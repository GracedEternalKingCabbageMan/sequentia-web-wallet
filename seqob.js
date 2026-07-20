// ---------------------------------------------------------------------------
// SeqOB order-book client — the wallet's same-chain Swap talks to the SeqOB
// relay (seqobd), not the old RFQ daemon. This module is the PURE protocol:
//
//   • a minimal protobuf wire codec for the inner swap messages (SwapRequest,
//     SwapAccept, SwapComplete) and the deterministic Offer encoding used for
//     signing/verification — byte-for-byte compatible with the Go relay
//     (validated against ground truth from internal/seqob/offer).
//   • the E2E Crypter: key = sha256(ECDH_X(myPriv, peerPub)) over secp256k1
//     (matches btcec.GenerateSharedSecret, which returns the 32-byte X), sealed
//     with AES-256-GCM (12-byte nonce prepended; WebCrypto default 128-bit tag).
//   • REST helpers: book snapshot, post/cancel offer, a maker's own orders.
//   • lift(): drive a taker lift over the WS courier to settlement, calling back
//     into the host for the two wasm-bound steps (build the SwapRequest, finalize
//     + broadcast the maker's co-signed PSET). The relay only ever sees ciphertext.
//
// The wallet acts as the TAKER (lift a resting offer) and can POST a resting
// offer (be the first to make a market). Co-signing lifts on a posted offer
// (the maker responder) needs the ResponderComplete PSET path, which is not yet
// in the wasm; posting rests an offer that a maker process (or a future in-wallet
// responder) fills. See README/report.
// ---------------------------------------------------------------------------

import { secp256k1, sha256 } from './btc.js';
// Pure-JS AES-256-GCM (vendored from @noble/ciphers v2.2.0). The wallet is served
// over plain HTTP, where WebCrypto's crypto.subtle is undefined; this works there.
import { gcm } from './noble-ciphers.js';

// --- byte helpers ----------------------------------------------------------

const te = new TextEncoder();
const td = new TextDecoder();

