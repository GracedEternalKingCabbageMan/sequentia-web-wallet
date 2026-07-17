// ---------------------------------------------------------------------------
// xcourier.js — CROSS-CHAIN (BTC <-> Sequentia asset) courier client for the
// SeqOB order book. This is the transport that replaces the RFQ daemon's
// /v1/xchain/* HTTP calls: it carries the HTLC-lift handshake messages (the
// XcMsg tagged union) as opaque E2E-sealed payloads inside the same WS courier
// the same-chain lift() uses. The relay only ever moves sealed bytes.
//
// The messages are JSON (not protobuf), byte-for-byte the shape of the Go
// daemon's internal/seqob/client/xcourier.go XcMsg: same "type" tags, same
// snake_case field names. XcMsg is sealed, never signed, so key order and
// omitting zero-value fields are both free (unlike the Offer, which is signed).
//
// This module is the pure TRANSPORT: the codec + a CourierSession with sealed
// send / typed recv (skip-unknown, surface XcFail), mirroring the Go
// recvXcType. The forward/reverse settlement (fund the BTC leg, verify + anchor
// -gate the SEQ leg, claim revealing the secret, refunds) stays in the wallet's
// existing client-side primitives (xswap.js / xrswap.js + the leg bridges); a
// driver wires those to a CourierSession in place of the RFQ round-trips.
// ---------------------------------------------------------------------------

import { secp256k1 } from './btc.js';
import { Crypter, hexToBytes, bytesToHex, seqobBase } from './seqob.js';

const te = new TextEncoder();
const td = new TextDecoder();

