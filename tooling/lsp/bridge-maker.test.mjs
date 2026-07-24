// Unit tests for bridge-maker.mjs — the LSP's reverse-maker courier handshake + the fund-safety parse of
// the maker's on-chain BTC HTLC. The courier session is a scripted FAKE (send records, recv replays), so
// the message flow, the terms binding, and the "refuse to front unless the HTLC is locked to the LSP"
// gate are all proven WITHOUT a relay or a node — the same discipline as the pure cores this feeds.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XcType } from '../../xcourier.js';
import { runReverseBridgeTerms, relayTakerAssetLeg, parseHtlcRedeem, verifyMakerBtcHtlc, newBridgeClaimKeypair,
  runForwardBridgeTerms, sendForwardBtcLegFunded, verifyMakerAssetLeg, checkMakerAssetLegObserved,
  buildHtlcRedeem as buildHtlcRedeemExport } from './bridge-maker.mjs';

// --- a Design-A HTLC redeemScript builder that mirrors pkg/xchain/primitive.go byte-for-byte -----------
const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, EQUALVERIFY: 0x88, SHA256: 0xa8, CHECKSIG: 0xac, CLTV: 0xb1 };
function h2b(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function b2h(a) { let s = ''; for (const x of a) s += x.toString(16).padStart(2, '0'); return s; }
// btcd AddInt64 minimal CScriptNum (non-negative here): little-endian, append 0x00 if the MSB is set.
function encScriptNum(n) {
  if (n === 0) return new Uint8Array(0);
  const out = []; let v = n; while (v > 0) { out.push(v & 0xff); v >>>= 8; }
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Uint8Array.from(out);
}
function pushData(bytes) { return Uint8Array.from([bytes.length, ...bytes]); }   // <=75-byte canonical push
// btcd AddInt64 emits a single OP_N opcode (OP_1=0x51..OP_16=0x60) for 1..16, else a data push — mirror it.
function encodeLocktime(locktime) {
  if (locktime >= 1 && locktime <= 16) return Uint8Array.from([0x50 + locktime]);
  return pushData(encScriptNum(locktime));
}
function buildHtlcRedeem(hashHex, claimPubHex, refundPubHex, locktime) {
  return b2h(Uint8Array.from([
    OP.IF, OP.SHA256, ...pushData(h2b(hashHex)), OP.EQUALVERIFY, ...pushData(h2b(claimPubHex)), OP.CHECKSIG,
    OP.ELSE, ...encodeLocktime(locktime), OP.CLTV, OP.DROP, ...pushData(h2b(refundPubHex)), OP.CHECKSIG, OP.ENDIF,
  ]));
}

// --- a scripted fake CourierSession -------------------------------------------------------------------
function fakeSession(replies) {
  const sent = [];
  const queue = replies.slice();
  return {
    sent,
    send: async (m) => { sent.push(m); },
    recv: async (wantType) => {
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].type === wantType) return queue.splice(i, 1)[0];
      }
      throw new Error(`fake: no scripted ${wantType}`);
    },
    fail: async () => {},
  };
}

const H = 'ab'.repeat(32);
const LSP = newBridgeClaimKeypair();      // the LSP's BTC claim key (what the maker must lock to)
const MAKER_REFUND = newBridgeClaimKeypair().pubHex;
const MAKER_SEQ_CLAIM = newBridgeClaimKeypair().pubHex;
const TAKER_SEQ_REFUND = newBridgeClaimKeypair().pubHex;
const T_BTC = 851234, T_SEQ = 4210000;

function makerBtcLegLocked({ claimPub = LSP.pubHex, hash = H, refund = MAKER_REFUND, cltv = T_BTC, btcAmount = 76066, seqAmount = 13127177428 } = {}) {
  return { type: XcType.BtcLegLocked, hash_h: hash, maker_seq_claim_pub: MAKER_SEQ_CLAIM, maker_refund_pub: refund,
    seq_locktime: T_SEQ, btc_amount: btcAmount, seq_amount: seqAmount, fee_btc: 0,
    leg: { txid: 'aa'.repeat(32), vout: 0, amount: btcAmount, redeem_script: buildHtlcRedeem(hash, claimPub, refund, cltv), locktime: cltv } };
}

