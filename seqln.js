// ---------------------------------------------------------------------------
// seqln.js — the wallet's Lightning module (the LSP / hosted-SeqLN thin client).
//
// The non-custodial instant-LN cross-chain DEX from a thin wallet. Under the LSP
// model (UX-audit §8.2 Tier 2): WE host the SeqLN nodes; the wallet is a thin
// client that (a) holds the keys and CO-SIGNS the hosted nodes' commitment
// updates via the on-device wasm signer SDK over wss Noise links, and (b)
// COMMANDS a cross-chain swap through a thin LSP HTTP API.
//
// The cross-chain pure-LN rail is TWO hosted nodes co-signed by ONE wallet:
//   * an ASSET node (holds the GOLD channel on Sequentia), and
//   * a BTC node    (holds the BTC channel on testnet4).
// The two legs settle atomically on one preimage. Both hosted nodes are KEYLESS
// (no hsm_secret): the browser device is the sole signer for BOTH, so the LSP can
// command routing but can never move the user's channel funds. The wallet's job
// on the swap path is simply to keep BOTH device signers serving so the two
// hosted nodes can co-sign their legs; the LSP (`POST /swap`) drives both legs.
//
// Two independent concerns, kept separate:
//   1. connectDevice()  — bring ONE on-device signer online (needs the wasm SDK,
//      a wss endpoint, and the wallet-derived per-node device identity). Called
//      once per hosted node (asset + btc). Browser-gated.
//   2. seqlnGetStatus() / seqlnSwap()  — the LSP HTTP client (plain fetch, so it
//      is fully testable in Node and mirrors the SEQ_SEQOB_URL global pattern).
//
// This module holds NO app/DOM references; index.html derives the per-node keys
// (seqln-keys.js), wires status into the UI, and swap.js reaches it through the
// `ln` bridge (beside xswap/xrswap/xmaker).
// ---------------------------------------------------------------------------

const W = (typeof window !== 'undefined') ? window : {};

const DEFAULTS = {
  lspUrl: W.SEQ_LSP_URL
    || (typeof location !== 'undefined' ? location.origin + '/lsp' : 'http://127.0.0.1:9981'),
  token: W.SEQ_LSP_TOKEN || '',
  // Per-node wss front of each hosted node's Noise_XK responder (WS<->TCP relay).
  // Absent for a node => the on-device signer for that node cannot come online.
  // The legacy single-node vars (SEQ_LSP_WS / SEQ_LSP_HOST_PUBKEY) are honoured as
  // a fallback for the ASSET slot so an existing one-node deployment keeps working.
  nodes: {
    asset: {
      wsUrl: W.SEQ_LSP_WS_ASSET || W.SEQ_LSP_WS || '',
      hostPubkey: W.SEQ_LSP_HOST_PUBKEY_ASSET || W.SEQ_LSP_HOST_PUBKEY || '',
    },
    btc: {
      wsUrl: W.SEQ_LSP_WS_BTC || '',
      hostPubkey: W.SEQ_LSP_HOST_PUBKEY_BTC || '',
    },
  },
  // The wasm signer SDK (vendored under /lightning). Dynamic-imported so a wallet
  // with LN unconfigured never loads the 1.5MB wasm.
  sdkPath: W.SEQ_LSP_SDK || './lightning/seqln-signer-sdk.js',
};

const NODES = ['asset', 'btc'];

let CFG = cloneCfg(DEFAULTS);
let onChange = null;

// Per-node signer + connection state. `enabled` = this node has a wss endpoint +
// host key configured, so it is REQUIRED for the cross-chain rail to be available.
function freshNode() {
  return { signer: null, connected: false, nodeId: null, phase: 'idle', detail: '', enabled: false };
}
const nodeState = { asset: freshNode(), btc: freshNode() };

function cloneCfg(src) {
  return {
    lspUrl: src.lspUrl, token: src.token, sdkPath: src.sdkPath,
    nodes: {
      asset: { ...src.nodes.asset },
      btc: { ...src.nodes.btc },
    },
  };
}

function markEnabled() {
  for (const n of NODES) {
    nodeState[n].enabled = !!(CFG.nodes[n].wsUrl && CFG.nodes[n].hostPubkey);
  }
}

function setPhase(node, phase, detail) {
  const s = nodeState[node];
  s.phase = phase; s.detail = detail || '';
  if (onChange) { try { onChange(seqlnState()); } catch {} }
}