function b64encode(bytes){ let s=''; for (let i=0;i<bytes.length;i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function b64decode(b64){ const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }

// XcType mirrors the Go XcMsgType constants (xcourier.go:36-45).
export const XcType = Object.freeze({
  TermsRequest:   'terms_request',
  Terms:          'terms',            // forward: maker's per-lift terms
  BtcLegFunded:   'btc_leg_funded',   // forward: taker funded the BTC leg
  SeqLegLocked:   'seq_leg_locked',   // forward: maker locked the SEQ leg
  BtcLegLocked:   'btc_leg_locked',   // reverse: maker locked the BTC leg
  SeqLegFunded:   'seq_leg_funded',   // reverse: taker funded the SEQ leg
  SecretRevealed: 'secret_revealed',  // reverse: maker reveals s after claiming SEQ
  Fail:           'fail',
});

// encodeXcMsg serializes an XcMsg to sealable bytes. Undefined/null/empty-string
// fields are dropped so a message carries only what its type sets (matching the
// Go omitempty tags); the Go side unmarshals leniently regardless.
export function encodeXcMsg(m){
  const out = {};
  for (const [k, v] of Object.entries(m)){
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return te.encode(JSON.stringify(out));
}

export function decodeXcMsg(bytes){
  return JSON.parse(td.decode(bytes));
}

// failMsg builds an XcFail (a courier abort note).
export function failMsg(code, message){ return { type: XcType.Fail, code, message }; }

// CourierSession wraps an established E2E channel (a Crypter + relay session id)
// over a transport, exposing sealed send / typed recv. The transport is
// injectable so the handshake logic is unit-testable without a real WebSocket:
//   transport.send(envelope)              -> deliver a JSON WS envelope
//   transport.recv(timeoutMs) -> Promise  -> next inbound JSON WS envelope
//   transport.close()                     -> optional
export class CourierSession {
  constructor(crypter, sessionId, transport){
    this.crypter = crypter;
    this.sessionId = sessionId;
    this.transport = transport;
  }

  // send seals an XcMsg and couriers it as a swap_msg for this session.
  async send(xcmsg){
    const sealed = await this.crypter.seal(encodeXcMsg(xcmsg));
    this.transport.send({ swap_msg: { session_id: this.sessionId, ciphertext: b64encode(sealed) } });
  }

  // recv returns the next XcMsg of type wantType, skipping unknown/out-of-order
  // messages (the courier is at-least-once-ish and a peer may add courtesy
  // messages). Throws on an XcFail from the peer or on timeout. Mirrors the Go
  // recvXcType.
  async recv(wantType, timeoutMs){
    const deadline = Date.now() + (timeoutMs || 120000);
    for (;;){
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for "' + wantType + '"');
      const env = await this.transport.recv(remaining);
      if (env == null) continue;
      if (env.error) throw new Error('relay: ' + (env.error.message || JSON.stringify(env.error)));
      const sm = env.swap_msg || env.swapMsg;
      if (!sm || !sm.ciphertext) continue;
      let xc;
      try {
        xc = decodeXcMsg(await this.crypter.open(b64decode(sm.ciphertext)));
      } catch {
        // Undecryptable frame: relay noise/injection at most; skip (the deadline
        // bounds the loop), matching the Go driver's continue-on-open-failure.
        continue;
      }
      if (xc.type === wantType) return xc;
      if (xc.type === XcType.Fail) throw new Error('peer failed the lift: ' + (xc.code || '') + ' ' + (xc.message || ''));
      // otherwise skip and keep waiting
    }
  }

  async fail(code, message){ try { await this.send(failMsg(code, message)); } catch {} }
  close(){ try { this.transport && this.transport.close && this.transport.close(); } catch {} }
}

function wsURL(){
  const base = seqobBase();
  if (/^https?:\/\//i.test(base)){
    return base.replace(/^http/i, 'ws').replace(/\/$/, '') + '/v1/ws';
  }
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss' : 'ws';
  const origin = (typeof location !== 'undefined') ? (proto + '://' + location.host) : ('ws://127.0.0.1');
  return origin + (base.startsWith('/') ? base : '/' + base).replace(/\/$/, '') + '/v1/ws';
}

// wsTransport adapts a WebSocket to the CourierSession transport interface,
// queuing inbound JSON envelopes for recv().
function wsTransport(ws){
  const inbox = [];
  let waiter = null;
  const push = (m) => { if (waiter){ const w = waiter; waiter = null; w.resolve(m); } else inbox.push(m); };
  ws.onmessage = (ev) => { try { push(JSON.parse(typeof ev.data === 'string' ? ev.data : td.decode(new Uint8Array(ev.data)))); } catch {} };
  ws.onclose = () => { if (waiter){ const w = waiter; waiter = null; w.reject(new Error('relay connection closed')); } };
  return {
    send: (obj) => ws.send(JSON.stringify(obj)),
    recv: (timeoutMs) => new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      waiter = { resolve, reject };
      if (timeoutMs) setTimeout(() => { if (waiter){ waiter = null; reject(new Error('courier timed out')); } }, timeoutMs);
    }),
    close: () => { try { ws.close(); } catch {} },
    _ws: ws,
  };
}

// openCourierSession opens a lift over the WS relay and returns a live
// CourierSession bound to the maker via ECDH over the SIGNED offer's pubkey.
// The relay's echoed maker_session_pubkey is cross-checked (never trusted) so a
// key-substituting relay can only deny service, matching seqob.lift().
//   offer     : the VERIFIED resting cross offer from the book
//   takeAtoms : base atoms to take (whole-HTLC: the offer's base_amount)
//   feeAsset  : taker fee asset hex ('' for default)
export async function openCourierSession(offer, takeAtoms, feeAsset, opts){
  opts = opts || {};
  const makerPubHex = offer.maker_pubkey || offer.makerPubkey;
  const offerId = offer.offer_id || offer.offerId;
  if (!makerPubHex || !offerId) throw new Error('offer missing maker_pubkey/offer_id');

  const sessPriv = opts.sessPriv ||
    (secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : crypto.getRandomValues(new Uint8Array(32)));
  const sessPub = secp256k1.getPublicKey(sessPriv, true);

  const ws = new WebSocket(wsURL());
  ws.binaryType = 'arraybuffer';
  const t = wsTransport(ws);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not reach the order-book relay'));
  });

  // Once the socket is open, close it on ANY error path — a rejected/mismatched lift used to leak the
  // WebSocket, and the retry-down-the-book loop multiplies that by the candidate count per take.
  try {
    t.send({ start_lift: {
      offer_id: offerId,
      maker_pubkey: makerPubHex,
      take_amount: String(takeAtoms),
      taker_fee_asset: feeAsset || '',
      taker_session_pubkey: b64encode(sessPub),
    }});

    let la = null;
    for (let n = 0; n < 8 && !la; n++){
      const m = await t.recv(20000);
      if (m && m.error) throw new Error('relay: ' + (m.error.message || JSON.stringify(m.error)));
      if (m && (m.lift_accepted || m.liftAccepted)) la = m.lift_accepted || m.liftAccepted;
    }
    if (!la) throw new Error('relay did not accept the lift');

    const echo = la.maker_session_pubkey || la.makerSessionPubkey;
    if (echo && b64encode(hexToBytes(makerPubHex)) !== echo)
      throw new Error('relay returned a mismatched maker key (possible MITM); aborting');

    const crypter = await Crypter.fromECDH(sessPriv, hexToBytes(makerPubHex));
    const sessionId = la.session_id || la.sessionId;
    return new CourierSession(crypter, sessionId, t);
  } catch (e){
    try { ws.close(); } catch {}
    throw e;
  }
}

