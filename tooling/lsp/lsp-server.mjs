// The hosted-SeqLN LSP HTTP service (Tier-2, "we run SeqLN for the user").
//
// The backend the wallet's Lightning module (seqln.js) commands. It is NOT
// custodial of the user's keys: the wallet's on-device wasm signer co-signs the
// hosted node's commitment updates over a wss Noise link, so the hosted node has
// no hsm_secret and this service can command routing but can never move the
// user's channel funds. It only tells the hosted node to take a pure-LN
// order-book offer via `seqob-cli xpln`.
//
//   POST /swap  {side:'buy'|'sell', asset, amount, payRail?, recvRail?}
//        payRail/recvRail each 'ln' | 'chain' (default ln/ln):
//          • ln  + ln    -> `seqob-cli xpln` (pure-LN, both legs Lightning). The two
//            LN legs settle on one preimage while the device signs each commitment
//            update; returns {preimage, amounts, finality:'final'}. UNCHANGED.
//          • MIXED (one leg 'ln', one 'chain') -> a SUBMARINE swap: the asset leg is
//            an anchored on-chain HTLC, the BTC leg is Lightning, bound by one
//            preimage. Dispatched to `seqob-cli xsubbuy` (buy the asset with BTC-LN,
//            receive it on-chain) or `xsublift` (sell the asset on-chain, receive
//            BTC-LN). Anchor-gated: it returns finality:'confirming' (anchor-bound to
//            Bitcoin), NOT the pure-LN instant-'final'. Only the asset-on-chain <->
//            BTC-Lightning combos map to the deployed binaries.
//          • chain + chain -> handled by the wallet's own on-chain rail (the SeqOB
//            order book), NOT the LSP: the browser runs that path directly.
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
//   --- MIXED (submarine) rail only ---
//   SEQ_RPC            Sequentia node RPC http://user:pass@host:port WITH -txindex,
//                      for the on-chain asset leg (fund/claim + BlockHashOfTx). REQUIRED
//                      for the mixed rail; if unset, mixed swaps return "not configured".
//   SEQ_WALLET         the hosted Sequentia node wallet for the on-chain leg (receives
//                      the asset on a buy; funds/holds it on a sell).
//   MIXED_BTC_RPC      the BTC-LN lightning-rpc for the submarine's Lightning leg
//                      (default: HOSTED_BTC_RPC, i.e. the device-cosigned hosted node).
//   MIN_ANCHOR_DEPTH   Bitcoin-anchor depth the taker requires before it pays (default 2).
//   LSP_MIXED_TIMEOUT_MS  max wall-clock for a mixed swap incl. the anchor gate
//                      (default 2_700_000 = 45 min; the gate is several Bitcoin blocks).
//
// The full laptop bring-up (keyless hosted node + WS relay + seqobd + LP maker +
// channels + a Node end-to-end proof through the wallet SDK) lives in the harness
// referenced by README.md.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  // Mixed (submarine) rail: the on-chain asset leg needs a txindex Sequentia node.
  seqRpc: process.env.SEQ_RPC || '',
  seqWallet: process.env.SEQ_WALLET || '',
  // The submarine's Lightning leg. Default: the device-cosigned hosted BTC node (so a
  // mixed swap stays non-custodial like pure-LN); overridable to an autonomous node.
  mixedBtcRpc: process.env.MIXED_BTC_RPC || process.env.HOSTED_BTC_RPC || hostedRpcFallback,
  minAnchorDepth: Number(process.env.MIN_ANCHOR_DEPTH || 2),
  mixedTimeoutMs: Number(process.env.LSP_MIXED_TIMEOUT_MS || 2_700_000),
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

