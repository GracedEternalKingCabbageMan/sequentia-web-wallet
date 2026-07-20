// sbtc.js — the wallet's thin client for the SBTC bridge (the application-level BTC<->SBTC custody
// peg). See ../sbtc-bridge/bridge.mjs and doc/sequentia/sbtc-peg-design.md.
//
// The bridge is reached at a SAME-ORIGIN path (default /sbtc), exactly like the seqob relay's
// /seqob: the reverse proxy (Caddy) forwards /sbtc -> the bridge and owns exposure/auth, so the
// browser calls it without CORS and no secret ever lives in the page.
//
// This module ONLY allocates bridge addresses. It moves NO funds: the actual BTC and SBTC transfers
// are made by the wallet's normal on-chain send path, and completion is observed by the wallet
// watching its own balance (the peg-in SBTC credit / the peg-out BTC arrival). Keeping it this thin
// means the trust surface is entirely the bridge + the user's own signed sends — never this client.

let BRIDGE = '/sbtc';
export function setBridgeBase(base){ BRIDGE = base || '/sbtc'; }
export function bridgeBase(){ return BRIDGE; }

async function post(path, body){
  const r = await fetch(BRIDGE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}), cache: 'no-store',
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { ok: false, error: txt || 'bad json' }; }
  if (!r.ok || j.ok === false) throw new Error(j.error || ('SBTC bridge HTTP ' + r.status));
  return j;
}

// PEG-IN: ask the bridge for a fresh Bitcoin deposit address bound to `seqRecipient` (a Sequentia
// address to be credited SBTC 1:1 once the BTC deposit confirms). The wallet then sends real BTC
// there; the bridge mints SBTC to seqRecipient after K confirmations. Idempotent enough to re-call
// (each call returns a fresh address; only a funded one is ever credited).
export async function requestPegIn(seqRecipient){
  if (!seqRecipient) throw new Error('peg-in needs a Sequentia recipient address');
  const j = await post('/pegin', { seq_recipient: String(seqRecipient) });
  if (!j.deposit_address) throw new Error('bridge returned no deposit address');
  return j.deposit_address;
}

// PEG-OUT: ask the bridge for a fresh Sequentia address bound to `btcDest` (a Bitcoin address to
// receive real BTC 1:1 once SBTC arrives). The wallet then sends SBTC there; the bridge burns it and
// releases reserve BTC to btcDest.
export async function requestPegOut(btcDest){
  if (!btcDest) throw new Error('peg-out needs a Bitcoin destination address');
  const j = await post('/pegout', { btc_dest: String(btcDest) });
  if (!j.sbtc_address) throw new Error('bridge returned no SBTC address');
  return j.sbtc_address;
}

// Resolve the SBTC asset id from a registry/asset-meta lookup the caller supplies. SBTC is a normal
// registered asset (ticker "SBTC"); the wallet already knows every asset's ticker, so the caller
// passes a (hex)->ticker resolver and we return the id whose ticker is SBTC, or null if not present
// (the peg is simply unavailable then). Kept here so the "which asset is SBTC" rule lives in one place.
export function resolveSbtcAsset(assetList, tickerOf){
  for (const hex of (assetList || [])){
    try { if (String(tickerOf(hex) || '').toUpperCase() === 'SBTC') return hex; } catch {}
  }
  return null;
}
