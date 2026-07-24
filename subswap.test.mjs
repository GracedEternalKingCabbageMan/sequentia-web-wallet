// Unit test for subswap.js — the P2P submarine taker client (both directions) + the LSP payer leg-bridge.
// Covers the FUND-SAFETY cores (the VerifySEQLeg checks + the anchor gate + the REQUIRED P2SH match), the
// bolt11 payment-hash/amount decode gates, the rail-crossing DISPATCH (P2P-first, LSP-fallback, both
// directions, honest-disable when the asset leg would also cross), the take SIZING (overshoot blocked), the
// two P2P driver happy paths, the FULL verify-before-pay refusal set (unverified leg / un-buried / seq-window
// / payment_hash mismatch / amount mismatch — NONE pays), and the crash-gap RESUME recovery — all with
// scripted fakes, no browser, no network.
import assert from 'node:assert';
import {
  rebuildAndCheckRedeem, checkLegBinding, checkFundingOutput, anchorDepthVerdict, verifySeqLeg,
  dispatchSubswap, runTakerReverseSubmarine, runTakerSubmarine, claimReverseSeqLeg, resumeReversePay,
  bolt11AmountMsat, bolt11PaymentHash, bolt11MinFinalCltv, holdCltvSafeVsTseq, sizeSubswapTake, waitAnchorBuried,
} from './subswap.js';

// makeBolt11 — build a bech32 bolt11 the wallet's PURE decoders (bolt11PaymentHash / bolt11AmountMsat /
// bolt11MinFinalCltv) parse end-to-end, with a chosen payment_hash and min_final_cltv ('c'). The decoders
// never verify the signature/checksum, so a structurally-valid string (timestamp 7 + tagged fields +
// signature 104 + checksum 6 groups) exercises the REAL tagged-field parse — critical: a HOLD invoice is
// byte-identical to a plain one, so the ONLY defence is decoding its 'c' and gating on it. Omit cltv to build
// an invoice with NO 'c' field (decoder must default to 18). Amount prefix lnbc2500u = 250,000,000 msat.
const _B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function _hexTo5bit(hex){ const bytes = []; for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16)); let acc = 0, bits = 0; const out = []; for (const b of bytes){ acc = (acc << 8) | b; bits += 8; while (bits >= 5){ bits -= 5; out.push((acc >> bits) & 31); } } if (bits > 0) out.push((acc << (5 - bits)) & 31); return out; }
function _intTo5bit(n){ if (n === 0) return [0]; const out = []; while (n > 0){ out.unshift(n % 32); n = Math.floor(n / 32); } return out; }
function makeBolt11({ payHashHex, cltv, prefix = 'lnbc2500u' }){
  const g = [];
  for (let i = 0; i < 7; i++) g.push(0);                                   // timestamp (7 groups)
  g.push(1, Math.floor(52 / 32), 52 % 32, ..._hexTo5bit(payHashHex));      // 'p' payment_hash (type 1, len 52)
  if (cltv != null){ const cd = _intTo5bit(cltv); g.push(24, Math.floor(cd.length / 32), cd.length % 32, ...cd); }   // 'c' min_final_cltv (type 24)
  for (let i = 0; i < 104; i++) g.push(0);                                 // signature (104 groups)
  for (let i = 0; i < 6; i++) g.push(0);                                   // checksum (6 groups)
  return prefix + '1' + g.map((x) => _B32[x]).join('');
}

const GOLD = 'aa'.repeat(32);
const H = 'bb'.repeat(32);
const MYCLAIM = '02' + 'a'.repeat(64);      // 33-byte compressed pubkey hex
const MAKERREFUND = '03' + 'b'.repeat(64);
const OTHERPUB = '02' + 'c'.repeat(64);
const LOCK = 5000;

// A deterministic redeem builder: the SAME (H, claim, refund, locktime) ALWAYS yields the SAME bytes, and any
// change flips them — exactly the property rebuildAndCheckRedeem relies on to prove "locked to MY key on H".
const buildRedeem = (h, c, r, l) => (String(h) + String(c) + String(r) + Number(l).toString(16)).toLowerCase();
const htlcSpkHex = (redeem) => 'a914' + redeem.slice(0, 40) + '87';
const goodRedeem = buildRedeem(H, MYCLAIM, MAKERREFUND, LOCK);

// The canonical BOLT11 test vector (2500u, payment_hash = 0001..0102). Lets the driver exercise the REAL
// payment-hash decode end-to-end, not a stub.
const HVEC = '0001020304050607080900010203040506070809000102030405060708090102';
const BOLT11_VEC = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const VEC_MSAT = 250000000n;   // lnbc2500u
const goodRedeemVec = buildRedeem(HVEC, MYCLAIM, MAKERREFUND, LOCK);
const legVec = { txid: 'cc'.repeat(32), vout: 0, amount: 1000, asset: GOLD, redeem_script: goodRedeemVec, locktime: LOCK, block_hash: 'dd'.repeat(32) };

// ===========================================================================
// PURE core: rebuildAndCheckRedeem — proves the asset HTLC's claim branch is MY key on H.
// ===========================================================================
assert.equal(rebuildAndCheckRedeem({ hashH: H, myClaimPub: MYCLAIM, makerRefundPub: MAKERREFUND, locktime: LOCK, providedScript: goodRedeem }, buildRedeem).ok, true, 'a redeem locked to my claim key on H verifies');
assert.equal(rebuildAndCheckRedeem({ hashH: H, myClaimPub: OTHERPUB, makerRefundPub: MAKERREFUND, locktime: LOCK, providedScript: goodRedeem }, buildRedeem).ok, false, 'a redeem NOT locked to my key is rejected (byte mismatch)');
assert.equal(rebuildAndCheckRedeem({ hashH: H, myClaimPub: MYCLAIM, makerRefundPub: MAKERREFUND, locktime: LOCK + 1, providedScript: goodRedeem }, buildRedeem).ok, false, 'a redeem with the wrong locktime is rejected');
assert.equal(rebuildAndCheckRedeem({ hashH: 'zz', myClaimPub: MYCLAIM, makerRefundPub: MAKERREFUND, locktime: LOCK, providedScript: goodRedeem }, buildRedeem).ok, false, 'a non-hex H is rejected');
console.log('ok: rebuildAndCheckRedeem binds the HTLC claim branch to MY key on H (rejects any substitution)');

// ===========================================================================
// PURE core: checkLegBinding — the leg binds to the SIGNED offer (amount exact, asset exact, locktime).
// ===========================================================================
const legOK = { txid: 'cc'.repeat(32), vout: 0, amount: 1000, asset: GOLD, redeem_script: goodRedeem, locktime: LOCK, block_hash: 'dd'.repeat(32) };
assert.equal(checkLegBinding({ leg: legOK, expectAsset: GOLD, expectAtoms: 1000, expectLocktime: LOCK }).ok, true, 'a leg matching the offer binds');
assert.equal(checkLegBinding({ leg: { ...legOK, amount: 999 }, expectAsset: GOLD, expectAtoms: 1000, expectLocktime: LOCK }).ok, false, 'a leg underpaying the offer amount is rejected');
assert.equal(checkLegBinding({ leg: { ...legOK, asset: 'ee'.repeat(32) }, expectAsset: GOLD, expectAtoms: 1000 }).ok, false, 'a leg with the wrong asset id is rejected');
assert.equal(checkLegBinding({ leg: { ...legOK, locktime: LOCK + 1 }, expectAsset: GOLD, expectAtoms: 1000, expectLocktime: LOCK }).ok, false, 'a leg whose locktime differs from the terms is rejected');
console.log('ok: checkLegBinding binds the announced leg to the signed offer (amount/asset/locktime)');

