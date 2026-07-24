// Unit tests for leg-bridge.mjs — the LSP per-leg bridge fund-safety decision core.
// The load-bearing invariant: the LSP NEVER fronts value on a crossed leg unless its recoup on the
// other end is already secured, so it can only ever stall into a refundable no-loss failure.
import test from 'node:test';
import assert from 'node:assert';
import { nextBridgeStep, BRIDGE_DEFAULTS, checkBridgeLocktimeOrdering, LOCKTIME_GATE_DEFAULTS, LOCKTIME_THRESHOLD,
  HOLD_LIFE_DEFAULTS, checkTseqWithinBound, requiredTakerHold, takerHoldSettleableToTseq, frontHtlcMintTarget,
  verifyFrontRouteExpiry, checkPayerFundGate, runPayerFundOnce, runPayerRefundOnce,
  runPayerRefundBumpOnce, sizeRefundFee } from './leg-bridge.mjs';

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

test('payer-LN: after funding, waits for the receiver to claim (spendStatus unspent, tip<T_btc)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
});

test('payer-LN: on the receiver claim (spendStatus spent_claim), settles the held LN to recoup', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 120, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) } });
  assert.equal(s.action, 'recoup-settle');
  assert.match(s.reason, /CLAIM branch/);
});

test('payer-LN: on-chain spent but classification UNCERTAIN -> wait (never settle/refund blind)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 120, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'uncertain' }, ln: { registered: true, held: true, settled: false, preimage: null } });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /UNCERTAIN|fail closed/i);
});

test('payer-LN: no claim by the on-chain CLTV (spendStatus unspent) -> refund on-chain', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 130, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: null } });
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
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: null }, swapLocked: false });
  assert.equal(s.action, 'wait');   // awaiting the receiver's claim — not the atomicity withhold
  assert.doesNotMatch(s.reason, /atomicity/i);
});

test('payer-LN: the gate NEVER overrides fail-closed — hold too close to expiry fails closed while unlocked', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A }, { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, swapLocked: false });
  assert.equal(s.action, 'fail-closed');
});

// ---- B — FUND-BEFORE-LOCK (crossFund): the payer BRIDGE where the taker holds P and the maker's asset leg
//      locks ONLY AFTER the LSP funds its BTC HTLC. swapLocked would DEADLOCK (the asset never locks until
//      after the fund), so crossFund REPLACES it — the mirror of the receiver leg's crossLock/recvReady. ----
test('crossFund payer: FUNDS the instant the hold is HELD even though swapLocked:false (no deadlock)', () => {
  // This is the load-bearing case: the native asset leg has NOT locked (it can't — the maker locks it only
  // AFTER this fund), so swapLocked is false; a generic payer leg would WAIT forever. crossFund funds anyway.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, swapLocked: false, crossFund: true });
  assert.equal(s.action, 'fund-onchain');
  assert.match(s.reason, /FUND-BEFORE-LOCK/);
});

test('crossFund payer: swapLocked is IGNORED — both states fund once the hold is HELD', () => {
  const mk = (swapLocked) => nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, swapLocked, crossFund: true });
  assert.equal(mk(false).action, 'fund-onchain');
  assert.equal(mk(true).action, 'fund-onchain');
});

test('crossFund payer: still WAITS until the hold is HELD (never fund before the recoup is held)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null, expiryBlocks: 40 }, crossFund: true });
  assert.equal(s.action, 'wait');
});

test('crossFund payer: still FAILS CLOSED when the hold is too close to expiry (fund-before-lock never overrides)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, crossFund: true });
  assert.equal(s.action, 'fail-closed');
});

test('crossFund payer: recoups on P PUBLIC (taker asset claim) while our BTC HTLC is DEFINITIVELY unspent', () => {
  // The PRIMARY P source: the taker claimed the maker asset leg, so P is public while our BTC HTLC is still
  // DEFINITIVELY unspent (spendStatus:'unspent') by the maker. We settle immediately (recoup), never waiting for
  // the maker's BTC claim — and we never refund a P-public HTLC (the maker claims it with the now-public P).
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 120, onchain: { funded: true, amountSat: A, cltv: 200, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
  assert.match(s.reason, /P is public/i);
});

test('crossFund payer: does NOT settle on a public P for a leg we never funded (oc.funded guard)', () => {
  // Defence: a public P must not let us capture the taker's held BTC unless we actually funded the maker HTLC.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 120, onchain: null, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.notEqual(s.action, 'recoup-settle');
});

test('crossFund payer: past T_btc with NO reveal (spendStatus unspent) still refunds our BTC HTLC (double no-loss)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 200, onchain: { funded: true, amountSat: A, cltv: 200, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'refund-onchain');
});

// ---- C — ALWAYS-RESUMABLE-WHILE-FUNDED: a transient on-chain read must not fail-close / re-fund a FUNDED leg.
test('payer transient outage: onchain null over a KNOWN-funded HTLC WAITS — never fail-closes / re-funds', () => {
  // A momentary bitcoind outage returns onchain:null. onchainKnownFunded (s.htlc.txid persisted) says the leg
  // is already funded, so even a near-expiry hold must NOT fall into the not-funded fail-close branch — WAIT.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, crossFund: true, onchainKnownFunded: true });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /transient|KNOWN funded|re-observe/i);
});
test('payer transient outage: WITHOUT onchainKnownFunded a null-onchain near-expiry hold STILL fails closed (unchanged)', () => {
  // The guard is scoped to KNOWN-funded legs: a genuinely-unfunded near-expiry hold keeps the old fail-close.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, crossFund: true });
  assert.equal(s.action, 'fail-closed');
});

// ---- E — TERMINAL DONE / RELEASE AFTER OUR OWN REFUND, keyed ENTIRELY on chain truth (spendStatus:'spent_refund')
// AND its BURIAL DEPTH (spendConfs >= refundFinalityConfs). The recoup-vs-release decision NO LONGER reads a
// P-less-at-T_btc heuristic or the persisted s.refunded intent — only the on-chain classification + confirmations.
// A refund is a TERMINAL fate (release the taker hold, NEVER recoup) ONLY once it is BURIED to a conventional BTC
// finality (>= refundFinalityConfs, now 6); a shallow (0-conf) refund is NOT terminal (a conflicting maker claim
// can still swap in) — see the SHALLOW-refund tests below.
test('payer refund landed + BURIED: spendStatus spent_refund (confs>=refundFinalityConfs) -> TERMINAL done / RELEASE the hold', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 130, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'done');
  assert.match(s.reason, /REFUND\/CLTV branch|reclaimed|RELEASE the taker hold|BURIED/i);
});
test('payer refund landed + BURIED: spent_refund is TERMINAL even BEFORE tip>=T_btc (chain truth, not tip/intent)', () => {
  // A BURIED refund on chain is authoritative regardless of the observed tip vs T_btc — no reliance on a
  // persisted s.refunded flag (a stale refunded:true is present here and MUST be irrelevant).
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 120, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs + 3 }, ln: { registered: true, held: true, settled: false, preimage: null }, refunded: false, crossFund: true });
  assert.equal(s.action, 'done');
});
test('payer refund vs maker claim: spendStatus spent_claim at/after T_btc RECOUP-SETTLES (chain says the maker claimed)', () => {
  // Even at/after T_btc, a CLAIM spend (spendStatus:'spent_claim') is the maker's claim -> recoup, never done.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 130, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
});
test('payer spend before T_btc, classification UNCERTAIN: STILL waits (never guesses claim vs refund)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 129, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'uncertain' }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'wait');
});

// ---- C(reorg) — REORG-EVICTION RESUMABILITY: a KNOWN-funded leg whose on-chain read reports funded:false
// (a reorg evicted the funding tx) must WAIT/re-observe, NOT re-fund or fail-close — the reorg re-mines the
// same funding txid, so a re-fund would double-broadcast and a fail-close would strand the fund.
test('payer reorg: onchain funded:false over a KNOWN-funded HTLC WAITS — never fail-closes / re-funds', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: { funded: false, amountSat: 0, cltv: 130, spent: false }, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.holdBuffer }, crossFund: true, onchainKnownFunded: true });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /reorg|KNOWN funded|re-observe/i);
});
test('payer reorg: funded:false WITHOUT onchainKnownFunded is a genuinely-unfunded leg (funds when the hold has runway)', () => {
  // Not a reorg of a known-funded leg — just a not-yet-funded on-chain read. With hold runway + crossFund it funds.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 100, onchain: { funded: false, amountSat: 0, cltv: 130, spent: false }, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, crossFund: true });
  assert.equal(s.action, 'fund-onchain');
});

// ---- E(no-double-dip) — RELEASE-ON-BURIED-REFUND, keyed on CHAIN TRUTH (spendStatus:'spent_refund') + BURIAL
// DEPTH, NOT the racy s.refunded intent. Once the BTC HTLC is spent on the REFUND branch AND that refund is BURIED
// (the LSP definitively reclaimed its BTC, no conflicting claim can swap in), a P that LEAKS afterwards (the maker's
// own T_seq negligence) must NEVER also settle the taker's hold — the held LN belongs to the taker. A BURIED
// 'spent_refund' beats a public P. (A SHALLOW refund + public P is the OPPOSITE — the claim wins; see below.)
test('payer NO-DOUBLE-DIP: BURIED spent_refund + P leaks -> TERMINAL done/RELEASE, NEVER recoup-settle (buried refund beats public P)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'done');
  assert.notEqual(s.action, 'recoup-settle');
  assert.match(s.reason, /REFUND\/CLTV branch|RELEASE|not ours to capture|BURIED/i);
});
// INVARIANT ("before any spend confirms: P public => recoup + do not refund"): a DEFINITIVELY-unspent BTC HTLC
// with P public means the taker HAS its asset and the maker will claim our still-open HTLC — so we RECOUP now and
// never refund. (Round-6 keyed this on s.refunded and could WRONGLY refund a P-public HTLC; chain truth corrects it.)
test('payer INVARIANT: UNSPENT + P public -> RECOUP-SETTLE (never refund a P-public HTLC), even with a stale refunded flag', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 131, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, refunded: true, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
});
test('payer control: NOT refunded + P public + spendStatus unspent still RECOUP-SETTLES', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 120, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
});

// ---- CHAIN-TRUTH IGNORES THE RACY s.refunded INTENT (round-6 crash scenarios now resolve on chain fate) ----
// crash-BEFORE-broadcast: s.refunded persisted true, but the refund NEVER broadcast, so the BTC HTLC is really
// claimed by the maker (spent_claim). The stale-true flag must NOT block the recoup (round-6 would have stalled).
test('round-6 crash-before-broadcast: stale refunded:true is IGNORED — spent_claim still RECOUP-SETTLES', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 132, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, refunded: true, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
});
// RPC-error-AFTER-broadcast: the refund DID broadcast + confirm + BURY (spent_refund, confs>=refundFinalityConfs) but the
// RPC errored so s.refunded was cleared to false. The stale-false flag must NOT force a recoup double-dip — chain
// truth (a buried refund) releases the hold.
test('round-6 RPC-error-after-broadcast: stale refunded:false is IGNORED — BURIED spent_refund RELEASES (no double-dip)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 140, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs + 5 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, refunded: false, crossFund: true });
  assert.equal(s.action, 'done');
  assert.notEqual(s.action, 'recoup-settle');
});

