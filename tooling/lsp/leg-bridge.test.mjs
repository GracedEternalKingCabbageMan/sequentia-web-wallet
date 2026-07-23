// Unit tests for leg-bridge.mjs — the LSP per-leg bridge fund-safety decision core.
// The load-bearing invariant: the LSP NEVER fronts value on a crossed leg unless its recoup on the
// other end is already secured, so it can only ever stall into a refundable no-loss failure.
import test from 'node:test';
import assert from 'node:assert';
import { nextBridgeStep, BRIDGE_DEFAULTS, checkBridgeLocktimeOrdering, LOCKTIME_GATE_DEFAULTS, LOCKTIME_THRESHOLD } from './leg-bridge.mjs';

const R = BRIDGE_DEFAULTS.frontRunway;   // 6
const M = BRIDGE_DEFAULTS.claimMargin;   // 2
const A = 100000;                        // leg amount sats

// ---- lnSide='receiver': LSP pays LN, claims the payer's on-chain HTLC ----
test('receiver-LN: waits for the payer to fund the on-chain HTLC before fronting', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
});

test('receiver-LN: REFUSES to front if the HTLC is not locked to the LSP (cannot recoup)', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: false }, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'fail-closed');
});

test('receiver-LN: REFUSES to front if the HTLC amount is below the leg amount', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A - 1, cltv: 200, lockedToLsp: true }, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'fail-closed');
});

test('receiver-LN: REFUSES to front if CLTV runway is too short to recoup after the reveal', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R - 1, lockedToLsp: true }, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'fail-closed');
});

test('receiver-LN: fronts ONLY once the HTLC is locked to us, amount ok, runway ok, and CONFIRMED', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R, lockedToLsp: true, confs: 1 }, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'front-ln');
});

test('receiver-LN: REFUSES to front while the recoup HTLC is still 0-conf (RBF-able) — waits, no loss', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R, lockedToLsp: true, confs: 0 }, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /confirmation/i);
});

test('receiver-LN: after fronting, a non-settling receiver just waits (no-loss stall)', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 150, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true }, ln: { registered: true, held: true, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
});

test('receiver-LN: on settle, recoups by claiming the on-chain HTLC with P', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 150, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true }, ln: { registered: true, held: true, settled: true, preimage: 'ab'.repeat(32) } });
  assert.equal(s.action, 'recoup-claim');
});

test('receiver-LN: recoups IMMEDIATELY when settle lands with the on-chain CLTV imminent', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 200 - M, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true }, ln: { registered: true, held: true, settled: true, preimage: 'ab'.repeat(32) } });
  assert.equal(s.action, 'recoup-claim');
  assert.match(s.reason, /IMMEDIATELY/);
});

test('receiver-LN: an impossible "settled but no HTLC" state fails closed loudly (never silently)', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 150, onchain: null, ln: { registered: true, held: true, settled: true, preimage: 'ab'.repeat(32) } });
  assert.equal(s.action, 'fail-closed');
  assert.match(s.reason, /INVARIANT/);
});

test('receiver-LN: spent HTLC is terminal done', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 160, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true, spent: true }, ln: { registered: true, held: true, settled: true, preimage: 'ab'.repeat(32) } });
  assert.equal(s.action, 'done');
});

// ---- lnSide='payer': LSP receives LN (held), funds the receiver's on-chain HTLC ----
test('payer-LN: REFUSES to fund on-chain until the payer LN is held (our recoup)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
});

test('payer-LN: funds on-chain once the LN is held', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 } });
  assert.equal(s.action, 'fund-onchain');
});

test('payer-LN: REFUSES to fund on-chain if the LN hold is too close to expiry', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer } });
  assert.equal(s.action, 'fail-closed');
});

test('payer-LN: after funding, waits for the receiver to claim', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false }, ln: { registered: true, held: true, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
});

test('payer-LN: on the receiver claim (P read), settles the held LN to recoup', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 120, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) } });
  assert.equal(s.action, 'recoup-settle');
});

test('payer-LN: on-chain spent but P not yet read -> wait (read the witness), never settle blind', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 120, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true }, ln: { registered: true, held: true, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
});