// ===========================================================================
// PURE core: checkFundingOutput — the output MUST pay the HTLC P2SH; FAIL CLOSED when spk is unreadable.
// ===========================================================================
const spk = htlcSpkHex(goodRedeem);
assert.equal(checkFundingOutput({ output: { value: 1000n, asset: GOLD, spk }, expectSpkHex: spk, expectAtoms: 1000, expectAsset: GOLD }).ok, true, 'a funding output paying the P2SH the right amount+asset verifies');
assert.equal(checkFundingOutput({ output: null, expectSpkHex: spk, expectAtoms: 1000 }).ok, false, 'a missing funding output is rejected (not confirmed)');
assert.equal(checkFundingOutput({ output: { value: 500n, asset: GOLD, spk }, expectSpkHex: spk, expectAtoms: 1000 }).ok, false, 'a funding output with the wrong value is rejected');
assert.equal(checkFundingOutput({ output: { value: 1000n, asset: GOLD, spk: 'a914dead87' }, expectSpkHex: spk, expectAtoms: 1000 }).ok, false, 'a funding output not paying the HTLC P2SH is rejected');
// FAIL CLOSED (the fix): an UNREADABLE spk, or an underivable expected spk, must NEVER be skipped.
assert.equal(checkFundingOutput({ output: { value: 1000n, asset: GOLD, spk: null }, expectSpkHex: spk, expectAtoms: 1000 }).ok, false, 'an UNREADABLE funding spk fails closed (never skips the P2SH match)');
assert.equal(checkFundingOutput({ output: { value: 1000n, asset: GOLD }, expectSpkHex: spk, expectAtoms: 1000 }).ok, false, 'an absent funding spk fails closed');
assert.equal(checkFundingOutput({ output: { value: 1000n, asset: GOLD, spk }, expectSpkHex: null, expectAtoms: 1000 }).ok, false, 'an underivable expected P2SH fails closed');
console.log('ok: checkFundingOutput REQUIRES the P2SH match and fails closed when spk is unreadable');

// ===========================================================================
// PURE core: anchorDepthVerdict — never pay against a reorg-able HTLC (unless a 0-conf front).
// ===========================================================================
assert.equal(anchorDepthVerdict({ anchorHeight: 100, btcTip: 105, minAnchorDepth: 3, legAtoms: 1000, max0ConfAtoms: 0 }).ok, true, 'depth 6 >= 3 is buried enough');
assert.equal(anchorDepthVerdict({ anchorHeight: 100, btcTip: 101, minAnchorDepth: 3, legAtoms: 1000, max0ConfAtoms: 0 }).ok, false, 'depth 2 < 3 is NOT buried enough');
assert.equal(anchorDepthVerdict({ anchorHeight: null, btcTip: 105, minAnchorDepth: 3, legAtoms: 1000, max0ConfAtoms: 0 }).ok, false, 'an un-anchored block is rejected');
const zc = anchorDepthVerdict({ anchorHeight: null, btcTip: null, minAnchorDepth: 3, legAtoms: 5, max0ConfAtoms: 10 });
assert.ok(zc.ok && zc.zeroConf, 'a leg under the 0-conf cap skips the anchor-bury wait (LP front)');
assert.equal(anchorDepthVerdict({ anchorHeight: null, btcTip: null, minAnchorDepth: 3, legAtoms: 50, max0ConfAtoms: 10 }).ok, false, 'a leg over the 0-conf cap still requires the bury');
console.log('ok: anchorDepthVerdict gates on Bitcoin-anchor depth (with a bounded 0-conf front exception)');

// ===========================================================================
// verifySeqLeg — the composed fund-safety gate over a fake chain reader.
// ===========================================================================
function verifyDeps(over = {}) {
  return {
    buildRedeem, htlcSpkHex,
    readOutput: async () => ({ value: 1000n, asset: GOLD, spk: htlcSpkHex(goodRedeem) }),
    // CONFIRMED-FUNDING + TXID-BOUND BLOCK: verifySeqLeg reads the anchor block from the ACTUAL txid's confirmed
    // status, never the maker-supplied leg.block_hash. Default: confirmed, in legOK's block.
    txStatus: async () => ({ confirmed: true, block_hash: legOK.block_hash, block_height: 100 }),
    anchorHeightOf: async () => 100,
    btcTip: async () => 106,
    ...over,
  };
}
const base = { hashH: H, myClaimPub: MYCLAIM, makerRefundPub: MAKERREFUND, leg: legOK, expectAsset: GOLD, expectAtoms: 1000, expectLocktime: LOCK, minAnchorDepth: 3, max0ConfAtoms: 0 };
assert.equal((await verifySeqLeg(base, verifyDeps())).ok, true, 'verifySeqLeg passes a well-formed, anchor-buried leg locked to my key');
assert.equal((await verifySeqLeg({ ...base, myClaimPub: OTHERPUB }, verifyDeps())).ok, false, 'verifySeqLeg REFUSES a leg not locked to my key (redeem mismatch)');
assert.equal((await verifySeqLeg({ ...base, expectAtoms: 2000 }, verifyDeps())).ok, false, 'verifySeqLeg REFUSES a leg that underpays the offer');
assert.equal((await verifySeqLeg(base, verifyDeps({ anchorHeightOf: async () => null }))).ok, false, 'verifySeqLeg REFUSES a leg whose funding is not anchored yet');
assert.equal((await verifySeqLeg(base, verifyDeps({ readOutput: async () => ({ value: 1000n, asset: GOLD, spk: 'a914dead87' }) }))).ok, false, 'verifySeqLeg REFUSES a leg whose on-chain output does not pay the HTLC P2SH');
assert.equal((await verifySeqLeg(base, verifyDeps({ readOutput: async () => ({ value: 1000n, asset: GOLD, spk: null }) }))).ok, false, 'verifySeqLeg FAILS CLOSED when the funding spk is unreadable (no P2SH skip)');
assert.equal((await verifySeqLeg({ ...base, skipAnchor: true }, verifyDeps({ anchorHeightOf: async () => null }))).ok, true, 'skipAnchor verifies redeem+binding+P2SH only (the driver polls the anchor separately)');
// CONFIRMED-FUNDING: a still-mempool (0-conf) funding is REFUSED (never paid/exposed against a reorg-able tx).
assert.equal((await verifySeqLeg(base, verifyDeps({ txStatus: async () => ({ confirmed: false, block_hash: null }) }))).ok, false, 'verifySeqLeg REFUSES a 0-conf (unconfirmed / mempool) funding');
assert.equal((await verifySeqLeg(base, verifyDeps({ txStatus: async () => null }))).ok, false, 'verifySeqLeg FAILS CLOSED when the tx status is unreadable (txid->block cannot be bound)');
// TXID-BOUND BLOCK: the maker leg.block_hash is a DECOY deep block; the tx's REAL block (from txStatus) is
// SHALLOW. verifySeqLeg computes depth from the REAL block -> not buried -> refuse. If it wrongly trusted
// leg.block_hash (deep) it would PASS, so asserting ok:false proves the anchor is bound to the actual txid.
{
  const REALBLK = '11'.repeat(32), DECOYBLK = '99'.repeat(32);
  const legDecoy = { ...legOK, block_hash: DECOYBLK };
  const decoyDeps = verifyDeps({ txStatus: async () => ({ confirmed: true, block_hash: REALBLK }),
    anchorHeightOf: async (bh) => bh === REALBLK ? 105 : 100 });   // real block depth 2 (<3); decoy depth 7
  assert.equal((await verifySeqLeg({ ...base, leg: legDecoy }, decoyDeps)).ok, false, 'verifySeqLeg binds the anchor block to the ACTUAL txid (a maker decoy leg.block_hash cannot fake depth)');
  const honestDeps = verifyDeps({ txStatus: async () => ({ confirmed: true, block_hash: REALBLK }),
    anchorHeightOf: async (bh) => bh === REALBLK ? 100 : 999 });   // real block depth 7 (>=3)
  assert.equal((await verifySeqLeg({ ...base, leg: legDecoy }, honestDeps)).ok, true, 'verifySeqLeg passes when the txid-bound (real) block is anchor-buried enough');
}
console.log('ok: verifySeqLeg composes the checks into ONE fund-safety gate (claim=my key + amount/asset + REQUIRED P2SH + CONFIRMED + txid-bound anchor)');

