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
//   --- "Move to Lightning" non-custodial channel funding ---
//   GET  /channel/deposit?chain=btc|seq -> the hosted node's on-chain deposit
//        address. The wallet sends the chosen amount there (signed by the user's OWN
//        wallet); the LSP never holds the on-chain keys.
//   POST /channel/open {chain, asset?, amount} -> watches for that deposit to confirm
//        then `fundchannel` to the routing peer. Non-custodial: the hosted node is
//        keyless, so the funding tx's SIGN_WITHDRAWAL is served by the DEVICE — the LSP
//        can command fundchannel but cannot sign it. Returns 202 {job_id, poll}.
//   GET  /channel/open/<id> -> pending_deposit | opening | awaiting_lockin | active | failed.
//   --- per-asset node provisioning (SeqLN is single-asset, so any asset needs its own node) ---
//   POST /node/provision {asset, device_transport_pubkey} -> boots (or re-attaches) a
//        keyless hosted SeqLN node for that asset, keyed to the device (the node pins the
//        device pubkey). Returns {node_id, host_pubkey, ws_port, public_ws_path}. The
//        wallet then attaches its on-device signer over the ws front and funds a channel.
//   GET  /node/list -> the provisioned per-asset nodes (dynamic; the "M" in "LN N/M").
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
//   --- "Move to Lightning" channel funding ---
//   CHANNEL_PEER_BTC   routing peer the BTC hosted node opens its channel to (id@host:port)
//   CHANNEL_PEER_ASSET routing peer the asset hosted node opens its channel to (id@host:port)
//   CHANNEL_WATCH_MS   how long POST /channel/open waits for the deposit + lock-in (default 1h)
//   --- MIXED (submarine) rail only ---
//   SEQ_RPC            Sequentia node RPC http://user:pass@host:port WITH -txindex,
//                      for the on-chain asset leg (fund/claim + BlockHashOfTx). REQUIRED
//                      for the mixed rail; if unset, mixed swaps return "not configured".
//   SEQ_WALLET         the hosted Sequentia node wallet for the on-chain leg (receives
//                      the asset on a buy; funds/holds it on a sell).
//   MIXED_BTC_RPC      the BTC-LN lightning-rpc for the submarine's Lightning leg
//                      (default: HOSTED_BTC_RPC, i.e. the device-cosigned hosted node).
//   MIN_ANCHOR_DEPTH   Bitcoin-anchor depth the taker requires before it pays (default 2).
//   MIXED_MAX_0CONF    0-conf LP-fronting cap (asset atoms). A mixed swap whose asset
//                      leg is <= this settles INSTANTLY (the submarine binary skips the
//                      anchor-bury wait; the LP fronts the small-amount reorg risk) and
//                      POST /swap answers SYNCHRONOUSLY with the preimage. Above it (or
//                      when body.amount is unknown) POST /swap returns HTTP 202 with a
//                      {job_id,status:'confirming'} handle and runs the anchor-gated swap
//                      in the background; poll GET /swap/<job_id>. 0 = always anchor-gated.
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
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { makeProvisioner } from './provision.mjs';
import { acceptUpgrade, bridgeWsToTcp } from './ws-bridge.mjs';
import { settlementPlanForSide, planExecutionName } from './settlement-router.mjs';
import { buildUnifiedBook } from './unified-book.mjs';

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
  // 0-conf LP-fronting cap (asset atoms). A mixed swap whose asset leg is <= this
  // settles INSTANTLY (the submarine binary skips the anchor-bury wait; the LP fronts
  // the Bitcoin-reorg risk) so /swap can answer SYNCHRONOUSLY with the preimage. Above
  // it (or when the amount is unknown) /swap returns a pollable 'confirming' job so the
  // browser never hangs through the multi-block anchor gate. 0 = always anchor-gated.
  mixedMax0conf: Number(process.env.MIXED_MAX_0CONF || 0),
  // --- Sub-asset rail: the MIRROR submarine (asset over Lightning + BTC ON-CHAIN HTLC). ---
  // A buy where the taker pays BTC on-chain and receives the asset over Lightning
  // (seqob-cli xsubas). It needs a bitcoind (funds + refunds the BTC HTLC), an asset LN
  // socket (receives the asset), and a relay carrying a sub-asset (ln_direction=4) maker.
  // Unset SUBAS_BTC_RPC/SUBAS_ASSET_LN => the rail is disabled (POST /swap fails closed).
  subasRelay: process.env.SUBAS_RELAY || process.env.RELAY || 'http://127.0.0.1:9955',
  subasBtcRpc: process.env.SUBAS_BTC_RPC || '',            // bitcoind RPC http://user:pass@host:port
  subasBtcWallet: process.env.SUBAS_BTC_WALLET || '',      // bitcoind wallet funding the BTC HTLC
  subasBtcChain: process.env.SUBAS_BTC_CHAIN || 'testnet4',
  subasAssetLn: process.env.SUBAS_ASSET_LN || process.env.HOSTED_ASSET_RPC || hostedRpcFallback,
  subasMinBtcConf: Number(process.env.SUBAS_MIN_BTC_CONF || 0), // 0 = LP fronts the reorg risk (instant)
  // Sub-asset INBOUND provisioning (JIT / pay-to-open). For a PER-USER receive the
  // user's own hosted asset node must have INBOUND liquidity (Move-to-Lightning only
  // gives outbound). SUBAS_LP_RPC is the lightning-rpc of the LP that opens an inbound
  // asset channel TOWARD the user (e.g. ln-asset = the sub-asset maker's own node, so
  // the maker can then pay over it). Unset => POST /channel/inbound + the per-user
  // sub-asset receive fail closed. The LP peer id/addr is CHANNEL_PEER_ASSET.
  subasLpRpc: process.env.SUBAS_LP_RPC || '',
  subasInboundReserve: Number(process.env.SUBAS_INBOUND_RESERVE || 5000), // extra asset sat funded above the receive amount (channel reserve room)
  subasInboundFeeBps: Number(process.env.SUBAS_INBOUND_FEE_BPS || 0),     // JIT-inbound fee, basis points of the amount (recorded)
  // SUB-ASSET SELL: pay the asset OVER LIGHTNING, receive BTC ON-CHAIN (mirror of the buy).
  // A sub-asset-SELL maker (ln_direction=5) on SUBAS_SELL_RELAY locks BTC on-chain + holds
  // an asset invoice on H; the LSP commands the USER's node to pay the held asset, learns P,
  // and RETURNS P + the BTC HTLC terms for the WALLET to claim on-chain (LSP never claims).
  subasSellRelay: process.env.SUBAS_SELL_RELAY || '',
  // --- "Move to Lightning" channel funding (GET /channel/deposit, POST /channel/open) ---
  // The routing peer each hosted node opens its channel TO (id@host:port). The channel
  // is funded from the hosted node's OWN on-chain wallet, whose only signer is the user's
  // device (keyless node + hsmd proxy), so the funding tx is device-co-signed: the LSP
  // orchestrates fundchannel but can never move the funds. Blank => that chain can't open.
  channelPeerBtc: process.env.CHANNEL_PEER_BTC || '',
  channelPeerAsset: process.env.CHANNEL_PEER_ASSET || '',
  // How long POST /channel/open watches for the on-chain deposit to confirm + the
  // channel to reach CHANNELD_NORMAL before it gives up (deposit never arrived, etc.).
  channelWatchMs: Number(process.env.CHANNEL_WATCH_MS || 3_600_000),
  // The routing peer a NEWLY-PROVISIONED per-asset node opens its channel to. SeqLN
  // nodes are single-asset, so this LP node is the counterparty for provisioned assets.
  channelPeerProvisioned: process.env.CHANNEL_PEER_PROVISIONED || '',
  // --- per-asset node provisioning (POST /node/provision) ---
  provDir: process.env.PROV_DIR || '',
  lightningd: process.env.LIGHTNINGD || '',
  hsmdProxy: process.env.HSMD_PROXY || '',
  wsRelay: process.env.WS_RELAY || '',
  nodeBin: process.env.NODE_BIN || process.execPath,
  elementsCli: process.env.ELEMENTS_CLI || '',
  seqRpcPort: Number(process.env.SEQ_RPC_PORT || 0),
  seqRpcUser: process.env.SEQ_RPC_USER || '',
  seqRpcPass: process.env.SEQ_RPC_PASS || '',
  // --- per-USER BTC (testnet4) node provisioning (POST /node/provision {chain:'btc'}) ---
  // A real wallet gets its OWN keyless testnet4 node — non-custodial, device-signed —
  // NOT the shared demo-btc node. These point the provisioner's 'btc' chain at the
  // testnet4 bitcoind + bitcoin-cli. Unset => BTC provisioning disabled (seq only).
  btcRpcPort: Number(process.env.BTC_RPC_PORT || 0),
  btcRpcUser: process.env.BTC_RPC_USER || process.env.SEQ_RPC_USER || '',
  btcRpcPass: process.env.BTC_RPC_PASS || process.env.SEQ_RPC_PASS || '',
  btcCli: process.env.BTC_CLI || '',
  btcNetwork: process.env.BTC_NETWORK || 'testnet4',
  btcFeerate: Number(process.env.BTC_FEERATE || 1000),
  // The routing peer a provisioned per-user BTC node opens its channel to.
  channelPeerBtcProvisioned: process.env.CHANNEL_PEER_BTC_PROVISIONED || process.env.CHANNEL_PEER_BTC || '',
  // Optional port-base overrides so a second LSP never collides on 9760/9800/18800.
  provAddrBase: Number(process.env.PROV_ADDR_BASE || 0) || undefined,
  provSignerBase: Number(process.env.PROV_SIGNER_BASE || 0) || undefined,
  provWsBase: Number(process.env.PROV_WS_BASE || 0) || undefined,
};

// The per-asset node provisioner (enabled when the boot binaries + dir are configured).
// SeqLN nodes are single-asset, so "move ANY asset into Lightning" needs a hosted node
// per asset spun up on demand, keyed to the connecting device. This is that mechanism.
let PROV = null;
if (CFG.provDir && CFG.lightningd && CFG.hsmdProxy && CFG.wsRelay && CFG.elementsCli && CFG.seqRpcPort) {
  // Per-chain backends. 'seq' (elements) is always configured; 'btc' (testnet4) is
  // added only when BTC_RPC_PORT + BTC_CLI are set, enabling per-user BTC nodes.
  const chains = {};
  if (CFG.btcRpcPort && CFG.btcCli) {
    chains.btc = {
      network: CFG.btcNetwork, rpcConnect: '127.0.0.1',
      rpcPort: CFG.btcRpcPort, rpcUser: CFG.btcRpcUser, rpcPass: CFG.btcRpcPass,
      cli: CFG.btcCli, feerate: CFG.btcFeerate, extra: ['min-emergency-msat=1000sat'],
    };
  }
  PROV = makeProvisioner({
    dir: CFG.provDir, lightningd: CFG.lightningd, hsmdProxy: CFG.hsmdProxy, wsRelay: CFG.wsRelay,
    node: CFG.nodeBin, lncli: CFG.lncli, elementsCli: CFG.elementsCli,
    rpcPort: CFG.seqRpcPort, rpcUser: CFG.seqRpcUser, rpcPass: CFG.seqRpcPass,
    chains,
    addrBase: CFG.provAddrBase, signerBase: CFG.provSignerBase, wsBase: CFG.provWsBase,
  });
  console.error(`[lsp] per-asset node provisioning ENABLED (dir ${CFG.provDir}; chains: seq${chains.btc ? ',btc' : ''})`);
}
if (!CFG.hostedAssetRpc || !CFG.hostedBtcRpc) {
  console.error('[lsp] missing hosted RPC: set HOSTED_ASSET_RPC + HOSTED_BTC_RPC (or HOSTED_RPC as a fallback for both)');
  process.exit(2);
}

// In-memory async job store for over-cap mixed swaps (anchor-gated, minutes-long).
// A restart drops in-flight jobs; the underlying swap is crash-safe via its own state
// file (the taker persists P after paying), so recovery is by re-driving the CLI.
const jobs = new Map();
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // reap finished jobs after 6h
function reapJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.done_ms && now - j.done_ms > JOB_TTL_MS) jobs.delete(id);
  }
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

