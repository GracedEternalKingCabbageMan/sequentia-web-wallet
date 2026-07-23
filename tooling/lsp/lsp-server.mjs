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
import { settlementPlanForSide, planExecutionName, planSettlement } from './settlement-router.mjs';
import { buildUnifiedBook } from './unified-book.mjs';
import { runBridgedSwap, matchFromTake, describeBridge, classifyLegs, takeRailsCrossed, bridgeAssetHandoffAdmissible, bridgeAssetRelayLocktimeVerdict, bridgeFrontConfirmed, isPureLnTake, crossingShapeSupported, describeCrossingSupport } from './bridge-driver.mjs';
import { checkBridgeLocktimeOrdering, requiredTakerHold, frontHtlcMintTarget, verifyFrontRouteExpiry } from './leg-bridge.mjs';
import { runReverseBridgeTerms, openReverseBridgeSession, newBridgeClaimKeypair, relayTakerAssetLeg } from './bridge-maker.mjs';
import { hashPreimageOk, subasSellStateFileForNonce, subasSellGuardVerdict, assembleSubasSellSettled } from './subas-sell-recovery.mjs';

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
  // The on-chain cross-chain order-book relay (seqobd) for the unified book. Distinct from RELAY,
  // which the box points at the pure-LN maker relay (:9965). Defaults to seqobd :9955.
  crossRelay: process.env.SEQOB_RELAY_URL || 'http://127.0.0.1:9955',
  gold: reqEnv('GOLD'),
  btcx: process.env.BTCX || '', // empty => real BTC-LN (seqob-cli -btc-asset "")
  // Must EXCEED the xpln CLI's own wait budget (terms-wait 60s + hold-wait 90s = 150s) plus a
  // settle+print margin: at exactly 150s the execFile killed a swap that had just settled and the
  // LSP reported "failed" for a completed swap. 180s = 150s CLI budget + 30s margin.
  swapTimeoutMs: Number(process.env.LSP_SWAP_TIMEOUT_MS || 180000),
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
  // --- Shared terminal constants (P5.4a): the ONE source of truth for values the wallet
  // otherwise hard-codes as its own literals (market-order slippage bound, covenant partial-fill
  // min-lot floor, on-chain dust). Advertised in /status.constants so the composer's slippage /
  // instant-range copy tracks THIS box instead of drifting from a wallet-side constant. The wallet
  // falls back to matching defaults when /status is unreachable, so an old LSP never breaks it.
  // NOTE min_lot_bps is DISPLAY-ONLY on the wallet: the covenant leaf bakes its min-lot at placement
  // and re-derives it at fill, so the settlement divisor is consensus-frozen and never tracks this.
  marketSlip: Number(process.env.MARKET_SLIP || 0.15),          // market-order walk stops this far below best
  minLotBps: Number(process.env.MIN_LOT_BPS || 10),            // covenant partial-fill floor, basis points (~0.1%)
  dustSats: Number(process.env.DUST_SATS || 546),             // on-chain dust floor (sats)
  // --- Sub-asset rail: the MIRROR submarine (asset over Lightning + BTC ON-CHAIN HTLC). ---
  // A buy where the taker pays BTC on-chain and receives the asset over Lightning
  // (seqob-cli xsubas). It needs a bitcoind (funds + refunds the BTC HTLC), an asset LN
  // socket (receives the asset), and a relay carrying a sub-asset (ln_direction=4) maker.
  // Unset SUBAS_BTC_RPC/SUBAS_ASSET_LN => the rail is disabled (POST /swap fails closed).
  subasRelay: process.env.SUBAS_RELAY || process.env.RELAY || 'http://127.0.0.1:9955',
  subasBtcRpc: process.env.SUBAS_BTC_RPC || '',            // bitcoind RPC http://user:pass@host:port
  subasBtcWallet: process.env.SUBAS_BTC_WALLET || '',      // bitcoind wallet funding the BTC HTLC
  // The LSP's OWN bitcoind wallet that RECEIVES a bridged-leg recoup (claiming the maker's BTC HTLC). Kept
  // distinct from subasBtcWallet so the recoup lands in the LSP's wallet, not the maker's funding wallet —
  // making the LSP's net (paid LN, recouped on-chain) unambiguous. Falls back to subasBtcWallet if unset.
  bridgeRecoupWallet: process.env.BRIDGE_RECOUP_WALLET || '',
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
// Job store. A restart kills the in-process driver of every in-flight job, so the job
// state is persisted to disk and reloaded on boot — but the DRIVER cannot be resurrected,
// so on boot a still-running ('pending'/'held'/'accepted') job is marked 'interrupted'
// rather than left looking live. That is the honest signal the wallet's client-side
// reconcile needs: a poll returns 'interrupted' (re-drive / recover) instead of a bare 404
// (which the client cannot distinguish from "never existed") OR a stale 'pending' that would
// poll forever against a driver that is gone. The underlying swap stays crash-safe via its
// own state file (the taker persists P after paying); this only fixes the STATUS surface.
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // reap finished jobs after 6h
// Persist to the same durable dir as the hosted-fund registry (provDir). If provisioning is
// disabled (no provDir) jobs stay in-memory only — exactly today's behavior, so no regression.
const JOBS_FILE = CFG.provDir ? path.join(CFG.provDir, 'jobs.json') : '';
const NON_TERMINAL = new Set(['pending', 'held', 'accepted', 'pending_deposit', 'confirming']);