// ===========================================================================
// waitAnchorBuried — CONFIRMED-FUNDING + TXID-BOUND BLOCK: bind the anchor block to the ACTUAL txid, reject 0-conf.
// ===========================================================================
{
  const nap = async () => {};
  const okv = await waitAnchorBuried({ txid: 'aa'.repeat(32), minAnchorDepth: 3, legAtoms: 1000, max0ConfAtoms: 0, deadlineMs: 50, pollMs: 1 },
    { txStatus: async () => ({ confirmed: true, block_hash: 'bb'.repeat(32) }), anchorHeightOf: async () => 100, btcTip: async () => 106 }, nap);
  assert.ok(okv.ok && okv.boundBlock === 'bb'.repeat(32), 'waitAnchorBuried binds the block from the txid status, buries, returns ok');
  const noconf = await waitAnchorBuried({ txid: 'aa'.repeat(32), minAnchorDepth: 3, legAtoms: 1000, max0ConfAtoms: 0, deadlineMs: 5, pollMs: 1 },
    { txStatus: async () => ({ confirmed: false, block_hash: null }), anchorHeightOf: async () => 100, btcTip: async () => 106 }, nap);
  assert.ok(!noconf.ok && noconf.timedOut, 'waitAnchorBuried NEVER trusts a 0-conf (mempool) funding — waits it out, then times out');
  // A maker decoy blockHash is IGNORED — only the txid-bound block counts (here still-mempool -> times out).
  const decoy = await waitAnchorBuried({ txid: 'aa'.repeat(32), blockHash: 'ff'.repeat(32), minAnchorDepth: 3, legAtoms: 1000, max0ConfAtoms: 0, deadlineMs: 5, pollMs: 1 },
    { txStatus: async () => ({ confirmed: false, block_hash: null }), anchorHeightOf: async (bh) => bh === 'ff'.repeat(32) ? 50 : null, btcTip: async () => 106 }, nap);
  assert.ok(!decoy.ok, 'waitAnchorBuried ignores the maker-supplied blockHash (only the txid-bound confirmed block counts)');
  console.log('ok: waitAnchorBuried binds the anchor block to the txid + rejects a 0-conf mempool funding');
}

// ===========================================================================
// bolt11 decode gates — payment-hash (against the REAL vector) + amount (conservative).
// ===========================================================================
assert.equal(bolt11PaymentHash(BOLT11_VEC), HVEC, 'bolt11PaymentHash decodes the payment_hash from a real BOLT11 test vector');
assert.equal(bolt11PaymentHash('lntb10u1pexampleinvoice'), null, 'a bogus/short invoice yields null (the gate then fails closed)');
assert.equal(bolt11PaymentHash('notaninvoice'), null, 'a non-invoice yields null');
assert.equal(bolt11PaymentHash(12345), null, 'a non-string yields null');
assert.equal(bolt11AmountMsat(BOLT11_VEC), VEC_MSAT, 'lnbc2500u -> 250,000,000 msat');
assert.equal(bolt11AmountMsat('lnbc20m1pvjluez...'), 2000000000n, 'lnbc20m -> 2,000,000,000 msat');
assert.equal(bolt11AmountMsat('lntb10u1p...'), 1000000n, 'lntb10u (testnet) -> 1,000,000 msat');
assert.equal(bolt11AmountMsat('lnbcrt5u1p...'), 500000n, 'lnbcrt5u (regtest) parses (bcrt before bc)');
assert.equal(bolt11AmountMsat('lntb1p...'), null, 'an amountless / sub-msat invoice returns null (never blocks)');
console.log('ok: bolt11PaymentHash + bolt11AmountMsat decode the invoice (real vector; null when unsure)');

// ===========================================================================
// bolt11MinFinalCltv — decode the 'c' (min_final_cltv) field; DEFAULT 18 when absent; null when unparseable.
// A hold invoice is byte-identical to a plain one, so this is the ONLY on-invoice signal of a masqueraded hold.
// ===========================================================================
assert.equal(bolt11MinFinalCltv(BOLT11_VEC), 18, "the real BOLT11 vector's min_final_cltv decodes to 18");
assert.equal(bolt11MinFinalCltv(makeBolt11({ payHashHex: H, cltv: 200 })), 200, "a 'c' field of 200 decodes to 200");
assert.equal(bolt11MinFinalCltv(makeBolt11({ payHashHex: H, cltv: 4032 })), 4032, "a large 'c' field decodes exactly (no overflow at realistic values)");
assert.equal(bolt11MinFinalCltv(makeBolt11({ payHashHex: H, cltv: null })), 18, 'an invoice with NO c field defaults to the BOLT11 minimum 18');
assert.equal(bolt11MinFinalCltv('notaninvoice'), null, 'a non-invoice yields null (the gate then fails closed)');
assert.equal(bolt11MinFinalCltv(12345), null, 'a non-string yields null');
console.log("ok: bolt11MinFinalCltv decodes the 'c' field (default 18 absent, null unparseable)");