// ---- E(reorg-aware) — SHALLOW REFUND IS NOT TERMINAL until a conventional BTC finality. A refund is a terminal
// fate ONLY once BURIED (spendConfs >= refundFinalityConfs, now 6). Below the finality depth a conflicting maker
// CLAIM can still swap in (RBF the unconfirmed refund / a reorg < that depth re-mines the claim), so the LSP must
// KEEP the taker hold ALIVE and watch — releasing it on a shallow refund is the fund-loss this closes (the maker's
// claim swaps in, takes our BTC HTLC, no recoup). The prior 2-conf margin was too shallow to be a true finality. ----
test('payer 0-conf-refund NOT terminal: SHALLOW spent_refund (no confs) + no P -> WAIT, never done (keep watching)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund' }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'done');
  assert.match(s.reason, /SHALLOW|NOT terminal|swap in|keep|re-observe/i);
});
test('payer 0-conf-refund NOT terminal: refund at refundFinalityConfs-1 is still SHALLOW -> WAIT (burial boundary)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs - 1 }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'wait');
});
test('payer 0-conf-refund BURIES at exactly refundFinalityConfs -> DONE (burial boundary, inclusive)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'done');
});
test('payer 0-conf-refund THEN a conflicting CLAIM swaps in (spendStatus flips to spent_claim) -> RECOUP (claim wins)', () => {
  // Tick 1: a shallow refund with no P -> the LSP waits (hold kept alive).
  const shallow = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(shallow.action, 'wait');
  // Tick 2: the maker's claim replaces the unconfirmed refund (RBF/reorg) — the classifier now reads spent_claim,
  // revealing P. The LSP RECOUPS (settles the hold with P) — a claim wins over an unconfirmed refund.
  const swappedIn = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 136, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(swappedIn.action, 'recoup-settle');
});

// ---- CHANGE (round 9): FINALITY is a CONVENTIONAL BTC depth, and a CONFIRMED maker CLAIM beats a conflicted
// (shallow) refund. The classifier's improved output (spendStatus + spendConfs) drives: a spent_claim that
// SUPERSEDES a prior 0-conf refund => RECOUP (not release), and a refund is terminal ONLY at a conventional
// finality (>= 6 confs) — never at the old shallow 2 (a 2-deep refund can still be reorged out for a claim). ----
test('refundFinalityConfs is a CONVENTIONAL BTC finality (>= 6) — a 2-deep refund is no longer terminal', () => {
  assert.ok(BRIDGE_DEFAULTS.refundFinalityConfs >= 6,
    `refundFinalityConfs must be a conventional BTC finality depth (>= 6), got ${BRIDGE_DEFAULTS.refundFinalityConfs}`);
  // Explicit at the OLD threshold: a refund only 2 deep is now SHALLOW -> WAIT (keep the hold alive), never done.
  const twoDeep = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 2 }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(twoDeep.action, 'wait');
  assert.notEqual(twoDeep.action, 'done');
  // ...and only at the full conventional finality (6) does the refund become terminal / release the hold.
  const buried = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 6 }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(buried.action, 'done');
});

// ---- WINDOW SIZING COUPLING: holdBuffer is DERIVED so the refund/hold window ALWAYS spans CONFIRM then BURY.
// The B3 slack (T_btc <= holdCLTV - holdBuffer) is the worst-case wall-clock window a no-reveal refund gets: an
// adversarial maker pins T_btc to exactly that ceiling. holdBuffer must therefore be refundConfirmBudget (mine
// under RBF) + refundFinalityConfs (bury) so a stuck-then-buried refund fits — and the two must never silently
// drift out of the window (the whole point of this round). ----
test('window sizing: holdBuffer === refundFinalityConfs + refundConfirmBudget (DERIVED, never drifts)', () => {
  assert.equal(BRIDGE_DEFAULTS.holdBuffer, BRIDGE_DEFAULTS.refundFinalityConfs + BRIDGE_DEFAULTS.refundConfirmBudget,
    `holdBuffer must be DERIVED = refundFinalityConfs + refundConfirmBudget, got ${BRIDGE_DEFAULTS.holdBuffer}`);
  // The confirm budget must be a GENEROUS margin over the ~3-block RBF target, not the old coincidental "+2".
  assert.ok(BRIDGE_DEFAULTS.refundConfirmBudget >= 12,
    `refundConfirmBudget must be a generous RBF confirm budget (>= 12 blocks), got ${BRIDGE_DEFAULTS.refundConfirmBudget}`);
  assert.equal(BRIDGE_DEFAULTS.holdBuffer, 18);   // 6 + 12 with the current constants
  // refundBumpWithin must cover the tightest gap (== holdBuffer) so a stuck refund at the B3 ceiling still gets
  // the FULL confirm+bury budget of RBF bumping from the first post-refund tick.
  assert.ok(BRIDGE_DEFAULTS.refundBumpWithin >= BRIDGE_DEFAULTS.holdBuffer,
    `refundBumpWithin (${BRIDGE_DEFAULTS.refundBumpWithin}) must be >= holdBuffer (${BRIDGE_DEFAULTS.holdBuffer})`);
});
test('payer 0-conf refund SUPERSEDED by a CONFIRMED maker claim -> RECOUP (classifier resolves the confirmed claim over the conflicted refund)', () => {
  // Tick 1: the LSP's OWN refund is on chain but only 0-conf, no P -> WAIT (hold kept ALIVE, never released on a
  // shallow refund) — exactly the T_btc race: our 0-conf refund conflicts with an in-flight maker claim.
  const shallowRefund = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(shallowRefund.action, 'wait');
  // Tick 2: a reorg swaps the maker's CLAIM in over the shallow refund and it CONFIRMS (spendConfs 3, revealing P).
  // The seqdex classifier resolves the CONFIRMED claim over the conflicted 0-conf refund -> spendStatus spent_claim.
  // The authoritative rule (a confirmed spend beats a 0-conf/conflicted one; a claim reveals P) drives RECOUP: the
  // LSP settles the STILL-LIVE hold with the revealed P — never release (the maker got paid; we recoup our fund).
  const confirmedClaim = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 138, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim', spendConfs: 3 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(confirmedClaim.action, 'recoup-settle');
  assert.match(confirmedClaim.reason, /CLAIM branch|maker got paid/i);
});
// ---- Fix 1 (round 10): RECOUP NEVER AFTER REFUND. A shallow-but-CONFIRMED refund (spendConfs 1..finality-1)
// plus a LATE public P must NEVER recoup-settle: the LSP already reclaimed its BTC on the refund branch, so
// settling the hold too would DOUBLE-DIP (keep the near-certain-to-bury refund AND collect the taker's LN,
// robbing the maker). The pPublic recoup is now decided STRICTLY AFTER the refund fate, and only over a
// DEFINITIVELY-UNSPENT HTLC — so any spent_refund WAITS for chain truth (burial => done, or a conflicting
// spent_claim swapping in => recoup). This is the closed hole. ----
test('Fix 1: payer SHALLOW-CONFIRMED refund + P PUBLIC -> WAIT, NEVER recoup-settle (no double-dip after a refund)', () => {
  // Our own refund is CONFIRMED but shallow (finality-1 deep, not 0-conf so not RBF-bumpable) and P leaks public.
  // The OLD ordering ran pPublic ahead of the shallow-refund branch and recoup-settled here => double-dip. Now it
  // WAITS: the near-certain-to-bury refund is left to bury (=> done), and only a conflicting claim swapping in
  // (spent_claim) would recoup. Never settle the hold on top of our own refund.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs - 1 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'recoup-settle');
  assert.match(s.reason, /NEVER a recoup|double-dip|let the maker/i);
});
test('Fix 1: that same shallow-confirmed refund, once it BURIES, is terminal done (P still public) — never recoup', () => {
  // The wait above resolves cleanly at burial: the refund is the maker's loss (P went public after T_btc, too
  // late), the LSP keeps its BTC and RELEASES the hold to the taker. Still no recoup-settle (no double-dip).
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 140, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'done');
  assert.notEqual(s.action, 'recoup-settle');
});
test('Fix 1: the ONLY recoup after a refund is a conflicting CLAIM swapping in (spent_claim), never pPublic alone', () => {
  // If the maker's claim actually swaps in over the unconfirmed refund (classifier flips to spent_claim), THEN we
  // recoup — chain truth, not an anticipatory pPublic. This is the "watch for a conflicting claim" resolution.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 136, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
});
// The task's explicit Fix-1 case: spent_refund at 3 conf + P public => WAIT (mined-but-shallow, not RBF-bumpable),
// then done at >= refundFinalityConfs, NEVER recoup at any point.
test('Fix 1 (task case): spent_refund @3conf + P public -> WAIT; then @>=finality -> done; never recoup', () => {
  const at3 = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 3 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32), expiryBlocks: 5 }, crossFund: true });
  assert.equal(at3.action, 'wait');               // 3 conf is mined (not 0-conf) => not RBF-bumpable; P public => never recoup
  assert.notEqual(at3.action, 'recoup-settle');
  assert.notEqual(at3.action, 'refund-bump');
  const atFinal = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 138, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: BRIDGE_DEFAULTS.refundFinalityConfs }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32), expiryBlocks: 2 }, crossFund: true });
  assert.equal(atFinal.action, 'done');
  assert.notEqual(atFinal.action, 'recoup-settle');
});

// ---- Fix 2 (round 10): REFUND FEE ADEQUACY — RBF fee-BUMP a 0-conf refund so it confirms inside the hold. ----
// nextBridgeStep emits 'refund-bump' ONLY for a 0-conf spent_refund (mempool, RBF-replaceable), with NO public P
// (a public P means the maker is entitled — let its claim win, never race it), when the hold's remaining life is
// inside the danger window (holdLife <= refundBumpWithin). Everything else stays 'wait' (unchanged).
test('Fix 2: 0-conf refund + no P + hold in the danger window -> refund-bump (RBF the stalled refund)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 131, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 6 }, crossFund: true });
  assert.equal(s.action, 'refund-bump');
  assert.match(s.reason, /FEE-BUMP|RBF|0-conf/i);
});
test('Fix 2: 0-conf refund but P PUBLIC -> WAIT, never bump (let the maker\'s claim win, never race it)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 131, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32), expiryBlocks: 6 }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'refund-bump');
  assert.notEqual(s.action, 'recoup-settle');
});
test('Fix 2: 0-conf refund but hold-life UNKNOWN (no expiryBlocks) -> WAIT (fail-safe; never bump on an unknown deadline)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 131, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'refund-bump');
});
test('Fix 2: 0-conf refund but hold-life OUTSIDE the danger window -> WAIT (not yet urgent, do not burn fees)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 131, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: BRIDGE_DEFAULTS.refundBumpWithin + 5 }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'refund-bump');
});
test('Fix 2: MINED-but-shallow refund (spendConfs 1) in the window -> WAIT (a confirmed tx cannot be RBF-bumped)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 131, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_refund', spendConfs: 1 }, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 6 }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'refund-bump');
});

// ---- Fix 2: sizeRefundFee (pure fee math) ----
test('sizeRefundFee: sizes from estimate * vsize, above the floor', () => {
  const fee = sizeRefundFee({ estSatPerVb: 10, vsize: 250, amountSat: 100000, floorSats: 600, ceilSats: 50000 });
  assert.equal(fee, 2500);   // 10 sat/vB * 250 vB
});
test('sizeRefundFee: floors at floorSats when the estimate is tiny', () => {
  const fee = sizeRefundFee({ estSatPerVb: 0.5, vsize: 250, amountSat: 100000, floorSats: 600, ceilSats: 50000 });
  assert.equal(fee, 600);
});
test('sizeRefundFee: caps at ceilSats', () => {
  const fee = sizeRefundFee({ estSatPerVb: 1000, vsize: 250, amountSat: 10_000_000, floorSats: 600, ceilSats: 50000 });
  assert.equal(fee, 50000);
});
test('sizeRefundFee: never fees past (amount - dust) even below the ceiling', () => {
  const fee = sizeRefundFee({ estSatPerVb: 1000, vsize: 250, amountSat: 5000, floorSats: 600, ceilSats: 50000, dustSats: 546 });
  assert.equal(fee, 5000 - 546);
});
test('sizeRefundFee: a bump escalates the last fee by bumpFactor (min-increment) even when the estimate is flat', () => {
  const fee = sizeRefundFee({ estSatPerVb: 4, vsize: 250, amountSat: 100000, floorSats: 600, ceilSats: 50000, lastFee: 2000, bumpFactor: 1.5 });
  assert.equal(fee, 3000);   // max(estimate 1000, lastFee*1.5 = 3000, floor 600)
});

