// SeqLN Tier-2 wallet device-signer SDK.
//
// One clean class a browser (or Node) wallet UI drives to turn an on-device
// mnemonic into a live, non-custodial signer for a HOSTED SeqLN node. The wallet
// never ships keys off the device: this SDK holds the mnemonic-derived signer in
// wasm, connects OUT over a (W)WebSocket to the hosted node's Noise_XK responder
// (behind the WS<->TCP relay), authenticates with BOLT-8 Noise_XK, and then
// SERVES the hosted lightningd's stream of hsmd sign-requests for the life of
// the connection. The host can never move the user's funds; it only asks the
// device to co-sign, and (in enforce mode) the device refuses theft-shaped
// requests.
//
//   const s = await SeqlnSigner.fromMnemonic(mnemonic);   // wasm signer on device
//   s.onStatus  = (st)  => render(st);                    // connecting/serving/...
//   s.onRequest = (req) => appendLog(req);                // per hsmd sign request
//   await s.connect({ wsUrl, hostStaticPubkey, deviceStaticPrivkey });
//   console.log('node id', s.nodeId());                   // derived over the link
//   ...
//   s.disconnect();
//
// Dependency-light by construction: the ONLY runtime deps are the browser
// globals `WebSocket` and `crypto.getRandomValues` (both also global in Node 22,
// so this same file is the Node harness shim) and the wasm module. No npm, no
// framework, pure ESM, Uint8Array throughout (no Node Buffer).
//
// The wasm module is the `wasm-pack --target web` build in ../web/pkg. Its glue
// initialises from a fetched URL (browser default) or from injected bytes
// (Node): pass `{ wasm }` to `fromMnemonic` to override the source.

import initWasm, { Signer, NoiseSession, devicePubkey } from './pkg/seqln_signer_wasm.js';

// ---- one-time wasm init ---------------------------------------------------
let _wasmReady = null;
// `source`: undefined => browser default (fetch bg.wasm next to the glue);
// a URL/string => fetched; a BufferSource/Response/WebAssembly.Module => used
// directly (this is the Node path: pass the .wasm bytes).
export function ensureWasm(source) {
  if (!_wasmReady) _wasmReady = initWasm(source === undefined ? undefined : { module_or_path: source });
  return _wasmReady;
}

// ---- tiny byte helpers (browser-safe; no Buffer) --------------------------
function hexToBytes(h) {
  if (h instanceof Uint8Array) return h;
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2) throw new Error('odd-length hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function rand32() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);   // global in browsers and Node 22+
  return b;
}
function asBytes(data) {
  // Normalise a WebSocket message payload to a Uint8Array (browser + Node give
  // ArrayBuffer when binaryType === 'arraybuffer'; tolerate Blob-less paths).
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('unexpected non-binary WebSocket frame');
}

// hsmd request type names (from hsmd/hsmd_wire.csv), for a readable UI log.
// Unknown types render as `type N`.
const HSMD_NAMES = {
  1: 'ECDH', 2: 'CANNOUNCEMENT_SIG', 3: 'CUPDATE_SIG', 6: 'NODE_ANNOUNCEMENT_SIG',
  5: 'SIGN_COMMITMENT_TX', 7: 'SIGN_WITHDRAWAL', 8: 'SIGN_INVOICE',
  9: 'CLIENT_HSMFD', 10: 'GET_CHANNEL_BASEPOINTS', 11: 'INIT', 56: 'CHECK_BIP86_PUBKEY',
  12: 'SIGN_DELAYED_PAYMENT_TO_US', 13: 'SIGN_REMOTE_HTLC_TO_US', 14: 'SIGN_PENALTY_TO_US',
  18: 'GET_PER_COMMITMENT_POINT', 19: 'SIGN_REMOTE_COMMITMENT_TX', 20: 'SIGN_REMOTE_HTLC_TX',
  21: 'SIGN_MUTUAL_CLOSE_TX', 22: 'CHECK_FUTURE_SECRET', 24: 'GET_OUTPUT_SCRIPTPUBKEY',
  27: 'DERIVE_SECRET', 28: 'CHECK_PUBKEY', 30: 'NEW_CHANNEL', 31: 'SETUP_CHANNEL',
  32: 'CHECK_OUTPOINT', 34: 'FORGET_CHANNEL', 35: 'VALIDATE_COMMITMENT_TX',
  36: 'VALIDATE_REVOCATION', 37: 'LOCK_OUTPOINT', 40: 'REVOKE_COMMITMENT_TX',
  142: 'SIGN_ANY_DELAYED_PAYMENT_TO_US', 143: 'SIGN_ANY_REMOTE_HTLC_TO_US',
  144: 'SIGN_ANY_PENALTY_TO_US',
};
function hsmdName(t) { return HSMD_NAMES[t] || `type ${t}`; }