// ===========================================================================
// holdCltvSafeVsTseq — the HOLD-INVOICE MASQUERADE gate, CONSERVATIVE INVERSE. Block-time model: the SEQ slot is
// DETERMINISTIC (g_pos_slot_interval = 30 s), so all the margin sits on the VARIABLE Bitcoin side: assume BTC as
// SLOW as a sustained hashrate-lull average (~1800 s/block) over SEQ's exact 30 s slot => ratio = 1800/30 = 60
// SEQ slots per BTC block (NOT the ~1.67x forward-sizing divisor, which was the fund-loss bug). The gate is
// evaluated at the POST-ANCHOR-BURY tip: the wallet taker (minAnchorDepth=3, max0conf=0) waits ~3 BTC confs to
// bury the fresh asset HTLC before paying, during which the SEQ tip advances ~minAnchorDepth*ratio blocks. So
// the honest maker MUST couple T_seq = (fc + minAnchorDepth)*ratio + claimMargin + buffer, and the gate at
// seqTip2 = M + minAnchorDepth*ratio must clear. seqTip is the ABSOLUTE post-bury tip; seqLocktime is absolute.
// ===========================================================================
{
  const cm = 120, RATIO = 60;   // 1800/30; must stay in step with SLOW_BTC_SECS/FAST_SEQ_SECS in subswap.js
  const AD = 3, fc = 8, buffer = 40;   // SubReverseMinAnchorDepth / SubReverseInvoiceCLTV / SubReverseTseqBuffer
  // Honest reverse-submarine coupling (seqdex xdriver_submarine_reverse.go):
  //   T_seq delta = (fc + minAnchorDepth)*ratio + claimMargin + buffer = (8+3)*60 + 120 + 40 = 820 (~6.8 h).
  const delta = (fc + AD) * RATIO + cm + buffer;
  assert.equal(delta, 820, 'the coupled honest T_seq delta = (fc+minAnchor)*ratio + claimMargin + buffer = 820');
  // Model the maker locking at tip M=0 so seqLocktime == the delta; the anchor-bury advances the tip to seqTip2.
  const seqTip2 = 0 + AD * RATIO;   // 180 — the POST-bury tip the gate is evaluated at
  // SAFE: an honest fc=8 offer at the coupled T_seq CLEARS the gate AFTER the anchor-bury advance.
  const safe = holdCltvSafeVsTseq({ finalCltv: fc, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm });
  assert.equal(safe.ok, true, 'an honest fc=8 offer at the coupled T_seq (820) clears the gate at the POST-bury tip (180)');
  assert.equal(safe.settleDeadlineSeq, seqTip2 + Math.ceil(fc * RATIO), 'settleDeadline = seqTip2 + ceil(fc*ratio) = 180 + 480 = 660');
  assert.ok(safe.settleDeadlineSeq + cm < delta, 'the safe case leaves a claim margin (== buffer 40) before T_seq');
  assert.ok(safe.settleDeadlineSeq >= fc * RATIO, 'the inverse is >= the ratio (never the ~1.67x forward divisor) — margin is on the SAFE side');

  // TOO SMALL WITHOUT THE ANCHOR-BURY TERM: a T_seq sized fc*ratio+cm+buffer (no minAnchorDepth term) is REFUSED
  // once the tip advances across the bury — this is EXACTLY why the coupling MUST include minAnchorDepth*ratio.
  const deltaNoBury = fc * RATIO + cm + buffer;   // 640
  assert.equal(holdCltvSafeVsTseq({ finalCltv: fc, seqTip: seqTip2, seqLocktime: deltaNoBury, claimMargin: cm }).ok, false, 'a T_seq sized WITHOUT the anchor-bury term (640) is refused at the post-bury tip — the coupling must add minAnchorDepth*ratio');

  // MASQUERADE: a large fc (a hold that could settle far past T_seq) is REFUSED even at the honest coupled T_seq.
  assert.equal(holdCltvSafeVsTseq({ finalCltv: 50, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm }).ok, false, 'a masquerading fc=50 is refused at the honest T_seq');
  assert.equal(holdCltvSafeVsTseq({ finalCltv: 200, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm }).ok, false, 'a masquerading fc=200 is refused at the honest T_seq (settles far past T_seq)');

  // Boundary self-consistency at the honest T_seq: exactly maxSafeCltvBtc is safe, +1 is not. (Since buffer<ratio,
  // maxSafe == the honest fc — the maker mints exactly the largest CLTV the T_seq admits; the buffer is pure
  // tip-advance slack.)
  const g = holdCltvSafeVsTseq({ finalCltv: 1, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm });
  const maxSafe = g.maxSafeCltvBtc;
  assert.equal(maxSafe, fc, 'maxSafeCltvBtc == the honest fc (buffer < ratio, so the buffer is pure tip-advance slack)');
  assert.equal(holdCltvSafeVsTseq({ finalCltv: maxSafe, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm }).ok, true, 'finalCltv == maxSafeCltvBtc still clears the gate');
  assert.equal(holdCltvSafeVsTseq({ finalCltv: maxSafe + 1, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm }).ok, false, 'finalCltv == maxSafeCltvBtc + 1 is refused (strict boundary)');

  // RESIDUAL BOUNDARY (documented, not a bug): the gate is safe ONLY while the REAL Bitcoin average stays within
  // the modeled ratio (1800 s/block). A SUSTAINED lull beyond it (e.g. 2700 s/block => real ratio 90) means the
  // maker's fc-block hold spans MORE SEQ slots than projected — re-evaluating the SAME honest offer at that real
  // ratio REFUSES, exhibiting the fixed-window-vs-variable-BTC residual. Mitigated (generous ratio + bounded fc +
  // the taker capping its own max-cltv), NOT eliminated (BTC block time is unbounded); the taker's outgoing HTLC
  // still refunds if the maker never settles, so this never leaves the taker's BTC merely HELD unrecoverable.
  assert.equal(holdCltvSafeVsTseq({ finalCltv: fc, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm }).ok, true, 'honest fc=8 clears at the modeled ratio 60 (real BTC avg <= 1800 s/block)');
  assert.equal(holdCltvSafeVsTseq({ finalCltv: fc, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm, cfg: { slowBtcSecs: 2700, fastSeqSecs: 30 } }).ok, false, 'a SUSTAINED BTC lull beyond the modeled 1800 s/block (real ratio 90) breaks the projection — the documented residual boundary');

  // Fail closed on undecodable / unreadable inputs.
  assert.equal(holdCltvSafeVsTseq({ finalCltv: null, seqTip: seqTip2, seqLocktime: delta, claimMargin: cm }).ok, false, 'a null (undecodable) min_final_cltv fails closed');
  assert.equal(holdCltvSafeVsTseq({ finalCltv: fc, seqTip: NaN, seqLocktime: delta, claimMargin: cm }).ok, false, 'an unreadable seq tip fails closed');
  console.log('ok: holdCltvSafeVsTseq — conservative inverse ratio 60 (1800/30); the coupled T_seq (fc+minAnchor)*ratio+cm+buffer=820 clears at the post-bury tip; no-bury sizing + masquerade refused; residual boundary shown');
}

// ===========================================================================
// sizeSubswapTake — SIZE the take to the user's amount; OVERSHOOT blocked when it can't be sliced.
// ===========================================================================
{
  const whole = sizeSubswapTake({ want: 0n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 0n });
  assert.deepEqual([whole.takeAtoms, whole.takeBtc, whole.partial, whole.overshoot], [1000n, 500n, false, false], 'no requested size -> take the whole offer');
  const part = sizeSubswapTake({ want: 400n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 100n });
  assert.deepEqual([part.takeAtoms, part.takeBtc, part.partial, part.overshoot], [400n, 200n, true, false], 'a partial-fillable offer slices to the requested size (BTC floored proportionally)');
  const over = sizeSubswapTake({ want: 400n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: false, minFill: 0n });
  assert.deepEqual([over.takeAtoms, over.overshoot], [1000n, true], 'an un-sliceable offer flags OVERSHOOT (composer blocks Place, never lifts the whole offer)');
  const underMin = sizeSubswapTake({ want: 50n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 100n });
  assert.equal(underMin.overshoot, true, 'a slice under the offer min_fill flags overshoot');
  const exact = sizeSubswapTake({ want: 1000n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: false, minFill: 0n });
  assert.deepEqual([exact.takeAtoms, exact.overshoot], [1000n, false], 'a want == offer takes the whole offer (no overshoot)');
  console.log('ok: sizeSubswapTake sizes to the user amount and BLOCKS overshoot (Review == what executes)');
}
{
  // SUBMARINE = WHOLE-OFFER-ONLY: the makers (RunMaker[Reverse]Submarine) lock the whole offer, so a submarine
  // take is ALWAYS the whole resting offer — never sliced (partial fill is the covenant CLOB's job).
  const whole = sizeSubswapTake({ want: 0n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 0n, submarine: true });
  assert.deepEqual([whole.takeAtoms, whole.takeBtc, whole.partial, whole.overshoot], [1000n, 500n, false, false], 'no requested size -> take the whole submarine offer');
  const exact = sizeSubswapTake({ want: 1000n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 0n, submarine: true });
  assert.deepEqual([exact.takeAtoms, exact.overshoot], [1000n, false], 'want == the whole submarine offer -> take it (no overshoot)');
  const noPart = sizeSubswapTake({ want: 400n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 0n, submarine: true });
  assert.deepEqual([noPart.takeAtoms, noPart.partial, noPart.overshoot, noPart.wholeOnly], [1000n, false, true, true], 'a submarine offer is NEVER sliced (want<whole even with allowPartial -> wholeOnly overshoot, never a partial)');
  // Control: the SAME want on a NON-submarine partial-fillable offer DOES slice — proving `submarine` is the gate.
  const sliced = sizeSubswapTake({ want: 400n, offerAtoms: 1000n, offerBtc: 500n, allowPartial: true, minFill: 0n, submarine: false });
  assert.deepEqual([sliced.partial, sliced.takeAtoms], [true, 400n], 'the same want on a non-submarine partial offer slices (submarine is the whole-only gate)');
  console.log("ok: sizeSubswapTake never slices a submarine offer (whole-offer-only; partial is the covenant CLOB's job)");
}

