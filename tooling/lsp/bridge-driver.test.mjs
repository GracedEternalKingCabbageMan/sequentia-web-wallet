// Unit tests for bridge-driver.mjs — the live driver's CONTROL FLOW, with all I/O injected as a
// scripted fake `io` "world". The point: prove the driver executes ONLY nextBridgeStep's output, never
// fronts before its recoup is secured or before the whole-swap lock, provisions JIT first, and can't
// deadlock when both legs bridge — all without a node.
import test from 'node:test';
import assert from 'node:assert';
import { runBridgedLeg, runBridgedSwap, classifyLegs, describeBridge, matchFromTake, makerRailsFromOffer, takeRailsCrossed, bridgeAssetHandoffAdmissible, bridgeAssetRelayLocktimeVerdict, bridgeFrontConfirmed, isPureLnTake, crossingShapeSupported, bridgedTakeSupported, describeCrossingSupport, fundedBtcSatsForResume } from './bridge-driver.mjs';
import { planSettlement } from './settlement-router.mjs';
import { BRIDGE_DEFAULTS } from './leg-bridge.mjs';

const A = 100000;
const DCFG = { pollMs: 0, maxTicks: 200 };   // low ceiling
// A REAL 1ms nap for the fake io: unlike `async () => {}` it yields to the macrotask/timer queue, so
// setTimeout-based test events fire and the driver loop is paced (no microtask starvation).
const nap1 = () => new Promise((r) => setTimeout(r, 1));

// ---------- a fake single-leg "world" for runBridgedLeg ----------
// receiver-LN: the LSP pays the receiver's hold, then claims the payer's on-chain HTLC.
function receiverWorld({ lockedToLsp = true, amount = A, cltv = 200, gate = () => true } = {}) {
  const w = { tip: 100, onchain: { funded: true, amountSat: amount, cltv, lockedToLsp, spent: false, confs: 6 },
    ln: { registered: true, held: false, settled: false, preimage: null }, _heldTicks: 0, calls: [] };
  return {
    world: w, swapLocked: gate, sleep: nap1, log: () => {},
    observe: async () => {
      // External event: a few ticks after we front (held), the receiver settles + reveals P.
      if (w.ln.held && !w.ln.settled) { if (++w._heldTicks >= 2) { w.ln.settled = true; w.ln.preimage = 'ab'.repeat(32); } }
      return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln } };
    },
    frontLn: async () => { w.calls.push('frontLn'); w.ln.held = true; },
    recoupClaim: async () => { w.calls.push('recoupClaim'); w.onchain.spent = true; },
  };
}
// payer-LN: the LSP receives the payer's LN (held), funds the receiver's on-chain HTLC; the receiver
// claims (reveals P), the LSP settles the held LN.
function payerWorld({ amount = A, gate = () => true, expiryBlocks = 40 } = {}) {
  const w = { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks },
    _fundedTicks: 0, calls: [] };
  return {
    world: w, swapLocked: gate, sleep: nap1, log: () => {},
    observe: async () => {
      // A few ticks after we fund on-chain, the receiver claims (spent via CLAIM) and P is read from the witness.
      if (w.onchain && w.onchain.funded && !w.onchain.spent) { if (++w._fundedTicks >= 2) { w.onchain.spent = true; w.onchain.spendStatus = 'spent_claim'; w.ln.preimage = 'cd'.repeat(32); } }
      return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln } };
    },
    fundOnchain: async () => { w.calls.push('fundOnchain'); w.onchain = { funded: true, amountSat: amount, cltv: w.tip + 12, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }; },
    recoupSettle: async () => { w.calls.push('recoupSettle'); w.ln.settled = true; },
  };
}

test('runBridgedLeg receiver-LN: walks wait->front->...->recoup-claim->done, fronting once', async () => {
  const io = receiverWorld();
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim']);
  assert.equal(r.fronted, true);
});

test('runBridgedLeg payer-LN: walks ->fund-onchain->...->recoup-settle->done', async () => {
  const io = payerWorld();
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['fundOnchain', 'recoupSettle']);
});

// crossFund payer BRIDGE (the taker holds P): the maker's asset leg locks ONLY AFTER the LSP funds its BTC
// HTLC + relays XcBtcLegFunded, so swapLocked can NEVER open before the fund — a generic payer leg would
// deadlock. crossFund funds the instant the hold is HELD (skipping swapLocked), the fund action ALSO drives
// the maker relay (here: locks the asset), the taker claims the asset revealing P (the PRIMARY source, BEFORE
// the maker claims our BTC HTLC), and the LSP recoup-settles. Proves the whole HELD->fund->lock->claim->recoup
// completes with no deadlock even with swapLocked pinned false.
function crossFundPayerWorld({ amount = A, expiryBlocks = 40 } = {}) {
  const w = { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks },
    _fundedTicks: 0, calls: [] };
  return {
    world: w, swapLocked: () => false, sleep: nap1, log: () => {},   // swapLocked pinned FALSE (asset locks only after fund)
    observe: async () => {
      // A few ticks after we fund+relay, the TAKER claims the maker's asset leg -> P is public while our BTC
      // HTLC is STILL DEFINITIVELY UNSPENT by the maker (primary P source; spendStatus stays 'unspent').
      if (w.onchain && w.onchain.funded && !w.ln.preimage) { if (++w._fundedTicks >= 2) w.ln.preimage = 'cd'.repeat(32); }
      return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln }, crossFund: true };
    },
    // fund-onchain funds the BTC HTLC AND drives the maker relay (asset lock) — one action, as in the live io.
    fundOnchain: async () => { w.calls.push('fundOnchain'); w.onchain = { funded: true, amountSat: amount, cltv: w.tip + 40, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }; },
    recoupSettle: async () => { w.calls.push('recoupSettle'); w.ln.settled = true; },
    refundOnchain: async () => { w.calls.push('refundOnchain'); },
  };
}