// initSeqln reads the window globals into CFG (SEQ_LSP_URL / _TOKEN and the
// per-node _WS_ASSET/_HOST_PUBKEY_ASSET + _WS_BTC/_HOST_PUBKEY_BTC, with the
// legacy single-node vars as the asset-slot fallback). `opts` overrides any of
// these (used by the Node tests, which pass an explicit lspUrl/sdkPath/nodes).
export function initSeqln(opts = {}) {
  CFG = cloneCfg(DEFAULTS);
  if (opts.lspUrl != null) CFG.lspUrl = opts.lspUrl;
  if (opts.token != null) CFG.token = opts.token;
  if (opts.sdkPath != null) CFG.sdkPath = opts.sdkPath;
  if (opts.nodes) {
    for (const n of NODES) {
      if (opts.nodes[n]) CFG.nodes[n] = { ...CFG.nodes[n], ...opts.nodes[n] };
    }
  }
  markEnabled();
  return CFG;
}

export function seqlnConfigured() { return !!CFG.lspUrl; }

// True when ANY hosted node is configured (so the UI should surface the LN pill).
export function seqlnDeployed() {
  return NODES.some((n) => nodeState[n].enabled);
}

// Snapshot for the UI. `connected` (and the top-level phase) reflect the WHOLE
// rail: a cross-chain swap needs BOTH legs, so `connected` is true only when
// every ENABLED node's device signer is serving. `nodes` exposes each leg.
export function seqlnState() {
  const enabled = NODES.filter((n) => nodeState[n].enabled);
  const connectedCount = enabled.filter((n) => nodeState[n].connected).length;
  const allConnected = enabled.length > 0 && connectedCount === enabled.length;
  const anyError = enabled.some((n) => nodeState[n].phase === 'error');
  const nodes = {};
  for (const n of NODES) {
    const s = nodeState[n];
    nodes[n] = { enabled: s.enabled, connected: s.connected, nodeId: s.nodeId, phase: s.phase, detail: s.detail };
  }
  return {
    configured: seqlnConfigured(),
    deployed: enabled.length > 0,
    connected: allConnected,
    connectedCount, enabledCount: enabled.length,
    phase: allConnected ? 'ready' : (anyError ? 'error' : (enabled.length ? 'connecting' : 'idle')),
    nodes,
  };
}

export function onSeqlnStatus(fn) { onChange = fn; }

// The LN swap route is offerable only when the LSP is reachable AND every enabled
// hosted node's on-device signer is serving (so BOTH hosted legs can co-sign the
// atomic swap). Deliberately conservative: a missing leg => no LN route, and the
// composer falls back to the on-chain cross rail.
export function seqlnAvailable() {
  return seqlnConfigured() && seqlnState().connected;
}

// Pure-LN happy path: genuinely instant + final (nothing on-chain, zero reorg
// risk). This is the ONE swap state the DEX 0-conf policy lets us call "final".
export function lnFinalityCopy() {
  return 'Instant and final · pure Lightning, nothing on-chain, no Bitcoin-reorg risk.';
}

// -- 1. on-device signers (browser-gated: WebSocket + wasm + the SDK) ----------
// Connect ONE hosted node's device signer. Called once per node (asset + btc).
//   node                   'asset' | 'btc' (which hosted node this signer serves)
//   deviceSigningSeed      the per-node SeqLN signing seed (seqln-keys.js) fed to
//                          SeqlnSigner.fromMnemonic — determines the keyless
//                          hosted node's LN identity (node_id + channel keys).
//   deviceTransportPrivkey the per-node Noise static privkey (its pubkey is what
//                          the LSP pins for this node).
//   wsUrl / hostStaticPubkey  the node's wss relay + pinned host static pubkey
//                          (default: CFG.nodes[node], read from the window vars).
export async function connectDevice({
  node, deviceSigningSeed, deviceTransportPrivkey,
  wsUrl, hostStaticPubkey, policy = 'permissive',
} = {}) {
  if (!node || !NODES.includes(node)) { throw new Error("connectDevice: node must be 'asset' or 'btc'"); }
  const cfgNode = CFG.nodes[node] || {};
  const ws = wsUrl || cfgNode.wsUrl;
  const hostPub = hostStaticPubkey || cfgNode.hostPubkey;
  const s = nodeState[node];

  if (!ws || !hostPub) { setPhase(node, 'unconfigured', 'no wss endpoint / host key'); return null; }
  if (!deviceSigningSeed || !deviceTransportPrivkey) { setPhase(node, 'unconfigured', 'no device identity'); return null; }
  if (s.signer) return s.nodeId;   // already connected/connecting for this node

  setPhase(node, 'connecting', 'loading signer');
  const mod = await import(CFG.sdkPath);
  const SeqlnSigner = mod.SeqlnSigner || mod.default;
  const signer = await SeqlnSigner.fromMnemonic(deviceSigningSeed);
  signer.setPolicy(policy);
  s.signer = signer;
  signer.onStatus = (st) => {
    if (st.state === 'node_id') { s.nodeId = st.nodeId; setPhase(node, 'node_id', st.nodeId.slice(0, 14) + '…'); }
    else setPhase(node, st.state, st.detail);
    if (st.state === 'closed' || st.state === 'error') { s.connected = false; }
  };
  try {
    await signer.connect({ wsUrl: ws, hostStaticPubkey: hostPub, deviceStaticPrivkey: deviceTransportPrivkey });
    const id = await signer.whenNodeId(30000);
    s.nodeId = id; s.connected = true; setPhase(node, 'ready', 'signer serving');
    return id;
  } catch (e) {
    s.signer = null; s.connected = false; setPhase(node, 'error', e.message || String(e));
    return null;
  }
}