// ===========================================================================
// DISPATCH: P2P-first, LSP-fallback, BOTH directions; honest-disable when the asset leg also crosses.
// ===========================================================================
const submarineAsk = { rail: 'submarine', meta: { caps: { btc_ln: true, interactive: true, asset_onchain: true } } };
const submarineBid = { rail: 'submarine', meta: { caps: { btc_ln: true, interactive: true, asset_onchain: true } } };
const onchainAsk = { rail: 'onchain', meta: { caps: { btc_ln: false, interactive: false, asset_onchain: true } } };
const onchainBid = { rail: 'onchain', meta: { caps: { btc_ln: false, interactive: false, asset_onchain: true } } };
const lnAssetAsk = { rail: 'ln', meta: { caps: { btc_ln: true, interactive: true, asset_onchain: false } } };

let d = dispatchSubswap({ asset: GOLD, side: 'buy', payRail: 'ln', recvRail: 'chain', offer: submarineAsk });
assert.deepEqual([d.path, d.ln_direction, d.lnSide], ['p2p-submarine', 1, 'payer'], 'BUY btc-ln vs an interactive submarine maker -> P2P reverse submarine (ln_direction 1)');
d = dispatchSubswap({ asset: GOLD, side: 'buy', payRail: 'ln', recvRail: 'chain', offer: onchainAsk });
assert.deepEqual([d.path, d.lnSide], ['lsp-bridge', 'payer'], 'BUY btc-ln vs an on-chain-only maker -> the LSP PAYER leg-bridge');
d = dispatchSubswap({ asset: GOLD, side: 'sell', payRail: 'chain', recvRail: 'ln', offer: submarineBid });
assert.deepEqual([d.path, d.ln_direction, d.lnSide], ['p2p-submarine', 0, 'receiver'], 'SELL asset-chain vs an interactive submarine maker -> P2P normal submarine (ln_direction 0)');
d = dispatchSubswap({ asset: GOLD, side: 'sell', payRail: 'chain', recvRail: 'ln', offer: onchainBid });
assert.deepEqual([d.path, d.lnSide], ['lsp-bridge', 'receiver'], 'SELL asset-chain vs an on-chain-only maker -> the LSP RECEIVER leg-bridge');
d = dispatchSubswap({ asset: GOLD, side: 'buy', payRail: 'chain', recvRail: 'chain', offer: onchainAsk });
assert.equal(d.path, 'native', 'rails coincide (both on-chain) -> native, no bridge in the value path');
d = dispatchSubswap({ asset: GOLD, side: 'buy', payRail: 'ln', recvRail: 'chain', offer: lnAssetAsk });
assert.equal(d.path, 'unsupported', 'BUY vs a maker resting the asset over LN -> unsupported (the asset leg would also cross; never a doomed submarine)');
console.log('ok: dispatchSubswap routes P2P-first, LSP-fallback, symmetric; honest-disables an asset-over-LN crossing');

// ===========================================================================
// DRIVER (PAYER/buy): the FULL verify-before-pay set; NONE of the refusals pays.
// ===========================================================================
function fakeSession(scripted) {
  const q = scripted.slice();
  return { sent: [], failed: null,
    async send(m) { this.sent.push(m); },
    async recv(want) { const m = q.shift(); if (!m) throw new Error('no scripted msg for ' + want); if (m.type !== want) throw new Error('want ' + want + ' got ' + m.type); return m; },
    async fail(code, message) { this.failed = { code, message }; },
    close() {} };
}