test('runBridgedLeg crossFund payer: HELD->fund->lock->claim->recoup with swapLocked PINNED FALSE (no deadlock)', async () => {
  const io = crossFundPayerWorld();
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['fundOnchain', 'recoupSettle']);   // never refunded; recouped via the primary P
  assert.equal(r.fronted, true);
});

// Fix 2 dispatch: a 0-conf refund inside the hold danger window drives io.refundBump (RBF), then once it BURIES
// the leg is terminal 'done' (released to the taker) — the driver executes exactly nextBridgeStep's 'refund-bump'.
function stuckRefundPayerWorld({ amount = A } = {}) {
  const w = { tip: 200, onchain: { funded: true, amountSat: amount, cltv: 190, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 },
    ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 6 }, _bumps: 0, calls: [] };
  return {
    world: w, swapLocked: () => false, sleep: nap1, log: () => {},
    observe: async () => ({ tip: w.tip, onchain: { ...w.onchain }, ln: { ...w.ln }, crossFund: true }),
    // each bump raises the tip (new block) and, after two bumps, the refund finally buries.
    refundBump: async () => { w.calls.push('refundBump'); w.tip += 1; if (++w._bumps >= 2) w.onchain.spendConfs = 6; },
    recoupSettle: async () => { w.calls.push('recoupSettle'); w.ln.settled = true; },
    refundOnchain: async () => { w.calls.push('refundOnchain'); },
  };
}
test('runBridgedLeg payer: a stuck 0-conf refund inside the hold window drives refund-bump, then done at burial', async () => {
  const io = stuckRefundPayerWorld();
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);                              // terminal done (buried refund => release the hold)
  assert.ok(io.world.calls.includes('refundBump'), 'must have RBF-bumped the stalled refund');
  assert.ok(!io.world.calls.includes('recoupSettle'), 'never recoup-settles after our own refund (no double-dip)');
});

test('runBridgedLeg receiver-LN: NEVER fronts while the whole-swap gate is closed', async () => {
  let open = false;
  const io = receiverWorld({ gate: () => open });
  // Race the driver against opening the gate after it has already spun several no-front ticks.
  const p = runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 1, maxTicks: 200 } });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(io.world.calls, [], 'must not have fronted while gated');
  open = true;                       // whole swap now locked
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim'], 'fronts only after the gate opens');
});

test('runBridgedLeg receiver-LN: fail-closed (HTLC not locked to LSP) never fronts, no loss', async () => {
  const io = receiverWorld({ lockedToLsp: false });
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.equal(r.fronted, false);
  assert.deepEqual(io.world.calls, []);
});

test('runBridgedLeg receiver-LN: fail-closed on too-short CLTV runway (no front)', async () => {
  const io = receiverWorld({ cltv: 104 });   // tip 100 + frontRunway 6 = 106 needed
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.deepEqual(io.world.calls, []);
});

test('runBridgedLeg: a wait/unmapped action is a pure no-op tick (never a value move)', async () => {
  // onchain=null forever -> the core always says wait; the driver must call NO value method and hit maxTicks.
  const w = { calls: [] };
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } }),
    frontLn: async () => { w.calls.push('frontLn'); }, recoupClaim: async () => { w.calls.push('recoupClaim'); } };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 20 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /maxTicks/);
  assert.deepEqual(w.calls, []);
});

test('runBridgedLeg: an execution error is re-observed, not escalated to a different value move', async () => {
  let threw = false;
  const io = receiverWorld();
  const realFront = io.frontLn;
  io.frontLn = async (...a) => { if (!threw) { threw = true; throw new Error('broadcast timeout'); } return realFront(...a); };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);   // recovered by re-observing + retrying the SAME core-directed action
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim']);
});

test('runBridgedLeg: rejects a bad lnSide', async () => {
  await assert.rejects(() => runBridgedLeg({ leg: { lnSide: 'x', amountSat: A }, io: { observe: async () => ({}) } }));
});

// ---------- classifyLegs / describeBridge (pure) ----------
test('classifyLegs splits bridged/native/jit from a plan', () => {
  // buyer pays BTC-LN, seller wants BTC on-chain -> BTC leg bridged (payer); asset leg native chain/chain.
  const plan = planSettlement({ asset: 'GOLD', buyer: { btcRail: 'ln', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } });
  const c = classifyLegs(plan);
  assert.equal(c.bridged.length, 1);
  assert.equal(c.bridged[0].unit, 'btc');
  assert.equal(c.native.length, 1);
  assert.equal(c.native[0].unit, 'asset');
});

test('describeBridge flags a coincident match as NOT bridged, LSP out of the value path', () => {
  const d = describeBridge({ asset: 'GOLD', buyer: { btcRail: 'chain', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } });
  assert.equal(d.bridged, false);
  assert.equal(d.happyCoincidence, true);
  assert.equal(d.lspInValuePath, false);
});

test('describeBridge flags a genuine cross as bridged + names the bridged leg', () => {
  const d = describeBridge({ asset: 'GOLD', buyer: { btcRail: 'ln', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } });
  assert.equal(d.bridged, true);
  assert.equal(d.lspInValuePath, true);
  assert.deepEqual(d.bridgeLegs, [{ unit: 'btc', lnSide: 'payer' }]);
});

// ---------- matchFromTake / makerRailsFromOffer (the take -> match contract) ----------
test('makerRailsFromOffer: on-chain offer -> both maker legs chain; ln offer -> asset leg ln, btc chain', () => {
  assert.deepEqual(makerRailsFromOffer({ rail: 'onchain' }), { makerBtcRail: 'chain', makerAssetRail: 'chain' });
  assert.deepEqual(makerRailsFromOffer({ rail: 'ln' }), { makerBtcRail: 'chain', makerAssetRail: 'ln' });
});

