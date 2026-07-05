// ---------------------------------------------------------------------------
// seqln.js — the wallet's Lightning module (the LSP / hosted-SeqLN thin client).
//
// The non-custodial instant-LN DEX from a thin wallet. Under the LSP model
// (UX-audit §8.2 Tier 2): WE host the SeqLN node; the wallet is a thin client
// that (a) holds the keys and CO-SIGNS the hosted node's commitment updates via
// the on-device wasm signer SDK over a wss Noise link, and (b) COMMANDS the
// hosted node to take a pure-LN order-book offer via a thin LSP HTTP API.
//
// The device signer NEVER leaves the browser: the hosted node has no hsm_secret,
// so the LSP can command routing but can never move the user's channel funds.
//
// Two independent concerns, kept separate:
//   1. connectDevice()  — bring the on-device signer online (needs the wasm SDK,
//      a wss endpoint, and the wallet-derived device identity). Browser-gated.
//   2. seqlnGetStatus() / seqlnSwap()  — the LSP HTTP client (plain fetch, so it
//      is fully testable in Node and mirrors the SEQ_SEQOB_URL global pattern).
//
// This module holds NO app/DOM references; index.html wires status into the UI
// and swap.js reaches it through the `ln` bridge (beside xswap/xrswap/xmaker).
// ---------------------------------------------------------------------------

const DEFAULTS = {
  lspUrl: (typeof window !== 'undefined' && window.SEQ_LSP_URL)
    || (typeof location !== 'undefined' ? location.origin + '/lsp' : 'http://127.0.0.1:9981'),
  token: (typeof window !== 'undefined' && window.SEQ_LSP_TOKEN) || '',
  // wss front of the hosted node's Noise_XK responder (WS<->TCP relay). Absent =>
  // the on-device signer cannot come online, so the LN route stays unavailable.
  wsUrl: (typeof window !== 'undefined' && window.SEQ_LSP_WS) || '',
  hostPubkey: (typeof window !== 'undefined' && window.SEQ_LSP_HOST_PUBKEY) || '',
  // The wasm signer SDK (vendored under /lightning). Dynamic-imported so a wallet
  // with LN unconfigured never loads the 1.5MB wasm.
  sdkPath: (typeof window !== 'undefined' && window.SEQ_LSP_SDK) || './lightning/seqln-signer-sdk.js',
};

let CFG = { ...DEFAULTS };
let signer = null;
let onChange = null;
const state = { connected: false, nodeId: null, phase: 'idle', detail: '' };

function setPhase(phase, detail) {
  state.phase = phase; state.detail = detail || '';
  if (onChange) { try { onChange(seqlnState()); } catch {} }
}

export function initSeqln(opts = {}) { CFG = { ...DEFAULTS, ...opts }; return CFG; }
export function seqlnConfigured() { return !!CFG.lspUrl; }
export function seqlnState() { return { ...state, configured: seqlnConfigured() }; }
export function onSeqlnStatus(fn) { onChange = fn; }

// The LN swap route is offerable only when the on-device signer is actually
// serving the hosted node (so the hosted node can sign the swap's commitments)
// AND the LSP is reachable. Availability is deliberately conservative: no signer,
// no LN route, and the composer falls back to the on-chain cross rail.
export function seqlnAvailable() { return seqlnConfigured() && state.connected; }

// Pure-LN happy path: genuinely instant + final (nothing on-chain, zero reorg
// risk). This is the ONE swap state the DEX 0-conf policy lets us call "final".
export function lnFinalityCopy() {
  return 'Instant and final · pure Lightning, nothing on-chain, no Bitcoin-reorg risk.';
}

// -- 1. on-device signer (browser-gated: needs WebSocket + wasm + the SDK) -----
// `mnemonic` seeds the hosted node's LN identity (the user's own seed).
// `deviceTransportPrivkey` is the pinned Noise static key (provisioned with the
// LSP; in a full build derived from the seed + registered at onboarding).
export async function connectDevice({ mnemonic, deviceTransportPrivkey, policy = 'permissive' } = {}) {
  if (!CFG.wsUrl || !CFG.hostPubkey) { setPhase('unconfigured', 'no wss endpoint / host key'); return null; }
  if (!mnemonic || !deviceTransportPrivkey) { setPhase('unconfigured', 'no device identity'); return null; }
  if (signer) return state.nodeId;
  setPhase('connecting', 'loading signer');
  const mod = await import(CFG.sdkPath);
  const SeqlnSigner = mod.SeqlnSigner || mod.default;
  signer = await SeqlnSigner.fromMnemonic(mnemonic);
  signer.setPolicy(policy);
  signer.onStatus = (st) => {
    if (st.state === 'node_id') { state.nodeId = st.nodeId; setPhase('node_id', st.nodeId.slice(0, 14) + '…'); }
    else setPhase(st.state, st.detail);
    if (st.state === 'closed' || st.state === 'error') { state.connected = false; }
  };
  try {
    await signer.connect({ wsUrl: CFG.wsUrl, hostStaticPubkey: CFG.hostPubkey, deviceStaticPrivkey: deviceTransportPrivkey });
    const id = await signer.whenNodeId(30000);
    state.nodeId = id; state.connected = true; setPhase('ready', 'signer serving');
    return id;
  } catch (e) {
    signer = null; state.connected = false; setPhase('error', e.message || String(e));
    return null;
  }
}
export function disconnectDevice() {
  try { signer?.disconnect(); } catch {}
  signer = null; state.connected = false; setPhase('idle', '');
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
// Hosted node id + per-asset channel balances (spendable=send, receivable=recv).
export function seqlnGetStatus() { return lspFetch('/status'); }
// Take a pure-LN offer: {side:'buy'|'sell', asset, amount}. Returns the settle
// (preimage, base/quote amounts). The device co-signs the hosted node's
// commitment updates in the background over the wss link during this call.
export function seqlnSwap({ side, asset, amount }) {
  return lspFetch('/swap', { method: 'POST', body: JSON.stringify({ side, asset, amount }) });
}

export default {
  initSeqln, seqlnConfigured, seqlnState, onSeqlnStatus, seqlnAvailable,
  lnFinalityCopy, connectDevice, disconnectDevice, seqlnGetStatus, seqlnSwap,
};
