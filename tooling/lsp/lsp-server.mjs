// The hosted-SeqLN LSP HTTP service (Tier-2, "we run SeqLN for the user").
//
// The backend the wallet's Lightning module (seqln.js) commands. It is NOT
// custodial of the user's keys: the wallet's on-device wasm signer co-signs the
// hosted node's commitment updates over a wss Noise link, so the hosted node has
// no hsm_secret and this service can command routing but can never move the
// user's channel funds. It only tells the hosted node to take a pure-LN
// order-book offer via `seqob-cli xpln`.
//
//   POST /swap  {side:'buy'|'sell', asset, amount}
//        -> `seqob-cli xpln` against the hosted node's lightning-rpc; the two LN
//           legs settle on one preimage while the device signs each commitment
//           update; returns {preimage, amounts}.
//   GET  /status  -> both hosted nodes' ids + per-asset channel balances.
//   GET  /health  (no auth) -> {ok:true}
//
// Topology: the real cross-chain shape uses TWO hosted nodes — an asset node
// (holds the GOLD channel, Sequentia) and a BTC node (holds the BTC channel,
// testnet4 real BTC-LN). The two legs settle atomically on one preimage. A
// one-node stand-in (HOSTED_RPC alone) is still supported for backward compat.
//
// Auth: a single static bearer token (LSP_TOKEN). PRODUCTION: replace with
// per-wallet auth (a RUNE / signed challenge bound to the device pubkey).
//
// Deploy config (env; machine-specific paths are REQUIRED, no laptop defaults):
//   LSP_PORT, LSP_TOKEN
//   LNCLI              path to lightning-cli
//   HOSTED_ASSET_RPC   the asset (GOLD/Sequentia) hosted node's lightning-rpc
//   HOSTED_BTC_RPC     the BTC (testnet4) hosted node's lightning-rpc
//   HOSTED_RPC         fallback for BOTH of the above (one-node stand-in mode)
//   SEQOB_CLI          path to seqob-cli
//   RELAY              seqobd relay base URL (default http://127.0.0.1:9955)
//   GOLD               the tradeable asset id
//   BTCX               the BTC-leg asset id; UNSET/empty => real BTC-LN (-btc-asset "")
//
// The full laptop bring-up (keyless hosted node + WS relay + seqobd + LP maker +
// channels + a Node end-to-end proof through the wallet SDK) lives in the harness
// referenced by README.md.

import http from 'node:http';
import { execFile } from 'node:child_process';

function reqEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`[lsp] missing required env ${name}`); process.exit(2); }
  return v;
}

const hostedRpcFallback = process.env.HOSTED_RPC || '';
const CFG = {
  port: Number(process.env.LSP_PORT || 9981),
  token: process.env.LSP_TOKEN || 'devtoken-lsp',
  lncli: reqEnv('LNCLI'),
  // Real cross-chain: two hosted nodes. HOSTED_RPC is a one-node fallback for both.
  hostedAssetRpc: process.env.HOSTED_ASSET_RPC || hostedRpcFallback,
  hostedBtcRpc: process.env.HOSTED_BTC_RPC || hostedRpcFallback,
  seqobCli: reqEnv('SEQOB_CLI'),
  relay: process.env.RELAY || 'http://127.0.0.1:9955',
  gold: reqEnv('GOLD'),
  btcx: process.env.BTCX || '', // empty => real BTC-LN (seqob-cli -btc-asset "")
  swapTimeoutMs: Number(process.env.LSP_SWAP_TIMEOUT_MS || 150000),
};
if (!CFG.hostedAssetRpc || !CFG.hostedBtcRpc) {
  console.error('[lsp] missing hosted RPC: set HOSTED_ASSET_RPC + HOSTED_BTC_RPC (or HOSTED_RPC as a fallback for both)');
  process.exit(2);
}

