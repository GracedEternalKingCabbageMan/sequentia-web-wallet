// Unit tests for leg-bridge.mjs — the LSP per-leg bridge fund-safety decision core.
// The load-bearing invariant: the LSP NEVER fronts value on a crossed leg unless its recoup on the
// other end is already secured, so it can only ever stall into a refundable no-loss failure.
import test from 'node:test';
import assert from 'node:assert';
import { nextBridgeStep, BRIDGE_DEFAULTS } from './leg-bridge.mjs';

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