test('matchFromTake: BUY vs on-chain offer, taker pays BTC over LN -> BTC leg bridges (payer)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'ln', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' });
  const plan = planSettlement(m);
  assert.equal(plan.happyCoincidence, false);
  assert.equal(plan.btcLeg.bridge, true);
  assert.equal(plan.btcLeg.lnSide, 'payer');
  assert.equal(plan.assetLeg.bridge, false);
});

test('matchFromTake: BUY vs on-chain offer, both taker rails chain -> HAPPY coincidence (no bridge)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' });
  assert.equal(planSettlement(m).happyCoincidence, true);
});

test('matchFromTake: BUY vs sub-asset LN offer, taker wants asset on-chain -> asset leg bridges (payer)', () => {
  // maker (sub-asset ask): assetRail ln, btcRail chain. Taker buys, pays BTC on-chain, wants asset on-chain.
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'ln' });
  const plan = planSettlement(m);
  assert.equal(plan.assetLeg.bridge, true);
  assert.equal(plan.assetLeg.lnSide, 'payer');   // maker (seller) pays the asset over LN
  assert.equal(plan.btcLeg.bridge, false);
});

test('matchFromTake: SELL vs on-chain offer, taker receives BTC over LN -> BTC leg bridges (receiver)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'sell', payRail: 'chain', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain', takerBtcInbound: true });
  const plan = planSettlement(m);
  assert.equal(plan.btcLeg.bridge, true);
  assert.equal(plan.btcLeg.lnSide, 'receiver');   // taker (seller) receives BTC over LN
});

test('matchFromTake: rejects a bad rail', () => {
  assert.throws(() => matchFromTake({ asset: 'X', side: 'buy', payRail: 'satellite', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' }));
});

// ---------- runBridgedSwap coordinator ----------
test('runBridgedSwap refuses a happy coincidence (never routes a native match through a bridge)', async () => {
  const r = await runBridgedSwap({ match: { asset: 'GOLD', buyer: { btcRail: 'chain', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } }, io: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /happy coincidence/i);
});

test('runBridgedSwap: JIT first, native drives, bridged leg gated until native locks, then settles', async () => {
  // buyer pays BTC on-chain, receives asset over LN with NO inbound -> asset leg bridged (receiver) + JIT;
  // seller both on-chain -> BTC leg native. So: JIT(asset) -> lock BTC(native) -> front asset -> settle.
  const events = [];
  let nativeChecks = 0;
  // asset leg (bridged, receiver): reuse the receiver world but attach amount + gate wiring via the swap io.
  const assetW = { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true, spent: false, confs: 6 },
    ln: { registered: true, held: false, settled: false, preimage: null }, _h: 0 };
  const io = {
    sleep: nap1, log: () => {},
    legAmountSat: () => A,
    provisionInbound: async (leg) => { events.push('jit:' + leg.unit); },
    startNative: async (leg) => { events.push('startNative:' + leg.unit); },
    // The native leg locks after a few polls (deterministic; the maker funds its HTLC).
    observeNativeLocked: async () => (++nativeChecks >= 3),
    observe: async (leg) => {
      if (leg.unit !== 'asset') return { tip: 100, onchain: null, ln: { registered: false, held: false, settled: false, preimage: null } };
      if (assetW.ln.held && !assetW.ln.settled) { if (++assetW._h >= 2) { assetW.ln.settled = true; assetW.ln.preimage = 'ab'.repeat(32); } }
      return { tip: assetW.tip, onchain: { ...assetW.onchain }, ln: { ...assetW.ln } };
    },
    frontLn: async (leg) => { events.push('front:' + leg.unit); assetW.ln.held = true; },
    recoupClaim: async (leg) => { events.push('claim:' + leg.unit); assetW.onchain.spent = true; },
  };
  // buyer pays BTC on-chain, receives asset over LN with no inbound -> asset leg bridges (receiver) + JIT.
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: false }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 1, maxTicks: 500 } });
  assert.equal(r.ok, true, r.reason);
  // JIT strictly before the front; the front strictly after native lock is observed.
  assert.ok(events.indexOf('jit:asset') >= 0 && events.indexOf('jit:asset') < events.indexOf('front:asset'), 'JIT before front');
  assert.ok(events.indexOf('front:asset') > 0, 'asset leg did front');
  assert.deepEqual(events.filter((e) => e.startsWith('front')), ['front:asset'], 'exactly one front');
});

test('runBridgedSwap: JIT failure fails the swap CLOSED before anything locks', async () => {
  const io = { sleep: nap1, log: () => {}, legAmountSat: () => A, provisionInbound: async () => { throw new Error('no LP liquidity'); },
    observe: async () => ({ tip: 100, onchain: null, ln: {} }) };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: false }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.match(r.reason, /JIT inbound/i);
});

test('runBridgedSwap: BOTH legs bridged does not deadlock (gate on the other leg LOCK, not its front)', async () => {
  // buyer pays BTC over LN + receives asset on-chain; seller pays asset over LN + receives BTC on-chain.
  // BTC leg: buyer(ln) vs seller(chain) -> cross, PAYER. Asset leg: seller(ln) vs buyer(chain) -> cross,
  // PAYER. So BOTH legs are payer-LN bridges (LSP funds each on-chain HTLC after each LN is held).
  const worlds = {
    btc:   payerLegWorld(),
    asset: payerLegWorld(),
  };
  const fronted = [];
  const io = {
    sleep: nap1, log: () => {}, legAmountSat: () => A,
    provisionInbound: async () => {},
    observe: async (leg) => worlds[leg.unit].observe(),
    fundOnchain: async (leg) => { fronted.push('fund:' + leg.unit); worlds[leg.unit].fund(); },
    recoupSettle: async (leg) => { worlds[leg.unit].settle(); },
  };
  const match = { asset: 'GOLD', buyer: { btcRail: 'ln', assetRail: 'chain' }, seller: { assetRail: 'ln', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 1, maxTicks: 800 } });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fronted.sort(), ['fund:asset', 'fund:btc'], 'both legs funded — no deadlock');
});