// ---- Fix 2: runPayerRefundBumpOnce (pure orchestrator) ----
test('runPayerRefundBumpOnce: 0-conf spent_refund + new block + higher fee -> RBF rebroadcast', async () => {
  let rebroadcastFee = null;
  const r = await runPayerRefundBumpOnce({
    classifySpend: async () => ({ status: 'spent_refund', spendConfs: 0 }),
    tipAdvanced: async () => true,
    computeFee: async () => ({ fee: 3000, bump: true }),
    rebroadcast: async (fee) => { rebroadcastFee = fee; return 'txid'; },
  });
  assert.equal(r.bumped, true);
  assert.equal(rebroadcastFee, 3000);
});
test('runPayerRefundBumpOnce: a refund that CONFIRMED (spendConfs >= 1) is NOT bumped', async () => {
  let called = false;
  const r = await runPayerRefundBumpOnce({
    classifySpend: async () => ({ status: 'spent_refund', spendConfs: 2 }),
    tipAdvanced: async () => true,
    computeFee: async () => ({ fee: 9999, bump: true }),
    rebroadcast: async () => { called = true; return 'x'; },
  });
  assert.equal(r.bumped, false);
  assert.equal(called, false);
});
test('runPayerRefundBumpOnce: a claim that swapped in (spent_claim) is NOT bumped (driver recoups instead)', async () => {
  let called = false;
  const r = await runPayerRefundBumpOnce({
    classifySpend: async () => ({ status: 'spent_claim', spendConfs: 0 }),
    tipAdvanced: async () => true,
    computeFee: async () => ({ fee: 9999, bump: true }),
    rebroadcast: async () => { called = true; return 'x'; },
  });
  assert.equal(r.bumped, false);
  assert.equal(called, false);
});
test('runPayerRefundBumpOnce: throttled to one bump per new BTC block (no tip advance -> no bump)', async () => {
  let called = false;
  const r = await runPayerRefundBumpOnce({
    classifySpend: async () => ({ status: 'spent_refund', spendConfs: 0 }),
    tipAdvanced: async () => false,
    computeFee: async () => ({ fee: 9999, bump: true }),
    rebroadcast: async () => { called = true; return 'x'; },
  });
  assert.equal(r.bumped, false);
  assert.equal(called, false);
});
test('runPayerRefundBumpOnce: no strictly-higher fee (ceiling reached) -> no rebroadcast', async () => {
  let called = false;
  const r = await runPayerRefundBumpOnce({
    classifySpend: async () => ({ status: 'spent_refund', spendConfs: 0 }),
    tipAdvanced: async () => true,
    computeFee: async () => ({ fee: 50000, bump: false }),
    rebroadcast: async () => { called = true; return 'x'; },
  });
  assert.equal(r.bumped, false);
  assert.equal(called, false);
});
test('runPayerRefundBumpOnce: an uncertain/unreadable classifier PROPAGATES (fail closed, no bump)', async () => {
  await assert.rejects(() => runPayerRefundBumpOnce({
    classifySpend: async () => { throw new Error('UNCERTAIN'); },
    tipAdvanced: async () => true,
    computeFee: async () => ({ fee: 3000, bump: true }),
    rebroadcast: async () => 'x',
  }), /UNCERTAIN/);
});
test('runPayerRefundBumpOnce: fails closed if any injected primitive is missing', async () => {
  await assert.rejects(() => runPayerRefundBumpOnce({ classifySpend: async () => ({ status: 'spent_refund' }) }), /must all be functions/);
});
test('payer spent_claim at 0-conf -> RECOUP-SETTLE (a claim reveals P immutably — safe to act at ANY depth)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 118, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'spent_claim', spendConfs: 0 }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'recoup-settle');
  assert.match(s.reason, /CLAIM|any depth|0-conf/i);
});
test('payer UNCERTAIN spend -> WAIT (retry), never release or double-broadcast — even with a public P', () => {
  // An uncertain spend could be an already-buried refund, so a public P alone must NOT force a recoup here.
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 135, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'uncertain' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'done');
  assert.notEqual(s.action, 'recoup-settle');
});