export function disconnectDevice(node) {
  const targets = node ? [node] : NODES;
  for (const n of targets) {
    const s = nodeState[n];
    try { s.signer?.disconnect(); } catch {}
    s.signer = null; s.connected = false; setPhase(n, 'idle', '');
  }
}

// -- provisioned per-asset nodes (dynamic N/M, beyond the fixed asset+btc rail) -----
// SeqLN is single-asset, so moving a NEW asset into Lightning provisions its own hosted
// node; the device attaches a signer to it exactly like the fixed nodes, but there can
// be arbitrarily many, so they live in a dynamic map (keyed by asset id) rather than the
// fixed asset/btc slots.
const provNodes = {};   // assetId -> { signer, connected, nodeId, phase, detail }

// Device transport pubkey (33-byte compressed hex) for a privkey — what the hosted node
// PINS (SEQLN_SIGNER_PEER_PUBKEY). Derived via the wasm SDK (same curve the node uses).
export async function deviceTransportPubkey(transportPrivkey) {
  const mod = await import(CFG.sdkPath);
  const S = mod.SeqlnSigner || mod.default;
  return S.devicePubkey(transportPrivkey);
}

// The wss URL a browser uses to reach a provisioned node's Noise responder (through the
// TLS front's per-node path). Deploy prerequisite: a Caddy wildcard mapping public_ws_path
// -> the node's private ws port. Overridable via SEQ_LSP_WS_BASE for local/test wiring.
function provWsUrl(publicWsPath) {
  const base = W.SEQ_LSP_WS_BASE
    || (typeof location !== 'undefined' ? location.origin.replace(/^http/, 'ws') : 'ws://127.0.0.1');
  return base.replace(/\/$/, '') + publicWsPath;
}

// Connect the on-device signer to a PROVISIONED node's responder (arbitrary asset).
export async function connectProvisioned({ assetId, key, deviceSigningSeed, deviceTransportPrivkey,
  wsUrl, hostStaticPubkey, policy = 'permissive' } = {}) {
  // The provNodes map key: an explicit LSP registry key (e.g. `btc:<devicepub>` for a
  // per-user BTC node), else a 32-byte-hex asset id (a Sequentia asset node is keyed by
  // its asset id). One of the two is required so the signer state is addressable.
  const mapKey = key ? String(key).toLowerCase()
    : (/^[0-9a-fA-F]{64}$/.test(String(assetId || '')) ? String(assetId).toLowerCase() : null);
  if (!mapKey) throw new Error('connectProvisioned: a node key or a 32-byte-hex assetId is required');
  const s = provNodes[mapKey] || (provNodes[mapKey] = { signer: null, connected: false, nodeId: null, phase: 'idle', detail: '' });
  if (!wsUrl || !hostStaticPubkey) { s.phase = 'unconfigured'; s.detail = 'no wss endpoint / host key'; return null; }
  if (!deviceSigningSeed || !deviceTransportPrivkey) { s.phase = 'unconfigured'; s.detail = 'no device identity'; return null; }
  if (s.signer) return s.nodeId;
  s.phase = 'connecting';
  const mod = await import(CFG.sdkPath);
  const SeqlnSigner = mod.SeqlnSigner || mod.default;
  const signer = await SeqlnSigner.fromMnemonic(deviceSigningSeed);
  signer.setPolicy(policy);
  s.signer = signer;
  signer.onStatus = (st) => {
    if (st.state === 'node_id') { s.nodeId = st.nodeId; s.phase = 'node_id'; }
    else s.phase = st.state;
    if (st.state === 'closed' || st.state === 'error') s.connected = false;
    if (onChange) { try { onChange(seqlnState()); } catch {} }
  };
  try {
    await signer.connect({ wsUrl, hostStaticPubkey, deviceStaticPrivkey: deviceTransportPrivkey });
    const id = await signer.whenNodeId(30000);
    s.nodeId = id; s.connected = true; s.phase = 'ready';
    if (onChange) { try { onChange(seqlnState()); } catch {} }
    return id;
  } catch (e) {
    s.signer = null; s.connected = false; s.phase = 'error'; s.detail = e.message || String(e);
    return null;
  }
}