function loadJobs() {
  const m = new Map();
  if (!JOBS_FILE) return m;
  let raw;
  try { raw = fs.readFileSync(JOBS_FILE, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return m; console.error('[lsp] jobs.json unreadable, starting empty:', e && e.message); return m; }
  let obj;
  try { obj = JSON.parse(raw); } catch { console.error('[lsp] jobs.json corrupt, starting empty'); return m; }
  const now = Date.now();
  for (const [id, j] of Object.entries(obj && obj.jobs ? obj.jobs : {})) {
    if (!j || typeof j !== 'object') continue;
    if (j.done_ms && now - j.done_ms > JOB_TTL_MS) continue;   // don't resurrect long-finished jobs
    if (NON_TERMINAL.has(j.status)) {
      // The driver that would have advanced this job died with the old process.
      j.status = 'interrupted';
      j.interrupted = true;
      j.error = j.error || 'the LSP restarted while this swap was in flight; its status could not be confirmed — recover via the wallet';
      j.done_ms = j.done_ms || now;
    }
    m.set(id, j);
  }
  return m;
}
const jobs = loadJobs();
if (JOBS_FILE) {
  const n = jobs.size, intr = [...jobs.values()].filter((j) => j.interrupted).length;
  if (n) console.error(`[lsp] loaded ${n} persisted job(s) from ${JOBS_FILE}${intr ? ` (${intr} marked interrupted after restart)` : ''}`);
}

function persistJobs() {
  if (!JOBS_FILE) return;
  // Synchronous atomic write (temp + rename). Jobs are low-frequency (a few per swap), the file is a
  // few KB, and this is a durability feature — so we flush inline rather than debounce, leaving no
  // window where a hard restart loses a just-created job (which is exactly what we must NOT lose).
  try {
    const tmp = JOBS_FILE + '.tmp';
    // Drop transient `_`-prefixed fields (e.g. job._bridgeSession, a live courier WebSocket): they are not
    // serialisable and are re-established, not restored. Everything durable is a plain field.
    fs.writeFileSync(tmp, JSON.stringify({ jobs: Object.fromEntries(jobs) }, (k, v) => (k.startsWith('_') ? undefined : v)));
    fs.renameSync(tmp, JOBS_FILE);
  } catch (e) { console.error('[lsp] failed to persist jobs.json:', e && e.message); }
}
// Every mutation of `jobs` must go through these so the on-disk copy stays current.
function setJob(id, job) { jobs.set(id, job); persistJobs(); return job; }

// Nonce-keyed idempotency for the SYNCHRONOUS (0-conf) mixed path (the async path dedupes via `jobs`).
// In-memory only: a completed 0-conf swap resolves in seconds, so surviving a restart is not needed
// (an in-flight one would already have funded; a retry after a restart falls through to a fresh run,
// which is the pre-existing behaviour for that narrow window).
const mixedResult = new Map();   // nonce -> { ...result, ts }
const mixedInflight = new Map(); // nonce -> Promise<result>

function reapJobs() {
  const now = Date.now();
  let changed = false;
  for (const [id, j] of jobs) {
    if (j.done_ms && now - j.done_ms > JOB_TTL_MS) { jobs.delete(id); changed = true; }
  }
  for (const [nonce, r] of mixedResult) {
    if (r.ts && now - r.ts > JOB_TTL_MS) mixedResult.delete(nonce);
  }
  if (changed) persistJobs();
}

// ---------------------------------------------------------------------------
// SUB-ASSET SELL idempotency store: swap_nonce -> the SETTLED swap result.
//
// A sub-asset SELL pays the asset over Lightning INSIDE the /swap call and answers
// SYNCHRONOUSLY with {settled, preimage, btc_htlc, hash_h}. If that response is lost
// AFTER the asset was already paid, the wallet re-calls /swap with the SAME client-
// supplied swap_nonce; we then return the ALREADY-settled result instead of re-running
// the swap, so the asset is NEVER paid twice and the wallet recovers everything it needs
// to claim the BTC. Persisted the SAME atomic/synchronous way as jobs.json (temp+rename),
// so an LSP restart between settling and the store-write is the only (tiny, unavoidable)
// remaining window. Bounded by age AND a most-recent cap so it can't grow without limit.
// FUND-SAFETY: EXACT-match keying ONLY — a missing/blank nonce means "no idempotency"
// (run fresh), never a wildcard, so one swap's result can never be served for another
// nonce; and only a genuine settle is ever recorded (a failed swap stores nothing).
const SUBAS_SELL_NONCES_FILE = CFG.provDir ? path.join(CFG.provDir, 'subas-sell-nonces.json') : '';
const SUBAS_SELL_NONCE_TTL_MS = 24 * 60 * 60 * 1000;   // a recovered result stays claimable for 24h
const SUBAS_SELL_NONCE_CAP = 500;                       // hard cap on retained results (most-recent wins)
function loadSubasSellNonces() {
  const m = new Map();
  if (!SUBAS_SELL_NONCES_FILE) return m;
  let raw;
  try { raw = fs.readFileSync(SUBAS_SELL_NONCES_FILE, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return m; console.error('[lsp] subas-sell-nonces unreadable, starting empty:', e && e.message); return m; }
  let obj;
  try { obj = JSON.parse(raw); } catch { console.error('[lsp] subas-sell-nonces corrupt, starting empty'); return m; }
  const now = Date.now();
  for (const [nonce, r] of Object.entries(obj && obj.nonces ? obj.nonces : {})) {
    if (!r || typeof r !== 'object' || r.settled !== true) continue;   // only genuine settles are ever valid
    if (r.ts && now - r.ts > SUBAS_SELL_NONCE_TTL_MS) continue;        // drop expired
    m.set(nonce, r);
  }
  return m;
}
const subasSellNonces = loadSubasSellNonces();
if (SUBAS_SELL_NONCES_FILE && subasSellNonces.size) {
  console.error(`[lsp] loaded ${subasSellNonces.size} sub-asset SELL idempotency record(s) from ${SUBAS_SELL_NONCES_FILE}`);
}
function persistSubasSellNonces() {
  if (!SUBAS_SELL_NONCES_FILE) return;   // provDir disabled: in-memory only (same posture as jobs.json)
  try {
    const tmp = SUBAS_SELL_NONCES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ nonces: Object.fromEntries(subasSellNonces) }));
    fs.renameSync(tmp, SUBAS_SELL_NONCES_FILE);
  } catch (e) { console.error('[lsp] failed to persist subas-sell-nonces.json:', e && e.message); }
}
// EXACT-match lookup of a stored settled result (never a wildcard); expires lazily.
function getSubasSellResult(nonce) {
  if (!nonce || typeof nonce !== 'string') return null;
  const r = subasSellNonces.get(nonce);
  if (!r) return null;
  if (r.ts && Date.now() - r.ts > SUBAS_SELL_NONCE_TTL_MS) { subasSellNonces.delete(nonce); persistSubasSellNonces(); return null; }
  return r;
}
// Record a SETTLED result under the nonce, SYNCHRONOUSLY (temp+rename) BEFORE the caller returns —
// so a hard restart between the swap settling and this write is the only remaining loss window.
// Never records a non-settled swap. Prunes expired entries, then caps to the most-recent N.
function putSubasSellResult(nonce, result) {
  if (!nonce || typeof nonce !== 'string') return;
  if (!result || result.settled !== true) return;   // FUND-SAFETY: only a genuine settle is ever recorded
  const now = Date.now();
  for (const [k, v] of subasSellNonces) { if (v && v.ts && now - v.ts > SUBAS_SELL_NONCE_TTL_MS) subasSellNonces.delete(k); }
  subasSellNonces.delete(nonce);                     // re-insert last so this nonce is the most-recent (insertion-ordered)
  subasSellNonces.set(nonce, { ...result, ts: now });
  while (subasSellNonces.size > SUBAS_SELL_NONCE_CAP) { const oldest = subasSellNonces.keys().next().value; subasSellNonces.delete(oldest); }
  persistSubasSellNonces();
}
// In-memory coalescing of CONCURRENT same-nonce runs: a retry that races the ORIGINAL /swap while
// it is STILL executing server-side (Node keeps the handler running after the client disconnects, so
// a reload + resumeSell re-call can arrive before the first run finishes). The second caller awaits
// the first run's promise instead of launching a SECOND xsubas-sell — which would double-pay. Not
// persisted: after a restart there are no in-flight runs, and the on-disk store gives cross-restart
// idempotency.
const subasSellInflight = new Map();   // swap_nonce -> Promise<runMixed result>

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
          return reject(new Error(`${method}: ${detail || scrubDetail(err.message)}`));
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
          return reject(new Error(`${method}: ${detail || scrubDetail(err.message)}`));
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${method}: bad json`)); }
      });
  });
}

// Bound EVERY per-node RPC used to build /status. Without it a down/unresponsive hosted node's
// socket hangs the whole /status forever, so ONE dead provisioned node poisoned ALL Lightning
// status in the wallet (L.status never resolves -> no channels -> false "No Lightning channel" +
// a flapping badge). A timed-out node rejects here and its caller skips it via .catch(()=>null).
const STATUS_RPC_TIMEOUT_MS = 5000;
// Bound RPCs that round-trip to the DEVICE signer (invoice/hold-invoice minting) or are otherwise
// heavier than a plain read. Same rationale as STATUS_RPC_TIMEOUT_MS: lnrpc defaults timeoutMs=0 (no
// timeout), so an offline signer or a wedged node would hang the request handler forever otherwise.
const SIGNER_RPC_TIMEOUT_MS = 20000;
// Redact secrets/internal paths from CLI output before returning it to a client: SEQ_RPC is a
// http://user:pass@host:port URL and seqob-cli/lightning-cli errors can echo it (or internal
// --rpc-file=/root/... paths). Keep the last 6 non-empty lines but strip credentials + fs paths.
const scrubDetail = (out) => String(out || '').split('\n').filter(Boolean).slice(-6).join(' | ')
  .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1<redacted>@')
  .replace(/\/root\/[^\s'"|]+/g, '<path>');
async function nodeStatus(rpc, leg) {
  const info = await lnrpc('getinfo', [], rpc, STATUS_RPC_TIMEOUT_MS);
  let channels = [];
  try {
    const pc = await lnrpc('listpeerchannels', [], rpc, STATUS_RPC_TIMEOUT_MS);
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

// What the LSP can JIT-FRONT for a wallet that holds NO channel of its own, per leg. The wallet's
// rail readiness (ln-rail.js) reads this so a leg with no own channel is still Lightning-ready when
// the LSP can front it — and HONESTLY unavailable when it cannot (no own channel AND no LP inventory),
// instead of promising an instant fronted leg that would then fail at settlement. Asset legs front
// from the LP node's (ln-asset) on-chain inventory of that asset (provisionInbound opens a JIT channel
// funded from it — needs CONFIRMED asset UTXOs, since fundchannel uses mindepth=0 but not minconf=0).
// The BTC leg fronts over the BTC-LN node's (btc-taker) OWN channels: spendable = the LSP can DELIVER
// BTC-LN (user receives), receivable = the LSP can RECEIVE it (user pays). Fully best-effort: a down LP
// or BTC node simply advertises no fronting for its leg (the wallet then offers on-chain, honestly).
async function frontableInventory() {
  const assets = {}; const btc = { out_sat: 0, in_sat: 0 };
  if (CFG.subasLpRpc) {
    try {
      const lf = await lnrpc('listfunds', [], CFG.subasLpRpc, STATUS_RPC_TIMEOUT_MS);
      for (const o of (lf.outputs || [])) {
        if (o.status !== 'confirmed' || o.reserved) continue;                 // confirmed + unreserved only
        const a = (o.asset || 'policy').toLowerCase();
        const sat = Math.round(Number(o.amount_msat ?? 0) / 1000);
        if (sat > 0) assets[a] = (assets[a] || 0) + sat;
      }
    } catch { /* LP down -> no asset-leg fronting advertised */ }
  }
  if (CFG.mixedBtcRpc) {
    try {
      const pc = await lnrpc('listpeerchannels', [], CFG.mixedBtcRpc, STATUS_RPC_TIMEOUT_MS);
      for (const c of (pc.channels || [])) {
        if (!String(c.state || '').startsWith('CHANNELD_NORMAL')) continue;   // only live channels can route now
        btc.out_sat += Math.round((c.spendable_msat ?? c.to_us_msat ?? 0) / 1000);
        btc.in_sat  += Math.round((c.receivable_msat ?? ((c.total_msat ?? 0) - (c.to_us_msat ?? 0))) / 1000);
      }
    } catch { /* BTC-LN node down -> no BTC-leg fronting advertised */ }
  }
  return { assets, btc };
}

async function status(deviceKeys = []) {
  // Aggregate BOTH hosted nodes: the asset (GOLD) node and the BTC node.
  // In one-node fallback mode both sockets are identical and return the same data.
  // Per-node catch: a down/hung demo node must NOT fail the whole /status (which would blank the
  // wallet's LN badge + balance for everyone). It drops to null; the response omits its channels.
  const [assetNode, btcNode, frontable] = await Promise.all([
    nodeStatus(CFG.hostedAssetRpc, 'asset').catch(() => null),
    nodeStatus(CFG.hostedBtcRpc, 'btc').catch(() => null),
    frontableInventory().catch(() => ({ assets: {}, btc: { out_sat: 0, in_sat: 0 } })),
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
  if (PROV) {
    // Query the device's nodes CONCURRENTLY and bound each: a dead node must neither hang /status
    // (see STATUS_RPC_TIMEOUT_MS) nor add its timeout to every other node's latency (a serial loop
    // over N stale nodes made /status take N*STATUS_RPC_TIMEOUT_MS). Each node's whole report is also
    // raced against a hard cap, so a hang in ANY of its RPCs (getinfo/listpeerchannels/listfunds)
    // drops just that node instead of poisoning the entire response.
    const recs = deviceKeys.map((key) => PROV.getByKey(key)).filter(Boolean);
    const results = await Promise.all(recs.map((rec) => Promise.race([
      (async () => {
        const ns = await nodeStatus(rec.rpc, rec.chain === 'btc' ? 'btc' : 'prov').catch(() => null);
        if (!ns) return null;
        const on = await onchainForReport(rec.rpc, rec.chain === 'btc' ? 'btc' : 'seq', rec.chain === 'btc' ? null : rec.asset_id).catch(() => ({ onchain_msat: 0 }));
        return { rec, ns, on };
      })(),
      new Promise((res) => setTimeout(() => res(null), STATUS_RPC_TIMEOUT_MS + 1500)),
    ])));
    for (const r of results) {
      if (!r) continue;
      const { rec, ns, on } = r;
      provNodes.push({ key: rec.key, asset_id: rec.asset_id, node_id: ns.id, channels: ns.channels.length,
        onchain_msat: on.onchain_msat, stranded: on.onchain_msat > 0 && ns.channels.length === 0 });
      for (const c of ns.channels) provChannels.push({ ...c, node_key: rec.key });
    }
  }
  return {
    ok: true,
    asset_node: assetNode,
    btc_node: btcNode,
    provisioned_nodes: provNodes,                                       // the device's own nodes it named
    channels: [...(assetNode?.channels || []), ...(btcNode?.channels || []), ...provChannels], // merged, leg-tagged; a down node contributes none
    frontable,   // what the LSP can JIT-front for a channel-less wallet (ln-rail.js: a leg is LN-ready if own channel OR frontable covers it)
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
    // P3.5 — the 0-conf LP-fronting ceiling on the BTC leg, in SATS, as the SINGLE SOURCE OF TRUTH the
    // wallet reads (frontCapAtoms) instead of hard-coding a default that can drift from the box config.
    // The BTC leg's atoms ARE sats (BTC has 8 decimals), so CFG.mixedMax0conf — the deployed MIXED_MAX_0CONF
    // — is already the sats ceiling. 0 means "no 0-conf fronting configured" (every mixed trade waits for a
    // confirmation), which the wallet surfaces honestly.
    mixed_max_0conf_sats: CFG.mixedMax0conf || 0,
    // P5.4a — the shared terminal constants block: the SINGLE source of truth the wallet reads into its
    // config so the market-slippage bound, the covenant min-lot copy, the front cap, and the dust floor
    // are one number, not independent literals that silently drift between the box and the composer.
    // front_cap_sats mirrors mixed_max_0conf_sats (same value, grouped here for discoverability).
    constants: {
      market_slip: CFG.marketSlip,
      min_lot_bps: CFG.minLotBps,
      front_cap_sats: CFG.mixedMax0conf || 0,
      dust_sats: CFG.dustSats,
    },
    // P3.2 — which rail-crossing shapes the LSP's bridge actually SETTLES, so a client checks BEFORE it
    // promises a bridge in Review (never a promise-then-fail post-confirm). Derived from the same pure
    // predicate the /swap admission uses (bridge-driver.crossingShapeSupported).
    bridge: describeCrossingSupport(),
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
  const lf = await lnrpc('listfunds', [], rpc, STATUS_RPC_TIMEOUT_MS).catch(() => ({ outputs: [] }));
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
    try { return await lnrpc('getinfo', [], rpc, STATUS_RPC_TIMEOUT_MS); }
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
    const info = await lnrpc('getinfo', [], rpc, STATUS_RPC_TIMEOUT_MS).catch(() => null);
    if (info && info.warning_lightningd_sync == null && info.warning_bitcoind_sync == null) return info;
    if (Date.now() > deadline) throw new Error('your Lightning node did not finish syncing to the chain tip in time (still rescanning) — its funds are safe on-chain; retry once it is caught up');
    await sleep(3000);
  }
}

async function channelDeposit(chain, assetId, nodeKey) {
  const { rpc } = targetFor(chain, chain === 'seq' ? (assetId || CFG.gold) : null, nodeKey);
  if (!rpc) throw new Error('no hosted node for that asset (provision it first)');
  const info = await waitGetinfo(rpc);            // tolerate a just-booted node's missing socket
  const na = await lnrpc('newaddr', ['bech32'], rpc, STATUS_RPC_TIMEOUT_MS);
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
  // T8 partial fill: take exactly the asset amount the wallet asked for (<= the offer). xsubas
  // locks the proportional BTC and the maker re-rests the remainder; 0/absent = the whole offer.
  if (job.asset_amount) args.push('-amount', String(job.asset_amount));
  if (job.offer_id) args.push('-offer-id', String(job.offer_id));
  if (job.maker_pubkey) args.push('-maker-pubkey', String(job.maker_pubkey));
  // (d) READ-ONLY held/settled watcher — the SAME holdinvoicelookup /node/invoice-status uses.
  //     The LSP NEVER settles (the DEVICE does), so this only surfaces state on the job.
  let watching = true;
  (async () => {
    while (watching) {
      try {
        const l = await lnrpc('holdinvoicelookup', [job.payment_hash], userRpc, SIGNER_RPC_TIMEOUT_MS);
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
    job.error = `sub-asset buy failed before held: ${scrubDetail(err.message)}`;
    job.detail = scrubDetail(out);
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
  setJob(jobId, job);   // persist on creation so a restart sees it (as 'interrupted'), not a 404
  runSubasBuyHodl(job, body)
    .catch((e) => { job.status = 'failed'; job.error = String((e && e.message) || e); job.done_ms = Date.now(); })
    .finally(() => persistJobs());   // capture the terminal state (settled/failed) on disk
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

function runSwap({ side, asset, amount, offer_id, maker_pubkey, quote_asset, node_key, counter_node_key }) {
  return new Promise((resolve) => {
    const assetId = resolveAsset(asset);
    if (side !== 'buy' && side !== 'sell') return resolve({ ok: false, error: "side must be 'buy' or 'sell'" });
    if (!assetId) return resolve({ ok: false, error: 'unknown asset (want GOLD or a 32-byte hex id)' });
    // Counter (quote) leg. asset<->asset (e.g. EURX/OILX): a real Sequentia asset id, so BOTH legs are
    // asset-LN — resolve EACH asset's hosted socket (targetFor) so the base + quote legs route over nodes
    // that actually hold those assets. Empty/BTC quote = the classic asset<->BTC (counter leg = BTC-LN).
    const quoteId = quote_asset && String(quote_asset).toUpperCase() !== 'BTC' ? resolveAsset(quote_asset) : null;
    const assetAsset = !!quoteId;
    // PHOENIX-STYLE SELF-CUSTODY: each leg runs on the USER's OWN provisioned node (nodes are keyed
    // per-asset, so `node_key` = the user's <asset> node and `counter_node_key` = the user's <quote_asset>
    // node for asset<->asset, or the user's BTC node for asset<->BTC). The device co-signs every
    // commitment over the wss link during the swap — the user's keys never leave the device. targetFor
    // routes an explicit provisioned key to the user's own node (line 601); it falls back to the shared
    // hosted node ONLY when the user has none (e.g. the GOLD demo), never silently for a real user asset.
    // Passing null (a wallet that omits the keys) reverts to the shared node — so the wallet MUST send them.
    const baseSock = targetFor('seq', assetId, node_key || null).rpc;
    const quoteSock = assetAsset
      ? targetFor('seq', quoteId, counter_node_key || null).rpc
      : targetFor('btc', null, counter_node_key || null).rpc;
    if (!baseSock || !quoteSock) return resolve({ ok: false, error: `no hosted Lightning node for ${assetAsset ? assetLabel(assetId) + '/' + assetLabel(quoteId) : assetLabel(assetId) + '/BTC'}` });
    const args = [
      'xpln', '-side', side, '-relay', CFG.relay,
      '-asset', assetId,
      ...(assetAsset ? ['-quote-asset', quoteId] : ['-btc-asset', CFG.btcx]),
      '-asset-ln-socket', baseSock, '-ln-socket', quoteSock,
      '-terms-wait', '60s', '-hold-wait', '90s',
    ];
    // Lift the SPECIFIC offer the taker priced, not just the first match: xpln supports
    // -offer-id/-maker-pubkey. Without them the composer showed a price for one offer while
    // xpln filled a relay-arbitrary one (a worse-price surprise). Pass them through when given.
    if (offer_id) args.push('-offer-id', String(offer_id));
    if (maker_pubkey) args.push('-maker-pubkey', String(maker_pubkey));
    const t0 = Date.now();
    execFile(CFG.seqobCli, args, { timeout: CFG.swapTimeoutMs, maxBuffer: 8 << 20 }, async (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      const m = out.match(/PURE-LN SWAP SETTLED:\s+(bought|sold)\s+(\d+)\s+([0-9a-f]+)\s+for\s+(\d+)\s+BTC sats[^;]*;\s+preimage\s+([0-9a-f]+)/i);
      if (m) return resolve({
        ok: true, side, direction: m[1], asset: m[3], asset_label: assetLabel(m[3]),
        base_amount: Number(m[2]), quote_amount: Number(m[4]),
        quote_asset: assetAsset ? quoteId : (CFG.btcx || 'BTC'),
        quote_asset_label: assetAsset ? assetLabel(quoteId) : 'BTC',   // the "BTC sats" in the CLI line is a cosmetic label; the amount is the quote asset's atoms
        preimage: m[5], finality: 'final', settled_ms: Date.now() - t0, requested_amount: amount ?? null,
      });
      // RECONCILE before declaring nothing was spent. If xpln got as far as committing funds it
      // printed `paying maker hold on H=<hash>` (the taker pays the maker's hold: BTC for a buy, the
      // asset for a sell). A kill during that pay (e.g. the exec timeout firing mid-settle) leaves the
      // HTLC in flight while err is set — reporting a flat failure invites a double-pay. Ask the paying
      // node `listsendpays H`: a pending/complete payment means funds ARE committed, so return an
      // "uncertain, do not retry" instead of "did not settle". H is unique, so this never collides with
      // another user's payment on the shared node.
      const hm = out.match(/paying maker hold on H=([0-9a-f]{64})/i);
      if (hm) {
        const H = hm[1];
        const payRpc = side === 'buy' ? quoteSock : baseSock;   // buy pays the quote leg, sell pays the asset leg
        try {
          const ls = await lnrpcKw('listsendpays', ['payment_hash=' + H], payRpc, 6000);
          const live = ((ls && ls.payments) || []).find((x) => x.status === 'pending' || x.status === 'complete');
          if (live) return resolve({ ok: false, uncertain: true, payment_status: live.status,
            error: 'The Lightning swap was interrupted while your payment was in flight. Do NOT retry — check your balance shortly; it may still complete on its own.',
            detail: scrubDetail(out), settled_ms: Date.now() - t0 });
        } catch { /* reconciliation is best-effort; fall through to the plain failure below */ }
      }
      resolve({ ok: false, error: err ? `swap failed: ${scrubDetail(err.message)}` : 'swap did not settle',
        detail: scrubDetail(out), settled_ms: Date.now() - t0 });
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
  const uinfo = await lnrpc('getinfo', [], userRpc, STATUS_RPC_TIMEOUT_MS);
  const userId = uinfo.id;
  const bind = (uinfo.binding || []).find(b => b.port) || {};
  if (!bind.port) throw new Error('user node has no listen binding for the LP to connect to');
  const host = bind.address || '127.0.0.1';
  await lnrpc('connect', [`id=${userId}`, `host=${host}`, `port=${bind.port}`], CFG.subasLpRpc, SIGNER_RPC_TIMEOUT_MS)
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

// --- sub-asset SELL crash recovery ------------------------------------------
// FUND-SAFETY: the xsubas-sell CLI pays the asset over LN INSIDE the /swap call and only then
// prints the settled JSON. If that subprocess crashes AFTER paying (+ the maker settling) but
// BEFORE we capture its stdout, the preimage P would be lost — the wallet could never claim the
// BTC. The CLI now persists a -state-file (H + the full BTC HTLC terms after verifying, then P
// after paying), so on a CLI failure we reconstruct the settled result — straight from the file
// (P already written) or by asking the taker's OWN node whether its outgoing asset payment on H
// genuinely COMPLETED (revealing P). We NEVER report settled without a real preimage in hand.
const RECOVER_POLL_TRIES = 5;    // ~ (5-1)*2s = 8s max wait for a momentarily-pending pay to settle
const RECOVER_POLL_MS = 2000;

// paymentStatusForHash asks a hosted node about its OUTGOING payment on payment_hash H, returning
// { preimage, pending }. The asset is paid with a bare-hash `sendpay`, so `listsendpays` (which
// carries `payment_preimage` on each COMPLETE part and 'pending' on an in-flight part) is
// authoritative; `listpays` (the xpay plugin's view, field `preimage`) is a best-effort fallback.
// FUND-SAFETY: it THROWS if listsendpays itself is unreadable, so callers treat that as UNCERTAIN
// (never "no pay"). `pending:true` means an attempt for H is still in flight (do not re-pay).
async function paymentStatusForHash(rpc, hashH) {
  let preimage = null, pending = false;
  const r = await lnrpcKw('listsendpays', [`payment_hash=${hashH}`], rpc, SIGNER_RPC_TIMEOUT_MS);
  for (const p of (r && r.payments) || []) {
    if (!p) continue;
    if (p.status === 'complete' && p.payment_preimage) preimage = String(p.payment_preimage).toLowerCase();
    else if (p.status === 'pending') pending = true;
  }
  if (!preimage) {
    try {
      const rp = await lnrpcKw('listpays', [`payment_hash=${hashH}`], rpc, SIGNER_RPC_TIMEOUT_MS);
      for (const p of (rp && rp.pays) || []) {
        if (!p) continue;
        if (p.status === 'complete' && p.preimage) preimage = String(p.preimage).toLowerCase();
        else if (p.status === 'pending') pending = true;
      }
    } catch (e) { console.error('[lsp] listpays fallback failed:', e && e.message); }
  }
  return { preimage, pending };
}

// settledPreimageForHash is the tolerant variant used by the within-call poll: a genuinely-COMPLETE
// preimage or null (swallowing an unreadable node, since the poll just retries).
async function settledPreimageForHash(rpc, hashH) {
  try { return (await paymentStatusForHash(rpc, hashH)).preimage; }
  catch (e) { console.error('[lsp] recovery payment status failed:', e && e.message); return null; }
}

// recoverSubasSell reconstructs a SETTLED sub-asset SELL result after THIS run's CLI failed, or
// returns null (=> the caller returns the original failure; the maker refunds its BTC HTLC at
// T_btc, so nothing is lost). It NEVER fabricates a settle: a settled result is returned ONLY with
// a real preimage — persisted to the state file (Phase "paid") or read back from a genuinely-
// COMPLETE outgoing payment on the taker's own node. (The cross-call retry case is handled earlier
// by preSpawnGuardSubasSell; this is the same-call fast path.)
async function recoverSubasSell({ stateFile, userRpc, assetId, nodeKey, dt, requestedAmount }) {
  let st;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return null; }                                          // missing/unreadable => no recovery
  const bh = st && st.btc_htlc;
  const hashH = st && typeof st.hash_h === 'string' ? st.hash_h.toLowerCase() : '';
  if (!bh || !bh.txid || !/^[0-9a-f]{64}$/i.test(hashH)) return null;   // nothing to rebuild from
  const mk = (preimageHex) => assembleSubasSellSettled({
    assetId, assetLabelStr: assetLabel(assetId), nodeKey, hashH, preimageHex,
    makerLnNodeId: st.maker_ln_node_id, btcHtlc: bh, dt, requestedAmount,
    note: 'Sub-asset SELL RECOVERED after a CLI crash: the asset was paid over Lightning. '
        + 'Claim the BTC on-chain with your device key using the returned preimage + btc_htlc.',
  });
  // (1) The preimage was persisted (Phase "paid") -> reconstruct directly.
  if (st.preimage && hashPreimageOk(hashH, st.preimage)) {
    return mk(String(st.preimage).toLowerCase());
  }
  // (2) Verified but P not yet persisted -> the crash landed during/just-after the pay. Ask the
  //     taker's OWN node whether the outgoing asset payment on H COMPLETED. Poll a few seconds:
  //     the maker settles the hold moments after it is held (it already holds P), so a payment
  //     that is momentarily 'pending' when the CLI died usually resolves right after. If it never
  //     completes, the asset was not paid -> null (the caller returns the original failure).
  for (let i = 0; i < RECOVER_POLL_TRIES; i++) {
    const p = await settledPreimageForHash(userRpc, hashH);
    if (p && hashPreimageOk(hashH, p)) return mk(p);
    if (i < RECOVER_POLL_TRIES - 1) await sleep(RECOVER_POLL_MS);
  }
  return null;                                                    // asset NOT paid -> return the failure
}

// preSpawnGuardSubasSell runs BEFORE (re)spawning xsubas-sell for a nonce-carrying request. If a
// prior attempt for this EXACT nonce left a state file, it decides — via the pure subasSellGuard-
// Verdict — whether the asset may already have been paid, so a same-nonce retry NEVER re-pays.
// Returns one of:
//   { action: 'rerun' }           -> provably no prior pay: caller spawns (runMixed pre-cleans).
//   { action: 'recover', result } -> a settled result to store + return (the asset was paid).
//   { action: 'hold', result }    -> a retryable {ok:false,pending:true,retry:true} body: a pay is
//                                    in-flight or unprovable. Caller returns it; the wallet re-polls
//                                    with the SAME nonce instead of treating the swap as failed.
async function preSpawnGuardSubasSell(body) {
  const stateFile = subasSellStateFileForNonce(os.tmpdir(), body && body.swap_nonce);
  if (!stateFile) return { action: 'rerun' };                     // unusable nonce -> no cross-call file
  let st;
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return { action: 'rerun' }; }                           // no readable prior state -> fresh (re)attempt
  const bh = st && st.btc_htlc;
  const hashH = st && typeof st.hash_h === 'string' ? st.hash_h.toLowerCase() : '';
  const assetId = resolveAsset(body && body.asset);
  const nodeKey = String((body && body.node_key) || '').toLowerCase();
  // Consult the node ONLY for a usable "verified" state (no persisted preimage). A persisted
  // preimage / unusable state is decided by the verdict without a query. A verified state we
  // cannot read from the node stays uncertain (nodeStatus=null -> the verdict holds, never reruns).
  const usable = !!(bh && bh.txid && /^[0-9a-f]{64}$/i.test(hashH));
  const hasPersistedP = usable && typeof st.preimage === 'string' && hashPreimageOk(hashH, st.preimage);
  let nodeStatus = null;
  if (usable && !hasPersistedP) {
    const { rpc: userRpc } = assetId ? targetFor('seq', assetId, nodeKey) : { rpc: null };
    if (userRpc) {
      try { nodeStatus = await paymentStatusForHash(userRpc, hashH); }
      catch (e) { console.error('[lsp] pre-spawn payment status failed:', e && e.message); nodeStatus = null; }
    }
  }
  const verdict = subasSellGuardVerdict(st, nodeStatus);
  if (verdict.kind === 'recover') {
    const result = assembleSubasSellSettled({
      assetId, assetLabelStr: assetLabel(assetId), nodeKey, hashH, preimageHex: verdict.preimage,
      makerLnNodeId: st.maker_ln_node_id, btcHtlc: bh, requestedAmount: body.amount,
      note: 'Sub-asset SELL RECOVERED on retry: a prior attempt for this swap already paid the asset '
          + 'over Lightning. Claim the BTC on-chain with your device key using the returned preimage + btc_htlc.',
    });
    try { fs.unlinkSync(stateFile); } catch { /* best-effort; nonce store now holds it */ }
    console.error(`[lsp] sub-asset SELL pre-spawn RECOVERED a prior settled attempt (hash_h=${hashH})`);
    return { action: 'recover', result };
  }
  if (verdict.kind === 'hold') {
    console.error(`[lsp] sub-asset SELL pre-spawn HOLD (${verdict.reason}); not re-running to avoid a double pay`);
    return { action: 'hold', result: { ok: false, settled: false, pending: true, retry: true,
      reason: verdict.reason,
      error: 'asset payment for this swap may be in progress; retry shortly with the same swap_nonce' } };
  }
  return { action: 'rerun' };                                     // provably no prior pay
}

function runMixed({ side, asset, amount, payRail, recvRail, node_key, asset_bolt11, payment_hash, asset_amount, btc_claim_pub, offer_id, maker_pubkey, btc_htlc, swap_nonce }) {
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
      // Crash-recovery state file: the CLI writes H + the full BTC HTLC terms after verifying, and
      // P after paying. Deterministic per swap via the SHARED derivation (so the pre-spawn guard and
      // this spawn agree on the path); falls back to a random id when there's no usable nonce. On a
      // CLI crash after paying we read this back (or query the node) to reconstruct the settled
      // result instead of losing P.
      const swapStateFile = subasSellStateFileForNonce(os.tmpdir(), swap_nonce)
        || path.join(os.tmpdir(), `xsubas-sell-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      // Pre-clean any stale file at this path. This is only REACHED on a genuine first attempt or
      // after the pre-spawn guard PROVED no prior pay for this nonce, so clearing a leftover
      // "verified"-but-unpaid file here can never drop a recoverable pay (the guard already held on
      // any paid/pending/uncertain state). The file then reflects ONLY this run.
      try { fs.unlinkSync(swapStateFile); } catch { /* no stale file: fine */ }
      const sellArgs = ['xsubas-sell', '-asset', assetId, '-relay', CFG.subasSellRelay,
        '-btc-rpc', CFG.subasBtcRpc, '-btc-chain', CFG.subasBtcChain,
        '-asset-ln-socket', userRpc, '-btc-claim-pub', btc_claim_pub,
        '-min-btc-conf', String(CFG.subasMinBtcConf), '-state-file', swapStateFile, '-json'];
      // Lift a SPECIFIC resting offer (order-book take) when the wallet names one.
      if (offer_id) sellArgs.push('-offer-id', String(offer_id));
      if (maker_pubkey) sellArgs.push('-maker-pubkey', String(maker_pubkey));
      const t0s = Date.now();
      return execFile(CFG.seqobCli, sellArgs, { timeout: CFG.mixedTimeoutMs, maxBuffer: 8 << 20 }, async (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        let j = null;
        for (const line of (stdout || '').trim().split('\n').reverse()) {
          const s = line.trim();
          if (s.startsWith('{') && s.endsWith('}')) { try { j = JSON.parse(s); break; } catch { /* keep scanning */ } }
        }
        const dt = Date.now() - t0s;
        if (j && j.settled) {
          try { fs.unlinkSync(swapStateFile); } catch { /* best-effort */ }
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
        // FUND-SAFETY: the CLI errored/crashed. It may have crashed AFTER paying the asset + the
        // maker settling but before printing the settled JSON -> P would be lost. Try to recover a
        // settled result from the crash-recovery state file (P persisted there) or by asking the
        // taker's own node whether the asset payment on H genuinely COMPLETED. recoverSubasSell
        // returns a settled result ONLY with a real preimage in hand.
        const recovered = await recoverSubasSell({
          stateFile: swapStateFile, userRpc, assetId, nodeKey: node_key,
          dt, requestedAmount: amount });
        if (recovered) {
          console.error(`[lsp] sub-asset SELL RECOVERED a settled result after a CLI failure (hash_h=${recovered.hash_h})`);
          try { fs.unlinkSync(swapStateFile); } catch { /* best-effort */ }
          return resolve(recovered);
        }
        // No real preimage -> the asset was NOT paid. Return the original failure unchanged; the
        // maker refunds its BTC HTLC at T_btc and nothing is lost. The state file is left in place
        // (harmless temp; pre-cleaned on the next same-nonce run).
        return resolve({ ok: false,
          error: (j && j.error) ? `sub-asset sell failed: ${scrubDetail(j.error)}` : (err ? `sub-asset sell failed: ${scrubDetail(err.message)}` : 'sub-asset sell did not settle'),
          detail: scrubDetail(out), settled_ms: dt });
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
      let preimage = null, htlcTxid = null, hasFundedLeg = false;
      try {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        preimage = st.preimage_hex || st.secret_hex || st.seq_preimage_hex || null;
        htlcTxid = st.seq_leg_txid || st.btc_leg_txid || null;
        // A funded on-chain leg whose swap did NOT settle still needs the state file's
        // private keys to reclaim after the timeout (seqob-cli xrefund -state-file …).
        hasFundedLeg = !!(st.btc_leg_txid || st.seq_leg_txid || st.btc_funding_txid);
      } catch { /* file may be absent on early failure */ }
      const cm = out.match(/claimed the asset in ([0-9a-f]{64})/i);
      // FUND-SAFETY: delete the state file ONLY on settlement, or when it holds no funded
      // leg (nothing to reclaim). Deleting it on a FAILURE with a funded HTLC destroyed the
      // ONLY copy of the refund keys — permanent loss. Keep it + log the recovery handle.
      if (settled || !hasFundedLeg) {
        try { fs.unlinkSync(stateFile); } catch { /* best-effort */ }
      } else {
        console.error(`[router] KEEPING ${stateFile}: funded leg ${htlcTxid} did not settle; reclaim after timeout with: ${CFG.seqobCli} xrefund -state-file ${stateFile}`);
      }
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
      const fdetail = scrubDetail(out);
      console.error(`[router] ${execName || 'mixed'} FAILED after ${dt}ms: ${err ? err.message : 'did not settle'}; tail: ${String(fdetail).trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 500)}`);
      resolve({ ok: false, error: err ? `mixed swap failed: ${scrubDetail(err.message)}` : 'mixed swap did not settle',
        detail: fdetail, settled_ms: dt });
    });
  });
}

