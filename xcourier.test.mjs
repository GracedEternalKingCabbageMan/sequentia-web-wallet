// Headless node test for xcourier.js (the cross-chain courier transport).
// Run: node xcourier.test.mjs   (exit 0 = all pass). No DOM, no relay.
import { __test__ } from './xcourier.js';
import { Crypter, bytesToHex } from './seqob.js';
import { secp256k1 } from './btc.js';

const { encodeXcMsg, decodeXcMsg, XcType, CourierSession, openMakerListener, b64encode, b64decode } = __test__;
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

// 7. openMakerListener: offer_submit registration, lift routing, sealed round-trip,
//    single-flight busy refusal — all over an injected fake WebSocket.
function fakeWs(){
  const sent = [];
  const ws = {
    send: (s) => sent.push(JSON.parse(s)),
    close(){ if (ws.onclose) ws.onclose(); },
    onmessage: null, onclose: null,
    inject: (obj) => { if (ws.onmessage) ws.onmessage({ data: JSON.stringify(obj) }); },
    sent,
  };
  return ws;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mws = fakeWs();
const offerPriv = secp256k1.utils.randomSecretKey();
const offerPub  = secp256k1.getPublicKey(offerPriv, true);
const signedOffer = { offer_id: 'off1', maker_pubkey: bytesToHex(offerPub), cross_chain: { direction: 0 } };
const tSessPriv = secp256k1.utils.randomSecretKey();
const tSessPub  = secp256k1.getPublicKey(tSessPriv, true);
const tCrypter  = await Crypter.fromECDH(tSessPriv, offerPub);   // taker's view of the E2E key

let liftGot = null;
const listener = await openMakerListener(signedOffer, offerPriv, async (session, lift) => {
  liftGot = lift;
  const tr = await session.recv(XcType.TermsRequest, 2000);      // taker's sealed terms_request
  if (tr.type === XcType.TermsRequest) await session.send({ type: XcType.Terms, btc_amount: 25000, seq_amount: 5000000 });
  await sleep(400);                                              // stay in-flight for the single-flight check
}, { ws: mws });

ok(mws.sent.some(m => m.offer_submit && m.offer_submit.offer_id === 'off1'), 'maker sends offer_submit to register the offer + lift route');

mws.inject({ lift_requested: { session_id: 'sess7', offer_id: 'off1', maker_pubkey: signedOffer.maker_pubkey, take_amount: '5000000', taker_session_pubkey: b64encode(tSessPub) } });
await sleep(30);
ok(liftGot && liftGot.sessionId === 'sess7' && liftGot.takeAmount === 5000000n, 'onLift fires with parsed lift (BigInt takeAmount)');

const trSealed = await tCrypter.seal(encodeXcMsg({ type: XcType.TermsRequest }));
mws.inject({ swap_msg: { session_id: 'sess7', ciphertext: b64encode(trSealed) } });
await sleep(30);
const outTerms = mws.sent.filter(m => m.swap_msg && m.swap_msg.session_id === 'sess7');
ok(outTerms.length >= 1, 'maker couriers a sealed reply for the session');
const openedTerms = decodeXcMsg(await tCrypter.open(b64decode(outTerms[outTerms.length-1].swap_msg.ciphertext)));
ok(openedTerms.type === XcType.Terms && openedTerms.btc_amount === 25000, 'taker opens the maker-sealed terms (ECDH symmetric)');

const t2Priv = secp256k1.utils.randomSecretKey(), t2Pub = secp256k1.getPublicKey(t2Priv, true);
const t2Crypter = await Crypter.fromECDH(t2Priv, offerPub);
mws.inject({ lift_requested: { session_id: 'sess8', offer_id: 'off1', maker_pubkey: signedOffer.maker_pubkey, take_amount: '1000', taker_session_pubkey: b64encode(t2Pub) } });
await sleep(30);
const busy = mws.sent.filter(m => m.swap_msg && m.swap_msg.session_id === 'sess8');
ok(busy.length >= 1, 'second concurrent lift gets a reply');
const busyMsg = decodeXcMsg(await t2Crypter.open(b64decode(busy[busy.length-1].swap_msg.ciphertext)));
ok(busyMsg.type === XcType.Fail && busyMsg.code === 'busy', 'second concurrent lift refused with XcFail{busy} (whole-HTLC single-flight)');
listener.close();

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