// One call the Balance tab uses to move an asset into Lightning end to end (client side):
// derive this asset's device identity, provision its hosted node keyed to that device,
// and bring the signer online. Returns { node, nodeId } (the wallet then funds a channel).
//   deriveIdentity(assetId) -> { transportPrivkey, signingSeed }  (seqln-keys.lnDeriveAsset)
// `chain` selects the hosted node kind: 'seq' (a Sequentia asset node, keyed by `assetId`)
// or 'btc' (a per-user testnet4 node, device-keyed — no assetId). `deriveIdentity` returns
// { transportPrivkey, signingSeed }: for seq it takes the assetId (lnDeriveAsset); for btc
// it ignores the arg (the btc device identity, lnDeriveNode(phrase,'btc')). Returns
// { node, nodeId, connected, key } — `key` is the LSP registry key the wallet then hands to
// fundChannel so the deposit + device-co-signed funding target THIS node, not a demo node.
export async function provisionAndConnect({ chain = 'seq', assetId, deriveIdentity, policy = 'permissive', label } = {}) {
  if (typeof deriveIdentity !== 'function') throw new Error('provisionAndConnect: deriveIdentity(assetId) is required');
  const id = deriveIdentity(assetId);
  const devicePubkey = await deviceTransportPubkey(id.transportPrivkey);
  const node = await provisionNode({ chain, asset: assetId, deviceTransportPubkey: devicePubkey, label });
  // The registry key the LSP routes /channel/deposit + /channel/open by. Prefer the key the
  // LSP returned; fall back to the asset id (seq) or the device-keyed form (btc) so a stub
  // /node/provision (the Node test) that omits `key` still resolves the same key the LSP uses.
  const nodeKey = node.key
    || (chain === 'btc' ? `btc:${String(devicePubkey).toLowerCase()}` : String(assetId).toLowerCase());
  const wsUrl = provWsUrl(node.public_ws_path);
  const nodeId = await connectProvisioned({
    key: nodeKey, deviceSigningSeed: id.signingSeed, deviceTransportPrivkey: id.transportPrivkey,
    wsUrl, hostStaticPubkey: node.host_pubkey, policy,
  });
  return { node, nodeId, connected: !!nodeId, key: nodeKey };
}

// Snapshot of the provisioned-node signers (for the dynamic N/M leg display).
export function provisionedState() {
  const out = {};
  for (const [k, s] of Object.entries(provNodes)) out[k] = { connected: s.connected, nodeId: s.nodeId, phase: s.phase, detail: s.detail };
  return out;
}

export function disconnectProvisioned(assetId) {
  const keys = assetId ? [String(assetId).toLowerCase()] : Object.keys(provNodes);
  for (const k of keys) { const s = provNodes[k]; if (!s) continue; try { s.signer?.disconnect(); } catch {} s.signer = null; s.connected = false; s.phase = 'idle'; }
}