const P = 'dd'.repeat(32);   // the preimage the maker's invoice reveals; sha256(P) == the leg's H (stubbed below)
function buyDeps(over = {}) {
  const order = [];
  const hh = over._hashH || HVEC;
  const leg = over._leg || legVec;
  const bolt11 = over._bolt11 || BOLT11_VEC;
  const session = over.session || fakeSession([{ type: 'sub_asset_locked', hash_h: hh, maker_refund_pub: MAKERREFUND, seq_locktime: LOCK, bolt11, leg }]);
  return { order, session,
    seqClaimKey: { public_key: MYCLAIM, secret_hex: 'ff'.repeat(32) },
    expect: { asset: GOLD, atoms: 1000n, msat: over._expectMsat != null ? over._expectMsat : VEC_MSAT },
    buildRedeem, htlcSpkHex,
    readOutput: async () => ({ value: 1000n, asset: GOLD, spk: htlcSpkHex(leg.redeem_script) }),
    // CONFIRMED-FUNDING + TXID-BOUND BLOCK for the anchor POLL (waitAnchorBuried): confirmed, in the leg's block.
    txStatus: async () => ({ confirmed: true, block_hash: leg.block_hash, block_height: 100 }),
    anchorHeightOf: async () => 100, btcTip: async () => 106,
    seqTip: async () => 100,
    sha256Hex: async (hex) => (hex === P ? hh : 'ee'.repeat(32)),
    payInvoice: async () => { order.push('pay'); return P; },
    claimSeq: async (rec) => { order.push('claim:' + rec.secret_hex + ':' + rec.claim_secret); return 'claimtxid00'; },
    onAboutToPay: () => { order.push('mark'); },
    onPaid: () => { order.push('persist'); },
    onClaimed: () => {},
    minAnchorDepth: 3, max0ConfAtoms: 0, claimMargin: 120, anchorWaitMs: 50, anchorPollMs: 1, log: () => {}, ...over };
}
{
  const deps = buyDeps();
  const r = await runTakerReverseSubmarine(deps);
  assert.ok(r.ok && r.preimage === P && r.seqClaimTxid === 'claimtxid00', 'the reverse-submarine buy verifies, pays, learns P, and claims the asset');
  assert.deepEqual(deps.order, ['mark', 'pay', 'persist', 'claim:' + P + ':' + 'ff'.repeat(32)], 'order is MARK (persist leg+bolt11 pre-pay) -> pay -> PERSIST P -> claim (P persisted BEFORE the claim)');
  assert.equal(deps.session.sent[0].type, 'sub_terms_request', 'the taker opens with a terms request carrying its claim key');
  assert.equal(deps.session.sent[0].taker_seq_claim_pub, MYCLAIM.toLowerCase(), 'the terms request carries MY claim pubkey');
  console.log('ok: runTakerReverseSubmarine verifies + window-gates + anchor-buries + decodes the invoice hash BEFORE paying, persists P before claiming');
}
{
  // FUND-SAFETY: a leg NOT locked to my key must be REFUSED before any payment (the single irreversible act).
  const legBad = { ...legOK, redeem_script: buildRedeem(H, OTHERPUB, MAKERREFUND, LOCK) };
  const deps = buyDeps({ session: fakeSession([{ type: 'sub_asset_locked', hash_h: H, maker_refund_pub: MAKERREFUND, seq_locktime: LOCK, bolt11: 'lnbc1p...', leg: legBad }]) });
  await assert.rejects(runTakerReverseSubmarine(deps), /not locked to this wallet|redeem_script/i, 'a leg not locked to my key is refused');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid for an unverified leg (no BTC-LN exposed)');
  assert.ok(deps.session.failed, 'the taker aborts the lift with an XcFail');
  console.log('ok: runTakerReverseSubmarine NEVER pays against an unverified asset leg (no fund exposure)');
}
{
  // FUND-SAFETY: an on-chain output that does NOT pay the HTLC P2SH (or is unreadable) is refused before paying.
  const deps = buyDeps({ readOutput: async () => ({ value: 1000n, asset: GOLD, spk: 'a914dead87' }) });
  await assert.rejects(runTakerReverseSubmarine(deps), /P2SH/i, 'a funding output not paying the HTLC P2SH is refused');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid against a mis-paying funding output');
  const deps2 = buyDeps({ readOutput: async () => ({ value: 1000n, asset: GOLD, spk: null }) });
  await assert.rejects(runTakerReverseSubmarine(deps2), /unreadable|P2SH/i, 'an UNREADABLE funding spk fails closed (no pay)');
  assert.deepEqual(deps2.order, [], 'the invoice was NEVER paid when the funding spk is unreadable');
  console.log('ok: runTakerReverseSubmarine requires the funding output pay the HTLC P2SH (fails closed on unreadable spk)');
}
{
  // FUND-SAFETY: an un-buried (reorg-able) leg is refused before paying (the anchor POLL times out, not aborts).
  const deps = buyDeps({ anchorHeightOf: async () => null });
  await assert.rejects(runTakerReverseSubmarine(deps), /anchor|buried|confirm/i, 'an un-anchored leg is refused');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid against a reorg-able leg');
  console.log('ok: runTakerReverseSubmarine polls the anchor and refuses to pay until the asset HTLC is buried');
}
{
  // FUND-SAFETY (0-conf): a still-mempool (unconfirmed) funding is refused — the anchor POLL waits for the
  // funding tx to CONFIRM (via txStatus) and never pays against a 0-conf mempool leg.
  const deps = buyDeps({ txStatus: async () => ({ confirmed: false, block_hash: null }) });
  await assert.rejects(runTakerReverseSubmarine(deps), /anchor|buried|confirm/i, 'a 0-conf (unconfirmed) funding is refused');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid against a 0-conf mempool funding');
  console.log('ok: runTakerReverseSubmarine refuses to pay against a 0-conf (mempool) asset HTLC funding');
}
{
  // FUND-SAFETY (txid-bound block): the maker's leg.block_hash is a DECOY deep block; the tx's REAL confirmed
  // block (from txStatus) is SHALLOW. The anchor POLL binds to the txid's real block -> not buried -> times out
  // -> NEVER pays. Proves a maker cannot fake anchor depth with a decoy block_hash.
  const deps = buyDeps({ _leg: { ...legVec, block_hash: '99'.repeat(32) },   // maker decoy block
    txStatus: async () => ({ confirmed: true, block_hash: '77'.repeat(32) }),  // real (shallow) block
    anchorHeightOf: async (bh) => bh === '77'.repeat(32) ? 105 : 100 });        // real depth 2 (<3); decoy depth 7
  await assert.rejects(runTakerReverseSubmarine(deps), /anchor|buried/i, 'a maker decoy block_hash cannot fake anchor depth (txid-bound)');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid when the txid-bound block is not buried');
  console.log('ok: runTakerReverseSubmarine derives anchor depth from the txid-bound block, not the maker leg.block_hash');
}
{
  // FUND-SAFETY (P2): a T_seq that leaves too small a claim window is refused before paying.
  const deps = buyDeps({ seqTip: async () => 4990 });   // LOCK 5000, margin 120 -> 5000 !> 5110
  await assert.rejects(runTakerReverseSubmarine(deps), /window|locktime/i, 'a too-small claim window is refused');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid when the claim window is too small');
  console.log('ok: runTakerReverseSubmarine refuses to pay when the seq claim window is too small');
}
{
  // FUND-SAFETY (the worst loss): a bolt11 whose payment_hash != H is refused before paying — paying it would
  // yield a preimage that opens NOTHING. The leg is correctly locked to my key on H, so verifySeqLeg passes;
  // the payment-hash decode is what catches it.
  const deps = buyDeps({ _hashH: H, _leg: legOK, _bolt11: BOLT11_VEC, _expectMsat: VEC_MSAT });
  await assert.rejects(runTakerReverseSubmarine(deps), /payment_hash|opens nothing/i, 'an invoice bound to a DIFFERENT hash is refused');
  assert.deepEqual(deps.order, [], 'the invoice was NEVER paid when its payment_hash != H (no BTC-LN lost for nothing)');
  console.log('ok: runTakerReverseSubmarine decodes the bolt11 and REFUSES to pay one whose payment_hash != H');
}
{
  // OVERPAY / amount gate: a bolt11 whose STATED amount != the offer price is refused before paying.
  const deps = buyDeps({ _expectMsat: 1000000n });   // vector is 250,000,000 msat != 1,000,000
  await assert.rejects(runTakerReverseSubmarine(deps), /demands|msat/i, 'a mispriced invoice is refused');
  assert.deepEqual(deps.order, [], 'the mispriced invoice was NEVER paid (amount gate, before the irreversible act)');
  console.log('ok: runTakerReverseSubmarine refuses a bolt11 whose amount != the offer price');
}
// A realistic reverse-submarine buyDeps at a chosen T_seq (rlock, an ABSOLUTE seq height) and invoice
// min_final_cltv (fc). The maker locks at tip ~100; pass an advancingTip so the SEQ tip advances across the
// anchor-bury (seqTip1 at step 3, seqTip2 at step 7 where the hold-CLTV gate runs). The leg's redeem_script +
// locktime AND the announced seq_locktime all agree on rlock (so verifySeqLeg passes and the flow reaches the
// hold-CLTV gate), and the invoice carries the chosen fc. Lets the integration tests use the SAME coupled
// (fc=8, delta=820 => rlock=920) sizing the pure gate test uses, instead of the unrealistic LOCK=5000 delta.
function subLockDeps(rlock, fc, over = {}){
  const rRedeem = buildRedeem(HVEC, MYCLAIM, MAKERREFUND, rlock);
  const rLeg = { txid: 'cc'.repeat(32), vout: 0, amount: 1000, asset: GOLD, redeem_script: rRedeem, locktime: rlock, block_hash: 'dd'.repeat(32) };
  return buyDeps({ _leg: rLeg,
    session: fakeSession([{ type: 'sub_asset_locked', hash_h: HVEC, maker_refund_pub: MAKERREFUND, seq_locktime: rlock, bolt11: makeBolt11({ payHashHex: HVEC, cltv: fc }), leg: rLeg }]),
    ...over });
}
// advancingTip models the SEQ tip advancing minAnchorDepth*ratio blocks while the taker waits out the anchor-
// bury: the driver reads seqTip at step 3 (lock tip) and again at step 7 (the tip the hold-CLTV gate runs at).
function advancingTip(lockTip, postBury){ let n = 0; return async () => (n++ === 0 ? lockTip : postBury); }
{
  // FUND-SAFETY (HOLD-INVOICE MASQUERADE — the last fund-loss): a bolt11 hold invoice is byte-identical to a
  // plain one. A malicious interactive maker hands a HOLD invoice whose min_final_cltv lets it keep our payment
  // HELD settleable PAST T_seq — it could refund the asset at T_seq, THEN settle the hold, capturing our BTC-LN
  // with no asset. The leg + payment_hash + amount all verify, so ONLY the hold-CLTV gate catches it. Even at the
  // fully-coupled honest T_seq (delta 820 -> RLOCK 920) evaluated at the post-bury tip (seqTip2 280), a malicious
  // fc=200 -> ~seq height 12280 (>> 920 - margin) is REFUSED, never paid.
  const deps = subLockDeps(920, 200, { seqTip: advancingTip(100, 280) });
  await assert.rejects(runTakerReverseSubmarine(deps), /hold|min_final_cltv|past T_seq|BAD_HOLD_CLTV/i, 'a hold invoice whose min_final_cltv could settle past T_seq is refused');
  assert.deepEqual(deps.order, [], 'the hold invoice was NEVER paid (no BTC-LN captured with no asset)');
  assert.ok(deps.session.failed && deps.session.failed.code === 'BAD_HOLD_CLTV', 'the taker aborts the lift with XcFail BAD_HOLD_CLTV');
  console.log('ok: runTakerReverseSubmarine REFUSES a masqueraded hold invoice (min_final_cltv would settle past T_seq)');
}
{
  // COORDINATION (the anchor-bury term): a T_seq sized WITHOUT the minAnchorDepth*ratio term — fc*ratio+cm+buffer
  // = 8*60+120+40 = 640 (RLOCK 740) — is now TOO SMALL: once the tip advances across the 3-conf bury (seqTip2 =
  // 100 + 3*60 = 280), an HONEST fc=8 -> settle-by ~760 + margin 120 = 880 > 740, so the driver fails closed
  // BAD_HOLD_CLTV, never paying. This is EXACTLY why the seqob coupling MUST add minAnchorDepth*ratio
  // (SubReverseMinAnchorDepth) to T_seq; the taker's gate at the post-bury tip is the authority, the maker sizes
  // to clear it.
  const deps = subLockDeps(740, 8, { seqTip: advancingTip(100, 280) });
  await assert.rejects(runTakerReverseSubmarine(deps), /hold|min_final_cltv|past T_seq|BAD_HOLD_CLTV/i, 'an honest fc=8 against a T_seq missing the anchor-bury term is refused once the tip advances across the bury');
  assert.deepEqual(deps.order, [], 'nothing paid against a T_seq too small for the post-bury gate');
  assert.ok(deps.session.failed && deps.session.failed.code === 'BAD_HOLD_CLTV', 'the taker aborts with BAD_HOLD_CLTV — motivating the honest maker to add minAnchorDepth*ratio to T_seq');
  console.log('ok: runTakerReverseSubmarine refuses an honest fc against a T_seq missing the anchor-bury term (the coupling must include minAnchorDepth*ratio)');
}
{
  // CONTROL: an honest fc=8 at the fully-coupled T_seq (delta 820 -> RLOCK 920, INCLUDING the anchor-bury term)
  // PROCEEDS even AFTER the tip advances across the 3-conf bury (seqTip1 100 -> seqTip2 280) — the gate blocks
  // ONLY a hold that could settle past T_seq, not a normal invoice at a properly-sized T_seq. Also asserts the
  // driver caps its OWN outgoing max-cltv-delay AT the invoice's min_final_cltv (fc) so a held payment refunds as
  // early as the invoice allows (never extending the window past what the maker demanded).
  let paidOpts = null;
  const deps = subLockDeps(920, 8, { seqTip: advancingTip(100, 280) });
  const basePay = deps.payInvoice;
  deps.payInvoice = async (bolt11, opts) => { paidOpts = opts; return basePay(bolt11, opts); };
  const r = await runTakerReverseSubmarine(deps);
  assert.ok(r.ok && r.preimage === P, 'a safe hold-CLTV invoice proceeds (verifies, pays, claims) AFTER the anchor-bury advance');
  assert.deepEqual(deps.order, ['mark', 'pay', 'persist', 'claim:' + P + ':' + 'ff'.repeat(32)], 'the safe path pays + claims in order');
  assert.ok(paidOpts && Number.isFinite(paidOpts.maxCltv) && paidOpts.maxCltv === 8, 'the driver caps its OWN outgoing max-cltv-delay AT the invoice min_final_cltv (fc=8), never extending the window');
  console.log('ok: runTakerReverseSubmarine proceeds on a SAFE hold-CLTV invoice at the fully-coupled T_seq AFTER the anchor-bury advance, capping its outgoing max-cltv at fc');
}