test('payer-LN: no claim by the on-chain CLTV -> refund on-chain (LN hold returns to the payer)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 130, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false }, ln: { registered: true, held: true, settled: false, preimage: null } });
  assert.equal(s.action, 'refund-onchain');
});

test('payer-LN: settled LN is terminal done', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 121, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true }, ln: { registered: true, held: true, settled: true, preimage: 'cd'.repeat(32) } });
  assert.equal(s.action, 'done');
});

// ---- whole-swap atomicity gate (obs.swapLocked): the LSP withholds its ONE value-front action
//      (front-ln for a receiver leg; fund-onchain for a payer leg) until every OTHER leg is locked,
//      so a partial (this leg reveals P while another never locks) is impossible on the shared H. ----
test('receiver-LN: WITHHOLDS the LN front while the other leg is not yet locked (atomicity)', () => {
  // Same state that fronts above (confirmed recoup), but swapLocked=false -> wait, never front.
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R, lockedToLsp: true, confs: 1 }, ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: false });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /atomicity/i);
});

test('receiver-LN: swapLocked:true (explicit) fronts, identical to undefined', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R, lockedToLsp: true, confs: 1 }, ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: true });
  assert.equal(s.action, 'front-ln');
});

test('receiver-LN: the gate NEVER blocks a recoup — settled+unlocked still claims (never strand value)', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 150, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true }, ln: { registered: true, held: true, settled: true, preimage: 'ab'.repeat(32) }, swapLocked: false });
  assert.equal(s.action, 'recoup-claim');
});

test('receiver-LN: the gate NEVER overrides fail-closed — bad recoup fails closed even while unlocked', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: false }, ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: false });
  assert.equal(s.action, 'fail-closed');
});

test('payer-LN: WITHHOLDS the on-chain fund while the other leg is not yet locked (atomicity)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, swapLocked: false });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /atomicity/i);
});

test('payer-LN: the gate only guards the FUND — an already-funded leg proceeds while unlocked', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false }, ln: { registered: true, held: true, settled: false, preimage: null }, swapLocked: false });
  assert.equal(s.action, 'wait');   // awaiting the receiver's claim — not the atomicity withhold
  assert.doesNotMatch(s.reason, /atomicity/i);
});

test('payer-LN: the gate NEVER overrides fail-closed — hold too close to expiry fails closed while unlocked', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, swapLocked: false });
  assert.equal(s.action, 'fail-closed');
});

// ---- guards ----
test('rejects an invalid lnSide', () => {
  assert.throws(() => nextBridgeStep({ lnSide: 'both', amountSat: A }, { tip: 1, onchain: null, ln: {} }));
});

// FUND-SAFETY REGRESSION: an absent/invalid leg amount silently defeats the "never front more than we
// recoup" check (`realAmount < undefined === false`), which is exactly how the live driver-wiring bug let
// the LSP front full value against a 1-sat recoup. The core must fail closed rather than decide against an
// unbounded amount — even when the on-chain HTLC looks perfect (locked, funded, deep confs, long runway).
for (const bad of [undefined, null, 0, -1, NaN, '100000']) {
  test(`fails closed when leg.amountSat is invalid (${JSON.stringify(bad)}) — never front unbounded`, () => {
    const s = nextBridgeStep({ lnSide: 'receiver', amountSat: bad }, { tip: 100, onchain: { funded: true, amountSat: 100000, cltv: 200, lockedToLsp: true, confs: 6 }, ln: { registered: true, held: false, settled: false, preimage: null } });
    assert.equal(s.action, 'fail-closed');
    assert.match(s.reason, /amountSat|unbounded/i);
  });
}

// ============================================================================
// W1 — LOCKTIME-ORDERING GATE (checkBridgeLocktimeOrdering)
// The reverse-cross fund hole: a malicious maker sets a SHORT BTC-HTLC refund locktime T_btc that clears
// the block-runway check, the LSP fronts the taker's ~2h hold, the maker refunds its BTC at T_btc, THEN
// reveals P by claiming the taker's asset — the LSP recoups too late (full-front loss). The gate refuses
// unless btc_refund_wall >= seq_refund_wall + hold_life + margin(6 BTC blocks), computed conservatively.
// ============================================================================
const G = LOCKTIME_GATE_DEFAULTS;
// The honest fleet: T_btc ~tip+100 BTC blocks (~16h) vs T_seq ~tip+240 SEQ blocks (~a few h).
const HONEST = { btcTip: 800000, btcRefundHeight: 800000 + 100, seqTip: 44000, seqRefundHeight: 44000 + 240 };

