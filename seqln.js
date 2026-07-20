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
  wsUrl, hostStaticPubkey, policy = 'enforce',   // enforce custody by default; callers pass 'permissive' (SEQ_LSP_POLICY kill-switch) to override
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
    // Drop the dead signer object, not just the flag: a closed ws can't be reused (SDK builds a
    // fresh SeqlnSigner per connect), and the `if (s.signer) return` guards below would otherwise
    // block every reconnect after a link drop (the "won't reconnect after refresh/sleep" bug).
    if (st.state === 'closed' || st.state === 'error') { s.connected = false; s.signer = null; }
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
  wsUrl, hostStaticPubkey, policy = 'enforce' } = {}) {   // enforce custody by default; SEQ_LSP_POLICY='permissive' overrides
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
    // Null the dead signer (not just the flag) so a later reconnect rebuilds — the `if (s.signer)`
    // guard above would otherwise short-circuit every retry once the link has dropped once.
    if (st.state === 'closed' || st.state === 'error') { s.connected = false; s.signer = null; }
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
export async function provisionAndConnect({ chain = 'seq', assetId, deriveIdentity, policy = 'enforce', label } = {}) {   // enforce custody by default; SEQ_LSP_POLICY='permissive' overrides
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
  if (!r.ok || j.ok === false) {
    // Surface the LSP's `detail` (the settlement binary's actual output) alongside the
    // summary error — dropping it left terminal failures as a bare "did not settle"
    // with the real reason discarded.
    const detail = j.detail ? String(j.detail).trim().split('\n').filter(Boolean).slice(-2).join(' · ') : '';
    throw new Error((j.error || ('HTTP ' + r.status)) + (detail ? ` — ${detail.slice(0, 300)}` : ''));
  }
  return j;
}
// Registry keys for the device's OWN provisioned nodes to also read in /status, BEYOND the ones
// connected this session (provNodes). The wallet reconstructs these from its mnemonic on load
// (`registerOwnStatusKeys`), so a REOPENED wallet still reads back channels on its own nodes —
// else a just-moved balance looks gone after a refresh. Self-scoped: only keys this device could
// derive are added, and the LSP resolves a key ONLY if this device actually provisioned that node,
// so a candidate key for a node that was never opened simply returns nothing.
const ownStatusKeys = new Set();
export function registerOwnStatusKeys(keys) { for (const k of (keys || [])) if (k) ownStatusKeys.add(String(k).toLowerCase()); }

// Both hosted nodes' ids + per-asset channel balances (spendable=send, recv=recv). Passes THIS
// device's provisioned-node keys (`?nodes=`) so /status also reports the device's OWN per-asset
// channels — so the Balance card reflects a channel the user created on their own node (not only
// the shared demo nodes), including across page reloads. Only keys this device derived are sent,
// so it stays self-scoped.
export function seqlnGetStatus() {
  const keys = [...new Set([...Object.keys(provNodes), ...ownStatusKeys])];
  return lspFetch('/status' + (keys.length ? ('?nodes=' + encodeURIComponent(keys.join(','))) : ''));
}

// The PURE-LN order book for <asset>/BTC, read from the SAME relay the LSP's xpln lifts from — so the
// composer prices and PINS the exact offer that will execute, instead of the on-chain cross book (a
// different market). Returns { buy_offers, sell_offers } each best-first (buy = cheapest, sell =
// richest), with offer_id + maker_pubkey to pin into the swap. A thrown error / older LSP without the
// endpoint means "no pure-LN liquidity" — the caller degrades honestly (disables Review).
export function seqlnLnBook(asset, quote) {
  // quote: a real Sequentia asset id for an asset<->asset pure-LN market (EURX/OILX), else omitted =
  // the classic asset<->BTC book (unchanged wire for every existing call).
  let q = '/lnbook?asset=' + encodeURIComponent(String(asset || ''));
  if (quote && String(quote).toUpperCase() !== 'BTC') q += '&quote=' + encodeURIComponent(String(quote));
  return lspFetch(q);
}

// Ask the LSP which of the device's CANDIDATE node keys are ACTUALLY provisioned (exist in the
// registry) — resolved from the PROV registry, NOT the node RPC, so a node blocked waiting for its
// signer (invisible to /status) is still discoverable. This breaks the reconnect deadlock: a just-
// revived node can be found and have its signer reattached even though it can't answer /status yet.
// Returns { provisioned: [{ key, asset_id, chain }] }. Self-scoped: only keys THIS device can derive
// are sent, and the LSP confirms a key only if this device provisioned it. Callers should treat a
// thrown error (e.g. endpoint not deployed) as "no discovery" and fall back to /status + remembered legs.
export function seqlnListNodes(keys) {
  const list = [...new Set((keys || []).filter(Boolean).map((k) => String(k).toLowerCase()))];
  if (!list.length) return Promise.resolve({ provisioned: [] });
  return lspFetch('/nodes/list', { method: 'POST', body: JSON.stringify({ keys: list }) });
}

// The on-chain (not-yet-in-a-channel) state of one of the device's OWN nodes. Used to DETECT a
// stranded deposit — a Move-to-Lightning whose deposit landed but whose channel never opened — so
// the wallet can finish it. Returns { node_up, onchain_msat, asset_id, channels, stranded }.
// stranded = node_up && onchain_msat>0 && channels==0. node_up:false means the node is still
// booting / awaiting its signer (unknown, not "no deposit").
export function seqlnNodeOnchain(node_key) {
  return lspFetch('/node/onchain?node=' + encodeURIComponent(node_key));
}

// --- Sub-asset BUY (pay BTC on-chain, receive asset over Lightning) HODL primitives ------------
// Ensure inbound asset liquidity to the user's OWN node so the maker can pay the asset over LN
// (JIT 0-conf inbound channel). amount in ASSET SATS.
export function seqlnChannelInbound({ node_key, asset, amount }) {
  return lspFetch('/channel/inbound', { method: 'POST', body: JSON.stringify({ node_key, asset, amount }) });
}
// Register a HODL invoice by hash H on the user's OWN node (the DEVICE keeps P; the node/LSP never
// learn it). Returns { payment_hash, bolt11:null, node_id, hodl:true } — the maker pays H BY HASH
// to node_id (pay-by-hash, like the sell). amount in ASSET SATS.
export function seqlnNodeInvoice({ node_key, asset, amount, payment_hash }) {
  return lspFetch('/node/invoice', { method: 'POST', body: JSON.stringify({ node_key, asset, amount, payment_hash }) });
}
// Poll the HODL invoice state on the user's node: { state, held /* maker's payment accepted+held */, settled }.
export function seqlnInvoiceStatus({ node_key, payment_hash }) {
  return lspFetch('/node/invoice-status?node=' + encodeURIComponent(node_key) + '&payment_hash=' + encodeURIComponent(payment_hash));
}
// Device-settle a HELD HODL invoice with P: releases the held asset payment to the user AND reveals
// P to the maker (via update_fulfill_htlc), atomically. Call ONLY after invoice-status shows held.
export function seqlnNodeSettle({ node_key, payment_hash, preimage }) {
  return lspFetch('/node/settle', { method: 'POST', body: JSON.stringify({ node_key, payment_hash, preimage }) });
}
// Generic Lightning RECEIVE: a plain (non-HODL) bolt11 to receive `amount` asset sats into the user's
// own hosted node. The node signs the invoice (device online required). Returns { bolt11, payment_hash }.
export function seqlnNodeReceive({ node_key, amount, description }) {
  return lspFetch('/node/receive', { method: 'POST', body: JSON.stringify({ node_key, amount, description }) });
}
// Generic Lightning SEND: the user's own hosted node PAYS `bolt11` (device co-signs every HTLC).
// Returns { paid, preimage, amount_msat, destination }.
export function seqlnNodePay({ node_key, bolt11 }) {
  return lspFetch('/node/pay', { method: 'POST', body: JSON.stringify({ node_key, bolt11 }) });
}
// Advisory status of an async LSP job (e.g. the sub-asset HODL BUY /swap job). Takes the poll path
// ('/swap/<id>') the /swap 202 returned, or a bare id. The wallet drives its own settle; this is only
// a display hint (pending|held|settled|failed).
export function seqlnJobStatus(pathOrId) {
  const p = String(pathOrId || '');
  return lspFetch(p.startsWith('/') ? p : ('/swap/' + p));
}

// "Move back to chain": cooperatively close a channel on the user's own hosted node and send the
// reclaimed funds to `destination` (the wallet's own on-chain address). The INVERSE of fundChannel.
// The device signer MUST be connected first (the keyless node's closing tx is device-signed), so the
// caller provisions/connects the node before calling this. Returns { closing_txid, type, destination }.
export function closeChannelLsp({ chain = 'seq', asset, node, scid, destination, unilateraltimeout } = {}) {
  return lspFetch('/channel/close', {
    method: 'POST',
    body: JSON.stringify({ chain, asset, node, scid, destination, unilateraltimeout }),
  });
}
// Take a cross-chain offer through the LSP: {side:'buy'|'sell', asset, amount,
// payRail?, recvRail?}. payRail/recvRail each 'ln' | 'chain':
//   • omitted / ln+ln -> pure-LN (both legs Lightning); the LSP drives BOTH legs and
//     each hosted node's device signer co-signs its commitment updates over its wss
//     link. Returns {preimage, base/quote amounts, finality:'final'}.
//   • mixed (one 'ln', one 'chain') -> a SUBMARINE swap (asset on-chain HTLC <-> BTC
//     over Lightning). Anchor-gated; returns finality:'confirming' (anchor-bound).
// Rails are only serialized when present, so the pure-LN call is byte-identical to
// before (the LSP treats a missing rail as ln/ln).
export function seqlnSwap({ side, asset, amount, quote_asset, payRail, recvRail, node_key, btc_claim_pub, offer_id, maker_pubkey, swap_nonce, hodl, payment_hash, asset_amount, btc_htlc }) {
  const body = { side, asset, amount };
  // asset<->asset pure-LN: the counter (quote) asset id. Omitted (or 'BTC') => the classic asset<->BTC
  // pure-LN, so the pure-LN body stays byte-identical to before for every existing asset<->BTC swap.
  if (quote_asset && String(quote_asset).toUpperCase() !== 'BTC') body.quote_asset = quote_asset;
  if (payRail) body.payRail = payRail;
  if (recvRail) body.recvRail = recvRail;
  // Sub-asset SELL (pay asset over LN, receive BTC on-chain): the LSP drives the LN payment
  // from the user's OWN hosted node (`node_key`) and returns P + the BTC HTLC terms WITHOUT
  // claiming — the wallet then claims on-chain with the device key matching `btc_claim_pub`.
  if (node_key) body.node_key = node_key;
  if (btc_claim_pub) body.btc_claim_pub = btc_claim_pub;
  // Forward the SPECIFIC reviewed offer so the LSP lifts THAT resting sell (its btc_sats is what
  // claimSell's economic gate checks) rather than an arbitrary one — matching Ambra's swapSub.
  if (offer_id) body.offer_id = offer_id;
  if (maker_pubkey) body.maker_pubkey = maker_pubkey;
  // Sub-asset SELL idempotency key: the wallet persists it BEFORE this call and re-sends the SAME
  // value on a recovery re-call so the LSP returns the already-settled {preimage, btc_htlc} without
  // re-paying the asset. Only serialized when present, so the pure-LN body is byte-identical to before.
  if (swap_nonce) body.swap_nonce = swap_nonce;
  // Sub-asset BUY (pay BTC on-chain, receive asset over LN): the device funds a BTC HTLC + registers a
  // HODL invoice on H, then the LSP drives the maker's pay-by-hash. These MUST reach the LSP or its
  // /swap handler never takes the `hodl` BUY branch and falls through to pure-LN — silently breaking
  // the whole sub-asset buy. (They were dropped by this destructure.)
  if (hodl) body.hodl = hodl;
  if (payment_hash) body.payment_hash = payment_hash;
  if (asset_amount != null) body.asset_amount = asset_amount;
  if (btc_htlc) body.btc_htlc = btc_htlc;
  return lspFetch('/swap', { method: 'POST', body: JSON.stringify(body) });
}

// The sub-asset order book for an asset: { sell_available, buy_available, sell_offers[],
// buy_offers[] }. Drives DYNAMIC rail gating (light the toggle only when real resting
// counterparty liquidity exists — for ANY asset, no hardcoded maker list) and the book view.
export function seqlnBook(asset) {
  return lspFetch('/book?asset=' + encodeURIComponent(asset));
}

// The UNIFIED order book for a BTC<->asset pair (Stage 2, rail-agnostic matching): ONE price-sorted
// book merging the on-chain cross relay + the sub-asset LN relays, rail as metadata. Returns
// { ok, asks[], bids[], best_ask, best_bid, counts } — each entry has { price, assetAtoms, btcSats,
// rail:'ln'|'onchain', id, raw }. The composer shows all resting liquidity and prices off the best,
// whichever rail carries it; the settlement router bridges the rails on take.
export function seqlnUnifiedBook(asset) {
  return lspFetch('/book/unified?asset=' + encodeURIComponent(asset));
}

// Post a resting sub-asset offer the wallet signed itself (the LSP never signs). `offer` is
// the signed Offer protojson. Returns { offer_id, status }.
export function seqlnPostOffer(offer) {
  return lspFetch('/offer', { method: 'POST', body: JSON.stringify({ offer }) });
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

  // 4. Poll to completion, surfacing each phase for the UI. The channel-open runs SERVER-SIDE, so a
  // transient network blip on the poll (the "failed to fetch" that used to kill the whole move) must
  // NOT abandon it — retry a bounded number of times, and only then surface a RESUMABLE error (the
  // job keeps running; reopening the wallet re-polls it). This is what makes a flaky connection
  // survivable instead of stranding a deposit.
  const deadline = Date.now() + timeoutMs;
  let job = started, pollErrors = 0;
  const maxPollErrors = 24;   // 24 * pollMs (~2 min at 5s) of transient tolerance before giving up
  for (;;) {
    emit(job.status, { job, deposit_txid: sent && sent.txid });
    if (job.status === 'active') return job;
    if (job.status === 'failed') throw new Error(job.error || 'channel open failed');
    if (Date.now() > deadline) throw new Error('channel open timed out');
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      job = await lspFetch(jobUrl);
      pollErrors = 0;
    } catch (e) {
      if (++pollErrors > maxPollErrors) {
        const err = new Error('Lost connection while opening the channel. It may still be completing on the server — reopen the wallet to resume.');
        err.resumable = true; err.jobUrl = jobUrl; err.cause = e;
        throw err;
      }
      emit('reconnecting', { attempt: pollErrors, of: maxPollErrors });
      // keep `job` as-is (last known status) and loop; the next poll retries the same jobUrl.
    }
  }
}