test('runBridgedSwap: binds the amount from io.legAmountSat — refuses an UNDERFUNDED recoup (Finding 1 regression)', async () => {
  // The live fund-loss bug: the driver passed leg.amountSat === undefined (router legs carry no amount),
  // so the core's "never front more than we recoup" check (oc.amountSat < leg.amountSat) was always false.
  // Here io.legAmountSat says the asset leg is worth A, but the maker's on-chain HTLC holds only 1 sat. The
  // driver MUST bind A into the core (via withAmt) so 1 < A fails closed — never front A against a 1-sat recoup.
  const events = [];
  const io = {
    sleep: nap1, log: () => {}, legAmountSat: () => A,
    provisionInbound: async () => {}, startNative: async () => {}, observeNativeLocked: async () => true,
    observe: async (leg) => leg.unit === 'asset'
      ? { tip: 100, onchain: { funded: true, amountSat: 1, cltv: 200, lockedToLsp: true, spent: false, confs: 6 }, ln: { registered: true, held: false, settled: false, preimage: null } }
      : { tip: 100, onchain: null, ln: {} },
    frontLn: async () => { events.push('front'); },
  };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: true }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 0, maxTicks: 50 } });
  assert.equal(r.ok, false, 'must fail — the recoup HTLC is underfunded');
  assert.deepEqual(events, [], 'NEVER fronted A against a 1-sat recoup');
});

test('runBridgedSwap: a bridged-leg fail-closed fails the whole swap', async () => {
  const io = {
    sleep: nap1, log: () => {}, provisionInbound: async () => {},
    startNative: async () => {}, observeNativeLocked: async () => true,
    // asset leg bridged (receiver) but the on-chain HTLC is NOT locked to the LSP -> fail-closed.
    observe: async (leg) => leg.unit === 'asset'
      ? { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: false }, ln: { registered: true, held: false, settled: false, preimage: null } }
      : { tip: 100, onchain: null, ln: {} },
    frontLn: async () => { throw new Error('should never front'); },
  };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: true }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 0, maxTicks: 50 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /asset:/);
});

// ---------- W2(b): maxTicks exhaustion is RESUMABLE only when nothing was fronted ----------
test('W2b runBridgedLeg: maxTicks exhausted PRE-FRONT is resumable (interrupted:true, nothing fronted)', async () => {
  // A receiver leg whose recoup HTLC never funds -> nextBridgeStep returns 'wait' forever -> maxTicks.
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } }),
    frontLn: async () => { throw new Error('must never front'); } };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.fronted, false);
  assert.equal(r.interrupted, true, 'pre-front exhaustion is resumable — the job is marked interrupted, not failed');
});

test('W2b runBridgedLeg: maxTicks exhausted AFTER a front is NOT resumable (interrupted:false)', async () => {
  // Recoup HTLC locked + confirmed, so we front; the receiver then NEVER settles -> we wait post-front.
  let fronted = false;
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true, confs: 6, spent: false }, ln: { registered: true, held: fronted, settled: false, preimage: null } }),
    frontLn: async () => { fronted = true; } };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.fronted, true);
  assert.equal(r.interrupted, false, 'post-front exhaustion needs operator attention, never a silent resume');
});

// ---------- hole 2: a FUNDED PAYER leg exhaustion is RESUMABLE (unlike a receiver's) ----------
test('hole 2 runBridgedLeg PAYER: maxTicks exhausted AFTER funding stays RESUMABLE (interrupted:true) — a funded payer leg is never abandoned', async () => {
  // The LSP funds its BTC on-chain (fronted), then P never becomes public and T_btc stays far off -> post-fund
  // 'wait' -> maxTicks. Unlike a RECEIVER leg (post-front = anomaly), a FUNDED PAYER leg MUST resume: its
  // recoup/refund horizon (T_seq / hold) is hours, far beyond one driver session, so it is marked interrupted
  // (re-driven by resume-on-boot to settle on P or refund at T_btc), never terminal 'failed'.
  let funded = false;
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100,
      onchain: funded ? { funded: true, amountSat: A, cltv: 200, lockedToReceiver: true, spent: false, spendStatus: 'unspent' } : null,
      ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, crossFund: true }),
    fundOnchain: async () => { funded = true; } };
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.fronted, true, 'the payer leg funded on-chain (real BTC at stake)');
  assert.equal(r.interrupted, true, 'a FUNDED payer leg stays resumable — never abandoned as terminal failed');
});

// ---------- C — a FUNDED payer leg that hits FAIL-CLOSED (not just maxTicks) stays RESUMABLE ----------
test('C runBridgedLeg PAYER: a fail-closed AFTER funding stays RESUMABLE (interrupted:true) — never dropped to terminal failed', async () => {
  // Fund the BTC on-chain (fronted), then a later tick drives the core to fail-closed (a near-expiry hold whose
  // on-chain read is momentarily gone and NOT flagged known-funded). A FUNDED payer leg must NOT be abandoned as
  // terminal 'failed' on ANY fail-close — it stays interrupted so resume-on-boot can still settle/refund the BTC.
  let funded = false;
  const io = { sleep: nap1, log: () => {},
    observe: async () => (funded
      ? { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, crossFund: true }
      : { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, crossFund: true }),
    fundOnchain: async () => { funded = true; } };
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 20 } });
  assert.equal(r.ok, false);
  assert.equal(r.lastAction, 'fail-closed');
  assert.equal(r.fronted, true, 'the payer leg funded on-chain (real BTC at stake)');
  assert.equal(r.interrupted, true, 'a FUNDED payer fail-close stays resumable — never terminal failed');
});