test('W1 gate: the HONEST fleet passes (T_btc ~tip+100 BTC vs T_seq ~tip+240 SEQ)', () => {
  const g = checkBridgeLocktimeOrdering(HONEST);
  assert.equal(g.ok, true, g.reason);
});

test('W1 gate: a SHORT-T_btc attack is REFUSED (front nothing)', () => {
  // Same seq terms, but the maker offers only ~30 BTC blocks of BTC-refund runway — clears the pure
  // core's 6-block runway yet is nowhere near seq_refund + hold + margin. Must fail closed.
  const g = checkBridgeLocktimeOrdering({ ...HONEST, btcRefundHeight: HONEST.btcTip + 30 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /UNSAFE|refuse|short/i);
});

// Boundary: derived from the live defaults (robust to constant tweaks). With 240 SEQ blocks of seq-refund
// runway, the required BTC-refund seconds map to a threshold count of BTC blocks; exactly at it passes,
// one BTC block below it fails.
{
  const seqBlocks = 240;
  const needSecs = seqBlocks * G.seqSecsPerBlock + G.holdInvoiceLifeSecs + G.marginBtcBlocks * G.btcSecsPerBlock;
  const threshBtcBlocks = Math.ceil(needSecs / G.btcSecsPerBlock);
  test(`W1 gate: boundary — exactly ${threshBtcBlocks} BTC blocks PASSES`, () => {
    const g = checkBridgeLocktimeOrdering({ btcTip: 0, btcRefundHeight: threshBtcBlocks, seqTip: 0, seqRefundHeight: seqBlocks });
    assert.equal(g.ok, true, g.reason);
  });
  test(`W1 gate: boundary — one BTC block below (${threshBtcBlocks - 1}) is REFUSED`, () => {
    const g = checkBridgeLocktimeOrdering({ btcTip: 0, btcRefundHeight: threshBtcBlocks - 1, seqTip: 0, seqRefundHeight: seqBlocks });
    assert.equal(g.ok, false);
  });
}

test('W1 gate: a maker BTC HTLC already at/after its refund height is REFUSED', () => {
  const g = checkBridgeLocktimeOrdering({ ...HONEST, btcRefundHeight: HONEST.btcTip });
  assert.equal(g.ok, false);
  assert.match(g.reason, /already refundable/i);
});

test('W1 gate: a maker who can reveal P LATER (larger T_seq) tightens the gate and is refused', () => {
  // Honest BTC runway (100 blocks) but the maker pushes the asset-HTLC refund far out, so the "last use
  // of P" is later than the BTC recoup window -> refuse.
  const g = checkBridgeLocktimeOrdering({ ...HONEST, seqRefundHeight: HONEST.seqTip + 3000 });
  assert.equal(g.ok, false);
});

for (const bad of [{ btcTip: NaN }, { btcRefundHeight: undefined }, { seqTip: 'x' }, { seqRefundHeight: null }]) {
  test(`W1 gate: invalid input (${JSON.stringify(bad)}) fails closed`, () => {
    const g = checkBridgeLocktimeOrdering({ ...HONEST, ...bad });
    assert.equal(g.ok, false);
  });
}

// ---- W1 FRONT-TIME integration: the gate is re-run inside nextBridgeStep against the LIVE tip at the
//      moment of fronting (obs.crossLock), so a job that PASSED at handshake but whose BTC tip has since
//      DRIFTED (idle, or across a restart/resume) is REFUSED before the un-gated front — not only checked
//      once at handshake. The maker BTC-HTLC refund height is oc.cltv, the live BTC tip is obs.tip; the
//      seq side (T_seq + live seq tip) rides in via obs.crossLock. ----
// A receiver leg poised to front (recoup locked to us, confirmed, whole-swap locked) — the ONLY thing the
// crossLock gate can still veto. T_btc is oc.cltv; move obs.tip to model the BTC tip drifting toward it.
const frontable = (tip, cltv, crossLock) => nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
  tip, onchain: { funded: true, amountSat: A, cltv, lockedToLsp: true, confs: 1 },
  ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: true, ...(crossLock ? { crossLock } : {}) });
