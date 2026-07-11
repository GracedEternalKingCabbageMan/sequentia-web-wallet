// SeqLN Tier-2 device-signer WS<->TCP relay (the "hosted-side WebSocket front").
//
// THE GAP this closes: a browser cannot open a raw TCP socket, but the device
// signer must connect OUT to the hosted proxy's Noise_XK responder
// (hsmd_proxy.c, SEQLN_SIGNER_LISTEN). The Noise handshake + the signer_frame
// codec are transport-AGNOSTIC opaque bytes over any duplex stream, so all that
// is missing is a byte pipe between the browser's WebSocket and the proxy's TCP
// listener. This relay IS that pipe.
//
//   browser device (SDK, wss client) === WebSocket ===>  [ this relay ]
//                                                              |
//                                                        raw TCP (opaque)
//                                                              v
//                                        hosted proxy  SEQLN_SIGNER_LISTEN (Noise responder)
//
// The relay is a DUMB, KEYLESS byte forwarder. The BOLT-8 Noise_XK handshake and
// every encrypted frame flow end-to-end browser<->proxy; the relay never sees a
// plaintext byte and holds no key. It forwards WebSocket payload bytes to TCP
// 1:1 and TCP bytes back as WebSocket binary frames, preserving order and byte
// count. WebSocket message boundaries are irrelevant: the app layer (Noise
// records, then the u32-LE signer frames) is self-delimiting, so a faithful
// in-order byte relay is all that is required.
//
// Zero npm dependencies: Node 22 ships no WebSocket *server*, so the minimal
// RFC 6455 server below is hand-rolled (accepts masked client frames, sends
// unmasked binary frames, answers ping, honours close). This keeps the relay a
// single self-contained file that runs fully offline.
//
// Usage:
//   node seqln-ws-relay.mjs --ws-port 18081 --tcp 127.0.0.1:19985 \
//        [--ws-host 127.0.0.1] [--tcp-retry-ms 20000] [--quiet]
//
// In production this role sits behind a normal TLS-terminating web server
// (nginx/Caddy `wss://`); this file is the reference implementation + the
// laptop-harness front. It is intentionally one connection-agnostic pipe.

import net from 'node:net';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const a = { wsHost: '127.0.0.1', wsPort: 18081, tcp: null, tcpRetryMs: 20000, quiet: false, pingMs: 15000, pongTimeoutMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--ws-port') a.wsPort = Number(argv[++i]);
    else if (k === '--ws-host') a.wsHost = argv[++i];
    else if (k === '--tcp') a.tcp = argv[++i];
    else if (k === '--tcp-retry-ms') a.tcpRetryMs = Number(argv[++i]);
    else if (k === '--ping-ms') a.pingMs = Number(argv[++i]);          // 0 disables keepalive
    else if (k === '--pong-timeout-ms') a.pongTimeoutMs = Number(argv[++i]);
    else if (k === '--quiet') a.quiet = true;
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else { console.error(`unknown arg: ${k}`); usage(); process.exit(2); }
  }
  if (!a.tcp || !a.tcp.includes(':')) { usage(); process.exit(2); }
  if (!a.pongTimeoutMs) a.pongTimeoutMs = a.pingMs ? a.pingMs * 2 : 0;
  return a;
}
function usage() {
  console.error('usage: node seqln-ws-relay.mjs --ws-port <p> --tcp <host:port>'
    + ' [--ws-host <h>] [--tcp-retry-ms <ms>] [--ping-ms <ms>] [--pong-timeout-ms <ms>] [--quiet]');
}
const args = parseArgs(process.argv.slice(2));
const [tcpHost, tcpPort] = (() => { const i = args.tcp.lastIndexOf(':'); return [args.tcp.slice(0, i), Number(args.tcp.slice(i + 1))]; })();
const log = (...m) => { if (!args.quiet) console.error('[relay]', ...m); };