test('C runBridgedLeg PAYER: a PRE-FRONT fail-closed is STILL resumable (interrupted:true) — a resumed leg may be funded from a PRIOR session, so lnSide alone gates', async () => {
  // A payer leg resumed after a restart begins THIS driver session with fronted=false, yet its BTC may already
  // be funded on-chain from the prior session (recovered by the boot chain-recover / fundOnchain scan). If this
  // session hits a fail-close (here: the hold is near expiry and the on-chain read is momentarily gone and NOT
  // flagged known-funded) BEFORE it re-fronts, it must NOT be dropped to terminal 'failed' — that would strand
  // the prior-session fund. Gating on lnSide ALONE (not `fronted && payer`) keeps it resumable. Contrast the
  // receiver pre-front fail-close below, which IS a genuine no-loss terminal.
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, crossFund: true }),
    fundOnchain: async () => { throw new Error('must not fund — the core fail-closes before any fund this session'); } };
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 20 } });
  assert.equal(r.lastAction, 'fail-closed');
  assert.equal(r.fronted, false, 'nothing fronted THIS session');
  assert.equal(r.interrupted, true, 'a payer pre-front fail-close stays resumable — a prior-session fund must never be stranded');
});

test('C runBridgedLeg RECEIVER: a pre-front fail-closed is NOT resumable (interrupted falsy) — genuine no-loss terminal', async () => {
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: false, confs: 6 }, ln: { registered: true, held: false, settled: false, preimage: null } }),
    frontLn: async () => { throw new Error('must never front'); } };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 20 } });
  assert.equal(r.lastAction, 'fail-closed');
  assert.equal(r.fronted, false);
  assert.notEqual(r.interrupted, true, 'a pre-front fail-close is a no-loss terminal, not resumable');
});

// ---------- D — resume drives off the PERSISTED funded amount, never the maker-stated bridge_terms ----------
test('D fundedBtcSatsForResume: uses legState.btc.amountSat (an on-chain fact), never a maker-stated amount', () => {
  assert.equal(fundedBtcSatsForResume({ amountSat: 76066 }), 76066);
  // amountSat absent/0 -> fall back to the recorded HTLC output amount (still persisted on-chain), never terms.
  assert.equal(fundedBtcSatsForResume({ amountSat: 0, htlc: { amount: 76066 } }), 76066);
  assert.equal(fundedBtcSatsForResume({ htlc: { amount: 50000 } }), 50000);
  // nothing funded recorded -> 0 (never a maker-stated value); NaN / negative amountSat are ignored.
  assert.equal(fundedBtcSatsForResume({ amountSat: NaN }), 0);
  assert.equal(fundedBtcSatsForResume({ amountSat: -5 }), 0);
  assert.equal(fundedBtcSatsForResume(null), 0);
  assert.equal(fundedBtcSatsForResume(undefined), 0);
});

test('W2b runBridgedSwap: a whole-swap pre-front maxTicks exhaustion surfaces interrupted:true', async () => {
  const io = {
    sleep: nap1, log: () => {}, legAmountSat: () => A,
    provisionInbound: async () => {}, startNative: async () => {}, observeNativeLocked: async () => true,
    // bridged asset leg whose recoup never funds -> waits pre-front to maxTicks; nothing fronted.
    observe: async () => ({ tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } }),
    frontLn: async () => { throw new Error('must never front'); },
  };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: true }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 0, maxTicks: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.interrupted, true);
});

test('W2b runBridgedSwap: a fail-closed swap is NOT marked interrupted (a real failure, not resumable)', async () => {
  const io = {
    sleep: nap1, log: () => {}, provisionInbound: async () => {},
    startNative: async () => {}, observeNativeLocked: async () => true,
    observe: async (leg) => leg.unit === 'asset'
      ? { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: false }, ln: { registered: true, held: false, settled: false, preimage: null } }
      : { tip: 100, onchain: null, ln: {} },
    frontLn: async () => { throw new Error('should never front'); },
  };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: true }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 0, maxTicks: 50 } });
  assert.equal(r.ok, false);
  assert.notEqual(r.interrupted, true);
});