// hsmd request type out of a signer-split frame:
//   u32-LE len | u8 is_main | [33B node_id if !is_main] | u64 dbid | u64 caps | u16 hsmd_type ...
function frameHsmdType(frame) {
  const isMain = frame[4];
  const off = 4 + 1 + (isMain ? 0 : 33) + 8 + 8;
  if (frame.length < off + 2) return -1;
  return (frame[off] << 8) | frame[off + 1];
}

// node_id out of a WIRE_HSMD_INIT_REPLY_V4 framed reply:
//   [u32 len] u16 type(114) u32 hsm_version u16 num_caps caps(4*n) node_id(33) ...
function nodeIdFromInitReply(framed) {
  if (framed.length < 4 + 8) return null;
  const dv = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  if (dv.getUint16(4, false) !== 114) return null;         // 114 = INIT_REPLY_V4
  const numCaps = dv.getUint16(4 + 6, false);
  const off = 4 + 2 + 4 + 2 + 4 * numCaps;
  if (framed.length < off + 33) return null;
  return bytesToHex(framed.subarray(off, off + 33));
}

// ---------------------------------------------------------------------------
export class SeqlnSigner {
  constructor(inner, opts = {}) {
    this._inner = inner;              // wasm Signer
    this._devicePriv = null;
    this._devicePub = null;
    this._nodeId = null;
    this._ws = null;
    this._noise = null;
    this._served = new Map();         // hsmd type -> count
    this._state = 'idle';
    this._closeErr = null;
    // UI hooks (assignable): onStatus({state,detail,nodeId,devicePubkey}),
    // onRequest({seq,type,name,replyBytes,rejected}).
    this.onStatus = opts.onStatus || null;
    this.onRequest = opts.onRequest || null;
  }

  // Build from a BIP-39 mnemonic (no passphrase). `opts.wasm` overrides the wasm
  // source (Node: pass the .wasm bytes; browser: omit).
  static async fromMnemonic(mnemonic, opts = {}) {
    await ensureWasm(opts.wasm);
    return new SeqlnSigner(Signer.fromMnemonic(mnemonic.trim()), opts);
  }
  // Build from raw hsm_secret bytes (the on-disk `32 zero bytes || mnemonic`).
  static async fromHsmSecret(bytes, opts = {}) {
    await ensureWasm(opts.wasm);
    return new SeqlnSigner(new Signer(hexToBytes(bytes)), opts);
  }
  // Compute the transport pubkey a host must pin for a given device privkey,
  // without constructing a signer (handy for provisioning UIs).
  static async devicePubkey(privkey, opts = {}) {
    await ensureWasm(opts.wasm);
    return bytesToHex(devicePubkey(hexToBytes(privkey)));
  }

  // enforce | permissive (M4 validating policy).
  setPolicy(mode) { this._inner.setEnforce(mode === 'enforce'); return this; }

  nodeId() { return this._nodeId; }
  devicePubkeyHex() { return this._devicePub; }
  servedCounts() { return new Map(this._served); }
  state() { return this._state; }

  _status(state, detail) {
    this._state = state;
    if (this.onStatus) {
      try { this.onStatus({ state, detail, nodeId: this._nodeId, devicePubkey: this._devicePub }); } catch {}
    }
  }