// -- 2. LSP HTTP client (plain fetch; Node-testable) ---------------------------
async function lspFetch(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (CFG.token) headers.authorization = `Bearer ${CFG.token}`;
  const r = await fetch(CFG.lspUrl + path, { ...opts, headers });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { ok: false, error: txt || 'bad json' }; }
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
// Both hosted nodes' ids + per-asset channel balances (spendable=send, recv=recv).
export function seqlnGetStatus() { return lspFetch('/status'); }
// Take a cross-chain offer through the LSP: {side:'buy'|'sell', asset, amount,
// payRail?, recvRail?}. payRail/recvRail each 'ln' | 'chain':
//   • omitted / ln+ln -> pure-LN (both legs Lightning); the LSP drives BOTH legs and
//     each hosted node's device signer co-signs its commitment updates over its wss
//     link. Returns {preimage, base/quote amounts, finality:'final'}.
//   • mixed (one 'ln', one 'chain') -> a SUBMARINE swap (asset on-chain HTLC <-> BTC
//     over Lightning). Anchor-gated; returns finality:'confirming' (anchor-bound).
// Rails are only serialized when present, so the pure-LN call is byte-identical to
// before (the LSP treats a missing rail as ln/ln).
export function seqlnSwap({ side, asset, amount, payRail, recvRail }) {
  const body = { side, asset, amount };
  if (payRail) body.payRail = payRail;
  if (recvRail) body.recvRail = recvRail;
  return lspFetch('/swap', { method: 'POST', body: JSON.stringify(body) });
}

// Just the channel list from /status (leg-tagged, per-asset spendable/receivable), for
// the Balance tab's in-channel ("Lightning") balance + the real channel count.
export async function seqlnChannels() {
  const st = await seqlnGetStatus();
  return st.channels || [];
}

// Which chains/assets the LSP can fund a channel for (Move to Lightning). SeqLN nodes
// are single-asset, so `assets` lists exactly the Sequentia assets that have a hosted
// node today (dynamic; grows as per-asset nodes are provisioned). `provisioning` is true
// when the LSP can spin up a node for ANY other asset (incl. a freshly-issued one) on
// demand. The Balance tab reads this to offer Move-to-Lightning per asset.
export async function seqlnFunding() {
  const st = await seqlnGetStatus();
  return st.funding || { btc: false, assets: [], provisioning: false };
}

// The provisioned per-asset hosted nodes (the dynamic "M" in "LN N/M"). Each is a
// single-asset keyless SeqLN node keyed to this device.
export async function seqlnNodes() {
  return (await lspFetch('/node/list')).nodes || [];
}

// Provision (or re-attach) a hosted SeqLN node for `asset`, keyed to THIS device. SeqLN
// nodes are single-asset, so moving a new asset into Lightning first needs its own node.
// `deviceTransportPubkey` is the device's per-node Noise static pubkey (seqln-keys.js);
// the node pins it so only this device can sign. Returns the node wiring the wallet then
// attaches its signer to (host_pubkey, public_ws_path) before funding a channel.
export function provisionNode({ asset, chain, deviceTransportPubkey, label }) {
  const body = { device_transport_pubkey: deviceTransportPubkey };
  // A per-USER BTC (testnet4) node is device-keyed (chain:'btc', NO asset id — the LSP
  // keys it by the device pubkey so a real wallet gets its OWN non-custodial BTC node).
  // A Sequentia asset node is asset-keyed. Only serialize `chain` for BTC so the seq
  // provision call is byte-identical to before.
  if (chain === 'btc') body.chain = 'btc';
  else body.asset = asset;
  if (label) body.label = label;
  return lspFetch('/node/provision', { method: 'POST', body: JSON.stringify(body) });
}

// Readiness of ONE provisioned node (by its registry key). A freshly-provisioned node boots
// + rescans, so its rpc is not answerable for the first seconds; the wallet polls this after
// provisionAndConnect (showing a "preparing your node…" progress) before it asks to fund a
// channel. Returns { ready, node_id, blockheight, synced }.
export function nodeGetinfo(nodeKey) {
  return lspFetch(`/node/getinfo?node=${encodeURIComponent(nodeKey)}`);
}