// ===========================================================================
// RAIL-BLIND BRIDGED TAKE — the LSP side of a genuine rail crossing.
//
// When the wallet takes an offer whose rails DIFFER from the taker's (a cross that the deployed xsub*
// binaries cannot execute — planExecutionName returns null), the LSP bridges the mismatched leg(s). The
// fund-safety of each crossed leg is the PURE core leg-bridge.nextBridgeStep; the whole-swap coordination
// (JIT first, the atomicity gate on one H, recoup-before-CLTV) is the PURE bridge-driver.runBridgedSwap.
// This file only supplies the live `io`: it OBSERVES real LN + on-chain state and EXECUTES exactly the
// action the driver (hence nextBridgeStep) returns — never fronting on its own judgement.
//
// The bridged-take POST /swap contract (fields ADDED to the normal swap body):
//   { side, asset, bridge:true,
//     payRail, recvRail,                 taker's chosen rails ('ln'|'chain')
//     maker_btc_rail, maker_asset_rail,  the resting offer's per-leg rails (unified-book derived)
//     btc_sats, asset_atoms,             the two legs' amounts (bound every LSP front)
//     offer_id, maker_pubkey,            the resting offer to settle against
//     node_key, btc_node_key,            the taker's hosted asset / BTC nodes (LN legs + JIT)
//     taker_asset_inbound, taker_btc_inbound,  skip JIT when the taker already holds inbound
//     swap_nonce }                       idempotency (persist-before-broadcast)
// Response: 202 { ok, job_id, poll:'/swap/<id>', rail:'bridged', bridged:true, settlement_plan,
//                 bridge_legs, jit_legs, swap_nonce }; poll GET /swap/<id> for { status, ok, legs }.
// ===========================================================================

const bridgeResult = new Map();     // swap_nonce -> { ...result, ts }  (idempotent replay)
const bridgeInflight = new Map();   // swap_nonce -> Promise<result>    (join an in-flight run)