// ---- CLASSIFIER-DOWN / ABSENT => FAIL CLOSED (wait), even at/after T_btc (never a blind refund) ----
test('payer uncertain-classifier at/after T_btc: WAIT, never refund on an unresolved chain read', () => {
  // Even with tip>=T_btc, an UNCERTAIN classification must NOT drive refund-onchain — only a DEFINITIVELY-unspent
  // read may refund. The action is wait (the reason legitimately mentions "refund" while explaining why we do NOT).
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 200, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'uncertain' }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.notEqual(s.action, 'refund-onchain');
  assert.match(s.reason, /UNCERTAIN|fail closed/i);
});
test('payer uncertain-classifier + P public: WAIT (a maybe-refund must not force a recoup double-dip)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 200, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: true, spendStatus: 'uncertain' }, ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true });
  assert.equal(s.action, 'wait');
});
test('payer absent spendStatus over a funded leg: FAIL CLOSED wait (classifier not yet read)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 200, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false }, ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /UNAVAILABLE|fail closed/i);
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
// W1 — LOCKTIME-ORDERING GATE (checkBridgeLocktimeOrdering) — fund-safe BY CONSTRUCTION, block-based.
// The reverse-cross fund hole: a malicious maker sets a SHORT BTC-HTLC refund locktime T_btc that clears
// the block-runway check, the LSP fronts the taker's long-lived hold, the maker refunds its BTC at T_btc,
// THEN reveals P by claiming the taker's asset — the LSP recoups too late (full-front loss). The gate now
// refuses unless recoupDeadlineBlocks = (T_btc - btcTip) - claimMargin >= requiredTakerBlocks (the front
// HTLC's min-final-CLTV sized from T_seq with the SINGLE conservative-fast BTC block time). One BTC-time
// assumption for BOTH the front-HTLC sizing AND the recoup deadline — no second divisor, so there is no
// fast-BTC band where only one side is protected. A short T_btc (or the honest ~100-block fleet, whose
// T_btc simply cannot cover a ~210-block front HTLC) is REJECTED and the wallet falls back to native.
// ============================================================================
const G = LOCKTIME_GATE_DEFAULTS;   // { claimMarginBlocks }
// A large-enough-T_btc maker: T_btc ~tip+260 BTC blocks vs T_seq ~tip+240 SEQ blocks. 240 SEQ blocks need a
// ~210-block front HTLC (30600s / 150 + 6), so recoupDeadline = 260 - 6 = 254 >= 210 -> CLEARS with headroom.
const HONEST = { btcTip: 800000, btcRefundHeight: 800000 + 260, seqTip: 44000, seqRefundHeight: 44000 + 240 };
// The required front-HTLC survival in BTC blocks for the honest T_seq (== the minted min-final-CLTV).
const REQ_BLOCKS = requiredTakerHold({ seqTip: 44000, seqRefundHeight: 44000 + 240 }).minFinalCltvBlocks;

test('W1 gate: a large-enough-T_btc maker CLEARS (T_btc ~tip+260 BTC vs T_seq ~tip+240 SEQ)', () => {
  const g = checkBridgeLocktimeOrdering(HONEST);
  assert.equal(g.ok, true, g.reason);
  assert.equal(g.minFinalCltvBlocks, REQ_BLOCKS);                 // the front HTLC is minted at exactly this
  assert.ok(g.minFinalCltvBlocks <= g.recoupDeadlineBlocks, 'minFinalCltvBlocks must fit inside the recoup deadline');
});

test('W1 gate: the honest SHORT-T_btc fleet (~100 BTC blocks) is now REJECTED (its T_btc cannot cover the front HTLC) — falls back to native', () => {
  // The whole point of the fix: T_btc ~tip+100 gives recoupDeadline 94, below the ~210 the front HTLC must
  // survive to cover a 240-block T_seq. Correct to REFUSE — the wallet falls back to native (no bridge).
  const g = checkBridgeLocktimeOrdering({ ...HONEST, btcRefundHeight: HONEST.btcTip + 100 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /UNSAFE|refuse|native|recoup runway/i);
  assert.ok(g.recoupDeadlineBlocks < g.requiredTakerBlocks);
});

test('W1 gate: a SHORT-T_btc attack is REFUSED (front nothing)', () => {
  // Same seq terms, but the maker offers only ~30 BTC blocks of BTC-refund runway — nowhere near the front
  // HTLC's required survival. Must fail closed.
  const g = checkBridgeLocktimeOrdering({ ...HONEST, btcRefundHeight: HONEST.btcTip + 30 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /UNSAFE|refuse|short|recoup runway/i);
});

// Boundary: derived from the live defaults (robust to constant tweaks). recoupDeadline = (T_btc - tip) -
// claimMargin must be >= requiredTakerBlocks; exactly at it passes, one BTC block below it fails.
{
  const seqBlocks = 240;
  const reqBlocks = requiredTakerHold({ seqTip: 0, seqRefundHeight: seqBlocks }).minFinalCltvBlocks;
  const threshBtcBlocks = reqBlocks + G.claimMarginBlocks;   // (T_btc - tip) that makes recoupDeadline == reqBlocks
  test(`W1 gate: boundary — exactly ${threshBtcBlocks} BTC blocks PASSES (recoupDeadline == requiredTakerBlocks)`, () => {
    const g = checkBridgeLocktimeOrdering({ btcTip: 0, btcRefundHeight: threshBtcBlocks, seqTip: 0, seqRefundHeight: seqBlocks });
    assert.equal(g.ok, true, g.reason);
    assert.equal(g.recoupDeadlineBlocks, g.requiredTakerBlocks);
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

test('W1 gate: a maker who can reveal P LATER (larger T_seq) needs even more T_btc and is refused', () => {
  // Ample BTC runway (260 blocks) but the maker pushes the asset-HTLC refund far out — beyond the max T_seq
  // bound, which requiredTakerHold enforces inside the gate -> refuse (fail closed).
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
const OKC = 800000 + 260;   // a maker T_btc large enough to cover the ~210-block front HTLC for a 240-block T_seq

test('W1 front-time: a HEALTHY live tip (T_btc ~tip+260 BTC) fronts', () => {
  const s = frontable(800000, OKC, SEQ);
  assert.equal(s.action, 'front-ln');
});

test('W1 front-time: a DRIFTED live tip (T_btc runway now below the front HTLC) is REFUSED at front time', () => {
  // Same T_btc = 800260 that passed at handshake (tip 800000, recoupDeadline 254 >= ~210), but the BTC tip
  // has drifted to 800090: recoupDeadline 164 < the ~210 blocks the front HTLC must survive. The front
  // decision must fail closed rather than pay the long-lived hold un-gated.
  const s = frontable(800090, OKC, SEQ);
  assert.equal(s.action, 'fail-closed');
  assert.match(s.reason, /locktime|drift/i);
});

test('W1 front-time: the SAME T_btc passes at the handshake tip but is refused at the drifted tip', () => {
  assert.equal(frontable(800000, OKC, SEQ).action, 'front-ln');    // handshake-era tip: safe
  assert.equal(frontable(800090, OKC, SEQ).action, 'fail-closed'); // drifted tip: refused
});

test('W1 front-time: an unreadable seq input (NaN) fails closed at front time (never front un-gated)', () => {
  const s = frontable(800000, OKC, { seqTip: NaN, seqRefundHeight: 44240 });
  assert.equal(s.action, 'fail-closed');
});

test('W1 front-time: absent crossLock leaves the front path UNCHANGED (back-compat / payer + single-leg)', () => {
  // Identical drifted tip as the refused case, but with NO crossLock -> the locktime gate does not apply and
  // the leg fronts exactly as before (the pure-block frontRunway is the only on-chain-end check).
  assert.equal(frontable(800090, OKC, null).action, 'front-ln');
});

test('W1 front-time: the gate NEVER blocks a recoup — a settled leg still claims even if drifted', () => {
  // crossLock present + tip drifted, but the receiver already settled (P revealed): recoup, never strand.
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800090, onchain: { funded: true, amountSat: A, cltv: OKC, lockedToLsp: true, confs: 1 },
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
  // one below the threshold is a height; with a tip that leaves ~300 BTC blocks of runway it clears the ordering.
  assert.equal(checkBridgeLocktimeOrdering({ btcTip: LOCKTIME_THRESHOLD - 300, btcRefundHeight: LOCKTIME_THRESHOLD - 1,
    seqTip: HONEST.seqTip, seqRefundHeight: HONEST.seqRefundHeight }).ok, true);
});

// ============================================================================
// W1-MINT — frontHtlcMintTarget: couple the minted front HTLC expiry to an ABSOLUTE Bitcoin height at PAY time.
// The STALENESS/DRIFT hole: the front HTLC's min-final-CLTV used to be sized ONCE at handshake and handed to
// getroute as a DELTA at pay time, so the minted absolute expiry = payTip + staleDelta FLOATED UP with the BTC
// tip — overshooting T_btc - claimMargin (LSP can't recoup) or dying before T_seq. The fix pins H = T_btc -
// claimMargin and returns DELTA = H - payTip, re-gating at the live tip. INVARIANT: T_seq_cover <= H <= T_btc -
// claimMargin, or fail closed. CM = the claim margin the upper bound is pinned inside.
// ============================================================================
const CM = LOCKTIME_GATE_DEFAULTS.claimMarginBlocks;   // 6
const UPPER = HONEST.btcRefundHeight - CM;             // 800254 — the maker's actual refund minus the claim margin

test('W1-MINT: an honest large-T_btc (260-block) maker mints a valid front target that still settles', () => {
  const m = frontHtlcMintTarget(HONEST);
  assert.equal(m.ok, true);
  assert.equal(m.absoluteExpiryHeight, UPPER);                       // pinned to T_btc - claimMargin
  assert.equal(HONEST.btcTip + m.finalCltvDelta, m.absoluteExpiryHeight);   // minted expiry == H EXACTLY
  // INVARIANT: T_seq_cover <= H <= T_btc - claimMargin
  assert.ok(m.tSeqCoverHeight <= m.absoluteExpiryHeight, 'H covers T_seq');
  assert.ok(m.absoluteExpiryHeight <= UPPER, 'H never above T_btc - claimMargin');
});

test('W1-MINT: a fresh mint sits the absolute expiry EXACTLY at T_btc - claimMargin, drift-invariant', () => {
  const m = frontHtlcMintTarget(HONEST);
  assert.equal(m.absoluteExpiryHeight, UPPER);                       // 800254
  // The DELTA is derived from the live tip to that ABSOLUTE height, so a later tip advance keeps H fixed:
  const drifted = frontHtlcMintTarget({ ...HONEST, btcTip: HONEST.btcTip + 40 });
  assert.equal(drifted.absoluteExpiryHeight, m.absoluteExpiryHeight);           // SAME absolute height regardless of tip
  assert.equal(drifted.finalCltvDelta, m.finalCltvDelta - 40);                  // delta shrinks so payTip+delta stays == H
  assert.equal((HONEST.btcTip + 40) + drifted.finalCltvDelta, m.absoluteExpiryHeight);
});

test('W1-MINT REGRESSION: BTC tip drifts UP so the STALE handshake delta would overshoot T_btc — now FAILS CLOSED', () => {
  // Handshake sized the front HTLC's min-final-CLTV as a DELTA from the handshake tip (the OLD bug).
  const staleDelta = requiredTakerHold({ seqTip: HONEST.seqTip, seqRefundHeight: HONEST.seqRefundHeight }).minFinalCltvBlocks; // 210
  const payTip = HONEST.btcTip + 90;   // BTC advanced 90 blocks between handshake and pay
  // WITNESS the old defect: minting with the stale DELTA from the drifted pay tip lands the incoming HTLC's
  // absolute expiry ABOVE T_btc - claimMargin (indeed above T_btc itself) — the LSP could NOT have recouped.
  const oldMintedExpiry = payTip + staleDelta;                       // 800090 + 210 = 800300
  assert.ok(oldMintedExpiry > UPPER, 'regression witness: the stale-delta mint overshoots T_btc - claimMargin');
  assert.ok(oldMintedExpiry > HONEST.btcRefundHeight, 'the stale-delta mint even outlives T_btc — full-front loss');
  // The FIX: the fresh mint target re-gates at the live pay tip and FAILS CLOSED — no front, no loss.
  const m = frontHtlcMintTarget({ btcTip: payTip, btcRefundHeight: HONEST.btcRefundHeight, seqTip: HONEST.seqTip, seqRefundHeight: HONEST.seqRefundHeight });
  assert.equal(m.ok, false);
  assert.ok(Number.isNaN(m.finalCltvDelta), 'no mint delta is produced on a fail-closed');
});

test('W1-MINT: a MODERATE drift still inside the window mints AT the upper bound (never overshoots T_btc)', () => {
  const payTip = HONEST.btcTip + 20;   // recoupDeadline (800260-800020)-6 = 234 >= the ~210 required
  const m = frontHtlcMintTarget({ btcTip: payTip, btcRefundHeight: HONEST.btcRefundHeight, seqTip: HONEST.seqTip, seqRefundHeight: HONEST.seqRefundHeight });
  assert.equal(m.ok, true);
  assert.equal(m.absoluteExpiryHeight, UPPER);                       // still pinned to the upper bound
  assert.equal(payTip + m.finalCltvDelta, UPPER);                    // minted expiry == H exactly, never above
  assert.ok(m.tSeqCoverHeight <= m.absoluteExpiryHeight, 'still covers T_seq');
});

test('W1-MINT: gated == minted — the mint delta IS the live-tip gate recoup runway', () => {
  const g = checkBridgeLocktimeOrdering(HONEST);
  const m = frontHtlcMintTarget(HONEST);
  assert.equal(g.ok, true);
  assert.equal(m.ok, true);
  assert.equal(m.finalCltvDelta, g.recoupDeadlineBlocks);           // the front HTLC's delta IS the gate's recoup runway
  assert.equal(m.requiredTakerBlocks, g.requiredTakerBlocks);       // same required survival from the same seqTip
  assert.ok(m.absoluteExpiryHeight - HONEST.btcTip >= m.requiredTakerBlocks, 'H - payTip >= requiredTakerBlocks (covers T_seq)');
});

test('W1-MINT: a short T_btc (gate fails) fails the mint target closed (no delta)', () => {
  const m = frontHtlcMintTarget({ ...HONEST, btcRefundHeight: HONEST.btcTip + 100 });  // recoupDeadline 94 < ~210
  assert.equal(m.ok, false);
  assert.ok(Number.isNaN(m.finalCltvDelta));
  assert.match(m.reason, /front mint target/i);
});

test('W1-MINT: an unreadable live tip (NaN) fails the mint target closed (never mint un-gated)', () => {
  assert.equal(frontHtlcMintTarget({ ...HONEST, btcTip: NaN }).ok, false);
  assert.equal(frontHtlcMintTarget({ ...HONEST, seqTip: NaN }).ok, false);
});

test('W1-MINT: a TIMESTAMP T_btc fails the mint target closed (height assert inherited from the gate)', () => {
  const m = frontHtlcMintTarget({ ...HONEST, btcRefundHeight: LOCKTIME_THRESHOLD + 800000 });
  assert.equal(m.ok, false);
  assert.match(m.reason, /TIMESTAMP|block height/i);
});

test('W1-MINT: the INVARIANT T_seq_cover <= H <= T_btc - claimMargin holds across drift regimes (or fails closed)', () => {
  for (const btcDrift of [0, 5, 20, 44, 45, 60, 90, 150]) {
    for (const seqDrift of [0, 10, 60, 120]) {
      const btcTip = HONEST.btcTip + btcDrift;
      const seqTip = HONEST.seqTip + seqDrift;
      const m = frontHtlcMintTarget({ btcTip, btcRefundHeight: HONEST.btcRefundHeight, seqTip, seqRefundHeight: HONEST.seqRefundHeight });
      if (!m.ok) continue;   // fail-closed is always safe (no front, no loss)
      const tag = `btcDrift ${btcDrift}, seqDrift ${seqDrift}`;
      assert.equal(m.absoluteExpiryHeight, UPPER, `H pinned to upper bound (${tag})`);
      assert.equal(btcTip + m.finalCltvDelta, UPPER, `minted expiry == H exactly (${tag})`);
      assert.ok(m.tSeqCoverHeight <= m.absoluteExpiryHeight, `lower bound: H covers T_seq (${tag})`);
      assert.ok(m.absoluteExpiryHeight <= UPPER, `upper bound: H never above T_btc - claimMargin (${tag})`);
    }
  }
});

// ============================================================================
// W1-MINT-VERIFY — verifyFrontRouteExpiry: verify the ACTUAL committed final-hop CLTV, not the intended delta.
// THE HOLE (round 6): frontHtlcMintTarget pins the INTENDED expiry to H = T_btc - claimMargin but computes its
// delta against BITCOIND's tip; getroute/sendpay run on the CLN node and commit the final-hop expiry at
// (CLN's OWN blockheight) + (the route's final-hop delay). Chain-view skew (δ = clnBlockheight - btcTip) or
// getroute padding the final delay pushes the ACTUAL expiry off H — δ>0 above T_btc - claimMargin (LSP can't
// recoup) or a short delay below T_seq (taker's hold dies). The FIX bases the delta on CLN's OWN height AND
// re-verifies the route's OWN committed delay against [T_seq cover, T_btc - claimMargin] before sendpay.
// The driver builds the getroute delta as (H - clnBlockheight); a route that honours it commits H exactly.
// ============================================================================
const driverDelta = (m, clnBlockheight) => m.absoluteExpiryHeight - clnBlockheight;   // what frontLn now hands getroute

test('W1-MINT-VERIFY: CLN height AHEAD of bitcoind (δ>0) makes the ACTUAL committed expiry overshoot T_btc-claimMargin — FAILS CLOSED', () => {
  const m = frontHtlcMintTarget(HONEST);
  assert.equal(m.ok, true);
  // The OLD bug: the delta was sized off BITCOIND's tip (payBtcTip). If CLN leads bitcoind by δ, a route that
  // commits that stale delta from CLN's OWN height lands the ACTUAL expiry at H + δ — above the upper bound.
  const delta = 8;                                        // δ = clnBlockheight - payBtcTip
  const clnBlockheight = HONEST.btcTip + delta;           // CLN ahead of bitcoind
  const staleDelta = m.finalCltvDelta;                    // H - payBtcTip (the intended delta OFF bitcoind)
  assert.ok(clnBlockheight + staleDelta > m.absoluteExpiryHeight, 'regression witness: δ pushes the actual expiry past the upper bound');
  const v = verifyFrontRouteExpiry({ clnBlockheight, actualDelay: staleDelta, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(v.ok, false);
  assert.match(v.reason, /OVERSHOOTS T_btc - claimMargin/);
  assert.equal(clnBlockheight + staleDelta, m.absoluteExpiryHeight + delta);   // the ACTUAL expiry = H + δ, unrecoupable
});

test('W1-MINT-VERIFY: the FIX — basing the delta on CLN\'s OWN height lands the ACTUAL expiry at H exactly despite δ>0', () => {
  const m = frontHtlcMintTarget(HONEST);
  const delta = 8;
  const clnBlockheight = HONEST.btcTip + delta;           // same skew that broke the stale-delta path above
  const fixedDelta = driverDelta(m, clnBlockheight);      // H - clnBlockheight — what frontLn now requests
  // A route that HONOURS the CLN-based request commits clnBlockheight + fixedDelta = H exactly — no drift.
  const v = verifyFrontRouteExpiry({ clnBlockheight, actualDelay: fixedDelta, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.actualAbsExpiry, m.absoluteExpiryHeight);   // the ACTUAL committed expiry is H, recoupable
});

test('W1-MINT-VERIFY: getroute PADDING the final delay above the request (shadow-route / min_final_cltv) — caught + FAILS CLOSED', () => {
  const m = frontHtlcMintTarget(HONEST);
  const clnBlockheight = HONEST.btcTip;                   // heights matched — the skew is NOT the cause here
  const requested = driverDelta(m, clnBlockheight);       // H - clnBlockheight
  const padded = requested + 20;                          // getroute pads the final hop past what we asked
  assert.ok(clnBlockheight + padded > m.absoluteExpiryHeight, 'padding pushes the actual expiry past the upper bound');
  const v = verifyFrontRouteExpiry({ clnBlockheight, actualDelay: padded, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(v.ok, false);
  assert.match(v.reason, /OVERSHOOTS T_btc - claimMargin/);
});

test('W1-MINT-VERIFY: an in-window ACTUAL delay (heights matched, no padding) PROCEEDS', () => {
  const m = frontHtlcMintTarget(HONEST);
  const clnBlockheight = HONEST.btcTip;
  const actualDelay = driverDelta(m, clnBlockheight);     // route honours the request -> lands at H
  const v = verifyFrontRouteExpiry({ clnBlockheight, actualDelay, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.actualAbsExpiry, m.absoluteExpiryHeight);
  assert.ok(m.tSeqCoverHeight <= v.actualAbsExpiry && v.actualAbsExpiry <= m.absoluteExpiryHeight);
});

test('W1-MINT-VERIFY: an honest large-T_btc maker with MATCHED heights settles (full path: mint -> CLN-based delta -> verify)', () => {
  const m = frontHtlcMintTarget(HONEST);
  assert.equal(m.ok, true);
  const clnBlockheight = HONEST.btcTip;                   // CLN and bitcoind agree
  const finalCltv = driverDelta(m, clnBlockheight);       // exactly what frontLn hands getroute
  assert.ok(finalCltv > 0);
  const route = { route: [{ delay: finalCltv + 40 }, { delay: finalCltv }] };   // last hop == requested (no padding)
  const actualDelay = route.route[route.route.length - 1].delay;
  const v = verifyFrontRouteExpiry({ clnBlockheight, actualDelay, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.actualAbsExpiry, m.absoluteExpiryHeight);   // settles: LSP recoups strictly before T_btc, hold covers T_seq
});

test('W1-MINT-VERIFY: a too-SHORT actual delay (expiry BELOW T_seq cover) FAILS CLOSED (taker-protection lower bound)', () => {
  const m = frontHtlcMintTarget(HONEST);
  const clnBlockheight = HONEST.btcTip;
  // A final delay that lands the ACTUAL expiry one block below the T_seq cover height -> the taker's hold could
  // die before it settles. Even though it does NOT overshoot T_btc, the lower bound must reject it.
  const shortDelay = (m.tSeqCoverHeight - 1) - clnBlockheight;
  assert.ok(clnBlockheight + shortDelay < m.tSeqCoverHeight);
  assert.ok(clnBlockheight + shortDelay <= m.absoluteExpiryHeight, 'this one is short, not an overshoot');
  const v = verifyFrontRouteExpiry({ clnBlockheight, actualDelay: shortDelay, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(v.ok, false);
  assert.match(v.reason, /BELOW the T_seq cover/);
});

test('W1-MINT-VERIFY: exactly AT each bound is accepted (inclusive window)', () => {
  const m = frontHtlcMintTarget(HONEST);
  const clnBlockheight = HONEST.btcTip;
  const atUpper = verifyFrontRouteExpiry({ clnBlockheight, actualDelay: m.absoluteExpiryHeight - clnBlockheight, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(atUpper.ok, true, atUpper.reason);              // == T_btc - claimMargin is fine (LSP still recoups)
  const atLower = verifyFrontRouteExpiry({ clnBlockheight, actualDelay: m.tSeqCoverHeight - clnBlockheight, tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight });
  assert.equal(atLower.ok, true, atLower.reason);              // == T_seq cover is fine (hold just covers T_seq)
});

test('W1-MINT-VERIFY: a non-finite / degenerate input fails closed (never sendpay on an unverifiable route)', () => {
  const m = frontHtlcMintTarget(HONEST);
  const base = { clnBlockheight: HONEST.btcTip, actualDelay: driverDelta(m, HONEST.btcTip), tSeqCoverHeight: m.tSeqCoverHeight, absoluteExpiryHeight: m.absoluteExpiryHeight };
  assert.equal(verifyFrontRouteExpiry({ ...base, clnBlockheight: NaN }).ok, false);      // unreadable CLN tip
  assert.equal(verifyFrontRouteExpiry({ ...base, actualDelay: NaN }).ok, false);         // missing route delay
  assert.equal(verifyFrontRouteExpiry({ ...base, actualDelay: 0 }).ok, false);           // non-positive delay
  assert.equal(verifyFrontRouteExpiry({ ...base, actualDelay: -5 }).ok, false);
  assert.equal(verifyFrontRouteExpiry({ ...base, tSeqCoverHeight: NaN }).ok, false);
  assert.equal(verifyFrontRouteExpiry({ ...base, absoluteExpiryHeight: NaN }).ok, false);
  assert.equal(verifyFrontRouteExpiry().ok, false);                                       // no args at all
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
  assert.equal(frontableP(800000, OKC, SEQ, null).action, 'front-ln');
  assert.equal(frontableP(800000, OKC, SEQ, Phex).action, 'front-ln');
});

test('W2b front-time: P public but the recoup HTLC already SPENT does NOT front on this branch (recoup handled at top)', () => {
  // oc.spent:true short-circuits to the terminal recoup at the top of stepReceiverLn; it never reaches the
  // front path, so a spent recoup is never fronted on the W2b exception (belt-and-suspenders on the invariant).
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800090, onchain: { funded: true, amountSat: A, cltv: 800000 + 100, lockedToLsp: true, confs: 1, spent: true },
    ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: true, crossLock: SEQ, preimage: Phex });
  assert.notEqual(s.action, 'front-ln');
});

// ============================================================================
// W2 — FRONT-BEFORE-FUND (the reverse-cross receiver leg). The taker exposes its asset leg ONLY AFTER the
// LSP fronts, so for a crossLock leg the front is gated on the taker being HOLD-READY (obs.recvReady) and is
// NO LONGER gated on the whole-swap lock (obs.swapLocked) — the asset leg does not lock until AFTER the front.
// This is the fund-safety reorder: front only with the recoup secured, before the taker commits any asset.
// ============================================================================
// A reverse-cross receiver leg poised to front (recoup locked + confirmed, healthy live-tip locktime ordering),
// parameterised by recvReady + swapLocked so we can prove the front now hinges on hold-ready, not the lock.
const reverseFront = ({ recvReady, swapLocked } = {}) => nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
  tip: 800000, onchain: { funded: true, amountSat: A, cltv: OKC, lockedToLsp: true, confs: 1, spent: false },
  ln: { registered: true, held: false, settled: false, preimage: null }, crossLock: SEQ,
  ...(recvReady !== undefined ? { recvReady } : {}), ...(swapLocked !== undefined ? { swapLocked } : {}) });

test('W2 front-before-fund: FRONTS on recoup-secured WITH hold-ready EVEN WHILE the asset leg is NOT locked', () => {
  // The load-bearing case: swapLocked:false (the native asset leg has NOT locked — it can\'t, the taker funds
  // it only AFTER this front) yet the front proceeds because the taker is hold-ready. The old core withheld
  // here (front-after-relay hole); the new core fronts BEFORE the taker exposes anything.
  const s = reverseFront({ recvReady: true, swapLocked: false });
  assert.equal(s.action, 'front-ln');
  assert.match(s.reason, /FRONT-BEFORE-FUND/);
});

test('W2 front-before-fund: WITHHOLDS the front until the taker is hold-ready (recvReady:false -> wait, no-loss)', () => {
  const s = reverseFront({ recvReady: false, swapLocked: true });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /hold-ready|recv_node_id/);
});

test('W2 front-before-fund: recvReady undefined proceeds (back-compat, mirrors swapLocked===undefined)', () => {
  assert.equal(reverseFront({ recvReady: undefined, swapLocked: false }).action, 'front-ln');
});

test('W2 front-before-fund: swapLocked is IGNORED for a crossLock leg (hold-ready true fronts regardless)', () => {
  // Both swapLocked states front once hold-ready — the asset-leg lock is no longer a precondition.
  assert.equal(reverseFront({ recvReady: true, swapLocked: false }).action, 'front-ln');
  assert.equal(reverseFront({ recvReady: true, swapLocked: true }).action, 'front-ln');
});

test('W2 front-before-fund: the minRecoupConf gate STILL fires (0-conf recoup -> wait, even if hold-ready)', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800000, onchain: { funded: true, amountSat: A, cltv: 800000 + 100, lockedToLsp: true, confs: 0, spent: false },
    ln: { registered: true, held: false, settled: false, preimage: null }, crossLock: SEQ, recvReady: true });
  assert.equal(s.action, 'wait');
  assert.match(s.reason, /confirmation/i);
});

test('W2 front-before-fund: the front-time LOCKTIME gate STILL fires at the front (drifted tip, hold-ready, no public P -> fail-closed)', () => {
  // Hold-ready AND recoup-locked, but the BTC tip has drifted so T_btc is inside the danger window and P is
  // not public: the front must STILL fail closed. Hold-ready never bypasses the locktime ordering.
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800090, onchain: { funded: true, amountSat: A, cltv: 800000 + 100, lockedToLsp: true, confs: 1, spent: false },
    ln: { registered: true, held: false, settled: false, preimage: null }, crossLock: SEQ, recvReady: true });
  assert.equal(s.action, 'fail-closed');
  assert.match(s.reason, /locktime|drift/i);
});

test('W2 front-before-fund: hold-ready NEVER blocks a recoup — a settled leg still claims even if recvReady:false', () => {
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 800050, onchain: { funded: true, amountSat: A, cltv: 800000 + 100, lockedToLsp: true, confs: 1, spent: false },
    ln: { registered: true, held: true, settled: true, preimage: Phex }, crossLock: SEQ, recvReady: false });
  assert.equal(s.action, 'recoup-claim');
});

test('W2 front-before-fund: a NON-crossLock receiver leg is UNCHANGED (still gated on swapLocked, not recvReady)', () => {
  // Without crossLock the leg keeps the whole-swap atomicity gate: swapLocked:false withholds regardless of
  // recvReady, and recvReady is not even consulted (it is a reverse-cross-only field).
  const withheld = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R, lockedToLsp: true, confs: 1 },
    ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: false, recvReady: true });
  assert.equal(withheld.action, 'wait');
  assert.match(withheld.reason, /atomicity/i);
  const fronts = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: 100, onchain: { funded: true, amountSat: A, cltv: 100 + R, lockedToLsp: true, confs: 1 },
    ln: { registered: true, held: false, settled: false, preimage: null }, swapLocked: true, recvReady: false });
  assert.equal(fronts.action, 'front-ln');   // recvReady ignored without crossLock
});

// ============================================================================
// W2 — HOLD-LIFE vs T_seq. The taker's BTC-LN hold must stay SETTLEABLE until strictly AFTER the maker's
// LATEST possible asset claim (T_seq). In FRONT-BEFORE-FUND the LSP fronts EARLY, so a FIXED short hold
// (the old 7200s / 2h) lets an adversarial maker WAIT for the hold to lapse, THEN claim the taker's asset
// (reveal P) — the dead hold collects nothing while the asset is gone (full asset loss). The taker sizes its
// hold from T_seq (requiredTakerHold / takerHoldSettleableToTseq); the LSP bounds T_seq (checkTseqWithinBound).
// ============================================================================
const HL = HOLD_LIFE_DEFAULTS;
const seqTipT = 44000;
const honestTseq = seqTipT + 240;   // the honest fleet: asset-HTLC refund ~240 SEQ blocks out

// (1) A HOLD SIZED TO COVER T_seq --------------------------------------------------------------------------
test('hold-life: requiredTakerHold sizes the hold expiry + front CLTV from T_seq (derived from the constants)', () => {
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq });
  assert.equal(r.ok, true, r.reason);
  const expectedSecs = 240 * HL.seqSecsPerBlock + HL.reorgMarginSecs + HL.settleMarginSecs;
  assert.equal(r.requiredSecs, expectedSecs);
  assert.equal(r.holdExpirySecs, Math.ceil(expectedSecs));
  assert.equal(r.minFinalCltvBlocks, Math.ceil(expectedSecs / HL.fastBtcSecsPerBlock) + HL.cltvMarginBlocks);
});

