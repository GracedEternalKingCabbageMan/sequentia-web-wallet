// Tests for the settlement router. Run: node settlement-router.test.mjs
import { planSettlement, planLeg, settlementPlanForSide, planExecutionName } from './settlement-router.mjs';

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL ${msg}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL ${msg}`); } }
function throws(fn, msg) { try { fn(); failed++; console.error(`FAIL ${msg} (did not throw)`); } catch { passed++; } }

// --- planLeg: the four native/bridge cases ---
eq(planLeg('btc', 'chain', 'chain', false),
   { unit:'btc', rail:'chain', method:'onchain-htlc', bridge:false, lnSide:null, jitInbound:false },
   'chain+chain -> native on-chain, no bridge');

eq(planLeg('btc', 'ln', 'ln', true),
   { unit:'btc', rail:'ln', method:'ln-htlc', bridge:false, lnSide:null, jitInbound:false },
   'ln+ln with inbound -> native LN, no bridge, no JIT');

eq(planLeg('asset', 'ln', 'ln', false),
   { unit:'asset', rail:'ln', method:'ln-htlc', bridge:false, lnSide:null, jitInbound:true },
   'ln+ln, receiver lacks inbound -> native LN but JIT required');

eq(planLeg('btc', 'ln', 'chain', false),
   { unit:'btc', rail:'mixed', method:'submarine', bridge:true, lnSide:'payer', jitInbound:false },
   'ln payer + chain receiver -> submarine bridge, lnSide payer');

eq(planLeg('btc', 'chain', 'ln', false),
   { unit:'btc', rail:'mixed', method:'submarine', bridge:true, lnSide:'receiver', jitInbound:true },
   'chain payer + ln receiver (no inbound) -> submarine bridge, lnSide receiver, JIT');

// --- planSettlement: whole-swap canonical shapes ---

// 1. Both sides fully on-chain -> today's cross-chain HTLC book. No bridge, happy.
let p = planSettlement({ asset:'GOLD',
  buyer:  { btcRail:'chain', assetRail:'chain' },
  seller: { assetRail:'chain', btcRail:'chain' } });
ok(p.happyCoincidence === true, '1: chain/chain is a happy coincidence');
ok(!p.btcLeg.bridge && !p.assetLeg.bridge, '1: no legs bridged');
ok(p.atomic.lspCoordinates === false, '1: LSP not in the value path');

// 2. Both sides fully LN, inbound present -> pure-LN. No bridge, funds never leave channels.
p = planSettlement({ asset:'GOLD',
  buyer:  { btcRail:'ln', assetRail:'ln', assetInbound:true },
  seller: { assetRail:'ln', btcRail:'ln', btcInbound:true } });
ok(p.happyCoincidence === true, '2: ln/ln is a happy coincidence (Andreas objection: no needless on-chain round-trip)');
ok(p.btcLeg.method === 'ln-htlc' && p.assetLeg.method === 'ln-htlc', '2: both legs pure-LN');
ok(p.steps.every(s => s.op !== 'provision-inbound'), '2: no JIT needed when both have inbound');

// 3. Buyer pays BTC over LN, receives asset on-chain; seller mirrors. Legs differ in rail
//    but EACH leg's endpoints agree -> no per-leg bridge (a real maker offered the mirror).
p = planSettlement({ asset:'GOLD',
  buyer:  { btcRail:'ln', assetRail:'chain' },
  seller: { assetRail:'chain', btcRail:'ln', btcInbound:true } });
ok(p.happyCoincidence === true, '3: mirror shape with a real maker needs no bridge');
ok(p.btcLeg.rail === 'ln' && p.assetLeg.rail === 'chain', '3: BTC leg LN, asset leg on-chain');

// 4. Rail DISAGREEMENT on the BTC leg: buyer pays BTC over LN, seller wants BTC on-chain.
//    The LSP bridges that leg. This is the case rail-blind matching creates and the old
//    code would have refused ("no maker for your rail").
p = planSettlement({ asset:'GOLD',
  buyer:  { btcRail:'ln', assetRail:'chain' },
  seller: { assetRail:'chain', btcRail:'chain' } });
ok(p.happyCoincidence === false, '4: BTC-leg disagreement forces a bridge');
ok(p.btcLeg.bridge === true && p.btcLeg.lnSide === 'payer', '4: BTC leg bridged, ln side is the payer (buyer)');
ok(p.assetLeg.bridge === false, '4: asset leg still native (both on-chain)');
ok(p.atomic.lspCoordinates === true, '4: LSP gates the preimage for atomicity');
ok(p.steps.some(s => s.op === 'reveal-preimage' && s.gatedByLsp === true), '4: reveal is LSP-gated');

// 5. Buyer wants the asset over LN with no inbound (the "coming soon" case) -> allowed:
//    a JIT channel is provisioned, and the asset leg bridges because the seller pays on-chain.
p = planSettlement({ asset:'OILX',
  buyer:  { btcRail:'chain', assetRail:'ln', assetInbound:false },
  seller: { assetRail:'chain', btcRail:'chain' } });
ok(p.assetLeg.jitInbound === true, '5: buyer LN-asset receive with no inbound -> JIT');
ok(p.assetLeg.bridge === true && p.assetLeg.lnSide === 'receiver', '5: asset leg bridged, ln side is the receiver (buyer)');
ok(p.steps[0].op === 'provision-inbound' && p.steps[0].leg === 'asset', '5: JIT provisioning comes first');
ok(p.btcLeg.bridge === false, '5: BTC leg native (both on-chain)');

// --- Stage 1b: router decision == the live runMixed if-chain, for all four shapes ---
// The live dispatch (lsp-server.mjs runMixed) maps (side, payRail, recvRail) to a binary. The
// router must pick the SAME binary before it's allowed to replace that dispatch. payRail/recvRail
// are the USER's leg rails; for buy btcLeg=payRail/assetLeg=recvRail, for sell they swap.
function execFor(side, payRail, recvRail){ return planExecutionName(side, settlementPlanForSide(side, payRail, recvRail)); }
eq(execFor('buy',  'ln',    'chain'), 'xsubbuy',     'buy pay-BTC-LN recv-asset-onchain -> xsubbuy');
eq(execFor('buy',  'chain', 'ln'),    'xsubas',      'buy pay-BTC-onchain recv-asset-LN -> xsubas (HODL)');
eq(execFor('sell', 'chain', 'ln'),    'xsublift',    'sell pay-asset-onchain recv-BTC-LN -> xsublift');
eq(execFor('sell', 'ln',    'chain'), 'xsubas-sell', 'sell pay-asset-LN recv-BTC-onchain -> xsubas-sell');
// Same-rail shapes are NOT submarine binaries — they route pure-LN / pure-chain elsewhere, so
// the mixed dispatch correctly has no binary for them.
ok(execFor('buy', 'ln', 'ln') === null, 'ln/ln is not a mixed binary (pure-LN path)');
ok(execFor('buy', 'chain', 'chain') === null, 'chain/chain is not a mixed binary (cross-book path)');

// --- validation ---
throws(() => planSettlement({}), 'missing buyer/seller throws');
throws(() => planLeg('btc', 'ln', 'satellite', false), 'invalid rail throws');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