const SEQ = { seqTip: 44000, seqRefundHeight: 44000 + 240 };   // honest asset-HTLC refund terms

test('W1 front-time: a HEALTHY live tip (T_btc ~tip+100 BTC) still fronts', () => {
  const s = frontable(800000, 800000 + 100, SEQ);
  assert.equal(s.action, 'front-ln');
});

test('W1 front-time: a DRIFTED live tip (T_btc now ~10 BTC blocks out) is REFUSED at front time', () => {
  // Same T_btc = 800100 that passed at handshake (tip 800000), but the BTC tip has drifted to 800090, so
  // only 10 BTC blocks of refund runway remain: it clears the 6-block front runway yet is nowhere near
  // seq_refund + hold + margin. The front decision must fail closed rather than pay the ~2h hold un-gated.
  const s = frontable(800090, 800000 + 100, SEQ);
  assert.equal(s.action, 'fail-closed');
  assert.match(s.reason, /locktime|drift/i);
});

test('W1 front-time: the SAME T_btc passes at the handshake tip but is refused at the drifted tip', () => {
  const Tbtc = 800000 + 100;
  assert.equal(frontable(800000, Tbtc, SEQ).action, 'front-ln');    // handshake-era tip: safe
  assert.equal(frontable(800090, Tbtc, SEQ).action, 'fail-closed'); // drifted tip: refused
});

test('W1 front-time: an unreadable seq input (NaN) fails closed at front time (never front un-gated)', () => {
  const s = frontable(800000, 800000 + 100, { seqTip: NaN, seqRefundHeight: 44240 });
  assert.equal(s.action, 'fail-closed');
});

test('W1 front-time: absent crossLock leaves the front path UNCHANGED (back-compat / payer + single-leg)', () => {
  // Identical drifted tip as the refused case, but with NO crossLock -> the wall-clock gate does not apply
  // and the leg fronts exactly as before (the pure-block runway is the only on-chain-end check).
  assert.equal(frontable(800090, 800000 + 100, null).action, 'front-ln');
});

test('W1 front-time: the gate NEVER blocks a recoup — a settled leg still claims even if drifted', () => {
  // crossLock present + tip drifted, but the receiver already settled (P revealed): recoup, never strand.
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800090, onchain: { funded: true, amountSat: A, cltv: 800000 + 100, lockedToLsp: true, confs: 1 },
    ln: { registered: true, held: true, settled: true, preimage: 'ab'.repeat(32) }, swapLocked: true, crossLock: SEQ });
  assert.equal(s.action, 'recoup-claim');
});

