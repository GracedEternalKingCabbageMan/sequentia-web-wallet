// Tests for the sub-asset SELL crash/retry recovery decision. Run: node subas-sell-recovery.test.mjs
//
// The fund-critical property: the LSP must NEVER decide 'rerun' (which re-pays the asset over LN)
// when a prior same-nonce attempt may already have paid. 'rerun' requires POSITIVE proof of no pay.
import crypto from 'node:crypto';
import os from 'node:os';
import {
  hashPreimageOk, subasSellStateFileForNonce, subasSellGuardVerdict, assembleSubasSellSettled,
} from './subas-sell-recovery.mjs';

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; } else { failed++; console.error(`FAIL ${msg}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL ${msg}`); } }

// Real preimage/hash so hashPreimageOk (used inside the verdict) is exercised for real.
const P = crypto.randomBytes(32).toString('hex');
const H = crypto.createHash('sha256').update(Buffer.from(P, 'hex')).digest('hex');
const Pother = crypto.randomBytes(32).toString('hex');
const verifiedState = { phase: 'verified', hash_h: H, btc_htlc: { txid: 'cafef00d', vout: 0, amount: 2000 } };
const paidState = { ...verifiedState, phase: 'paid', preimage: P };

// --- hashPreimageOk ---
ok(hashPreimageOk(H, P) === true, 'hashPreimageOk: real P opens H');
ok(hashPreimageOk(H, Pother) === false, 'hashPreimageOk: wrong P rejected');
ok(hashPreimageOk(H, 'zz') === false, 'hashPreimageOk: bad hex rejected');
ok(hashPreimageOk(H, undefined) === false, 'hashPreimageOk: non-string rejected');

// --- subasSellStateFileForNonce ---
ok(subasSellStateFileForNonce('/tmp', 'abc123') === subasSellStateFileForNonce('/tmp', 'abc123'),
   'stateFile: same nonce -> same deterministic path');
ok(subasSellStateFileForNonce('/tmp', 'abc') !== subasSellStateFileForNonce('/tmp', 'def'),
   'stateFile: different nonce -> different path');
ok(subasSellStateFileForNonce('/tmp', '../../etc/passwd').endsWith('xsubas-sell-etcpasswd.json'),
   'stateFile: sanitizes path-traversal chars out of the nonce');
ok(subasSellStateFileForNonce('/tmp', '  ') === null, 'stateFile: blank nonce -> null');
ok(subasSellStateFileForNonce('/tmp', '!@#$') === null, 'stateFile: all-punctuation nonce -> null (no usable id)');
ok(subasSellStateFileForNonce('/tmp', 42) === null, 'stateFile: non-string nonce -> null');

// --- subasSellGuardVerdict: the five coordinator cases + fund-safe holds ---

// (1) paid  -> recover (no node consult needed; the persisted preimage proves the pay)
eq(subasSellGuardVerdict(paidState, null), { kind: 'recover', preimage: P },
   'CASE paid -> recover from the state file preimage');
eq(subasSellGuardVerdict(paidState, { preimage: null, pending: false }), { kind: 'recover', preimage: P },
   'CASE paid -> recover even if the node shows nothing (preimage wins)');

// (2) verified + node COMPLETE -> recover
eq(subasSellGuardVerdict(verifiedState, { preimage: P, pending: false }), { kind: 'recover', preimage: P },
   'CASE verified + node complete -> recover from the node preimage');

// (3) verified + node PENDING -> hold (never re-run: a pay for H is in-flight)
eq(subasSellGuardVerdict(verifiedState, { preimage: null, pending: true }), { kind: 'hold', reason: 'pay-in-flight' },
   'CASE verified + node pending -> hold (do NOT respawn)');

// (4) verified + node shows NO send -> rerun (provably no prior pay)
eq(subasSellGuardVerdict(verifiedState, { preimage: null, pending: false }), { kind: 'rerun' },
   'CASE verified + node no-send -> rerun (safe)');

// (5) no state file -> rerun (genuine first/fresh attempt)
eq(subasSellGuardVerdict(null, null), { kind: 'rerun' }, 'CASE no file -> rerun');

// Fund-safe extras: uncertainty must NEVER become a rerun.
eq(subasSellGuardVerdict(verifiedState, null), { kind: 'hold', reason: 'node-unreadable' },
   'verified + node UNREADABLE (null) -> hold, never rerun');
eq(subasSellGuardVerdict({ phase: 'verified', hash_h: H }, { preimage: null, pending: false }),
   { kind: 'hold', reason: 'prior-state-unreadable' },
   'state file present but missing btc_htlc -> hold, never rerun');
eq(subasSellGuardVerdict({ phase: 'paid', hash_h: H, btc_htlc: { txid: 'x' }, preimage: Pother }, { preimage: null, pending: true }),
   { kind: 'hold', reason: 'pay-in-flight' },
   'corrupt persisted preimage (does not hash to H) falls through to the node view (pending -> hold)');

// A corrupt persisted preimage with the node showing NO send -> rerun (the persisted P was junk,
// and the node PROVES nothing was sent). Still safe: proof of no pay.
eq(subasSellGuardVerdict({ phase: 'paid', hash_h: H, btc_htlc: { txid: 'x' }, preimage: Pother }, { preimage: null, pending: false }),
   { kind: 'rerun' },
   'corrupt persisted preimage + node no-send -> rerun (proven no pay)');

// --- assembleSubasSellSettled shape ---
const bh = { txid: 't', vout: 1, amount: 2000, redeem_script: '51', t_btc: 200, taker_claim_pubkey: '02a', maker_refund_pubkey: '02b' };
const settled = assembleSubasSellSettled({
  assetId: 'asset1', assetLabelStr: 'GOLD', nodeKey: 'nk', hashH: H, preimageHex: P,
  makerLnNodeId: '02deadbeef', btcHtlc: bh, note: 'n', dt: 1234, requestedAmount: 5,
});
ok(settled.ok === true && settled.settled === true && settled.recovered === true, 'assemble: ok+settled+recovered');
ok(settled.pay_rail === 'ln' && settled.recv_rail === 'chain' && settled.side === 'sell', 'assemble: rails/side');
ok(settled.hash_h === H && settled.preimage === P, 'assemble: carries H + P');
eq(settled.btc_htlc, bh, 'assemble: passes btc_htlc through verbatim (wallet claims from it)');
ok(settled.eta_seconds === 1 && settled.settled_ms === 1234 && settled.requested_amount === 5, 'assemble: timing/amount');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