const ASSET_ALIAS = { GOLD: CFG.gold, gold: CFG.gold, BTC: CFG.btcx };
function resolveAsset(a) {
  if (!a) return null;
  if (ASSET_ALIAS[a]) return ASSET_ALIAS[a];
  if (/^[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase();
  return null;
}
function assetLabel(id) {
  if (id === CFG.gold) return 'GOLD';
  if (id === CFG.btcx) return 'BTC';
  return id.slice(0, 8) + '…';
}

function lnrpc(method, args = [], rpc = CFG.hostedAssetRpc) {
  return new Promise((resolve, reject) => {
    execFile(CFG.lncli, [`--rpc-file=${rpc}`, method, ...args],
      { maxBuffer: 8 << 20 }, (err, stdout) => {
        if (err) return reject(new Error(`${method}: ${err.message}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${method}: bad json`)); }
      });
  });
}

async function nodeStatus(rpc, leg) {
  const info = await lnrpc('getinfo', [], rpc);
  let channels = [];
  try {
    const pc = await lnrpc('listpeerchannels', [], rpc);
    channels = (pc.channels || [])
      .filter((c) => String(c.state).startsWith('CHANNELD'))
      .map((c) => {
        const asset = c.channel_asset || c.asset || 'policy';
        const spendable = Math.round((c.spendable_msat ?? c.to_us_msat ?? 0) / 1000);
        const receivable = Math.round((c.receivable_msat
          ?? ((c.total_msat ?? 0) - (c.to_us_msat ?? 0))) / 1000);
        return {
          leg,
          peer_id: (c.peer_id || '').slice(0, 16),
          short_channel_id: c.short_channel_id || null,
          state: c.state, asset, asset_label: assetLabel(asset),
          spendable_units: spendable, receivable_units: receivable,
        };
      });
  } catch { /* pre-channel */ }
  return { id: info.id, alias: info.alias, network: info.network,
    blockheight: info.blockheight, channels };
}

async function status() {
  // Aggregate BOTH hosted nodes: the asset (GOLD) node and the BTC node.
  // In one-node fallback mode both sockets are identical and return the same data.
  const [assetNode, btcNode] = await Promise.all([
    nodeStatus(CFG.hostedAssetRpc, 'asset'),
    nodeStatus(CFG.hostedBtcRpc, 'btc'),
  ]);
  return {
    ok: true,
    asset_node: assetNode,
    btc_node: btcNode,
    channels: [...assetNode.channels, ...btcNode.channels], // merged, leg-tagged
  };
}

function runSwap({ side, asset, amount }) {
  return new Promise((resolve) => {
    const assetId = resolveAsset(asset);
    if (side !== 'buy' && side !== 'sell') return resolve({ ok: false, error: "side must be 'buy' or 'sell'" });
    if (!assetId) return resolve({ ok: false, error: 'unknown asset (want GOLD or a 32-byte hex id)' });
    const args = [
      'xpln', '-side', side, '-relay', CFG.relay,
      '-asset', assetId, '-btc-asset', CFG.btcx,
      '-asset-ln-socket', CFG.hostedAssetRpc, '-ln-socket', CFG.hostedBtcRpc,
      '-terms-wait', '60s', '-hold-wait', '90s',
    ];
    const t0 = Date.now();
    execFile(CFG.seqobCli, args, { timeout: CFG.swapTimeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const m = out.match(/PURE-LN SWAP SETTLED:\s+(bought|sold)\s+(\d+)\s+([0-9a-f]+)\s+for\s+(\d+)\s+BTC sats[^;]*;\s+preimage\s+([0-9a-f]+)/i);
      if (m) return resolve({
        ok: true, side, direction: m[1], asset: m[3], asset_label: assetLabel(m[3]),
        base_amount: Number(m[2]), quote_asset: CFG.btcx || 'BTC', quote_amount: Number(m[4]),
        preimage: m[5], finality: 'final', settled_ms: Date.now() - t0, requested_amount: amount ?? null,
      });
      resolve({ ok: false, error: err ? `swap failed: ${err.message}` : 'swap did not settle',
        detail: out.split('\n').filter(Boolean).slice(-6).join(' | '), settled_ms: Date.now() - t0 });
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
const authed = (req) => (req.headers['authorization'] || '') === `Bearer ${CFG.token}`;
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1 << 20) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve(null); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'seqln-lsp' });
  if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized (Bearer token required)' });
  try {
    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, await status());
    if (req.method === 'POST' && url.pathname === '/swap') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'bad json body' });
      const r = await runSwap(body);
      return send(res, r.ok ? 200 : 502, r);
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
server.listen(CFG.port, '127.0.0.1', () => {
  console.error(`[lsp] listening http://127.0.0.1:${CFG.port}  asset-rpc ${CFG.hostedAssetRpc}  btc-rpc ${CFG.hostedBtcRpc}  relay ${CFG.relay}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