// execFile seqob-cli xhtlc-observe and parse its JSON. READ-ONLY: never moves value. Returns
// { tip, funded, amount, confirmations, spent, spender_txid?, preimage? } or throws.
function xhtlcObserve({ rpc, wallet, txid, vout, hashH, redeem }) {
  return new Promise((resolve, reject) => {
    if (!rpc || !txid) return reject(new Error('xhtlc-observe needs rpc + txid'));
    const args = ['xhtlc-observe', '-rpc', rpc, '-txid', String(txid), '-vout', String(vout ?? 0)];
    if (wallet) args.push('-wallet', wallet);
    if (hashH) args.push('-hash', String(hashH));
    if (redeem) args.push('-redeem', String(redeem));   // -> script_bound: is the funded output P2SH(redeem)?
    execFile(CFG.seqobCli, args, { timeout: STATUS_RPC_TIMEOUT_MS + 8000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`xhtlc-observe: ${scrubDetail(err.message)}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('xhtlc-observe: bad JSON')); }
    });
  });
}

// Build the planSettlement match from a bridged-take body (ONE source of truth with the wallet:
// bridge-driver.matchFromTake). Throws on a malformed body so the dispatch fails closed.
function buildBridgeMatchFromBody(body) {
  return matchFromTake({
    asset: resolveAsset(body.asset), side: body.side,
    payRail: body.payRail, recvRail: body.recvRail,
    makerBtcRail: body.maker_btc_rail, makerAssetRail: body.maker_asset_rail,
    takerAssetInbound: !!body.taker_asset_inbound, takerBtcInbound: !!body.taker_btc_inbound,
  });
}

// The per-leg amount (the bound on every LSP front) from the body: btc leg = sats, asset leg = atoms.
function bridgeLegAmount(body, leg) {
  return leg.unit === 'btc' ? Number(body.btc_sats || 0) : Number(body.asset_atoms || 0);
}

// Build the LIVE io the pure driver runs against. observe + provisionInbound + legAmountSat are FULLY
// wired to existing primitives. The value-moving actions compose the EXISTING audited primitives
// (lnrpc pay/settle + the xsubas-* HTLC CLIs) and read the per-leg handshake data (H, the counterparty
// invoice/HTLC terms, the LSP keys) from `job.legState`, which prepareBridgeLegs populates. Every value
// move FAILS CLOSED when its handshake data is absent, so an incomplete setup can only STALL, never
// mis-front — the same discipline nextBridgeStep enforces. The maker-side lift that fills the maker end
// of legState is the E2E-completion boundary (a LIVE maker, which this environment does not run).
function makeBridgeIo({ match, body, job }) {
  const st = (unit) => (job.legState && job.legState[unit]) || null;
  // The LSP's OWN BTC-LN node — it pays the taker's hold on H from here. Prefer the configured bridge/mixed
  // node (MIXED_BTC_RPC = the LSP's btc-taker) over a body-named node, and never a bare 'lightning-rpc'.
  const lspRpc = CFG.mixedBtcRpc || (targetFor('btc', null, body.btc_node_key || null).rpc);
  return {
    sleep, log: (...a) => console.error('[bridge]', ...a),
    legAmountSat: (leg) => bridgeLegAmount(body, leg),
    // W2(a): the driver flips this synchronously at its start / stop; /bridge/asset gates the taker's asset
    // hand-off on it (bridgeAssetHandoffAdmissible) rather than the lagging job.status.
    setDriverLive: (v) => { job._driverLive = !!v; },

    // JIT inbound BEFORE any lock: an LN receiver with no inbound cannot receive. Fully wired to the
    // existing non-custodial provisionInbound (asset leg). A BTC-LN receive JIT would use the BTC
    // channel path; not exercised here (the common cross is asset-LN receive).
    provisionInbound: async (leg) => {
      if (leg.unit !== 'asset') return;   // only an asset LN receiver is JIT-provisioned via SUBAS_LP today
      await provisionInbound({ nodeKey: body.node_key, assetId: resolveAsset(body.asset), amount: Number(body.asset_atoms) || 0 });
    },

    // NATIVE leg (LSP not in its value path): observe its lock so the crossed leg's front can gate on it.
    // The native leg settles taker<->maker on the existing path; here we only watch its on-chain/LN lock.
    startNative: async () => { /* the existing native path (offer lift) drives it; nothing to kick from here */ },
    observeNativeLocked: async (leg) => {
      const s = st(leg.unit);
      if (!s) return false;
      if (s.onchain && s.onchain.txid) {   // native on-chain HTLC funded == locked
        // FUND-SAFETY (review Finding 4): the whole-swap atomicity gate opens on THIS leg being locked, so
        // BIND it — don't front on merely "some funded UTXO exists" at the taker-supplied txid:vout. Verify
        // the funded output carries the AGREED asset id and pays AT LEAST the AGREED amount (from the offer
        // terms the maker signed, NOT the taker's self-reported leg). A mismatch — or an unreadable observe —
        // reports NOT locked, so the LSP never fronts against a bogus / underfunded / wrong-asset leg. When
        // the expected asset/amount are absent (an unwired shape) it degrades to the funded check, so it can
        // never falsely stall a correct front.
        try {
          const o = await xhtlcObserve({ rpc: s.onchainRpc, wallet: s.onchainWallet, txid: s.onchain.txid, vout: s.onchain.vout });
          if (!o.funded) return false;
          if (s.seqAmount != null && Number(s.seqAmount) > 0 && Number(o.amount || 0) < Number(s.seqAmount)) return false;
          if (s.seqAsset && o.asset_id && String(o.asset_id).toLowerCase() !== String(s.seqAsset).toLowerCase()) return false;
          return true;
        } catch { return false; }
      }
      if (s.lnRpc && s.hashH) {              // native LN payment held == locked
        try { const l = await lnrpc('holdinvoicelookup', [s.hashH], s.lnRpc, SIGNER_RPC_TIMEOUT_MS); return l.state === 'accepted' || l.state === 'settled'; }
        catch { return false; }
      }
      return false;
    },

    // CROSSED leg: OBSERVE the two ends for nextBridgeStep. Read-only, composes holdinvoicelookup
    // (the LN end) + xhtlc-observe (the on-chain end) + the HTLC terms the LSP itself set/verified.
    observe: async (leg) => {
      const s = st(leg.unit) || {};
      let ln = { registered: false, held: false, settled: false, preimage: null, expiryBlocks: s.lnExpiryBlocks };
      let recvReady;
      if (leg.lnSide === 'receiver') {
        // RECEIVER leg: the LSP PAYS the taker's hold on H out of its OWN node. The LN state is that
        // outgoing pay, captured by frontLn (a successful pay to a hold invoice returns P once the taker
        // settles). There is no hold at the LSP to look up, and the taker's node is self-custody.
        ln = { registered: !!s.frontAttempted, held: false, settled: !!s.frontPreimage,
          preimage: s.frontPreimage || null, expiryBlocks: s.lnExpiryBlocks };
        // W2 FRONT-BEFORE-FUND — the front is gated on the taker being HOLD-READY: it has registered its
        // BTC-LN hold on H and handed its recv_node_id (via POST /bridge/front), recorded as s.recvNodeId.
        // Until then recvReady:false withholds the front in nextBridgeStep (no-loss; nothing paid into a
        // void hold). frontLn itself also fails closed without recvNodeId — this just avoids the spin.
        recvReady = !!s.recvNodeId;
      } else if (s.lnRpc && s.hashH) {
        // PAYER leg: the LSP HOLDS the taker's incoming LN on H at its own node -> holdinvoicelookup.
        try {
          const l = await lnrpc('holdinvoicelookup', [s.hashH], s.lnRpc, SIGNER_RPC_TIMEOUT_MS);
          ln = { registered: !!l.state, held: l.state === 'accepted', settled: l.state === 'settled',
            preimage: (l.payment_preimage || l.preimage || null), expiryBlocks: s.lnExpiryBlocks };
        } catch { /* node momentarily unreadable -> treat as not-yet; the driver just re-observes */ }
      }
      let tip = s.tip || 0, onchain = null;
      if (s.htlc && s.htlc.txid) {
        try {
          const o = await xhtlcObserve({ rpc: s.onchainRpc, wallet: s.onchainWallet, txid: s.htlc.txid, vout: s.htlc.vout, hashH: s.hashH, redeem: s.htlc.script });
          tip = (typeof o.tip === 'number') ? o.tip : tip;
          // FUND-SAFETY: lockedToLsp is TRUE only when the handshake PARSED claim==LSP on H (verifiedClaimLsp)
          // AND xhtlc-observe confirms the funded output pays P2SH(this redeemScript) (script_bound). Either
          // missing -> false -> leg-bridge fails closed and the LSP never fronts. (A maker HTLC we funded
          // ourselves — payer leg — is trusted via lockedTo:'receiver' as before.)
          const lspBound = s.htlc.lockedTo === 'lsp' && !!s.verifiedClaimLsp && o.script_bound === true;
          onchain = { funded: !!o.funded, amountSat: Number(o.amount || 0), cltv: s.htlc.cltv,
            confs: Number(o.confirmations || 0),   // fed to leg-bridge's minRecoupConf gate (no fronting a 0-conf, RBF-able recoup target)
            lockedToLsp: lspBound, lockedToReceiver: s.htlc.lockedTo === 'receiver',
            spent: !!o.spent };
          // payer leg: P is read from the receiver's on-chain claim witness -> feed it to the core.
          if (o.preimage && !ln.preimage) ln.preimage = o.preimage;
        } catch { /* observe hiccup -> re-observe next tick */ }
      } else if (s.tipRpc) {
        try { const o = await xhtlcObserve({ rpc: s.tipRpc, txid: s.tipProbeTxid || '0'.repeat(64), vout: 0 }); if (typeof o.tip === 'number') tip = o.tip; } catch {}
      }
      // W1 (front-time) — attach the cross-leg LOCKTIME inputs so nextBridgeStep re-checks the wall-clock
      // ordering against the LIVE tip AT FRONT TIME (and on every resume tick), not only at handshake. Only
      // the reverse-cross BTC receiver leg has a taker asset-HTLC to relate to: its refund height T_seq is
      // on the ASSET leg state (or bridge_terms), and the maker BTC-HTLC refund height T_btc is oc.cltv on
      // THIS leg with the live BTC tip above. Read the LIVE seq tip here so a job whose BTC tip has drifted
      // since handshake is refused when the driver next tries to front. FAIL CLOSED: if the asset refund
      // height or the live seq tip is unreadable, feed the gate NaN so it refuses (never front on an
      // unverifiable ordering). Absent for every other shape -> the front path is byte-identical to before.
      let crossLock, publicP;
      if (leg.lnSide === 'receiver' && leg.unit === 'btc' && onchain) {
        const sa = st('asset') || {};
        const seqRefundHeight = Number(sa.seqLocktime ?? (job.bridge_terms && job.bridge_terms.seq_locktime));
        let seqTip = NaN;
        try { const so = await xhtlcObserve({ rpc: CFG.seqRpc, txid: '0'.repeat(64), vout: 0 }); seqTip = Number(so && so.tip); }
        catch { /* seq node momentarily unreadable -> seqTip stays NaN -> the gate fails closed (no front) */ }
        // FRONT-TIME re-check (against the live BTC + seq tips) — the gate derives the taker's required front-HTLC
        // survival from T_seq itself (requiredTakerHold), so a BTC tip that drifted toward a short/self-traded
        // T_btc now fails closed at front time too (not just handshake). Just the two cross-leg heights are needed.
        crossLock = { seqTip, seqRefundHeight };
        // W2(b) — surface a top-level PUBLIC preimage P so the front-time locktime gate can ALLOW a front that
        // is IMMEDIATELY recoupable (P known, recoup HTLC still unspent -> front + claim, zero exposure) rather
        // than STRAND a taker whose asset was already relayed + claimed. P is public once the maker has claimed
        // the taker's RELAYED asset leg; the authoritative source is that on-chain claim's witness (a
        // non-cooperative maker may skip the courtesy XcSecretRevealed). Prefer any P already learned (the front
        // itself, or the relay courtesy), else read the asset leg's spend. Best-effort: an unreadable P just
        // leaves the gate's fail-closed path in force (no front) — never a false "P public".
        const learned = (ln && ln.preimage) || (typeof job.relay_preimage === 'string' && /^[0-9a-f]{64}$/i.test(job.relay_preimage) ? job.relay_preimage : null);
        if (learned && /^[0-9a-f]{64}$/i.test(learned)) publicP = String(learned).toLowerCase();
        else if (sa.onchain && sa.onchain.txid) {
          try {
            const ao = await xhtlcObserve({ rpc: CFG.seqRpc, txid: sa.onchain.txid, vout: sa.onchain.vout || 0, hashH: s.hashH, redeem: sa.onchain.redeem });
            if (ao && ao.preimage && /^[0-9a-f]{64}$/i.test(ao.preimage)) publicP = String(ao.preimage).toLowerCase();
          } catch { /* asset-leg observe hiccup -> no public P this tick -> gate stays fail-closed */ }
        }
        // W2 taker-liveness: surface the PUBLIC preimage (the maker's on-chain asset claim, or its courtesy
        // reveal) on the job so GET /swap/<id> hands P to the TAKER. P is on-chain-public once the maker
        // claims, so this leaks nothing — it just lets the taker settle its already-fronted hold even when a
        // non-cooperative maker skips the courtesy reveal. Persist once; the taker verifies sha256(P)==H itself.
        if (publicP && job.public_preimage !== publicP) { job.public_preimage = publicP; persistJobs(); }
      }
      const base = (recvReady !== undefined) ? { tip, onchain, ln, recvReady } : { tip, onchain, ln };
      return crossLock ? { ...base, crossLock, ...(publicP ? { preimage: publicP } : {}) } : base;
    },

    // --- value-moving actions: compose the EXISTING primitives; FAIL CLOSED on missing handshake data ---
    // receiver leg: pay the receiver's hold invoice on H (this reveals P once they settle).
    frontLn: async (leg) => {
      const s = st(leg.unit);
      if (!s || !s.recvNodeId || !s.hashH || !(s.amountSat > 0)) throw new Error('front-ln blocked: taker node id / H / amount not established yet — fail closed (no LN fronted)');
      s.frontAttempted = true; persistJobs();
      const amtMsat = s.amountSat * 1000;
      const adoptP = (p) => { if (p && /^[0-9a-f]{64}$/i.test(String(p))) { s.frontPreimage = String(p).toLowerCase(); persistJobs(); return true; } return false; };
      // W2 FRONT-BEFORE-FUND — mark the front CONFIRMED (committed toward the taker's hold on H) so the
      // taker can learn it (GET /swap/<id> status 'fronted') and ONLY THEN fund + relay its asset. This is
      // the gate /bridge/asset checks (bridgeFrontConfirmed): the taker never exposes its asset before the
      // LSP has actually paid. Set on any live/settled pay on H — a committed sendpay, an adopted prior
      // pending pay, or an already-complete one. Idempotent; persisted before waitsendpay blocks.
      const markFronted = () => { if (s.frontHeld !== true) { s.frontHeld = true; if (job.status === 'confirming') job.status = 'fronted'; persistJobs(); } };
      // FUND-SAFETY (idempotent front across a resume — review Finding 5): observe reports ln.held:false for
      // this receiver leg, so the state machine relies on the in-process waitsendpay below. On a restart
      // mid-front (frontAttempted persisted, frontPreimage not yet), re-entering here must NOT issue a
      // duplicate sendpay CLN may reject — that would leave us paid but unable to re-learn P and recoup.
      // So ADOPT any prior attempt on H first: a COMPLETE pay already carries P; a PENDING pay is in flight,
      // so waitsendpay blocks for the taker to settle it. Only a genuine no-pay funds a fresh sendpay.
      // paymentStatusForHash THROWS if the node is unreadable, so we never re-pay on an uncertain "no pay".
      const prior = await paymentStatusForHash(lspRpc, s.hashH);
      if (prior.preimage) { markFronted(); adoptP(prior.preimage); return; }
      if (prior.pending) { markFronted(); const w = await lnrpc('waitsendpay', [String(s.hashH)], lspRpc, CFG.mixedTimeoutMs); adoptP(w && (w.payment_preimage || w.preimage)); return; }
      // W1-MINT — COUPLE the front HTLC's minted expiry to an ABSOLUTE Bitcoin height at PAY time, NOT the stale
      // handshake delta. getroute's final-cltv is a DELTA from the PAY-time tip, so minting with the
      // handshake-sized s.frontMinFinalCltv would land the incoming HTLC's absolute expiry at payTip + staleDelta,
      // which FLOATS UP as the BTC tip advances between handshake and pay: it could OVERSHOOT T_btc - claimMargin
      // (the maker refunds its BTC before the LSP recoups with P = full-front loss) or, if stale-short, die before
      // T_seq (the maker waits it out, then reveals P = taker's dead hold, asset gone). So re-read the LIVE BTC +
      // SEQ tips HERE and compute the mint target fresh: frontHtlcMintTarget pins the absolute expiry to
      // H = T_btc - claimMargin (LSP always recoups) and returns the getroute DELTA = H - payTip so the minted
      // expiry == H EXACTLY, independent of later drift. It re-runs the SAME locktime gate at the live tip
      // (gated == minted by construction) and FAILS CLOSED if T_btc has drifted so the window is empty (H no
      // longer covers T_seq under conservative-fast BTC). Fail closed = no front; in FRONT-BEFORE-FUND the taker
      // has exposed nothing, so it is a no-loss terminal (falls back to native). s.frontMinFinalCltv stays an
      // EARLY handshake reject only — it is NEVER the minted value now. The taker independently re-verifies the
      // ACTUAL minted incoming-HTLC expiry against T_seq (swap.js step-4.5 via listhtlcs), backstopping this.
      const seqLegForMint = st('asset') || {};
      const tSeqForMint = Number(seqLegForMint.seqLocktime ?? (job.bridge_terms && job.bridge_terms.seq_locktime));
      const tBtcForMint = Number(s.htlc && s.htlc.cltv);
      let payBtcTip = NaN, paySeqTip = NaN;
      try { const bo = await xhtlcObserve({ rpc: CFG.subasBtcRpc, wallet: CFG.subasBtcWallet, txid: s.htlc.txid, vout: s.htlc.vout }); payBtcTip = Number(bo && bo.tip); } catch { /* unreadable BTC tip -> NaN -> mint target fails closed (no front) */ }
      try { const so = await xhtlcObserve({ rpc: CFG.seqRpc, txid: '0'.repeat(64), vout: 0 }); paySeqTip = Number(so && so.tip); } catch { /* unreadable SEQ tip -> NaN -> mint target fails closed (no front) */ }
      const mint = frontHtlcMintTarget({ btcTip: payBtcTip, btcRefundHeight: tBtcForMint, seqTip: paySeqTip, seqRefundHeight: tSeqForMint });
      if (!mint.ok) throw new Error(`front-ln blocked (fail closed, no LN fronted): ${mint.reason}`);
      // VERIFY-NOT-TRUST the ACTUAL committed final-hop CLTV — never the intended delta. frontHtlcMintTarget
      // pins the INTENDED absolute expiry to H = T_btc - claimMargin, but it computed its delta against
      // BITCOIND's tip (payBtcTip). getroute/sendpay run on the CLN node and commit the final-hop HTLC's
      // absolute expiry as (the CLN node's OWN blockheight) + (the route's final-hop delay). Two ways the
      // ACTUAL minted expiry drifts off H even after a clean mint: (i) CHAIN-VIEW SKEW — if CLN's height leads
      // bitcoind's by δ, a delta off payBtcTip lands the real expiry at H + δ, which for δ>0 overshoots
      // T_btc - claimMargin so the LSP can't recoup (a maker/self-trader waits past T_btc, refunds its BTC,
      // THEN settles the still-live front with P = full-front loss); (ii) ROUTE PADDING — getroute may pad the
      // final delay (shadow-routing / recipient min_final_cltv) above what we asked, independently overshooting.
      // FIX: (1) base the getroute DELTA on CLN's OWN blockheight (the value it adds the final delay to), so a
      // clean route lands the ACTUAL expiry at H in CLN's view irrespective of δ; (2) AFTER getroute, BEFORE
      // sendpay, re-derive the ACTUAL absolute expiry from CLN's OWN tip + the route's OWN final-hop delay and
      // require it inside [T_seq cover, T_btc - claimMargin] (verifyFrontRouteExpiry) — fail closed on any
      // overshoot. Front-before-fund => a fail-closed here exposes nothing (native fallback). The taker
      // independently verifies the ACTUAL LOWER bound via listhtlcs (swap.js step-4.5); this is the LSP-side
      // ACTUAL UPPER bound, so the minted HTLC is verified on BOTH bounds off ACTUAL values by the party each protects.
      let clnBlockheight = NaN;
      try { const gi = await lnrpc('getinfo', [], lspRpc, SIGNER_RPC_TIMEOUT_MS); clnBlockheight = Number(gi && gi.blockheight); } catch { /* unreadable CLN tip -> NaN -> fails closed just below */ }
      if (!Number.isFinite(clnBlockheight)) throw new Error('front-ln blocked (fail closed, no LN fronted): the CLN node blockheight is unreadable — cannot verify the actual committed front-HTLC expiry');
      // The getroute DELTA that lands the ACTUAL absolute expiry at H in the CLN node's OWN view (the base
      // getroute adds the final delay to), NOT bitcoind's — so chain-view skew δ cannot float the real expiry.
      const finalCltv = mint.absoluteExpiryHeight - clnBlockheight;
      if (!Number.isFinite(finalCltv) || finalCltv <= 0) throw new Error(`front-ln blocked (fail closed, no LN fronted): degenerate final-CLTV delta ${finalCltv} (H ${mint.absoluteExpiryHeight} <= CLN tip ${clnBlockheight})`);
      // The seqln holdinvoice has NO bolt11 — pay it by BARE HASH: route to the taker's node, sendpay keyed
      // on H, and waitsendpay BLOCKS until the taker settles the hold with P and returns it. That returned P
      // is exactly how the LSP learns the preimage to recoup — and, being a hold, the payment stays in-flight
      // (the taker paid nothing until it settles), so this is a true front, not a fire-and-forget.
      const route = await lnrpc('getroute', [String(s.recvNodeId), String(amtMsat), '10', String(finalCltv)], lspRpc, SIGNER_RPC_TIMEOUT_MS);
      if (!route || !Array.isArray(route.route) || !route.route.length) throw new Error('front-ln: no route to the taker node — fail closed');
      // Re-read the ACTUAL final-hop CLTV the route WILL commit (its own last-hop delay) and verify it against
      // reality on BOTH bounds BEFORE any value moves. This — not the intended delta — is what actually bounds
      // the LSP's recoup and the taker's hold; a skew/padding overshoot fails closed here, no LN fronted.
      const actualDelay = Number(route.route[route.route.length - 1] && route.route[route.route.length - 1].delay);
      const routeCheck = verifyFrontRouteExpiry({ clnBlockheight, actualDelay, tSeqCoverHeight: mint.tSeqCoverHeight, absoluteExpiryHeight: mint.absoluteExpiryHeight });
      if (!routeCheck.ok) throw new Error(`front-ln blocked (fail closed, no LN fronted): ${routeCheck.reason}`);
      await lnrpc('sendpay', [JSON.stringify(route.route), String(s.hashH)], lspRpc, SIGNER_RPC_TIMEOUT_MS);
      // sendpay has committed the HTLC toward the taker's hold (it now shows as pending) — the front is live.
      // Mark it CONFIRMED before waitsendpay blocks, so the taker sees 'fronted' and may safely fund its asset.
      markFronted();
      const w = await lnrpc('waitsendpay', [String(s.hashH)], lspRpc, CFG.mixedTimeoutMs);
      adoptP(w && (w.payment_preimage || w.preimage));
    },
    // payer leg: fund the receiver's on-chain HTLC (claim=receiver w/ P, refund=LSP). Reuses the audited
    // xsubas-fund-btc primitive; records the funded HTLC + the LSP refund key in legState.
    fundOnchain: async (leg) => {
      const s = st(leg.unit);
      if (!s || !s.receiverClaimPub || !s.hashH || !(s.amountSat > 0) || !s.cltv) throw new Error('fund-onchain blocked: receiver claim pub / H / amount / cltv not established — fail closed (nothing funded)');
      const funded = await fundBridgeHtlcBtc({ claimPub: s.receiverClaimPub, hashH: s.hashH, amountSat: s.amountSat, cltv: s.cltv });
      s.htlc = { txid: funded.btc_htlc_txid, vout: funded.btc_htlc_vout, amount: funded.btc_htlc_amount,
        script: funded.btc_htlc_script, cltv: funded.btc_locktime, lockedTo: 'receiver' };
      s.lspRefundPriv = funded.btc_refund_priv;   // LSP-held; bounds our recoup to exactly this HTLC
      persistJobs();
    },
    // receiver leg: claim the payer's on-chain HTLC (locked to the LSP) with the revealed P. Reuses
    // xsubas-claim-btc; the LSP's claim key is bounded to exactly what it fronted.
    recoupClaim: async (leg, step, obs) => {
      const s = st(leg.unit);
      const P = obs && obs.ln && obs.ln.preimage;
      if (!s || !s.htlc || !s.lspClaimPriv || !P) throw new Error('recoup-claim blocked: HTLC/claim-key/preimage missing — fail closed (recoup deferred, never lost)');
      await claimBridgeHtlcBtc({ htlc: s.htlc, preimage: P, claimPriv: s.lspClaimPriv });
    },
    // payer leg: settle the payer's held LN with the P read from the receiver's on-chain claim.
    recoupSettle: async (leg, step, obs) => {
      const s = st(leg.unit);
      const P = obs && obs.ln && obs.ln.preimage;
      if (!s || !s.hashH || !P) throw new Error('recoup-settle blocked: held-invoice/preimage missing — fail closed');
      await lnrpc('holdinvoicesettle', [s.hashH, P], lspRpc, SIGNER_RPC_TIMEOUT_MS);
    },
    // payer leg: no claim by the on-chain CLTV -> refund the LSP-funded HTLC (the payer's LN hold returns
    // to them on its own). Reuses the xsubas BTC refund path.
    refundOnchain: async (leg) => {
      const s = st(leg.unit);
      if (!s || !s.htlc || !s.lspRefundPriv) throw new Error('refund-onchain blocked: HTLC/refund-key missing — fail closed');
      await refundBridgeHtlcBtc({ htlc: s.htlc, refundPriv: s.lspRefundPriv });
    },
  };
}

// fund/claim/refund helpers that shell out to the EXISTING audited BTC HTLC primitives. The SEQ-asset
// on-chain leg (asset<->asset bridging) reuses the SAME xchain code via a mirror CLI; wiring it is the
// remaining mechanical step (see report). These are the ONLY value-moving shells the bridge io calls.
function fundBridgeHtlcBtc({ claimPub, hashH, amountSat, cltv, refundPriv }) {
  return new Promise((resolve, reject) => {
    if (!CFG.subasBtcRpc || !CFG.subasBtcWallet) return reject(new Error('BTC HTLC fund not configured (SUBAS_BTC_RPC + SUBAS_BTC_WALLET)'));
    const args = ['xsubas-fund-btc', '-maker-claim-pub', String(claimPub), '-hash', String(hashH),
      '-btc-amount', String(amountSat), '-btc-locktime', String(cltv),
      '-btc-rpc', CFG.subasBtcRpc, '-btc-wallet', CFG.subasBtcWallet, '-btc-chain', CFG.subasBtcChain];
    if (refundPriv) args.push('-refund-priv', String(refundPriv));
    execFile(CFG.seqobCli, args, { timeout: CFG.mixedTimeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`fund BTC HTLC: ${scrubDetail(err.message)}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('fund BTC HTLC: bad JSON')); }
    });
  });
}
function claimBridgeHtlcBtc({ htlc, preimage, claimPriv, refundPub }) {
  return new Promise((resolve, reject) => {
    if (!CFG.subasBtcRpc) return reject(new Error('BTC HTLC claim not configured (SUBAS_BTC_RPC)'));
    const args = ['xsubas-claim-btc', '-btc-rpc', CFG.subasBtcRpc, '-btc-chain', CFG.subasBtcChain,
      '-txid', String(htlc.txid), '-vout', String(htlc.vout), '-amount', String(htlc.amount),
      '-redeem-script', String(htlc.script), '-t-btc', String(htlc.cltv),
      '-refund-pub', String(refundPub || htlc.refundPub || ''), '-preimage', String(preimage), '-claim-priv', String(claimPriv)];
    const recoupWallet = CFG.bridgeRecoupWallet || CFG.subasBtcWallet;   // the LSP's own wallet receives the recoup
    if (recoupWallet) args.push('-btc-wallet', recoupWallet);
    execFile(CFG.seqobCli, args, { timeout: CFG.mixedTimeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`claim BTC HTLC: ${scrubDetail(err.message)}`));
      resolve(String(stdout || '').trim());
    });
  });
}
function refundBridgeHtlcBtc({ htlc, refundPriv }) {
  return new Promise((resolve, reject) => {
    if (!CFG.subasBtcRpc) return reject(new Error('BTC HTLC refund not configured (SUBAS_BTC_RPC)'));
    // xsubas-refund recovers by state-file; a param-based refund reuses the same xchain RefundBTCLeg.
    // Left to the E2E wiring (needs the funded-HTLC state file the fund step persists on the box).
    return reject(new Error('on-chain refund via state-file left to E2E wiring (no-loss: the CLTV refund path exists in xsubas-refund)'));
  });
}