export function bytesToHex(a){ let s=''; for (let i=0;i<a.length;i++) s += a[i].toString(16).padStart(2,'0'); return s; }
export function hexToBytes(h){
  if (h == null) return new Uint8Array(0);
  if (h.length % 2) throw new Error('odd hex length');
  const a = new Uint8Array(h.length/2);
  for (let i=0;i<a.length;i++) a[i] = parseInt(h.substr(i*2,2),16);
  return a;
}
function b64encode(bytes){ let s=''; for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function b64decode(b64){ const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
function concatBytes(...arrs){ let n=0; for (const a of arrs) n+=a.length; const out=new Uint8Array(n); let o=0; for (const a of arrs){ out.set(a,o); o+=a.length; } return out; }

// --- minimal protobuf writer ----------------------------------------------
//
// Proto3 semantics: scalar zero/empty/false fields are omitted; message and
// repeated fields are emitted when present. Field numbers > 15 produce a
// multi-byte tag (varint of field<<3|wiretype). uint64 values may exceed 2^53
// so amounts are handled as BigInt.

class PW {
  constructor(){ this.b = []; }
  bytes(){ return Uint8Array.from(this.b); }
  _varint(v){
    let n = typeof v === 'bigint' ? v : BigInt(v);
    if (n < 0n) throw new Error('negative varint');
    while (n > 0x7fn){ this.b.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
    this.b.push(Number(n));
  }
  _tag(field, wtype){ this._varint((BigInt(field) << 3n) | BigInt(wtype)); }
  _raw(arr){ for (let i=0;i<arr.length;i++) this.b.push(arr[i]); }
  // string (wiretype 2): omit empty (proto3 default)
  str(field, s){ if (s == null || s === '') return; const enc = te.encode(String(s)); this._tag(field,2); this._varint(enc.length); this._raw(enc); }
  // uint32/uint64 (wiretype 0): omit zero. Accepts number|string|bigint.
  uint(field, v){ const n = (typeof v === 'bigint') ? v : BigInt(v == null ? 0 : v); if (n === 0n) return; this._tag(field,0); this._varint(n); }
  bool(field, v){ if (!v) return; this._tag(field,0); this._varint(1n); }
  enum(field, v){ const n = BigInt(v||0); if (n === 0n) return; this._tag(field,0); this._varint(n); }
  // length-delimited raw bytes (wiretype 2). Always emitted (caller decides presence).
  lenbytes(field, bytes){ this._tag(field,2); this._varint(bytes.length); this._raw(bytes); }
  // embedded message (wiretype 2): emit only when sub is non-null.
  msg(field, sub){ if (sub == null) return; this.lenbytes(field, sub); }
}

// --- minimal protobuf reader (only what SwapAccept needs) ------------------

function readVarint(b, i){
  let shift = 0n, result = 0n;
  while (true){
    const byte = b[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, i];
}
// Returns a map field# -> array of {wtype, val}. Length-delimited values are
// Uint8Array; varints are BigInt. Unknown fields are captured and ignored.
function readFields(b){
  const out = {};
  let i = 0;
  while (i < b.length){
    let tag; [tag, i] = readVarint(b, i);
    const field = Number(tag >> 3n), wtype = Number(tag & 0x7n);
    let val;
    if (wtype === 0){ [val, i] = readVarint(b, i); }
    else if (wtype === 2){ let len; [len, i] = readVarint(b, i); const n = Number(len); val = b.subarray(i, i+n); i += n; }
    else if (wtype === 5){ val = b.subarray(i, i+4); i += 4; }
    else if (wtype === 1){ val = b.subarray(i, i+8); i += 8; }
    else throw new Error('unsupported wiretype ' + wtype);
    (out[field] = out[field] || []).push(val);
  }
  return out;
}
function firstStr(fields, n){ const v = fields[n] && fields[n][0]; return v ? td.decode(v) : ''; }

// --- inner swap message codec ---------------------------------------------

// Normalise the wasm SwapRequest.toJson() shape (camel or snake) into our fields.
function normReq(j){
  const g = (...names) => { for (const n of names) if (j[n] !== undefined && j[n] !== null) return j[n]; return undefined; };
  const ui = g('unblinded_inputs','unblindedInputs') || [];
  return {
    id: g('id'),
    amount_p: g('amount_p','amountP'),
    asset_p: g('asset_p','assetP'),
    amount_r: g('amount_r','amountR'),
    asset_r: g('asset_r','assetR'),
    transaction: g('transaction'),
    unblinded_inputs: ui.map(u => ({
      index: u.index ?? 0,
      asset: u.asset,
      amount: u.amount,
      asset_blinder: u.asset_blinder ?? u.assetBlinder,
      amount_blinder: u.amount_blinder ?? u.amountBlinder,
    })),
  };
}

function encodeUnblindedInput(u){
  const w = new PW();
  w.uint(1, u.index || 0);          // index (omit 0 — maker defaults to 0)
  w.str(2, u.asset);
  w.uint(3, u.amount || 0);
  w.str(4, u.asset_blinder);
  w.str(5, u.amount_blinder);
  return w.bytes();
}

// seqdex.v1.SwapRequest -> wire bytes (standard, not deterministic; the maker
// just proto.Unmarshals it).
export function encodeSwapRequest(reqJson){
  const r = normReq(reqJson);
  const w = new PW();
  w.str(1, r.id);
  w.uint(2, r.amount_p);
  w.str(3, r.asset_p);
  w.uint(4, r.amount_r);
  w.str(5, r.asset_r);
  w.str(6, r.transaction);
  for (const u of (r.unblinded_inputs||[])) w.msg(7, encodeUnblindedInput(u));
  return w.bytes();
}

// wire bytes -> {id, request_id, transaction} (unblinded_inputs ignored: the
// finalize only needs the maker's co-signed PSET in `transaction`).
export function decodeSwapAccept(bytes){
  const f = readFields(bytes);
  return { id: firstStr(f,1), request_id: firstStr(f,2), transaction: firstStr(f,3) };
}

// seqdex.v1.SwapComplete -> wire bytes.
export function encodeSwapComplete(c){
  const w = new PW();
  w.str(1, c.id);
  w.str(2, c.accept_id);
  w.str(3, c.transaction);
  return w.bytes();
}

// --- deterministic Offer encoding (sign/verify) ----------------------------

function tradeDirNum(v){
  if (typeof v === 'number') return v;
  if (typeof v === 'string'){
    if (v === 'TRADE_DIR_SELL' || v === '1') return 1;
    if (v === 'TRADE_DIR_BUY'  || v === '2') return 2;
    return 0;
  }
  return v || 0;
}
const O = (j, ...names) => { for (const n of names) if (j[n] !== undefined && j[n] !== null) return j[n]; return undefined; };

function encodeAssetPair(p){
  if (!p) return null;
  const w = new PW();
  w.str(1, O(p,'base_asset','baseAsset'));
  w.str(2, O(p,'quote_asset','quoteAsset'));
  return w.bytes();
}
function encodeSameChain(s){
  if (!s) return null;
  const w = new PW();
  w.str(1, O(s,'maker_recv_address','makerRecvAddress'));
  w.str(2, O(s,'maker_blinding_pub','makerBlindingPub'));
  return w.bytes();
}

// seqob.v1.CovenantTerms (offer settlement oneof field 23): a FUNDED, self-
// enforcing resting order (passive CLOB). Byte-identical to the Go relay's
// deterministic marshal so a maker-signed covenant offer verifies here and the
// signature the relay checks matches. The `bytes` fields (maker_prog, maker_x,
// internal_key, merkle_path) are carried as HEX in the offer object and encoded
// as raw bytes here for signing; convert to base64 for the grpc-gateway JSON POST
// (covenantOfferForPost below).
function encodeCovenantTerms(c){
  if (!c) return null;
  const w = new PW();
  w.str(1, O(c,'covenant_txid','covenantTxid'));
  w.uint(2, O(c,'covenant_vout','covenantVout'));
  w.str(3, O(c,'asset_a','assetA'));
  w.str(4, O(c,'asset_b','assetB'));
  w.uint(5, O(c,'rate_num','rateNum'));
  w.uint(6, O(c,'rate_den','rateDen'));
  w.lenbytes(7, hexToBytes(O(c,'maker_prog','makerProg')));
  w.uint(8, O(c,'maker_prog_ver','makerProgVer'));
  w.uint(9, O(c,'min_lot','minLot'));
  w.uint(10, O(c,'expiry_locktime','expiryLocktime'));
  w.lenbytes(11, hexToBytes(O(c,'maker_x','makerX')));
  w.lenbytes(12, hexToBytes(O(c,'internal_key','internalKey')));
  for (const p of (O(c,'merkle_path','merklePath') || [])) w.lenbytes(13, hexToBytes(p));
  return w.bytes();
}

// seqob.v1.CrossChainTerms (offer settlement oneof field 21). Field numbers and
// proto3 omit-zero semantics match the Go relay's deterministic marshal exactly,
// so a maker-signed CROSS offer verifies here byte-for-byte (direction 0 =
// BTC_TO_ASSET is omitted on both sides, like any proto3 zero uint).
function encodeCrossChain(c){
  if (!c) return null;
  const w = new PW();
  w.str(1, O(c,'btc_sentinel','btcSentinel'));
  w.str(2, O(c,'maker_claim_pub','makerClaimPub'));
  w.str(3, O(c,'maker_refund_pub','makerRefundPub'));
  w.uint(4, O(c,'maker_leg_locktime','makerLegLocktime'));
  w.str(5, O(c,'maker_recv_address','makerRecvAddress'));
  w.uint(6, O(c,'direction'));
  return w.bytes();
}

// Deterministic proto encoding of seqob.v1.Offer with maker_sig cleared, fields
// in ascending number order — the exact bytes the Go relay signs/verifies.
// Only the same_chain settlement variant is produced (the wallet posts same-chain
// offers); cross_chain/lightning offers are verified by passing through their
// pre-encoded settlement bytes is out of scope here.
export function canonicalOfferBytes(o){
  const w = new PW();
  w.str(1, O(o,'offer_id','offerId'));
  w.uint(2, O(o,'schema_version','schemaVersion'));
  w.msg(3, encodeAssetPair(O(o,'pair')));
  w.enum(4, tradeDirNum(O(o,'trade_dir','tradeDir')));
  w.uint(5, O(o,'base_amount','baseAmount'));
  w.uint(6, O(o,'offer_amount','offerAmount'));
  w.str(7, O(o,'offer_asset','offerAsset'));
  w.uint(8, O(o,'want_amount','wantAmount'));
  w.str(9, O(o,'want_asset','wantAsset'));
  w.bool(10, O(o,'allow_partial','allowPartial'));
  w.uint(11, O(o,'min_fill','minFill'));
  w.uint(12, O(o,'created_at_unix','createdAtUnix'));
  w.uint(13, O(o,'expires_at_unix','expiresAtUnix'));
  w.str(14, O(o,'maker_pubkey','makerPubkey'));
  w.str(15, O(o,'fee_asset_hint','feeAssetHint'));
  w.uint(16, O(o,'min_anchor_depth','minAnchorDepth'));
  w.str(17, O(o,'maker_ln_node_pubkey','makerLnNodePubkey'));
  const hints = O(o,'ln_connect_hints','lnConnectHints') || [];
  for (const h of hints) w.str(18, h);
  // confidential (19): the SIGNED book-namespace tag. false (proto3 default) is
  // OMITTED, so a transparent offer encodes byte-for-byte as before — the live
  // unblinded book is untouched. A true value segregates the offer into the
  // relay's blinded book (matches confidential-vs-confidential only). Placed
  // BEFORE the settlement oneof (20+) so the ascending field order is preserved.
  w.bool(19, O(o,'confidential','confidential'));
  // oneof settlement, in field-number order: same_chain = 20, cross_chain = 21.
  // Only the set variant is present in a served offer, so exactly one emits; a
  // cross offer now verifies here too (was: cross offers could never verify).
  // lightning = 22 is reserved and not yet encoded.
  w.msg(20, encodeSameChain(O(o,'same_chain','sameChain')));
  w.msg(21, encodeCrossChain(O(o,'cross_chain','crossChain')));
  // lightning = 22 reserved. covenant = 23: passive-CLOB funded resting order.
  w.msg(23, encodeCovenantTerms(O(o,'covenant')));
  // maker_sig (31) is deliberately omitted.
  return w.bytes();
}

// --- ECDSA DER (secp256k1) -------------------------------------------------

function trimInt(b){
  let i = 0; while (i < b.length-1 && b[i] === 0) i++;   // strip leading zeros
  let v = b.subarray(i);
  if (v[0] & 0x80){ const t = new Uint8Array(v.length+1); t[0]=0; t.set(v,1); v = t; } // sign byte
  return v;
}
function derEncode(r32, s32){
  const r = trimInt(r32), s = trimInt(s32);
  const body = concatBytes(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}
function derDecode(der){
  if (der[0] !== 0x30) throw new Error('bad DER');
  let i = 2;                                   // skip 0x30, total-len
  if (der[i++] !== 0x02) throw new Error('bad DER r');
  let rlen = der[i++]; let r = der.subarray(i, i+rlen); i += rlen;
  if (der[i++] !== 0x02) throw new Error('bad DER s');
  let slen = der[i++]; let s = der.subarray(i, i+slen); i += slen;
  const fix = (x) => { if (x.length === 32) return x; if (x.length === 33 && x[0] === 0) return x.subarray(1); const o = new Uint8Array(32); o.set(x.subarray(Math.max(0,x.length-32)), Math.max(0,32-x.length)); return o; };
  return { r: fix(r), s: fix(s) };
}

// Sign an offer object in place: set maker_pubkey from priv, fill maker_sig
// (base64 DER) over sha256(canonical). priv is 32 bytes.
export function signOffer(offer, priv){
  const pub = secp256k1.getPublicKey(priv, true);             // 33B compressed
  offer.maker_pubkey = bytesToHex(pub);
  delete offer.maker_sig;
  const h = sha256(canonicalOfferBytes(offer));
  const compact = secp256k1.sign(h, priv, { prehash: false }); // 64B low-S
  offer.maker_sig = b64encode(derEncode(compact.subarray(0,32), compact.subarray(32,64)));
  return offer;
}

// Verify a relay-served offer's maker signature. Returns true/false (never throws).
export function verifyOffer(offer){
  try {
    const sigB64 = O(offer,'maker_sig','makerSig');
    const pubHex = O(offer,'maker_pubkey','makerPubkey');
    if (!sigB64 || !pubHex) return false;
    const { r, s } = derDecode(b64decode(sigB64));
    const h = sha256(canonicalOfferBytes(offer));
    return secp256k1.verify(concatBytes(r, s), h, hexToBytes(pubHex), { prehash: false, lowS: false });
  } catch { return false; }
}

// --- E2E Crypter (ECDH + AES-256-GCM) --------------------------------------

export class Crypter {
  constructor(keyBytes){ this.keyBytes = keyBytes; }                 // 32B AES-256 key
  static async fromECDH(myPriv, peerPub){
    const shared = secp256k1.getSharedSecret(myPriv, peerPub, true); // 33B [prefix||X]
    const x = shared.subarray(shared.length - 32);                   // 32B X coordinate
    return new Crypter(sha256(x));
  }
  async seal(plaintext){
    const nonce = (crypto || window.crypto).getRandomValues(new Uint8Array(12));
    const ct = gcm(this.keyBytes, nonce).encrypt(plaintext);        // ct || tag(16) — Go's gcm.Seal layout
    return concatBytes(nonce, ct);                                   // nonce(12) || ct || tag
  }
  async open(sealed){
    if (sealed.length < 12 + 16) throw new Error('ciphertext too short');
    const nonce = sealed.subarray(0, 12), ct = sealed.subarray(12);
    return gcm(this.keyBytes, nonce).decrypt(ct);                    // throws on tag mismatch
  }
}

// --- REST ------------------------------------------------------------------

let SEQOB = '/seqob';
export function setSeqobBase(base){ SEQOB = base || '/seqob'; }
export function seqobBase(){ return SEQOB; }

async function getJSON(path){
  const r = await fetch(SEQOB + path, { cache:'no-store' });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt }; }
  if (!r.ok) throw new Error((j && (j.message||j.error)) || j._raw || ('HTTP '+r.status));
  return j;
}
async function postJSON(path, body){
  const r = await fetch(SEQOB + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt }; }
  if (!r.ok) throw new Error((j && (j.message||j.error)) || j._raw || ('HTTP '+r.status));
  return j;
}

// Order book for a pair. Returns { pair, offers:[...] } with each offer carrying a
// `_verified` flag (maker signature checked locally; the relay is untrusted).
// opts.confidential requests the BLINDED book namespace (a distinct order set the
// relay keeps segregated from the transparent book); the default (omitted/false)
// is the transparent book, byte-identical to the live route.
// The relay marshals with protojson (server.go), which encodes proto `bytes` as BASE64. A
// CovenantTerms offer's byte fields (maker_prog, maker_x, internal_key, merkle_path) therefore
// arrive base64, but the wallet's canonical encoding (encodeCovenantTerms) hexToBytes()es them —
// so a relay-served covenant offer's signature NEVER verified (base64 decoded as hex). Convert
// those fields back to the wallet's hex convention at the fetch boundary. Scoped to covenant
// offers; cross/same-chain string fields and the base64 maker_sig are untouched.
function b64ToHex(s){
  if (typeof s !== 'string' || !s) return s;
  try { const b = b64decode(s); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }
  catch { return s; }
}
function normRelayOffer(o){
  const cov = o && (o.covenant || o.Covenant);
  if (cov){
    for (const k of ['maker_prog', 'makerProg', 'maker_x', 'makerX', 'internal_key', 'internalKey']){
      if (cov[k] != null) cov[k] = b64ToHex(cov[k]);
    }
    for (const k of ['merkle_path', 'merklePath']){
      if (Array.isArray(cov[k])) cov[k] = cov[k].map(b64ToHex);
    }
  }
  return o;
}
export async function fetchBook(baseAsset, quoteAsset, opts){
  const q = (opts && opts.confidential) ? '?confidential=1' : '';
  const j = await getJSON(`/v1/market/${baseAsset}/${quoteAsset}/orderbook${q}`);
  const offers = (j.offers || j.Offers || []).map(o => { normRelayOffer(o); return { ...o, _verified: verifyOffer(o) }; });
  return { pair: j.pair || { base_asset: baseAsset, quote_asset: quoteAsset }, offers };
}
export async function fetchMyOrders(makerPubkey){
  const j = await getJSON(`/v1/offers?maker_pubkey=${encodeURIComponent(makerPubkey)}`);
  return (j.offers || j.Offers || []).map(normRelayOffer);
}
export async function postOffer(offer){ return postJSON('/v1/offers', offer); }
export async function cancelOffer(cancel){ return postJSON('/v1/offers/cancel', cancel); }

// A covenant offer's CovenantTerms `bytes` fields are HEX in the signed object
// (so canonicalOfferBytes hashes the raw bytes exactly like the Go relay); the
// grpc-gateway JSON wants base64 for proto `bytes`. covenantOfferForPost returns
// a shallow copy safe to POST without disturbing the signed object.
function covenantOfferForPost(offer){
  const c = O(offer,'covenant'); if (!c) return offer;
  const b64 = (h) => b64encode(hexToBytes(h));
  const cc = { ...c };
  if (cc.maker_prog != null)   cc.maker_prog   = b64(cc.maker_prog);
  if (cc.maker_x != null)      cc.maker_x      = b64(cc.maker_x);
  if (cc.internal_key != null) cc.internal_key = b64(cc.internal_key);
  if (Array.isArray(cc.merkle_path)) cc.merkle_path = cc.merkle_path.map(b64);
  return { ...offer, covenant: cc };
}

// Sign (over the raw-bytes canonical form) then POST a covenant resting offer.
export async function postCovenantOffer(offer, priv){
  const signed = priv ? signOffer(offer, priv) : offer;
  return postJSON('/v1/offers', covenantOfferForPost(signed));
}

// Sign + post an OfferCancel for an offer the wallet made.
export async function signAndCancel(offerId, priv, nonce){
  const c = { offer_id: offerId, maker_pubkey: bytesToHex(secp256k1.getPublicKey(priv, true)), nonce: String(nonce ?? Math.floor(Date.now()/1000)) };
  // canonical cancel bytes = deterministic encoding with sig cleared: {offer_id=1, maker_pubkey=2, nonce=3}
  const w = new PW();
  w.str(1, c.offer_id); w.str(2, c.maker_pubkey); w.uint(3, c.nonce);
  const h = sha256(w.bytes());
  const compact = secp256k1.sign(h, priv, { prehash:false });
  c.sig = b64encode(derEncode(compact.subarray(0,32), compact.subarray(32,64)));
  return cancelOffer(c);
}

// --- WS lift (taker) -------------------------------------------------------

function wsURL(){
  // SEQOB is a same-origin path ('/seqob') or absolute http(s) URL.
  if (/^https?:\/\//.test(SEQOB)) return SEQOB.replace(/^http/, 'ws') + '/v1/ws';
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss' : 'ws';
  const host = (typeof location !== 'undefined') ? location.host : '';
  return `${proto}://${host}${SEQOB}/v1/ws`;
}

// Lift a resting offer to settlement.
//   offer       : the (verified) resting Offer from the book
//   takeAtoms   : base atoms to take (<= base_amount)
//   feeAsset    : taker fee asset hex (open fee market)
//   hooks.buildRequest(offer, takeAtoms, feeAsset) -> SwapRequest JSON (wasm)
//   hooks.finalizeAccept({id,transaction}) -> { transaction: <stripped signed PSET b64>, txid }
//   hooks.onStatus(msg)  (optional) progress callback
// Resolves to the settled txid.
export async function lift(offer, takeAtoms, feeAsset, hooks){
  const status = (m) => { try { hooks.onStatus && hooks.onStatus(m); } catch {} };
  const makerPubHex = O(offer,'maker_pubkey','makerPubkey');
  const offerId = O(offer,'offer_id','offerId');
  if (!makerPubHex || !offerId) throw new Error('offer missing maker_pubkey/offer_id');

  // Ephemeral taker session key (E2E only; distinct from any on-chain key).
  const sessPriv = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : crypto.getRandomValues(new Uint8Array(32));
  const sessPub = secp256k1.getPublicKey(sessPriv, true);

  const ws = new WebSocket(wsURL());
  ws.binaryType = 'arraybuffer';
  const inbox = [];
  let waiter = null;
  const pushIn = (msg) => { if (waiter){ const w = waiter; waiter = null; w.resolve(msg); } else inbox.push(msg); };
  const nextMsg = (timeoutMs) => new Promise((resolve, reject) => {
    if (inbox.length){ return resolve(inbox.shift()); }
    const w = { resolve, reject };
    waiter = w;
    // Bind the timeout to THIS waiter (w), not the shared `waiter`. A stale timeout from an already-
    // resolved earlier nextMsg used to fire later and null+reject whatever the CURRENT waiter was —
    // rejecting a fresh live wait with a spurious "timed out" (or orphaning it). `waiter === w` makes a
    // stale timeout a no-op.
    if (timeoutMs) setTimeout(() => { if (waiter === w){ waiter = null; reject(new Error('timed out waiting for the maker')); } }, timeoutMs);
  });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not reach the order-book relay'));
  });
  ws.onmessage = (ev) => { try { pushIn(JSON.parse(typeof ev.data === 'string' ? ev.data : td.decode(new Uint8Array(ev.data)))); } catch {} };
  ws.onclose = () => { if (waiter){ const w = waiter; waiter = null; w.reject(new Error('relay connection closed')); } };

  const send = (obj) => ws.send(JSON.stringify(obj));

  try {
    status('Opening lift…');
    send({ start_lift: {
      offer_id: offerId,
      maker_pubkey: makerPubHex,
      take_amount: String(takeAtoms),
      taker_fee_asset: feeAsset || '',
      taker_session_pubkey: b64encode(sessPub),
    }});

    // Await lift_accepted.
    let la = null;
    for (let n=0; n<8 && !la; n++){
      const m = await nextMsg(20000);
      if (m.error) throw new Error('relay: ' + (m.error.message || JSON.stringify(m.error)));
      if (m.lift_accepted || m.liftAccepted) la = m.lift_accepted || m.liftAccepted;
    }
    if (!la) throw new Error('relay did not accept the lift');

    // SECURITY: derive the E2E key from the SIGNED offer's maker pubkey, never the
    // relay echo. If the relay substituted a key the echo won't match — abort.
    const echo = la.maker_session_pubkey || la.makerSessionPubkey;
    if (echo && b64encode(hexToBytes(makerPubHex)) !== echo)
      throw new Error('relay returned a mismatched maker key (possible MITM); aborting');
    const crypter = await Crypter.fromECDH(sessPriv, hexToBytes(makerPubHex));
    const sessionId = la.session_id || la.sessionId;

    // Build + seal + courier the SwapRequest.
    status('Building your half of the swap…');
    const reqJson = await hooks.buildRequest(offer, takeAtoms, feeAsset);
    const sealedReq = await crypter.seal(encodeSwapRequest(reqJson));
    status('Sent to the maker; awaiting co-sign…');
    send({ swap_msg: { session_id: sessionId, ciphertext: b64encode(sealedReq) } });

    // Await the maker's sealed SwapAccept.
    let acc = null;
    for (let n=0; n<3 && !acc; n++){
      const m = await nextMsg(90000);
      if (m.error) throw new Error('maker: ' + (m.error.message || JSON.stringify(m.error)));
      const sm = m.swap_msg || m.swapMsg;
      if (sm && sm.ciphertext){
        const opened = await crypter.open(b64decode(sm.ciphertext));
        acc = decodeSwapAccept(opened);
      }
    }
    if (!acc || !acc.transaction) throw new Error('no co-signed swap returned by the maker');

    // Finalize + broadcast (host wasm), then courier the SwapComplete receipt.
    status('Signing and broadcasting…');
    const fin = await hooks.finalizeAccept(acc);
    const complete = encodeSwapComplete({ id: randHex(8), accept_id: acc.id, transaction: fin.transaction });
    try { send({ swap_msg: { session_id: sessionId, ciphertext: b64encode(await crypter.seal(complete)) } }); } catch {}
    return fin.txid;
  } finally {
    try { ws.close(); } catch {}
  }
}

// Watch-for-fill / live book: open a persistent relay WS, subscribe to a market,
// and dispatch the relay's stream. Two uses: (1) a covenant maker watches its rest
// fill (order_status) while offline-capable, and a taker settles on `matched`; (2)
// a live order book — the relay sends a `public_book` snapshot on subscribe, then
// `public_order_created` / `public_order_removed` deltas as the book changes, so a
// viewer can tick individual rows without polling. Snapshot + created offers are
// tagged `_verified` (maker signature checked locally; the relay is untrusted),
// exactly like fetchBook — the caller filters forged rows the same way.
//   markets : [{ base_asset, quote_asset }]  to subscribe (optional)
//   handlers: { onBook({pair,offers}), onOfferCreated(offer), onOfferRemoved(r),
//               onMatched(m), onOrderStatus(s), onError(e), onOpen(), onClose() }
// Returns { ws, subscribe(pair), close() }.
export function openRelay(markets, handlers){
  handlers = handlers || {};
  const ws = new WebSocket(wsURL());
  ws.binaryType = 'arraybuffer';
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  ws.onopen = () => {
    for (const m of (markets || [])) send({ market_subscribe: { base_asset: O(m,'base_asset','baseAsset'), quote_asset: O(m,'quote_asset','quoteAsset') } });
    try { handlers.onOpen && handlers.onOpen(); } catch {}
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : td.decode(new Uint8Array(ev.data))); } catch { return; }
    const book = m.public_book || m.publicBook;
    const created = m.public_order_created || m.publicOrderCreated;
    const matched = m.matched || m.Matched;
    const status = m.order_status || m.orderStatus;
    const removed = m.public_order_removed || m.publicOrderRemoved;
    if (book && handlers.onBook){
      const offers = (book.offers || book.Offers || []).map(o => ({ ...o, _verified: verifyOffer(o) }));
      try { handlers.onBook({ pair: book.pair || book.Pair || null, offers }); } catch {}
    }
    if (created && handlers.onOfferCreated){ try { handlers.onOfferCreated({ ...created, _verified: verifyOffer(created) }); } catch {} }
    if (matched && handlers.onMatched)         { try { handlers.onMatched(matched); } catch {} }
    if (status && handlers.onOrderStatus)      { try { handlers.onOrderStatus(status); } catch {} }
    if (removed && handlers.onOfferRemoved)    { try { handlers.onOfferRemoved(removed); } catch {} }
    if (m.error && handlers.onError)           { try { handlers.onError(m.error); } catch {} }
  };
  ws.onclose = () => { try { handlers.onClose && handlers.onClose(); } catch {} };
  ws.onerror = () => { try { handlers.onError && handlers.onError({ message: 'relay connection error' }); } catch {} };
  return {
    ws,
    subscribe: (pair) => send({ market_subscribe: { base_asset: O(pair,'base_asset','baseAsset'), quote_asset: O(pair,'quote_asset','quoteAsset') } }),
    // Post an offer over THIS WS (relay To.offer_submit = 102). A resulting match routes From.matched
    // back to this connection, so a taker crossing a resting covenant receives the terms + settles via
    // the onMatched handler. Used by the wallet taker path (takePeggedCovenant).
    post: (offer) => send({ offer_submit: offer }),
    close: () => { try { ws.close(); } catch {} },
  };
}

export function randHex(n){
  const a = new Uint8Array(n); (crypto || window.crypto).getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2,'0')).join('');
}

// Derive a stable maker identity key from wallet-provided entropy (so a posted
// offer survives reload and can be cancelled). seedHex must be high-entropy and
// wallet-private; we domain-separate so this never collides with on-chain keys.
export function makerKeyFromSeed(seedHex){
  const k = sha256(concatBytes(te.encode('seqob-maker-identity-v1'), hexToBytes(seedHex)));
  return k;   // 32-byte scalar (secp256k1 order space; sha256 output is a valid key w.h.p.)
}

// test surface
export const __test__ = { encodeSwapRequest, decodeSwapAccept, encodeSwapComplete, canonicalOfferBytes, encodeCovenantTerms, signOffer, verifyOffer, bytesToHex, hexToBytes, derEncode, derDecode };