// ===========================================================================
// DRIVER (RECEIVER/sell): mint P/H, fund the asset HTLC, settle the held invoice with P (receive BTC + reveal P).
// ===========================================================================
{
  const order = [];
  const session = fakeSession([{ type: 'sub_terms', maker_seq_claim_pub: MAKERREFUND, seq_locktime: LOCK, seq_amount: 1000, min_anchor_depth: 3 }]);
  const deps = {
    session, seqRefundKey: { public_key: MYCLAIM, secret_hex: 'ff'.repeat(32) },
    expect: { asset: GOLD, atoms: 1000n, msat: 1000n * 1000n },
    randomSecret: async () => P, sha256Hex: async () => H, buildRedeem, htlcSpkHex,
    seqTip: async () => 100, minSeqClaimWindow: 120,
    fundSeq: async ({ redeemHex }) => { order.push('fund'); return { txid: 'ff'.repeat(32), vout: 1, block_hash: 'ab'.repeat(32), height: 90 }; },
    anchorHeightOf: async () => 88,
    mintHold: async ({ hashH, preimage, msat }) => { order.push('mint:' + hashH + ':' + preimage); return { node_id: 'nodeid123', bolt11: null }; },
    invoiceStatus: async () => ({ held: true, settled: false }),
    settleHold: async ({ hashH, preimage }) => { order.push('settle:' + preimage); },
    onFunded: () => { order.push('persist'); }, log: () => {}, holdPollMs: 1,
  };
  const r = await runTakerSubmarine(deps);
  assert.ok(r.ok && r.settled && r.preimage === P, 'the normal-submarine sell settles: receives BTC-LN by settling its held invoice with P');
  assert.deepEqual(order, ['mint:' + H + ':' + P, 'fund', 'persist', 'settle:' + P], 'order is mint invoice on H (with P for auto-settle) -> fund the asset -> PERSIST -> settle with P (capture BTC + reveal P)');
  const funded = session.sent.find((m) => m.type === 'sub_asset_funded');
  assert.ok(funded && funded.hash_h === H && funded.taker_seq_refund_pub === MYCLAIM.toLowerCase(), 'the taker announces sub_asset_funded with H + its refund key');
  assert.ok(funded.taker_ln_node_id === 'nodeid123' && funded.amount_msat === 1000000, 'the announce carries the node_id + amount_msat pay-by-hash fallback (maker needs a payable leg)');
  console.log('ok: runTakerSubmarine mints a plain invoice on H (P for auto-settle) + announces it, settles with P (single T_seq gate)');
}
{
  // SELL PERSIST-BEFORE-FUND (fund-loss): P/H/redeem + the intended leg MUST be persisted (onAboutToFund)
  // BEFORE fundSeq broadcasts the asset HTLC (mirror the buy's onAboutToPay), so a reload during the ~12min
  // waitConf can recover H/P/redeem/leg and never strand a funded-but-unpersisted asset.
  const order = [];
  let preFund = null;
  const session = fakeSession([{ type: 'sub_terms', maker_seq_claim_pub: MAKERREFUND, seq_locktime: LOCK, seq_amount: 1000, min_anchor_depth: 3 }]);
  const deps = {
    session, seqRefundKey: { public_key: MYCLAIM, secret_hex: 'ff'.repeat(32) },
    expect: { asset: GOLD, atoms: 1000n, msat: 1000n * 1000n },
    randomSecret: async () => P, sha256Hex: async () => H, buildRedeem, htlcSpkHex,
    seqTip: async () => 100, minSeqClaimWindow: 120,
    onAboutToFund: (info) => { order.push('aboutToFund'); preFund = info; },
    fundSeq: async ({ redeemHex }) => { order.push('fund'); return { txid: 'ff'.repeat(32), vout: 1, block_hash: 'ab'.repeat(32), height: 90 }; },
    anchorHeightOf: async () => 88,
    mintHold: async () => { order.push('mint'); return { node_id: 'nodeid123', bolt11: null }; },
    invoiceStatus: async () => ({ held: true, settled: false }),
    settleHold: async () => { order.push('settle'); },
    onFunded: () => { order.push('onFunded'); }, log: () => {}, holdPollMs: 1,
  };
  const r = await runTakerSubmarine(deps);
  assert.ok(r.ok && r.settled, 'the sell settles');
  assert.ok(order.indexOf('aboutToFund') >= 0 && order.indexOf('aboutToFund') < order.indexOf('fund'), 'onAboutToFund (persist P/H/redeem + intended leg) fires BEFORE fundSeq broadcasts');
  assert.ok(preFund && preFund.preimage === P && preFund.hash_h === H && /.+/.test(preFund.redeem) && preFund.refund_secret === 'ff'.repeat(32) && String(preFund.atoms) === '1000' && preFund.asset === GOLD && Number(preFund.seq_locktime) === LOCK,
    'the pre-fund persist carries P + H + redeem + refund_secret + the intended leg (asset/amount/locktime) — full recovery material, no funded-but-unpersisted window');
  console.log('ok: runTakerSubmarine persists P/H/redeem + the intended leg BEFORE funding (crash-safe sell recovery)');
}
{
  // A sell whose maker never pays returns a REFUNDABLE result (the leg is reclaimable after T_seq), never a loss.
  const session = fakeSession([{ type: 'sub_terms', maker_seq_claim_pub: MAKERREFUND, seq_locktime: LOCK, seq_amount: 1000, min_anchor_depth: 3 }]);
  const deps = {
    session, seqRefundKey: { public_key: MYCLAIM, secret_hex: 'ff'.repeat(32) },
    expect: { asset: GOLD, atoms: 1000n, msat: 1000000n },
    randomSecret: async () => P, sha256Hex: async () => H, buildRedeem, htlcSpkHex, seqTip: async () => 100,
    fundSeq: async () => ({ txid: 'ff'.repeat(32), vout: 1, block_hash: 'ab'.repeat(32), height: 90 }),
    anchorHeightOf: async () => 88, mintHold: async () => ({ node_id: 'n', bolt11: null }),
    invoiceStatus: async () => ({ held: false, settled: false }), settleHold: async () => {},
    log: () => {}, holdPollMs: 1, holdWaitMs: 5,
  };
  const r = await runTakerSubmarine(deps);
  assert.ok(!r.ok && r.refundable && r.leg && r.leg.txid, 'an unpaid sell returns refundable with its leg (reclaim after T_seq)');
  console.log('ok: runTakerSubmarine returns a refundable leg when the maker never pays (no fund loss)');
}