// prepareBridgeLegs populates job.legState[unit] for every leg: the per-leg RPCs + amounts from the body,
// and — for the ONE fund-safe rail crossing the io wires (a taker that SELLS the asset and RECEIVES BTC
// over Lightning, against a REVERSE (buy) cross maker whose BTC leg is on-chain) — the MAKER SIDE via the
// real courier handshake (bridge-maker.runReverseBridgeTerms). That handshake hands the maker the LSP's
// OWN btc-claim pubkey, so the maker locks a real on-chain BTC HTLC paying the LSP on the maker's H; we
// parse+verify that HTLC (claim==LSP, H, refund, CLTV) BEFORE recording it, so leg-bridge only ever fronts
// once the recoup is provably locked to the LSP. Any other crossing shape (or a missing taker key) leaves
// the maker side UNSET, so every value move fails closed (stall, never mis-front). Async (opens a relay
// WS). Records the outcome on job.bridgeHandshake and the taker-facing terms on job.bridge_terms.
async function prepareBridgeLegs({ match, body, job }) {
  const plan = planSettlement(match);
  const { bridged, native } = classifyLegs(plan);
  job.legState = job.legState || {};
  for (const leg of [...bridged, ...native]) {
    const isBtc = leg.unit === 'btc';
    const s = job.legState[leg.unit] = job.legState[leg.unit] || {};
    s.unit = leg.unit; s.bridge = !!leg.bridge; s.lnSide = leg.lnSide || null;
    s.amountSat = bridgeLegAmount(body, leg);
    // On-chain end RPC/wallet: BTC leg -> bitcoind; asset leg -> the Sequentia node.
    s.onchainRpc = isBtc ? CFG.subasBtcRpc : CFG.seqRpc;
    s.onchainWallet = isBtc ? CFG.subasBtcWallet : CFG.seqWallet;
    s.tipRpc = s.onchainRpc;
    // The LN end of the leg lives on the TAKER's hosted node (its hold on H); the LSP pays it from its own
    // node (see makeBridgeIo's lspRpc). observe reads the hold via this rpc.
    s.lnRpc = s.lnRpc || (isBtc ? targetFor('btc', null, body.btc_node_key || null).rpc
                                : targetFor('seq', resolveAsset(body.asset), body.node_key || null).rpc);
  }

  // The maker handshake — ONLY for the proven, io-supported crossing: BTC leg bridged, lnSide 'receiver'
  // (taker sells the asset, receives BTC over LN), against a reverse maker. Everything else stays unwired
  // (fail closed). Never throws out of the job: a failure records job.bridgeHandshake.error and leaves the
  // maker side unset, so the driver fails closed rather than the job crashing.
  // ONE source of truth with the wallet's pre-Review capability check (bridge-driver.crossingShapeSupported):
  // the wired shape is BTC-leg bridged / lnSide 'receiver' (taker sells asset, receives BTC over LN) with a
  // native asset leg. If the wallet ever promised a bridge for another shape, this refuses it identically.
  const canBridge = crossingShapeSupported(plan);
  if (!canBridge) {
    job.bridgeHandshake = { ok: false, error: 'this crossing shape is not wired (only taker-sells-asset / receives-BTC-over-LN vs a reverse maker is)' };
    return plan;
  }
  const takerSeqRefundPub = body.taker_seq_refund_pub || body.takerSeqRefundPub || '';
  if (!/^[0-9a-fA-F]{66}$/.test(takerSeqRefundPub)) {
    job.bridgeHandshake = { ok: false, error: 'bridged sell needs taker_seq_refund_pub (the taker\'s OWN asset-refund key; the LSP never holds a taker key) — fail closed' };
    return plan;
  }
  if (!body.offer_id || !body.maker_pubkey) {
    job.bridgeHandshake = { ok: false, error: 'bridged take needs offer_id + maker_pubkey to lift the reverse maker' };
    return plan;
  }
  if (!CFG.subasBtcRpc || !CFG.subasBtcWallet) {
    job.bridgeHandshake = { ok: false, error: 'BTC on-chain backend (SUBAS_BTC_RPC + SUBAS_BTC_WALLET) not configured — cannot recoup the bridged BTC leg' };
    return plan;
  }
  const lspClaim = newBridgeClaimKeypair();   // the LSP's BTC claim key; its priv bounds the recoup
  let session = null;
  try {
    session = await openReverseBridgeSession({
      offer: { offer_id: body.offer_id, maker_pubkey: body.maker_pubkey },
      relayBase: CFG.crossRelay,
      takeAtoms: BigInt(Number(body.asset_atoms) || 0),
    });
    const hs = await runReverseBridgeTerms({ session,
      lspBtcClaimPubHex: lspClaim.pubHex, takerSeqRefundPubHex: takerSeqRefundPub,
      expect: { btcSats: Number(body.btc_sats) || 0, seqAtoms: Number(body.asset_atoms) || 0 } });

    // BRIDGED BTC leg (receiver): the maker's real on-chain BTC HTLC, verified locked to the LSP on H.
    const sb = job.legState.btc;
    sb.hashH = hs.hashHex;
    sb.htlc = { txid: hs.btcHtlc.txid, vout: hs.btcHtlc.vout, amount: hs.btcHtlc.amount,
      script: hs.btcHtlc.redeemScriptHex, cltv: hs.btcHtlc.cltv, lockedTo: 'lsp', refundPub: hs.btcHtlc.refundPubHex };
    sb.lspClaimPriv = lspClaim.privHex;      // LSP-held; the claim key that recoups exactly this HTLC
    sb.verifiedClaimLsp = true;              // parse-verified at handshake (P2SH binding re-checked in observe)
    sb.amountSat = hs.btcAmount;             // front the LN for exactly what the recoup pays
    // recvBolt11 / the taker's hold on H is filled by the taker's follow-up (it can only mint the hold
    // AFTER it learns H below); until then frontLn fails closed. lnExpiryBlocks irrelevant for a receiver leg.

    // NATIVE asset leg (direct taker<->maker): the terms the taker needs to fund its OWN asset HTLC.
    const sa = job.legState.asset;
    if (sa) { sa.makerSeqClaimPub = hs.makerSeqClaimPubHex; sa.seqLocktime = hs.seqLocktime; sa.seqAmount = hs.seqAmount; sa.seqAsset = resolveAsset(body.asset); }

    // W1 — LOCKTIME-ORDERING GATE. Before recording the handshake OK (which lets the driver front the
    // taker's LN hold), verify the maker's BTC-HTLC refund locktime T_btc is comfortably LATER, in
    // WALL-CLOCK, than the last moment the shared preimage P can be used against the LSP. Otherwise a
    // malicious maker with a SHORT T_btc that clears the pure core's naive block runway can front-bleed
    // the LSP: front the ~2h hold, refund its BTC at T_btc, THEN reveal P by claiming the taker's asset —
    // the LSP learns P too late and its recoup target is already gone (full-front loss). We read both tips
    // and refuse unless btc_refund_wall >= seq_refund_wall + hold_life + margin(6 BTC blocks). ANY failure
    // to read the tips or a failed gate => fail closed (nothing has been fronted): wipe the recoup wiring
    // so even a stray driver tick can only stall, close the session, and record the refusal.
    let btcTip, seqTip;
    try {
      const bo = await xhtlcObserve({ rpc: CFG.subasBtcRpc, wallet: CFG.subasBtcWallet, txid: sb.htlc.txid, vout: sb.htlc.vout });
      const so = await xhtlcObserve({ rpc: CFG.seqRpc, txid: '0'.repeat(64), vout: 0 });
      btcTip = Number(bo && bo.tip); seqTip = Number(so && so.tip);
    } catch (e) {
      try { session && session.close(); } catch {}
      job._bridgeSession = null;
      if (job.legState.btc) delete job.legState.btc.verifiedClaimLsp;
      job.bridgeHandshake = { ok: false, error: `locktime-ordering gate could not read chain tips — fail closed (nothing fronted): ${scrubDetail(String((e && e.message) || e))}` };
      persistJobs();
      return plan;
    }
    // The gate sizes the taker's required front-HTLC survival from T_seq itself (requiredTakerHold, one BTC-time
    // assumption) and demands the maker's T_btc give at least that many BTC blocks of recoup runway; a short or
    // self-traded T_btc (or a collapsed/too-far T_seq) fails closed here. The honest fleet with a SHORT T_btc is
    // correctly REFUSED and the wallet falls back to native — that is the fund-safe-by-construction behaviour.
    const gate = checkBridgeLocktimeOrdering({
      btcTip, btcRefundHeight: Number(sb.htlc.cltv),
      seqTip, seqRefundHeight: Number(hs.seqLocktime),
    });
    if (!gate.ok) {
      try { session && session.close(); } catch {}
      job._bridgeSession = null;
      if (job.legState.btc) delete job.legState.btc.verifiedClaimLsp;   // no recoup wiring survives a refusal
      job.bridgeHandshake = { ok: false, error: `locktime-ordering gate refused (nothing fronted): ${gate.reason}` };
      persistJobs();
      console.error('[bridge] locktime-ordering gate REFUSED:', gate.reason);
      return plan;
    }

    // W2 — HOLD-LIFE vs T_seq. The taker's BTC-LN hold must stay SETTLEABLE until strictly AFTER the maker's
    // latest possible asset claim (T_seq wall-clock) + reorg/settle margin — else an adversarial maker WAITS
    // for a short hold to lapse, THEN claims the taker's asset (reveals P): the taker's dead hold collects
    // nothing while its asset is gone (full asset loss). Two guards, both fail-closed (nothing fronted yet):
    //   FIX 2 — BOUND T_seq: refuse a maker whose T_seq is unreasonably far from the live seq tip, so the
    //     taker's hold AND the LSP's fronted-funds lock are bounded to a sane maximum (a few hours of blocks).
    //   Publish the required hold expiry + the front HTLC's min-final-CLTV (sized from T_seq + the live seq
    //     tip) so the taker mints a hold that outlives T_seq and the LSP routes its front (frontLn getroute)
    //     with an HTLC that cannot lapse before the maker's latest claim. requiredTakerHold enforces BOTH the
    //     bound and the LN max-CLTV feasibility; either failing => fail closed here (never front).
    const holdReq = requiredTakerHold({ seqTip, seqRefundHeight: Number(hs.seqLocktime) });
    if (!holdReq.ok) {
      try { session && session.close(); } catch {}
      job._bridgeSession = null;
      if (job.legState.btc) delete job.legState.btc.verifiedClaimLsp;
      job.bridgeHandshake = { ok: false, error: `hold-life vs T_seq refused (nothing fronted): ${holdReq.reason}` };
      persistJobs();
      console.error('[bridge] hold-life vs T_seq REFUSED:', holdReq.reason);
      return plan;
    }
    // EARLY handshake reject only: requiredTakerHold above already failed closed (holdReq.ok) if T_seq is
    // out of bound or the required CLTV exceeds the LN maximum. frontMinFinalCltv is recorded for diagnostics
    // and the taker's own hold sizing (via bridge_terms.hold_min_final_cltv), but is NO LONGER the minted
    // value — frontLn re-derives the mint target from the LIVE tips (frontHtlcMintTarget), pinning the front
    // HTLC's absolute expiry to T_btc - claimMargin, so no stale handshake delta can drift the minted expiry.
    sb.frontMinFinalCltv = holdReq.minFinalCltvBlocks;

    job._bridgeSession = session;            // kept alive so the taker's funded asset leg can be relayed in
    job.bridge_terms = { hash_h: hs.hashHex, maker_seq_claim_pub: hs.makerSeqClaimPubHex,
      seq_locktime: hs.seqLocktime, seq_amount: hs.seqAmount, btc_amount: hs.btcAmount,
      btc_htlc_txid: hs.btcHtlc.txid, btc_htlc_cltv: hs.btcHtlc.cltv,
      // W2 hold-life vs T_seq — the taker mints its BTC-LN hold with THIS expiry (seconds) so it stays
      // settleable until after T_seq + margin, and hands hold_min_final_cltv to /bridge/front so the LSP's
      // front HTLC carries enough CLTV runway. seq_tip is the live tip these were sized against.
      seq_tip: seqTip, hold_expiry_secs: holdReq.holdExpirySecs, hold_min_final_cltv: holdReq.minFinalCltvBlocks };
    job.bridgeHandshake = { ok: true };
    persistJobs();
    console.error('[bridge] maker locked BTC HTLC to the LSP:', hs.btcHtlc.txid, 'on H', hs.hashHex);
  } catch (e) {
    try { session && session.close(); } catch {}
    job._bridgeSession = null;
    job.bridgeHandshake = { ok: false, error: `maker handshake failed (nothing fronted): ${scrubDetail(String((e && e.message) || e))}` };
  }
  return plan;
}