// lnrpcKw: like lnrpc but passes keyword args (lightning-cli -k method k=v ...), for
// commands (e.g. `invoice`) whose optional params are cleaner set by name than by position.
function lnrpcKw(method, kv = [], rpc, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    if (!rpc) return reject(new Error(`internal: no rpc path for lnrpcKw '${method}'`));
    execFile(CFG.lncli, [`--rpc-file=${rpc}`, '-k', method, ...kv],
      { maxBuffer: 8 << 20, timeout: timeoutMs || undefined }, (err, stdout, stderr) => {
        if (err) {
          let detail = (stderr || '').trim();
          try { const j = JSON.parse(stdout); if (j && j.message) detail = j.message; } catch { /* not json */ }
          return reject(new Error(`${method}: ${detail || err.message}`));
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${method}: bad json`)); }
      });
  });
}
function lnrpc(method, args = [], rpc, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    // Fail LOUD on a missing rpc path: never silently default to the demo node (that would
    // target the wrong node) or to a bare `lightning-rpc` in cwd. A falsy rpc here is a
    // programming/registry bug, so surface it clearly instead of hitting the wrong socket.
    if (!rpc) return reject(new Error(`internal: no rpc path for lnrpc '${method}' (node record is missing its rpc)`));
    execFile(CFG.lncli, [`--rpc-file=${rpc}`, method, ...args],
      { maxBuffer: 8 << 20, timeout: timeoutMs || undefined }, (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error(`${method}: timed out after ${Math.round(timeoutMs/1000)}s (is the device signer connected?)`));
        // lightning-cli prints the JSON-RPC error (with a human "message") to stdout
        // even on a non-zero exit, so surface that instead of the bare "Command failed".
        if (err) {
          let detail = (stderr || '').trim();
          try { const j = JSON.parse(stdout); if (j && j.message) detail = j.message; } catch { /* not json */ }
          return reject(new Error(`${method}: ${detail || err.message}`));
        }
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

async function status(deviceKeys = []) {
  // Aggregate BOTH hosted nodes: the asset (GOLD) node and the BTC node.
  // In one-node fallback mode both sockets are identical and return the same data.
  const [assetNode, btcNode] = await Promise.all([
    nodeStatus(CFG.hostedAssetRpc, 'asset'),
    nodeStatus(CFG.hostedBtcRpc, 'btc'),
  ]);
  // Include the REQUESTING DEVICE's OWN provisioned-node channels, so the wallet reads back its
  // LN balance right after a "Move to Lightning" (else a just-created channel on the user's own
  // per-asset node is invisible and the balance card shows "No Lightning channel yet"). Gated by
  // the device's PROVISION KEYS: `deviceKeys` are the `seq:<assetId>:<devicepub>` / `btc:<pub>`
  // registry keys the wallet derived from ITS OWN mnemonic — only that device can name them, so
  // this discloses a node's channels solely to the device that owns it. Channels are leg-tagged
  // with the node key + the node's asset id (the wallet matches by asset id).
  const provChannels = [];
  const provNodes = [];
  if (PROV) for (const key of deviceKeys) {
    const rec = PROV.getByKey(key);
    if (!rec) continue;
    const ns = await nodeStatus(rec.rpc, rec.chain === 'btc' ? 'btc' : 'prov').catch(() => null);
    if (!ns) continue;
    const on = await onchainForReport(rec.rpc, rec.chain === 'btc' ? 'btc' : 'seq', rec.chain === 'btc' ? null : rec.asset_id).catch(() => ({ onchain_msat: 0 }));
    provNodes.push({ key: rec.key, asset_id: rec.asset_id, node_id: ns.id, channels: ns.channels.length,
      onchain_msat: on.onchain_msat, stranded: on.onchain_msat > 0 && ns.channels.length === 0 });
    for (const c of ns.channels) provChannels.push({ ...c, node_key: rec.key });
  }
  return {
    ok: true,
    asset_node: assetNode,
    btc_node: btcNode,
    provisioned_nodes: provNodes,                                       // the device's own nodes it named
    channels: [...assetNode.channels, ...btcNode.channels, ...provChannels], // merged, leg-tagged (incl. the device's own)
    // Which chains/assets "Move to Lightning" can fund on THIS LSP. SeqLN nodes are
    // single-asset, so each Sequentia asset needs its OWN hosted node; `assets` lists
    // the demo GOLD node PLUS every asset the provisioner has booted a node for, and
    // grows as the wallet provisions more. `provisioning` tells the wallet it can spin
    // up a node for any other asset on demand (POST /node/provision).
    funding: {
      btc: !!(CFG.channelPeerBtc && CFG.hostedBtcRpc),
      assets: fundableAssets(),
      provisioning: !!PROV,
    },
  };
}

// ---------------------------------------------------------------------------
// "Move to Lightning" — non-custodial channel funding.
//
// The user moves BTC (testnet4) or a Sequentia asset from on-chain into a
// Lightning channel on THEIR hosted node. The flow is:
//   1. GET  /channel/deposit?chain=btc|seq -> the hosted node's on-chain address.
//   2. The WALLET sends the chosen amount on-chain to that address, signed by the
//      user's OWN wallet (index.html's BTC / asset send path). The LSP never sees
//      or holds the user's on-chain keys.
//   3. POST /channel/open watches for that deposit to confirm in the hosted node's
//      on-chain wallet, then calls `fundchannel` to the routing peer. Because the
//      hosted node is KEYLESS (subdaemon=hsmd proxy -> the device's wasm signer),
//      the funding transaction's SIGN_WITHDRAWAL is served by the DEVICE. The LSP
//      can command fundchannel but cannot produce the funding signature, so it can
//      never move the deposited funds. Fail-closed: no device signer -> no funding
//      signature -> no channel.
//   4. GET /channel/open/<id> reports pending_deposit -> opening -> awaiting_lockin
//      -> active (CHANNELD_NORMAL), at which point /status shows spendable_msat.
// ---------------------------------------------------------------------------
const CHAINS = { btc: 'btc', seq: 'seq', sequentia: 'seq', asset: 'seq' };

// Resolve the hosted node RPC + routing peer for a (chain, assetId). BTC -> the demo BTC
// node. seq GOLD -> the demo asset node (the one in active use). seq OTHER asset -> the
// per-asset node the provisioner booted for it (single-asset SeqLN reality). Returns
// { rpc, peer, provisioned } or { rpc:null } if there is no hosted node for that asset.
function targetFor(chain, assetId, nodeKey) {
  // An explicit provisioned-node key (e.g. `btc:<devicepub>`) wins: it routes to the
  // user's OWN provisioned node (non-custodial), not a shared demo node. This is how a
  // per-user BTC channel is funded — the request names the device's provisioned node.
  if (PROV && nodeKey) {
    const rec = PROV.getByKey(nodeKey);
    if (rec) return { rpc: rec.rpc, peer: rec.lp_peer || (rec.chain === 'btc' ? CFG.channelPeerBtcProvisioned : CFG.channelPeerProvisioned), provisioned: true, rec };
  }
  if (chain === 'btc') return { rpc: CFG.hostedBtcRpc, peer: CFG.channelPeerBtc, provisioned: false };
  // seq: the demo GOLD node stays the canonical GOLD node (in active use).
  if (assetId && assetId === CFG.gold) return { rpc: CFG.hostedAssetRpc, peer: CFG.channelPeerAsset, provisioned: false };
  if (PROV && assetId) {
    const rec = PROV.get(assetId);
    if (rec) return { rpc: rec.rpc, peer: rec.lp_peer || CFG.channelPeerProvisioned, provisioned: true, rec };
  }
  return { rpc: null, peer: '', provisioned: false };
}
// The assets Move-to-Lightning can fund right now: the demo GOLD node + every asset the
// provisioner has a node for. Dynamic — grows as the wallet provisions more assets.
function fundableAssets() {
  const out = [];
  const seen = new Set();
  if (CFG.channelPeerAsset) { out.push({ id: CFG.gold, label: assetLabel(CFG.gold), provisioned: false }); seen.add(CFG.gold); }
  // Nodes are per-DEVICE now (several nodes can share one asset), so advertise ONE row per
  // asset — the wallet provisions its own device-scoped node for that asset on the click.
  if (PROV) for (const rec of PROV.list()) {
    if ((rec.chain || 'seq') === 'btc') continue;          // a btc node isn't a Sequentia asset
    if (seen.has(rec.asset_id)) continue;
    seen.add(rec.asset_id);
    out.push({ id: rec.asset_id, label: rec.label, provisioned: true, node_id: rec.node_id, status: rec.status });
  }
  return out;
}

// The hosted node's confirmed on-chain balance (base units: BTC sats / asset atoms)
// available to fund a channel. For an asset channel only outputs of `assetId` count;
// for BTC every confirmed output counts. Returns { units, outpoints } (outpoints of
// the matching confirmed outputs, so fundchannel can pin exactly the user's deposit).
async function confirmedOnchain(rpc, chain, assetId) {
  const lf = await lnrpc('listfunds', [], rpc);
  let units = 0; const outpoints = [];
  for (const o of (lf.outputs || [])) {
    // Count the user's own deposit as soon as the node SEES it, confirmed or not: it is the
    // user funding their OWN single-asset channel, so there is no counterparty risk in funding
    // at 0-conf (fundchannel uses minconf=0; the channel still won't lock in until the funding
    // tx — and thus its parent deposit — confirms). This removes a full block of latency.
    if (o.status !== 'confirmed' && o.status !== 'unconfirmed') continue;
    if (chain === 'seq' && assetId && (o.asset || '').toLowerCase() !== assetId.toLowerCase()) continue;
    const sats = Math.round(Number(o.amount_msat ?? 0) / 1000);
    if (!sats) continue;
    units += sats;
    outpoints.push(`${o.txid}:${o.output}`);
  }
  return { units, outpoints };
}

// Find the channel opened to `peerId` (optionally matching funding_txid) on this node.
async function findChannel(rpc, peerId, fundingTxid) {
  const pc = await lnrpc('listpeerchannels', [], rpc).catch(() => ({ channels: [] }));
  const cands = (pc.channels || []).filter((c) =>
    (c.peer_id || '').toLowerCase() === peerId.toLowerCase() &&
    (!fundingTxid || (c.funding_txid || '').toLowerCase() === fundingTxid.toLowerCase()));
  // Prefer a NORMAL channel, else the most-recent opening one.
  return cands.find((c) => c.state === 'CHANNELD_NORMAL')
    || cands.find((c) => String(c.state).startsWith('CHANNELD')) || cands[0] || null;
}

// Reliably connect the hosted node to the routing peer BEFORE funding a channel. A peerless
// fundchannel is exactly what stranded a user's deposit once (the node had 0 peers), so we retry
// `connect` and VERIFY via listpeers that the link is actually up — and if it never comes up we
// throw a CLEAR error instead of proceeding to a fundchannel that would hang/strand the deposit.
// The connect crypto handshake (Noise ECDH) is DEVICE-SIGNED over the hsmd proxy, so a device that
// isn't serving signing makes this fail loud ("keep your wallet open") rather than hang forever.
async function ensurePeer(rpc, peerId, peerAddr, job) {
  const CONNECT_TIMEOUT_MS = 25000;   // per attempt; bounds the device-signed ECDH so it can't hang
  const ATTEMPTS = 4;
  const alreadyUp = async () => {
    const lp = await lnrpc('listpeers', [`id=${peerId}`], rpc).catch(() => ({ peers: [] }));
    return (lp.peers || []).some((p) => (p.id || '').toLowerCase() === peerId.toLowerCase() && p.connected);
  };
  if (await alreadyUp()) { if (job) job.connect_note = 'already connected'; return; }
  let lastErr = '';
  for (let i = 0; i < ATTEMPTS; i++) {
    try { await lnrpc('connect', [peerAddr ? `${peerId}@${peerAddr}` : peerId], rpc, CONNECT_TIMEOUT_MS); }
    catch (e) { lastErr = e.message; if (job) job.connect_note = lastErr; }
    if (await alreadyUp()) { if (job) job.connect_note = 'connected'; return; }
    await sleep(2000);
  }
  throw new Error(`could not connect your Lightning node to the routing peer after ${ATTEMPTS} tries` +
    (lastErr ? ` (${lastErr})` : '') +
    ` — the device signer may not be serving the connection handshake; keep your wallet open and retry.` +
    ` Your deposit is safe on-chain and no channel was opened.`);
}

// A hosted node's on-chain balance that is NOT yet in a channel (listfunds.outputs are, by
// definition, wallet UTXOs not committed to any channel). Used by the stranded-deposit report so a
// wallet can auto-detect "deposit landed on my node but no channel" and (re)call /channel/open.
// msat convention matches CLN: for an asset output amount_msat = atoms * 1000 (5 USDX -> 500000000000).
async function onchainForReport(rpc, chain, assetId) {
  const lf = await lnrpc('listfunds', [], rpc).catch(() => ({ outputs: [] }));
  let msat = 0; const outputs = [];
  for (const o of (lf.outputs || [])) {
    if (o.status !== 'confirmed' && o.status !== 'unconfirmed') continue;   // count 0-conf too
    if (chain === 'seq' && assetId && (o.asset || '').toLowerCase() !== assetId.toLowerCase()) continue;
    const m = Number(o.amount_msat ?? 0);
    if (!m) continue;
    msat += m;
    outputs.push({ txid: o.txid, output: o.output, amount_msat: m, status: o.status, asset: o.asset || null });
  }
  return { onchain_msat: msat, outputs };
}

const channelJobs = new Map();
function reapChannelJobs() {
  const now = Date.now();
  for (const [id, j] of channelJobs) if (j.done_ms && now - j.done_ms > JOB_TTL_MS) channelJobs.delete(id);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET /channel/deposit?chain=btc|seq[&asset=<id>] -> the hosted node's deposit address.
// Poll getinfo until the node's rpc answers (a freshly-provisioned node boots + rescans, so
// its lightning-rpc SOCKET does not exist for the first seconds — lightning-cli then reports
// `Connecting to 'lightning-rpc': No such file or directory`, i.e. NOT ready, not an empty
// rpc). Returns getinfo once the node responds; throws a clean "still preparing" past the
// bound. The wallet polls /node/getinfo for progress, so this is a short safety net.
async function waitGetinfo(rpc, timeoutMs = 45000) {
  if (!rpc) throw new Error('internal: no rpc path for node (cannot wait for readiness)');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await lnrpc('getinfo', [], rpc); }
    catch (e) {
      if (Date.now() > deadline) throw new Error(`your Lightning node is still preparing (booting + syncing) — try again in a moment (${e.message})`);
      await sleep(1500);
    }
  }
}

// Wait until the node is FULLY SYNCED to the chain tip before we drive a channel open. A
// keyless node boots + rescans for MINUTES; issuing `fundchannel` before it finishes syncing
// parks the funding on "Waiting to sync with bitcoind" AND (worse) fires a funding-path signer
// op mid-rescan, which is exactly what wedged a device signer once (proxy blocked on a device
// read the browser never answered, freezing the whole node loop). So gate on getinfo reporting
// no sync warnings. getinfo answering at all already means the loop is live (a wedged loop hangs
// getinfo), so this also catches a soft-wedge as a timeout rather than a silent hang.
async function waitSynced(rpc, deadline) {
  for (;;) {
    const info = await lnrpc('getinfo', [], rpc).catch(() => null);
    if (info && info.warning_lightningd_sync == null && info.warning_bitcoind_sync == null) return info;
    if (Date.now() > deadline) throw new Error('your Lightning node did not finish syncing to the chain tip in time (still rescanning) — its funds are safe on-chain; retry once it is caught up');
    await sleep(3000);
  }
}

async function channelDeposit(chain, assetId, nodeKey) {
  const { rpc } = targetFor(chain, chain === 'seq' ? (assetId || CFG.gold) : null, nodeKey);
  if (!rpc) throw new Error('no hosted node for that asset (provision it first)');
  const info = await waitGetinfo(rpc);            // tolerate a just-booted node's missing socket
  const na = await lnrpc('newaddr', ['bech32'], rpc);
  return { ok: true, chain, node_id: info.id, network: info.network,
    address: na.bech32 || na.address || na.p2tr };
}

// The background worker: watch for the deposit, then fundchannel (device-co-signed).
async function runChannelOpen(job) {
  const { rpc, peer } = targetFor(job.chain, job.asset_id, job.node_key);
  if (!rpc) throw new Error('no hosted node for that asset');
  if (!peer) throw new Error('no routing peer configured for that asset');
  const [peerId, peerAddr] = peer.split('@');
  const deadline = Date.now() + CFG.channelWatchMs;
  const need = Number(job.requested_amount);

  // 0. Wait for the node's rpc to answer (a fresh node's socket may not exist yet), THEN wait
  //    until it is fully synced to the chain tip. Funding an un-synced (still-rescanning) node
  //    parks the funding tx and fires a signer op mid-rescan that can wedge the device signer.
  await waitGetinfo(rpc);
  job.status = 'syncing';
  await waitSynced(rpc, deadline);

  // A10 IDEMPOTENCY GUARD (prevents a double-fund). Before waiting for the deposit
  // or funding, check whether a channel to this peer ALREADY exists. The wallet's
  // auto-reconnect / stranded-deposit recovery (section 4) — and any plain retry —
  // can re-issue /channel/open after a prior fundchannel already broadcast; funding
  // again would open a SECOND channel and fragment the user's deposit. Worse, the
  // deposit-wait below would then spin to timeout ("Could not afford ...", the
  // deposit already spent into the first channel). If an opening/locked channel is
  // present, adopt it and skip straight to the lock-in watch. (listpeerchannels is
  // registry/db-backed, so this needs no peer connection and never signs.)
  let existingCh = null;
  {
    const pc = await lnrpc('listpeerchannels', [`id=${peerId}`], rpc)
      .catch(() => ({ channels: [] }));
    const OPEN_STATES = ['OPENINGD', 'DUALOPEND_OPEN_INIT', 'DUALOPEND_AWAITING_LOCKIN',
                         'CHANNELD_AWAITING_LOCKIN', 'CHANNELD_NORMAL'];
    existingCh = (pc.channels || []).find((c) => OPEN_STATES.includes(c.state)) || null;
  }
  if (existingCh) {
    job.funding_txid = existingCh.funding_txid
      || (existingCh.funding && existingCh.funding.txid) || null;
    job.channel_id = existingCh.channel_id || null;
    job.reused_existing = true;
    job.status = 'awaiting_lockin';
  }

  if (!existingCh) {
  // 1. Wait for confirmed on-chain funds >= the requested channel amount. (Funds the
  //    user just deposited; if the node already holds enough, this passes at once.)
  for (;;) {
    if (Date.now() > deadline) throw new Error('deposit did not confirm before timeout');
    const { units, outpoints } = await confirmedOnchain(rpc, job.chain, job.asset_id);
    job.confirmed_units = units;
    if (units >= need) { job.deposit_outpoints = outpoints; break; }
    job.status = 'pending_deposit';
    await sleep(3000);   // poll briskly: the deposit is the user's own tx, seen within seconds
  }

  // 2. Connect to the routing peer + fundchannel. The funding tx SIGN_WITHDRAWAL is
  //    served by the DEVICE over the hsmd proxy; a missing device fails this closed.
  job.status = 'connecting';
  // Reliable connect w/ retry + verify. NEVER proceed to fundchannel peerless (that stranded a
  // user's 5 USDX once): ensurePeer throws a clear error and the job fails cleanly, funds intact.
  await ensurePeer(rpc, peerId, peerAddr, job);
  job.status = 'opening';
  // fundchannel with the seqln fork's `asset` parameter, so the channel AND its on-chain
  // funding fee are denominated in the DEPOSITED asset — NOT the policy asset (tSEQ). This
  // is the crux: stock fundchannel funds in the policy asset, so on a single-asset node it
  // either fails "Could not afford ... 0 available UTXOs" (it counts zero policy UTXOs) or,
  // with a `utxos` pin, builds a policy-denominated tx that cannot balance against the
  // asset-only inputs -> `bad-txns-in-ne-out`. With `asset=<id>` the fork coin-selects that
  // asset's UTXOs and pays the (few-atom, fee-rated) fee IN the asset — one all-asset funding
  // tx (asset channel + asset change + asset fee), matching the demo GOLD channel. We fund an
  // explicit amount = the confirmed deposit minus a small reserve for that fee; the leftover
  // stays on the node's wallet (recoverable). A BTC node is policy-denominated (BTC IS the
  // testnet4 policy asset), so it passes no `asset` and funds plainly.
  //
  // The fork sizes the asset fee from the node's OWN fee rate table (its Elements backend's
  // getfeeexchangerates), so the LSP can only fund an asset its backend whitelists — acceptable by
  // design (today that is every live asset: GOLD, USDX, EURX, SILVR, OILX). The wallet gates the
  // Move-to-Lightning list on /feerates, which IS that acceptance set, so it only ever asks for
  // assets the node can fund — consistent by construction.
  const FEE_RESERVE = 20000; // asset atoms held back for the in-asset on-chain fee (~1 atom)
  const fundAmount = Math.max(1, (job.confirmed_units || need) - FEE_RESERVE);
  // minconf=0 so we can fund from the user's just-broadcast (0-conf) deposit immediately —
  // it's their own money funding their own channel, so 0-conf carries no counterparty risk.
  const fcArgs = [`id=${peerId}`, `amount=${fundAmount}`, 'announce=true', 'minconf=0'];
  if (job.chain === 'seq' && job.asset_id) fcArgs.push(`asset=${job.asset_id}`);
  const fc = await lnrpc('fundchannel', fcArgs, rpc);
  job.funding_txid = fc.txid || (fc.txids && fc.txids[0]) || null;
  job.channel_id = fc.channel_id || null;
  } // end if(!existingCh): skip connect+fundchannel when a channel already exists (A10)

  // 3. Watch the channel to CHANNELD_NORMAL.
  job.status = 'awaiting_lockin';
  for (;;) {
    if (Date.now() > deadline) throw new Error('channel did not reach CHANNELD_NORMAL before timeout');
    const ch = await findChannel(rpc, peerId, job.funding_txid);
    if (ch) {
      job.state = ch.state;
      job.short_channel_id = ch.short_channel_id || null;
      job.spendable_msat = ch.spendable_msat ?? ch.to_us_msat ?? null;
      job.channel_asset = ch.channel_asset || ch.asset || 'policy';
      if (ch.state === 'CHANNELD_NORMAL') { job.status = 'active'; break; }
    }
    await sleep(15000);
  }
  job.done_ms = Date.now();
  return job;
}

// POST /channel/open {chain, asset?, amount}. Validates + starts the background job.
function startChannelOpen(body) {
  const chain = CHAINS[String(body.chain || '').toLowerCase()];
  if (!chain) return { ok: false, error: "chain must be 'btc' or 'seq'" };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'amount must be a positive number (base units: BTC sats / asset atoms)' };
  // Resolve the asset so the deposit watch counts only that asset + we route to the correct
  // single-asset node. NO privileged default asset: a seq channel REQUIRES an explicit asset id
  // (there is no "the GOLD node" fallback). The LSP funds whatever asset the wallet asks — it does
  // not whitelist; producers decide movability by mining or not.
  let assetId = null;
  if (chain === 'seq') {
    assetId = body.asset ? resolveAsset(body.asset) : null;
    if (!assetId) return { ok: false, error: 'a Sequentia asset id is required for a seq channel (no default asset)' };
    if (assetId === CFG.btcx) return { ok: false, error: 'that id is the BTC leg; use chain=btc' };
  }
  // A provisioned-node key (e.g. `btc:<devicepub>`) routes to the user's OWN node.
  const nodeKey = body.node || null;
  const { rpc, peer } = targetFor(chain, assetId, nodeKey);
  if (!rpc) {
    return { ok: false, error: `this LSP has no hosted Lightning node for ${assetLabel(assetId)} yet. `
      + 'SeqLN nodes are single-asset, so provision one first: POST /node/provision {asset}.' };
  }
  if (!peer) return { ok: false, error: `no routing peer configured for ${chain === 'btc' ? 'BTC' : assetLabel(assetId)}` };
  reapChannelJobs();
  const jobId = crypto.randomUUID();
  const job = { ok: true, job_id: jobId, chain, asset_id: assetId, node_key: nodeKey,
    asset_label: assetId ? assetLabel(assetId) : (chain === 'btc' ? 'BTC' : null),
    requested_amount: amount, peer_id: peer.split('@')[0], status: 'pending_deposit',
    state: null, funding_txid: null, short_channel_id: null, started_ms: Date.now() };
  channelJobs.set(jobId, job);
  runChannelOpen(job)
    .then(() => { /* job mutated in place */ })
    .catch((e) => { job.status = 'failed'; job.error = String((e && e.message) || e); job.done_ms = Date.now(); });
  return { ...job, poll: `/channel/open/${jobId}` };
}

// ---------------------------------------------------------------------------
// Sub-asset external-BTC HODL BUY (async, pollable) — the EXACT mirror of the proven
// sub-asset SELL, roles flipped. The taker pays BTC ON-CHAIN and receives the asset OVER
// LIGHTNING; the taker's OWN hosted node holds the asset payment by H (holdinvoice-seq, NO
// bolt11 — the maker pays H by BARE HASH) and the DEVICE settles with P out-of-band. Always
// ASYNC (the maker must PayHash + the device must settle). INVARIANT: the LSP only READS
// holdinvoicelookup — it NEVER calls settle, so it stays blind to P (the whole point of
// HODL). Wired from POST /swap {side:'buy',hodl:true}; polled via GET /swap/<job_id>.
async function runSubasBuyHodl(job, body) {
  // (a) resolve the user's hosted asset node (the payee of the held asset payment).
  const rec = PROV && PROV.getByKey(job.node_key);
  const userRpc = rec && rec.rpc;
  if (!userRpc) throw new Error('user node not provisioned for this asset (POST /node/provision first)');
  // (b) JIT inbound so the user node can RECEIVE the asset over LN (idempotent, fail-closed).
  try {
    job.inbound = await provisionInbound({ nodeKey: job.node_key, assetId: job.asset, amount: job.asset_amount });
  } catch (e) {
    throw new Error(`inbound provisioning failed: ${(e && e.message) || e}`);
  }
  // (c) the external-BTC xsubas vector (the DEVICE funded the BTC HTLC, so NO -btc-wallet)
  //     MINUS -asset-bolt11, PLUS the HODL signal: announce THIS node id + H, the maker pays
  //     H by BARE HASH, and the device settles out-of-band. body.btc_htlc carries the full
  //     redeem_script + taker_refund_pub the driver relays (job.btc_htlc keeps only a subset).
  const bh = body.btc_htlc;
  // Resolve the user node's LN id — the HODL trigger is `-taker-ln-node-id <id>` (the maker pays the
  // hold by BARE HASH to it). `-asset-hodl` is NOT a real xsubas flag; passing it breaks flag parsing
  // (every later flag is dropped) so hodl mode never engages and the flow silently mis-settles.
  let userNodeId = (rec && rec.node_id) || '';
  if (!userNodeId) { try { const gi = await lnrpc('getinfo', [], userRpc); userNodeId = gi.id || ''; } catch {} }
  if (!userNodeId) throw new Error('could not resolve the user node LN id for the HODL buy');
  const args = ['xsubas', '-asset', job.asset, '-relay', CFG.subasRelay,
    '-btc-rpc', CFG.subasBtcRpc, '-btc-chain', CFG.subasBtcChain,
    '-btc-htlc-txid', String(bh.txid), '-btc-htlc-vout', String(bh.vout),
    '-btc-htlc-amount', String(bh.amount), '-btc-htlc-script', String(bh.redeem_script),
    '-btc-locktime', String(bh.cltv), '-btc-refund-pub', String(bh.taker_refund_pub),
    '-asset-ln-socket', userRpc, '-taker-ln-node-id', String(userNodeId),
    '-payment-hash', job.payment_hash, '-state-file', `/tmp/xsubas-${job.job_id}.json`,
    '-min-btc-conf', String(CFG.subasMinBtcConf)];
  if (job.offer_id) args.push('-offer-id', String(job.offer_id));
  if (job.maker_pubkey) args.push('-maker-pubkey', String(job.maker_pubkey));
  // (d) READ-ONLY held/settled watcher — the SAME holdinvoicelookup /node/invoice-status uses.
  //     The LSP NEVER settles (the DEVICE does), so this only surfaces state on the job.
  let watching = true;
  (async () => {
    while (watching) {
      try {
        const l = await lnrpc('holdinvoicelookup', [job.payment_hash], userRpc);
        if (l.state === 'accepted' && !job.held) {
          job.held = true; job.held_ms = Date.now();
          if (job.status === 'pending') job.status = 'held';
        }
        if (l.state === 'settled') job.settled = true;
      } catch { /* transient; keep polling */ }
      await sleep(2000);
    }
  })();
  // (e) drive the maker's pay-by-hash to completion (bounded by the mixed timeout).
  const { err, out } = await new Promise((resolve) =>
    execFile(CFG.seqobCli, args, { timeout: CFG.mixedTimeoutMs, maxBuffer: 8 << 20 },
      (e2, so, se) => resolve({ err: e2, out: (so || '') + (se || '') })));
  // (f) The HODL taker CLI RETURNS AT HELD (prints "HELD", exits 0); the on-chain SETTLED happens
  //     LATER, after the DEVICE settles (/node/settle) and the maker claims the BTC HTLC. So a clean
  //     CLI exit is success-IN-PROGRESS, not terminal — only a pre-held error is a real failure.
  const heldBanner = /HELD on H|HODL BUY[^\n]*HELD/i.test(out);
  if (err && !job.held && !heldBanner) {
    watching = false;
    job.status = 'failed';
    job.error = `sub-asset buy failed before held: ${err.message}`;
    job.detail = out.split('\n').filter(Boolean).slice(-6).join(' | ');
    job.note = 'the BTC HTLC is refundable after T_btc via btcLeg.refund (the device holds the refund key).';
    job.done_ms = Date.now();
    return job;
  }
  if (job.status === 'pending') { job.held = true; job.held_ms = job.held_ms || Date.now(); job.status = 'held'; }
  // Keep the read-only holdinvoicelookup watcher ALIVE past the CLI exit: the wallet drives
  // /node/settle (the device reveals P), the maker claims the BTC, and holdinvoicelookup flips to
  // 'settled' -> the watcher sets job.settled. The LSP never sees P.
  const settleDeadline = Date.now() + CFG.mixedTimeoutMs;
  while (!job.settled && Date.now() < settleDeadline) { await sleep(2000); }
  watching = false;
  job.done_ms = Date.now();
  job.settled_ms = Date.now() - job.started_ms;
  if (job.settled) {
    job.status = 'settled';
    job.note = 'received the asset over Lightning; the maker claimed your BTC HTLC with the device-revealed preimage.';
  } else {
    job.status = 'held';
    job.note = 'the asset payment is HELD on your node; settle it from your wallet (the device reveals the preimage) to complete.';
  }
  return job;
}

// POST /swap {side:'buy',hodl:true,...}: validate the HODL-buy contract, create the pollable
// job in the shared `jobs` Map, launch the worker, and hand back a 202 job shell (or
// {ok:false,code}). Mirrors startChannelOpen. GET /swap/<job_id> then surfaces the job verbatim.
function startSubasBuyHodl(body) {
  const assetId = resolveAsset(body.asset);
  if (!assetId || assetId === CFG.btcx) return { ok: false, error: 'a Sequentia asset id is required for a sub-asset buy (not BTC)' };
  const nodeKey = String((body && body.node_key) || '').toLowerCase();
  if (!nodeKey) return { ok: false, error: 'node_key (your hosted asset node that receives the asset over LN) is required' };
  const H = String((body && body.payment_hash) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(H)) return { ok: false, error: 'payment_hash must be a 32-byte hex H = SHA256(P)' };
  const assetAmount = Number(body.asset_amount);
  if (!Number.isFinite(assetAmount) || assetAmount <= 0) return { ok: false, error: 'asset_amount must be a positive number (asset atoms)' };
  const bh = body.btc_htlc;
  const need = ['txid', 'vout', 'amount', 'redeem_script', 'cltv', 'maker_claim_pub', 'taker_refund_pub'];
  if (!bh || need.some((k) => bh[k] === undefined || bh[k] === null || bh[k] === '')) {
    return { ok: false, error: 'btc_htlc must carry {txid,vout,amount,redeem_script,cltv,maker_claim_pub,taker_refund_pub} (the device-funded on-chain HTLC on H)' };
  }
  // Backend gates (fail closed).
  if (!CFG.subasBtcRpc || !CFG.subasRelay) {
    return { ok: false, code: 503, error: 'the sub-asset BUY rail is not configured on this LSP (set SUBAS_BTC_RPC + SUBAS_RELAY + a sub-asset maker on SUBAS_RELAY)' };
  }
  if (!PROV) return { ok: false, code: 501, error: 'per-asset node provisioning is not enabled on this LSP' };
  const rec = PROV.getByKey(nodeKey);
  if (!rec || !rec.rpc) return { ok: false, code: 404, error: 'unknown/unprovisioned node_key (POST /node/provision first)' };

  const jobId = crypto.randomUUID();
  const job = {
    job_id: jobId, side: 'buy', hodl: true, rail: 'subasset',
    pay_rail: 'chain', recv_rail: 'ln', asset: assetId, asset_label: assetLabel(assetId),
    node_key: nodeKey, payment_hash: H, asset_amount: assetAmount,
    btc_htlc: { txid: String(bh.txid), vout: bh.vout, amount: bh.amount, cltv: bh.cltv },
    offer_id: body.offer_id || null, maker_pubkey: body.maker_pubkey || null,
    status: 'pending', held: false, settled: false,
    finality: 'confirming', anchor_bound: true, inbound: null, started_ms: Date.now() };
  jobs.set(jobId, job);
  runSubasBuyHodl(job, body).catch((e) => {
    job.status = 'failed'; job.error = String((e && e.message) || e); job.done_ms = Date.now();
  });
  return { ...job, ok: true, held: false, poll: `/swap/${jobId}`,
    note: 'Sub-asset HODL buy: poll GET /swap/<job_id>; when held:true, settle via /node/settle to release P and let the maker claim your BTC.' };
}

// POST /channel/close {chain, asset?, node?, scid?, destination}. The INVERSE of Move-to-Lightning:
// cooperatively close a channel on the user's OWN hosted node and send the reclaimed funds straight
// to `destination` (the wallet's own on-chain address), so nothing is left parked on the hosted node
// and no separate asset-sweep is needed. Device-signed and fail-closed: the keyless node's closing tx
// SIGN is served by the DEVICE (like the funding SIGN_WITHDRAWAL), so the LSP can command the close
// but cannot redirect the funds — and if no device signer is connected, the close simply times out
// rather than moving anything. `unilateraltimeout` gives the cooperative path a window before falling
// back to a (still device-signed) unilateral force-close.
async function closeChannel(body) {
  const chain = CHAINS[String(body.chain || '').toLowerCase()];
  if (!chain) return { ok: false, error: "chain must be 'btc' or 'seq'" };
  let assetId = null;
  if (chain === 'seq') {
    assetId = body.asset ? resolveAsset(body.asset) : null;
    if (!assetId) return { ok: false, error: 'a Sequentia asset id is required for a seq channel' };
  }
  const nodeKey = body.node || null;
  const { rpc } = targetFor(chain, assetId, nodeKey);
  if (!rpc) return { ok: false, error: `no hosted Lightning node for ${chain === 'btc' ? 'BTC' : assetLabel(assetId)}` };
  const dest = String(body.destination || '').trim();
  if (!dest) return { ok: false, error: 'destination (your on-chain address) is required so the reclaimed funds return to your wallet' };
  // Pick the channel to close: the named scid, else the node's single open channel.
  const pc = await lnrpc('listpeerchannels', [], rpc).catch(() => ({ channels: [] }));
  const open = (pc.channels || []).filter((c) => String(c.state || '').startsWith('CHANNELD'));
  const ch = body.scid ? open.find((c) => c.short_channel_id === body.scid) : (open.length === 1 ? open[0] : null);
  if (!ch) return { ok: false, error: open.length ? 'multiple channels on this node — specify scid' : 'no open channel to close on this node' };
  const id = ch.short_channel_id || ch.channel_id;
  // close <id> <unilateraltimeout> <destination>: cooperative first (funds -> destination), then a
  // device-signed unilateral fallback. Bounded by an execFile timeout so a missing device fails fast.
  const uni = Number.isFinite(Number(body.unilateraltimeout)) ? Math.max(1, Number(body.unilateraltimeout)) : 60;
  const r = await lnrpc('close', [id, String(uni), dest], rpc, (uni + 30) * 1000);
  return { ok: true, closing_txid: r.txid || (r.txids && r.txids[0]) || null, type: r.type || null,
    scid: ch.short_channel_id || null, destination: dest, asset_label: assetId ? assetLabel(assetId) : 'BTC' };
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
// Under the 0-conf cap (MIXED_MAX_0CONF) the submarine binary skips the anchor-bury
// wait, so this resolves in seconds and POST /swap awaits it directly (returning the
// preimage, zero_conf:true). Over the cap the taker WAITS for the asset HTLC to bury
// under Bitcoin to MIN_ANCHOR_DEPTH before paying/settling the Lightning leg — minutes
// long — so the POST /swap handler runs runMixed in the BACKGROUND as a job and returns
// immediately; this function is the same either way. Honest finality: 'confirming'
// (anchor-bound), NOT the pure-LN instant-'final'.
// provisionInbound gives the user's OWN hosted asset node INBOUND liquidity so it
// can RECEIVE the asset (Move-to-Lightning only funds outbound). The LP (SUBAS_LP_RPC,
// e.g. ln-asset) connects to the user node and opens a 0-conf asset channel TOWARD it,
// funded from the LP's on-chain asset — the exact JIT/pay-to-open step proven at the
// CLI. Idempotent: a no-op (already_had_inbound) if the user already has >= amount
// receivable from the LP. Fails closed (throws) if unconfigured, the node is not
// provisioned, or the LP lacks asset liquidity. amount is in ASSET SATS.
async function provisionInbound({ nodeKey, assetId, amount }) {
  if (!CFG.subasLpRpc) throw new Error('inbound provisioning is not configured on this LSP (set SUBAS_LP_RPC)');
  const lpId = (CFG.channelPeerAsset || '').split('@')[0];
  if (!lpId) throw new Error('inbound: no LP peer configured (CHANNEL_PEER_ASSET)');
  if (!(amount > 0)) throw new Error('inbound: amount (asset sats) must be > 0');
  const { rpc: userRpc, rec } = targetFor('seq', assetId, nodeKey);
  if (!userRpc || !rec) throw new Error('user node not provisioned for this asset (POST /node/provision first)');
  const need = amount * 1000; // msat
  // Idempotent: reuse an existing NORMAL channel from the LP with enough receivable.
  const pc = await lnrpc('listpeerchannels', [], userRpc).catch(() => ({ channels: [] }));
  const already = (pc.channels || []).find(c => c.peer_id === lpId && c.state === 'CHANNELD_NORMAL' && Number(c.receivable_msat || 0) >= need);
  if (already) return { ok: true, already_had_inbound: true, channel_id: already.channel_id || null, receivable_msat: already.receivable_msat ?? null, fee_msat: 0 };
  // The user node's listen address, so the LP can dial it.
  const uinfo = await lnrpc('getinfo', [], userRpc);
  const userId = uinfo.id;
  const bind = (uinfo.binding || []).find(b => b.port) || {};
  if (!bind.port) throw new Error('user node has no listen binding for the LP to connect to');
  const host = bind.address || '127.0.0.1';
  await lnrpc('connect', [`id=${userId}`, `host=${host}`, `port=${bind.port}`], CFG.subasLpRpc)
    .catch(e => { throw new Error(`LP could not connect to the user node: ${e.message}`); });
  // LP funds a 0-conf asset channel TOWARD the user (all liquidity on the LP side =
  // the user's inbound). Fails closed if the LP lacks the asset on-chain.
  const fundAmt = amount + CFG.subasInboundReserve;
  const fc = await lnrpc('fundchannel', [`id=${userId}`, `amount=${fundAmt}sat`, `asset=${assetId}`, 'mindepth=0', 'announce=false'], CFG.subasLpRpc);
  // Wait for CHANNELD_NORMAL on the user side (0-conf -> seconds).
  const deadline = Date.now() + 90000;
  let chan;
  for (;;) {
    const pc2 = await lnrpc('listpeerchannels', [], userRpc).catch(() => ({ channels: [] }));
    chan = (pc2.channels || []).find(c => c.peer_id === lpId && (c.funding_txid === fc.txid || c.channel_id === fc.channel_id));
    if (chan && chan.state === 'CHANNELD_NORMAL') break;
    if (Date.now() > deadline) throw new Error('inbound channel did not reach CHANNELD_NORMAL in time');
    await sleep(3000);
  }
  const feeMsat = Math.floor(need * CFG.subasInboundFeeBps / 10000);
  return { ok: true, already_had_inbound: false, channel_id: fc.channel_id || null, funding_txid: fc.txid || null,
    receivable_msat: chan.receivable_msat ?? null, fee_msat: feeMsat };
}

function runMixed({ side, asset, amount, payRail, recvRail, node_key, asset_bolt11, payment_hash, asset_amount, btc_claim_pub, offer_id, maker_pubkey, btc_htlc }) {
  return new Promise(async (resolve) => {
    const assetId = resolveAsset(asset);
    if (side !== 'buy' && side !== 'sell') return resolve({ ok: false, error: "side must be 'buy' or 'sell'" });
    if (!assetId || assetId === CFG.btcx) return resolve({ ok: false, error: 'mixed swap needs a Sequentia asset id (not BTC)' });
    // Stage 1b: the settlement router is now the dispatch AUTHORITY. It maps (side, payRail,
    // recvRail) to the deployed binary; the branches below are guarded on execName, NOT raw rails
    // (the equivalence test proves these agree). A null execName is a rail crossing / unsupported
    // shape — the current binaries can't execute it (that needs the Stage-2 bridge), so fail closed
    // uniformly here with the router's plan attached.
    let plan = null, execName = null;
    try {
      plan = settlementPlanForSide(side, payRail, recvRail);
      execName = planExecutionName(side, plan);
    } catch (e) { console.error('[router] plan failed', e && e.message); }
    console.error(`[router] side=${side} pay=${payRail} recv=${recvRail} btcLeg=${plan ? plan.btcLeg.rail : '?'} assetLeg=${plan ? plan.assetLeg.rail : '?'} -> ${execName || 'NO-BINARY(bridge/unsupported)'}`);
    if (!execName) {
      return resolve({ ok: false, finality: 'unsupported',
        error: `pay=${payRail}/recv=${recvRail} for a ${side} needs the settlement bridge (a rail crossing the deployed binaries can't execute yet). `
             + 'Use both-Lightning, both-on-chain, or a supported mixed shape.',
        settlement_plan: plan ? { btcLeg: plan.btcLeg.rail, assetLeg: plan.assetLeg.rail, bridged: !plan.happyCoincidence } : null });
    }
    // Map (side, payRail, recvRail) -> the submarine CLI. The three deployed shapes:
    //   asset-on-chain <-> BTC-LN (xsubbuy/xsublift, via -seq-rpc/-seq-wallet), and
    //   the MIRROR asset-over-LN + BTC-on-chain (xsubas, via -btc-rpc/-asset-ln-socket).
    // The SEQ_RPC/SEQ_WALLET config is required ONLY by the on-chain-asset submarine
    // branches; the sub-asset branch has no on-chain asset leg, so it is checked there.
    const stateFile = path.join(os.tmpdir(), `lsp-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    let args;
    let inbound = null;          // set for a per-user sub-asset receive (JIT inbound record)
    const perUser = !!(node_key && asset_bolt11 && payment_hash);
    // SUB-ASSET SELL: pay the asset OVER LIGHTNING, receive BTC ON-CHAIN (mirror of the buy).
    // The maker (ln_direction=5) locks BTC on-chain + holds an asset invoice on H; the LSP
    // commands the USER's hosted asset node (node_key) to pay the held asset by bare hash
    // (device co-signs), learns P, and RETURNS P + the BTC HTLC terms for the WALLET to claim
    // on-chain with its device key. The LSP never claims the BTC HTLC -> non-custodial.
    if (execName === 'xsubas-sell') {
      if (!CFG.subasBtcRpc || !CFG.subasSellRelay) {
        return resolve({ ok: false, finality: 'unsupported',
          error: 'the sub-asset SELL rail is not configured on this LSP (set SUBAS_BTC_RPC + SUBAS_SELL_RELAY + a sub-asset-sell maker).' });
      }
      if (!node_key || !btc_claim_pub) {
        return resolve({ ok: false, error: 'sub-asset sell requires node_key (the hosted asset node that pays over LN) + btc_claim_pub (the wallet device claim pubkey that claims the BTC on-chain)' });
      }
      const { rpc: userRpc, rec } = targetFor('seq', assetId, node_key);
      if (!userRpc || !rec) {
        return resolve({ ok: false, error: 'user node not provisioned for this asset (POST /node/provision first)' });
      }
      const sellArgs = ['xsubas-sell', '-asset', assetId, '-relay', CFG.subasSellRelay,
        '-btc-rpc', CFG.subasBtcRpc, '-btc-chain', CFG.subasBtcChain,
        '-asset-ln-socket', userRpc, '-btc-claim-pub', btc_claim_pub,
        '-min-btc-conf', String(CFG.subasMinBtcConf), '-json'];
      // Lift a SPECIFIC resting offer (order-book take) when the wallet names one.
      if (offer_id) sellArgs.push('-offer-id', String(offer_id));
      if (maker_pubkey) sellArgs.push('-maker-pubkey', String(maker_pubkey));
      const t0s = Date.now();
      return execFile(CFG.seqobCli, sellArgs, { timeout: CFG.mixedTimeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        let j = null;
        for (const line of (stdout || '').trim().split('\n').reverse()) {
          const s = line.trim();
          if (s.startsWith('{') && s.endsWith('}')) { try { j = JSON.parse(s); break; } catch { /* keep scanning */ } }
        }
        const dt = Date.now() - t0s;
        if (j && j.settled) {
          return resolve({
            ok: true, side: 'sell', asset: assetId, asset_label: assetLabel(assetId),
            rail: 'mixed', pay_rail: 'ln', recv_rail: 'chain',
            settled: true, per_user: true, node_key,
            hash_h: j.hash_h, preimage: j.preimage,
            maker_ln_node_id: j.maker_ln_node_id, btc_htlc: j.btc_htlc,
            finality: 'confirming', anchor_bound: true, eta_seconds: Math.round(dt / 1000),
            note: 'Sub-asset SELL: you paid the asset over Lightning. Claim the BTC on-chain with your device key using the returned preimage + btc_htlc (the LSP does not hold your claim key).',
            settled_ms: dt, requested_amount: amount ?? null,
          });
        }
        return resolve({ ok: false,
          error: (j && j.error) ? `sub-asset sell failed: ${j.error}` : (err ? `sub-asset sell failed: ${err.message}` : 'sub-asset sell did not settle'),
          detail: out.split('\n').filter(Boolean).slice(-6).join(' | '), settled_ms: dt });
      });
    }
    if (execName === 'xsubas') {
      // SUB-ASSET: pay BTC ON-CHAIN, receive the asset OVER LIGHTNING. The LSP funds the
      // BTC HTLC from its bitcoind wallet; a sub-asset (ln_direction=4) maker on
      // SUBAS_RELAY pays the asset invoice. Two receive targets:
      //   PER-USER (node_key + asset_bolt11 + payment_hash): the invoice was made by the
      //     DEVICE on its OWN hosted node with the device's OWN preimage (non-custodial).
      //     The LSP JIT-provisions inbound to that node, then drives xsubas in
      //     external-invoice mode (never minting/settling P). This is the real feature.
      //   SHARED (no node_key): the legacy path — invoice minted on CFG.subasAssetLn (the
      //     LSP's own node). Kept for smoke tests; NOT a per-user receive.
      if (!CFG.subasBtcRpc) {
        return resolve({ ok: false, finality: 'unsupported',
          error: 'the sub-asset rail is not configured on this LSP (set SUBAS_BTC_RPC + a sub-asset maker on SUBAS_RELAY).' });
      }
      let assetLnSock, extraArgs;
      if (perUser) {
        const { rpc: userRpc, rec } = targetFor('seq', assetId, node_key);
        if (!userRpc || !rec) {
          return resolve({ ok: false, error: 'user node not provisioned for this asset (POST /node/provision first)' });
        }
        // (a) ensure the user's node has inbound for the asset (idempotent).
        try {
          inbound = await provisionInbound({ nodeKey: node_key, assetId, amount: Number(asset_amount) || 0 });
        } catch (e) {
          return resolve({ ok: false, error: `inbound provisioning failed: ${e.message}` });
        }
        // (b) the invoice lives on the USER's node; the device holds P.
        assetLnSock = userRpc;
        extraArgs = ['-asset-bolt11', asset_bolt11, '-payment-hash', payment_hash];
      } else {
        if (!CFG.subasAssetLn) {
          return resolve({ ok: false, finality: 'unsupported',
            error: 'the shared sub-asset rail is not configured (set SUBAS_ASSET_LN), or pass node_key + asset_bolt11 + payment_hash for a per-user receive.' });
        }
        assetLnSock = CFG.subasAssetLn;
        extraArgs = ['-asset-invoice', 'plain'];
      }
      // EXTERNAL BTC (non-custodial): when the wallet supplies btc_htlc, the DEVICE
      // funded+signed the BTC HTLC from the USER's own BTC. Drop -btc-wallet (the LSP
      // fronts nothing) and RELAY the HTLC; the maker verifies it on-chain, pays the
      // device's asset invoice (the device's node auto-settles, revealing P to the maker),
      // then claims the HTLC with P. Requires the per-user path (device invoice on its own
      // node). Absent btc_htlc = the legacy LSP-fronted path (-btc-wallet).
      const bh = btc_htlc && btc_htlc.txid ? btc_htlc : null;
      if (bh && !perUser) {
        return resolve({ ok: false, error: 'external-BTC buy requires node_key + asset_bolt11 + payment_hash (the device invoice on its own node) alongside btc_htlc (the device-funded HTLC)' });
      }
      if (bh) {
        args = ['xsubas', '-asset', assetId, '-relay', CFG.subasRelay,
          '-btc-rpc', CFG.subasBtcRpc, '-btc-chain', CFG.subasBtcChain,      // no -btc-wallet: the DEVICE funded the HTLC
          '-btc-htlc-txid', String(bh.txid), '-btc-htlc-vout', String(bh.vout),
          '-btc-htlc-amount', String(bh.amount), '-btc-htlc-script', String(bh.redeem_script),
          '-btc-locktime', String(bh.cltv), '-btc-refund-pub', String(bh.taker_refund_pub),
          '-asset-ln-socket', assetLnSock, '-min-btc-conf', String(CFG.subasMinBtcConf),
          ...extraArgs, '-state-file', stateFile];
        if (offer_id) args.push('-offer-id', String(offer_id));
        if (maker_pubkey) args.push('-maker-pubkey', String(maker_pubkey));
      } else {
        args = ['xsubas', '-asset', assetId, '-relay', CFG.subasRelay,
          '-btc-rpc', CFG.subasBtcRpc, '-btc-wallet', CFG.subasBtcWallet, '-btc-chain', CFG.subasBtcChain,
          '-asset-ln-socket', assetLnSock, '-min-btc-conf', String(CFG.subasMinBtcConf),
          ...extraArgs, '-state-file', stateFile];
      }
    } else {
      if (!CFG.seqRpc || !CFG.seqWallet) {
        return resolve({ ok: false, error: 'the mixed (submarine) rail is not configured on this LSP (set SEQ_RPC + SEQ_WALLET)' });
      }
      let cmd, extra;
      if (execName === 'xsubbuy') {
        cmd = 'xsubbuy';                                       // BTC-LN in, asset on-chain out
        extra = ['-ln-socket', CFG.mixedBtcRpc, '-min-anchor-depth', String(CFG.minAnchorDepth)];
        if (CFG.mixedMax0conf > 0) extra.push('-max-0conf', String(CFG.mixedMax0conf));
      } else if (execName === 'xsublift') {
        cmd = 'xsublift';                                      // asset on-chain in, BTC-LN out
        extra = ['-ln-socket', CFG.mixedBtcRpc];
      } else {
        // Unreachable: the top-level null guard already fails closed. Defensive belt-and-suspenders.
        return resolve({ ok: false, finality: 'unsupported',
          error: `mixed pay=${payRail}/recv=${recvRail} for a ${side} is not a deployed submarine.` });
      }
      args = [cmd, '-asset', assetId, '-relay', CFG.relay,
        '-seq-rpc', CFG.seqRpc, '-seq-wallet', CFG.seqWallet, '-state-file', stateFile, ...extra];
    }
    const t0 = Date.now();
    execFile(CFG.seqobCli, args, { timeout: CFG.mixedTimeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      // xsubbuy/xsublift log "SUBMARINE SWAP SETTLED"; xsubas logs "SUB-ASSET SWAP SETTLED".
      const settled = /SUB(?:MARINE|-ASSET) SWAP SETTLED/i.test(out);
      // The preimage + on-chain outpoint are persisted to the session file. The on-chain
      // leg is the ASSET (seq_leg_txid) for xsubbuy/xsublift, or the BTC HTLC (btc_leg_txid)
      // for xsubas.
      let preimage = null, htlcTxid = null;
      try {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        preimage = st.preimage_hex || st.secret_hex || st.seq_preimage_hex || null;
        htlcTxid = st.seq_leg_txid || st.btc_leg_txid || null;
      } catch { /* file may be absent on early failure */ }
      const cm = out.match(/claimed the asset in ([0-9a-f]{64})/i);
      try { fs.unlinkSync(stateFile); } catch { /* best-effort */ }
      const dt = Date.now() - t0;
      // PER-USER (device-preimage): the preimage is DEVICE-HELD and NEVER returned;
      // the settlement signal is `settled:true` (the device's node auto-settled its
      // invoice = the asset was received). The wallet observes the receive on its own
      // node. SHARED (smoke-test) path may surface the LSP-minted preimage.
      if (settled) return resolve({
        ok: true, side, asset: assetId, asset_label: assetLabel(assetId),
        rail: 'mixed', pay_rail: payRail, recv_rail: recvRail,
        settled: true,
        ...(perUser ? { per_user: true, node_key, inbound } : { preimage }),
        htlc_txid: htlcTxid, claim_txid: cm ? cm[1] : null,
        // HONEST: the BTC leg is an on-chain HTLC — final to its Bitcoin depth.
        finality: 'confirming', anchor_bound: true, eta_seconds: Math.round(dt / 1000),
        note: perUser
          ? 'Sub-asset receive on your own hosted node (preimage device-held, not returned).'
          : 'Mixed submarine swap: one leg on Lightning, one anchored on-chain. Anchor-bound to Bitcoin.',
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

// Read-only JSON-RPC to the Sequentia node (CFG.seqRpc = http://user:pass@host:port).
// Used only by the public /anchor read below.
async function seqRpcCall(method, params = []) {
  if (!CFG.seqRpc) throw new Error('SEQ_RPC not configured');
  const u = new URL(CFG.seqRpc);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  const endpoint = `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'lsp-anchor', method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error((j.error && j.error.message) || `seq rpc ${method} error`);
  return j.result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'seqln-lsp' });
  // GET /anchor -> the Sequentia tip's CURRENT Bitcoin-anchor height. The cross-chain anchor
  // gate polls this so a lagging/contested anchor is a WAIT, not a stale-snapshot dead-end.
  // Public chain data, so it sits before the token check like /health.
  if (req.method === 'GET' && url.pathname === '/anchor') {
    try {
      const info = await seqRpcCall('getblockchaininfo');
      const blk = await seqRpcCall('getblock', [info.bestblockhash]);
      return send(res, 200, { ok: true, height: info.blocks,
        anchor_height: (blk.anchorheight ?? null), anchor_hash: (blk.anchorhash ?? null) });
    } catch (e) {
      return send(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized (Bearer token required)' });
  try {
    // ----- ORDER BOOK (sub-asset rail): the wallet gates its BUY/SELL toggles on live
    // resting liquidity, and users post their own resting offers (permissionless). Offers
    // rest on the sub-asset relays (localhost, so the wallet reaches them via the LSP).
    //   GET /book?asset=<id> -> { sell_available, buy_available, sell_offers[], buy_offers[] }
    //   ln_direction 5 = resting BUY-asset-with-BTC (a party locks BTC on-chain) => user can SELL.
    //   ln_direction 4 = resting SELL-asset-for-BTC (a party pays asset over LN, INTERACTIVE) => user can BUY.
    // GET /book/unified?asset=<id> -> ONE price-sorted book merging the on-chain cross relay AND
    // the sub-asset LN relays, rail as metadata (Stage 2, rail-agnostic matching). Taker selection
    // is best-price rail-blind; the settlement router bridges the rails on take. The wallet reads
    // this instead of the two separate books. Each entry carries its raw offer so the wallet can
    // construct the take (cross HTLC or sub-asset LN) from the same payload.
    if (req.method === 'GET' && url.pathname === '/book/unified') {
      const assetId = resolveAsset(url.searchParams.get('asset'));
      if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: '?asset=<sequentia asset id> is required (not BTC)' });
      const relays = [...new Set([CFG.relay, CFG.subasRelay, CFG.subasSellRelay].filter(Boolean))];
      const seen = new Set(), raw = [];
      for (const relay of relays) {
        try {
          const rr = await fetch(`${relay}/v1/market/${assetId}/BTC/orderbook`, { signal: AbortSignal.timeout(5000) });
          if (!rr.ok) continue;
          for (const o of ((await rr.json()).offers || [])) {
            const key = (o.maker_pubkey || '') + ':' + (o.offer_id || '');
            if (seen.has(key)) continue; seen.add(key);
            raw.push(o);
          }
        } catch { /* a down relay just contributes no liquidity */ }
      }
      const book = buildUnifiedBook(raw);
      return send(res, 200, { ok: true, asset: assetId,
        asks: book.asks, bids: book.bids,
        best_ask: book.asks[0] || null, best_bid: book.bids[0] || null,
        counts: { asks: book.asks.length, bids: book.bids.length } });
    }
    if (req.method === 'GET' && url.pathname === '/book') {
      const assetId = resolveAsset(url.searchParams.get('asset'));
      if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: '?asset=<sequentia asset id> is required (not BTC)' });
      const relays = [...new Set([CFG.subasSellRelay, CFG.subasRelay].filter(Boolean))];
      const seen = new Set(), sell = [], buy = [];
      for (const relay of relays) {
        let offers = [];
        try {
          const rr = await fetch(`${relay}/v1/market/${assetId}/BTC/orderbook`, { signal: AbortSignal.timeout(5000) });
          if (rr.ok) offers = (await rr.json()).offers || [];
        } catch { /* a down relay just contributes no liquidity */ }
        for (const o of offers) {
          const lt = o.lightning || {}, dir = Number(lt.ln_direction);
          if (dir !== 4 && dir !== 5) continue;
          const key = (o.maker_pubkey || '') + ':' + (o.offer_id || '');
          if (seen.has(key)) continue; seen.add(key);
          if (dir === 5) {
            const asset_amount = Number(o.want_amount || 0), btc_sats = Number(o.offer_amount || 0);
            sell.push({ offer_id: o.offer_id, maker_pubkey: o.maker_pubkey, ln_direction: 5,
              asset_amount, btc_sats, price_sats_per_atom: asset_amount ? btc_sats / asset_amount : null,
              maker_ln_node: o.maker_ln_node_pubkey || null, onchain_cltv: Number(lt.onchain_cltv || 0),
              expires_at: Number(o.expires_at_unix || 0), interactive: false });
          } else {
            const asset_amount = Number(o.offer_amount || 0), btc_sats = Number(o.want_amount || 0);
            buy.push({ offer_id: o.offer_id, maker_pubkey: o.maker_pubkey, ln_direction: 4,
              asset_amount, btc_sats, price_sats_per_atom: asset_amount ? btc_sats / asset_amount : null,
              maker_ln_node: o.maker_ln_node_pubkey || null, ln_connect_hints: o.ln_connect_hints || null,
              // the maker identity pubkey the wallet locks its BTC HTLC's CLAIM branch to, and the
              // maker's suggested on-chain CLTV delta (the wallet sets T_btc = btc_tip + this-or-more).
              maker_claim_pub: lt.maker_claim_pub || null, onchain_cltv: Number(lt.onchain_cltv || 0),
              expires_at: Number(o.expires_at_unix || 0), interactive: true });
          }
        }
      }
      return send(res, 200, { ok: true, asset: assetId, asset_label: assetLabel(assetId),
        sell_available: sell.length > 0, buy_available: buy.length > 0, sell_offers: sell, buy_offers: buy });
    }

    // POST /offer { offer: <signed Offer protojson> } -> forward to the sub-asset relay.
    // The wallet builds + SIGNS the offer (non-custodial); the LSP only relays the bytes and
    // routes by ln_direction (5 -> sell relay, 4 -> buy relay). Posting is permissionless.
    if (req.method === 'POST' && url.pathname === '/offer') {
      const body = await readBody(req);
      const offer = body && body.offer;
      const dir = Number(offer && offer.lightning && offer.lightning.ln_direction);
      if (!offer || (dir !== 4 && dir !== 5)) return send(res, 400, { ok: false, error: 'body { offer: <signed Offer> } with lightning.ln_direction 4 (resting SELL) or 5 (resting BUY)' });
      if (!offer.maker_sig || !offer.maker_pubkey) return send(res, 400, { ok: false, error: 'offer must be SIGNED (maker_sig + maker_pubkey); the LSP never signs on your behalf' });
      const relay = dir === 5 ? CFG.subasSellRelay : CFG.subasRelay;
      if (!relay) return send(res, 503, { ok: false, error: `no sub-asset relay configured for ln_direction=${dir}` });
      try {
        const rr = await fetch(`${relay}/v1/offers`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(offer), signal: AbortSignal.timeout(8000) });
        const txt = await rr.text();
        if (!rr.ok) return send(res, 502, { ok: false, error: 'relay rejected the offer: ' + txt.slice(0, 240) });
        let st = null; try { st = JSON.parse(txt); } catch { /* status is best-effort */ }
        return send(res, 200, { ok: true, offer_id: (st && st.offer_id) || offer.offer_id,
          status: (st && st.status) || 'OPEN', ln_direction: dir,
          note: dir === 4 ? 'Resting SELL is INTERACTIVE: your LN node must be reachable at settlement to pay the asset when a taker locks BTC.' : 'Resting BUY: you lock BTC on-chain when taken.' });
      } catch (e) { return send(res, 502, { ok: false, error: 'post to relay failed: ' + e.message }); }
    }
    // POST /nodes/list { keys:[...] } -> { provisioned:[{key,asset_id,chain}] }.
    // Resolve candidate device node keys against the PROV REGISTRY ONLY (getByKey re-reads
    // the registry file; it NEVER calls getinfo/listpeerchannels). This is deliberate: a node
    // blocked at HSM init (waiting for its signer) can't answer its RPC, but must still be
    // discoverable so the wallet can connect the signer and un-block it (the reconnect
    // chicken-and-egg). Self-scoped: only keys that resolve to a node this device provisioned
    // come back (a key the device couldn't derive simply isn't in the registry). Keys are
    // lowercased (getByKey lowercases too).
    if (req.method === 'POST' && url.pathname === '/nodes/list') {
      const body = await readBody(req);
      const keys = body && Array.isArray(body.keys) ? body.keys : null;
      if (!keys) return send(res, 400, { ok: false, error: 'body { keys: ["seq:<assetHex>:<devicePub>" | "btc:<devicePub>", ...] } required' });
      const provisioned = [], seen = new Set();
      for (const raw of keys) {
        if (typeof raw !== 'string') continue;
        const key = raw.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const rec = PROV && PROV.getByKey(key);
        if (rec) provisioned.push({ key: rec.key || key, asset_id: rec.asset_id || null, chain: rec.chain || null });
      }
      return send(res, 200, { provisioned });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      // `?nodes=<key1>,<key2>` = the requesting device's own provision keys, so /status also
      // reports that device's provisioned-node channels (see status()). Only the device that
      // derived a key knows it, so this is self-scoped.
      const deviceKeys = (url.searchParams.get('nodes') || '').split(',').map((s) => s.trim()).filter(Boolean);
      return send(res, 200, await status(deviceKeys));
    }
    // Per-asset hosted-node provisioning: spin up (or re-attach) a SeqLN node for an
    // asset, keyed to the connecting device. Non-custodial (keyless node + device pin).
    if (req.method === 'POST' && url.pathname === '/node/provision') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'bad json body' });
      const chain = CHAINS[String(body.chain || 'seq').toLowerCase()] || 'seq';
      if (!/^[0-9a-fA-F]{66}$/.test(body.device_transport_pubkey || '')) {
        return send(res, 400, { ok: false, error: 'device_transport_pubkey (33-byte compressed hex) is required — the node pins it so only your device can sign' });
      }
      let provArgs;
      if (chain === 'btc') {
        // Per-user BTC: a keyless testnet4 node keyed to THIS device (not the shared demo).
        if (!PROV.CFG.chains.btc) return send(res, 501, { ok: false, error: 'per-user BTC provisioning is not enabled on this LSP (set BTC_RPC_PORT + BTC_CLI)' });
        provArgs = { chain: 'btc', deviceTransportPubkey: body.device_transport_pubkey, label: body.label || 'BTC' };
      } else {
        const assetId = resolveAsset(body.asset);
        if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: 'asset must be a Sequentia asset (GOLD or a 32-byte hex id), or pass chain:"btc"' });
        provArgs = { chain: 'seq', assetId, deviceTransportPubkey: body.device_transport_pubkey, label: body.label || assetLabel(assetId) };
      }
      try {
        const rec = await PROV.provision(provArgs);
        return send(res, 200, { ok: true, chain: rec.chain || 'seq', key: rec.key, asset_id: rec.asset_id, label: rec.label, status: rec.status,
          node_id: rec.node_id, host_pubkey: rec.host_pubkey, ws_port: rec.ws_port,
          public_ws_path: rec.public_ws_path, network: rec.network });
      } catch (e) { return send(res, 409, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Readiness of ONE provisioned node (the wallet polls this after provisioning, showing a
    // "preparing your node…" progress, before it asks for a deposit address). A fresh node
    // boots + rescans, so its rpc socket is absent for the first seconds; `ready` flips true
    // once getinfo answers. Fast + non-blocking (a single getinfo attempt with an 8s cap).
    // POST /node/invoice { node_key, asset, amount /* asset sats */, preimage?, payment_hash? }
    //   -> { bolt11, payment_hash }.  Mint an asset invoice on the node_key's OWN hosted node
    //   (self-scoped). Two custody modes:
    //     HODL (recommended, LSP stays blind to P): pass `payment_hash` (= H). The node holds
    //       the payment by H and does NOT learn P; the DEVICE settles later via /node/settle
    //       AFTER the maker's payment is held. Requires the holdinvoice plugin on the node.
    //     NORMAL (weaker): pass `preimage` (= P). The node is created WITH P and auto-settles
    //       on payment, so the node/LSP learns P at mint time (see the buy P-custody note).
    if (req.method === 'POST' && url.pathname === '/node/invoice') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const body = await readBody(req);
      const nodeKey = ((body && body.node_key) || '').toLowerCase();
      const assetId = resolveAsset(body && body.asset);
      const amount = Number(body && body.amount);
      if (!nodeKey || !assetId || !(amount > 0)) return send(res, 400, { ok: false, error: 'body { node_key, asset, amount (asset sats), preimage? | payment_hash? } required' });
      const rec = PROV.getByKey(nodeKey);
      if (!rec || !rec.rpc) return send(res, 404, { ok: false, error: 'unknown node key (POST /node/provision first)' });
      const amtMsat = String(Math.round(amount) * 1000);           // asset sats -> asset msat
      const label = 'buy-' + crypto.randomUUID();
      const H = body && body.payment_hash ? String(body.payment_hash).toLowerCase() : null;
      const P = body && body.preimage ? String(body.preimage).toLowerCase() : null;
      try {
        let inv;
        if (H) {
          // HODL: register H to be HELD (holdinvoice-seq creates NO bolt11 — the maker pays the
          // hash directly via sendpay to this node id). The DEVICE holds P; settle via /node/settle.
          inv = await lnrpc('holdinvoice', [H, amtMsat, label, 'asset buy (HODL)'], rec.rpc);
          const ni = await lnrpc('getinfo', [], rec.rpc).catch(() => ({}));
          return send(res, 200, { ok: true, bolt11: null, payment_hash: H, hodl: true, node_id: ni.id || rec.node_id || null, amount_msat: Number(amtMsat) });
        } else {
          // NORMAL invoice. Use keyword args so the optional `preimage` can be set without
          // positional padding: lightning-cli -k invoice amount_msat=.. label=.. preimage=..
          const kv = [`amount_msat=${amtMsat}`, `label=${label}`, 'description=asset buy'];
          if (P) kv.push(`preimage=${P}`);
          inv = await lnrpcKw('invoice', kv, rec.rpc);
        }
        return send(res, 200, { ok: true, bolt11: inv.bolt11, payment_hash: inv.payment_hash, hodl: !!H });
      } catch (e) {
        return send(res, 502, { ok: false, error: `invoice: ${e.message}` });
      }
    }

    // GET /node/invoice-status?node=<key>&payment_hash=<H> -> { state, held, settled }. Poll this
    // after /swap {side:buy} so the wallet knows when the maker's payment is HELD (state 'accepted')
    // and it is safe to /node/settle. Uses the holdinvoice plugin's holdinvoicelookup (registry-scoped).
    if (req.method === 'GET' && url.pathname === '/node/invoice-status') {
      if (!PROV) return send(res, 501, { ok: false, error: 'provisioning not enabled' });
      const nodeKey = (url.searchParams.get('node') || '').toLowerCase();
      const H = (url.searchParams.get('payment_hash') || '').toLowerCase();
      if (!nodeKey || !H) return send(res, 400, { ok: false, error: '?node=<key>&payment_hash=<H> required' });
      const rec = PROV.getByKey(nodeKey);
      if (!rec || !rec.rpc) return send(res, 404, { ok: false, error: 'unknown node key' });
      try {
        const l = await lnrpc('holdinvoicelookup', [H], rec.rpc);
        return send(res, 200, { ok: true, state: l.state,
          held: l.state === 'accepted', settled: l.state === 'settled' });
      } catch (e) { return send(res, 502, { ok: false, error: `lookup: ${e.message}` }); }
    }

    // POST /node/settle { node_key, payment_hash, preimage } -> { settled:true }.  Device-settle
    // a HODL invoice with P, releasing the maker's HELD payment to the taker and revealing P to
    // the maker via the LN settle. Call ONLY after the maker's payment is held (so revealing P
    // is safe). Self-scoped. Requires the holdinvoice plugin.
    if (req.method === 'POST' && url.pathname === '/node/settle') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const body = await readBody(req);
      const nodeKey = ((body && body.node_key) || '').toLowerCase();
      const H = ((body && body.payment_hash) || '').toLowerCase();
      const P = ((body && body.preimage) || '').toLowerCase();
      if (!nodeKey || !H || !P) return send(res, 400, { ok: false, error: 'body { node_key, payment_hash, preimage } required' });
      const rec = PROV.getByKey(nodeKey);
      if (!rec || !rec.rpc) return send(res, 404, { ok: false, error: 'unknown node key' });
      try {
        await lnrpc('holdinvoicesettle', [H, P], rec.rpc);
        return send(res, 200, { ok: true, settled: true });
      } catch (e) {
        return send(res, 502, { ok: false, error: `settle: ${e.message}` });
      }
    }

    // POST /node/receive { node_key, amount (asset sats), description? } -> { bolt11, payment_hash }.
    // A PLAIN (non-HODL) invoice to RECEIVE over Lightning into the user's own hosted node. The node
    // signs the bolt11 with its node key (device-co-signed), so its signer must be online. Distinct
    // from /node/invoice (which is the HODL buy path); this is the generic Receive-tab invoice.
    if (req.method === 'POST' && url.pathname === '/node/receive') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const body = await readBody(req);
      const nodeKey = ((body && body.node_key) || '').toLowerCase();
      const amount = Number(body && body.amount);
      if (!nodeKey || !(amount > 0)) return send(res, 400, { ok: false, error: 'body { node_key, amount (asset sats), description? } required' });
      const rec = PROV.getByKey(nodeKey);
      if (!rec || !rec.rpc) return send(res, 404, { ok: false, error: 'unknown node key (POST /node/provision first)' });
      const amtMsat = String(Math.round(amount) * 1000);
      const label = 'recv-' + crypto.randomUUID();
      const desc = (body && body.description) ? String(body.description).slice(0, 128) : 'Lightning receive';
      try {
        const inv = await lnrpcKw('invoice', [`amount_msat=${amtMsat}`, `label=${label}`, `description=${desc}`], rec.rpc);
        return send(res, 200, { ok: true, bolt11: inv.bolt11, payment_hash: inv.payment_hash, amount_msat: Number(amtMsat) });
      } catch (e) { return send(res, 502, { ok: false, error: `invoice: ${e.message}` }); }
    }

    // POST /node/pay { node_key, bolt11 } -> { paid, preimage, amount_msat, destination }. The user's
    // hosted node PAYS a Lightning invoice (device co-signs every HTLC). Non-custodial: the LSP commands
    // `pay` but cannot sign it. retry_for bounds the routing attempt so a dead route can't hang forever.
    if (req.method === 'POST' && url.pathname === '/node/pay') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const body = await readBody(req);
      const nodeKey = ((body && body.node_key) || '').toLowerCase();
      const bolt11 = String((body && body.bolt11) || '').trim();
      if (!nodeKey || !bolt11) return send(res, 400, { ok: false, error: 'body { node_key, bolt11 } required' });
      const rec = PROV.getByKey(nodeKey);
      if (!rec || !rec.rpc) return send(res, 404, { ok: false, error: 'unknown node key' });
      try {
        const r = await lnrpcKw('pay', [`bolt11=${bolt11}`, 'retry_for=45'], rec.rpc);
        return send(res, 200, { ok: true, paid: r.status === 'complete', preimage: r.payment_preimage || null,
          amount_msat: r.amount_msat != null ? Number(r.amount_msat) : null, destination: r.destination || null });
      } catch (e) { return send(res, 502, { ok: false, error: `pay: ${e.message}` }); }
    }

    if (req.method === 'GET' && url.pathname === '/node/getinfo') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const nodeKey = url.searchParams.get('node') || '';
      const rec = PROV.getByKey(nodeKey);
      if (!rec) return send(res, 404, { ok: false, error: 'unknown node key' });
      const info = await PROV.getinfo(rec);        // null while the node is still booting
      return send(res, 200, { ok: true, ready: !!info, node_id: (info && info.id) || rec.node_id || null,
        blockheight: (info && info.blockheight) || null,
        synced: !!(info && info.warning_lightningd_sync == null && info.blockheight != null) });
    }
    // Stranded-deposit report for ONE provisioned node: the on-chain balance not yet in a channel.
    // The wallet polls this after a "Move to Lightning" to auto-detect "deposit landed, no channel"
    // (onchain_msat > 0 && channels === 0 -> stranded) and (re)call POST /channel/open.
    if (req.method === 'GET' && url.pathname === '/node/onchain') {
      if (!PROV) return send(res, 501, { ok: false, error: 'per-asset node provisioning is not enabled on this LSP' });
      const nodeKey = url.searchParams.get('node') || '';
      const rec = PROV.getByKey(nodeKey);
      if (!rec) return send(res, 404, { ok: false, error: 'unknown node key' });
      const chain = rec.chain === 'btc' ? 'btc' : 'seq';
      // Probe reachability first: a keyless node blocked at HSM init (no device signer) can't
      // answer RPC, so onchain would read 0 — which is "unknown", NOT "no deposit". node_up lets
      // the wallet say "keep your wallet open so the signer connects" instead of "nothing here".
      let channels = 0, node_up = false;
      try { const ns = await nodeStatus(rec.rpc, 'prov'); channels = ns.channels.length; node_up = true; } catch { /* down/booting/awaiting-signer */ }
      const on = node_up
        ? await onchainForReport(rec.rpc, chain, chain === 'btc' ? null : rec.asset_id).catch(() => ({ onchain_msat: 0, outputs: [] }))
        : { onchain_msat: 0, outputs: [] };
      return send(res, 200, { ok: true, node_key: rec.key, node_id: rec.node_id, asset_id: rec.asset_id,
        chain, node_up, onchain_msat: on.onchain_msat, outputs: on.outputs || [], channels,
        stranded: node_up && on.onchain_msat > 0 && channels === 0 });
    }
    // List the provisioned per-device nodes (with a live node-id refresh). Refresh by KEY:
    // several device-scoped nodes can share one asset id, so each is refreshed on its own key.
    if (req.method === 'GET' && url.pathname === '/node/list') {
      if (!PROV) return send(res, 200, { ok: true, nodes: [] });
      const nodes = [];
      for (const rec of PROV.list()) {
        const r = await PROV.refresh(rec.key);
        nodes.push({ key: r.key, chain: r.chain || 'seq', asset_id: r.asset_id, label: r.label, status: r.status, node_id: r.node_id,
          host_pubkey: r.host_pubkey, ws_port: r.ws_port, public_ws_path: r.public_ws_path, network: r.network });
      }
      return send(res, 200, { ok: true, nodes });
    }
    // "Move to Lightning": the hosted node's on-chain deposit address for a chain/asset.
    if (req.method === 'GET' && url.pathname === '/channel/deposit') {
      const chain = CHAINS[String(url.searchParams.get('chain') || '').toLowerCase()];
      if (!chain) return send(res, 400, { ok: false, error: "chain must be 'btc' or 'seq'" });
      const nodeKey = url.searchParams.get('node') || null;
      const assetId = chain === 'seq' ? (resolveAsset(url.searchParams.get('asset') || 'GOLD') || CFG.gold) : null;
      const { rpc } = targetFor(chain, assetId, nodeKey);
      if (!rpc) return send(res, 501, { ok: false, error: `no hosted Lightning node for that ${chain === 'btc' ? 'BTC node' : 'asset'} — provision it first (POST /node/provision)` });
      return send(res, 200, await channelDeposit(chain, assetId, nodeKey));
    }
    // Poll a "Move to Lightning" channel-open job.
    if (req.method === 'GET' && url.pathname.startsWith('/channel/open/')) {
      const id = url.pathname.slice('/channel/open/'.length);
      const job = channelJobs.get(id);
      if (!job) return send(res, 404, { ok: false, error: 'unknown channel job id' });
      // ok:true = the poll succeeded; the job's own `status` (active|failed|…) is the
      // source of truth, so the wallet can read a failed job's error without a throw.
      return send(res, 200, { ...job, ok: true });
    }
    // Start a "Move to Lightning" channel-open (background: watch deposit -> fundchannel).
    if (req.method === 'POST' && url.pathname === '/channel/open') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'bad json body' });
      const r = startChannelOpen(body);
      return send(res, r.ok ? 202 : 400, r);
    }
    // JIT INBOUND: give the user's OWN hosted asset node inbound liquidity so it can
    // RECEIVE (the missing half of Move-to-Lightning). The LP (SUBAS_LP_RPC) opens a
    // 0-conf asset channel TOWARD the user's node. Idempotent, fail-closed. Call this
    // BEFORE creating the device invoice + POST /swap for a per-user sub-asset receive.
    //   POST /channel/inbound {node_key, asset, amount}  (amount in ASSET SATS)
    if (req.method === 'POST' && url.pathname === '/channel/inbound') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'bad json body' });
      const assetId = resolveAsset(body.asset);
      if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: 'asset must be a Sequentia asset id' });
      const amount = Number(body.amount || 0);
      if (!(amount > 0)) return send(res, 400, { ok: false, error: 'amount (asset sats to be receivable) is required' });
      try {
        const r = await provisionInbound({ nodeKey: body.node_key, assetId, amount });
        return send(res, 200, r);
      } catch (e) { return send(res, 502, { ok: false, error: String((e && e.message) || e) }); }
    }
    // "Move back to chain": cooperatively close a channel on the user's own hosted node, sending
    // the reclaimed funds straight to the wallet's on-chain address. Device-signed (see closeChannel).
    if (req.method === 'POST' && url.pathname === '/channel/close') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'bad json body' });
      const r = await closeChannel(body);
      return send(res, r.ok ? 200 : 400, r);
    }
    // Poll an over-cap (anchor-gated) mixed swap started asynchronously by POST /swap.
    if (req.method === 'GET' && url.pathname.startsWith('/swap/')) {
      const id = url.pathname.slice('/swap/'.length);
      const job = jobs.get(id);
      if (!job) return send(res, 404, { ok: false, error: 'unknown job id' });
      return send(res, 200, { ok: true, ...job });
    }
    if (req.method === 'POST' && url.pathname === '/swap') {
      const body = await readBody(req);
      if (!body) return send(res, 400, { ok: false, error: 'bad json body' });
      // SUB-ASSET external-BTC HODL BUY: taker pays BTC ON-CHAIN, receives the asset OVER
      // LIGHTNING; the taker's OWN hosted node holds the asset payment by H (holdinvoice-seq,
      // no bolt11) and the DEVICE settles with P out-of-band. Always ASYNC (the maker must
      // PayHash + the device must settle), and the LSP never sees P. Distinct from the legacy
      // asset_bolt11 per-user path (auto-settle); keyed on body.hodl===true. Fires BEFORE the
      // ln/ln default so it never falls through to runSwap (pure-LN).
      if (body.side === 'buy' && body.hodl === true) {
        reapJobs();
        const r = startSubasBuyHodl(body);
        return send(res, r.ok ? 202 : (r.code || 400), r);
      }
      // Rails select the settlement path (default ln/ln = the unchanged pure-LN route).
      // EXCEPTION: a SELL carrying a device btc_claim_pub is a SUB-ASSET sell (asset over
      // Lightning -> BTC ON-CHAIN HTLC, ln_direction=5). The wallet omits rails, so default
      // them to ln/chain here instead of letting it fall through to the pure-LN (xpln) path.
      let payRail = body.payRail, recvRail = body.recvRail;
      if (body.side === 'sell' && body.btc_claim_pub && !payRail && !recvRail) {
        payRail = 'ln'; recvRail = 'chain';
      }
      payRail = payRail || 'ln'; recvRail = recvRail || 'ln';
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
      // MIXED (one leg 'ln', one 'chain') -> a submarine swap. Two shapes settle:
      // asset-on-chain <-> BTC-Lightning (xsubbuy/xsublift, always), and the MIRROR
      // asset-over-LN + BTC-on-chain (xsubas) for a BUY when this LSP is configured with
      // a sub-asset backend (SUBAS_BTC_RPC + SUBAS_ASSET_LN + a maker on SUBAS_RELAY).
      const side = body.side;
      // Sub-asset is reachable when the BTC leg is configured AND either a shared asset
      // node (SUBAS_ASSET_LN, smoke test) or the per-user path (an LP for JIT inbound +
      // the request naming a provisioned node_key) is available.
      const perUserReq = !!(body.node_key && body.asset_bolt11 && body.payment_hash);
      const subasReady = !!(CFG.subasBtcRpc && (CFG.subasAssetLn || (perUserReq && CFG.subasLpRpc)));
      const subasSellReady = !!(CFG.subasBtcRpc && CFG.subasSellRelay);
      // The settlement router names the binary for this (rail-blind-matched) shape — a single
      // source of truth shared with runMixed; the outer gate only adds backend readiness.
      let execName = null;
      try { execName = planExecutionName(side, settlementPlanForSide(side, payRail, recvRail)); } catch {}
      const backendReady = (execName === 'xsubbuy' || execName === 'xsublift') ? true
        : execName === 'xsubas' ? subasReady
        : execName === 'xsubas-sell' ? subasSellReady : false;
      const supported = !!execName && backendReady;
      if (!supported) {
        return send(res, 422, { ok: false, finality: 'unsupported',
          error: `mixed pay=${payRail}/recv=${recvRail} for a ${side} has no maker/backend on this LSP `
               + '(asset-on-chain <-> BTC-Lightning always; asset-over-LN + BTC-on-chain needs a sub-asset backend). '
               + 'Use both-Lightning, both-on-chain, or a supported mixed shape.' });
      }
      // SUB-ASSET SELL always answers SYNCHRONOUSLY: the wallet needs P + the BTC HTLC
      // terms in the response to claim on-chain with its device key.
      if (execName === 'xsubas-sell') {
        const r = await runMixed({ ...body, payRail, recvRail });
        return send(res, r.ok ? 200 : 502, r);
      }
      reapJobs();
      // Under the 0-conf cap -> the submarine skips the anchor-bury wait, so the swap
      // is fast: answer SYNCHRONOUSLY with the preimage. Over the cap (or unknown
      // amount) -> the anchor gate takes many Bitcoin blocks, so run it in the
      // background and hand back a pollable job instead of holding the connection.
      const amt = Number(body.amount || 0);
      const under0conf = CFG.mixedMax0conf > 0 && amt > 0 && amt <= CFG.mixedMax0conf;
      if (under0conf) {
        const r = await runMixed({ ...body, payRail, recvRail });
        if (r.ok) { r.zero_conf = true; r.finality = 'confirming'; }
        return send(res, r.ok ? 200 : 502, r);
      }
      const jobId = crypto.randomUUID();
      const job = { job_id: jobId, status: 'confirming', side, asset: body.asset,
        rail: 'mixed', pay_rail: payRail, recv_rail: recvRail, finality: 'confirming',
        requested_amount: body.amount ?? null, started_ms: Date.now() };
      jobs.set(jobId, job);
      runMixed({ ...body, payRail, recvRail })
        .then((r) => jobs.set(jobId, { ...job, ...r, status: r.ok ? 'settled' : 'failed', done_ms: Date.now() }))
        .catch((e) => jobs.set(jobId, { ...job, status: 'failed', error: String((e && e.message) || e), done_ms: Date.now() }));
      return send(res, 202, { ...job, ok: true,
        poll: `/swap/${jobId}`,
        note: 'over the 0-conf cap: the on-chain leg is anchor-gated to Bitcoin (several blocks). '
            + 'Poll GET /swap/<job_id> for completion; the wallet stays responsive.' });
    }
    send(res, 404, { ok: false, error: 'not found' });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