// Resume a channel-open WITHOUT re-depositing: the deposit already landed on the node, so just
// (re)start the LSP's fundchannel-from-existing-balance job and poll it to completion. Used to
// recover a move that was interrupted after the deposit but before the channel opened (the
// "stranded deposit" case) — the funds are on the user's own node, this finishes moving them.
export async function resumeFundChannel({ chain, asset, amount, node, onProgress, pollMs = 5000, timeoutMs = 3_600_000 } = {}) {
  const emit = (phase, extra) => { try { onProgress && onProgress({ phase, ...extra }); } catch {} };
  emit('opening-request');
  const body = { chain, amount };
  if (asset) body.asset = asset;
  if (node) body.node = node;
  const started = await lspFetch('/channel/open', { method: 'POST', body: JSON.stringify(body) });
  const jobUrl = started.poll || `/channel/open/${started.job_id}`;
  const deadline = Date.now() + timeoutMs;
  let job = started, pollErrors = 0;
  const maxPollErrors = 24;
  for (;;) {
    emit(job.status, { job });
    if (job.status === 'active') return job;
    if (job.status === 'failed') throw new Error(job.error || 'channel open failed');
    if (Date.now() > deadline) throw new Error('channel open timed out');
    await new Promise((r) => setTimeout(r, pollMs));
    try { job = await lspFetch(jobUrl); pollErrors = 0; }
    catch (e) { if (++pollErrors > maxPollErrors) throw e; emit('reconnecting', { attempt: pollErrors, of: maxPollErrors }); }
  }
}

export default {
  initSeqln, seqlnConfigured, seqlnDeployed, seqlnState, onSeqlnStatus, seqlnAvailable,
  lnFinalityCopy, connectDevice, disconnectDevice, seqlnGetStatus, seqlnSwap,
  seqlnChannels, seqlnFunding, seqlnNodes, provisionNode, fundChannel,
  deviceTransportPubkey, connectProvisioned, provisionAndConnect, provisionedState, disconnectProvisioned,
  nodeGetinfo, waitNodeReady,
};