// ---------- W3(b): takeRailsCrossed — refuse a crossed take that omitted bridge:true ----------
test('W3b takeRailsCrossed: a genuine rail crossing is flagged (a bridge is required)', () => {
  // SELL vs on-chain offer, taker receives BTC over LN -> BTC leg bridges (a real cross).
  assert.equal(takeRailsCrossed({ side: 'sell', payRail: 'chain', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain' }), true);
});

test('W3b takeRailsCrossed: a HAPPY coincidence is NOT a cross (no bridge)', () => {
  assert.equal(takeRailsCrossed({ side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' }), false);
});

test('W3b takeRailsCrossed: undeterminable/invalid rails -> false (caller falls through, never over-refuses)', () => {
  assert.equal(takeRailsCrossed({ side: 'sell', payRail: 'nonsense', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain' }), false);
});

// ---------- W2(a): AUTHORITATIVE driver-liveness gates /bridge/asset (not the lagging job.status) ----------
// The /bridge/asset handler admits the taker's asset hand-off ONLY while a driver is live (job._driverLive,
// set/cleared synchronously with the bridged driver) AND the courier session is open. Prove the driver sets
// the flag while it runs and CLEARS it at exit, so the handoff predicate (bridgeAssetHandoffAdmissible)
// refuses once the driver has stopped — even during the post-loop-await lag when status is still 'confirming'.
test('W2a runBridgedSwap: sets _driverLive while running and CLEARS it at exit (pre-front maxTicks)', async () => {
  const job = { _driverLive: false, _bridgeSession: {} };   // session still open (same process), no driver yet
  let sawLiveDuringRun = false;
  const io = {
    sleep: nap1, log: () => {}, legAmountSat: () => A,
    setDriverLive: (v) => { job._driverLive = !!v; },
    provisionInbound: async () => {}, startNative: async () => {}, observeNativeLocked: async () => true,
    observe: async () => { if (bridgeAssetHandoffAdmissible(job)) sawLiveDuringRun = true;
      return { tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } }; },
    frontLn: async () => { throw new Error('must never front'); },
  };
  // Before any driver runs, an open session ALONE must not admit the hand-off.
  assert.equal(bridgeAssetHandoffAdmissible(job), false, 'session-open alone (no live driver) is NOT admissible');
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: true }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 0, maxTicks: 5 } });
  assert.equal(r.ok, false);
  assert.equal(sawLiveDuringRun, true, 'the hand-off WAS admissible while the driver ran (flag live)');
  assert.equal(job._driverLive, false, 'driver CLEARED the liveness flag on exit');
  assert.equal(bridgeAssetHandoffAdmissible(job), false, 'the /bridge/asset gate REFUSES after the driver stops — no strand');
});

test('W2a runBridgedSwap: clears _driverLive even when JIT fails before any leg drives', async () => {
  const job = { _driverLive: false, _bridgeSession: {} };
  const io = { sleep: nap1, log: () => {}, legAmountSat: () => A,
    setDriverLive: (v) => { job._driverLive = !!v; },
    provisionInbound: async () => { throw new Error('no LP liquidity'); },
    observe: async () => ({ tip: 100, onchain: null, ln: {} }) };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: false }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.match(r.reason, /JIT inbound/i);
  assert.equal(job._driverLive, false, 'liveness flag cleared on the JIT-failure early return (no leaked admit)');
  assert.equal(bridgeAssetHandoffAdmissible(job), false);
});

test('W2a bridgeAssetHandoffAdmissible: needs BOTH a live driver and an open session', () => {
  assert.equal(bridgeAssetHandoffAdmissible({ _driverLive: true, _bridgeSession: {} }), true);
  assert.equal(bridgeAssetHandoffAdmissible({ _driverLive: false, _bridgeSession: {} }), false, 'no live driver -> refuse');
  assert.equal(bridgeAssetHandoffAdmissible({ _driverLive: true, _bridgeSession: null }), false, 'session already relayed/closed -> refuse');
  assert.equal(bridgeAssetHandoffAdmissible(null), false);
});

// ---------- W2(a): bridgeAssetRelayLocktimeVerdict — the RELAY-time locktime gate for /bridge/asset ----------
// The taker's asset leg is EXPOSED to the maker's claim the instant it is relayed, so the block-based locktime
// ordering is re-checked HERE against LIVE tips (a maker whose short T_btc has DRIFTED so it can no longer cover
// the taker's required front-HTLC survival is refused BEFORE the asset is exposed). Reads the two CLTV refund
// heights from the SAME job fields the front-time gate uses. Large-enough terms: T_btc ~tip+260 BTC (covers the
// ~210-block front HTLC for a 240-block T_seq), T_seq ~tip+240 SEQ.
const relayJob = () => ({ status: 'confirming', _driverLive: true, _bridgeSession: {},
  legState: { btc: { htlc: { cltv: 800000 + 260 } }, asset: { seqLocktime: 44000 + 240 } } });

test('W2a bridgeAssetRelayLocktimeVerdict: a HEALTHY live tip ADMITS the relay', () => {
  const v = bridgeAssetRelayLocktimeVerdict({ job: relayJob(), btcTip: 800000, seqTip: 44000 });
  assert.equal(v.ok, true, v.reason);
});

test('W2a bridgeAssetRelayLocktimeVerdict: a DRIFTED BTC tip (recoup runway below the front HTLC) REFUSES the relay', () => {
  const v = bridgeAssetRelayLocktimeVerdict({ job: relayJob(), btcTip: 800090, seqTip: 44000 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /UNSAFE|refuse|short|recoup runway/i);
});

test('W2a bridgeAssetRelayLocktimeVerdict (site 3): a maker whose T_btc CANNOT cover requiredTakerBlocks REFUSES the relay', () => {
  // The third of the three gate sites: a short-T_btc maker (100 BTC blocks, recoupDeadline 94 < ~210) that would
  // strand the LSP is refused at relay time too — the taker keeps its asset and refunds at T_seq (no loss).
  const job = { legState: { btc: { htlc: { cltv: 800000 + 100 } }, asset: { seqLocktime: 44000 + 240 } } };
  const v = bridgeAssetRelayLocktimeVerdict({ job, btcTip: 800000, seqTip: 44000 });
  assert.equal(v.ok, false);
  assert.ok(v.recoupDeadlineBlocks < v.requiredTakerBlocks);
});

test('W2a bridgeAssetRelayLocktimeVerdict: an unreadable tip (NaN) fails closed — never relay unverified', () => {
  assert.equal(bridgeAssetRelayLocktimeVerdict({ job: relayJob(), btcTip: NaN, seqTip: 44000 }).ok, false);
  assert.equal(bridgeAssetRelayLocktimeVerdict({ job: relayJob(), btcTip: 800000, seqTip: NaN }).ok, false);
});

test('W2a bridgeAssetRelayLocktimeVerdict: a TIMESTAMP maker T_btc is refused (defensive height assert)', () => {
  const job = relayJob(); job.legState.btc.htlc.cltv = 500000000 + 800000;   // UNIX timestamp, not a height
  assert.equal(bridgeAssetRelayLocktimeVerdict({ job, btcTip: 800000, seqTip: 44000 }).ok, false);
});

test('W2a bridgeAssetRelayLocktimeVerdict: reads T_seq from bridge_terms when the asset legState lacks it', () => {
  const job = { legState: { btc: { htlc: { cltv: 800000 + 260 } }, asset: {} }, bridge_terms: { seq_locktime: 44000 + 240 } };
  assert.equal(bridgeAssetRelayLocktimeVerdict({ job, btcTip: 800000, seqTip: 44000 }).ok, true);
  assert.equal(bridgeAssetRelayLocktimeVerdict({ job, btcTip: 800090, seqTip: 44000 }).ok, false);
});

test('W2a bridgeAssetRelayLocktimeVerdict: a missing maker BTC HTLC cltv fails closed (NaN height)', () => {
  const v = bridgeAssetRelayLocktimeVerdict({ job: { legState: { btc: {}, asset: { seqLocktime: 44240 } } }, btcTip: 800000, seqTip: 44000 });
  assert.equal(v.ok, false);
});

// ---------- W2: FRONT-BEFORE-FUND — the driver fronts a reverse-cross receiver leg on recoup-secured +
//            hold-ready, BEFORE the asset leg locks (swapLocked stays false the whole time). ----------
// A reverse-cross receiver world: the maker BTC HTLC is the recoup (locked to us, confirmed, healthy locktime
// ordering via crossLock). The whole-swap gate (swapLocked) is ALWAYS false here — the taker funds its native
// asset leg only AFTER the front, so that leg never locks first. `recvReady` flips true when the taker posts
// hold-ready. The front must hinge on recvReady, never on swapLocked.
function reverseCrossWorld() {
  const w = { tip: 800000, onchain: { funded: true, amountSat: A, cltv: 800000 + 260, lockedToLsp: true, spent: false, confs: 1 },
    ln: { registered: true, held: false, settled: false, preimage: null }, _heldTicks: 0, recvReady: false, calls: [] };
  return {
    world: w, swapLocked: () => false,   // the native asset leg NEVER locks before the front (front-before-fund)
    sleep: nap1, log: () => {},
    observe: async () => {
      if (w.ln.held && !w.ln.settled) { if (++w._heldTicks >= 2) { w.ln.settled = true; w.ln.preimage = 'ab'.repeat(32); } }
      return { tip: w.tip, onchain: { ...w.onchain }, ln: { ...w.ln },
        crossLock: { seqTip: 44000, seqRefundHeight: 44000 + 240 }, recvReady: w.recvReady };
    },
    frontLn: async () => { w.calls.push('frontLn'); w.ln.held = true; },
    recoupClaim: async () => { w.calls.push('recoupClaim'); w.onchain.spent = true; },
  };
}

test('W2 driver: fronts a reverse-cross receiver leg WITHOUT the asset leg ever locking (swapLocked false throughout)', async () => {
  const io = reverseCrossWorld();
  io.world.recvReady = true;   // taker already hold-ready
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim'], 'fronted + recouped though swapLocked was false the whole time');
  assert.equal(r.fronted, true);
});

test('W2 driver: WITHHOLDS the front until the taker is hold-ready, then fronts (recvReady gates, not swapLocked)', async () => {
  const io = reverseCrossWorld();   // recvReady:false
  const p = runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 1, maxTicks: 400 } });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(io.world.calls, [], 'must not front before the taker is hold-ready (asset not yet exposed)');
  io.world.recvReady = true;        // taker registers its hold on H + hands recv_node_id
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim'], 'fronts only once hold-ready — before the asset leg locks');
});

test('W2 driver: resume re-enters at recoup when the front already settled (P known) — never a second front', async () => {
  // Simulate a resume AFTER the taker settled the hold (P learned pre-restart): ln.settled already true.
  const io = reverseCrossWorld();
  io.world.recvReady = true; io.world.ln.settled = true; io.world.ln.held = true; io.world.ln.preimage = 'ab'.repeat(32);
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['recoupClaim'], 're-enters straight at the recoup — no duplicate front');
});