  // Open the WebSocket, run the Noise_XK INITIATOR handshake, and kick off the
  // signer serve loop. Resolves once authenticated + serving (the node id
  // arrives shortly after, on the first INIT, via nodeId()/onStatus). Rejects if
  // the WebSocket, handshake, or host/device key check fails.
  async connect({ wsUrl, hostStaticPubkey, deviceStaticPrivkey, openTimeoutMs = 15000 }) {
    if (this._ws) throw new Error('already connected');
    this._devicePriv = hexToBytes(deviceStaticPrivkey);
    const hostPub = hexToBytes(hostStaticPubkey);
    this._devicePub = bytesToHex(devicePubkey(this._devicePriv));

    // --- open the socket ---
    this._status('connecting', wsUrl);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    // Byte-stream reader over discrete WS messages (relay/network may coalesce
    // or split; the app framing is self-delimiting, so we buffer + readExact).
    let inbuf = new Uint8Array(0);
    let wake = null;
    let closed = false;
    const onData = (bytes) => { inbuf = concat(inbuf, bytes); if (wake) { const w = wake; wake = null; w(); } };
    const wakeAll = () => { if (wake) { const w = wake; wake = null; w(); } };
    const readExact = async (n) => {
      while (inbuf.length < n) {
        if (closed) throw new Error(this._closeErr || 'link closed');
        await new Promise((r) => { wake = r; });
      }
      const out = inbuf.subarray(0, n);
      inbuf = inbuf.subarray(n);
      return out;
    };

    ws.onmessage = (ev) => onData(asBytes(ev.data));
    ws.onclose = () => { closed = true; wakeAll(); if (this._state !== 'closed' && this._state !== 'error') this._status('closed', 'link closed'); };
    ws.onerror = () => { this._closeErr = this._closeErr || 'websocket error'; };

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('websocket open timeout')), openTimeoutMs);
      ws.onopen = () => { clearTimeout(t); res(); };
      const prevErr = ws.onerror;
      ws.onerror = (e) => { if (prevErr) prevErr(e); if (this._state === 'connecting') { clearTimeout(t); rej(new Error('websocket connect failed')); } };
    });

    // --- BOLT-8 Noise_XK handshake as INITIATOR ---
    this._status('handshaking', 'Noise_XK act one');
    const noise = NoiseSession.newInitiator(hostPub, this._devicePriv, rand32());
    this._noise = noise;
    ws.send(noise.writeActOne());                 // 50 bytes
    let act2;
    try {
      act2 = await readExact(50);
    } catch (e) {
      // No act two: the responder rejected our act one (wrong host key baked
      // into it, or the responder is unreachable) and sent nothing back.
      this._status('error', 'no act two (handshake rejected: wrong host key or responder unreachable)');
      throw new Error('handshake failed before act two: ' + e.message);
    }
    let act3;
    try {
      act3 = noise.readActTwo(act2);              // throws if the host key is wrong
    } catch (e) {
      this._status('error', 'host authentication failed (wrong host key)');
      throw new Error('Noise_XK host auth failed: ' + (e.message || e));
    }
    ws.send(act3);                                // 66 bytes
    this._status('authenticated', 'Noise_XK complete; serving sign requests');

    // --- serve the signer-split frames over the encrypted stream ---
    let plain = new Uint8Array(0);
    const refill = async () => {
      const hdr = await readExact(18);
      const bodyLen = noise.decryptHeader(hdr);
      const body = await readExact(bodyLen + 16);
      plain = concat(plain, noise.decryptBody(body));
    };
    const readU32LE = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    let seq = 0;

    this._serveLoop = (async () => {
      try {
        for (;;) {
          while (plain.length < 4) await refill();
          const flen = readU32LE(plain, 0);
          while (plain.length < 4 + flen) await refill();
          const frame = plain.subarray(0, 4 + flen);
          plain = plain.subarray(4 + flen);

          const type = frameHsmdType(frame);
          this._served.set(type, (this._served.get(type) || 0) + 1);

          const reply = this._inner.processFrame(frame);   // wasm signs
          if (this._nodeId === null) {
            const id = nodeIdFromInitReply(reply);
            if (id) { this._nodeId = id; this._status('node_id', id); }
          }
          seq += 1;
          if (this.onRequest) {
            try {
              this.onRequest({ seq, type, name: hsmdName(type), replyBytes: reply.length - 4, rejected: reply.length === 4 });
            } catch {}
          }
          ws.send(noise.encrypt(reply));
          if (closed) break;
        }
      } catch (e) {
        if (!closed) { this._closeErr = e.message; this._status('error', e.message); }
        try { ws.close(); } catch {}
      }
    })();
  }

  // Block until the node id is known (first INIT served) or the link ends.
  async whenNodeId(timeoutMs = 20000) {
    const start = Date.now();
    while (this._nodeId === null) {
      if (this._state === 'closed' || this._state === 'error') throw new Error(this._closeErr || 'link ended before INIT');
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for node id');
      await new Promise((r) => setTimeout(r, 50));
    }
    return this._nodeId;
  }

  disconnect() {
    this._status('closed', 'disconnect()');
    try { this._ws?.close(); } catch {}
    this._ws = null;
  }
}

export default SeqlnSigner;