// ---------------------------------------------------------------------------
// GAP B — the central device-signer WS-ROUTER.
//
// ONE endpoint, `GET /lsp-ws-node/<id>` (WebSocket upgrade), reaches EVERY
// provisioned node: it looks <id> up in the provision registry and byte-bridges
// the browser's WebSocket to that node's Noise responder (127.0.0.1:<signerPort>,
// the hsmd proxy's SEQLN_SIGNER_LISTEN). So a SINGLE static Caddy rule
// `wss://…/lsp-ws-node/*  ->  reverse_proxy 127.0.0.1:<LSP_PORT>` serves all
// nodes — no per-node Caddy edits, ever. Each provision's `public_ws_path` is
// exactly this path. The router is keyless: the Noise_XK handshake + signer
// frames flow end-to-end browser<->proxy; the LSP never sees a plaintext byte.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PREEMPT-ARM WIRING (Specula watchtower, Phase G — withhold-revoke defense).
//
// When a device signer drops MID-ROUND (a commitment_signed is in flight and the
// peer's revoke is still outstanding — an HTLC in any non-terminal state), arm
// speculad to broadcast OUR CURRENT commitment first, so a peer who withholds the
// revoke cannot later force a stale close in their favour. On a clean device
// reconnect, dis-arm. The device-presence signal is the ws-bridge itself (onDrop
// = the device's Noise ws went down; onUp = it is spliced back), which is the only
// authoritative source because the arm/dis-arm must run on the box WHILE the device
// is gone (the browser cannot reach the node RPC then).
//
// This wiring's ONLY responsibility is flipping the boolean. It never computes or
// passes a commit_num: speculad's own guards (broadcast only when
// preempt_commit_num == meta.current_commit_num == armed_commit_num, AND the
// funding outpoint is still unspent) make a stale/revoked broadcast impossible, so
// this is reorg-safe by construction. Idempotent: re-arming/re-disarming is a no-op
// in wt_store_set_preempt_armed (write/unlink), and a completed round auto-clears
// the flag via wt_store_advance regardless. Fail-soft: a node that is itself down
// just skips (a missed disarm is harmless — the next clean advance clears it).
// ---------------------------------------------------------------------------