// ---------- W2: bridgeFrontConfirmed — /bridge/asset must REJECT the asset hand-off before the front ----------
test('W2 bridgeFrontConfirmed: true once the BTC leg is frontHeld (the LSP has paid the taker\'s hold on H)', () => {
  assert.equal(bridgeFrontConfirmed({ legState: { btc: { frontHeld: true } } }), true);
});

test('W2 bridgeFrontConfirmed: true once the front has settled (frontPreimage learned)', () => {
  assert.equal(bridgeFrontConfirmed({ legState: { btc: { frontPreimage: 'ab'.repeat(32) } } }), true);
});

test('W2 bridgeFrontConfirmed: FALSE before any front — relaying the asset then would strand it (reject)', () => {
  assert.equal(bridgeFrontConfirmed({ legState: { btc: { htlc: {}, verifiedClaimLsp: true, recvNodeId: 'n' } } }), false, 'handshook + hold-ready but NOT fronted -> refuse the relay');
  assert.equal(bridgeFrontConfirmed({ legState: { btc: {} } }), false);
  assert.equal(bridgeFrontConfirmed({ legState: {} }), false);
  assert.equal(bridgeFrontConfirmed({}), false);
  assert.equal(bridgeFrontConfirmed(null), false);
});

test('W2 bridgeFrontConfirmed: a non-hex frontPreimage is NOT treated as a confirmed front', () => {
  assert.equal(bridgeFrontConfirmed({ legState: { btc: { frontPreimage: 'nope' } } }), false);
  assert.equal(bridgeFrontConfirmed({ legState: { btc: { frontHeld: 'yes' } } }), false, 'only a strict true frontHeld counts');
});

// ---------- W3(c): isPureLnTake — the ln/ln dispatch branch must exempt a bridged take ----------
test('W3c isPureLnTake: a ln/ln take with bridge:true is NOT the pure-LN route (falls through to the bridge)', () => {
  assert.equal(isPureLnTake({ payRail: 'ln', recvRail: 'ln', bridge: true }), false);
});

test('W3c isPureLnTake: a normal ln/ln take IS the pure-LN route (unchanged runSwap dispatch)', () => {
  assert.equal(isPureLnTake({ payRail: 'ln', recvRail: 'ln' }), true);
  assert.equal(isPureLnTake({ payRail: 'ln', recvRail: 'ln', bridge: false }), true);
});

test('W3c isPureLnTake: a mixed or crossed take is never the pure-LN route', () => {
  assert.equal(isPureLnTake({ payRail: 'ln', recvRail: 'chain' }), false);
  assert.equal(isPureLnTake({ payRail: 'chain', recvRail: 'ln' }), false);
  assert.equal(isPureLnTake({ payRail: 'chain', recvRail: 'chain', bridge: true }), false);
});