test('hold-life: a hold minted at the required expiry + CLTV is settleable until after T_seq', () => {
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq });
  const cover = takerHoldSettleableToTseq({ seqTip: seqTipT, seqRefundHeight: honestTseq,
    holdExpirySecs: r.holdExpirySecs, minFinalCltvBlocks: r.minFinalCltvBlocks });
  assert.equal(cover.ok, true, cover.reason);
});

test('hold-life: the OLD FIXED 7200s (2h) hold is REFUSED against an honest T_seq (this is the fund-loss bug)', () => {
  // 240 SEQ blocks needs ~8.5h of settleable hold; a fixed 7200s hold lapses long before T_seq -> fail closed.
  const cover = takerHoldSettleableToTseq({ seqTip: seqTipT, seqRefundHeight: honestTseq, holdExpirySecs: 7200 });
  assert.equal(cover.ok, false);
  assert.match(cover.reason, /SHORTER|settleable|T_seq/i);
});

test('hold-life: a T_seq at/below the live tip is now REJECTED by the min bound (degenerate / margin-collapse)', () => {
  // A T_seq at the tip means the taker asset HTLC is already refundable — a degenerate, margin-collapsed leg.
  // The FIX 2b min bound rejects it (was previously admitted as a "margins-only window"); fail closed, no loss.
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: seqTipT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /below the min|margin-collapse|min /i);
});