// --- parseHtlcRedeem round-trips the exact Go script format ---
test('parseHtlcRedeem round-trips a Design-A HTLC (claim, H, refund, locktime)', () => {
  const s = buildHtlcRedeem(H, LSP.pubHex, MAKER_REFUND, T_BTC);
  const p = parseHtlcRedeem(h2b(s));
  assert.equal(p.hashHex, H);
  assert.equal(p.claimPubHex, LSP.pubHex);
  assert.equal(p.refundPubHex, MAKER_REFUND);
  assert.equal(p.locktime, T_BTC);
});

test('verifyMakerBtcHtlc: TRUE only when claim==LSP, H, refund, CLTV all bind', () => {
  const good = buildHtlcRedeem(H, LSP.pubHex, MAKER_REFUND, T_BTC);
  assert.equal(verifyMakerBtcHtlc({ redeemScriptHex: good, hashHex: H, lspClaimPubHex: LSP.pubHex, makerRefundPubHex: MAKER_REFUND, locktime: T_BTC }).ok, true);
  // claim points at someone ELSE (a malicious maker) -> refuse
  const evil = buildHtlcRedeem(H, MAKER_SEQ_CLAIM, MAKER_REFUND, T_BTC);
  assert.equal(verifyMakerBtcHtlc({ redeemScriptHex: evil, hashHex: H, lspClaimPubHex: LSP.pubHex, makerRefundPubHex: MAKER_REFUND, locktime: T_BTC }).ok, false);
  // wrong H
  assert.equal(verifyMakerBtcHtlc({ redeemScriptHex: good, hashHex: 'cd'.repeat(32), lspClaimPubHex: LSP.pubHex, makerRefundPubHex: MAKER_REFUND, locktime: T_BTC }).ok, false);
  // wrong CLTV vs terms
  assert.equal(verifyMakerBtcHtlc({ redeemScriptHex: good, hashHex: H, lspClaimPubHex: LSP.pubHex, makerRefundPubHex: MAKER_REFUND, locktime: T_BTC + 1 }).ok, false);
});

// --- W1-UNIT: the BTC-HTLC CLTV must be a BLOCK HEIGHT, never a UNIX timestamp ---
// A Bitcoin nLockTime >= 500,000,000 (BIP-65 LOCKTIME_THRESHOLD) is a TIMESTAMP; the bridge locktime-ordering
// gate does height arithmetic, so a timestamp CLTV would let a malicious maker bypass it. Refuse at verify.
const LT_THRESH = 500000000;
test('W1-UNIT verifyMakerBtcHtlc: a TIMESTAMP CLTV (>= LOCKTIME_THRESHOLD) is REFUSED — not a block height', () => {
  const ts = buildHtlcRedeem(H, LSP.pubHex, MAKER_REFUND, LT_THRESH);
  const v = verifyMakerBtcHtlc({ redeemScriptHex: ts, hashHex: H, lspClaimPubHex: LSP.pubHex, makerRefundPubHex: MAKER_REFUND, locktime: LT_THRESH });
  assert.equal(v.ok, false);
  assert.match(v.reason, /block height|TIMESTAMP/i);
  // a height one below the threshold still binds (it is a threshold, not a blanket refusal of large CLTVs).
  const ok = buildHtlcRedeem(H, LSP.pubHex, MAKER_REFUND, LT_THRESH - 1);
  assert.equal(verifyMakerBtcHtlc({ redeemScriptHex: ok, hashHex: H, lspClaimPubHex: LSP.pubHex, makerRefundPubHex: MAKER_REFUND, locktime: LT_THRESH - 1 }).ok, true);
});