// A commitment round is complete only once every HTLC is irrevocably committed (or
// removed) — i.e. it sits in a terminal *_ACK_REVOCATION state. Any other htlc state
// (ADD/REMOVE paired with COMMIT / REVOCATION / ACK_COMMIT) means a commitment_signed
// is in flight and the peer revoke is still outstanding: the withhold-revoke window.
function htlcMidRound(state) { return !/ACK_REVOCATION$/.test(String(state || '')); }

const armInflight = new Map();   // rec.key -> Promise: single-flight per node so a flapping link never fires overlapping RPC storms
function armForNode(recRaw, down) {
  const key = recRaw && recRaw.key;
  if (!key) return Promise.resolve();
  const prev = armInflight.get(key) || Promise.resolve();
  const next = prev.then(() => armForNodeInner(recRaw, down)).catch(() => {});
  armInflight.set(key, next);
  return next;
}
async function armForNodeInner(recRaw, down) {
  // Resolve the FULL record (getByWsId does not attach .rpc); getByKey applies withRpc.
  const rec = PROV.getByKey(recRaw.key) || recRaw;
  if (!rec || !rec.rpc) return;
  let channels;
  try {
    const pc = await lnrpc('listpeerchannels', [], rec.rpc, 8000);
    channels = pc.channels || [];
  } catch { return; }   // node down/booting/awaiting-signer: nothing to (or need to) arm
  for (const ch of channels) {
    const cid = ch.channel_id || ch.short_channel_id;
    if (!cid) continue;
    if (down) {
      // Arm ONLY channels caught mid-round; a plain idle tab-close must never force-close.
      const mid = Array.isArray(ch.htlcs) && ch.htlcs.some((h) => htlcMidRound(h.state));
      if (!mid) continue;
      try {
        await lnrpcKw('setpreemptarmed', [`id=${cid}`, 'armed=true'], rec.rpc, 8000);
        console.error('[preempt-arm]', rec.key, cid, 'ARMED (mid-round device drop)');
      } catch (e) { console.error('[preempt-arm] arm failed', rec.key, cid, e.message); }
    } else {
      // Clean disarm on reconnect (belt-and-suspenders; speculad also auto-clears on
      // every advance). Idempotent: disarming an un-armed channel is a harmless no-op.
      try { await lnrpcKw('setpreemptarmed', [`id=${cid}`, 'armed=false'], rec.rpc, 8000); } catch { /* un-armed / node down: harmless */ }
    }
  }
}