// runBridgedSwapJob: the async job that drives a whole bridged take. Mirrors the over-0conf mixed path:
// persist-before-broadcast (the job is set BEFORE any funding), swap_nonce idempotency, resumable. The
// fund-safety is the pure driver; this only supplies the live io.
async function runBridgedSwapJob(body, job) {
  let match;
  try { match = buildBridgeMatchFromBody(body); }
  catch (e) { return { ok: false, error: `bridged take: ${scrubDetail(String((e && e.message) || e))}` }; }
  const plan = await prepareBridgeLegs({ match, body, job });
  if (plan.happyCoincidence) {
    return { ok: false, handled_by: 'native',
      error: 'this match is a happy coincidence (rails coincide) — settle it natively, not via the bridge' };
  }
  // The maker handshake must have secured the recoup (BTC HTLC locked to the LSP) before we drive any
  // value move — else the driver would only stall. Fail closed here with the exact reason.
  if (job.bridgeHandshake && job.bridgeHandshake.ok === false) {
    return { ok: false, rail: 'bridged', settlement_plan: bridgeplanSummary(plan),
      error: `bridged take not settled: ${job.bridgeHandshake.error}` };
  }
  const io = makeBridgeIo({ match, body, job });
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 3000, maxTicks: Math.ceil(CFG.mixedTimeoutMs / 3000) } });
  return r.ok
    ? { ok: true, settled: true, rail: 'bridged', finality: 'confirming', anchor_bound: true,
        settlement_plan: bridgeplanSummary(plan), legs: r.legs }
    // W2(b): a pre-front maxTicks exhaustion is RESUMABLE (nothing fronted, the taker's asset leg is
    // already committed) — surface `interrupted` so the job is marked 'interrupted' (re-driven by
    // resume-on-boot) rather than terminal 'failed', which would strand the taker.
    : { ok: false, rail: 'bridged', error: `bridged swap did not settle: ${scrubDetail(r.reason || 'unknown')}`,
        settlement_plan: bridgeplanSummary(plan), legs: r.legs || [], ...(r.interrupted ? { interrupted: true } : {}) };
}

// A compact, wire-friendly view of the plan for the wallet's honest net-terms display.
function bridgeplanSummary(plan) {
  const c = classifyLegs(plan);
  return { bridged: !plan.happyCoincidence,
    btc_leg: plan.btcLeg && { rail: plan.btcLeg.rail, bridge: plan.btcLeg.bridge, lnSide: plan.btcLeg.lnSide, jitInbound: plan.btcLeg.jitInbound },
    asset_leg: plan.assetLeg && { rail: plan.assetLeg.rail, bridge: plan.assetLeg.bridge, lnSide: plan.assetLeg.lnSide, jitInbound: plan.assetLeg.jitInbound },
    bridge_legs: c.bridged.map((l) => l.unit), jit_legs: c.jit.map((l) => l.unit) };
}

// /rails probe cache: 10s per asset (4 relay fetches per miss).
const _railsCache = new Map();

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