// (2) A MAKER T_seq BEYOND THE BOUND IS REJECTED -----------------------------------------------------------
test('hold-life bound: a T_seq exactly at the max is accepted', () => {
  assert.equal(checkTseqWithinBound({ seqTip: seqTipT, seqRefundHeight: seqTipT + HL.maxTseqBlocks }).ok, true);
});

test('hold-life bound: a T_seq one block BEYOND the max is REJECTED', () => {
  const g = checkTseqWithinBound({ seqTip: seqTipT, seqRefundHeight: seqTipT + HL.maxTseqBlocks + 1 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /beyond|max/i);
});

test('hold-life bound: requiredTakerHold fails closed for a T_seq far beyond the bound (the LSP handshake refuses it)', () => {
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: seqTipT + HL.maxTseqBlocks + 1000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /beyond|max/i);
});

test('hold-life bound: a TIMESTAMP T_seq (>= LOCKTIME_THRESHOLD) fails closed (defensive height assert)', () => {
  const g = checkTseqWithinBound({ seqTip: seqTipT, seqRefundHeight: LOCKTIME_THRESHOLD + seqTipT });
  assert.equal(g.ok, false);
  assert.match(g.reason, /TIMESTAMP|height/i);
});

// (3) THE TAKER FAILS CLOSED IF IT CANNOT MINT A LONG-ENOUGH HOLD ------------------------------------------
test('hold-life: FAIL CLOSED when the minted hold expiry is even one second short of required', () => {
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq });
  const cover = takerHoldSettleableToTseq({ seqTip: seqTipT, seqRefundHeight: honestTseq, holdExpirySecs: r.requiredSecs - 1 });
  assert.equal(cover.ok, false);
  assert.match(cover.reason, /SHORTER|Fail closed/i);
});

test('hold-life: FAIL CLOSED when the front HTLC min-final-CLTV is too small to span T_seq', () => {
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq });
  const cover = takerHoldSettleableToTseq({ seqTip: seqTipT, seqRefundHeight: honestTseq,
    holdExpirySecs: r.holdExpirySecs, minFinalCltvBlocks: r.minFinalCltvBlocks - 1 });
  assert.equal(cover.ok, false);
  assert.match(cover.reason, /CLTV|lapse/i);
});

test('hold-life: cannot mint a long-enough hold when the required CLTV exceeds the LN maximum -> fail closed', () => {
  // Force infeasibility via a tiny maxFinalCltvBlocks: an honest T_seq then needs more CLTV than the ceiling.
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq, cfg: { maxFinalCltvBlocks: 10 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot mint|maximum|CLTV/i);
});

test('hold-life: takerHoldSettleableToTseq rejects a non-positive / non-finite hold expiry', () => {
  for (const bad of [0, -1, NaN, undefined, 'x']) {
    assert.equal(takerHoldSettleableToTseq({ seqTip: seqTipT, seqRefundHeight: honestTseq, holdExpirySecs: bad }).ok, false);
  }
});

for (const bad of [{ seqTip: NaN }, { seqRefundHeight: undefined }, { seqTip: 'x' }, { seqRefundHeight: null }]) {
  test(`hold-life: invalid input (${JSON.stringify(bad)}) fails closed`, () => {
    assert.equal(requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq, ...bad }).ok, false);
    assert.equal(takerHoldSettleableToTseq({ seqTip: seqTipT, seqRefundHeight: honestTseq, holdExpirySecs: 999999, ...bad }).ok, false);
  });
}

// ============================================================================
// COUPLED CROSS-CHAIN TIMING — fund-safe BY CONSTRUCTION with ONE BTC-time assumption. The invariant, in BTC
// blocks from the front block (both HTLCs live on Bitcoin, so it is regime-independent):
//   requiredTakerBlocks  <=  minFinalCltvBlocks  <=  recoupDeadlineBlocks = (T_btc - btcTip) - claimMargin
// LEFT (taker safe / BUG #1): size the front HTLC's CLTV with the SINGLE conservative-fast BTC block time so its
//   wall-clock life spans requiredSecs (hence past T_seq) EVEN under a fast-BTC burst — a smaller divisor => more
//   blocks. RIGHT (LSP safe): the SAME requiredTakerBlocks is compared against the maker's T_btc recoup runway —
//   no second divisor. The gate passes IFF the safe window is non-empty; a maker whose T_btc cannot cover the
//   front HTLC (incl. the honest ~100-block fleet) is REJECTED and the wallet falls back to native.
// ============================================================================

test('BUG #1 — fast BTC (150s/block) still leaves the front HTLC alive PAST T_seq (the old 600 divisor lapsed early)', () => {
  const FAST = 150;   // an adversarial fast-BTC burst: the WORST case for the front HTLC's wall-clock life
  const r = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq });
  assert.equal(r.ok, true, r.reason);
  const frontHtlcWallSecs = r.minFinalCltvBlocks * FAST;        // the front HTLC's real wall-clock life at fast BTC
  const tSeqWallSecs = 240 * HL.seqSecsPerBlock;                // the maker's LATEST asset claim (conservative slow)
  assert.ok(frontHtlcWallSecs > tSeqWallSecs, `front HTLC ${frontHtlcWallSecs}s must outlast T_seq ${tSeqWallSecs}s`);
  assert.ok(frontHtlcWallSecs >= r.requiredSecs, `front HTLC ${frontHtlcWallSecs}s must span the full required window ${r.requiredSecs}s even at fast BTC`);
  // Regression witness: the OLD (inverted) 600 divisor under-sizes, so the SAME front HTLC LAPSES before T_seq.
  const oldBlocks = Math.ceil(r.requiredSecs / 600) + HL.cltvMarginBlocks;
  assert.ok(oldBlocks * FAST < tSeqWallSecs, `the old 600 divisor (${oldBlocks} blocks) would have lapsed at ${oldBlocks * FAST}s, before T_seq ${tSeqWallSecs}s`);
});

// The single conservative envelope both sides live in: BTC no faster than the fast floor, SEQ no slower than the
// slow ceiling. requiredTakerBlocks derives from these EXACT constants (via requiredTakerHold), which is why one
// number bounds BOTH the front-HTLC survival and the recoup deadline.
const seqBlocksHonest = honestTseq - seqTipT;                   // 240
const REQ_HONEST = requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: honestTseq }).minFinalCltvBlocks;

test('LARGE-ENOUGH T_btc (260 BTC blocks) with a 240-SEQ-block T_seq CLEARS the gate — the front HTLC fits inside the recoup deadline', () => {
  const btcTip = 800000, btcRefundHeight = btcTip + 260;
  const g = checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight, seqTip: seqTipT, seqRefundHeight: honestTseq });
  assert.equal(g.ok, true, g.reason);
  assert.equal(g.requiredTakerBlocks, REQ_HONEST);
  assert.equal(g.minFinalCltvBlocks, REQ_HONEST);
  assert.equal(g.recoupDeadlineBlocks, 260 - G.claimMarginBlocks);
  assert.ok(g.minFinalCltvBlocks <= g.recoupDeadlineBlocks, 'the minted front HTLC must fit inside the recoup deadline');
});

test('A maker whose T_btc CANNOT cover requiredTakerBlocks is REJECTED at BOTH the pure gate AND the front-time gate', () => {
  // T_btc = 100 BTC blocks -> recoupDeadline 94 < the ~210 the front HTLC must survive for a 240-block T_seq.
  const btcTip = 800000, shortTbtc = btcTip + 100;
  // (site 1) the pure handshake gate.
  const g = checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight: shortTbtc, seqTip: seqTipT, seqRefundHeight: honestTseq });
  assert.equal(g.ok, false);
  assert.ok(g.recoupDeadlineBlocks < g.requiredTakerBlocks, 'the recoup deadline must be below the required front-HTLC survival');
  // (site 2) the front-time gate inside nextBridgeStep (recoup locked + confirmed + hold-ready) — still refuses.
  const s = nextBridgeStep({ lnSide: 'receiver', amountSat: A }, {
    tip: btcTip, onchain: { funded: true, amountSat: A, cltv: shortTbtc, lockedToLsp: true, confs: 1, spent: false },
    ln: { registered: true, held: false, settled: false, preimage: null },
    crossLock: { seqTip: seqTipT, seqRefundHeight: honestTseq }, recvReady: true });
  assert.equal(s.action, 'fail-closed');
  assert.match(s.reason, /locktime|recoup runway|UNSAFE/i);
  // (site 3 — the relay-time gate, bridgeAssetRelayLocktimeVerdict — is covered in bridge-driver.test.mjs.)
});

test('FUND-SAFE BY CONSTRUCTION: when the gate PASSES, the front HTLC expiry sits in [T_seq-cover, T_btc-claimMargin] for EVERY block-time regime', () => {
  const btcTip = 800000, btcRefundHeight = btcTip + 260;
  const g = checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight, seqTip: seqTipT, seqRefundHeight: honestTseq });
  assert.equal(g.ok, true, g.reason);
  const mfc = g.minFinalCltvBlocks;                             // the front HTLC is minted at this BTC-block CLTV
  const frontExpiryHeight = btcTip + mfc;
  const recoupDeadlineHeight = btcRefundHeight - G.claimMarginBlocks;
  // (1) LSP-safe (upper bound) — a PURE BTC-block relation, so it holds in ANY regime: the front HTLC expires no
  //     later than T_btc - claimMargin, leaving the LSP claimMargin blocks to claim the maker BTC HTLC with P.
  assert.ok(frontExpiryHeight <= recoupDeadlineHeight,
    `front HTLC expiry ${frontExpiryHeight} must be <= T_btc - claimMargin ${recoupDeadlineHeight}`);
  // (2) taker-safe (lower bound) — for EVERY regime inside the conservative envelope (BTC no faster than the fast
  //     floor 150; SEQ no slower than the slow ceiling 90), the front HTLC's real wall-clock life outlasts the
  //     maker's LATEST asset claim + reorg + settle, so the hold is still settleable when P is revealed.
  for (const btcSpb of [HL.fastBtcSecsPerBlock, 300, 600]) {           // fast -> slow BTC
    for (const seqSpb of [30, 60, HL.seqSecsPerBlock]) {               // fast -> slow SEQ
      const frontLifeSecs = mfc * btcSpb;                             // the front HTLC's real wall-clock life
      const makerClaimSecs = seqBlocksHonest * seqSpb + HL.reorgMarginSecs + HL.settleMarginSecs;   // real latest-use-of-P
      assert.ok(frontLifeSecs >= makerClaimSecs,
        `regime btc=${btcSpb}/seq=${seqSpb}: front HTLC life ${frontLifeSecs}s must outlast the maker's latest claim + margin ${makerClaimSecs}s (front HTLC must NOT die before T_seq)`);
      assert.ok(frontExpiryHeight <= recoupDeadlineHeight,
        `regime btc=${btcSpb}/seq=${seqSpb}: no regime may let the front HTLC outlive T_btc - claimMargin (upper bound is block-based)`);
    }
  }
});