// ============================================================================
// W1-UNIT — a TIMESTAMP locktime is not a block height. checkBridgeLocktimeOrdering does HEIGHT arithmetic
// (refundHeight - tip); a CLTV >= LOCKTIME_THRESHOLD (500,000,000) is a UNIX timestamp, so a malicious maker
// could set one to make btcBlocksToRefund a huge bogus number that clears the gate. The maker HTLC is refused
// as a non-height at parse (bridge-maker), and the gate ALSO asserts height-ness defensively — fail closed.
// ============================================================================
test('W1-UNIT gate: a TIMESTAMP btcRefundHeight (>= LOCKTIME_THRESHOLD) fails closed (defensive height assert)', () => {
  // Without the defensive assert this would clear the gate: (5e8+800000) - 800000 = 5e8 "blocks" of runway.
  const g = checkBridgeLocktimeOrdering({ ...HONEST, btcRefundHeight: LOCKTIME_THRESHOLD + 800000 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /TIMESTAMP|block height/i);
});

test('W1-UNIT gate: a TIMESTAMP seqRefundHeight fails closed too (either locktime looking like a timestamp)', () => {
  const g = checkBridgeLocktimeOrdering({ ...HONEST, seqRefundHeight: LOCKTIME_THRESHOLD + 44000 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /TIMESTAMP|block height/i);
});

test('W1-UNIT gate: exactly at LOCKTIME_THRESHOLD is a timestamp (refused); one below is a valid height', () => {
  assert.equal(checkBridgeLocktimeOrdering({ ...HONEST, btcRefundHeight: LOCKTIME_THRESHOLD }).ok, false);
  // one below the threshold is a height; with an honest tip it clears the ordering (huge BTC runway).
  assert.equal(checkBridgeLocktimeOrdering({ btcTip: LOCKTIME_THRESHOLD - 100, btcRefundHeight: LOCKTIME_THRESHOLD - 1,
    seqTip: HONEST.seqTip, seqRefundHeight: HONEST.seqRefundHeight }).ok, true);
});

// ============================================================================
// W2(b) — the front-time locktime gate is no longer the COMMITMENT point (that moved to /bridge/asset
// admission, W2a). So a front-time refusal must NOT strand a taker whose asset was ALREADY relayed + claimed:
// once P is PUBLIC (obs.preimage) and the recoup HTLC is still unspent + claimable, the LSP fronts and
// IMMEDIATELY recoups with the known P (zero exposure), so it PROCEEDS. Fail-closed stays only while P is
// NOT public. The recoup HTLC is unspent (oc.spent!==true) and claimable (frontRunway already guaranteed above).
// ============================================================================
const Phex = 'ab'.repeat(32);
// A receiver leg poised to front (recoup locked + confirmed, whole-swap locked), with an optional public P.
const frontableP = (tip, cltv, crossLock, preimage) => nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
  tip, onchain: { funded: true, amountSat: A, cltv, lockedToLsp: true, confs: 1, spent: false },
  ln: { registered: true, held: false, settled: false, preimage: null },
  swapLocked: true, crossLock, ...(preimage !== undefined ? { preimage } : {}) });

test('W2b front-time: a DRIFTED T_btc that would fail-close STILL fronts once P is PUBLIC + recoup unspent', () => {
  // Same drift the W1 test refuses (T_btc 800100 vs tip 800090 -> ~10 blocks, gate fails), but P is public
  // and the recoup HTLC is unspent + claimable -> front + immediate recoup with the known P, zero exposure.
  assert.equal(frontableP(800090, 800000 + 100, SEQ, Phex).action, 'front-ln');
});

test('W2b front-time: the SAME drift with P NOT public is still REFUSED (fail-closed preserved)', () => {
  assert.equal(frontableP(800090, 800000 + 100, SEQ, null).action, 'fail-closed');       // explicit null
  assert.equal(frontableP(800090, 800000 + 100, SEQ, undefined).action, 'fail-closed');  // absent field
});

test('W2b front-time: a NON-hex / short obs.preimage is NOT treated as public P (fail-closed)', () => {
  assert.equal(frontableP(800090, 800000 + 100, SEQ, 'not-a-real-preimage').action, 'fail-closed');
  assert.equal(frontableP(800090, 800000 + 100, SEQ, 'ab').action, 'fail-closed');
});

test('W2b front-time: a HEALTHY tip fronts whether or not P is public (the gate passes on its own)', () => {
  assert.equal(frontableP(800000, 800000 + 100, SEQ, null).action, 'front-ln');
  assert.equal(frontableP(800000, 800000 + 100, SEQ, Phex).action, 'front-ln');
});

test('W2b front-time: P public but the recoup HTLC already SPENT does NOT front on this branch (recoup handled at top)', () => {
  // oc.spent:true short-circuits to the terminal recoup at the top of stepReceiverLn; it never reaches the
  // front path, so a spent recoup is never fronted on the W2b exception (belt-and-suspenders on the invariant).
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800090, onchain: { funded: true, amountSat: A, cltv: 800000 + 100, lockedToLsp: true, confs: 1, spent: true },
    ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: true, crossLock: SEQ, preimage: Phex });
  assert.notEqual(s.action, 'front-ln');
});