// ---------------------------------------------------------------------------
// MAKER side: openMakerListener registers a signed cross offer on the relay and
// serves incoming lifts. This is the inverse of openCourierSession: instead of
// sending start_lift and awaiting lift_accepted (taker), the maker sends
// offer_submit (To field 102) to rest the offer AND register this WS as its lift
// route, then handles From frames — lift_requested (143: a taker lifted; carries
// taker_session_pubkey) and swap_msg (131: sealed courier passthrough). The
// maker's per-session E2E key is ECDH(makerOfferPriv, taker_session_pubkey),
// symmetric with the taker's ECDH(sessPriv, makerOfferPubkey), so Crypter is
// reused unchanged. Mirrors the Go seqob-maker serveCross loop (cmd/seqob-maker
// /main.go). Single-lift-at-a-time (whole-HTLC, no partials): a second concurrent
// lift is refused with XcFail{busy}, matching the daemon.
//   signedOffer : the SIGNED cross offer object (its maker_pubkey must match makerPriv)
//   makerPriv   : the maker offer private key (Uint8Array/hex) used to sign the offer
//   onLift(session, lift) : async; runs the maker settlement driver for one lift.
//                           lift = { sessionId, offerId, takeAmount (BigInt) }.
//   opts.ws     : inject a transport for tests (else a real WebSocket to the relay)
// Returns { close(), resubmit(offer), activeCount() }.
export async function openMakerListener(signedOffer, makerPriv, onLift, opts){
  opts = opts || {};
  const priv = typeof makerPriv === 'string' ? hexToBytes(makerPriv) : makerPriv;
  const ws = opts.ws || new WebSocket(wsURL());
  if (!opts.ws) ws.binaryType = 'arraybuffer';

  const sessions = new Map();   // sessionId -> { push(env), fail(err) }
  let closed = false;
  let inFlight = 0;             // single-lift-at-a-time guard (whole-HTLC)

  const send = (obj) => ws.send(JSON.stringify(obj));

  async function handleLift(lr){
    const sessionId = lr.session_id || lr.sessionId;
    const takerPubB64 = lr.taker_session_pubkey || lr.takerSessionPubkey;
    if (!sessionId || !takerPubB64 || sessions.has(sessionId)) return;

    const crypter = await Crypter.fromECDH(priv, b64decode(takerPubB64));
    const inbox = []; let waiter = null;
    const push = (env) => { if (waiter){ const w = waiter; waiter = null; w.resolve(env); } else inbox.push(env); };
    const fail = (err) => { if (waiter){ const w = waiter; waiter = null; w.reject(err); } };
    const transport = {
      send,
      recv: (timeoutMs) => new Promise((resolve, reject) => {
        if (inbox.length) return resolve(inbox.shift());
        waiter = { resolve, reject };
        if (timeoutMs) setTimeout(() => { if (waiter){ waiter = null; reject(new Error('courier timed out')); } }, timeoutMs);
      }),
      close: () => {},   // per-session close is a no-op; the listener owns the shared ws
    };
    sessions.set(sessionId, { push, fail });
    const session = new CourierSession(crypter, sessionId, transport);

    // Whole-HTLC: refuse a second concurrent lift rather than half-serve it.
    if (inFlight > 0){ try { await session.fail('busy', 'maker is settling another lift'); } catch {} sessions.delete(sessionId); return; }
    inFlight++;
    try {
      await onLift(session, {
        sessionId,
        offerId: lr.offer_id || lr.offerId,
        takeAmount: BigInt(lr.take_amount || lr.takeAmount || 0),
      });
    } catch (e){
      try { await session.fail('maker_error', (e && e.message) || String(e)); } catch {}
    } finally {
      inFlight--; sessions.delete(sessionId);
    }
  }

  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : td.decode(new Uint8Array(ev.data))); } catch { return; }
    if (m.error) return;   // GenericError; ignore (offer_submit rejections surface via no lifts)
    const lr = m.lift_requested || m.liftRequested;
    if (lr){ handleLift(lr).catch(() => {}); return; }
    const sm = m.swap_msg || m.swapMsg;
    if (sm && (sm.session_id || sm.sessionId)){
      const s = sessions.get(sm.session_id || sm.sessionId);
      if (s) s.push(m);
      return;
    }
    // public_book / order_status / market_list frames are ignored by the maker loop.
  };
  ws.onclose = () => { closed = true; for (const s of sessions.values()) s.fail(new Error('relay connection closed')); };

  if (!opts.ws){
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not reach the order-book relay')); });
  }
  // Rest the offer + register as its lift route.
  send({ offer_submit: signedOffer });

  return {
    close: () => { closed = true; try { ws.close(); } catch {} },
    resubmit: (offer) => { if (!closed) send({ offer_submit: offer || signedOffer }); },
    activeCount: () => sessions.size,
    _ws: ws,
  };
}

export const __test__ = { encodeXcMsg, decodeXcMsg, failMsg, XcType, CourierSession, b64encode, b64decode, openMakerListener };
