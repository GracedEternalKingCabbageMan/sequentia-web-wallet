// Unit tests for bridge-maker.mjs — the LSP's reverse-maker courier handshake + the fund-safety parse of
// the maker's on-chain BTC HTLC. The courier session is a scripted FAKE (send records, recv replays), so
// the message flow, the terms binding, and the "refuse to front unless the HTLC is locked to the LSP"
// gate are all proven WITHOUT a relay or a node — the same discipline as the pure cores this feeds.
import test from 'node:test';
import assert from 'node:assert';
import { XcType } from '../../xcourier.js';
import { runReverseBridgeTerms, relayTakerAssetLeg, parseHtlcRedeem, verifyMakerBtcHtlc, newBridgeClaimKeypair } from './bridge-maker.mjs';

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
function buildHtlcRedeem(hashHex, claimPubHex, refundPubHex, locktime) {
  const lt = encScriptNum(locktime);
  return b2h(Uint8Array.from([
    OP.IF, OP.SHA256, ...pushData(h2b(hashHex)), OP.EQUALVERIFY, ...pushData(h2b(claimPubHex)), OP.CHECKSIG,
    OP.ELSE, ...pushData(lt), OP.CLTV, OP.DROP, ...pushData(h2b(refundPubHex)), OP.CHECKSIG, OP.ENDIF,
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