test('FIX 2b — a min-T_seq violation is REJECTED (bound + requiredTakerHold both fail closed; the boundary is admitted)', () => {
  const tooNear = seqTipT + HL.minTseqBlocks - 1;
  const b = checkTseqWithinBound({ seqTip: seqTipT, seqRefundHeight: tooNear });
  assert.equal(b.ok, false);
  assert.match(b.reason, /below the min|margin-collapse|min /i);
  assert.equal(requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: tooNear }).ok, false);
  assert.equal(checkTseqWithinBound({ seqTip: seqTipT, seqRefundHeight: seqTipT + HL.minTseqBlocks }).ok, true);   // exactly at the min: ok
});

// ============================================================================
// B — PAYER-SIDE FUND-TIME GATE (checkPayerFundGate). The MIRROR for the LSP payer leg-bridge (buy: taker
// pays BTC over LN, receives the asset on-chain). The LSP RECEIVES the taker's BTC-LN hold and FUNDS an
// on-chain BTC HTLC to the maker; before funding it must verify, from the ACTUAL committed incoming-HTLC
// CLTV, that (B2) the hold covers T_seq and (B3) T_btc matures inside the hold's remaining life. Pure BTC
// blocks (both HTLCs are on Bitcoin). Fail closed on any invalid/timestamp/degenerate input.
// ============================================================================
const HB = BRIDGE_DEFAULTS.holdBuffer;   // 18 (DERIVED = refundFinalityConfs 6 + refundConfirmBudget 12)
// requiredTakerBlocks for the honest 240-SEQ-block T_seq (== the front-HTLC survival used elsewhere).
const REQ_PAYER = requiredTakerHold({ seqTip: 44000, seqRefundHeight: 44000 + 240 }).minFinalCltvBlocks;   // 210
// btcTip 800000; incoming hold CLTV 800220 (220 >= 210 covers T_seq); T_btc 800180 (> tip, >= B1 floor 800150,
// <= 800220 - 18 = 800202). The honest maker rests T_btc at seqdex BtcLocktimeDelta 180 (tip + 180), ~40 blocks
// below the ~220-block hold — clearing the holdBuffer=18 (finality 6 + confirm 12) window with headroom.
const HONEST_PAYER = { btcTip: 800000, incomingHtlcExpiry: 800220, btcRefundHeight: 800180, seqTip: 44000, seqRefundHeight: 44000 + 240 };

test('payer fund gate: an honest hold (covers T_seq) + T_btc inside the hold PASSES', () => {
  const g = checkPayerFundGate(HONEST_PAYER);
  assert.equal(g.ok, true, g.reason);
  assert.equal(g.requiredTakerBlocks, REQ_PAYER);
  assert.equal(g.incomingHoldBlocks, 220);
  assert.equal(g.tBtcInsideHold, true);
});

test('payer fund gate (B2): an incoming hold too SHORT to cover T_seq is REFUSED', () => {
  // incomingHtlcExpiry 800100 -> only 100 blocks of hold life, below the ~210 needed to cover a 240-block T_seq.
  const g = checkPayerFundGate({ ...HONEST_PAYER, incomingHtlcExpiry: 800100 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /B2|settleable|T_seq|below/i);
  assert.ok(g.incomingHoldBlocks < g.requiredTakerBlocks);
});

test('payer fund gate (B3): a T_btc that matures OUTSIDE the hold (too far) is REFUSED', () => {
  // T_btc 800300 > incomingHtlcExpiry 800220 - holdBuffer 18 = 800202 -> not inside the hold's life.
  const g = checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: 800300 });
  assert.equal(g.ok, false);
  assert.match(g.reason, /B3|inside the hold|holdBuffer/i);
});

test('payer fund gate: a T_btc already at/below the tip (refundable immediately) is REFUSED', () => {
  const g = checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: HONEST_PAYER.btcTip });
  assert.equal(g.ok, false);
  assert.match(g.reason, /refundable immediately|<= tip/i);
});

test('payer fund gate: boundaries — exactly at requiredTakerBlocks (B2) and exactly at hold-holdBuffer (B3) PASS', () => {
  // B2 boundary: incomingHtlcExpiry = btcTip + requiredTakerBlocks exactly. T_btc pinned inside.
  const atB2 = checkPayerFundGate({ ...HONEST_PAYER, incomingHtlcExpiry: 800000 + REQ_PAYER, btcRefundHeight: 800000 + REQ_PAYER - HB });
  assert.equal(atB2.ok, true, atB2.reason);
  // B3 boundary: T_btc = incomingHtlcExpiry - holdBuffer exactly.
  const atB3 = checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: HONEST_PAYER.incomingHtlcExpiry - HB });
  assert.equal(atB3.ok, true, atB3.reason);
  // one block past B3 fails.
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: HONEST_PAYER.incomingHtlcExpiry - HB + 1 }).ok, false);
});

test('payer fund gate: a degenerate T_seq (too near, margin-collapse) is REFUSED via requiredTakerHold', () => {
  const g = checkPayerFundGate({ ...HONEST_PAYER, seqRefundHeight: HONEST_PAYER.seqTip + 30 });   // 30 < minTseqBlocks 120
  assert.equal(g.ok, false);
  assert.match(g.reason, /below the min|margin-collapse|min /i);
});

test('payer fund gate: a TIMESTAMP height (incoming hold / T_btc / T_seq) fails closed', () => {
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, incomingHtlcExpiry: LOCKTIME_THRESHOLD + 800260 }).ok, false);
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: LOCKTIME_THRESHOLD + 800250 }).ok, false);
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, seqRefundHeight: LOCKTIME_THRESHOLD + 44000 }).ok, false);
});

test('payer fund gate: a non-finite input fails closed (never fund on an unverifiable ordering)', () => {
  for (const bad of [{ btcTip: NaN }, { incomingHtlcExpiry: undefined }, { btcRefundHeight: 'x' }, { seqTip: null }, { seqRefundHeight: NaN }]) {
    assert.equal(checkPayerFundGate({ ...HONEST_PAYER, ...bad }).ok, false);
  }
  assert.equal(checkPayerFundGate().ok, false);
});

test('SELF-TRADE (maker==taker) with tuned small T_seq/T_btc is REFUSED — the gate itself now enforces the T_seq min bound', () => {
  // A self-trader tunes a tiny T_seq to shrink the required front HTLC so a matched tiny T_btc would clear the
  // recoup deadline, then waits to race the LSP recoup. The gate now delegates to requiredTakerHold, so BOTH
  // moves fail closed INSIDE the gate (nothing at stake):
  //  (a) a tiny T_btc, even with honest T_seq, cannot cover the ~210-block front HTLC.
  assert.equal(checkBridgeLocktimeOrdering({ btcTip: 800000, btcRefundHeight: 800000 + 30,
    seqTip: seqTipT, seqRefundHeight: honestTseq }).ok, false);
  //  (b) THE collapse move — a tiny T_seq so a matched tiny T_btc would otherwise clear the deadline — is now
  //      caught by the T_seq min bound INSIDE the gate (via requiredTakerHold), not merely as a separate check.
  const tinyTseq = seqTipT + 30;                 // 30 SEQ blocks, well under the 120 min
  const collapsed = checkBridgeLocktimeOrdering({ btcTip: 800000, btcRefundHeight: 800000 + 40,
    seqTip: seqTipT, seqRefundHeight: tinyTseq });
  assert.equal(collapsed.ok, false);             // the gate refuses the collapsed T_seq directly...
  assert.match(collapsed.reason, /below the min|margin-collapse|min /i);
  assert.equal(requiredTakerHold({ seqTip: seqTipT, seqRefundHeight: tinyTseq }).ok, false);   // ...via the same min bound
  assert.equal(checkTseqWithinBound({ seqTip: seqTipT, seqRefundHeight: tinyTseq }).ok, false);
});

// ============================================================================
// B0 — HELD-AMOUNT gate (hole 1). holdinvoice marks HELD on the FIRST incoming HTLC regardless of amount, so
// a 1-sat pay must NOT trip funding. Enforced only when the caller supplies the amounts (fundOnchain always
// does; the pure CLTV-only tests above omit them, and still pass). Mirror of stepReceiverLn's amount fail-close.
// ============================================================================
const PRICE = 100000;   // the ordered BTC price (sats)

test('payer fund gate (B0): a held amount COVERING the ordered price PASSES', () => {
  const g = checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: PRICE, orderedAmountSat: PRICE });
  assert.equal(g.ok, true, g.reason);
});

test('payer fund gate (B0): a 1-sat pay (held < ordered) is REFUSED even though the hold is marked HELD', () => {
  const g = checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: 1, orderedAmountSat: PRICE });
  assert.equal(g.ok, false);
  assert.match(g.reason, /B0|HELD|full price|below the ordered/i);
});

test('payer fund gate (B0): a held amount ONE sat short is REFUSED; exactly equal PASSES', () => {
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: PRICE - 1, orderedAmountSat: PRICE }).ok, false);
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: PRICE, orderedAmountSat: PRICE }).ok, true);
  // an over-pay is fine (the LSP fronts exactly the price; the extra just sits in the hold).
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: PRICE + 5, orderedAmountSat: PRICE }).ok, true);
});

test('payer fund gate (B0): an unverifiable held amount (NaN) with a real ordered price fails closed', () => {
  const g = checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: NaN, orderedAmountSat: PRICE });
  assert.equal(g.ok, false);
  // and a bogus (<= 0) ordered price cannot bound the check -> fail closed.
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, heldAmountSat: PRICE, orderedAmountSat: 0 }).ok, false);
});

// ============================================================================
// B1 — T_btc >= f(T_seq) WALL-CLOCK ORDERING gate (hole 4). The payer analog of checkBridgeLocktimeOrdering:
// convert the T_seq window to BTC blocks with the SAME slow-SEQ/fast-BTC divisors requiredTakerHold uses and
// require T_btc >= that height + a maker-claim runway, so a wall-clock inversion (T_btc <= T_seq) that B2/B3
// (which only bound T_btc from ABOVE) would MISS can never let the LSP refund its BTC before P reveals at T_seq.
// ============================================================================
const RUN = BRIDGE_DEFAULTS.makerClaimRunwayBlocks;   // 6
const TSEQ_BTC = Math.ceil(240 * HOLD_LIFE_DEFAULTS.seqSecsPerBlock / HOLD_LIFE_DEFAULTS.fastBtcSecsPerBlock);   // ceil(240*90/150)=144
const B1_FLOOR = 800000 + TSEQ_BTC + RUN;   // 800150

test('payer fund gate (B1): the honest T_btc clears the wall-clock ordering floor', () => {
  const g = checkPayerFundGate(HONEST_PAYER);
  assert.equal(g.ok, true, g.reason);
  assert.equal(g.tSeqCoverHeight, 800000 + TSEQ_BTC);
  assert.ok(HONEST_PAYER.btcRefundHeight >= B1_FLOOR);
});

test('payer fund gate (B1): a T_btc BELOW the T_seq wall-clock (an inversion) is REFUSED even though it passes B3', () => {
  // T_btc 800100 < floor 800150, yet it IS inside the hold (800100 <= 800220 - 18 = 800202) and > tip — so B2/B3
  // pass and only B1 catches it. This is exactly the maker-sets-T_btc<=T_seq inversion of hole 4.
  const inverted = { ...HONEST_PAYER, btcRefundHeight: 800100 };
  assert.ok(inverted.btcRefundHeight > inverted.btcTip);                                  // not immediately refundable
  assert.ok(inverted.btcRefundHeight <= inverted.incomingHtlcExpiry - HB);                // passes B3 (inside the hold)
  const g = checkPayerFundGate(inverted);
  assert.equal(g.ok, false);
  assert.match(g.reason, /B1|ordering floor|inversion|reveal/i);
});