// Short-TTL cache for the no-param /anchor tip. That path is unauthenticated (the wallet needs it
// before login and the taker's T_seq guard polls it during a swap) and each miss costs two Sequentia
// RPCs, so a hot loop or a burst of clients would amplify into RPC load. The tip only moves once per
// block (~seconds apart at most), and it is fully public, so a couple of seconds of staleness is
// harmless. Only the no-param tip is cached; tx/block lookups are per-swap and keyed, not hot.
let _anchorTip = { at: 0, body: null };
const ANCHOR_TIP_TTL_MS = 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'seqln-lsp' });
  // GET /anchor            -> the Sequentia tip's CURRENT Bitcoin-anchor height.
  // GET /anchor?block=<hash> -> the Bitcoin-anchor height of THAT specific block.
  // GET /anchor?tx=<txid>    -> the Bitcoin-anchor height of the block that CONFIRMED that tx.
  // The cross-chain claim gate needs the anchor of the SWAP LEG'S OWN block (the block that holds the
  // maker's HTLC output), NOT the tip: a block's anchor is FIXED (it never rises as the chain
  // advances), and per the anchoring theorem the leg's anchor must be >= the BTC-lock height or the
  // leg could outlive the BTC. Serving it here (node-sourced, keyed to the leg's own tx/block) lets
  // the wallet verify the leg's real anchor instead of trusting the maker's self-reported number.
  // A null anchor_height means "not confirmed yet" (the caller WAITS). Public chain data, so it sits
  // before the token check like /health.
  if (req.method === 'GET' && url.pathname === '/anchor') {
    try {
      const txParam = url.searchParams.get('tx');
      const blockParam = txParam ? null : url.searchParams.get('block');
      const anchorOfBlock = async (hash) => {
        let blk; try { blk = await seqRpcCall('getblock', [hash]); }
        catch { return { ok: true, anchor_height: null }; }   // not yet confirmed/known
        return { ok: true, block: hash, height: (blk.height ?? null),
          anchor_height: (blk.anchorheight ?? null), anchor_hash: (blk.anchorhash ?? null) };
      };
      if (txParam) {
        if (!/^[0-9a-fA-F]{64}$/.test(txParam)) return send(res, 400, { ok: false, error: 'bad txid' });
        let tx; try { tx = await seqRpcCall('getrawtransaction', [txParam, true]); }
        catch { return send(res, 200, { ok: true, tx: txParam, anchor_height: null }); }   // unknown/unconfirmed
        if (!tx || !tx.blockhash) return send(res, 200, { ok: true, tx: txParam, anchor_height: null });   // in mempool, no block yet
        return send(res, 200, { ...(await anchorOfBlock(tx.blockhash)), tx: txParam });
      }
      if (blockParam) {
        if (!/^[0-9a-fA-F]{64}$/.test(blockParam)) return send(res, 400, { ok: false, error: 'bad block hash' });
        return send(res, 200, await anchorOfBlock(blockParam));
      }
      const now = Date.now();
      if (_anchorTip.body && (now - _anchorTip.at) < ANCHOR_TIP_TTL_MS)
        return send(res, 200, _anchorTip.body);
      const info = await seqRpcCall('getblockchaininfo');
      const blk = await seqRpcCall('getblock', [info.bestblockhash]);
      const body = { ok: true, height: info.blocks,
        anchor_height: (blk.anchorheight ?? null), anchor_hash: (blk.anchorhash ?? null) };
      _anchorTip = { at: now, body };
      return send(res, 200, body);
    } catch {
      return send(res, 502, { ok: false, error: 'anchor unavailable' });   // generic — never surface the internal RPC endpoint
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
    // GET /rails?asset=<id> -> which BTC<->asset rails have LIVE resting liquidity for
    // this asset, per side, so wallets can gate their rail toggles HONESTLY instead of
    // offering a rail with no maker (the "mixed swap did not settle" class). Universal
    // mapping: an offer with trade_dir SELL means the maker sells the asset => the USER
    // can BUY on that rail; BUY => the user can SELL. Rail identity comes from the
    // relay + the offer's settlement: :9955 BTC-leg = cross; :9965 lightning
    // ln_direction 0/1 = submarine, 2/3 = pure-LN; :9966/:9971 = sub-asset.
    if (req.method === 'GET' && url.pathname === '/rails') {
      const assetId = resolveAsset(url.searchParams.get('asset'));
      if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: '?asset=<sequentia asset id> is required (not BTC)' });
      const now = Date.now();
      const hit = _railsCache.get(assetId);
      if (hit && now - hit.at < 10_000) return send(res, 200, hit.body);
      const rails = { cross: { buy: false, sell: false }, submarine: { buy: false, sell: false },
                      pureln: { buy: false, sell: false }, subasset: { buy: false, sell: false } };
      const probe = async (relay, classify) => {
        try {
          const rr = await fetch(`${relay}/v1/market/${assetId}/BTC/orderbook`, { signal: AbortSignal.timeout(5000) });
          if (!rr.ok) return;
          for (const o of ((await rr.json()).offers || [])) {
            const rail = classify(o);
            if (!rail) continue;
            const dir = String(o.trade_dir || o.tradeDir || '');
            if (/SELL/.test(dir)) rails[rail].buy = true; else if (/BUY/.test(dir)) rails[rail].sell = true;
          }
        } catch { /* a down relay contributes no liquidity */ }
      };
      const lnRail = (o) => {
        const lt = o.lightning || o.Lightning;
        if (!lt) return null;
        const d = Number(lt.ln_direction ?? lt.lnDirection ?? 0);
        return d <= 1 ? 'submarine' : d <= 3 ? 'pureln' : 'subasset';
      };
      await Promise.all([
        probe(CFG.crossRelay, (o) => ((o.want_asset ?? o.wantAsset) === 'BTC' || (o.offer_asset ?? o.offerAsset) === 'BTC') ? 'cross' : null),
        probe(CFG.relay, lnRail),
        CFG.subasRelay && CFG.subasRelay !== CFG.relay ? probe(CFG.subasRelay, lnRail) : null,
        CFG.subasSellRelay && CFG.subasSellRelay !== CFG.relay ? probe(CFG.subasSellRelay, lnRail) : null,
      ].filter(Boolean));
      const body = { ok: true, asset: assetId, rails };
      _railsCache.set(assetId, { at: now, body });
      return send(res, 200, body);
    }
    if (req.method === 'GET' && url.pathname === '/book/unified') {
      const assetId = resolveAsset(url.searchParams.get('asset'));
      if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: '?asset=<sequentia asset id> is required (not BTC)' });
      const relays = [...new Set([CFG.crossRelay, CFG.subasRelay, CFG.subasSellRelay].filter(Boolean))];
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
      // Sort each side BEST-FIRST so a taker's offers[0] is the best price, not a relay-random one
      // (the relay serves offers in Go-map iteration order). A SELLER (dir-5 'sell' offers: user gives
      // the asset, receives BTC) wants the HIGHEST sats/atom; a BUYER (dir-4 'buy': user pays BTC) the
      // LOWEST. price_sats_per_atom is null only for a zero-amount offer (filtered above), so treat null
      // as worst.
      sell.sort((a, b) => (b.price_sats_per_atom ?? -Infinity) - (a.price_sats_per_atom ?? -Infinity));
      buy.sort((a, b) => (a.price_sats_per_atom ?? Infinity) - (b.price_sats_per_atom ?? Infinity));
      return send(res, 200, { ok: true, asset: assetId, asset_label: assetLabel(assetId),
        sell_available: sell.length > 0, buy_available: buy.length > 0, sell_offers: sell, buy_offers: buy });
    }

    // GET /lnbook?asset=<id> -> the PURE-LN order book from the SAME relay xpln lifts from (CFG.relay,
    // the pure-LN maker relay on the box). The wallet MUST price + pin the pure-LN rail off this, NOT
    // the on-chain cross book (a different market): quoting the cross book showed a price/amounts that
    // the settle never honoured (xpln lifts a pure-LN offer, whole-offer) and enabled Review on a dead
    // rail whenever cross had liquidity but pure-LN did not. Offer identity mirrors xpln.go exactly:
    // a pure-LN offer carries lightning.ln_direction 2 (LnAssetLNForBTCLN -> the taker can SELL the
    // asset) or 3 (LnBTCLNForAssetLN -> the taker can BUY); asset = base_amount; btc = want_amount,
    // or offer_amount when the offer's give-leg IS the BTC sentinel. Returned best-first so offers[0]
    // is exactly what a pinned xpln will take.
    if (req.method === 'GET' && url.pathname === '/lnbook') {
      const assetId = resolveAsset(url.searchParams.get('asset'));
      if (!assetId || assetId === CFG.btcx) return send(res, 400, { ok: false, error: '?asset=<sequentia asset id> is required (not BTC)' });
      // The QUOTE side: a real Sequentia asset id for an asset<->asset pure-LN market (e.g. EURX/OILX),
      // else the BTC sentinel (asset<->BTC). Offer identity is unchanged; the give-leg / "btc_sats" field
      // simply carries the quote asset's atoms. `btc_sats` keeps its name for wire compatibility.
      const quoteParam = url.searchParams.get('quote');
      const quoteId = quoteParam && String(quoteParam).toUpperCase() !== 'BTC' ? resolveAsset(quoteParam) : null;
      const quoteKey = quoteId || 'BTC';
      const seen = new Set(), sell = [], buy = [];
      let offers = [];
      try {
        const rr = await fetch(`${CFG.relay}/v1/market/${assetId}/${quoteKey}/orderbook`, { signal: AbortSignal.timeout(5000) });
        if (rr.ok) offers = (await rr.json()).offers || [];
      } catch { /* relay down -> empty book -> the wallet honestly reports the rail unavailable */ }
      for (const o of offers) {
        const lt = o.lightning || {}, dir = Number(lt.ln_direction);
        if (dir !== 2 && dir !== 3) continue;                     // not a pure-LN offer
        const key = (o.maker_pubkey || '') + ':' + (o.offer_id || '');
        if (seen.has(key)) continue; seen.add(key);
        const asset_amount = Number(o.base_amount || 0);
        let btc_sats = Number(o.want_amount || 0);
        if (o.offer_asset === quoteKey) btc_sats = Number(o.offer_amount || 0);
        const row = { offer_id: o.offer_id, maker_pubkey: o.maker_pubkey, ln_direction: dir,
          asset_amount, btc_sats, price_sats_per_atom: asset_amount ? btc_sats / asset_amount : null,
          expires_at: Number(o.expires_at_unix || 0) };
        if (dir === 3) buy.push(row); else sell.push(row);        // 3 => taker BUYs, 2 => taker SELLs
      }
      // Best-first for the taker: a BUYER wants the LOWEST sats/atom, a SELLER the HIGHEST.
      buy.sort((a, b) => (a.price_sats_per_atom ?? Infinity) - (b.price_sats_per_atom ?? Infinity));
      sell.sort((a, b) => (b.price_sats_per_atom ?? -Infinity) - (a.price_sats_per_atom ?? -Infinity));
      return send(res, 200, { ok: true, asset: assetId, asset_label: assetLabel(assetId),
        quote_asset: quoteKey, quote_asset_label: quoteId ? assetLabel(quoteId) : 'BTC',
        buy_available: buy.length > 0, sell_available: sell.length > 0, buy_offers: buy, sell_offers: sell });
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
      const amount = Number(body && body.amount);
      const rec = PROV.getByKey(nodeKey);
      if (!rec || !rec.rpc) return send(res, 404, { ok: false, error: 'unknown node key (POST /node/provision first)' });
      // The BRIDGED-SELL taker registers a HODL hold on H at its own BTC-LN node so the LSP's front (a
      // bare-hash sendpay on H) lands HELD there — that node is a BTC node, not an asset node, so an asset
      // id is neither present nor meaningful (the amount is BTC sats). Require an asset only for a Sequentia
      // asset node (the sub-asset HODL buy); a BTC node holds by hash with no asset. The holdinvoice call is
      // asset-agnostic either way (it takes only H + amount msat).
      const assetId = (rec.chain === 'btc') ? null : resolveAsset(body && body.asset);
      if (!nodeKey || !(amount > 0) || (rec.chain !== 'btc' && !assetId)) return send(res, 400, { ok: false, error: 'body { node_key, amount (sats), payment_hash? | preimage?, asset (Sequentia asset nodes only) } required' });
      const amtMsat = String(Math.round(amount) * 1000);           // asset sats -> asset msat
      const label = 'buy-' + crypto.randomUUID();
      const H = body && body.payment_hash ? String(body.payment_hash).toLowerCase() : null;
      const P = body && body.preimage ? String(body.preimage).toLowerCase() : null;
      try {
        let inv;
        if (H) {
          // HODL: register H to be HELD (holdinvoice-seq creates NO bolt11 — the maker pays the
          // hash directly via sendpay to this node id). The DEVICE holds P; settle via /node/settle.
          // W2 HOLD-LIFE vs T_seq — the BRIDGED-SELL taker passes `expiry` (seconds) so its hold on H stays
          // valid until strictly AFTER the maker's latest asset claim (T_seq) + margin; without a long-enough
          // expiry the maker could wait for a short hold to lapse, then reveal P and take the asset. Absent
          // (the sub-asset HODL buy) => the plugin default. holdinvoice: [H, amount_msat, label, desc, expiry?].
          const holdArgs = [H, amtMsat, label, 'asset buy (HODL)'];
          if (Number(body && body.expiry) > 0) holdArgs.push(String(Math.ceil(Number(body.expiry))));
          inv = await lnrpc('holdinvoice', holdArgs, rec.rpc, SIGNER_RPC_TIMEOUT_MS);
          const ni = await lnrpc('getinfo', [], rec.rpc, SIGNER_RPC_TIMEOUT_MS).catch(() => ({}));
          return send(res, 200, { ok: true, bolt11: null, payment_hash: H, hodl: true, node_id: ni.id || rec.node_id || null, amount_msat: Number(amtMsat) });
        } else {
          // NORMAL invoice. Use keyword args so the optional `preimage` can be set without
          // positional padding: lightning-cli -k invoice amount_msat=.. label=.. preimage=..
          const kv = [`amount_msat=${amtMsat}`, `label=${label}`, 'description=asset buy'];
          if (P) kv.push(`preimage=${P}`);
          inv = await lnrpcKw('invoice', kv, rec.rpc, SIGNER_RPC_TIMEOUT_MS);
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
        const l = await lnrpc('holdinvoicelookup', [H], rec.rpc, SIGNER_RPC_TIMEOUT_MS);
        // FUND-SAFETY (bridged-sell taker) — surface the ACTUAL committed incoming-HTLC CLTV (block height) and
        // this node's live Bitcoin tip so the taker can verify, before exposing any asset, that the front the LSP
        // ROUTED actually stays settleable until after T_seq — never trusting the min-final-CLTV it merely
        // REQUESTED (getroute may commit a shorter final CLTV). Best-effort: on a read hiccup we return null and
        // the taker fails closed (refuses to fund) rather than trusting an unverifiable runway. htlc_expiry is the
        // MIN expiry over the incoming HTLC(s) for H (the earliest-lapsing one governs settleability).
        let htlcExpiry = null, btcTip = null;
        try {
          const info = await lnrpc('getinfo', [], rec.rpc, SIGNER_RPC_TIMEOUT_MS);
          if (info && Number.isFinite(Number(info.blockheight))) btcTip = Number(info.blockheight);
          const lh = await lnrpc('listhtlcs', [], rec.rpc, SIGNER_RPC_TIMEOUT_MS);
          const mine = ((lh && lh.htlcs) || []).filter((x) => String(x.payment_hash || '').toLowerCase() === H
            && x.direction === 'in' && Number.isFinite(Number(x.expiry)));
          if (mine.length) htlcExpiry = Math.min(...mine.map((x) => Number(x.expiry)));
        } catch { /* leave htlc_expiry/btc_tip null -> the taker fails closed */ }
        return send(res, 200, { ok: true, state: l.state,
          held: l.state === 'accepted', settled: l.state === 'settled', htlc_expiry: htlcExpiry, btc_tip: btcTip });
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
        await lnrpc('holdinvoicesettle', [H, P], rec.rpc, SIGNER_RPC_TIMEOUT_MS);
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
        const inv = await lnrpcKw('invoice', [`amount_msat=${amtMsat}`, `label=${label}`, `description=${desc}`], rec.rpc, SIGNER_RPC_TIMEOUT_MS);
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
      const { _bridgeSession, ...pub } = job;   // never serialize the live WS session
      return send(res, 200, { ok: true, ...pub });
    }
    // BRIDGE PHASE 1b — FRONT-BEFORE-FUND hold-ready. The taker, having learned H from POST /swap's
    // bridge_terms, registers a hold on H at its OWN BTC-LN node, then calls this with its recv_node_id to
    // signal HOLD-READY. The LSP records the node id (the front's target) so the pure driver — already
    // running for this job — fronts the taker's hold as soon as the recoup is secured (maker BTC HTLC
    // confirmed + amount + runway + wall-clock locktime ordering), which is STRICTLY BEFORE the taker exposes
    // any asset. The taker then polls GET /swap/<id> for status 'fronted' and only THEN funds + relays its
    // asset (POST /bridge/asset). This ordering is the fund-safety fix: a declined/undriven front strands
    // nothing (the taker has funded nothing yet). Idempotent (a re-post just re-affirms the node id).
    if (req.method === 'POST' && url.pathname === '/bridge/front') {
      const body = await readBody(req);
      if (!body || !body.job_id) return send(res, 400, { ok: false, error: 'need { job_id, recv_node_id }' });
      const job = jobs.get(body.job_id);
      if (!job) return send(res, 404, { ok: false, error: 'unknown bridge job id' });
      if (job.rail !== 'bridged') return send(res, 400, { ok: false, error: 'not a bridged job' });
      if (!body.recv_node_id) return send(res, 400, { ok: false, error: 'recv_node_id (the taker BTC-LN node holding the hold on H) required' });
      // The maker handshake must have secured the recoup (BTC HTLC parse-verified locked to the LSP) before we
      // arm the front, else there is nothing to recoup against. verifiedClaimLsp is set + the locktime gate
      // passed only on a clean handshake; without it the driver can only stall, so refuse hold-ready plainly.
      const sb = job.legState && job.legState.btc;
      if (!(sb && sb.htlc && sb.verifiedClaimLsp && sb.hashH))
        return send(res, 409, { ok: false, error: `bridge job is not past a verified maker handshake yet (status '${job.status}') — poll GET /swap/${body.job_id} for bridge_terms first, then re-post hold-ready.` });
      // The driver must be LIVE to front (same authority the asset hand-off uses); a terminated/never-started
      // driver will never front, so recording hold-ready would leave the taker polling forever. Fail closed.
      if (job._driverLive !== true)
        return send(res, 409, { ok: false, error: `bridge job driver is not live to front (status '${job.status}', driverLive=${job._driverLive === true}) — cannot arm the front. Refusing.` });
      sb.recvNodeId = String(body.recv_node_id);   // the front's target; observe() flips recvReady:true -> the driver fronts
      // The taker may still report the front HTLC's min-final-CLTV it wants; record the MAX for diagnostics.
      // This NO LONGER sets the minted value: frontLn re-derives the mint target from the LIVE tips at pay time
      // (frontHtlcMintTarget) and pins the front HTLC's absolute expiry to T_btc - claimMargin, which both covers
      // the taker's required survival to T_seq AND stays recoupable by the LSP — the taker cannot request more
      // than the maker's T_btc can safely cover (a larger ask that would overshoot T_btc simply fails the mint
      // gate). The taker independently re-verifies the ACTUAL minted incoming-HTLC expiry (swap.js step-4.5).
      if (Number(body.recv_min_final_cltv) > 0)
        sb.frontMinFinalCltv = Math.max(Number(sb.frontMinFinalCltv) || 0, Math.ceil(Number(body.recv_min_final_cltv)));
      persistJobs();
      return send(res, 202, { ok: true, hold_ready: true, status: job.status,
        note: 'hold-ready recorded; the LSP will front your BTC-LN hold on H as soon as the recoup is secured. '
            + 'Poll GET /swap/' + body.job_id + ' until status is "fronted", then fund + relay your asset (POST /bridge/asset). Do NOT fund your asset before "fronted".' });
    }
    // BRIDGE PHASE 2 (rail-crossing SELL): AFTER the LSP has FRONTED (status 'fronted'), the taker funds its
    // OWN asset HTLC self-custody (claim=maker-with-P, refund=taker-after-T_seq) and hands the funded asset
    // outpoint here. The LSP records it (so the native asset leg reads LOCKED) and RELAYS it to the maker over
    // the kept-alive courier session (maker claims it, revealing P; the taker then settles its already-fronted
    // hold with P and receives BTC-LN; the LSP recoups the maker's BTC HTLC with P). The LSP never holds a
    // taker key. FUND-SAFETY: this REJECTS the hand-off unless the front is confirmed (bridgeFrontConfirmed),
    // so the taker never exposes its asset before it is guaranteed payment.
    if (req.method === 'POST' && url.pathname === '/bridge/asset') {
      const body = await readBody(req);
      if (!body || !body.job_id) return send(res, 400, { ok: false, error: 'need { job_id, taker_seq_leg }' });
      const job = jobs.get(body.job_id);
      if (!job) return send(res, 404, { ok: false, error: 'unknown bridge job id' });
      // W2(a): accept the asset hand-off ONLY while a bridged driver is AUTHORITATIVELY live to front it —
      // job._driverLive (set/cleared synchronously with runBridgedSwap) AND the courier session still open.
      // Gating on this instead of job.status closes the LAG hole: after the driver exhausts maxTicks it stops
      // (nothing will ever front), but job.status stays 'confirming' through ~1.5s of post-loop awaits and
      // flips terminal only in the caller .then. In that lag the OLD status check still admitted (status
      // 'confirming' + _bridgeSession non-null), so relaying the taker's asset would hand it to the maker
      // with no front ever = strand. _driverLive is false the instant the driver stops, so the hand-off now
      // fails closed. (A past-handoff job re-driven by resume-on-boot has a null session -> also refused; it
      // needs no second hand-off.) The predicate subsumes the session check, so both facts are surfaced.
      if (!bridgeAssetHandoffAdmissible(job))
        return send(res, 409, { ok: false, error: `bridge job is not live to accept the asset hand-off (status '${job.status}', driverLive=${job._driverLive === true}, session=${!!job._bridgeSession}) — its driver is not running to front the hold, so funding the asset now would strand it. Refusing.` });
      // W2 — FRONT-BEFORE-FUND. REJECT the asset hand-off unless the front is CONFIRMED. This is the load-
      // bearing reorder: the taker must not expose its asset (relaying it lets the maker claim + reveal P)
      // until the LSP has actually paid the taker's hold on H. If the taker skipped /bridge/front, or the
      // front has not yet committed (recoup not yet secured, e.g. the maker BTC HTLC is still 0-conf), refuse
      // here — the taker keeps its asset (it should not have funded yet) and simply retries once 'fronted'.
      if (!bridgeFrontConfirmed(job))
        return send(res, 409, { ok: false, error: `the LSP has NOT fronted your BTC-LN hold yet (status '${job.status}') — do NOT fund or relay your asset before the front is confirmed. Register your hold on H, POST /bridge/front with your recv_node_id, poll GET /swap/${body.job_id} until status is "fronted", then retry. Refusing to relay (fail closed; nothing of yours is exposed).` });
      const leg = body.taker_seq_leg || {};
      if (!leg.txid || !leg.redeem_script)
        return send(res, 400, { ok: false, error: 'taker_seq_leg{txid,vout,amount,redeem_script,locktime,asset[,block_hash]} required' });
      // W2(a) — RELAY-TIME LOCKTIME GATE. This is a second COMMITMENT point: relaying the taker's asset leg
      // EXPOSES it to the maker's claim (the maker then reveals P). The front is already secured by the front-
      // time gate, but the BTC tip may have DRIFTED further since; re-run the SAME wall-clock locktime-ordering
      // gate against LIVE tips BEFORE relaying — a maker whose short T_btc has drifted into the danger window
      // must be refused HERE too, so the LSP is never left unable to recoup. A refusal does NOT strand the
      // taker: its hold simply expires and the front returns (no-loss), and it refunds its asset at T_seq.
      {
        let btcTip = NaN, seqTip = NaN;
        const _sb = job.legState && job.legState.btc;
        if (_sb && _sb.htlc && _sb.htlc.txid) {
          try {
            const bo = await xhtlcObserve({ rpc: CFG.subasBtcRpc, wallet: CFG.subasBtcWallet, txid: _sb.htlc.txid, vout: _sb.htlc.vout });
            const so = await xhtlcObserve({ rpc: CFG.seqRpc, txid: '0'.repeat(64), vout: 0 });
            btcTip = Number(bo && bo.tip); seqTip = Number(so && so.tip);
          } catch { /* a tip momentarily unreadable -> NaN -> the gate fails closed below (never relay unverified) */ }
        }
        // RELAY-time re-check (the second commitment point, against live tips) — same one-BTC-time gate; a
        // drifted/short T_btc that can no longer cover the taker's required front-HTLC survival is refused here too.
        const relayGate = bridgeAssetRelayLocktimeVerdict({ job, btcTip, seqTip });
        if (!relayGate.ok) {
          console.error('[bridge] /bridge/asset relay REFUSED by live-tip locktime gate:', relayGate.reason);
          return send(res, 422, { ok: false, error: `refusing to relay the taker asset leg: the live-tip locktime-ordering gate is unsafe (a short/drifted maker T_btc would let it refund its BTC before the LSP can recoup with P). The asset was NOT exposed — refund it at your T_seq. Detail: ${relayGate.reason}` });
        }
      }
      job.legState = job.legState || {};
      const sa = job.legState.asset = job.legState.asset || {};
      sa.onchain = { txid: leg.txid, vout: Number(leg.vout || 0), redeem: leg.redeem_script };   // native lock (redeem lets observe read P from the maker's claim, W2b)
      const sb = job.legState.btc; if (sb && body.recv_node_id && !sb.recvNodeId) sb.recvNodeId = String(body.recv_node_id);   // defensive: the front's target is normally set at /bridge/front
      persistJobs();
      // Relay the taker's asset leg -> the maker claims it (reveals P). Fire-and-forget: the maker's claim is
      // anchor-gated (can take minutes) and the driver reads P from the front's pay result / the on-chain claim.
      // FUND-SAFETY (W2 FRONT-BEFORE-FUND): this relay — and hence the taker exposing its asset — happens ONLY
      // AFTER the front is confirmed (the bridgeFrontConfirmed gate above). So a maker that claims the instant
      // it gets the relay finds the taker ALREADY guaranteed payment (the LSP's hold pay on H is live); the
      // taker settles with the revealed P and receives its BTC-LN, and the LSP recoups the maker's BTC HTLC.
      // A PERMANENT LSP death after the relay is covered by resume-on-boot (it re-attaches the in-flight front
      // and recoups). The old front-AFTER-relay hole — relay exposes the asset while no front is yet in flight
      // — is closed: the relay can no longer run before the front.
      const session = job._bridgeSession; job._bridgeSession = null;   // one relay per session
      relayTakerAssetLeg({ session, takerSeqLeg: leg })
        .then((r) => { job.relay_preimage = r && r.preimageHex ? r.preimageHex : null; persistJobs(); })
        .catch((e) => { console.error('[bridge] relay asset leg:', e && e.message); })
        .finally(() => { try { session.close(); } catch {} });
      return send(res, 202, { ok: true, relayed: true, note: 'asset leg relayed to the maker; poll GET /swap/' + body.job_id + ' for settlement' });
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
      // W3(c): a ln/ln take is the UNCHANGED pure-LN route ONLY when it is NOT a bridged take. This branch
      // runs BEFORE the bridge branch below, so without the bridge:true exemption (mirror of the chain/chain
      // branch) a genuine bridged take whose BOTH taker rails are on Lightning — legitimate when the resting
      // MAKER's rails differ — was swallowed by pure-LN runSwap, settling an UNRELATED swap over the shared
      // node and falsely reporting 'settled'. isPureLnTake carries that exemption so it falls through.
      if (isPureLnTake({ payRail, recvRail, bridge: body.bridge })) {
        const r = await runSwap(body);                          // UNCHANGED pure-LN
        return send(res, r.ok ? 200 : 502, r);
      }
      if (payRail === 'chain' && recvRail === 'chain' && body.bridge !== true) {
        // On-chain <-> on-chain is the SeqOB order-book HTLC path the wallet runs
        // itself; the LSP does not settle it. (A bridged take can legitimately have both
        // TAKER rails on-chain while the MAKER's differ, so it is exempt — handled below.)
        return send(res, 200, { ok: false, handled_by: 'wallet_onchain', finality: 'anchor-bound',
          error: 'on-chain <-> on-chain is settled by the wallet\'s own on-chain rail (the SeqOB order book), not the LSP' });
      }
      // RAIL-BLIND BRIDGED TAKE: a genuine rail crossing (the taker took an offer whose rails DIFFER
      // from the taker's). The deployed xsub* binaries cannot execute it (planExecutionName == null);
      // the LSP bridges the mismatched leg(s) via the pure driver (bridge-driver.runBridgedSwap), which
      // obeys leg-bridge.nextBridgeStep per crossed leg + gates the shared preimage for atomicity. Always
      // an async job (anchor-gated), with swap_nonce idempotency + persist-before-broadcast (mirrors the
      // mixed path), so a lost 202 + retry never funds twice and a restart resumes, never strands funds.
      if (body.bridge === true) {
        reapJobs();
        const bnonce = (typeof body.swap_nonce === 'string' && body.swap_nonce.trim()) ? body.swap_nonce.trim() : '';
        if (bnonce) {
          const hit = bridgeResult.get(bnonce);
          if (hit) { const { ts, ...r } = hit; return send(res, r.ok ? 200 : 502, { ...r, idempotent_replay: true }); }
          for (const [jid, j] of jobs) {
            if (j.swap_nonce === bnonce && j.rail === 'bridged') {
              return send(res, 202, { ...j, job_id: jid, poll: '/swap/' + jid, idempotent_replay: true });
            }
          }
        }
        // Validate the match UP FRONT so a malformed cross (or a coincidence) fails closed with a clear
        // message instead of spawning a job that can only stall.
        let planPreview;
        try { planPreview = planSettlement(buildBridgeMatchFromBody(body)); }
        catch (e) { return send(res, 422, { ok: false, error: `bridged take: ${scrubDetail(String((e && e.message) || e))}` }); }
        if (planPreview.happyCoincidence) {
          return send(res, 422, { ok: false, handled_by: 'native',
            error: 'this match is a happy coincidence (rails coincide) — settle it natively, not via the bridge' });
        }
        const jobId = crypto.randomUUID();
        const job = { job_id: jobId, status: 'confirming', side: body.side, asset: body.asset,
          rail: 'bridged', finality: 'confirming', settlement_plan: bridgeplanSummary(planPreview),
          ...(bnonce ? { swap_nonce: bnonce } : {}), requested_amount: body.amount ?? null, started_ms: Date.now() };
        setJob(jobId, job);   // persist BEFORE any funding (a restart sees 'interrupted', not a 404)
        const run = runBridgedSwapJob(body, job)
          // W2(b): interrupted (pre-front maxTicks exhaustion) -> 'interrupted' (resumable), NOT 'failed'.
          // Do NOT cache an interrupted result under the nonce: a retry must be able to re-drive it.
          .then((r) => { setJob(jobId, { ...jobs.get(jobId), ...r, status: r.ok ? 'settled' : (r.interrupted ? 'interrupted' : 'failed'), done_ms: Date.now() }); if (bnonce && !r.interrupted) bridgeResult.set(bnonce, { ...r, ts: Date.now() }); return r; })
          .catch((e) => { const r = { ok: false, error: String((e && e.message) || e) }; setJob(jobId, { ...jobs.get(jobId), ...r, status: 'failed', done_ms: Date.now() }); return r; })
          .finally(() => { if (bnonce) bridgeInflight.delete(bnonce); });
        if (bnonce) bridgeInflight.set(bnonce, run);
        return send(res, 202, { ...job, ok: true, poll: `/swap/${jobId}`,
          bridged: true, bridge_legs: job.settlement_plan.bridge_legs, jit_legs: job.settlement_plan.jit_legs,
          note: 'rail-blind bridged take: the LSP bridges the mismatched leg(s) on one shared preimage. '
              + 'Poll GET /swap/<job_id> for completion; each crossed leg is anchor-gated + refund-safe.' });
      }
      // W3(b) — REFUSE-CROSSED. A take that carries the maker's per-leg rails AND genuinely CROSSES rails
      // (a bridge is required) MUST set bridge:true so it enters the non-custodial bridged driver above. If
      // it reaches here without bridge:true, do NOT let it fall through to the CUSTODIAL submarine dispatch:
      // with a resting submarine maker that path would execute an UNRELATED swap out of the LSP's OWN funds
      // and report 'settled' — a false success while the client's actual bridged take never happened. Fail
      // closed with 422. (takeRailsCrossed returns false for non-cross / undeterminable shapes, so a plain
      // legitimate submarine — asset-LN <-> BTC-on-chain, no maker rails — is unaffected.)
      if (body.maker_btc_rail && body.maker_asset_rail
        && takeRailsCrossed({ side: body.side, payRail, recvRail,
             makerBtcRail: body.maker_btc_rail, makerAssetRail: body.maker_asset_rail,
             takerAssetInbound: !!body.taker_asset_inbound, takerBtcInbound: !!body.taker_btc_inbound })) {
        return send(res, 422, { ok: false, finality: 'unsupported',
          error: 'this take crosses rails (a bridge is required) but bridge:true was not set — refusing to route it through the custodial submarine path (which would move the LSP\'s own funds on an unrelated swap and misreport success). Retry the take with bridge:true.' });
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
      // P3.3 — RETIRE THE CUSTODIAL SUBMARINE for any shape now covered non-custodially. xsublift (asset
      // on-chain in, BTC-LN out) and xsubbuy (BTC-LN in, asset on-chain out) are LP-FRONTED out of the LSP's
      // OWN funds (-ln-socket = the LSP's node; -btc-wallet/-seq-wallet = the LSP's wallets) — custodial, and
      // a fund-safety liability. The sell shape (asset on-chain -> BTC-LN) is EXACTLY the W2 non-custodial
      // bridge's wired shape, so route it there (bridge:true). The mirror buy (BTC-LN -> asset on-chain) has
      // NO non-custodial route today, so gate it honestly rather than move LSP funds. Fail closed BEFORE the
      // custodial runMixed is ever reached. (xsubas / xsubas-sell — the genuinely non-custodial sub-asset
      // paths — are unaffected.)
      if (execName === 'xsublift') {
        return send(res, 422, { ok: false, finality: 'unsupported',
          error: 'sell-asset-on-chain / receive-BTC-over-Lightning is now settled by the NON-custodial rail-crossing bridge, not the custodial submarine (which fronts the LSP\'s own funds). Retry the take with bridge:true (plus maker_btc_rail/maker_asset_rail + offer_id/maker_pubkey + taker_seq_refund_pub).' });
      }
      if (execName === 'xsubbuy') {
        return send(res, 422, { ok: false, finality: 'unsupported',
          error: 'pay-BTC-over-Lightning / receive-asset-on-chain has no non-custodial route on this LSP and the custodial submarine (which fronts the LSP\'s own funds) is retired. To buy the asset non-custodially, pay BTC ON-CHAIN and receive the asset over Lightning (the HODL buy: side:buy, hodl:true), or take a supported shape.' });
      }
      const backendReady = execName === 'xsubas' ? subasReady
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
        // Idempotency + double-pay guard, keyed by the client-supplied swap_nonce. The asset is paid
        // INSIDE runMixed; if the wallet loses this response it re-calls with the SAME nonce, and we
        // MUST return the already-settled result rather than pay a second time. A missing/blank nonce
        // is an old client: no idempotency, runs fresh exactly as before (back-compat).
        const nonce = (typeof body.swap_nonce === 'string' && body.swap_nonce.trim()) ? body.swap_nonce.trim() : '';
        if (nonce) {
          const hit = getSubasSellResult(nonce);          // EXACT-match only; never another swap's result
          if (hit) { const { ts, ...payload } = hit; return send(res, 200, { ...payload, idempotent_replay: true }); }
        }
        let r;
        const inflight = nonce ? subasSellInflight.get(nonce) : null;
        if (inflight) {
          r = await inflight;                              // a retry raced the original run -> await it, never launch a second
        } else {
          // FUND-SAFETY (double-pay race): RESERVE the single-flight slot SYNCHRONOUSLY, before any
          // await. The old code set the slot only AFTER preSpawnGuardSubasSell (which awaits a node
          // RPC — a real macrotask window), so a same-nonce retry arriving during that await found no
          // in-flight entry, ran the guard too, both saw "no pay yet" and BOTH spawned xsubas-sell —
          // paying the asset TWICE for one BTC HTLC. Now a late arrival awaits THIS run instead.
          let settle;
          const slot = nonce ? new Promise((res2) => { settle = res2; }) : null;
          if (nonce) subasSellInflight.set(nonce, slot);
          try {
            // PRE-SPAWN RECOVERY GUARD: a same-nonce retry must NEVER re-pay an asset a prior attempt
            // may already have paid. Recover a settled result, HOLD if a pay is in-flight/unprovable,
            // and only run fresh when the node PROVES no pay for H ever left (or there's no nonce).
            if (nonce) {
              const guard = await preSpawnGuardSubasSell(body);
              if (guard.action === 'recover') { putSubasSellResult(nonce, guard.result); r = guard.result; }
              else if (guard.action === 'hold') { r = guard.result; }
              // guard.action === 'rerun' -> a fresh run is safe; runMixed pre-cleans the stale file.
            }
            if (r === undefined) {
              r = await runMixed({ ...body, payRail, recvRail });
              if (nonce && r && r.ok && r.settled) putSubasSellResult(nonce, r);   // store BEFORE the finally delete
            }
          } catch (e) {
            r = { ok: false, error: 'sub-asset sell failed: ' + scrubDetail(String((e && e.message) || e)) };
          } finally {
            if (nonce) { settle(r); subasSellInflight.delete(nonce); }   // resolve late awaiters, then free the slot
          }
        }
        return send(res, r.ok ? 200 : 502, r);
      }
      reapJobs();
      const mixNonce = (typeof body.swap_nonce === 'string' && body.swap_nonce.trim()) ? body.swap_nonce.trim() : '';
      // Under the 0-conf cap -> the submarine skips the anchor-bury wait, so the swap
      // is fast: answer SYNCHRONOUSLY with the preimage. Over the cap (or unknown
      // amount) -> the anchor gate takes many Bitcoin blocks, so run it in the
      // background and hand back a pollable job instead of holding the connection.
      const amt = Number(body.amount || 0);
      const under0conf = CFG.mixedMax0conf > 0 && amt > 0 && amt <= CFG.mixedMax0conf;
      if (under0conf) {
        // Idempotency (fund-safety): a same-nonce retry (a lost 200 then a re-POST) must NOT fund a
        // second submarine HTLC. Replay a completed run, or join an in-flight one, keyed by the nonce.
        if (mixNonce) {
          const hit = mixedResult.get(mixNonce);
          if (hit) { const { ts, ...r } = hit; return send(res, r.ok ? 200 : 502, { ...r, idempotent_replay: true }); }
          const inf = mixedInflight.get(mixNonce);
          if (inf) { const r = await inf; return send(res, r && r.ok ? 200 : 502, r); }
        }
        let settle;
        const slot = mixNonce ? new Promise((res2) => { settle = res2; }) : null;
        if (mixNonce) mixedInflight.set(mixNonce, slot);
        let r;
        try {
          r = await runMixed({ ...body, payRail, recvRail });
          if (r.ok) { r.zero_conf = true; r.finality = 'confirming'; }
          if (mixNonce) mixedResult.set(mixNonce, { ...r, ts: Date.now() });
        } catch (e) {
          r = { ok: false, error: 'mixed swap failed: ' + scrubDetail(String((e && e.message) || e)) };
        } finally {
          if (mixNonce) { settle(r); mixedInflight.delete(mixNonce); }
        }
        return send(res, r.ok ? 200 : 502, r);
      }
      // Idempotency (fund-safety): a same-nonce re-POST — a lost 202 then a retry, or a restart-then-
      // retry — must return the EXISTING job, never fund a SECOND on-chain HTLC from the hosted wallet.
      // The nonce is persisted IN the job record, so the scan also matches an 'interrupted' job after a
      // restart. (A missing nonce is an old client: no dedupe, exactly as before.)
      if (mixNonce) {
        for (const [jid, j] of jobs) {
          if (j.swap_nonce === mixNonce) {
            return send(res, 202, { ...j, job_id: jid, poll: '/swap/' + jid, idempotent_replay: true });
          }
        }
      }
      const jobId = crypto.randomUUID();
      const job = { job_id: jobId, status: 'confirming', side, asset: body.asset,
        rail: 'mixed', pay_rail: payRail, recv_rail: recvRail, finality: 'confirming',
        ...(mixNonce ? { swap_nonce: mixNonce } : {}),   // idempotency key, persisted with the job
        requested_amount: body.amount ?? null, started_ms: Date.now() };
      setJob(jobId, job);   // persist on creation (a restart sees 'interrupted', not a 404)
      runMixed({ ...body, payRail, recvRail })
        .then((r) => setJob(jobId, { ...job, ...r, status: r.ok ? 'settled' : 'failed', done_ms: Date.now() }))
        .catch((e) => setJob(jobId, { ...job, status: 'failed', error: String((e && e.message) || e), done_ms: Date.now() }));
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
  // RESUME in-flight BRIDGE jobs (persist-before-broadcast + resumable). A bridged swap whose driver died
  // with the old process is recovered by re-running ONLY the pure driver against its persisted legState —
  // NOT the maker handshake (the maker already locked its BTC HTLC; re-handshaking would lock another).
  // W2 FRONT-BEFORE-FUND — resume any NON-TERMINAL job whose recoup is wired AND the LSP has already put
  // value / exposure in flight: either it FRONTED (s.btc.frontHeld — the in-flight hold pay must be
  // re-attached so the LSP learns P off the settle and recoups) or the asset was RELAYED (s.asset.onchain —
  // the maker will claim + reveal P). Both are fund-safety-critical: without re-driving, a fronted/relayed
  // job that died could never recoup. A job that only handshook (no front, no relay) has nothing at stake
  // and its relay needs the now-gone courier session, so it is left to fail no-loss. (Gating on frontHeld OR
  // sa.onchain — not merely `interrupted` — also covers a HARD kill that never marked the job 'interrupted'.)
  // Fund-safety is unchanged: the driver obeys nextBridgeStep exactly. Best-effort + guarded; never fail boot.
  for (const [id, job] of jobs) {
    try {
      if (job.rail !== 'bridged') continue;
      if (job.status === 'settled' || job.status === 'failed') continue;   // terminal — nothing to resume
      const s = job.legState || {};
      if (!(s.btc && s.btc.htlc && s.btc.verifiedClaimLsp && s.btc.recvNodeId && (s.btc.frontHeld || (s.asset && s.asset.onchain)))) continue;   // fronted or relayed only
      const bt = job.bridge_terms || {};
      const rbody = { side: job.side, asset: job.asset, payRail: 'chain', recvRail: 'ln',
        maker_btc_rail: 'chain', maker_asset_rail: 'chain', taker_btc_inbound: true,
        btc_sats: bt.btc_amount, asset_atoms: bt.seq_amount };
      const match = buildBridgeMatchFromBody(rbody);
      const io = makeBridgeIo({ match, body: rbody, job });
      job.status = 'confirming'; job.interrupted = false; job.error = null; persistJobs();
      console.error('[lsp] resuming bridged job', id, '(re-driving front+recoup on the persisted maker HTLC)');
      runBridgedSwap({ match, io, driverCfg: { pollMs: 3000, maxTicks: Math.ceil(CFG.mixedTimeoutMs / 3000) } })
        // A resumed run that again exhausts pre-front stays 'interrupted' (resumable on the next boot),
        // not 'failed' — the taker's committed asset must never be stranded by a marking.
        .then((r) => { setJob(id, { ...jobs.get(id), ...(r.ok ? { ok: true, settled: true, status: 'settled', interrupted: false } : (r.interrupted ? { ok: false, status: 'interrupted', interrupted: true, error: `resumed bridged swap not yet settled (pre-front): ${r.reason || 'unknown'}` } : { ok: false, status: 'failed', error: `resumed bridged swap did not settle: ${r.reason || 'unknown'}` })), legs: r.legs, done_ms: Date.now() }); })
        .catch((e) => { setJob(id, { ...jobs.get(id), ok: false, status: 'failed', error: String((e && e.message) || e), done_ms: Date.now() }); });
    } catch (e) { console.error('[lsp] bridge resume skipped for', id, e && e.message); }
  }
  // T10 restart-invisibility: the per-user lightningd nodes are spawned DETACHED, so they SURVIVE an
  // LSP restart — only our in-process view of them is lost. Proactively re-attach on boot (getinfo is a
  // read, no signer needed) so /status + /node/list report them `running` immediately, and a wallet
  // reconnecting after the restart hits the cheap re-attach path (rec exists + running) instead of a
  // re-boot. Best-effort + non-blocking: a node still booting/awaiting-signer just stays as-is and is
  // picked up by the next refresh. Never fail the boot on it.
  if (PROV) {
    (async () => {
      let up = 0, seen = 0;
      for (const rec of PROV.list()) {
        seen++;
        try { const r = await PROV.refresh(rec.key); if (r && r.status === 'running') up++; } catch { /* down/booting; leave it */ }
      }
      if (seen) console.error(`[lsp] boot re-attach: ${up}/${seen} hosted node(s) already running (survived the restart)`);
    })().catch(() => {});
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