// --- B: the EXPORTED buildHtlcRedeem the LSP payer bridge uses to PRE-COMPUTE the intended redeemScript
// (persist-before-broadcast + verify-not-trust the funding CLI) must match the Go script format byte-for-byte,
// or the post-fund verify would spuriously reject / the funded HTLC would be un-refundable by the LSP's key.
test('buildHtlcRedeem (exported): byte-for-byte matches the Go script format + round-trips parseHtlcRedeem', () => {
  const claim = newBridgeClaimKeypair().pubHex, refund = newBridgeClaimKeypair().pubHex;
  for (const lt of [T_BTC, T_SEQ, 1, 44300, LT_THRESH - 1]) {
    const exported = buildHtlcRedeemExport({ hashHex: H, claimPubHex: claim, refundPubHex: refund, locktime: lt });
    assert.equal(exported, buildHtlcRedeem(H, claim, refund, lt));   // == the local mirror of pkg/xchain/primitive.go
    const p = parseHtlcRedeem(h2b(exported));
    assert.equal(p.hashHex, H); assert.equal(p.claimPubHex, claim);
    assert.equal(p.refundPubHex, refund); assert.equal(p.locktime, lt);
  }
  // rejects malformed inputs (never emit a script the LSP could not refund with its persisted key).
  assert.throws(() => buildHtlcRedeemExport({ hashHex: 'ab', claimPubHex: newBridgeClaimKeypair().pubHex, refundPubHex: newBridgeClaimKeypair().pubHex, locktime: T_BTC }), /32-byte/);
  assert.throws(() => buildHtlcRedeemExport({ hashHex: H, claimPubHex: 'abcd', refundPubHex: newBridgeClaimKeypair().pubHex, locktime: T_BTC }), /33-byte/);
  assert.throws(() => buildHtlcRedeemExport({ hashHex: H, claimPubHex: newBridgeClaimKeypair().pubHex, refundPubHex: newBridgeClaimKeypair().pubHex, locktime: LT_THRESH }), /block height/);
});

// --- GOLDEN CROSS-LANGUAGE CONTRACT: the LSP buildHtlcRedeem must byte-match the Go xchain redeemScript ---
// The seqdex Go test (pkg/xchain/htlc_redeem_vectors_test.go) emits the CANONICAL Go LockScript bytes for a
// set of (hash_h, claim_pub, refund_pub, t_btc) tuples — INCLUDING the locktime-encoding edge values 16
// (OP_16 single opcode), 17, 0x7f, 0x80, 0xffff, and 500000000-1 — into a committed fixture. We load that
// exact fixture here and assert the JS buildHtlcRedeem reproduces every redeem_hex byte-for-byte (and that
// parseHtlcRedeem round-trips it). If JS ever diverges from Go, the payer leg-bridge would broadcast the BTC
// funding then throw at its script-equality gate (a fund-loss window) — this test is what forbids that drift.
test('GOLDEN: buildHtlcRedeem byte-matches the Go xchain vectors (incl. locktime edges 16/17/0x7f/0x80/0xffff/5e8-1)', () => {
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'testdata', 'htlc_redeem_vectors.json');
  const vectors = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(Array.isArray(vectors) && vectors.length >= 6, 'fixture must carry the edge-value vectors');
  const seenLocktimes = new Set();
  for (const v of vectors) {
    const got = buildHtlcRedeemExport({ hashHex: v.hash_h, claimPubHex: v.claim_pub, refundPubHex: v.refund_pub, locktime: v.t_btc });
    assert.equal(got, v.redeem_hex, `redeemScript mismatch vs Go at t_btc=${v.t_btc}`);
    const p = parseHtlcRedeem(h2b(v.redeem_hex));
    assert.equal(p.hashHex, v.hash_h);
    assert.equal(p.claimPubHex, v.claim_pub);
    assert.equal(p.refundPubHex, v.refund_pub);
    assert.equal(p.locktime, v.t_btc);
    seenLocktimes.add(v.t_btc);
  }
  // The edge cases that a naive always-data-push JS encoder would get wrong MUST be present in the fixture.
  for (const edge of [16, 17, 0x80, 0xffff]) assert.ok(seenLocktimes.has(edge), `fixture is missing the t_btc=${edge} edge vector`);
});