let wsConnSeq = 0;
server.on('upgrade', (req, socket) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${CFG.port}`);
    const m = u.pathname.match(/^\/lsp-ws-node\/([A-Za-z0-9._-]+)$/);
    if (!m) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    if (!PROV) { socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n'); return; }
    const rec = PROV.getByWsId(m[1]);
    if (!rec) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    if (!acceptUpgrade(req, socket)) return;
    const id = ++wsConnSeq;
    bridgeWsToTcp(socket, req, {
      tcpHost: '127.0.0.1', tcpPort: rec.signerPort, tcpRetryMs: 120000, id,
      log: (...a) => console.error('[ws-router]', `[${rec.public_ws_path}]`, ...a),
      // Device-presence -> watchtower preempt-arm. onUp: device signer back -> dis-arm.
      // onDrop: device gone -> arm any channel caught mid-round. Fire-and-forget: the
      // callbacks must never throw into the bridge's socket handlers (armForNode swallows).
      onUp: () => { armForNode(rec, false); },
      onDrop: () => { armForNode(rec, true); },
    });
  } catch (e) {
    try { socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } catch {}
    console.error('[ws-router] upgrade error:', e.message);
  }
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.error(`[lsp] listening http://127.0.0.1:${CFG.port}  asset-rpc ${CFG.hostedAssetRpc}  btc-rpc ${CFG.hostedBtcRpc}  relay ${CFG.relay}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