// ===========================================================================
// RESUME: claimReverseSeqLeg re-claims a buy that already learned P (crash between pay and claim).
// ===========================================================================
{
  let claimed = null;
  const r = await claimReverseSeqLeg({ preimage: P, leg: { ...legOK, redeem_script: goodRedeem }, asset: GOLD },
    { seqClaimKey: { secret_hex: 'ff'.repeat(32) }, claimSeq: async (rec) => { claimed = rec; return 'resumeclaim'; } });
  assert.ok(r.ok && r.seqClaimTxid === 'resumeclaim', 'a persisted P + leg re-claims on resume');
  assert.equal(claimed.secret_hex, P, 'the resume claim spends with the persisted preimage P');
  console.log('ok: claimReverseSeqLeg resumes the claim from a persisted P + verified leg (fund-safety on reload)');
}

// ===========================================================================
// RESUME (crash gap): resumeReversePay recovers a BUY that crashed AFTER persist-before-pay, BEFORE learning P.
// It re-queries the node (idempotent), recovers P, and claims — and NEVER drops / NEVER re-pays past the window.
// ===========================================================================
{
  const rec = { hash_h: HVEC, bolt11: BOLT11_VEC, asset: GOLD, leg: { ...legVec, redeem_script: goodRedeemVec } };
  // (1) The payment had already settled: the idempotent re-pay returns the cached P; we verify + claim.
  let claimed = null;
  const r = await resumeReversePay(rec, {
    payInvoice: async () => P, sha256Hex: async (hex) => (hex === P ? HVEC : 'ee'.repeat(32)),
    seqClaimKey: { secret_hex: 'ff'.repeat(32) }, claimSeq: async (c) => { claimed = c; return 'recovered-claim'; },
    seqTip: async () => 100, claimMargin: 120,
  });
  assert.ok(r.ok && r.recovered && r.seqClaimTxid === 'recovered-claim', 'a crashed paying buy recovers P from the settled payment and claims');
  assert.equal(claimed.secret_hex, P, 'the resumed claim spends with the recovered P');
  // (2) The payment has NOT settled yet: recovered:false, never dropped, never claimed.
  let claimedAt2 = false;
  const r2 = await resumeReversePay(rec, {
    payInvoice: async () => null, seqClaimKey: { secret_hex: 'ff'.repeat(32) }, claimSeq: async () => { claimedAt2 = true; return 'x'; },
    seqTip: async () => 100, claimMargin: 120,
  });
  assert.ok(!r2.ok && r2.recovered === false && !claimedAt2, 'an unsettled payment is kept resumable (never dropped, never claimed)');
  // (3) Past the claim window: do NOT (re)pay — the maker may have refunded the asset (no loss).
  let paidAt3 = false;
  const r3 = await resumeReversePay(rec, {
    payInvoice: async () => { paidAt3 = true; return P; }, seqClaimKey: { secret_hex: 'ff'.repeat(32) }, claimSeq: async () => 'x',
    seqTip: async () => LOCK, claimMargin: 120,   // tip == T_seq -> window closed
  });
  assert.ok(!r3.ok && !paidAt3, 'past the claim window resume does NOT re-pay (no loss)');
  console.log('ok: resumeReversePay recovers a crashed paying buy (idempotent), never drops it, never re-pays past the window');
}

console.log('\nALL PASS');