// ---- RFC 6455 minimal server ----------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Encode one server->client frame (unmasked). opcode: 0x2 binary, 0x8 close,
// 0x9 ping, 0xA pong. Data frames are never fragmented here.
function encodeFrame(opcode, payload) {
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
// {opcode, payload} for every complete frame. Bytes that don't yet form a whole
// frame stay buffered.
class FrameDecoder {
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
function acceptUpgrade(req, socket) {
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

// ---- bridge one WS connection to a fresh TCP connection to the proxy --------
let connSeq = 0;
function bridge(wsSocket, req) {
  const id = ++connSeq;
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  log(`#${id} WebSocket up from ${peer}; dialing proxy ${tcpHost}:${tcpPort}`);

  const dec = new FrameDecoder();
  let tcp = null;
  let tcpReady = false;
  let pending = [];            // WS->proxy bytes buffered until the TCP dial lands
  let closed = false;
  let wsToTcp = 0, tcpToWs = 0;
  let lastAlive = Date.now();
  let keepalive = null;

  const wsSend = (opcode, payload) => { if (!wsSocket.destroyed) wsSocket.write(encodeFrame(opcode, payload)); };
  const shutdown = (why) => {
    if (closed) return; closed = true;
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    log(`#${id} closing (${why}); relayed ws->proxy ${wsToTcp}B, proxy->ws ${tcpToWs}B`);
    try { wsSend(0x8, Buffer.alloc(0)); } catch {}
    try { wsSocket.destroy(); } catch {}
    try { tcp?.destroy(); } catch {}
  };
  // Keepalive: detect a silently-dead ws (tab asleep / phone offline, no TCP RST)
  // and CLOSE our TCP to the proxy so it sees a clean EOF instead of a half-dead
  // ESTAB link that would wedge the hosted node. See ws-bridge.mjs for the why.
  if (args.pingMs > 0) {
    keepalive = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastAlive > args.pongTimeoutMs) {
        shutdown('ws keepalive timeout (device silent — likely tab asleep/offline)');
        return;
      }
      try { wsSend(0x9, Buffer.alloc(0)); } catch {}   // ping
    }, args.pingMs);
    if (keepalive.unref) keepalive.unref();
  }

  // Dial the proxy's Noise-responder TCP listener, retrying: lightningd may not
  // have exec'd the proxy (which binds at startup) by the time the device
  // connects. Fail closed after the retry budget.
  const deadline = Date.now() + args.tcpRetryMs;
  const dial = () => {
    const s = new net.Socket();
    s.once('error', () => {
      s.destroy();
      if (closed) return;
      if (Date.now() > deadline) { log(`#${id} proxy dial timed out`); shutdown('proxy unreachable'); return; }
      setTimeout(dial, 200);
    });
    s.connect(tcpPort, tcpHost, () => {
      s.removeAllListeners('error');
      s.setNoDelay(true);
      tcp = s; tcpReady = true;
      log(`#${id} proxy TCP up; splicing`);
      for (const b of pending) { tcp.write(b); wsToTcp += b.length; }
      pending = [];
      s.on('data', (d) => { tcpToWs += d.length; wsSend(0x2, d); });
      s.on('close', () => shutdown('proxy closed'));
      s.on('error', () => shutdown('proxy error'));
    });
  };
  dial();

  wsSocket.setNoDelay(true);
  wsSocket.on('data', (chunk) => {
    lastAlive = Date.now();   // ANY inbound ws frame proves the device is alive
    dec.push(chunk);
    for (const { opcode, payload } of dec.frames()) {
      if (opcode === 0x8) { shutdown('ws close'); return; }          // close
      if (opcode === 0x9) { wsSend(0xA, payload); continue; }        // ping->pong
      if (opcode === 0xA) { continue; }                              // pong: refresh only
      // data (binary 0x2 / text 0x1 / continuation 0x0): forward bytes as-is.
      if (tcpReady) { tcp.write(payload); wsToTcp += payload.length; }
      else { pending.push(payload); }
    }
  });
  wsSocket.on('close', () => shutdown('ws closed'));
  wsSocket.on('error', () => shutdown('ws error'));
}

// ---- listen ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Plain HTTP GET: a liveness probe so the harness can wait for readiness.
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('seqln-ws-relay: POST a WebSocket upgrade to bridge to '
    + `${tcpHost}:${tcpPort}\n`);
});
server.on('upgrade', (req, socket) => {
  if (acceptUpgrade(req, socket)) bridge(socket, req);
});
server.listen(args.wsPort, args.wsHost, () => {
  log(`listening ws://${args.wsHost}:${args.wsPort}  ->  tcp ${tcpHost}:${tcpPort}`
    + ` (Noise responder; relay is keyless)`);
});
server.on('error', (e) => { console.error('[relay] fatal:', e.message); process.exit(1); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