// ---- helpers ----
// A minimal payer-leg world usable inside the swap io (fund -> receiver claims -> settle).
function payerLegWorld() {
  const w = { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, _f: 0 };
  return {
    observe: () => { if (w.onchain && w.onchain.funded && !w.onchain.spent) { if (++w._f >= 2) { w.onchain.spent = true; w.onchain.spendStatus = 'spent_claim'; w.ln.preimage = 'cd'.repeat(32); } } return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln } }; },
    fund: () => { w.onchain = { funded: true, amountSat: A, cltv: w.tip + 12, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }; },
    settle: () => { w.ln.settled = true; },
  };
}

// ---------- P3.2 crossing-shape capability (the wallet pre-Review check == the LSP admission) ----------

test('P3.2 crossingShapeSupported: the WIRED shape (SELL asset / receive BTC over LN vs on-chain reverse maker) is supported', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'sell', payRail: 'chain', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain', takerBtcInbound: true });
  const plan = planSettlement(m);
  assert.equal(plan.btcLeg.bridge, true);
  assert.equal(plan.btcLeg.lnSide, 'receiver');
  assert.equal(crossingShapeSupported(plan), true);
});

test('P3.2 crossingShapeSupported: a payer-side BTC-leg bridge (BUY, pay BTC over LN) with a native asset leg IS wired', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'ln', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' });
  const plan = planSettlement(m);
  assert.equal(plan.btcLeg.bridge, true);
  assert.equal(plan.btcLeg.lnSide, 'payer');
  assert.equal(plan.assetLeg.bridge, false);
  assert.equal(crossingShapeSupported(plan), true);   // the LSP payer leg-bridge funds the on-chain BTC HTLC to the maker
});

test('P3.2 crossingShapeSupported: an asset-leg bridge (maker sub-asset LN, taker wants asset on-chain) is NOT wired', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'ln' });
  const plan = planSettlement(m);
  assert.equal(plan.assetLeg.bridge, true);
  assert.equal(crossingShapeSupported(plan), false);
});

test('P3.2 crossingShapeSupported: a HAPPY coincidence is never "supported" (settle natively, not via the bridge)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' });
  assert.equal(planSettlement(m).happyCoincidence, true);
  assert.equal(crossingShapeSupported(planSettlement(m)), false);
});

test('P3.2 bridgedTakeSupported: match-based wrapper agrees with crossingShapeSupported on the wired shape', () => {
  const take = { asset: 'GOLD', side: 'sell', payRail: 'chain', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain', takerBtcInbound: true };
  assert.equal(bridgedTakeSupported(take), true);
});

test('P3.2 bridgedTakeSupported: undeterminable/invalid rails -> false (wallet does NOT promise a bridge, falls back)', () => {
  assert.equal(bridgedTakeSupported({ asset: 'GOLD', side: 'sell', payRail: 'satellite', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain' }), false);
  assert.equal(bridgedTakeSupported({}), false);
  assert.equal(bridgedTakeSupported(null), false);
});

test('P3.2 bridgedTakeSupported: exactly the shapes the LSP admission accepts (parity with crossingShapeSupported)', () => {
  // Enumerate every genuine crossing vs a unified-book maker (BTC leg on-chain) and assert the match-based
  // wallet check equals the plan-based LSP-admission check — so a Review can never promise a bridge the LSP
  // then refuses post-confirm.
  for (const side of ['buy', 'sell'])
    for (const payRail of ['ln', 'chain'])
      for (const recvRail of ['ln', 'chain'])
        for (const makerAssetRail of ['ln', 'chain']) {
          const take = { asset: 'GOLD', side, payRail, recvRail, makerBtcRail: 'chain', makerAssetRail,
            takerAssetInbound: false, takerBtcInbound: false };
          const plan = planSettlement(matchFromTake(take));
          assert.equal(bridgedTakeSupported(take), crossingShapeSupported(plan),
            `parity mismatch for ${side} pay=${payRail} recv=${recvRail} makerAsset=${makerAssetRail}`);
        }
});

test('P3.2 describeCrossingSupport: publishes the wired shape + supported crossings both directions, all supported entries pass the predicate', () => {
  const d = describeCrossingSupport();
  assert.match(d.wired_shape, /SELL|receive|reverse|BUY|pay|forward/i);
  assert.ok(Array.isArray(d.supported_crossings) && d.supported_crossings.length >= 1);
  assert.ok(Array.isArray(d.unsupported_crossings) && d.unsupported_crossings.length >= 1);
  for (const s of d.supported_crossings) assert.equal(s.supported, true);
  for (const s of d.unsupported_crossings) assert.equal(s.supported, false);
  // The supported crossings are exactly the BTC-leg crossings with a NATIVE asset leg (bridge=false), BOTH
  // directions. Reconstruct each entry's plan and assert the predicate it encodes: the BTC leg bridges and
  // the asset leg does not (its rail may be on-chain OR native LN — both are "native asset leg").
  for (const s of d.supported_crossings) {
    const plan = planSettlement(matchFromTake({ asset: 'x', side: s.side, payRail: s.payRail, recvRail: s.recvRail, makerBtcRail: 'chain', makerAssetRail: s.makerAssetRail }));
    assert.equal(plan.btcLeg.bridge, true, `supported entry must bridge the BTC leg: ${JSON.stringify(s)}`);
    assert.equal(plan.assetLeg.bridge, false, `supported entry must keep the asset leg native: ${JSON.stringify(s)}`);
  }
  // BOTH a sell/receiver and a buy/payer BTC-leg crossing are now supported.
  assert.ok(d.supported_crossings.some((s) => s.side === 'sell' && s.recvRail === 'ln'), 'sell/receiver crossing supported');
  assert.ok(d.supported_crossings.some((s) => s.side === 'buy' && s.payRail === 'ln'), 'buy/payer crossing supported');
});