test('W1-UNIT runReverseBridgeTerms: FAILS CLOSED when the maker BTC HTLC CLTV is a TIMESTAMP, not a height', async () => {
  const s = fakeSession([makerBtcLegLocked({ cltv: LT_THRESH })]);
  await assert.rejects(() => runReverseBridgeTerms({ session: s, lspBtcClaimPubHex: LSP.pubHex, takerSeqRefundPubHex: TAKER_SEQ_REFUND,
    expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /block height|TIMESTAMP/i);
});

// --- the handshake ---
test('runReverseBridgeTerms: sends TermsRequest w/ LSP claim + taker refund, parses BtcLegLocked', async () => {
  const s = fakeSession([makerBtcLegLocked()]);
  const r = await runReverseBridgeTerms({ session: s, lspBtcClaimPubHex: LSP.pubHex, takerSeqRefundPubHex: TAKER_SEQ_REFUND,
    expect: { btcSats: 76066, seqAtoms: 13127177428 } });
  // the LSP inserted itself as the BTC claimer, and passed the TAKER's own asset-refund key
  assert.equal(s.sent[0].type, XcType.TermsRequest);
  assert.equal(s.sent[0].taker_btc_claim_pub, LSP.pubHex);
  assert.equal(s.sent[0].taker_seq_refund_pub, TAKER_SEQ_REFUND);
  // legState the io needs
  assert.equal(r.hashHex, H);
  assert.equal(r.btcHtlc.txid, 'aa'.repeat(32));
  assert.equal(r.btcHtlc.cltv, T_BTC);
  assert.equal(r.btcHtlc.refundPubHex, MAKER_REFUND);
  assert.equal(r.makerSeqClaimPubHex, MAKER_SEQ_CLAIM);
  assert.equal(r.seqLocktime, T_SEQ);
});

test('runReverseBridgeTerms: FAILS CLOSED when the maker locks BTC to a NON-LSP key (unrecoupable front)', async () => {
  const s = fakeSession([makerBtcLegLocked({ claimPub: MAKER_SEQ_CLAIM })]);   // claim != LSP
  await assert.rejects(() => runReverseBridgeTerms({ session: s, lspBtcClaimPubHex: LSP.pubHex, takerSeqRefundPubHex: TAKER_SEQ_REFUND,
    expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /claim pubkey is NOT the LSP key/);
});

test('runReverseBridgeTerms: refuses a maker BTC amount below the offered sats', async () => {
  const s = fakeSession([makerBtcLegLocked({ btcAmount: 5000 })]);
  await assert.rejects(() => runReverseBridgeTerms({ session: s, lspBtcClaimPubHex: LSP.pubHex, takerSeqRefundPubHex: TAKER_SEQ_REFUND,
    expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /below the offered/);
});

test('runReverseBridgeTerms: rejects non-33-byte LSP/taker keys up front', async () => {
  const s = fakeSession([makerBtcLegLocked()]);
  await assert.rejects(() => runReverseBridgeTerms({ session: s, lspBtcClaimPubHex: 'zz', takerSeqRefundPubHex: TAKER_SEQ_REFUND, expect: {} }));
});

test('relayTakerAssetLeg: forwards SeqLegFunded and reads the courtesy preimage', async () => {
  const P = 'cd'.repeat(32);
  const s = fakeSession([{ type: XcType.SecretRevealed, preimage: P }]);
  const leg = { txid: 'bb'.repeat(32), vout: 1, amount: 13127177428, redeem_script: 'deadbeef', locktime: T_SEQ, asset: 'c8ec' };
  const r = await relayTakerAssetLeg({ session: s, takerSeqLeg: leg });
  assert.equal(s.sent[0].type, XcType.SeqLegFunded);
  assert.deepEqual(s.sent[0].leg, leg);
  assert.equal(r.preimageHex, P);
});

// ============================================================================
// FORWARD (PAYER) bridge handshake — the MIRROR: the taker mints H + holds P and buys the asset on-chain,
// paying BTC over LN. The LSP funds the on-chain BTC HTLC to the maker and RELAYS the maker's asset leg,
// which MUST bind claim=the REAL taker's key on H (verifyMakerAssetLeg). Two rounds: Terms, then BtcLegFunded.
// ============================================================================
const MAKER_BTC_CLAIM = newBridgeClaimKeypair().pubHex;   // where the LSP-funded BTC HTLC pays the maker
const MAKER_SEQ_REFUND2 = newBridgeClaimKeypair().pubHex; // the maker's asset refund key
const TAKER_SEQ_CLAIM = newBridgeClaimKeypair().pubHex;   // the REAL taker's asset-claim key on H
const LSP_BTC_REFUND = newBridgeClaimKeypair().pubHex;    // the LSP's own BTC refund key on the funded HTLC

function makerTerms({ btcClaim = MAKER_BTC_CLAIM, seqRefund = MAKER_SEQ_REFUND2, tBtc = T_BTC, tSeq = T_SEQ, btcAmount = 76066, seqAmount = 13127177428, feeBtc = 0 } = {}) {
  return { type: XcType.Terms, maker_btc_claim_pub: btcClaim, maker_refund_pub: seqRefund,
    btc_locktime: tBtc, seq_locktime: tSeq, btc_amount: btcAmount, seq_amount: seqAmount, fee_btc: feeBtc };
}
function makerSeqLegLocked({ claimPub = TAKER_SEQ_CLAIM, hash = H, refund = MAKER_SEQ_REFUND2, cltv = T_SEQ, seqAmount = 13127177428 } = {}) {
  return { type: XcType.SeqLegLocked, leg: { txid: 'cc'.repeat(32), vout: 0, amount: seqAmount, asset: 'c8ec',
    redeem_script: buildHtlcRedeem(hash, claimPub, refund, cltv), locktime: cltv, block_hash: 'ee'.repeat(32), anchor_height: 44100 } };
}

test('verifyMakerAssetLeg: TRUE only when claim==taker, H, refund==maker, CLTV==T_seq all bind', () => {
  const good = buildHtlcRedeem(H, TAKER_SEQ_CLAIM, MAKER_SEQ_REFUND2, T_SEQ);
  assert.equal(verifyMakerAssetLeg({ redeemScriptHex: good, hashHex: H, takerSeqClaimPubHex: TAKER_SEQ_CLAIM, makerRefundPubHex: MAKER_SEQ_REFUND2, locktime: T_SEQ }).ok, true);
  // claim points at the LSP/maker, NOT the real taker -> refuse (the taker could never claim the asset)
  const evil = buildHtlcRedeem(H, MAKER_BTC_CLAIM, MAKER_SEQ_REFUND2, T_SEQ);
  assert.equal(verifyMakerAssetLeg({ redeemScriptHex: evil, hashHex: H, takerSeqClaimPubHex: TAKER_SEQ_CLAIM, makerRefundPubHex: MAKER_SEQ_REFUND2, locktime: T_SEQ }).ok, false);
  // wrong H, wrong CLTV
  assert.equal(verifyMakerAssetLeg({ redeemScriptHex: good, hashHex: 'cd'.repeat(32), takerSeqClaimPubHex: TAKER_SEQ_CLAIM, makerRefundPubHex: MAKER_SEQ_REFUND2, locktime: T_SEQ }).ok, false);
  assert.equal(verifyMakerAssetLeg({ redeemScriptHex: good, hashHex: H, takerSeqClaimPubHex: TAKER_SEQ_CLAIM, makerRefundPubHex: MAKER_SEQ_REFUND2, locktime: T_SEQ + 1 }).ok, false);
});

test('verifyMakerAssetLeg: a TIMESTAMP CLTV (>= LOCKTIME_THRESHOLD) is REFUSED (must be a block height)', () => {
  const ts = buildHtlcRedeem(H, TAKER_SEQ_CLAIM, MAKER_SEQ_REFUND2, LT_THRESH);
  assert.equal(verifyMakerAssetLeg({ redeemScriptHex: ts, hashHex: H, takerSeqClaimPubHex: TAKER_SEQ_CLAIM, makerRefundPubHex: MAKER_SEQ_REFUND2, locktime: LT_THRESH }).ok, false);
});

test('runForwardBridgeTerms: sends TermsRequest, parses the maker Terms + binds amounts', async () => {
  const s = fakeSession([makerTerms()]);
  const t = await runForwardBridgeTerms({ session: s, expect: { btcSats: 76066, seqAtoms: 13127177428 } });
  assert.equal(s.sent[0].type, XcType.TermsRequest);
  assert.equal(t.makerBtcClaimPubHex, MAKER_BTC_CLAIM);
  assert.equal(t.makerSeqRefundPubHex, MAKER_SEQ_REFUND2);
  assert.equal(t.btcLocktime, T_BTC);
  assert.equal(t.seqLocktime, T_SEQ);
  assert.equal(t.btcAmount, 76066);
  assert.equal(t.seqAmount, 13127177428);
});

test('runForwardBridgeTerms: REFUSES a maker wanting MORE BTC than offered (the LSP would overpay)', async () => {
  const s = fakeSession([makerTerms({ btcAmount: 90000 })]);
  await assert.rejects(() => runForwardBridgeTerms({ session: s, expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /above the offered/);
});

test('runForwardBridgeTerms: REFUSES a NON-POSITIVE BTC price (btcAmount <= 0) — verify-not-trust the maker price', async () => {
  // A maker quoting btcAmount=0 SLIPS PAST the upper-bound (0 > btcSats is false); without this gate the LSP
  // would fund body.btc_sats while persisting bridge_terms.btc_amount=0 (a resume off that would drive a 0-sat
  // leg). Refuse it so terms.btcAmount ALWAYS equals the funded amount — with OR without an expected bound.
  await assert.rejects(() => runForwardBridgeTerms({ session: fakeSession([makerTerms({ btcAmount: 0 })]), expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /non-positive BTC price/);
  await assert.rejects(() => runForwardBridgeTerms({ session: fakeSession([makerTerms({ btcAmount: -5 })]), expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /non-positive BTC price/);
  await assert.rejects(() => runForwardBridgeTerms({ session: fakeSession([makerTerms({ btcAmount: 0 })]), expect: {} }), /non-positive BTC price/);
});

test('runForwardBridgeTerms: REFUSES a maker delivering LESS asset than offered', async () => {
  const s = fakeSession([makerTerms({ seqAmount: 1000 })]);
  await assert.rejects(() => runForwardBridgeTerms({ session: s, expect: { btcSats: 76066, seqAtoms: 13127177428 } }), /below the offered/);
});

test('runForwardBridgeTerms: rejects malformed Terms (missing keys / locktimes)', async () => {
  await assert.rejects(() => runForwardBridgeTerms({ session: fakeSession([{ type: XcType.Terms, btc_locktime: T_BTC, seq_locktime: T_SEQ }]), expect: {} }), /claim pubkey|refund pubkey/);
  await assert.rejects(() => runForwardBridgeTerms({ session: fakeSession([makerTerms({ tBtc: 0 })]), expect: {} }), /T_btc/);
});

test('sendForwardBtcLegFunded: sends BtcLegFunded w/ taker claim + LSP refund, verifies the maker asset leg', async () => {
  const s = fakeSession([makerSeqLegLocked()]);
  const btcLeg = { txid: 'dd'.repeat(32), vout: 0, amount: 76066, redeem_script: 'beef' };
  const r = await sendForwardBtcLegFunded({ session: s, hashHex: H, takerSeqClaimPubHex: TAKER_SEQ_CLAIM,
    lspBtcRefundPubHex: LSP_BTC_REFUND, btcLeg, takeSeqAtoms: 13127177428, makerSeqRefundPubHex: MAKER_SEQ_REFUND2, seqLocktime: T_SEQ });
  assert.equal(s.sent[0].type, XcType.BtcLegFunded);
  assert.equal(s.sent[0].hash_h, H);
  assert.equal(s.sent[0].taker_seq_claim_pub, TAKER_SEQ_CLAIM);   // the REAL taker's asset-claim key (self-custody)
  assert.equal(s.sent[0].taker_btc_refund_pub, LSP_BTC_REFUND);   // the LSP refunds the BTC HTLC it funds
  assert.deepEqual(s.sent[0].leg, btcLeg);
  assert.equal(r.makerSeqLeg.txid, 'cc'.repeat(32));
  assert.equal(r.makerSeqLeg.locktime, T_SEQ);
});

test('sendForwardBtcLegFunded: FAILS CLOSED when the maker locks the asset to a NON-taker key (taker could not claim)', async () => {
  const s = fakeSession([makerSeqLegLocked({ claimPub: MAKER_BTC_CLAIM })]);   // claim != the real taker
  const btcLeg = { txid: 'dd'.repeat(32), vout: 0, amount: 76066, redeem_script: 'beef' };
  await assert.rejects(() => sendForwardBtcLegFunded({ session: s, hashHex: H, takerSeqClaimPubHex: TAKER_SEQ_CLAIM,
    lspBtcRefundPubHex: LSP_BTC_REFUND, btcLeg, takeSeqAtoms: 13127177428, makerSeqRefundPubHex: MAKER_SEQ_REFUND2, seqLocktime: T_SEQ }),
    /NOT the taker key/);
});

test('sendForwardBtcLegFunded: rejects non-33-byte taker/LSP keys up front', async () => {
  const btcLeg = { txid: 'dd'.repeat(32), vout: 0, amount: 76066, redeem_script: 'beef' };
  await assert.rejects(() => sendForwardBtcLegFunded({ session: fakeSession([makerSeqLegLocked()]), hashHex: H,
    takerSeqClaimPubHex: 'zz', lspBtcRefundPubHex: LSP_BTC_REFUND, btcLeg, takeSeqAtoms: 1, makerSeqRefundPubHex: MAKER_SEQ_REFUND2, seqLocktime: T_SEQ }));
});

// --- checkMakerAssetLegObserved (hole 3): the ON-CHAIN value-verify (half (b)) of the forward maker's asset
// leg. verifyMakerAssetLeg proves what the maker CLAIMS in its redeemScript (parse); this proves the maker
// actually FUNDED it on-chain, for the AGREED asset + amount, bound to that same script — BEFORE the LSP hands
// the leg to the taker to claim. Mirror of the receiver bridge's observeNativeLocked binding. Pure.
const GOOD_OBSERVE = { funded: true, script_bound: true, asset_id: 'ab'.repeat(32), amount: 13127177428 };
const ASSET_ID = 'ab'.repeat(32);

test('checkMakerAssetLegObserved: a funded, script-bound, right-asset, sufficient-amount output PASSES', () => {
  const v = checkMakerAssetLegObserved({ observed: GOOD_OBSERVE, expectAssetId: ASSET_ID, expectAtoms: 13127177428 });
  assert.equal(v.ok, true, v.reason);
});

test('checkMakerAssetLegObserved: an UNFUNDED outpoint (maker broadcast lag / never funded) is REFUSED', () => {
  const v = checkMakerAssetLegObserved({ observed: { ...GOOD_OBSERVE, funded: false }, expectAssetId: ASSET_ID, expectAtoms: 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /not funded/i);
});

test('checkMakerAssetLegObserved: a NON-script-bound output (funded a different script) is REFUSED', () => {
  const v = checkMakerAssetLegObserved({ observed: { ...GOOD_OBSERVE, script_bound: false }, expectAssetId: ASSET_ID, expectAtoms: 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /P2SH|not bound|script/i);
});

test('checkMakerAssetLegObserved: a WRONG asset id is REFUSED; a missing asset id (with an expectation) is REFUSED', () => {
  assert.equal(checkMakerAssetLegObserved({ observed: { ...GOOD_OBSERVE, asset_id: 'cd'.repeat(32) }, expectAssetId: ASSET_ID, expectAtoms: 1 }).ok, false);
  const noId = checkMakerAssetLegObserved({ observed: { ...GOOD_OBSERVE, asset_id: null }, expectAssetId: ASSET_ID, expectAtoms: 1 });
  assert.equal(noId.ok, false);
  assert.match(noId.reason, /no readable asset id|asset/i);
});

test('checkMakerAssetLegObserved: an UNDER-delivered amount (below the agreed atoms) is REFUSED; over-delivery is fine', () => {
  assert.equal(checkMakerAssetLegObserved({ observed: { ...GOOD_OBSERVE, amount: 13127177427 }, expectAssetId: ASSET_ID, expectAtoms: 13127177428 }).ok, false);
  assert.equal(checkMakerAssetLegObserved({ observed: { ...GOOD_OBSERVE, amount: 13127177429 }, expectAssetId: ASSET_ID, expectAtoms: 13127177428 }).ok, true);
});

test('checkMakerAssetLegObserved: a null/absent observe (unreadable) fails closed', () => {
  assert.equal(checkMakerAssetLegObserved({ observed: null, expectAssetId: ASSET_ID, expectAtoms: 1 }).ok, false);
  assert.equal(checkMakerAssetLegObserved({}).ok, false);
});