test('payer fund gate (B1): boundary — T_btc exactly at the floor PASSES, one below FAILS', () => {
  assert.equal(checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: B1_FLOOR }).ok, true);
  const below = checkPayerFundGate({ ...HONEST_PAYER, btcRefundHeight: B1_FLOOR - 1 });
  assert.equal(below.ok, false);
  assert.match(below.reason, /B1|ordering floor/i);
});

// ============================================================================
// B — RESUMABLE RELAY (hole 5): a funded crossFund payer leg whose maker asset-leg relay is not yet complete
// (relayPending) RE-DRIVES fund-onchain instead of stalling, but the settle/refund actions always win first.
// ============================================================================
test('crossFund payer: RE-DRIVES the relay (fund-onchain) while funded (unspent) but relayPending — never strands a funded leg', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' },
      ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true, relayPending: true });
  assert.equal(s.action, 'fund-onchain');
  assert.match(s.reason, /relay|resumable|stranded/i);
});

test('crossFund payer: a PUBLIC P (unspent) takes priority over the relay re-drive (recoup-settle, not re-fund)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' },
      ln: { registered: true, held: true, settled: false, preimage: 'cd'.repeat(32) }, crossFund: true, relayPending: true });
  assert.equal(s.action, 'recoup-settle');
});

test('crossFund payer: T_btc reached (unspent) takes priority over the relay re-drive (refund-onchain)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 130, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' },
      ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true, relayPending: true });
  assert.equal(s.action, 'refund-onchain');
});

test('crossFund payer: NOT relayPending + funded (unspent) -> plain wait (no spurious re-drive)', () => {
  const s = nextBridgeStep({ lnSide: 'payer', amountSat: A },
    { tip: 110, onchain: { funded: true, amountSat: A, cltv: 130, lockedToReceiver: true, spent: false, spendStatus: 'unspent' },
      ln: { registered: true, held: true, settled: false, preimage: null }, crossFund: true, relayPending: false });
  assert.equal(s.action, 'wait');
});

// ============================================================================
// runPayerFundOnce — the payer-bridge FUND-ONCE discipline (round-6 convergence tail). Pure control-flow with
// all I/O injected, so the three fund-loss disciplines are exercised without a node:
//   (i)  NEVER broadcast on a locate UNCERTAINTY (dryLocate REJECTS -> propagate, no broadcast).
//   (ii) ADOPT-BEFORE-GATE (a persisted intent -> locate + adopt an already-funded leg BEFORE the gate runs).
//   (iii) PERSIST-INTENT-BEFORE-BROADCAST + a DEFINITIVE scan-before-broadcast (broadcast only on funded:false).
const FUNDED = { funded: true, btc_htlc_txid: 'aa'.repeat(32), btc_htlc_vout: 0, btc_htlc_amount: A, btc_htlc_script: 'ab', btc_locktime: 130 };
const NOT_FUNDED = { funded: false };
// A fund harness: records the ORDER of every injected step, and lets each test script the two dryLocate answers.
function fundHarness({ hasIntent, locateAnswers = [], gateThrows = false }) {
  const calls = [];
  let li = 0;
  const io = {
    hasIntent,
    dryLocate: async () => {
      calls.push('locate');
      const a = locateAnswers[li++];
      if (a instanceof Error) throw a;           // UNCERTAIN — the seqdex CLI exited non-zero (fail closed)
      return a;
    },
    runGate: async () => { calls.push('gate'); if (gateThrows) throw new Error('GATE FAIL (assumes not-yet-funded)'); },
    persistIntent: async () => { calls.push('persistIntent'); },
    broadcast: async () => { calls.push('broadcast'); return FUNDED; },
  };
  return { calls, io };
}

test('runPayerFundOnce: locate UNCERTAIN on adopt-before-gate does NOT broadcast (throws, no gate, no broadcast)', async () => {
  const { calls, io } = fundHarness({ hasIntent: true, locateAnswers: [new Error('locate UNCERTAIN: a lookup failed')] });
  await assert.rejects(runPayerFundOnce(io), /UNCERTAIN/);
  assert.deepEqual(calls, ['locate']);                 // stopped at the locate; never gated, never broadcast
  assert.ok(!calls.includes('broadcast'), 'must NOT broadcast on an uncertain locate');
});

test('runPayerFundOnce: locate UNCERTAIN on the scan-before-broadcast does NOT broadcast (first-fund path)', async () => {
  // hasIntent:false -> skip the adopt locate; gate passes; persistIntent; then the scan-before-broadcast locate
  // comes back UNCERTAIN -> must THROW and NEVER broadcast (a transient read over an already-funded leg must not
  // trigger a second broadcast).
  const { calls, io } = fundHarness({ hasIntent: false, locateAnswers: [new Error('locate UNCERTAIN')] });
  await assert.rejects(runPayerFundOnce(io), /UNCERTAIN/);
  assert.deepEqual(calls, ['gate', 'persistIntent', 'locate']);
  assert.ok(!calls.includes('broadcast'), 'uncertain scan-before-broadcast must NOT broadcast');
});

test('runPayerFundOnce: ADOPT-BEFORE-GATE — a persisted intent + already-funded leg adopts, gate NEVER runs', async () => {
  // The grief case: the gate WOULD throw (inputs moved on re-entry), but adoption must happen first so a funded
  // leg is never abandoned. gateThrows:true proves the gate is not even reached.
  const { calls, io } = fundHarness({ hasIntent: true, locateAnswers: [FUNDED], gateThrows: true });
  const r = await runPayerFundOnce(io);
  assert.equal(r.broadcasted, false);
  assert.equal(r.adopted, 'pre-gate');
  assert.equal(r.funded.btc_htlc_txid, FUNDED.btc_htlc_txid);
  assert.deepEqual(calls, ['locate']);                 // adopted BEFORE the (throwing) gate; no broadcast
});

test('runPayerFundOnce: first-fund happy path broadcasts EXACTLY once after a definitive funded:false', async () => {
  const { calls, io } = fundHarness({ hasIntent: false, locateAnswers: [NOT_FUNDED] });
  const r = await runPayerFundOnce(io);
  assert.equal(r.broadcasted, true);
  assert.equal(r.adopted, null);
  assert.deepEqual(calls, ['gate', 'persistIntent', 'locate', 'broadcast']);
  assert.equal(calls.filter((c) => c === 'broadcast').length, 1);
});

test('runPayerFundOnce: scan-before-broadcast finds a prior broadcast -> ADOPT, do NOT re-broadcast (no double-fund)', async () => {
  // hasIntent:false (no adopt locate), gate passes, persistIntent, then the scan-before-broadcast DEFINITIVELY
  // finds an output already funded (a crash after a prior broadcast on this same tick's key) -> adopt, never
  // broadcast a second output to the deterministic P2SH.
  const { calls, io } = fundHarness({ hasIntent: false, locateAnswers: [FUNDED] });
  const r = await runPayerFundOnce(io);
  assert.equal(r.broadcasted, false);
  assert.equal(r.adopted, 'pre-broadcast');
  assert.ok(!calls.includes('broadcast'), 'a located prior funding must NOT be re-broadcast');
});

test('runPayerFundOnce: adopt-before-gate MISS (definitive funded:false) falls through to first-fund', async () => {
  // hasIntent:true but the leg is DEFINITIVELY not funded -> the adopt locate returns funded:false, then the
  // first-fund path runs (gate -> persistIntent -> scan -> broadcast). Two locates total.
  const { calls, io } = fundHarness({ hasIntent: true, locateAnswers: [NOT_FUNDED, NOT_FUNDED] });
  const r = await runPayerFundOnce(io);
  assert.equal(r.broadcasted, true);
  assert.deepEqual(calls, ['locate', 'gate', 'persistIntent', 'locate', 'broadcast']);
});

test('runPayerFundOnce: fails closed if any injected primitive is missing', async () => {
  await assert.rejects(runPayerFundOnce({ dryLocate: async () => NOT_FUNDED }), /must all be functions/);
});

// ============================================================================
// runPayerRefundOnce — CHAIN-TRUTH idempotency (round-7). classifySpend (the seqdex xsubas-htlc-spend-status
// classifier, DEFINITIVE-or-throw) is consulted FIRST, immediately before broadcasting: it NEVER broadcasts
// unless the BTC HTLC is DEFINITIVELY unspent. spent_claim => skip (recoup next observe); spent_refund => done;
// uncertain / unreadable => THROW (fail closed). s.refunded is persisted only as a broadcast-dedup hint.
function refundHarness({ status = 'unspent', broadcastThrows = false, classifyThrows = false } = {}) {
  const calls = [];
  const io = {
    classifySpend: async () => { calls.push('classify'); if (classifyThrows) throw new Error('classifier UNREADABLE (fail closed)'); return { status }; },
    persistRefundIntent: async () => calls.push('persist(refunded=true)'),
    broadcastRefund: async () => { calls.push('broadcast'); if (broadcastThrows) throw new Error('refund broadcast FAILED (HTLC untouched, retryable)'); return 'REFUNDED'; },
    clearRefundIntent: async () => calls.push('clear(refunded=false)'),
  };
  return { calls, io };
}

test('runPayerRefundOnce: DEFINITIVELY unspent -> classify, persist BEFORE broadcast, broadcast once', async () => {
  const { calls, io } = refundHarness({ status: 'unspent' });
  const r = await runPayerRefundOnce(io);
  assert.equal(r.broadcasted, true);
  assert.equal(r.result, 'REFUNDED');
  // classify FIRST, then persist STRICTLY before broadcast; no clear on success.
  assert.deepEqual(calls, ['classify', 'persist(refunded=true)', 'broadcast']);
  assert.ok(calls.indexOf('classify') < calls.indexOf('broadcast'), 'must classify before broadcasting');
  assert.ok(calls.indexOf('persist(refunded=true)') < calls.indexOf('broadcast'), 'dedup hint must persist before the broadcast');
});

test('runPayerRefundOnce: spent_claim -> NEVER broadcasts (recoup instead next observe)', async () => {
  const { calls, io } = refundHarness({ status: 'spent_claim' });
  const r = await runPayerRefundOnce(io);
  assert.equal(r.broadcasted, false);
  assert.equal(r.status, 'spent_claim');
  assert.deepEqual(calls, ['classify']);   // no persist, no broadcast — the maker already claimed
});

test('runPayerRefundOnce: spent_refund -> DONE (idempotent), NEVER re-broadcasts', async () => {
  const { calls, io } = refundHarness({ status: 'spent_refund' });
  const r = await runPayerRefundOnce(io);
  assert.equal(r.broadcasted, false);
  assert.equal(r.status, 'spent_refund');
  assert.deepEqual(calls, ['classify']);
});

test('runPayerRefundOnce: uncertain -> THROWS (fail closed, no broadcast on an unresolved chain read)', async () => {
  const { calls, io } = refundHarness({ status: 'uncertain' });
  await assert.rejects(runPayerRefundOnce(io), /not DEFINITIVELY unspent|fail closed/i);
  assert.deepEqual(calls, ['classify']);   // classified, then refused — never persisted or broadcast
});

test('runPayerRefundOnce: an UNREADABLE classifier propagates (never a blind broadcast)', async () => {
  const { calls, io } = refundHarness({ classifyThrows: true });
  await assert.rejects(runPayerRefundOnce(io), /UNREADABLE/);
  assert.deepEqual(calls, ['classify']);
});

test('runPayerRefundOnce: a broadcast that does NOT land CLEARS the dedup hint and re-throws', async () => {
  const { calls, io } = refundHarness({ status: 'unspent', broadcastThrows: true });
  await assert.rejects(runPayerRefundOnce(io), /FAILED/);
  assert.deepEqual(calls, ['classify', 'persist(refunded=true)', 'broadcast', 'clear(refunded=false)']);
});

test('runPayerRefundOnce: fails closed if any injected primitive is missing', async () => {
  await assert.rejects(runPayerRefundOnce({ persistRefundIntent: async () => {} }), /must all be functions/);
  await assert.rejects(runPayerRefundOnce({ classifySpend: async () => ({ status: 'unspent' }) }), /must all be functions/);
});