// Poll nodeGetinfo until the node's rpc answers (ready), emitting progress. Throws past the
// timeout with a clean message. This is what turns "still connecting" dead ends into an
// honest, bounded "preparing your node…" wait before funding.
export async function waitNodeReady({ nodeKey, onProgress, timeoutMs = 180_000, pollMs = 2500 } = {}) {
  if (!nodeKey) throw new Error('waitNodeReady: a node key is required');
  const emit = (extra) => { try { onProgress && onProgress({ phase: 'preparing', ...extra }); } catch {} };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let st = null;
    try { st = await nodeGetinfo(nodeKey); } catch { /* transient */ }
    if (st && st.ready) return st;
    emit({ ready: false });
    if (Date.now() > deadline) throw new Error('your Lightning node is still preparing (booting + syncing); try again in a moment');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// -- "Move to Lightning": non-custodial channel funding --------------------------
// Move BTC (testnet4) or a Sequentia asset from on-chain into a Lightning channel on
// the user's hosted node. NON-CUSTODIAL: the wallet signs the on-chain deposit itself
// (via the `sendOnchain` hook the wallet supplies, so this module never depends on the
// wallet's signer), and the channel funding tx is co-signed by the on-device signer
// (the hosted node is keyless), so the LSP orchestrates fundchannel but can never move
// the funds. The device signer for this chain's leg MUST be serving.
//
//   chain        'btc' | 'seq'
//   asset        (seq only) 'GOLD' or a 32-byte hex id — the asset to fund the channel with
//   amount       base units to move (BTC sats / asset atoms)
//   sendOnchain  async ({ chain, asset, amount, address }) => { txid } — the wallet's
//                own on-chain send to the hosted node's deposit address (it signs it)
//   onProgress   (evt) => void — { phase, ... }: 'deposit-address' | 'sending' | 'sent' |
//                'pending_deposit' | 'opening' | 'awaiting_lockin' | 'active' | 'failed'
// Resolves with the final active job ({ short_channel_id, spendable_msat, ... }).
// `node` is the LSP registry key of the user's OWN provisioned node (from
// provisionAndConnect). When present it is threaded into BOTH /channel/deposit and
// /channel/open so the deposit address AND the device-co-signed fundchannel target THAT
// node — NOT the shared demo node. Omitting it falls back to the LSP default (demo) node,
// so the wallet MUST pass it for a non-custodial per-user channel.
export async function fundChannel({ chain, asset, amount, node, sendOnchain, onProgress,
  pollMs = 5000, timeoutMs = 3_600_000 } = {}) {
  if (chain !== 'btc' && chain !== 'seq') throw new Error("fundChannel: chain must be 'btc' or 'seq'");
  if (typeof sendOnchain !== 'function') throw new Error('fundChannel: a sendOnchain hook is required (the wallet signs the deposit)');
  const emit = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch {} };

  // 1. The hosted node's on-chain deposit address for this chain (of the user's own node).
  emit('deposit-address');
  const depQ = `/channel/deposit?chain=${encodeURIComponent(chain)}`
    + (asset ? `&asset=${encodeURIComponent(asset)}` : '')
    + (node ? `&node=${encodeURIComponent(node)}` : '');
  const dep = await lspFetch(depQ);
  if (!dep.address) throw new Error('LSP returned no deposit address');

  // 2. The WALLET sends the deposit on-chain (it signs it — the LSP never holds the key).
  emit('sending', { address: dep.address });
  const sent = await sendOnchain({ chain, asset, amount, address: dep.address });
  emit('sent', { address: dep.address, deposit_txid: sent && sent.txid });

  // 3. Tell the LSP to watch for the deposit + fundchannel (device co-signs the funding).
  emit('opening-request');
  const body = { chain, amount };
  if (asset) body.asset = asset;
  if (node) body.node = node;               // route the fundchannel to the user's OWN node
  const started = await lspFetch('/channel/open', { method: 'POST', body: JSON.stringify(body) });
  const jobUrl = started.poll || `/channel/open/${started.job_id}`;

  // 4. Poll to completion, surfacing each phase for the UI.
  const deadline = Date.now() + timeoutMs;
  let job = started;
  for (;;) {
    emit(job.status, { job, deposit_txid: sent && sent.txid });
    if (job.status === 'active') return job;
    if (job.status === 'failed') throw new Error(job.error || 'channel open failed');
    if (Date.now() > deadline) throw new Error('channel open timed out');
    await new Promise((r) => setTimeout(r, pollMs));
    job = await lspFetch(jobUrl);
  }
}

export default {
  initSeqln, seqlnConfigured, seqlnDeployed, seqlnState, onSeqlnStatus, seqlnAvailable,
  lnFinalityCopy, connectDevice, disconnectDevice, seqlnGetStatus, seqlnSwap,
  seqlnChannels, seqlnFunding, seqlnNodes, provisionNode, fundChannel,
  deviceTransportPubkey, connectProvisioned, provisionAndConnect, provisionedState, disconnectProvisioned,
  nodeGetinfo, waitNodeReady,
};
