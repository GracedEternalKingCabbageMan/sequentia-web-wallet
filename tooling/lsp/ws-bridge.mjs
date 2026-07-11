// Reusable, zero-dependency WebSocket<->TCP byte bridge (RFC 6455 server side).
//
// This is the byte-pipe that lets a browser device signer reach a hosted node's
// Noise_XK responder (hsmd_proxy, SEQLN_SIGNER_LISTEN, a raw TCP port a browser
// cannot open directly). The Noise handshake and the signer_frame codec are
// transport-agnostic opaque bytes, so a faithful in-order byte relay is all that
// is required; this module holds NO key and never sees a plaintext byte.
//
// It is the shared core behind two fronts:
//   * seqln-ws-relay.mjs  — a standalone per-node relay (one fixed TCP target).
//   * lsp-server.mjs       — the central ws-router: ONE endpoint
//       `GET /lsp-ws-node/<id>` (WebSocket upgrade) that looks the node up in the
//       provision registry and bridges to that node's Noise responder, so a SINGLE
//       static Caddy rule `wss://.../lsp-ws-node/*` reaches EVERY provisioned node
//       (no per-node Caddy edits, ever).
//
// Node 22 ships no WebSocket *server*, so the minimal RFC 6455 server is
// hand-rolled here: it accepts masked client frames, sends unmasked binary
// frames, answers ping, and honours close.

import net from 'node:net';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Encode one server->client frame (unmasked). opcode: 0x2 binary, 0x8 close,
// 0x9 ping, 0xA pong. Data frames are never fragmented here.
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// A streaming decoder for masked client frames. Feed it TCP chunks; it emits
// {opcode, payload} for every complete frame. Partial bytes stay buffered.
export class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]); }
  *frames() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      else { payload = Buffer.from(payload); }
      this.buf = b.subarray(off + len);
      yield { opcode, payload };
    }
  }
}

// Complete the HTTP Upgrade handshake on a raw socket, returning true on success.
export function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return false;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return true;
}

// Bridge one already-upgraded WebSocket (raw socket) to a FRESH TCP connection to
// `{ tcpHost, tcpPort }`, retrying the dial for up to `tcpRetryMs` (lightningd may
// not have exec'd the proxy that binds the responder yet). `log` is optional.
// Fail-closed: if the target never comes up, the WebSocket is closed.
//
// KEEPALIVE (funds-critical): a browser tab that sleeps or a phone that drops off
// the network severs the device's WebSocket WITHOUT a TCP RST — the OS never
// delivers a 'close'/'error', so this bridge would hold its proxy TCP ESTAB
// forever. The hosted proxy, blocked reading that now-silent link, then wedges
// the whole hosted node. To prevent that half-dead link we send a WebSocket PING
// every `pingMs` and shut the bridge down (closing the proxy TCP -> the proxy
// sees a clean EOF and awaits a reconnect) if no ws frame arrives within
// `pongTimeoutMs`. Set `pingMs = 0` to disable (used only to isolate the
// proxy-side recovery in tests).
export function bridgeWsToTcp(wsSocket, req, { tcpHost, tcpPort, tcpRetryMs = 20000, log = () => {}, id = 0, pingMs = 15000, pongTimeoutMs = 0 }) {
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  log(`#${id} WebSocket up from ${peer}; dialing ${tcpHost}:${tcpPort}`);
  if (!pongTimeoutMs) pongTimeoutMs = pingMs ? pingMs * 2 : 0;

  const dec = new FrameDecoder();
  let tcp = null, tcpReady = false, closed = false, wsToTcp = 0, tcpToWs = 0;
  let pending = [];
  let lastAlive = Date.now();
  let keepalive = null;

  const wsSend = (opcode, payload) => { if (!wsSocket.destroyed) wsSocket.write(encodeFrame(opcode, payload)); };
  const shutdown = (why) => {
    if (closed) return; closed = true;
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    log(`#${id} closing (${why}); relayed ws->tcp ${wsToTcp}B, tcp->ws ${tcpToWs}B`);
    try { wsSend(0x8, Buffer.alloc(0)); } catch {}
    try { wsSocket.destroy(); } catch {}
    try { tcp?.destroy(); } catch {}
  };
  if (pingMs > 0) {
    keepalive = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastAlive > pongTimeoutMs) {
        shutdown('ws keepalive timeout (device silent — likely tab asleep/offline)');
        return;
      }
      try { wsSend(0x9, Buffer.alloc(0)); } catch {}   // ping
    }, pingMs);
    if (keepalive.unref) keepalive.unref();
  }

  const deadline = Date.now() + tcpRetryMs;
  const dial = () => {
    const s = new net.Socket();
    s.once('error', () => {
      s.destroy();
      if (closed) return;
      if (Date.now() > deadline) { log(`#${id} target dial timed out`); shutdown('target unreachable'); return; }
      setTimeout(dial, 200);
    });
    s.connect(tcpPort, tcpHost, () => {
      s.removeAllListeners('error');
      s.setNoDelay(true);
      tcp = s; tcpReady = true;
      log(`#${id} target TCP up; splicing`);
      for (const b of pending) { tcp.write(b); wsToTcp += b.length; }
      pending = [];
      s.on('data', (d) => { tcpToWs += d.length; wsSend(0x2, d); });
      s.on('close', () => shutdown('target closed'));
      s.on('error', () => shutdown('target error'));
    });
  };
  dial();

  wsSocket.setNoDelay(true);
  wsSocket.on('data', (chunk) => {
    lastAlive = Date.now();   // ANY inbound ws frame proves the device is alive
    dec.push(chunk);
    for (const { opcode, payload } of dec.frames()) {
      if (opcode === 0x8) { shutdown('ws close'); return; }   // close
      if (opcode === 0x9) { wsSend(0xA, payload); continue; } // ping->pong
      if (opcode === 0xA) { continue; }                       // pong: refresh only
      if (tcpReady) { tcp.write(payload); wsToTcp += payload.length; }
      else { pending.push(payload); }
    }
  });
  wsSocket.on('close', () => shutdown('ws closed'));
  wsSocket.on('error', () => shutdown('ws error'));
}
