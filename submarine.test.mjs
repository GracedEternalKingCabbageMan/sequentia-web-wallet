// Unit test for submarine.js — the mixed-rail (submarine) swap state machine +
// localStorage persistence + resume + REFUND path. Proves an in-flight submarine swap
// survives a page reload (so the trade-process view + "Refund BTC leg" button come
// back) and only becomes refundable once the on-chain HTLC leg's CLTV timeout is
// buried. Runs in Node, no browser (storage is a Map-backed localStorage shim).
import assert from 'node:assert';
import {
  ST, isTerminal, isRefundable, newSwap, applyStatus,
  markRefunding, markRefunded, markSettled, markFailed,
  serialize, deserialize, saveSwap, loadSwap, resume,
} from './submarine.js';

// A minimal localStorage-shaped store.
function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), _m: m };
}
const KEY = 'swk.sequentia.submarine';
const GOLD = 'aa'.repeat(32);

// --- new swap: SELL GOLD on-chain <-> receive BTC over Lightning ------------------
const htlc = { chain: 'seq', address: 'tsq1qhtlc', txid: 'ab'.repeat(32), vout: 0,
  amount: 100000, refund_locktime: 250, refund_pub: '02'.padEnd(66, 'f'), refund_secret: '11'.repeat(32) };
let rec = newSwap({ side: 'sell', asset: GOLD, amount: 100000, payRail: 'chain', recvRail: 'ln', payIsBtc: false, htlc });
assert.equal(rec.state, ST.SETTLING, 'a fresh submarine swap starts SETTLING');
assert.ok(!isTerminal(rec), 'settling is not terminal');
assert.equal(rec.htlc.refund_locktime, 250, 'the on-chain HTLC leg carries its CLTV refund locktime');
assert.ok(rec.id && rec.created, 'the swap has an id + created stamp');
console.log('ok: newSwap builds a live SETTLING record carrying the on-chain HTLC refund leg');

// --- refundability is gated on the CLTV timeout ----------------------------------
assert.equal(isRefundable(rec, 100), false, 'not refundable before the locktime is buried');
assert.equal(isRefundable(rec, 249), false, 'not refundable one block early');
assert.equal(isRefundable(rec, 250), true, 'refundable once the tip reaches the locktime');
assert.equal(isRefundable(rec, 400), true, 'still refundable well past the locktime');
console.log('ok: the on-chain HTLC leg is refundable ONLY once its CLTV timeout is buried');

// --- persistence round-trip -------------------------------------------------------
assert.deepEqual(deserialize(serialize(rec)), rec, 'serialize -> deserialize is lossless');
const store = memStore();
saveSwap(store, KEY, rec);
assert.deepEqual(loadSwap(store, KEY), rec, 'saveSwap/loadSwap round-trips the whole record');
console.log('ok: the in-flight swap persists to (and reloads from) localStorage losslessly');

// --- RESUME after a page refresh: a live swap comes back; its refund leg is intact -
const resumed = resume(store, KEY);
assert.ok(resumed && resumed.state === ST.SETTLING, 'resume returns the live swap (trade-process view can re-render)');
assert.equal(resumed.htlc.refund_locktime, 250, 'the resumed swap still knows its refund leg (Refund BTC leg works)');
assert.equal(isRefundable(resumed, 300), true, 'the resumed swap is refundable past its buried timeout');
console.log('ok: resume() rehydrates a non-terminal swap WITH its refund leg after a reload');

// --- the refund path: settling -> refunding -> refunded (terminal) ----------------
let ref = markRefunding(resumed);
assert.equal(ref.state, ST.REFUNDING, 'broadcasting the HTLC refund moves to REFUNDING');
assert.ok(!isTerminal(ref), 'refunding is not yet terminal');
ref = markRefunded(ref, 'ee'.repeat(32));
assert.ok(isTerminal(ref) && ref.state === ST.REFUNDED, 'a confirmed refund is terminal');
assert.equal(ref.refund_txid, 'ee'.repeat(32), 'the refund txid is recorded');
console.log('ok: the refund off-ramp advances settling -> refunding -> refunded (terminal)');

// --- resume DROPS a terminal swap (never re-shows a settled/refunded stepper) ------
saveSwap(store, KEY, ref);
assert.equal(resume(store, KEY), null, 'resume drops a terminal swap');
assert.equal(store.getItem(KEY), null, 'the terminal record is cleared from storage');
console.log('ok: resume() cleans a terminal swap so a stale stepper never re-appears');

// --- applyStatus: settle + fail transitions from LSP polls ------------------------
let live = newSwap({ side: 'buy', asset: GOLD, amount: 5, payRail: 'ln', recvRail: 'chain', payIsBtc: true, htlc });
let settled = applyStatus(live, { finality: 'final', preimage: 'cd'.repeat(32) });
assert.ok(settled.state === ST.SETTLED && settled.preimage === 'cd'.repeat(32), 'a final poll settles the swap with its preimage');
let stillGoing = applyStatus(live, { status: 'confirming', detail: 'burying under Bitcoin' });
assert.ok(stillGoing.state === ST.SETTLING && /burying/.test(stillGoing.detail), 'a confirming poll keeps it SETTLING with detail');
let failed = applyStatus(live, { ok: false, error: 'no route' });
assert.ok(failed.state === ST.FAILED && /no route/.test(failed.detail), 'an ok:false poll fails the swap with its error');
// applyStatus can DISCOVER the on-chain leg a server-side-started swap only later exposes.
let discovered = applyStatus(newSwap({ side: 'sell', asset: GOLD, amount: 1, payRail: 'chain', recvRail: 'ln', payIsBtc: false }),
  { status: 'confirming', onchain_leg: { htlc_address: 'tsq1qlate', locktime: 500 } });
assert.equal(discovered.htlc.refund_locktime, 500, 'applyStatus captures an HTLC leg the LSP surfaces mid-swap');
assert.ok(markSettled(live).state === ST.SETTLED && markFailed(live, 'x').state === ST.FAILED, 'explicit settle/fail marks are terminal');
console.log('ok: applyStatus advances settle/fail/confirming and captures a late-surfaced HTLC leg');

// --- terminal records are frozen against further status ---------------------------
const frozen = applyStatus(ref, { finality: 'final' });
assert.equal(frozen.state, ST.REFUNDED, 'a terminal (refunded) swap ignores later status');
console.log('ok: terminal swaps are frozen (a late poll cannot un-refund them)');

console.log('\nALL PASS');