// runMixed drives a SUBMARINE swap: the asset leg is an anchored on-chain HTLC and
// the BTC leg is Lightning, bound by one preimage. Only the two combos where the
// ASSET leg is on-chain and the BTC leg is Lightning map to the deployed binaries:
//   • side buy,  pay ln,  recv chain -> xsubbuy  (pay BTC over LN, claim the asset on-chain)
//   • side sell, pay chain, recv ln  -> xsublift (fund the asset HTLC on-chain, receive BTC-LN)
// The mirror combos (asset over LN + BTC on-chain) would need a BTC-on-chain HTLC
// submarine, which is not deployed; they fail closed with a clear message.
//
// It is SYNCHRONOUS through the whole anchor gate (up to LSP_MIXED_TIMEOUT_MS): the
// taker verifies the asset HTLC, WAITS for it to bury under Bitcoin to MIN_ANCHOR_DEPTH,
// then pays/settles the Lightning leg and claims/reveals on-chain. Honest finality:
// 'confirming' (anchor-bound), NOT the pure-LN 'final'. (Increment 2: 0-conf fronting
// to make the receive feel instant; an async job model to avoid the long-poll.)
function runMixed({ side, asset, amount, payRail, recvRail }) {
  return new Promise((resolve) => {
    const assetId = resolveAsset(asset);
    if (side !== 'buy' && side !== 'sell') return resolve({ ok: false, error: "side must be 'buy' or 'sell'" });
    if (!assetId || assetId === CFG.btcx) return resolve({ ok: false, error: 'mixed swap needs a Sequentia asset id (not BTC)' });
    if (!CFG.seqRpc || !CFG.seqWallet) {
      return resolve({ ok: false, error: 'the mixed (submarine) rail is not configured on this LSP (set SEQ_RPC + SEQ_WALLET)' });
    }
    // Map (side, payRail, recvRail) -> the submarine CLI. The ASSET leg must be
    // on-chain and the BTC leg on Lightning.
    let cmd, extra;
    if (side === 'buy' && payRail === 'ln' && recvRail === 'chain') {
      cmd = 'xsubbuy';                                         // BTC-LN in, asset on-chain out
      extra = ['-ln-socket', CFG.mixedBtcRpc, '-min-anchor-depth', String(CFG.minAnchorDepth)];
    } else if (side === 'sell' && payRail === 'chain' && recvRail === 'ln') {
      cmd = 'xsublift';                                        // asset on-chain in, BTC-LN out
      extra = ['-ln-socket', CFG.mixedBtcRpc];
    } else {
      return resolve({ ok: false, finality: 'unsupported',
        error: `mixed pay=${payRail}/recv=${recvRail} for a ${side} is not a deployed submarine `
             + '(only asset-on-chain <-> BTC-Lightning). Use both-Lightning, both-on-chain, or flip the mixed legs.' });
    }
    const stateFile = path.join(os.tmpdir(), `lsp-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const args = [cmd, '-asset', assetId, '-relay', CFG.relay,
      '-seq-rpc', CFG.seqRpc, '-seq-wallet', CFG.seqWallet, '-state-file', stateFile, ...extra];
    const t0 = Date.now();
    execFile(CFG.seqobCli, args, { timeout: CFG.mixedTimeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const settled = /SUBMARINE SWAP SETTLED/i.test(out);
      // The preimage + funded/claim outpoints are persisted to the session file.
      let preimage = null, htlcTxid = null;
      try {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        preimage = st.preimage_hex || st.secret_hex || null;   // xsubbuy: preimage learned; xsublift: our secret
        htlcTxid = st.seq_leg_txid || null;
      } catch { /* file may be absent on early failure */ }
      const cm = out.match(/claimed the asset in ([0-9a-f]{64})/i);
      try { fs.unlinkSync(stateFile); } catch { /* best-effort */ }
      const dt = Date.now() - t0;
      if (settled) return resolve({
        ok: true, side, asset: assetId, asset_label: assetLabel(assetId),
        rail: 'mixed', pay_rail: payRail, recv_rail: recvRail,
        preimage, htlc_txid: htlcTxid, claim_txid: cm ? cm[1] : null,
        // HONEST: the asset leg is an anchored on-chain HTLC — final only to its
        // Bitcoin-anchor depth, not the instant-final of pure Lightning.
        finality: 'confirming', anchor_bound: true, eta_seconds: Math.round(dt / 1000),
        note: 'Mixed submarine swap: one leg on Lightning, one anchored on-chain. Anchor-bound to Bitcoin.',
        settled_ms: dt, requested_amount: amount ?? null,
      });
      resolve({ ok: false, error: err ? `mixed swap failed: ${err.message}` : 'mixed swap did not settle',
        detail: out.split('\n').filter(Boolean).slice(-6).join(' | '), settled_ms: dt });
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
      // Rails select the settlement path (default ln/ln = the unchanged pure-LN route).
      const payRail = body.payRail || 'ln', recvRail = body.recvRail || 'ln';
      if (payRail === 'ln' && recvRail === 'ln') {
        const r = await runSwap(body);                          // UNCHANGED pure-LN
        return send(res, r.ok ? 200 : 502, r);
      }
      if (payRail === 'chain' && recvRail === 'chain') {
        // On-chain <-> on-chain is the SeqOB order-book HTLC path the wallet runs
        // itself; the LSP does not settle it.
        return send(res, 200, { ok: false, handled_by: 'wallet_onchain', finality: 'anchor-bound',
          error: 'on-chain <-> on-chain is settled by the wallet\'s own on-chain rail (the SeqOB order book), not the LSP' });
      }
      const r = await runMixed({ ...body, payRail, recvRail });  // MIXED -> submarine
      return send(res, r.ok ? 200 : (r.finality === 'unsupported' ? 422 : 502), r);
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
server.listen(CFG.port, '127.0.0.1', () => {
  console.error(`[lsp] listening http://127.0.0.1:${CFG.port}  asset-rpc ${CFG.hostedAssetRpc}  btc-rpc ${CFG.hostedBtcRpc}  relay ${CFG.relay}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
