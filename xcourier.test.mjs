// Headless node test for xcourier.js (the cross-chain courier transport).
// Run: node xcourier.test.mjs   (exit 0 = all pass). No DOM, no relay.
import { __test__ } from './xcourier.js';
import { Crypter } from './seqob.js';
import { secp256k1 } from './btc.js';

const { encodeXcMsg, decodeXcMsg, XcType, CourierSession } = __test__;
let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++; } else console.log('ok:', m); };

// 1. codec round-trip + omitempty (undefined/null/'' dropped) + exact JSON field names.
const terms = {
  type: XcType.Terms, maker_btc_claim_pub: '02aa', maker_refund_pub: '02bb',
  btc_locktime: 142683, seq_locktime: 16449, btc_amount: 25000, seq_amount: 5000000,
  code: '', leg: null, fee_btc: undefined,
};
const enc = encodeXcMsg(terms);
const dec = decodeXcMsg(enc);
ok(dec.type === 'terms' && dec.maker_btc_claim_pub === '02aa' && dec.btc_amount === 25000 && dec.seq_amount === 5000000, 'terms round-trips');
ok(!('fee_btc' in dec) && !('code' in dec) && !('leg' in dec), 'undefined/empty/null fields omitted');
const s = new TextDecoder().decode(enc);
ok(s.includes('"type":"terms"') && s.includes('"seq_locktime":16449') && s.includes('"maker_btc_claim_pub":"02aa"'), 'exact snake_case JSON field names (match xcourier.go)');

// 2. XcLeg round-trip (vout:0 must survive — no omitempty on vout in Go).
const funded = {
  type: XcType.BtcLegFunded, hash_h: 'ab'.repeat(32), taker_seq_claim_pub: '03cc', taker_btc_refund_pub: '03dd',
  leg: { txid: 'deadbeef', vout: 0, amount: 25000, redeem_script: '51', locktime: 142683, height: 142580 },
};
const fd = decodeXcMsg(encodeXcMsg(funded));
ok(fd.leg.txid === 'deadbeef' && fd.leg.vout === 0 && fd.leg.height === 142580 && fd.hash_h.length === 64, 'btc_leg_funded + XcLeg round-trip (incl. vout:0)');

// 3. CourierSession send/recv over an in-memory transport, two crypters (taker/maker),
//    both derived by ECDH so the sealed payloads decrypt on the far side.
const takerPriv = secp256k1.utils.randomSecretKey();
const makerPriv = secp256k1.utils.randomSecretKey();
const takerCrypter = await Crypter.fromECDH(takerPriv, secp256k1.getPublicKey(makerPriv, true));
const makerCrypter = await Crypter.fromECDH(makerPriv, secp256k1.getPublicKey(takerPriv, true));

function pair() {
  const q = []; let w = null;
  return {
    push: (m) => { if (w) { const x = w; w = null; x(m); } else q.push(m); },
    recv: (t) => new Promise((res) => { if (q.length) return res(q.shift()); w = res; if (t) setTimeout(() => { if (w) { w = null; res(null); } }, t); }),
  };
}
const toMaker = pair(), toTaker = pair();
const takerSess = new CourierSession(takerCrypter, 'sess1', { send: (o) => toMaker.push(o), recv: (t) => toTaker.recv(t), close() {} });
const makerSess = new CourierSession(makerCrypter, 'sess1', { send: (o) => toTaker.push(o), recv: (t) => toMaker.recv(t), close() {} });

await takerSess.send({ type: XcType.TermsRequest });
ok((await makerSess.recv(XcType.TermsRequest, 2000)).type === XcType.TermsRequest, 'maker receives terms_request');

await makerSess.send(terms);
const gotTerms = await takerSess.recv(XcType.Terms, 2000);
ok(gotTerms.btc_amount === 25000 && gotTerms.maker_btc_claim_pub === '02aa', 'taker receives sealed terms');

// 4. skip-unknown: a courtesy secret_revealed then the wanted seq_leg_locked.
await makerSess.send({ type: XcType.SecretRevealed, preimage: 'ff'.repeat(32) });
await makerSess.send({ type: XcType.SeqLegLocked, leg: { txid: 'seqtx', vout: 1, amount: 5000000, asset: 'aa11', redeem_script: '52', locktime: 16449, block_hash: 'blk', anchor_height: 142580 } });
const locked = await takerSess.recv(XcType.SeqLegLocked, 2000);
ok(locked.leg.txid === 'seqtx' && locked.leg.anchor_height === 142580, 'recv skips unknown types and returns the wanted one');

// 5. XcFail surfaces as a thrown error.
await makerSess.send({ type: XcType.Fail, code: 'terms_mismatch', message: 'nope' });
let threw = false; try { await takerSess.recv(XcType.SeqLegLocked, 1000); } catch (e) { threw = /peer failed/.test(e.message); }
ok(threw, 'XcFail throws on recv');

// 6. recv times out when nothing arrives.
let toThrew = false; try { await takerSess.recv(XcType.Terms, 200); } catch (e) { toThrew = /timed out/.test(e.message); }
ok(toThrew, 'recv times out');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
