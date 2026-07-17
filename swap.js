// ---------------------------------------------------------------------------
// SeqDEX swap — the symmetric "Pay -> Receive" composer (Phase 6d-3 reframe).
//
// ONE composer replaces the old market/BUY-SELL form: "You pay [amt][asset]" on
// top, a circular flip (the signature) in the middle, "You receive [amt][asset]"
// below. Both asset fields are visually EQUAL — there is no base/quote and no
// privileged/native asset in the UI. Buying vs selling is just which asset sits
// on top; the flip inverts pay<->receive and re-quotes.
//
// Routing is automatic from the chosen assets, so the composer is the single
// entry point for BOTH swap kinds:
//   • both sides Sequentia assets -> SAME-CHAIN atomic swap (this module's
//     propose -> sign -> complete path, unchanged from 6d-1).
//   • either side is BTC (the parent/testnet4 asset) -> CROSS-CHAIN HTLC wizard
//     (xswap.js: quote -> lock BTC -> propose -> anchor gate -> claim -> poll).
//
// The proven same-chain backend internals are preserved verbatim:
//   - dexPost to /v1/markets|market/price|trade/preview|trade/propose|trade/complete
//   - the SwapRequest via Wollet.seqdexSwapRequest(...)
//   - sign = new Pset -> addDetails(wollet) -> Signer.sign -> stripBip32 -> complete
//     (with the self-broadcast fallback). stripBip32 + the signing sequence are
//     untouched.
//
// Project UI rules honoured (all five, see the composer code):
//  • Buy AND sell of ALL assets, symmetric — the flip is the only direction control.
//  • SEQ/tSEQ equal standing — just one searchable row in the asset pickers.
//  • Open fee market — a first-class fee-asset selector, valued in native-equiv + ref.
//  • Reference currency — every amount (pay/receive/fee/rate) carries an "≈ <ref>" value.
//  • Anchor-aware finality — "settles in ~1 block · anchor-bound to Bitcoin"; never "instant".
// ---------------------------------------------------------------------------

import * as seqob from './seqob.js';
import { secp256k1 } from './btc.js';
// The byte-exact passive-CLOB covenant stack: place a funded resting order that
// fills permissionlessly (even while the wallet is offline), and settle an inbound
// match as the taker. Everything routes through these; no crypto is hand-rolled here.
import { planPlaceOrder, buildCovenantTerms, settleFill as covSettleFill, planRefund as covPlanRefund, cancel as covCancel } from './covenant-order.js';
import { makeCovenantHooks, makerPayout } from './covenant-fill-host.js';
import { computeRate, orderExpiry, deriveOtherField, buildCovenantOffer, fillRestSplit } from './covenant-flow.js';
// HONEST per-asset Lightning-rail gating (offer LN only with a real usable channel).
import { railAvailability } from './ln-rail.js';
// The mixed-rail (submarine) swap state machine + localStorage resume (fund-safety:
// an in-flight on-chain HTLC leg must survive a reload so it can be refunded).
import * as sub from './submarine.js';

let C = null;            // injected app context (see index.html initSwapTab)
let X = null;            // the cross-chain route handle ({ openFromComposer, renderXswap, hasInFlight })
let L = null;            // the Lightning (LSP) route handle ({ available, swap, status, finalityCopy })
let MARKETS = [];        // legacy RFQ markets (kept only to seed the picker; routing is order-book)
let XMARKETS = [];       // cross-chain: [{ btc_asset, seq_asset, ... }] (BTC<->asset)
let LAST_QUOTE = null;   // the priced/oriented same-chain legs for the current composer state
let BOOK = { offers: [], pair: null };   // the resting offers for the selected same-chain pair
let XBOOK = { offers: [], seqAsset: null, payIsBtc: true };   // resting cross offers for the selected BTC<->asset pair
let UBOOK = null;   // the UNIFIED book (on-chain + LN merged, rail-tagged) for the pair, from the LSP /book/unified
let XMAKE = null;   // the wallet's OWN live resting cross offer (maker) + its settlement state, if any
// Trades the user DISMISSED this session (kept live + resumable, just not force-shown). Gated in
// renderSwap so a dismissed swap returns to the composer instead of bouncing straight back to its
// stepper; the "Active trades" card (renderInFlightCard) reopens any of them. Session-only: a reload
// clears it, so an in-flight trade force-shows again on load (fund-safety: never silently lost).
const _dismissed = new Set();
// A small persistent log of COMPLETED trades (submarine/sell/cross), so the orders card is a
// history too, not just live status. Capped; deduped by a per-trade id so a terminal view that
// re-renders logs once. Summaries only (no keys/secrets) — safe to persist.
const HIST_KEY = 'swk.dex.history';
function loadHist(){ try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]') || []; } catch { return []; } }
function logTrade(e){
  if (!e || !e.id) return;
  try {
    const h = loadHist();
    if (h.some(x => x.id === e.id)) return;   // once per trade
    h.unshift({ id: e.id, title: e.title || '', status: e.status || '', txid: e.txid || null, at: Date.now() });
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 15)));
  } catch {}
}
// Same-chain DEX swaps receive TRANSPARENTLY by default (principle #6: transparent-by-default);
// the user can OPT IN to a confidential (blinded) receive. Persisted wallet-wide.
let _confidentialReceive = false;
try { _confidentialReceive = localStorage.getItem('swk.dex.confidentialReceive') === '1'; } catch {}
export function setConfidentialReceive(on){ _confidentialReceive = !!on; try { localStorage.setItem('swk.dex.confidentialReceive', on ? '1' : '0'); } catch {} }
export function confidentialReceive(){ return _confidentialReceive; }
// This wallet's own receive address for a same-chain DEX credit/refund: transparent (toUnconfidential)
// by DEFAULT, blinded only when the user opted in. Was previously blinded unconditionally (a #6 bug).
function covReceiveAddr(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  return (_confidentialReceive ? a : (a.toUnconfidential ? a.toUnconfidential() : a)).toString();
}

// ---------------------------------------------------------------------------
// Book namespace: Unblinded (transparent, default, live) vs Blinded (confidential).
// ---------------------------------------------------------------------------
// The Swap tab reads from + posts to ONE of two DISTINCT relay books. Transparent
// is the default (principle #6: transparent-by-default); the user opts into the
// blinded book with the toggle. The blinded book is a SEPARATE namespace on the
// relay (?confidential=1 / a signed confidential=true tag on the offer) that
// matches confidential-vs-confidential only, so BOTH swap legs blind on-chain and
// the public swap ratio never leaks a confidential amount. Persisted wallet-wide.
let _book = 'public';
try { _book = localStorage.getItem('swk.dex.book') === 'confidential' ? 'confidential' : 'public'; } catch {}
function isConfBook(){ return _book === 'confidential'; }
export function dexBook(){ return _book; }
function persistBook(){ try { localStorage.setItem('swk.dex.book', _book); } catch {} }

// blech32 charset (same symbol table as bech32; blech32 differs only in its 12-char
// checksum, which we do not need to verify — the address is minted by our own wasm).
const _B32_CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function _convertBits(data, from, to){
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const v of data){ acc = (acc << from) | v; bits += from; while (bits >= to){ bits -= to; out.push((acc >> bits) & maxv); } }
  return out;   // pad=false: leftover bits are dropped (correct for decode)
}
// Extract the 33-byte confidential blinding pubkey (hex) embedded in a blech32
// confidential (tsqb1…/sqb1…) address. Returns '' if the address is not blech32 or
// cannot be parsed; the caller still sets the signed confidential tag, so a failed
// extraction never mis-routes the book (the relay can also recover the key from the
// blech32 recv address itself). blech32 data = [witver] + convertbits(blinding_pub(33)
// || witness_program, 8, 5) + checksum(12); we drop the 12-char checksum + witver
// symbol, convert 5->8, and take the first 33 bytes.
function blindingPubFromAddr(addr){
  try {
    const s = String(addr).toLowerCase();
    const pos = s.lastIndexOf('1');
    if (pos < 1) return '';
    const vals = [];
    for (const ch of s.slice(pos + 1)){ const d = _B32_CS.indexOf(ch); if (d < 0) return ''; vals.push(d); }
    if (vals.length < 12 + 1) return '';
    const payload5 = vals.slice(1, vals.length - 12);   // drop witver symbol + 12-char checksum
    const bytes = _convertBits(payload5, 5, 8);
    if (bytes.length < 33) return '';
    return bytes.slice(0, 33).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}
// This wallet's own BLINDED (blech32) receive address + its blinding pubkey, for a
// confidential-book offer/lift. Both legs must blind, so a confidential offer always
// publishes the blinded form (never toUnconfidential).
function blindedReceive(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const addr = a.toString();
  return { address: addr, blindingPub: blindingPubFromAddr(addr) };
}

// The wallet's SeqOB MAKER identity: a stable per-browser key that signs resting
// offers + doubles as the E2E session key. It is NOT a fund key (funds move via the
// on-chain co-sign with the wallet's real keys), so persisting it locally is safe.
function makerPriv(){
  let h = (typeof localStorage !== 'undefined') && localStorage.getItem('seqobMakerKey');
  if (!h || !/^[0-9a-f]{64}$/.test(h)){
    const a = new Uint8Array(32); (crypto || window.crypto).getRandomValues(a);
    h = [...a].map(b => b.toString(16).padStart(2,'0')).join('');
    try { localStorage.setItem('seqobMakerKey', h); } catch {}
  }
  return seqob.hexToBytes(h);
}
function makerPubHex(){ return seqob.bytesToHex(secp256k1.getPublicKey(makerPriv(), true)); }
const EST_SWAP_VSIZE = 1500n;   // explicit same-chain swap fee estimate (vbytes)

// Composer state. payAsset/receiveAsset are asset hexes (or 'BTC' for the parent leg).
const S = {
  payAsset: null, receiveAsset: null,
  edited: 'pay',          // which side the user last typed ('pay' | 'receive')
  feeAsset: null,         // chosen fee asset hex (defaults to POLICY_HEX)
  quoting: false,
  // TWO independent settlement rails, one per leg. Each is 'ln' (instant Lightning)
  // or 'chain' (on-chain). ln+ln -> pure-LN LSP route; chain+chain -> on-chain
  // cross-chain HTLC; a MIXED pair (one leg each) needs the submarine backend (not
  // yet wired) and fails closed with an honest message. Only meaningful on a
  // BTC<->asset pair; forced to chain/chain otherwise so an LN-unconfigured wallet
  // behaves exactly as before.
  payRail: 'chain', recvRail: 'chain',
  railsTouched: false,    // true once the user (or a "fix" link) picks a rail -> stop auto-defaulting
  // TAKE = lift resting offers (fields LINKED via the book price; today's behavior).
  // POST = rest a LIMIT order at your OWN price (fields INDEPENDENT; pay÷receive IS the
  // price). Auto-defaults to 'post' for a pair with no resting orders so the market can be
  // started; 'take' when there is a book to lift. modeTouched stops the auto-default once
  // the user picks a mode. Only 'same' + 'cross' routes can be posted (LN/mixed are take-only).
  mode: 'take', modeTouched: false,
};
let INSTANT = {};    // ticker -> { spendable, receivable } atoms (best-effort from the LSP /status)
let LAST_MID = null; // { price, cross } for the current pair — feeds the pair bar
// The last LSP /status channel snapshot + provisioned-node state — the GROUND TRUTH the
// composer gates the Lightning rail on (a real per-asset channel, NOT "LSP configured").
// Refreshed by refreshInstant(); read synchronously by findRoute/updateRails.
let LNSTATUS = { channels: [], funding: null };
let LNPROV = {};     // provisionedState(): assetHexLower -> { connected, phase }
let MIXED = null;    // the in-flight mixed-rail (submarine) swap (persisted; see submarine.js)
const MIXED_KEY = 'swk.sequentia.submarine';   // localStorage key for the in-flight submarine swap

const TRADE_TYPE = { BUY: 0, SELL: 1 };   // seqdex.v1 TradeType enum

// POST <DEX>/v1/... as JSON; returns parsed JSON (or throws a useful message).
async function dexPost(path, body){
  const r = await fetch(C.DEX + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt }; }
  if (!r.ok) {
    const msg = (j && (j.message || j.error)) || j._raw || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return j;
}

const big = v => BigInt(v == null ? 0 : v);

// grpc-gateway emits camelCase but accepts either case; read a field by either name.
function pick(obj, ...names){
  if (!obj) return undefined;
  for (const n of names){ if (obj[n] !== undefined) return obj[n]; }
  return undefined;
}
function normMarket(m){
  const mk = pick(m, 'market') || m;
  return { base_asset: pick(mk, 'base_asset', 'baseAsset'),
           quote_asset: pick(mk, 'quote_asset', 'quoteAsset') };
}

// ---------------------------------------------------------------------------
// init / render
// ---------------------------------------------------------------------------
export function initSwap(ctx){
  C = ctx;
  X = ctx.xroute || null;     // cross-chain bridge wired in index.html (see initSwapTab)
  L = ctx.ln || null;         // Lightning (LSP) bridge wired in index.html (see initSwapTab)
  seqob.setSeqobBase(C.SEQOB || '/seqob');   // the order-book relay (same-origin proxy)
  const { $ } = C;
  if ($('swReview') && !$('swReview')._wired){
    $('swReview')._wired = true;
    $('swFlip').onclick  = onFlip;
    $('swMax').onclick   = onMax;
    $('swReview').onclick = onReview;
    $('swPayPick').onclick  = () => openPicker('pay');
    $('swRecvPick').onclick = () => openPicker('receive');
    $('swFeePick').onclick  = openFeePicker;
    // Two independent rail choosers (Pay from / Receive to), shown only for a
    // BTC<->asset pair when the on-device signer is live (see updateRails).
    wireRailSeg('swPayRailSeg', 'pay');
    wireRailSeg('swRecvRailSeg', 'recv');
    // Take / Post chooser (switching to Post unlinks the two amount fields).
    wireModeSeg();
    // Unblinded / Blinded book toggle (switches which relay namespace we read + post to).
    wireBookSeg();
    if ($('swXBack')) $('swXBack').onclick = () => { if (X && X.hasInFlight && X.hasInFlight()) _dismissed.add('cross'); showCross(false); renderSwap(); };
    if ($('swRBack')) $('swRBack').onclick = () => { if (X && X.hasReverseInFlight && X.hasReverseInFlight()) _dismissed.add('reverse'); showReverse(false); renderSwap(); };
    // Live re-quote as the user types. The edited side is the "fixed" leg; the
    // other side is quoted. Debounced so we don't hammer the daemon per keystroke.
    wireAmount($('swPayAmt'), 'pay');
    wireAmount($('swRecvAmt'), 'receive');
    // Reference-currency hints under each amount, valued in that side's asset.
    // Keep the returned updaters so we can re-value the hints when the asset (not
    // the typed value) changes, WITHOUT dispatching a synthetic 'input' (which
    // would falsely re-arm the requote/edited-side logic above).
    _payHint  = C.attachRefHint($('swPayAmt'),  () => S.payAsset || '');
    _recvHint = C.attachRefHint($('swRecvAmt'), () => S.receiveAsset || '');
  }
}
let _payHint = null, _recvHint = null;

let _quoteTimer = null;
function wireAmount(input, side){
  input.addEventListener('input', () => {
    S.edited = side;
    input._userTyped = true;   // this side now holds USER input — never overwrite it
    LAST_QUOTE = null;
    setReviewEnabled(false);
    clearTimeout(_quoteTimer);
    _quoteTimer = setTimeout(() => requote().catch(()=>{}), 350);
  });
}
// Programmatically set a field's value and mark it NOT user-typed (so the other
// side's derivation may overwrite this one; the user's own input is protected).
function setDerived(input, value){ if (!input) return; input.value = value; input._userTyped = false; }
// Apply the anti-clobber compose rule: derive the field the user did NOT edit from
// the book's best price, WITHOUT clearing or overwriting anything the user typed.
// The empty-market case (no price) leaves both fields exactly as typed — this is
// the fix for the first-order bug where linked fields wiped each other.
function applyComposeDerivation(pay, receive, price){
  const payEl = C.$('swPayAmt'), recvEl = C.$('swRecvAmt');
  const editedEl = S.edited === 'pay' ? payEl : recvEl;
  const otherEl  = S.edited === 'pay' ? recvEl : payEl;
  if (document.activeElement === otherEl) return;   // never fight the field being typed in
  if (editedEl._refMode || otherEl._refMode) return; // ref-currency input mode: don't derive across units
  const r = deriveOtherField({
    edited: S.edited, editedVal: numVal(editedEl),
    otherUserTyped: !!otherEl._userTyped, price,
  });
  if (!r) return;                                    // no derivation -> leave both fields untouched
  const meta = C.assetMeta(r.side === 'pay' ? pay : receive);
  setDerived(otherEl, C.fmtAtoms(C.parseAtoms(String(trim(r.value)), meta.precision || 0), meta.precision || 0));
  paintRefHints();
}

// Re-render the whole composer for the current wallet/markets/state.
export async function renderSwap(){
  if (!C.wollet) return;
  // Prune stale dismissals: once a kind's trade has ended, its flag must not suppress a future one.
  if (!hasMixedInFlight()) _dismissed.delete('mixed');
  if (!(X && X.hasInFlight && X.hasInFlight())) _dismissed.delete('cross');
  if (!(X && X.hasReverseInFlight && X.hasReverseInFlight())) _dismissed.delete('reverse');
  // A persisted mixed-rail (submarine) swap owns the tab until it is terminal or
  // dismissed: its on-chain HTLC leg is recoverable only via the Refund off-ramp, so
  // the trade-process view (not the composer) must show on entry — including after a reload.
  if (hasMixedInFlight() && !_dismissed.has('mixed')){
    showMixed(true); renderMixedSwap();
    return;
  }
  // If a cross-chain swap is already in flight, jump straight to its stepper —
  // the composer's single entry point also resumes an interrupted BTC swap. Two
  // directions, two wizards: forward (pay BTC, get asset) and reverse (sell asset).
  // Skipped if the user DISMISSED it this session — the Active-trades card reopens it.
  if (X && X.hasInFlight && X.hasInFlight() && !_dismissed.has('cross')){
    showCross(true);
    X.renderXswap();
    return;
  }
  if (X && X.hasReverseInFlight && X.hasReverseInFlight() && !_dismissed.has('reverse')){
    showReverse(true);
    X.renderReverse();
    return;
  }
  showCross(false); showReverse(false); showMixed(false);
  const _bh = C.$('swBook'); if (_bh) _bh.innerHTML = '';   // cleared; requote re-renders for the selected pair
  renderInFlightCard();   // any dismissed / background in-flight trade, reopenable
  renderMyOrders();
  await loadMarkets();
  // Default the pay/receive assets to the first sensible tradable pair so the
  // composer is never empty: tSEQ on top if it trades, else the first market.
  ensureDefaults();
  renderFeePicker();
  paintPanes();
  renderChips();
  renderPairBar();
  refreshInstant();   // best-effort instant/on-chain split from the LSP /status (non-blocking)
  await requote().catch(()=>{});
}

function showCross(on){
  const cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (cw) cw.classList.toggle('hide', !on);
  if (on && rw) rw.classList.add('hide');     // forward + reverse hosts are mutually exclusive
  if (comp) comp.classList.toggle('hide', on);
  // "Back to composer" is now a DISMISS (the swap keeps running + the Active-trades card reopens
  // it), so it's shown whenever the cross host is open — including with a swap in flight.
  const back = C.$('swXBack');
  if (back) back.classList.toggle('hide', !on);
}
// Reverse (asset -> BTC) wizard host, symmetric with showCross.
function showReverse(on){
  const cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (rw) rw.classList.toggle('hide', !on);
  if (on && cw) cw.classList.add('hide');
  if (comp) comp.classList.toggle('hide', on);
  // Symmetric with showCross: reveal "Back to composer" whenever the reverse host is open,
  // including with a sell in flight (it's a DISMISS — the swap keeps running).
  const back = C.$('swRBack');
  if (back) back.classList.toggle('hide', !on);
}

// ---------------------------------------------------------------------------
// markets discovery (same-chain pairs + cross-chain BTC<->asset pairs)
// ---------------------------------------------------------------------------
async function loadMarkets(){
  const status = C.$('swStatus');
  if (status){ status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading markets…'; }
  // Same-chain markets.
  try {
    const resp = await dexPost('/v1/markets', {});
    MARKETS = (Array.isArray(resp.markets) ? resp.markets : []).map(m => ({
      market: normMarket(m), fee: pick(m, 'fee') || {},
    }));
  } catch (e){ MARKETS = []; }
  // Cross-chain markets (BTC <-> asset). Best-effort; absence just hides BTC routes.
  XMARKETS = (X && X.markets) ? await X.markets().catch(()=>[]) : [];
  if (status) status.textContent = '';
  C.$('swErr').textContent = '';
}

// Assets the composer can START from (either side, before the other is chosen):
// everything the user OWNS (so the wallet's own assets are always selectable, even
// before a market has loaded), plus every asset quoted by some market, plus BTC if a
// cross-chain market exists. findRoute() still gates an actual swap on a real market,
// so an owned-but-unmarketed asset is offered but routes to "No market".
function startableAssets(){
  const set = new Set();
  const bal = C.balObj() || {};
  for (const h of Object.keys(bal)){ if (big(bal[h]) > 0n) set.add(h); }   // what you hold
  // Every registry/known asset: the order book lets you trade (or start) ANY pair,
  // not just ones with a pre-existing market.
  if (C.registryAssets){ for (const h of C.registryAssets()){ if (h && h !== 'BTC') set.add(h); } }
  for (const m of MARKETS){ set.add(m.market.base_asset); set.add(m.market.quote_asset); }
  for (const xm of XMARKETS){ set.add('BTC'); set.add(xm.seq_asset); }
  // The blinded book is Sequentia-only: BTC lives on the parent chain, which has no
  // confidential transactions, so a BTC leg cannot blind. Drop it from the picker.
  if (isConfBook()) set.delete('BTC');
  // Dedup by resolved ticker. Reissued assets leave STALE ids behind: an old id may
  // resolve to the SAME ticker as the current one (making the asset appear twice), or
  // to a metadata-less "Asset" (dust of a long-dead id). Keep ONE id per ticker,
  // preferring the id the current registry knows, then a held id; and drop unresolved
  // ids that are not actually held.
  const reg = new Set(C.registryAssets ? C.registryAssets() : []);
  const held = h => { try { return big(bal[h] || 0n) > 0n; } catch { return false; } };
  const byKey = new Map();
  for (const h of set){
    if (h === 'BTC'){ byKey.set('BTC', 'BTC'); continue; }
    const meta = (C.assetMeta && C.assetMeta(h)) || {};
    const resolved = meta.name && meta.name !== 'Asset';
    if (!resolved && !held(h)) continue;                  // stale dust of an old id, no metadata: hide it
    const key = resolved ? meta.ticker : h;               // group resolved by ticker; keep unresolved-but-held unique
    const cur = byKey.get(key);
    if (!cur){ byKey.set(key, h); continue; }
    if ((reg.has(h) && !reg.has(cur)) || (held(h) && !held(cur))) byKey.set(key, h);   // prefer registry-known, then held
  }
  return [...byKey.values()];
}

// Assets that have a market with `other` (the already-chosen side). If `other` is
// null, every tradable asset is a candidate. This is how the pickers only offer a
// counter-asset that actually trades against the chosen one.
function counterpartsOf(other){
  if (!other) return startableAssets();
  const set = new Set();
  if (other === 'BTC'){
    // Cross-chain order book: BTC pairs with ANY Sequentia asset. The pair may have
    // no resting cross offers yet, in which case its book shows empty (a maker must
    // post one) — but every asset is selectable, not just ones with a live market.
    for (const h of startableAssets()){ if (h !== 'BTC') set.add(h); }
  } else {
    // Same-chain: any OTHER Sequentia asset is a valid counterpart (the pair may
    // have no resting offers yet — then it's startable). BTC is a valid cross-chain
    // counterpart on the transparent book only (the blinded book is Sequentia-only).
    for (const h of startableAssets()){ if (h !== other && h !== 'BTC') set.add(h); }
    if (!isConfBook()) set.add('BTC');
  }
  return [...set];
}

// Is (pay, receive) a routable pair? Same-chain if both are Sequentia assets with
// a market; cross-chain if exactly one side is BTC and the BTC<->asset market exists.
function findRoute(pay, receive){
  if (!pay || !receive || pay === receive) return null;
  if (pay === 'BTC' && receive === 'BTC') return null;   // BTC<->BTC is not a market
  const btcPair = (pay === 'BTC') !== (receive === 'BTC');   // exactly one side is BTC
  if (btcPair){
    const seqAsset = pay === 'BTC' ? receive : pay;
    const payIsBtc = pay === 'BTC';
    const xm = XMARKETS.find(m => m.seq_asset === seqAsset) || null;
    // When LN isn't deployed there is no rail choice: both legs are on-chain, so an
    // LN-unconfigured wallet always takes the proven cross route (independent of any
    // stale rail state). Gate on lnDeployed() (own-node capable), NOT lnAvailable()
    // (shared hub connected): the mixed/pure-LN legs below run on the user's OWN nodes,
    // and the per-leg ra.payLn/recvLn.ok checks already require a real usable channel —
    // so a disconnected shared hub must not force a funded own channel back to on-chain.
    const ln = lnDeployed();
    // HONEST gating: a leg may sit on 'ln' ONLY when THAT asset (or BTC) has a real,
    // usable channel with the liquidity the leg's direction needs — never merely
    // "LSP configured". Any 'ln' leg without a channel is downgraded to 'chain' here,
    // so a stale rail state can never silently route into a dead LN path.
    const ra = ln ? railAvail(pay, receive) : null;
    // Rail-agnostic (Stage 3): HONOR a chosen LN pay-leg even without a channel yet — review opens +
    // funds it inline on Place-order (reviewMixed/reviewLn provisioning), so "pay from Lightning" is a
    // preference, not gated on pre-existing liquidity. (No longer downgraded to 'chain' on !payLn.ok.)
    // Pay-over-LN: a BTC pay-leg (a BUY) is funded inline on Place-order, so honor it unconditionally.
    // Paying the ASSET over LN (a sub-asset SELL) instead LIFTS a resting sub-asset sell offer — there
    // is no inline funding — so honor it only when such an offer exists (sellCapable) or the user has a
    // real pay channel; otherwise degrade to the on-chain cross rail (which supports POSTING). Without
    // this, an LN best-bid the auto-select picked but that has no takeable sub-asset offer (source
    // mismatch, or the fire-and-forget sub-asset book not yet loaded) strands the user: requoteMixed
    // disables Review and a mixed route isn't postable, so BOTH Review and Post are off.
    const paySellServiceable = payIsBtc || (ra && ra.payLn.ok) || sellCapable(seqAsset);
    const p = (ln && S.payRail === 'ln' && paySellServiceable) ? 'ln' : 'chain';
    // Receiving over LN normally needs a real inbound channel on that asset — EXCEPT the
    // sub-asset BUY (pay BTC on-chain, receive the asset over LN). There the LSP JIT-provisions
    // the user's inbound asset liquidity as part of the buy (provisionInbound), so recv=ln is
    // honoured with no pre-existing channel; every OTHER 'ln' recv leg still needs ra.recvLn.ok.
    const subAssetBuyRecvLn = ln && payIsBtc && S.payRail === 'chain'
      && S.recvRail === 'ln' && subassetCapable(receive);
    const r = (ln && S.recvRail === 'ln' && (ra.recvLn.ok || subAssetBuyRecvLn)) ? 'ln' : 'chain';
    // ln + ln -> the proven pure-LN LSP route (non-custodial, keys on device).
    // Offered only when BOTH legs have a real usable channel.
    if (p === 'ln' && r === 'ln')
      return { kind: 'ln', seqAsset, payIsBtc, xm, payRail: p, recvRail: r };
    // chain + chain -> the proven on-chain cross-chain HTLC order book. ANY
    // BTC<->asset pair is routable (the book may be empty; a maker posts one).
    if (p === 'chain' && r === 'chain')
      return { kind: 'cross', seqAsset, xm, payIsBtc, payRail: p, recvRail: r };
    // MIXED (one leg LN, one on-chain): a submarine swap. reviewMixed dispatches to
    // the LSP's POST /swap (payRail/recvRail) -> seqob-cli xsubbuy/xsublift. The one
    // deployed shape is asset-on-chain <-> BTC-Lightning; the mirror combo fails
    // closed there with an honest message.
    return { kind: 'mixed', seqAsset, xm, payIsBtc, payRail: p, recvRail: r };
  }
  // Same-chain order book: ANY two distinct Sequentia assets form a market. It may
  // have no resting offers yet, in which case the user can start it by posting one.
  return { kind: 'same', pay, receive };
}
function lnAvailable(){ return !!(L && L.available && L.available()); }
// LN is DEPLOYED (LSP + node config present) but the SHARED hub isn't necessarily connected. The
// sub-asset rails use the user's OWN node, so they gate on this, not lnAvailable() (see the bridge).
function lnDeployed(){ return !!(L && L.deployed ? L.deployed() : (L && L.available && L.available())); }

// The composer deliberately opens with NO pair preselected — both sides sit on
// "Select asset" so no asset (least of all SEQ) is implied as a default. Here we
// only VALIDATE the current state (e.g. after markets reload) and drop stale picks.
function ensureDefaults(){
  const startable = startableAssets();
  if (S.payAsset && !startable.includes(S.payAsset)) S.payAsset = null;
  if (S.receiveAsset && (S.receiveAsset === S.payAsset ||
      (S.payAsset && !counterpartsOf(S.payAsset).includes(S.receiveAsset)))){
    S.receiveAsset = null;
  }
  // No hardcoded fee asset: defaultFeeAsset() (chosen lazily at quote time) prefers
  // the asset you're already paying with. Drop a stale/unaccepted fee pick.
  if (S.feeAsset && !acceptedFee(S.feeAsset)) S.feeAsset = null;
}

// ---------------------------------------------------------------------------
// pane painting
// ---------------------------------------------------------------------------
function tk(hex){ return hex ? C.assetMeta(hex).ticker : 'Select'; }
// Precision/ticker for BTC, the one parent-chain asset, so it formats like any other.
function metaOf(hex){ return hex === 'BTC' ? { ticker: 'BTC', precision: 8 } : C.assetMeta(hex); }
function balAtoms(hex){
  if (!hex) return 0n;
  if (hex === 'BTC') return big(C.btcBalance || 0);   // parent-chain balance, shown like any other
  const b = C.balObj(); return big(b[hex] || 0);
}
function balStr(hex){
  if (!hex) return '';
  const m = metaOf(hex);
  const onchain = balAtoms(hex), instant = instantAtomsFor(hex);
  let s = 'Balance ' + C.fmtAtoms(onchain, m.precision) + ' ' + m.ticker + ' on-chain';
  if (instant > 0n) s += ' · ' + C.fmtAtoms(instant, m.precision) + ' Lightning';
  return s;
}

// --- instant (in-channel / Lightning) balances, best-effort from the LSP /status ---
function atomsOf(x){
  if (x == null) return 0n;
  if (typeof x === 'bigint') return x;
  try { return BigInt(x); } catch { return BigInt(Math.trunc(Number(x) || 0)); }
}
function instantAtomsFor(hex){
  const t = metaOf(hex).ticker;
  const e = INSTANT[t];
  return e ? atomsOf(e.spendable) : 0n;
}
// Refresh the instant/on-chain split from the LSP /status. Best-effort: if LN is
// unconfigured, the call fails, or the shape is unknown, instant stays 0 and nothing
// breaks (the wallet's known on-chain figure is always shown).
// TODO(instant-balance units): the LSP's *_units fields are treated as the asset's
// atoms here; confirm the unit convention when the LSP /status contract firms up.
async function refreshInstant(){
  INSTANT = {};
  LNSTATUS = { channels: [], funding: null };
  LNPROV = (L && L.provisioned) ? (L.provisioned() || {}) : {};
  // Read /status whenever we CAN (L.status exists) — NOT gated on L.available(). available() means
  // "the shared rail's BTC+asset hub nodes are both serving", but the wallet's OWN provisioned
  // channels are real regardless; gating on it left INSTANT empty (composer "0 Lightning") whenever
  // a shared leg wasn't up, which also broke the pay-from-Lightning amount check for own channels.
  if (!(L && L.status)) return;
  try {
    const st = await L.status();
    const chans = (st && (st.channels || st.channel_balances)) || [];
    LNSTATUS = { channels: chans, funding: (st && st.funding) || null };   // ground truth for rail gating
    try { console.log('[dbg-btc]', JSON.stringify((chans||[]).map(c=>({leg:c.leg,state:c.state,node_key:!!c.node_key,asset_label:c.asset_label,asset:c.asset,spend:c.spendable_units,recv:c.receivable_units})))); } catch(e){} // TEMP
    for (const c of chans){
      if (!c.node_key) continue;   // ONLY the wallet's own channels count as its Lightning balance
                                   // (never shared/demo) — consistent with the Balance tab + railAvail
      // Key by the RESOLVED ticker (what instantAtomsFor looks up), not the raw channel label: the
      // LSP labels a channel with a TRUNCATED hex when it can't resolve the asset's ticker (e.g.
      // "2a515539…" for USDX), so keying by asset_label put the balance under a key nothing reads,
      // and the composer showed "0 Lightning" for a funded channel. Resolve the full asset hex →
      // metaOf().ticker to match, exactly like the Balance card matches on c.asset.
      const isBtc = (c.leg === 'btc' || c.asset_label === 'BTC');
      let t;
      if (isBtc) t = 'BTC';
      else {
        const hex = (typeof c.asset === 'string' && /^[0-9a-f]{64}$/i.test(c.asset)) ? c.asset.toLowerCase() : null;
        t = hex ? metaOf(hex).ticker : (c.asset_label || c.asset || c.ticker);
      }
      if (!t) continue;
      INSTANT[t] = {
        spendable: (c.spendable_units ?? c.spendable ?? 0),
        receivable: (c.receivable_units ?? c.receivable ?? 0),
      };
    }
  } catch { INSTANT = {}; LNSTATUS = { channels: [], funding: null }; }
  try { renderChips(); paintPanes(); } catch {}
}

// --- per-asset Lightning-rail gating (ln-rail.js) ---------------------------------
// The composer's leg descriptor for the gating helpers: 'BTC' for the parent leg, else
// { hex, ticker } so a channel can be matched by asset id OR its ticker label.
function railTarget(hexOrBtc){ return hexOrBtc === 'BTC' ? 'BTC' : { hex: hexOrBtc, ticker: metaOf(hexOrBtc).ticker }; }
// The live per-leg LN verdict for the current pay/receive legs (real channel liquidity,
// direction-aware). Safe to call any time; reads the last /status snapshot synchronously.
function railAvail(payHex, receiveHex){
  return railAvailability({
    channels: LNSTATUS.channels || [], provisioned: LNPROV,
    payTarget: railTarget(payHex), recvTarget: railTarget(receiveHex),
  });
}

// --- balance chips: per-asset Lightning vs on-chain split ---
function iconClass(hex){ return hex === 'BTC' ? 'btc' : (hex === C.POLICY_HEX ? 'seq' : 'asset'); }
function iconGlyph(hex, m){
  if (hex === 'BTC') return '₿';
  return (m.ticker || '?').slice(0, 1).toUpperCase();
}
function chipHtml(hex){
  const m = metaOf(hex);
  const onchain = balAtoms(hex), instant = instantAtomsFor(hex);
  const total = onchain + instant;
  return `<button type="button" class="swchip" data-h="${esc(hex)}">
    <span class="swchip-ic ${iconClass(hex)}">${esc(iconGlyph(hex, m))}</span>
    <span class="swchip-body">
      <span class="swchip-amt mono">${esc(C.fmtAtoms(total, m.precision))} ${esc(m.ticker)}</span>
      <span class="swchip-split"><span class="z">${esc(C.fmtAtoms(instant, m.precision))} Lightning</span> · ${esc(C.fmtAtoms(onchain, m.precision))} on-chain</span>
    </span></button>`;
}
function renderChips(){
  const host = C.$('swChips'); if (!host) return;
  const bal = C.balObj() || {};
  const held = Object.keys(bal).filter(h => big(bal[h]) > 0n && h !== 'BTC');
  // BTC is first-class (dual-chain) — always a chip, even at 0.
  const list = []; const seen = new Set();
  for (const h of ['BTC', ...held]){ if (!seen.has(h)){ seen.add(h); list.push(h); } }
  host.innerHTML = list.map(chipHtml).join('');
  host.querySelectorAll('.swchip[data-h]').forEach(c => c.onclick = () => onChipPick(c.dataset.h));
}
// Clicking a chip sets it as the PAY side (a quick way to start a trade from a holding).
function onChipPick(hex){
  if (!hex || hex === S.payAsset) return;
  S.payAsset = hex;
  if (S.receiveAsset && (S.receiveAsset === hex || !counterpartsOf(hex).includes(S.receiveAsset))) S.receiveAsset = null;
  S.railsTouched = false; S.modeTouched = false;
  LAST_QUOTE = null; setReviewEnabled(false);
  paintPanes(); requote().catch(()=>{});
}

// --- pair bar: the selected market + last price (derived from the book mid) ---
function renderPairBar(){
  const host = C.$('swPairBar'); if (!host) return;
  if (!S.payAsset || !S.receiveAsset){ host.innerHTML = ''; host.classList.add('hide'); return; }
  host.classList.remove('hide');
  const pm = metaOf(S.payAsset), rm = metaOf(S.receiveAsset);
  let lastStr = '—';
  if (LAST_MID && LAST_MID.price != null && isFinite(LAST_MID.price) && LAST_MID.price > 0){
    lastStr = LAST_MID.cross
      ? `${trim(LAST_MID.price)} BTC/${rm.ticker}`
      : `${trim(LAST_MID.price)} ${pm.ticker}/${rm.ticker}`;
  }
  host.innerHTML = `<div class="swpairsel">${esc(rm.ticker)} <span class="swpair-car">/</span> ${esc(pm.ticker)}</div>
    <div class="swpair-last">last <b class="mono">${esc(lastStr)}</b></div>`;
}
// The reference value of ONE unit of an asset (for the ladder's mid line).
function oneUnitRefStr(hex){
  const m = metaOf(hex); const one = 10n ** BigInt(m.precision || 0);
  return C.refValueStr(hex, one) || '';
}

function paintPanes(){
  const { $ } = C;
  $('swPayTk').textContent  = tk(S.payAsset);
  $('swRecvTk').textContent = tk(S.receiveAsset);
  $('swPayBal').textContent  = balStr(S.payAsset);
  $('swRecvBal').textContent = balStr(S.receiveAsset);
  // Max only makes sense for an owned Sequentia asset on the pay side.
  $('swMax').style.display = (S.payAsset && S.payAsset !== 'BTC' && balAtoms(S.payAsset) > 0n) ? '' : 'none';
  paintRefHints();
  paintRouteLine();
  updateRails();
  paintModeSeg();
  paintBookSeg();
  paintConfControl();
  const cta = $('swReview'); if (cta) cta.textContent = 'Place order';   // one CTA, always
}

// The opt-in confidential-RECEIVE control (transparent book only) is meaningless when
// the received leg is BTC — the parent chain has no confidential transactions — so it
// is HIDDEN whenever S.receiveAsset === 'BTC'. It is also hidden on the Blinded book,
// where both legs already blind by construction (a per-swap opt-in would be redundant).
function paintConfControl(){
  const wrap = C.$('swConfWrap'); if (!wrap) return;
  const hide = S.receiveAsset === 'BTC' || isConfBook();
  wrap.style.display = hide ? 'none' : 'flex';
}

// --- Unblinded / Blinded book toggle -------------------------------------------
function wireBookSeg(){
  const seg = C.$('swBookSeg'); if (!seg || seg._wired) return; seg._wired = true;
  seg.querySelectorAll('button[data-book]').forEach(b => b.onclick = () => setBook(b.dataset.book));
}
function paintBookSeg(){
  const seg = C.$('swBookSeg'); if (!seg) return;
  seg.querySelectorAll('button[data-book]').forEach(b => b.classList.toggle('on', b.dataset.book === _book));
  const note = C.$('swBookNote');
  if (note) note.textContent = isConfBook()
    ? 'Blinded book: both legs settle confidentially (amounts and assets hidden on-chain). Sequentia assets only.'
    : 'Unblinded book: transparent settlement, the default. Bitcoin (cross-chain) pairs trade here.';
}
// Switch the active book namespace. Distinct order sets: the desk reloads from the
// selected namespace and posts into it. Blinded is Sequentia-only, so a BTC pick is
// dropped on the way in.
function setBook(next){
  next = next === 'confidential' ? 'confidential' : 'public';
  if (next === _book){ paintBookSeg(); return; }
  _book = next; persistBook();
  if (isConfBook()){
    if (S.payAsset === 'BTC') S.payAsset = null;
    if (S.receiveAsset === 'BTC') S.receiveAsset = null;
  }
  // Fresh namespace: drop the stale book/quote and re-derive defaults + pickers.
  BOOK = { offers: [], pair: null };
  LAST_QUOTE = null; setReviewEnabled(false);
  S.railsTouched = false; S.modeTouched = false;
  ensureDefaults();
  paintPanes();
  requote().catch(()=>{});
}

// ---------------------------------------------------------------------------
// Take / Post (lift the book vs. rest a limit order at your own price)
// ---------------------------------------------------------------------------
// A route can be POSTED only when the wallet already has an offer-post path for it:
// same-chain (postOfferReview -> seqob.signOffer/postOffer) and cross-chain
// (postCrossOfferReview -> X.makerStart/makerStartReverse). LN + mixed rails are
// taker-only (LP fixed terms / submarine), so they stay in Take.
function postSupported(route){ return !!route && (route.kind === 'same' || route.kind === 'cross'); }
// After the book is known, pick the default mode for a fresh pair: Post when there is
// nothing resting to lift (start the market), Take when there is. Once the user picks a
// mode (modeTouched) we stop overriding it. Unsupported routes are forced to Take.
function applyAutoMode(bookLen, route){
  // Default MARKET (S.mode='take') always: type one amount, the other auto-fills at the best
  // executable price. The user can switch to LIMIT (S.mode='post') to set their own price
  // (independent fields). Unsupported routes are forced to take. (bookLen kept for callers.)
  if (!postSupported(route)) S.mode = 'take';
  else if (!S.modeTouched) S.mode = 'take';
  paintModeSeg();
}
function wireModeSeg(){
  const seg = C.$('swModeSeg'); if (!seg || seg._wired) return; seg._wired = true;
  seg.querySelectorAll('button[data-m]').forEach(b => b.onclick = () => { if (!b.disabled) setMode(b.dataset.m); });
}
// The visible Take vs Post distinction is DELETED (project directive): every order
// is just "Place order", and whether it lifts the book, rests a covenant, or posts
// a cross offer is a backend decision. The segmented control stays hidden; the
// internal S.mode is still used by the cross-chain route to pick take-vs-post
// automatically (never surfaced). The CTA label is fixed to "Place order" in
// paintPanes. paintModeSeg is now just the internal auto-mode reconciler.
function paintModeSeg(){
  if (!C) return;
  const wrap = C.$('swModeWrap'), seg = C.$('swModeSeg');
  const route = findRoute(S.payAsset, S.receiveAsset);
  if (!postSupported(route)) S.mode = 'take';
  // Market/Limit is only meaningful where a limit order can rest (same-chain + cross); LN/mixed are
  // market-only, so the toggle hides there. Shows once a limit-capable pair is chosen.
  const show = !!(S.payAsset && S.receiveAsset && postSupported(route));
  if (wrap) wrap.classList.toggle('hide', !show);
  if (seg) seg.querySelectorAll('button[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
}
// Switch mode by hand (marks it touched so the auto-default stops). Take re-links the
// fields (requote re-derives the opposite); Post leaves both fields independent.
function setMode(m){
  if (m !== 'take' && m !== 'post') return;
  S.mode = m; S.modeTouched = true;
  LAST_QUOTE = null; setReviewEnabled(false);
  paintModeSeg();
  requote().catch(()=>{});
}

// Show BOTH rail choosers (Pay from / Receive to) only for a BTC<->asset pair when
// the on-device signer is live; otherwise hide them and force both legs on-chain so
// an LN-unconfigured wallet behaves exactly as before.
function updateRails(){
  const box = C.$('swRailPicks'); if (!box) return;
  const pay = S.payAsset, receive = S.receiveAsset;
  const btcPair = pay && receive && pay !== receive
    && ((pay === 'BTC') !== (receive === 'BTC'));   // exactly one side is BTC
  if (btcPair && lnDeployed()){
    box.classList.remove('hide');
    // Probe the sub-asset order book for this pair's asset (async, cached) so the sub-asset
    // BUY/SELL rails light from LIVE liquidity, not a hardcoded list. When it lands it may
    // re-run updateRails to reflect a flipped availability.
    try { refreshSubassetBook(pay === 'BTC' ? receive : pay); } catch {}
    // HONEST per-asset gating: a leg may sit on Lightning ONLY when THAT asset (or BTC)
    // has a real, usable channel with the liquidity the leg's direction needs. There is
    // no silent submarine-funding of a cold channel — a leg with no channel defaults to
    // (and is pinned to) on-chain, and the LN button is disabled with a Move-to-Lightning
    // explanation. This kills the old "LSP configured => flash the LN rail" bug.
    const ra = railAvail(pay, receive);
    if (!S.railsTouched){
      // Auto-default: Lightning when a usable channel already exists, else on-chain (never auto-pick
      // a rail that would need provisioning — the user opts into that by choosing Lightning).
      S.payRail  = ra.payLn.ok  ? 'ln' : 'chain';
      S.recvRail = ra.recvLn.ok ? 'ln' : 'chain';
    }
    // If the user chose Lightning for a leg with no channel yet, KEEP it — the channel is opened
    // inline on Place-order (reviewLn). We no longer force it back to on-chain. (The unsupported
    // mixed shape is still corrected below via railSupported.)
    // Never sit on the undeployed mixed shape (asset over LN + BTC on-chain): if the
    // channel-reconciled combo is unsupported, fall all the way back to the proven
    // on-chain cross route (both legs on-chain), which is always available.
    if (!railSupported(S.payRail, S.recvRail)){ S.payRail = 'chain'; S.recvRail = 'chain'; }
    paintRailSegs(ra);
    renderRailNote(ra);
  } else {
    box.classList.add('hide');
    renderRailNote(null);
    S.payRail = 'chain'; S.recvRail = 'chain'; S.railsTouched = false;
  }
}
// An honest inline note under the rail choosers when the Lightning option is NOT
// offerable for a leg (no channel / wrong-side liquidity): says why + links to
// Move-to-Lightning. Cleared when both legs' LN options are live (or LN is off).
function renderRailNote(ra){
  const note = C.$('swRailNote'); if (!note) return;
  // Only nag about a missing/insufficient Lightning channel for a leg the user is ACTUALLY
  // routing over Lightning. A leg switched back to on-chain needs no channel, so its note
  // must clear (this is the fix for the note persisting after flipping a leg to on-chain).
  const payBad  = ra && S.payRail  === 'ln' && !ra.payLn.ok  ? ra.payLn  : null;
  const recvBad = ra && S.recvRail === 'ln' && !ra.recvLn.ok ? ra.recvLn : null;
  const bad = payBad || recvBad;   // surface the first LN-selected leg that isn't LN-ready
  if (!bad){ note.innerHTML = ''; note.classList.add('hide'); return; }
  note.classList.remove('hide');
  if (bad.cta === 'move'){
    // No channel yet is NOT a blocker any more — a channel is opened for you INLINE when you place
    // the order. Say so honestly; offer an optional "set it up now" shortcut to the Balance tab.
    note.innerHTML = `<span>No Lightning channel for this leg yet — one is opened for you when you place the order (this can take a couple of minutes).</span>`
      + ` <button type="button" class="swfix" id="swRailMove">Set it up now</button>`;
  } else {
    // Channel exists but this side lacks liquidity (cta 'add') — the honest add-liquidity note stays.
    note.innerHTML = `<span>${esc(bad.reason)} ${esc(bad.hint || '')}</span>`
      + ` <button type="button" class="swfix" id="swRailMove">${esc(bad.ctaLabel || 'Add liquidity')}</button>`;
  }
  const b = C.$('swRailMove');
  if (b) b.onclick = () => { if (C.gotoLightning) C.gotoLightning(); else try { C.toast('Open a Lightning channel from the Balance tab.'); } catch {} };
}
// DYNAMIC sub-asset rail availability from the order book (L.book) — NO hardcoded maker
// list. The sub-asset relays are a permissionless signed-intent book, so a rail is offered
// only when REAL resting counterparty liquidity exists, for ANY asset (a deployed maker is
// just seed liquidity, one offer among many). `buy_available` = someone rests an offer
// paying the asset over LN (a BTC-on-chain BUYER can take it → the sub-asset BUY rail);
// `sell_available` = someone rests an offer locking BTC on-chain (an asset-over-LN SELLER
// can take it → the sub-asset SELL rail). Populated by refreshSubassetBook(); railSupported
// reads it synchronously, so the toggle lights once the async probe lands.
const SUBASSET_BOOK = {};   // assetHexLower -> { sell_available, buy_available, sell_offers, buy_offers, ts }
function subassetCapable(seqAssetHex){ const e = seqAssetHex && SUBASSET_BOOK[seqAssetHex.toLowerCase()]; return !!(e && e.buy_available); }
function sellCapable(seqAssetHex){ const e = seqAssetHex && SUBASSET_BOOK[seqAssetHex.toLowerCase()]; return !!(e && e.sell_available); }
function subassetOffers(seqAssetHex, dir){ const e = seqAssetHex && SUBASSET_BOOK[seqAssetHex.toLowerCase()]; return (e && (dir === 'sell' ? e.sell_offers : e.buy_offers)) || []; }
let _bookInflight = {};
async function refreshSubassetBook(seqAssetHex){
  if (!seqAssetHex || seqAssetHex === 'BTC' || !(L && L.book && lnDeployed())) return;
  const k = seqAssetHex.toLowerCase();
  const prev = SUBASSET_BOOK[k];
  if (prev && (Date.now() - prev.ts) < 15000) return;   // ~15s cache
  if (_bookInflight[k]) return; _bookInflight[k] = true;
  try {
    const b = await L.book(seqAssetHex);
    const wasSell = !!(prev && prev.sell_available), wasBuy = !!(prev && prev.buy_available);
    SUBASSET_BOOK[k] = { sell_available: !!b.sell_available, buy_available: !!b.buy_available,
      sell_offers: b.sell_offers || [], buy_offers: b.buy_offers || [], ts: Date.now() };
    // If availability flipped, re-gate + repaint the rails so the toggle tracks live liquidity.
    if (wasSell !== !!b.sell_available || wasBuy !== !!b.buy_available){ try { updateRails(); } catch {} }
  } catch { SUBASSET_BOOK[k] = { sell_available:false, buy_available:false, sell_offers:[], buy_offers:[], ts: Date.now() }; }
  finally { _bookInflight[k] = false; }
}

// Is (payRail, recvRail) a rail combination with a backend for the current pair? Both
// legs the same (pure-LN or fully on-chain) always work. Two mixed shapes exist:
//   - asset-on-chain <-> BTC-Lightning (the submarine) — always available; and
//   - asset-over-Lightning + BTC-on-chain (the sub-asset MIRROR) — a BUY only, and only
//     for a pair that actually has a sub-asset maker (subassetCapable), else it fails
//     closed at the LSP, so it must not be selectable.
function railSupported(p, r){
  // Rail-agnostic matching (Stage 3): a rail is a SETTLEMENT PREFERENCE, not a matching gate.
  // Any mixed combo is selectable whenever Lightning is deployed; the settlement router decides
  // the settlement + bridges on Place-order, and fails closed CLEANLY (refundable) if a leg can't
  // be honored. We no longer pre-block on a live maker (subassetCapable/sellCapable) — the unified
  // book already shows the liquidity, and gating the rail on it re-introduced the very
  // rail distinction the merged book erases. (p === r is always fine: pure-LN / pure-on-chain.)
  return (p === r) || lnDeployed();
}
function wireRailSeg(id, leg){
  const seg = C.$(id); if (!seg || seg._wired) return; seg._wired = true;
  // Guard on b.disabled at click time so a greyed (unsupported) combo can't be picked.
  seg.querySelectorAll('button[data-r]').forEach(b => b.onclick = () => { if (!b.disabled) setRail(leg, b.dataset.r); });
}
function paintRailSegs(ra){
  ra = ra || railAvail(S.payAsset, S.receiveAsset);
  const badTip = 'Coming soon — this asset-over-Lightning with BTC on-chain shape has no maker yet. '
    + 'Keep the asset on-chain and BTC on Lightning, or set both legs the same way.';
  const paint = (id, leg) => { const seg = C.$(id); if (!seg) return;
    const cur = leg === 'pay' ? S.payRail : S.recvRail;
    const legLn = leg === 'pay' ? ra.payLn : ra.recvLn;   // real per-asset LN verdict for this leg
    seg.querySelectorAll('button[data-r]').forEach(b => {
      const r = b.dataset.r;
      b.classList.toggle('on', r === cur);
      // The Lightning button is now SELECTABLE even without a channel: if the leg has no channel yet,
      // one is opened for you INLINE on Place-order (see reviewLn / renderRailNote). Only the
      // undeployed mixed shape (asset over LN + BTC on-chain) stays disabled. A no-channel LN pick
      // gets an informative title (not disabled). On-chain is always available.
      let bad = false, tip = '';
      const p2 = leg === 'pay' ? r : S.payRail;
      const r2 = leg === 'pay' ? S.recvRail : r;
      if (r !== 'chain' && !railSupported(p2, r2)){ bad = true;
        // Distinguish "no maker for this shape at all" from "a sub-asset maker exists but
        // you have no inbound Lightning liquidity to receive the asset" — the latter is the
        // sub-asset buy case, and saying "no maker" there would be wrong.
        const subAssetNoInbound = leg === 'recv' && S.payAsset === 'BTC' && p2 === 'chain'
          && subassetCapable(S.receiveAsset);
        tip = subAssetNoInbound
          ? `Receiving ${C.assetMeta(S.receiveAsset).ticker} over Lightning needs inbound Lightning liquidity for it (coming soon). For now, receive it on-chain.`
          : badTip;
      }
      else if (r === 'ln' && !legLn.ok){ tip = legLn.cta === 'add'
        ? (legLn.reason + (legLn.hint ? ' ' + legLn.hint : ''))
        : 'No channel yet — one is opened for you when you place the order.'; }
      b.disabled = bad;
      if (tip) b.title = tip; else b.removeAttribute('title');   // informative title even when selectable
    }); };
  paint('swPayRailSeg', 'pay');
  paint('swRecvRailSeg', 'recv');
}
// Set ONE leg's rail (leg = 'pay' | 'recv'); marks the rails as user-chosen so the
// auto-default stops overriding them. Changing rails can change the route kind, so the
// Take/Post default is re-armed too.
function setRail(leg, r){
  const cur = leg === 'pay' ? S.payRail : S.recvRail;
  if (cur === r) return;
  if (leg === 'pay') S.payRail = r; else S.recvRail = r;
  S.railsTouched = true; S.modeTouched = false;
  LAST_QUOTE = null; setReviewEnabled(false);
  const ra = railAvail(S.payAsset, S.receiveAsset);
  paintRailSegs(ra);
  try { renderRailNote(ra); } catch {}   // refresh/clear the LN-channel note for the newly-selected rail
  try { renderFeePicker(); } catch {}   // reflect the pay-from-Lightning fee freeze immediately
  requote().catch(()=>{});
}
function paintRefHints(){
  // Re-value the "≈ <ref>" hints against the current asset + typed amount. The
  // updaters read S.payAsset/S.receiveAsset live through their assetFn closures,
  // so calling them directly (not via a synthetic 'input') refreshes the hint
  // without re-arming the edited-side requote logic.
  try { _payHint && _payHint(); } catch {}
  try { _recvHint && _recvHint(); } catch {}
}

// The route line: rate ("1 tSEQ = 0.38 USDX · SeqDEX maker") + route label.
function paintRouteLine(){
  const { $ } = C;
  const route = findRoute(S.payAsset, S.receiveAsset);
  if (!S.payAsset || !S.receiveAsset){
    if (S.payAsset && !S.receiveAsset){
      const cps = counterpartsOf(S.payAsset);
      $('swRate').textContent = cps.length
        ? 'Choose what to receive.'
        : 'No markets trade against ' + tk(S.payAsset) + ' yet.';
    } else {
      $('swRate').textContent = 'Pick two assets to see a rate.';
    }
    $('swRoute').textContent = ''; return;
  }
  if (!route){
    $('swRate').textContent = 'No market between ' + tk(S.payAsset) + ' and ' + tk(S.receiveAsset) + '.';
    $('swRoute').textContent = '';
    return;
  }
  $('swRoute').textContent =
      route.kind === 'mixed' ? 'Mixed rails · Lightning + on-chain'
    : route.kind === 'cross' ? (route.payIsBtc ? 'Cross-chain · buy with BTC' : 'Cross-chain · sell for BTC')
    : route.kind === 'ln'    ? (route.payIsBtc ? 'Lightning · buy with BTC' : 'Lightning · sell for BTC')
    : 'Same-chain · order book';
  // The rate line is filled by the quote (showQuote / showXRate); a placeholder until then.
  if (!LAST_QUOTE) $('swRate').textContent = '1 ' + tk(S.payAsset) + ' = … ' + tk(S.receiveAsset);
}

// ---------------------------------------------------------------------------
// flip + max
// ---------------------------------------------------------------------------
function onFlip(){
  const f = C.$('swFlip');
  f.classList.toggle('spun');
  // Swap assets AND amounts; keep the user's intent by flipping which side was edited.
  [S.payAsset, S.receiveAsset] = [S.receiveAsset, S.payAsset];
  const pa = C.$('swPayAmt'), ra = C.$('swRecvAmt');
  [pa.value, ra.value] = [ra.value, pa.value];
  [pa._userTyped, ra._userTyped] = [ra._userTyped, pa._userTyped];   // keep the anti-clobber flags with their values
  S.edited = S.edited === 'pay' ? 'receive' : 'pay';
  S.modeTouched = false;   // re-arm the Take/Post default for the flipped pair
  LAST_QUOTE = null; setReviewEnabled(false);
  paintPanes();
  requote().catch(()=>{});
}
function onMax(){
  if (!S.payAsset || S.payAsset === 'BTC') return;
  const m = C.assetMeta(S.payAsset);
  C.$('swPayAmt').value = C.fmtAtoms(balAtoms(S.payAsset), m.precision);
  C.$('swPayAmt')._userTyped = true;   // Max is an explicit user amount
  // exit ⇄ ref-input mode if active so the literal asset amount is used
  if (C.$('swPayAmt')._refMode) C.$('swPayAmt')._refMode = false;
  S.edited = 'pay'; LAST_QUOTE = null; setReviewEnabled(false);
  paintRefHints();
  requote().catch(()=>{});
}

// ---------------------------------------------------------------------------
// quoting — fills the opposite amount + the rate/fee lines
// ---------------------------------------------------------------------------
// The amount actually typed (honouring the shared ⇄ ref-input mode), as a string.
function typedAmount(side){
  const input = side === 'pay' ? C.$('swPayAmt') : C.$('swRecvAmt');
  const hex = side === 'pay' ? S.payAsset : S.receiveAsset;
  return C.assetAmountOf ? C.assetAmountOf(input, hex) : (input.value || '').trim();
}

async function requote(){
  const { $ } = C;
  $('swErr').textContent = '';
  LAST_MID = null;
  paintRouteLine();
  // Rail-blind take (Stage 3): default the rails to the BEST-PRICE offer's rail across ALL rails,
  // so a market take gets the best price whichever rail carries it — the taker matches on price, not
  // rail. The user's explicit rail choice (railsTouched) always wins; then the rail is a settlement
  // preference and the LSP bridges the difference. Only for a BTC<->asset pair (the one with a rail
  // choice); the on-chain offer -> both legs on-chain (cross), an LN offer -> the ASSET leg over LN
  // (recv for a buy, pay for a sell) + BTC on-chain (sub-asset). Cached, so it costs no extra fetch.
  const oneBtc = (S.payAsset === 'BTC') !== (S.receiveAsset === 'BTC');
  if (oneBtc && !S.railsTouched && S.payAsset && S.receiveAsset){
    const seqAsset = S.payAsset === 'BTC' ? S.receiveAsset : S.payAsset;
    const side = S.payAsset === 'BTC' ? 'buy' : 'sell';
    try {
      const ub = await getUnifiedBook(seqAsset);
      const best = ub && (side === 'buy' ? (ub.best_ask || (ub.asks || [])[0]) : (ub.best_bid || (ub.bids || [])[0]));
      if (best && best.rail){
        if (best.rail === 'onchain'){ S.payRail = 'chain'; S.recvRail = 'chain'; }
        else if (side === 'buy'){ S.payRail = 'chain'; S.recvRail = 'ln'; }
        // Sell over LN only if a sub-asset sell offer is actually takeable; else keep the pay leg on
        // chain (postable cross rail) so the LN best-bid doesn't strand the user. Upgrades to LN on a
        // later requote once the sub-asset book loads.
        else                    { S.payRail = sellCapable(seqAsset) ? 'ln' : 'chain'; S.recvRail = 'chain'; }
        try { paintRailSegs(); } catch {}
      }
    } catch {}
  }
  const route = findRoute(S.payAsset, S.receiveAsset);
  renderTiming(route);   // timing banner reflects the rails immediately, before amounts
  // LN / mixed / no-route are take-only; keep the mode control honest before we quote.
  if (!postSupported(route)) S.mode = 'take';
  paintModeSeg();
  if (!route){ setReviewEnabled(false); clearOpposite(); clearBook(); return; }
  const amtStr = typedAmount(S.edited);
  // Do NOT bail on an empty amount: the quote functions fetch and RENDER the ONE
  // order book first (so it is visible the moment a pair is chosen, on EVERY rail),
  // then quote only if an amount is present.
  if (route.kind === 'ln')    return requoteLn(route, amtStr);
  if (route.kind === 'cross') return requoteCross(route, amtStr);
  if (route.kind === 'mixed') return requoteMixed(route, amtStr);
  return requoteSame(route, amtStr);
}
function clearBook(){ renderBookPlaceholder(); renderPairBar(); }
// A muted stand-in so the desk's LEFT (book) column is never a blank void before a pair
// is chosen. Replaced by the live ladder the moment a pair + book load.
function renderBookPlaceholder(){
  const host = C.$('swBook'); if (!host) return;
  host.innerHTML = `<div class="swladder"><div class="swladder-head">`
    + `<span class="sub" style="color:var(--txt);font-weight:650">Order book</span><span class="sub"></span></div>`
    + `<div class="swladder-empty">Pick two assets to see the order book.</div></div>`;
}

function clearOpposite(){
  const other = S.edited === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
  // Don't stomp a value the user is actively typing on the OTHER side.
  if (document.activeElement !== other) other.value = '';
}
function setReviewEnabled(on){ const b = C.$('swReview'); if (b) b.disabled = !on; }

// --- same-chain: the unified PLACE-ORDER path (passive-CLOB covenant) ---
// Every same-chain order is "Place order": the two amount fields are the user's own
// limit (their ratio IS the price), and Place funds a self-enforcing covenant that
// rests on-chain and fills whenever it is crossed — even while the wallet is closed.
// The book still renders on the left (any resting orders); clicking a level seeds
// the fields. There is NO take-vs-post distinction — the matcher crosses the order.
async function requoteSame(route, amtStr){
  const { $ } = C;
  const pay = route.pay, receive = route.receive;
  const status = $('swStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading the order book…';
  $('swErr').textContent = '';
  try {
    if (!S.feeAsset) S.feeAsset = defaultFeeAsset();
    // The relay keys markets by exact base/quote order, so fetch BOTH orientations. A 4xx means "no
    // such market yet" (genuinely empty); a network/5xx error means the relay is UNREACHABLE. T7:
    // never conflate the two, or an outage looks like an empty book and invites posting into the void.
    let reachErr = null;
    const bookOpts = { confidential: isConfBook() };   // read the selected namespace
    const safeBook = async (a, b) => {
      try { return await seqob.fetchBook(a, b, bookOpts); }
      catch (e){ if (/HTTP\s*4\d\d/.test(e.message||'')) return { offers: [] };   // 4xx: empty/unknown market
                 reachErr = e; return { offers: [] }; }                            // network/5xx: unreachable
    };
    const [b1, b2] = await Promise.all([ safeBook(receive, pay), safeBook(pay, receive) ]);
    const now = Math.floor(Date.now()/1000);
    const notExpired = (o) => { const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0); return !(exp && exp <= now); };
    // Offers giving `receive` want `pay` (asks, crossable by our order); the opposite side (give
    // `pay`, want `receive`) feeds the spread/mid summary and the depth display.
    const seen = new Set(), liftable = [], otherSide = [];
    for (const o of [...(b1.offers||[]), ...(b2.offers||[])]){
      const id = (o.maker_pubkey||o.makerPubkey)+':'+(o.offer_id||o.offerId);
      if (seen.has(id)) continue; seen.add(id);
      if (o._verified === false) continue;                       // untrusted relay: skip forged rows
      if (!notExpired(o)) continue;
      const oa = o.offer_asset||o.offerAsset, wa = o.want_asset||o.wantAsset;
      if (oa === receive && wa === pay) liftable.push(o);
      else if (oa === pay && wa === receive) otherSide.push(o);
    }
    liftable.sort((a,bb)=> ratioRecvPerPay(bb) - ratioRecvPerPay(a));  // best price first
    BOOK = { pair:{ base_asset: receive, quote_asset: pay }, offers: liftable, otherOffers: otherSide };
    renderBook(pay, receive);

    // T7: relay unreachable AND nothing to show — say so and let the user retry.
    if (reachErr && !liftable.length){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Order book unreachable - retry.';
      $('swRoute').textContent = '';
      $('swErr').textContent = 'Could not reach the order-book relay (' + (reachErr.message || reachErr) + '). Check your connection and press Refresh.';
      return;
    }
    status.textContent = '';

    // MARKET (default): fill the empty side from the book's best EXECUTABLE price, WITHOUT wiping
    // user input. LIMIT (S.mode==='post'): the two fields are independent — the user sets their own
    // price, so we never auto-derive. (Empty market: best is null -> no derivation either way.)
    const best = bestReceivePerPay(liftable, pay, receive);
    if (S.mode === 'take') applyComposeDerivation(pay, receive, best);
    paintPlaceRate(pay, receive, best, liftable.length);
    paintFee(S.feeAsset, null);
    setFinality('same');

    // Enable Place order once BOTH amounts are set and the pay leg is affordable.
    const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
    const payAtoms  = safeAtoms($('swPayAmt').value,  pm.precision || 0);
    const recvAtoms = safeAtoms($('swRecvAmt').value, rm.precision || 0);
    if (payAtoms <= 0n || recvAtoms <= 0n){ LAST_QUOTE = null; setReviewEnabled(false); return; }
    if (payAtoms > balAtoms(pay)){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swErr').textContent = `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker}.`;
      return;
    }
    if (isConfBook()){
      // The BLINDED book rides the INTERACTIVE co-sign rail (seqob.lift for a taker,
      // seqob.postOffer for a maker) — NEVER the covenant rail: a covenant FILL leaf
      // introspects EXPLICIT output amounts, which CT (Pedersen-committed amounts)
      // cannot satisfy. Lift a crossable blinded offer if one rests; otherwise rest a
      // blinded offer (both legs blind to each party's blinding pubkey).
      const editedAsset = S.edited === 'pay' ? pay : receive;
      const editedAtoms = S.edited === 'pay' ? payAtoms : recvAtoms;
      if (liftable.length){
        const q = executableQuote(liftable[0], pay, receive, editedAsset, editedAtoms);
        q.confidential = true;
        if (q.amountP > balAtoms(pay)){
          LAST_QUOTE = null; setReviewEnabled(false);
          $('swErr').textContent = `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker}.`;
          return;
        }
        LAST_QUOTE = q;
      } else {
        LAST_QUOTE = { kind:'same', startMarket:true, post:true, confidential:true, pay, receive };
      }
      setReviewEnabled(true);
      return;
    }
    LAST_QUOTE = { kind:'same', place:true, pay, receive, payAtoms, recvAtoms };
    setReviewEnabled(true);
  } catch (e){
    status.textContent = '';
    $('swErr').textContent = 'Order book: ' + (e.message || e);
    setReviewEnabled(false);
  }
}

// The rate + route lines for the place-order composer.
function paintPlaceRate(pay, receive, best, bookLen){
  const { $ } = C;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payV = numVal($('swPayAmt')), recvV = numVal($('swRecvAmt'));
  const yourPrice = (payV > 0 && recvV > 0) ? recvV / payV : 0;
  if (S.mode === 'post'){
    // LIMIT: the user's own price. Compare to the book so they know if/when it crosses.
    if (yourPrice > 0){
      let s = `Limit · 1 ${pm.ticker} = ${trim(yourPrice)} ${rm.ticker}`;
      if (best) s += yourPrice <= best ? ` — crosses now (best offer ${trim(best)})` : ` — rests until crossed (best offer ${trim(best)})`;
      $('swRate').textContent = s;
    } else {
      $('swRate').textContent = 'Limit — set both amounts; their ratio is your price.';
    }
  } else {
    // MARKET: fill at the best executable offer.
    if (yourPrice > 0 && best){
      // If the order is bigger than the resting depth at this price, it fills what's there now and
      // rests the remainder as a limit — surface that split.
      const split = marketFillSplit(safeAtoms($('swPayAmt').value, pm.precision||0), safeAtoms($('swRecvAmt').value, rm.precision||0));
      let s = `Market · 1 ${pm.ticker} = ${trim(yourPrice)} ${rm.ticker} (best offer)`;
      if (split) s += ` · fills ~${trim(Number(split.fill)/Math.pow(10, pm.precision||0))} ${pm.ticker} now, ~${trim(Number(split.rest)/Math.pow(10, pm.precision||0))} rests`;
      $('swRate').textContent = s;
    } else if (best){
      $('swRate').textContent = `Market · fills at 1 ${pm.ticker} = ${trim(best)} ${rm.ticker} — set an amount.`;
    } else {
      $('swRate').textContent = bookLen
        ? 'No crossable offers yet — set both amounts to rest an order (their ratio is your price).'
        : 'No resting orders yet — set both amounts to place the first order.';
    }
  }
  $('swRoute').textContent = bookLen ? 'Order book · place a resting order' : 'Order book · be the first';
}

// Best RECEIVE-per-PAY price from the crossable asks, in DISPLAY units.
function bestReceivePerPay(offers, pay, receive){
  const pm = metaOf(pay), rm = metaOf(receive);
  let best = 0;
  for (const o of (offers||[])){
    const recvU = Number(big(o.offer_amount||o.offerAmount)) / Math.pow(10, rm.precision||0);
    const payU  = Number(big(o.want_amount ||o.wantAmount )) / Math.pow(10, pm.precision||0);
    if (payU > 0){ const p = recvU/payU; if (p > best) best = p; }
  }
  return best || null;
}
function safeAtoms(str, prec){ try { return C.parseAtoms((str||'').trim(), prec); } catch { return 0n; } }

// PAY-atoms of resting book depth that meets the order's price right now — the amount a Market
// order can fill immediately (asks giving >= the order's receive-per-pay). Anything above this
// depth is the remainder that rests. `offers` are the crossable asks (BOOK.offers), each offering
// `offer_amount` of RECEIVE for `want_amount` of PAY. A best-effort preview; the matcher does the
// actual crossing at fill time.
function crossableDepthAtoms(offers, orderPayAtoms, orderRecvAtoms){
  const op = Number(orderPayAtoms), or = Number(orderRecvAtoms);
  const orderPrice = op > 0 ? or / op : 0;               // receive per pay the order is willing to accept
  let d = 0n;
  for (const o of (offers || [])){
    const recvU = Number(big(o.offer_amount || o.offerAmount || 0));
    const payU  = Number(big(o.want_amount  || o.wantAmount  || 0));
    if (payU <= 0) continue;
    if (recvU / payU + 1e-9 >= orderPrice) d += big(o.want_amount || o.wantAmount || 0);   // ask meets the price
  }
  return d;
}
// The Market fill/rest preview for an order of `payAtoms` against the current book: how much fills
// now vs rests as a limit. null when nothing rests (full fill) or nothing crosses (whole thing rests).
function marketFillSplit(payAtoms, recvAtoms){
  const depth = crossableDepthAtoms((BOOK && BOOK.offers) || [], payAtoms, recvAtoms);
  const pay = BigInt(payAtoms);
  const fill = depth > pay ? pay : depth;                // can't fill more than the order
  const rest = pay - fill;
  if (fill <= 0n || rest <= 0n) return null;             // full fill or no crossable liquidity -> no split to show
  return { fill, rest };
}

// POST mode (same-chain): the two amount fields are the user's OWN limit — their ratio
// IS the price. We do NOT touch either field (no book-derived fill) and route Review to
// postOfferReview (seqob.signOffer + seqob.postOffer), the proven offer-post path. The
// book (with any resting rows) still renders on the left; this rests a new order into it.
function postModeSame(pay, receive){
  const { $ } = C;
  if (!S.feeAsset) S.feeAsset = defaultFeeAsset();
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const pv = numVal($('swPayAmt')), rv = numVal($('swRecvAmt'));
  const hasBook = !!(BOOK.offers && BOOK.offers.length);
  LAST_QUOTE = { kind:'same', startMarket:true, post:true, pay, receive };
  if (pv > 0 && rv > 0){
    $('swRate').textContent = `Your price · 1 ${pm.ticker} = ${trim(rv/pv)} ${rm.ticker} — Post to rest this offer.`;
  } else {
    $('swRate').textContent = hasBook
      ? `Set both amounts — their ratio is your limit price — then Post a resting offer.`
      : `No resting offers yet — set both amounts (their ratio is your price) to post the first order.`;
  }
  $('swRoute').textContent = hasBook ? 'Order book · post a limit order' : 'Order book · be the first';
  paintFee(S.feeAsset, null);
  setFinality('same');
  setReviewEnabled(pv > 0 && rv > 0);
}

function ratioRecvPerPay(o){
  const off = Number(o.offer_amount || o.offerAmount || 0), want = Number(o.want_amount || o.wantAmount || 0);
  return want > 0 ? off/want : 0;
}
function ceilDiv(a, b){ return (a + b - 1n) / b; }

// T14: best ask/bid, mid, spread (all in PAY per 1 RECEIVE, the conventional "price of receive") and
// total takeable depth (in RECEIVE units), from the two book sides — whichever the data allows. Any
// side may be absent, in which case its figure is null. sideA = offers we can take (give RECEIVE,
// want PAY); sideB = the opposite side (give PAY, want RECEIVE).
// TODO(browser-verify): the per-row price still reads RECEIVE-per-PAY while this summary reads
// PAY-per-RECEIVE (conventional). Both are explicitly labelled; confirm they read clearly together.
function bookStats(sideA, sideB, payMeta, recvMeta){
  const toPay  = a => Number(a)/Math.pow(10, payMeta.precision||0);
  const toRecv = a => Number(a)/Math.pow(10, recvMeta.precision||0);
  let bestAsk = Infinity, bestBid = 0, depthRecv = 0;
  for (const o of (sideA||[])){
    const off = toRecv(big(o.offer_amount||o.offerAmount)), want = toPay(big(o.want_amount||o.wantAmount));
    if (off > 0){ depthRecv += off; const p = want/off; if (p > 0 && p < bestAsk) bestAsk = p; }   // cheapest ask
  }
  for (const o of (sideB||[])){
    const off = toPay(big(o.offer_amount||o.offerAmount)), want = toRecv(big(o.want_amount||o.wantAmount));
    if (want > 0){ const p = off/want; if (p > bestBid) bestBid = p; }                              // highest bid
  }
  const hasAsk = isFinite(bestAsk) && bestAsk > 0, hasBid = bestBid > 0;
  return { bestAsk: hasAsk?bestAsk:null, bestBid: hasBid?bestBid:null,
           mid: (hasAsk&&hasBid)?(bestAsk+bestBid)/2:null, spread:(hasAsk&&hasBid)?(bestAsk-bestBid):null, depthRecv };
}

// Executable legs against ONE resting offer, using the daemon's exact proRata:
//   recv = floor(offer_amount * take / base),  pay = ceil(want_amount * take / base)
// with `take` in BASE atoms. The user's typed amount selects `take`; the executed
// amounts are the authoritative proRata, capped at the offer's size (single-offer fill).
function executableQuote(o, payAsset, receiveAsset, editedAsset, typedAtoms){
  const baseAsset = o.pair ? (o.pair.base_asset||o.pair.baseAsset) : (o.base_asset||o.baseAsset);
  const baseAmt = big(o.base_amount||o.baseAmount), offerAmt = big(o.offer_amount||o.offerAmount), wantAmt = big(o.want_amount||o.wantAmount);
  let take;
  if (editedAsset === baseAsset)       take = typedAtoms;
  else if (baseAsset === receiveAsset) take = wantAmt > 0n ? (typedAtoms * baseAmt) / wantAmt : 0n;   // typed the pay leg
  else                                 take = offerAmt > 0n ? ceilDiv(typedAtoms * baseAmt, offerAmt) : 0n; // typed the receive leg
  if (take < 1n) take = 1n;
  if (take > baseAmt) take = baseAmt;
  const recv = (offerAmt * take) / baseAmt;
  const pay  = ceilDiv(wantAmt * take, baseAmt);
  const feeAsset = S.feeAsset || defaultFeeAsset();
  // Open-fee-market fee: the native policy fee (in tSEQ-sats) converted into the chosen
  // fee asset via its published exchange rate — fee_atoms = ceil(native_fee_sats * SCALE / rate),
  // so a more valuable asset pays FEWER atoms. NOTE feeRateFor() is the exchange RATE, not a fee
  // amount; the old `feeRateFor * vsize` produced an absurd fee (e.g. ~29,526 USDX) that broke funding.
  let feeAmount = 0n, feeRate = BigInt(C.EXCHANGE_RATE_SCALE);
  try {
    feeRate = (feeAsset === C.POLICY_HEX) ? BigInt(C.EXCHANGE_RATE_SCALE) : C.feeRateFor(feeAsset);
    const nativeFeeSats = (BigInt(C.DEFAULT_FEERATE) * EST_SWAP_VSIZE) / 1000n;   // sat/kvB * vbytes / 1000
    feeAmount = ceilDiv(nativeFeeSats * BigInt(C.EXCHANGE_RATE_SCALE), feeRate);
  } catch {}
  return { kind:'same', offer:o, takeBase:take,
    assetP: payAsset, amountP: pay, assetR: receiveAsset, amountR: recv,
    feeAsset, feeAmount, feeRate, capped: take >= baseAmt };
}

function paintEmptyRate(pay, receive, n){
  const { $ } = C;
  $('swRate').textContent = n
    ? `${n} resting offer${n>1?'s':''} for ${C.assetMeta(receive).ticker} - enter an amount.`
    : `No resting offers for ${C.assetMeta(receive).ticker}/${C.assetMeta(pay).ticker} yet - enter an amount to start this market.`;
  $('swRoute').textContent = 'Order book';
  setFinality('same');
}

// Derive pay/receive legs (the proven 6d-1 mapping).
// SELL base: send base (typed), receive quote (previewed). BUY base: receive base, send quote.
function orientLegs(m, side, baseAtoms, p){
  const base = m.market.base_asset, quote = m.market.quote_asset;
  const counterAmt = big(pick(p, 'amount') || 0);
  const counterAsset = pick(p, 'asset') || quote;
  if (side === 'BUY')
    return { assetP: counterAsset, amountP: counterAmt, assetR: base, amountR: baseAtoms };
  return { assetP: base, amountP: baseAtoms, assetR: counterAsset, amountR: counterAmt };
}

// Fill the opposite amount field + the rate/fee lines from LAST_QUOTE.
function paintQuoteSame(){
  const { $ } = C; const q = LAST_QUOTE; if (!q) return;
  // assetP/amountP is what we PAY; assetR/amountR is what we RECEIVE.
  const pm = C.assetMeta(q.assetP), rm = C.assetMeta(q.assetR);
  // Write the side we did NOT edit (so the user's typed field is never stomped).
  if (S.edited === 'pay'){
    if (document.activeElement !== $('swRecvAmt')) $('swRecvAmt').value = C.fmtAtoms(q.amountR, rm.precision);
  } else {
    if (document.activeElement !== $('swPayAmt')) $('swPayAmt').value = C.fmtAtoms(q.amountP, pm.precision);
  }
  paintRefHints();
  // Rate line: 1 PAY = X RECEIVE (derived from the two legs; direction-agnostic).
  const payU  = Number(q.amountP) / Math.pow(10, pm.precision || 0);
  const recvU = Number(q.amountR) / Math.pow(10, rm.precision || 0);
  if (payU > 0){
    const r = recvU / payU;
    $('swRate').textContent = `1 ${pm.ticker} = ${trim(r)} ${rm.ticker} · order book`;
  }
  paintFee(q.feeAsset, q.feeAmount);
  setFinality('same');
}

// Fetch + render the ONE (cross) order book for a BTC<->asset pair. Called on EVERY
// rail (ln / cross / mixed) so the book is never blank and looks identical — there is
// no on-chain/LN distinction in the book UI. Returns { offers, unreachable }.
// Cached unified-book fetch (rail-blind matching). ONE fetch per pair per ~12s; both the composer's
// rail auto-selection (requote) and the book render (loadBtcBook) read it. Returns the raw LSP
// payload ({ asks, bids, best_ask, best_bid, ... }) or null.
let _ubookCache = { key: null, ts: 0, book: null };
async function getUnifiedBook(seqAsset){
  if (!seqAsset || seqAsset === 'BTC') return null;
  if (_ubookCache.key === seqAsset && (Date.now() - _ubookCache.ts) < 12000) return _ubookCache.book;
  let book = null;
  try { if (L && L.unifiedBook){ const u = await L.unifiedBook(seqAsset); if (u && u.ok) book = u; } } catch {}
  _ubookCache = { key: seqAsset, ts: Date.now(), book };
  return book;
}
async function loadBtcBook(route){
  const seqAsset = route.seqAsset;
  let book = { forward: [], reverse: [], unreachable: false };
  if (X && X.book) book = await X.book(seqAsset).catch(() => ({ forward: [], reverse: [], unreachable: true }));
  const forward = book.forward || [], reverse = book.reverse || [];
  const offers = route.payIsBtc ? forward : reverse;   // the takeable side for this direction (quote + fill)
  XBOOK = { seqAsset, payIsBtc: route.payIsBtc, offers, forward, reverse };
  // Stage 2 (rail-agnostic display): fetch the UNIFIED book (on-chain + LN merged, rail-tagged) and
  // render THAT — the user sees ALL resting liquidity and a real price whichever rail carries it,
  // never "no maker for your rail". Falls back to the on-chain-only cross book if the LSP is
  // unreachable. The proven on-chain take path (XBOOK) is unchanged; an LN row seeds the amount and
  // the composer requotes on the user's rail (the LSP bridges / fails closed cleanly on take).
  const ub = await getUnifiedBook(seqAsset);
  const unified = ub ? { asks: ub.asks || [], bids: ub.bids || [] } : null;
  UBOOK = unified ? { seqAsset, ...unified } : null;
  renderXBook(seqAsset, route.payIsBtc, forward, reverse, unified);
  return { offers, unreachable: book.unreachable };
}
function numVal(el){ return parseFloat((((el && el.value) || '')).replace(/,/g, '')) || 0; }
// Best-effort self-correcting fill for the LN / mixed rails: derive the field the
// user did NOT edit from the best resting offer's price, so the composer is never
// half-empty. The authoritative amounts still come from the settle response (LN) or
// the daemon quote (cross); this is display only, and never stomps an active field.
// Format a UNIT amount to a string rounded to the asset's own precision (MED-4): a value
// written back into an amount field must never carry more decimals than the asset supports,
// or parseAtoms() throws on submit and the trade becomes un-postable. Mirrors fmtAtoms.
function fmtUnits(units, prec){ return C.fmtAtoms(BigInt(Math.round(units * Math.pow(10, prec))), prec); }
function deriveXOpposite(route){
  try {
    const o = (XBOOK.offers || [])[0]; if (!o) return;
    const am = C.assetMeta(route.seqAsset);
    const aprec = am.precision || 0;
    const { asset, btc } = xOfferAmts(o, route.payIsBtc);
    const assetU = Number(big(asset)) / Math.pow(10, aprec), btcU = Number(big(btc)) / 1e8;
    if (!(assetU > 0 && btcU > 0)) return;
    const btcPerAsset = btcU / assetU;
    const pa = C.$('swPayAmt'), ra = C.$('swRecvAmt');
    const btcIsPay = (S.payAsset === 'BTC');
    if (S.edited === 'pay'){
      const v = numVal(pa); if (!(v > 0)) return;
      const other = btcIsPay ? (v / btcPerAsset) : (v * btcPerAsset);
      // derived leg is the RECEIVE side: the asset when BTC is paid, otherwise BTC (8dp).
      if (document.activeElement !== ra) ra.value = fmtUnits(other, btcIsPay ? aprec : 8);
    } else {
      const v = numVal(ra); if (!(v > 0)) return;
      const other = btcIsPay ? (v * btcPerAsset) : (v / btcPerAsset);
      // derived leg is the PAY side: BTC when BTC is paid, otherwise the asset.
      if (document.activeElement !== pa) pa.value = fmtUnits(other, btcIsPay ? 8 : aprec);
    }
    paintRefHints();
  } catch {}
}

// --- MIXED rails (one leg LN, one on-chain) -------------------------------------
// The front end is priced from the same book and the timing banner is exact. Review
// now runs a real submarine swap via the LSP (reviewMixed -> POST /swap with
// payRail/recvRail -> seqob-cli xsubbuy/xsublift): the asset leg is an anchored
// on-chain HTLC, the BTC leg is Lightning, bound by one preimage. Anchor-gated (not
// instant-final). The one undeployed shape (asset over LN + BTC on-chain) fails closed.
async function requoteMixed(route, amtStr){
  const { $ } = C;
  const am = C.assetMeta(route.seqAsset);
  $('swStatus').textContent = ''; $('swErr').textContent = '';
  // Defensive: the rail toggles already grey out the undeployed mixed shape (asset over LN
  // + BTC on-chain), but if state ever lands there, don't offer a doomed Review — render
  // the book, then nudge the user to a supported combo instead of hitting an HTTP 422.
  if (!railSupported(route.payRail, route.recvRail)){
    await loadBtcBook(route);
    $('swRate').textContent = 'This rail combination isn’t available yet.';
    $('swRoute').textContent = 'Mixed rails · coming soon';
    $('swErr').textContent = `Asset-over-Lightning with BTC on-chain has no maker yet. `
      + `Put ${am.ticker} on-chain and BTC on Lightning, or set both legs the same way.`;
    setReviewEnabled(false);
    renderTiming(route);
    return;
  }
  // Sub-asset SELL (pay the asset over Lightning, receive BTC on-chain): take a resting sell offer
  // from the sub-asset book — a whole-offer lift at the maker's fixed terms. Attach the offer so
  // startSell takes exactly THIS one (unambiguous amount), fill both amount fields, and show the
  // BTC received. Distinct from the submarine path below (which reads the on-chain cross book).
  if (route.payRail === 'ln' && route.recvRail === 'chain' && !route.payIsBtc){
    const offer = subassetOffers(route.seqAsset, 'sell')[0] || null;
    if (!offer){
      $('swRate').textContent = `No resting ${am.ticker}→BTC sell offer right now — try again shortly.`;
      $('swRoute').textContent = 'Mixed rails · sell over Lightning, receive BTC on-chain';
      setReviewEnabled(false); renderTiming(route); return;
    }
    // MED-4: format each leg at its own precision (asset at am.precision, BTC at 8), not the
    // generic 8dp trim(), so a sub-8-decimal asset writes a re-parseable value into the field.
    const assetStr = C.fmtAtoms(BigInt(offer.asset_amount), am.precision || 0);
    const btcStr = C.fmtAtoms(BigInt(offer.btc_sats), 8);
    $('swPayAmt').value = assetStr;
    $('swRecvAmt').value = btcStr;
    $('swRate').textContent = `${assetStr} ${am.ticker} → ${btcStr} BTC · best resting offer`;
    $('swRoute').textContent = 'Mixed rails · sell over Lightning, receive BTC on-chain';
    paintFee('BTC', null, 'You pay the ' + am.ticker + ' over Lightning; your device claims the BTC from its on-chain HTLC.');
    LAST_QUOTE = { kind: 'mixed', route, seqAsset: route.seqAsset, payIsBtc: false,
      payRail: 'ln', recvRail: 'chain', sellOffer: offer };
    renderTiming(route);
    setReviewEnabled(true);
    return;
  }
  // Sub-asset BUY (pay BTC on-chain, receive the asset over Lightning): like the sell, reviewMixed
  // lifts the WHOLE resting sub-asset BUY offer at the maker's fixed terms (startBuy uses
  // offer.asset_amount and ignores the typed amount). So quote off THAT offer — not the on-chain
  // cross book — attach it, and show its exact BTC↔asset terms, so the displayed rate is what
  // actually executes (fixes the price-honesty gap where the cross book and the lifted offer differ).
  if (route.payRail === 'chain' && route.recvRail === 'ln' && route.payIsBtc && subassetCapable(route.seqAsset)){
    const offer = subassetOffers(route.seqAsset, 'buy')[0] || null;
    if (!offer){
      $('swRate').textContent = `No resting BTC→${am.ticker} buy offer right now — try again shortly.`;
      $('swRoute').textContent = 'Mixed rails · buy over Lightning, pay BTC on-chain';
      setReviewEnabled(false); renderTiming(route); return;
    }
    const assetStr = C.fmtAtoms(BigInt(offer.asset_amount), am.precision || 0);
    const btcStr = C.fmtAtoms(BigInt(offer.btc_sats), 8);
    $('swRecvAmt').value = assetStr;
    $('swPayAmt').value = btcStr;
    $('swRate').textContent = `${btcStr} BTC → ${assetStr} ${am.ticker} · best resting offer`;
    $('swRoute').textContent = 'Mixed rails · buy over Lightning, pay BTC on-chain';
    paintFee('BTC', null, 'You pay BTC on-chain; the maker pays the ' + am.ticker + ' to your device over Lightning.');
    LAST_QUOTE = { kind: 'mixed', route, seqAsset: route.seqAsset, payIsBtc: true,
      payRail: 'chain', recvRail: 'ln', buyOffer: offer };
    renderTiming(route);
    setReviewEnabled(true);
    return;
  }
  await loadBtcBook(route);
  deriveXOpposite(route);
  const o = (XBOOK.offers || [])[0];
  if (o){
    const { asset, btc } = xOfferAmts(o, route.payIsBtc);
    const assetU = Number(big(asset)) / Math.pow(10, am.precision || 0), btcU = Number(big(btc)) / 1e8;
    $('swRate').textContent = (assetU > 0 && btcU > 0)
      ? `1 BTC = ${trim(assetU / btcU)} ${am.ticker} · best resting offer`
      : `Mixed rails · ${am.ticker}/BTC`;
  } else {
    $('swRate').textContent = `No resting offers for ${am.ticker}/BTC yet.`;
  }
  $('swRoute').textContent = 'Mixed rails · Lightning + on-chain';
  // Fronted case (pay on-chain -> receive on LN, within the instant-front CAP): the
  // fee note flags the instant-settlement cover; otherwise it's quoted when the route lands.
  const fronted = (route.recvRail === 'ln' && route.payRail === 'chain' && btcLegAtoms() <= frontCapAtoms());
  paintFee('BTC', null, fronted
    ? 'Includes instant-settlement cover for the fronted on-chain leg.'
    : 'Mixed-rail settlement · fees are quoted when this route lands.');
  LAST_QUOTE = { kind: 'mixed', route, seqAsset: route.seqAsset, payIsBtc: route.payIsBtc,
    payRail: route.payRail, recvRail: route.recvRail };
  renderTiming(route);
  setReviewEnabled(!!(amtStr && amtStr.trim()));   // clickable -> reviewMixed runs the submarine swap
}

// --- cross-chain quote (GetXchainQuote) ---
// POST mode (cross-chain BTC<->asset): the fields are the user's OWN price. Review posts a
// resting cross offer via the maker path (postCrossOfferReview -> X.makerStart/makerStartReverse).
// reverse = pay BTC (post a BID: buy the asset with BTC); forward = pay the asset (post an ASK:
// sell the asset for BTC) — mirroring the "be the first" branch in requoteCross.
function postModeCross(route){
  const { $ } = C;
  const am = C.assetMeta(route.seqAsset);
  const reverse = !!route.payIsBtc;
  const start = reverse ? (X && X.makerStartReverse) : (X && X.makerStart);
  if (!start){
    LAST_QUOTE = null; setReviewEnabled(false);
    $('swRate').textContent = `Posting a ${am.ticker}/BTC offer isn’t available in this build.`;
    $('swRoute').textContent = '';
    setFinality('cross');
    return;
  }
  LAST_QUOTE = { kind:'cross-make', reverse, assetHex: route.seqAsset };
  const both = numVal($('swPayAmt')) > 0 && numVal($('swRecvAmt')) > 0;
  $('swRate').textContent = both
    ? `Your price · ${reverse ? `buy ${am.ticker} with BTC` : `sell ${am.ticker} for BTC`} — Post to rest this offer.`
    : `Set both amounts (the ${am.ticker} and the BTC) — their ratio is your price — then Post.`;
  $('swRoute').textContent = reverse ? 'Cross-chain · post a bid (buy with BTC)' : 'Cross-chain · post an offer (sell for BTC)';
  setFinality('cross');
  setReviewEnabled(both);
}

async function requoteCross(route, amtStr){
  const { $ } = C;
  if (!X || !X.quote){ $('swErr').textContent = 'Cross-chain route unavailable in this build.'; setReviewEnabled(false); return; }
  const seqAsset = route.seqAsset;
  const am = C.assetMeta(seqAsset);
  const seqPrec = am.precision || 0;
  const status = $('swStatus'); status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading the cross-chain order book…';
  $('swErr').textContent = '';
  try {
    // Fetch + render the ONE (cross) order book for this pair, then pick the side
    // that matches the taker's direction: buy asset with BTC = forward offers; sell
    // asset for BTC = reverse offers. "No offers" is not an error — it renders an
    // empty book (cross markets need a maker with BTC reserves, so unlike a
    // same-chain pair the wallet can't self-start one yet).
    const { offers, unreachable } = await loadBtcBook(route);

    // T7: cross-chain relay unreachable AND nothing to show — offer a retry, never invite first-maker.
    if (unreachable && !offers.length){
      status.textContent = ''; clearOpposite(); LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Cross-chain order book unreachable - retry.';
      $('swRoute').textContent = '';
      $('swErr').textContent = 'Could not reach the cross-chain order book (' + (unreachable === true ? 'relay unreachable' : unreachable) + '). Check your connection and press Refresh.';
      return;
    }

    // Take vs Post (Post defaults for an empty cross book). In Post mode the fields are the
    // user's own price; Review posts a resting cross offer via the maker (postCrossOfferReview).
    applyAutoMode(offers.length, route);
    if (S.mode === 'post'){ status.textContent = ''; return postModeCross(route); }

    if (!offers.length){
      status.textContent = ''; clearOpposite(); setFinality('cross');
      if (!route.payIsBtc && X && X.makerStart){
        // SELL asset for BTC with no resting bid: self-start via the FORWARD maker
        // (the wallet holds the asset, locks it, claims the taker's BTC).
        LAST_QUOTE = { kind: 'cross-make', reverse: false, assetHex: seqAsset };
        $('swRate').textContent = `No resting offers yet - Review to post your own and sell ${am.ticker} for BTC.`;
        $('swRoute').textContent = 'Cross-chain · be the first (sell for BTC)';
        setReviewEnabled(true);
      } else if (route.payIsBtc && X && X.makerStartReverse){
        // BUY asset with BTC with no resting ask: self-start via the REVERSE maker
        // (the wallet funds a BTC bid, holds the secret, claims the taker's asset).
        LAST_QUOTE = { kind: 'cross-make', reverse: true, assetHex: seqAsset };
        $('swRate').textContent = `No resting offers yet - Review to post your own and buy ${am.ticker} with BTC.`;
        $('swRoute').textContent = 'Cross-chain · be the first (buy with BTC)';
        setReviewEnabled(true);
      } else {
        LAST_QUOTE = null; setReviewEnabled(false);
        $('swRate').textContent = `No resting offers for ${am.ticker}/BTC yet - a market maker needs to post one.`;
        $('swRoute').textContent = route.payIsBtc ? 'Cross-chain · buy with BTC' : 'Cross-chain · sell for BTC';
      }
      return;
    }

    if (!amtStr || !amtStr.trim()){
      status.textContent = ''; clearOpposite(); setReviewEnabled(false);
      const n = offers.length;
      $('swRate').textContent = `${n} resting cross-chain offer${n>1?'s':''} - enter an amount.`;
      $('swRoute').textContent = route.payIsBtc ? 'Cross-chain · buy with BTC' : 'Cross-chain · sell for BTC';
      setFinality('cross');
      return;
    }

    // The user's FULL requested amount, priced at the best resting offer. We quote the full amount;
    // the cross daemon returns what the best maker can fill NOW (its liquidity) — the immediate-fill
    // portion. The unfilled remainder rests as a limit order at the same price (posted on Review).
    const { asset: bestAsset, btc: bestBtc } = xOfferAmts(offers[0], route.payIsBtc);
    if (!(bestAsset > 0n && bestBtc > 0n)) throw new Error('no cross-chain price yet');
    const editedIsSeq = (S.edited === 'pay' ? S.payAsset : S.receiveAsset) === seqAsset;
    let reqSeqAtoms, reqBtcAtoms;
    if (editedIsSeq){
      reqSeqAtoms = C.parseAtoms(amtStr, seqPrec);
      reqBtcAtoms = (reqSeqAtoms * bestBtc) / bestAsset;      // BTC at the best price
    } else {
      reqBtcAtoms = C.parseAtoms(amtStr, 8);
      reqSeqAtoms = (reqBtcAtoms * bestAsset) / bestBtc;
    }
    if (reqSeqAtoms <= 0n) throw new Error('enter an amount greater than zero');
    const rawXq = route.payIsBtc
      ? await X.quote(seqAsset, reqSeqAtoms)                  // { seq_amount, btc_amount, fee_btc } — capped to the maker's fillable
      : (X.reverseQuote ? await X.reverseQuote(seqAsset, reqSeqAtoms)
                        : (() => { throw new Error('selling an asset for BTC is unavailable in this build'); })());
    // fill-now = what the maker can fill (the quote); remainder = requested − fill, rested at the
    // same price. A <0.5% sliver is treated as rounding (full fill, no remainder).
    const fillSeq = big(rawXq.seq_amount);
    const canRest = route.payIsBtc ? !!(X && X.makerStartReverse) : !!(X && X.makerStart);
    const split = canRest ? fillRestSplit(reqSeqAtoms, fillSeq) : null;   // { fill, rest } or null (full fill)
    const remSeq = split ? split.rest : 0n;
    const hasRemainder = remSeq > 0n;
    const remBtc = hasRemainder ? (remSeq * bestBtc) / bestAsset : 0n;
    LAST_QUOTE = { kind:'cross', reverse: !route.payIsBtc, route, xq: rawXq, seqAsset,
      requestedSeqAtoms: reqSeqAtoms, requestedBtcAtoms: reqBtcAtoms, fillSeqAtoms: fillSeq,
      remainderSeqAtoms: hasRemainder ? remSeq : 0n, remainderBtcAtoms: remBtc };
    status.textContent = '';
    paintQuoteCross();
    setReviewEnabled(true);
  } catch (e){
    status.textContent = '';
    $('swErr').textContent = 'Cross-chain order book: ' + (e.message || e);
    setReviewEnabled(false);
  }
}

// Asset/BTC atom amounts of a cross offer, per taker direction. Forward (dir 0):
// base_amount = the asset, want_amount = BTC. Reverse (dir 1): offer_amount = BTC,
// want_amount (or base_amount) = the asset.
function xOfferAmts(o, payIsBtc){
  const ba = big(o.base_amount||o.baseAmount), wa = big(o.want_amount||o.wantAmount), of = big(o.offer_amount||o.offerAmount);
  return payIsBtc ? { asset: ba, btc: wa } : { asset: (wa || ba), btc: of };
}

// Cross-chain order book (resting cross offers for one BTC<->asset pair + direction),
// rendered as the SAME ladder as the same-chain book — no rail distinction, orders
// look identical. Buying asset with BTC => the offers are ASKS you can take; selling
// asset for BTC => they are BIDS you can take. Prices are BTC per asset unit.
function renderXBook(seqAsset, payIsBtc, forward, reverse, unified){
  const host = C.$('swBook'); if (!host) return;
  const am = C.assetMeta(seqAsset);
  forward = forward || []; reverse = reverse || [];
  let asks, bids, n;
  const useUnified = !!(unified && ((unified.asks && unified.asks.length) || (unified.bids && unified.bids.length)));
  if (useUnified){
    // MERGED book (Stage 2): on-chain + LN offers, each row tagged with its rail, priced BTC/asset in
    // whole units and sorted like the on-chain book. Clicking a level seeds the asset size
    // (rail-agnostic); the composer requotes on the user's chosen rail (the LSP bridges on take).
    const uRow = (o) => {
      const atoms = big(o.assetAtoms);
      const assetU = Number(atoms) / Math.pow(10, am.precision || 0);
      const btcU = Number(big(o.btcSats)) / 1e8;
      return { price: assetU > 0 ? btcU / assetU : 0, size: assetU, assetAtoms: atoms, rail: o.rail };
    };
    asks = (unified.asks || []).map(uRow).filter(r => r.price > 0 && r.size > 0);
    bids = (unified.bids || []).map(uRow).filter(r => r.price > 0 && r.size > 0);
    n = (unified.asks || []).length + (unified.bids || []).length;
    const seed = (r) => () => {
      const el = payIsBtc ? C.$('swRecvAmt') : C.$('swPayAmt');
      // Seed the EXACT atoms at the asset's own precision (like fillFromXOffer / commit 7d85b396's
      // MED-4 fix), not an 8dp float trim() that can lose precision or emit more decimals than the
      // asset supports.
      if (el){ S.edited = payIsBtc ? 'receive' : 'pay'; el.value = C.fmtAtoms(r.assetAtoms, am.precision || 0); }
      LAST_QUOTE = null; setReviewEnabled(false); requote().catch(()=>{});
    };
    (payIsBtc ? asks : bids).forEach(r => r.onClick = seed(r));
  } else {
    // On-chain-only fallback (LSP unreachable). asks = forward offers (someone SELLS the asset for
    // BTC), bids = reverse offers (someone BUYS the asset with BTC). Priced BTC/asset by each offer's
    // OWN direction, not the user's side.
    const toRow = (o, i, dirIsBtc) => {
      const { asset, btc } = xOfferAmts(o, dirIsBtc);
      const assetU = Number(big(asset)) / Math.pow(10, am.precision || 0), btcU = Number(big(btc)) / 1e8;
      return { price: assetU > 0 ? btcU / assetU : 0, size: assetU, _i: i };
    };
    asks = forward.map((o, i) => toRow(o, i, true)).filter(r => r.price > 0 && r.size > 0);
    bids = reverse.map((o, i) => toRow(o, i, false)).filter(r => r.price > 0 && r.size > 0);
    n = forward.length + reverse.length;
    (payIsBtc ? asks : bids).forEach(r => r.onClick = () => fillFromXOffer(r._i));
  }
  asks.sort((a, b) => a.price - b.price);
  { let c = 0; const t = asks.reduce((s, r) => s + r.size, 0) || 1; asks.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  asks.reverse();
  bids.sort((a, b) => b.price - a.price);
  { let c = 0; const t = bids.reduce((s, r) => s + r.size, 0) || 1; bids.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  // (onClick was assigned per-branch above: seed-amount for the merged book, fillFromXOffer for the
  // on-chain fallback. The clickable side is the one takeable in the user's current direction.)
  const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  LAST_MID = { price: mid, cross: true };
  renderLadder(host, {
    asks: asks.slice(0, 8), bids: bids.slice(0, 8), mid, spread,
    priceLabel: `(BTC/${am.ticker})`, sizeLabel: am.ticker,
    refMidStr: oneUnitRefStr(seqAsset),
    headTitle: 'Order book', headSub: `${n} offer${n === 1 ? '' : 's'}`,
    emptyMsg: 'No resting offers yet - a market maker with BTC reserves needs to post one.',
  });
  renderPairBar();
}
// Click a cross-book level: seed the composer with that offer's asset size + re-quote.
function fillFromXOffer(i){
  const o = (XBOOK.offers || [])[i]; if (!o) return;
  const am = C.assetMeta(XBOOK.seqAsset);
  const { asset } = xOfferAmts(o, XBOOK.payIsBtc);
  if (XBOOK.payIsBtc){ S.edited = 'receive'; C.$('swRecvAmt').value = C.fmtAtoms(asset, am.precision || 0); }
  else               { S.edited = 'pay';     C.$('swPayAmt').value  = C.fmtAtoms(asset, am.precision || 0); }
  LAST_QUOTE = null; setReviewEnabled(false);
  requote().catch(()=>{});
}

// The shared ladder: asks (red, high->low) · mid · bids (green, high->low), with a
// cumulative-depth bar per row. Rows whose item carries an onClick are clickable
// (click-a-level-to-price); the rest are display-only depth. ONE renderer for both
// the same-chain and cross-chain books, so orders look identical on every rail.
function renderLadder(host, o){
  if (!host) return;
  const rowHtml = (cls, r, i) => {
    const clk = typeof r.onClick === 'function';
    const w = Math.max(2, Math.min(100, Math.round((r.frac || 0) * 100)));
    return `<button type="button" class="swlrow ${cls}${clk ? '' : ' noclick'}${r.mine ? ' mine' : ''}" data-side="${cls}" data-i="${i}"${r.mine ? ' title="Your resting order"' : ''}${clk ? '' : ' tabindex="-1"'}>
      <span>${r.mine ? '<i class="swlyou">you</i>' : ''}${esc(trim(r.price))}</span><span>${esc(trim(r.size))}</span><span>${esc(trim(r.cum != null ? r.cum : r.size))}</span>
      <i class="swldepth" style="width:${w}%"></i></button>`;
  };
  const asks = o.asks || [], bids = o.bids || [];
  const asksHtml = asks.map((r, i) => rowHtml('ask', r, i)).join('');
  const bidsHtml = bids.map((r, i) => rowHtml('bid', r, i)).join('');
  const hasRows = asks.length || bids.length;
  const cols = `<div class="swladder-cols"><span>Price ${esc(o.priceLabel || '')}</span><span>Size${o.sizeLabel ? ' (' + esc(o.sizeLabel) + ')' : ''}</span><span>Sum</span></div>`;
  const midHtml = hasRows
    ? `<div class="swlmid"><b>${o.mid != null ? esc(trim(o.mid)) : '—'}</b> <span class="sp">${o.spread != null ? 'spread ' + esc(trim(o.spread)) + ' · mid' : 'mid'}</span> <span>${esc(o.refMidStr || '')}</span></div>`
    : '';
  const empty = hasRows ? '' : `<div class="swladder-empty">${esc(o.emptyMsg || 'No resting offers yet.')}</div>`;
  host.innerHTML = `<div class="swladder">
    <div class="swladder-head"><span class="sub" style="color:var(--txt);font-weight:650">${esc(o.headTitle || 'Order book')}</span><span class="sub">${esc(o.headSub || '')}</span></div>
    ${cols}${asksHtml}${midHtml}${bidsHtml}${empty}</div>`;
  host.querySelectorAll('.swlrow').forEach(b => {
    const side = b.dataset.side, i = +b.dataset.i;
    const r = (side === 'ask' ? asks : bids)[i];
    if (!r || typeof r.onClick !== 'function') return;
    b.onclick = () => { r.onClick(); host.querySelectorAll('.swlrow').forEach(x => x.classList.remove('picked')); b.classList.add('picked'); };
  });
  renderMyOrders();
}

function paintQuoteCross(){
  const { $ } = C; const q = LAST_QUOTE; if (!q || q.kind !== 'cross') return;
  const sm = C.assetMeta(q.seqAsset);
  // Show the user's FULL requested amount (never the fillable sliver): the order they typed.
  const reqSeq = q.requestedSeqAtoms != null ? BigInt(q.requestedSeqAtoms) : big(q.xq.seq_amount);
  const reqBtc = q.requestedBtcAtoms != null ? BigInt(q.requestedBtcAtoms) : big(q.xq.btc_amount);
  const seqStr = C.fmtAtoms(reqSeq, sm.precision);
  const btcStr = C.fmtAtoms(reqBtc, 8);
  // Map BTC<->asset onto pay/receive panes (whichever the user has on each side).
  const btcIsPay = (S.payAsset === 'BTC');
  if (btcIsPay){
    if (document.activeElement !== $('swPayAmt'))  $('swPayAmt').value  = btcStr;
    if (document.activeElement !== $('swRecvAmt')) $('swRecvAmt').value = seqStr;
  } else {
    if (document.activeElement !== $('swPayAmt'))  $('swPayAmt').value  = seqStr;
    if (document.activeElement !== $('swRecvAmt')) $('swRecvAmt').value = btcStr;
  }
  paintRefHints();
  const seqUnits = Number(reqSeq) / Math.pow(10, sm.precision || 0);
  const btcUnits = Number(reqBtc) / 1e8;
  let line = btcUnits > 0 ? `1 BTC = ${trim(seqUnits / btcUnits)} ${sm.ticker} · cross-chain HTLC` : `cross-chain HTLC`;
  // Market order bigger than the maker's depth: say how much fills now and how much rests — the
  // same "fills ~X now, ~Y rests" language the same-chain route uses. No more "Capped — reduce it".
  const rem = q.remainderSeqAtoms != null ? BigInt(q.remainderSeqAtoms) : 0n;
  if (rem > 0n){
    const fillU = Number(BigInt(q.fillSeqAtoms)) / Math.pow(10, sm.precision || 0);
    const restU = Number(rem) / Math.pow(10, sm.precision || 0);
    line += ` · fills ~${trim(fillU)} ${sm.ticker} now, ~${trim(restU)} rests`;
  }
  $('swRate').textContent = line;
  // Cross-chain "fee" is the maker fee in BTC (no open fee-asset market on the BTC leg).
  paintFee('BTC', q.xq.fee_btc, 'Maker fee, paid in BTC on the parent chain.');
  setFinality('cross');
}

// ---------------------------------------------------------------------------
// fee market (open: pay the network fee in any asset the node prices)
// ---------------------------------------------------------------------------
function paintFee(feeAssetHex, feeAtoms, noteOverride){
  const { $ } = C;
  // Paying FROM Lightning is a single-asset payment (you pay one asset over one route), so the fee
  // is inherently in that same asset — freeze the fee asset to the pay asset and lock the picker.
  const payFromLn = !!(S.payRail === 'ln' && S.payAsset);
  // Paying WITH BTC (cross-chain buy) settles the BTC leg on the parent chain, whose fee is a
  // Bitcoin network fee in BTC (sat/vB) — never an any-asset Sequentia fee. Lock the displayed
  // fee asset to BTC so it isn't shown as a stale Sequentia pick.
  const payIsBtc = S.payAsset === 'BTC';
  if (payFromLn){ feeAssetHex = S.payAsset; if (S.payAsset !== 'BTC') S.feeAsset = S.payAsset; }
  else if (payIsBtc){ feeAssetHex = 'BTC'; }
  const fm = C.assetMeta(feeAssetHex);
  $('swFeeTk').textContent = fm.ticker;
  $('swFeeAmt').textContent = (feeAtoms != null) ? (C.fmtAtoms(feeAtoms, fm.precision) + ' ' + fm.ticker) : '-';
  const ref = (feeAtoms != null) ? (C.refValueStr(feeAssetHex, feeAtoms) || '') : '';
  $('swFeeRef').textContent = ref;
  $('swFeeNote').textContent = noteOverride || (payFromLn
    ? `In ${fm.ticker} — the asset you pay over Lightning.`
    : payIsBtc
    ? 'In BTC — the Bitcoin network fee for the parent-chain leg (sat/vB).'
    : 'Pay the fee in any asset the network prices.');
  // The fee picker is disabled when paying from Lightning (fee frozen to the pay asset), and for
  // the cross-chain (BTC-only) leg / LN leg / mixed rail (their cost is the LP spread / BTC-leg fee
  // baked into the rate, not a taker-funded open-market network fee).
  const noFee = payFromLn || (LAST_QUOTE && (LAST_QUOTE.kind === 'cross' || LAST_QUOTE.kind === 'ln' || LAST_QUOTE.kind === 'mixed'));
  $('swFeePick').disabled = !!noFee;
  $('swFeePick').style.opacity = noFee ? '.5' : '';
  if (payFromLn) $('swFeePick').title = `Paying over Lightning — the fee is in ${fm.ticker}, the asset you pay.`;
  else $('swFeePick').removeAttribute('title');
}

// An asset is acceptable for fees if the node publishes a rate for it. Native is
// always accepted by the protocol — a backend fact — so it's a valid fallback, but
// it gets NO special label or position in the UI (open fee market, no privilege).
function acceptedFee(hex){
  if (!hex || hex === 'BTC') return false;
  if (hex === C.POLICY_HEX) return true;
  const r = C.feeRates || {};
  const e = r[hex] || r[C.assetMeta(hex).ticker];   // feeRates is keyed by ticker, not asset hex
  return !!(e && e.rate > 0);
}
const feeVal = (h) => Number(big((C.balObj()||{})[h] || 0)) / Math.pow(10, C.assetMeta(h).precision || 0);
// Default fee asset: the one you're ALREADY paying with (neutral — no privileged
// asset); else the largest node-accepted asset you hold; else any node-priced asset.
function defaultFeeAsset(){
  if (acceptedFee(S.payAsset)) return S.payAsset;
  const bal = C.balObj() || {};
  const owned = Object.keys(bal).filter(h => big(bal[h]) > 0n && acceptedFee(h)).sort((a,b)=> feeVal(b)-feeVal(a));
  if (owned.length) return owned[0];
  return C.POLICY_HEX;   // hold no node-accepted asset: fall back to tSEQ
}
// The fee-asset candidate list: the asset you're paying with first (most natural fee
// source), then owned node-accepted assets, then any other node-priced asset. Every
// entry is treated identically — no asset is flagged as a "default".
function feeAssetOptions(){
  const seen = new Set(), out = [];
  const add = (hex) => { if (hex && !seen.has(hex) && acceptedFee(hex)){ seen.add(hex); out.push({ hex, ticker: C.assetMeta(hex).ticker }); } };
  add(S.payAsset);
  const bal = C.balObj() || {};
  // You can only pay a fee in an asset you actually hold, so list held+accepted
  // assets (plus tSEQ), not every node-accepted asset — the latter showed assets
  // you don't hold at a confusing 0 balance.
  Object.keys(bal).filter(h => big(bal[h]) > 0n).forEach(add);
  add(C.POLICY_HEX);
  return out;
}
function renderFeePicker(){
  // Paying from Lightning freezes the fee to the pay asset (see paintFee).
  const payFromLn = (S.payRail === 'ln' && S.payAsset);
  const fa = payFromLn ? S.payAsset : (S.feeAsset || (S.payAsset ? defaultFeeAsset() : null));
  C.$('swFeeTk').textContent = fa ? C.assetMeta(fa).ticker : '-';
  const pick = C.$('swFeePick');
  if (pick && payFromLn){ pick.disabled = true; pick.style.opacity = '.5'; }
}
function openFeePicker(){
  if (C.$('swFeePick').disabled) return;
  const opts = feeAssetOptions();
  popover(C.$('swFeePick'), opts.map(o => ({
    hex: o.hex, ticker: o.ticker, name: feeAssetSubline(o.hex), bal: balLine(o.hex), enabled: true,
  })), (hex) => {
    S.feeAsset = hex; renderFeePicker();
    LAST_QUOTE = null; setReviewEnabled(false);
    requote().catch(()=>{});
  });
}
function feeAssetSubline(hex){
  if (hex === S.payAsset) return 'The asset you’re paying with';
  return 'Accepted for fees';
}

// ---------------------------------------------------------------------------
// honest, actionable timing banner (keyed off the RECEIVE leg)
// ---------------------------------------------------------------------------
// The LP instant-front CAP (how much on-chain PAY the LP will front so you receive
// on Lightning NOW). Read from window.SEQ_LSP_FRONT_CAP (BTC, e.g. 0.0005); default
// 0.0005 BTC. Compared against the BTC leg of the trade in BTC atoms.
function frontCapAtoms(){
  const w = (typeof window !== 'undefined') ? window : {};
  const c = w.SEQ_LSP_FRONT_CAP;
  if (c != null){ try { return C.parseAtoms(String(c), 8); } catch {} }
  return 50000n;   // 0.0005 BTC
}
// The BTC leg amount of the current composer state, in BTC atoms (the on-chain PAY
// exposure the CAP governs). Exactly one side of a BTC pair is BTC.
function btcLegAtoms(){
  const btcIsPay = (S.payAsset === 'BTC');
  const v = ((btcIsPay ? C.$('swPayAmt') : C.$('swRecvAmt')).value || '').trim();
  try { return C.parseAtoms(v, 8); } catch { return 0n; }
}
// testnet4 on-chain payment confirmation estimate (the pay leg must confirm before an
// over-CAP LN front settles). Overridable via window.SEQ_ONCHAIN_CONF = { n, t }.
function onchainConf(){
  const w = (typeof window !== 'undefined') ? window : {};
  const o = w.SEQ_ONCHAIN_CONF;
  return (o && o.n) ? { n: o.n, t: o.t || '~10 min' } : { n: 1, t: '~10 min' };
}
// asset units per BTC unit, from the best resting offer (for expressing the CAP in the
// pay asset's own units when paying an asset). 0 if unknown.
function assetPerBtc(route){
  const o = (XBOOK.offers || [])[0]; if (!o) return 0;
  const am = C.assetMeta(route.seqAsset);
  const { asset, btc } = xOfferAmts(o, route.payIsBtc);
  const assetU = Number(big(asset)) / Math.pow(10, am.precision || 0), btcU = Number(big(btc)) / 1e8;
  return btcU > 0 ? assetU / btcU : 0;
}
// The CAP expressed in the PAY asset's own units (BTC when paying BTC; the asset when
// paying the asset, converted via the best-offer price; falls back to BTC if unknown).
function capDisplay(route){
  const cap = frontCapAtoms();
  if (route.payIsBtc) return C.fmtAtoms(cap, 8) + ' BTC';
  const r = assetPerBtc(route);
  if (r > 0){
    const am = C.assetMeta(route.seqAsset);
    const capAssetUnits = (Number(cap) / 1e8) * r;
    const capAssetAtoms = BigInt(Math.round(capAssetUnits * Math.pow(10, am.precision || 0)));
    return C.fmtAtoms(capAssetAtoms, am.precision || 0) + ' ' + am.ticker;
  }
  return C.fmtAtoms(cap, 8) + ' BTC';
}
// Anchor-honest wording reused across the on-chain-receipt cases.
const ANCHOR_FINAL = 'anchor-bound to Bitcoin (reverts only if Bitcoin reverts)';

// Render the timing banner for the current route. The matrix is keyed off the RECEIVE
// leg (an on-chain RECEIPT is never made instant by the CAP; the CAP only fronts an
// on-chain PAYMENT). The inline "fix" links flip a leg to Lightning.
function renderTiming(route){
  const el = C.$('swTiming'), ic = C.$('swTimingIcon'), tx = C.$('swTimingText');
  if (!el || !tx) return;
  const wireFix = () => { el.querySelectorAll('.swfix').forEach(s => s.onclick = () => setRail(s.dataset.fix, 'ln')); };
  const ln = lnAvailable();
  // Only offer a "switch this leg to Lightning" fix when that leg has a REAL usable
  // channel — otherwise the link would be a dead no-op (the rail stays on-chain).
  const ra = ln ? railAvail(S.payAsset, S.receiveAsset) : { payLn: { ok: false }, recvLn: { ok: false } };
  if (!route){
    el.className = 'swtiming ok'; if (ic) ic.textContent = '•';
    tx.innerHTML = 'Pick two assets to see how settlement works.';
    return;
  }
  if (route.kind === 'same'){
    // Same-chain atomic swap: on-chain receipt (no LN option here), anchor-bound.
    el.className = 'swtiming wait'; if (ic) ic.textContent = '◷';
    tx.innerHTML = `Appears immediately, final in <b>~1 block</b> · ${ANCHOR_FINAL}.`;
    return;
  }
  // BTC pair: the exact 4-case matrix keyed off the receive leg.
  const pr = route.payRail, rr = route.recvRail;
  const tk = esc(C.assetMeta(route.seqAsset).ticker);
  if (rr === 'ln' && pr === 'ln'){
    el.className = 'swtiming ok'; if (ic) ic.textContent = '✓';
    tx.innerHTML = '<b>Instant &amp; final</b> — both legs on Lightning, nothing on-chain, no reorg risk.';
  } else if (rr === 'ln' && pr === 'chain' && btcLegAtoms() <= frontCapAtoms()){
    el.className = 'swtiming ok'; if (ic) ic.textContent = '✓';
    tx.innerHTML = `<b>Instant.</b> Your on-chain payment is fronted; you receive final ${tk} now.`;
  } else if (rr === 'ln' && pr === 'chain'){
    const { n, t } = onchainConf();
    el.className = 'swtiming wait'; if (ic) ic.textContent = '◷';
    // The "pay from Lightning" fix only helps when the PAY leg has a usable channel.
    const canFixPay = ra.payLn.ok;
    tx.innerHTML = `<b>~${n} confirmation${n > 1 ? 's' : ''} (${esc(t)}):</b> your on-chain payment must confirm first. `
      + (canFixPay ? `Settle instantly by <span class="swfix" data-fix="pay">paying from Lightning</span>, or trade under ${esc(capDisplay(route))}.`
                   : `Trade under ${esc(capDisplay(route))} to be fronted instantly.`);
    if (canFixPay) wireFix();
  } else {   // rr === 'chain' (any pay rail): on-chain receipt, inherent — CAP can't make it instant
    el.className = 'swtiming wait'; if (ic) ic.textContent = '◷';
    // Offer "switch Receive to Lightning" only when the RECEIVE leg has a usable channel.
    const canFixRecv = ra.recvLn.ok;
    tx.innerHTML = `Appears immediately, final in <b>~1 block</b> · ${ANCHOR_FINAL}.`
      + (canFixRecv ? ` To receive instantly &amp; finally, <span class="swfix" data-fix="recv">switch Receive to Lightning</span>.` : '');
    if (canFixRecv) wireFix();
  }
}
// Back-compat shim: older call sites pass a kind string; the banner now derives its
// state from the live route + rails, so the argument is ignored.
function setFinality(_kind){ renderTiming(findRoute(S.payAsset, S.receiveAsset)); }

// ---------------------------------------------------------------------------
// asset picker popover (searchable; ticker · balance · ≈ ref)
// ---------------------------------------------------------------------------
function balLine(hex){
  if (!hex) return { b:'', r:'' };
  const a = balAtoms(hex), m = metaOf(hex);
  return { b: C.fmtAtoms(a, m.precision) + ' ' + m.ticker, r: C.refValueStr(hex, a) || '' };
}

function openPicker(side){
  const other = side === 'pay' ? S.receiveAsset : S.payAsset;
  // Candidate set: assets that trade against the OTHER side (or all tradable if the
  // other side is unset). This is what enforces "only offer a counter-asset that trades".
  const candidates = counterpartsOf(other);
  const cur = side === 'pay' ? S.payAsset : S.receiveAsset;
  // Your HELD assets first (carrying the on-chain/Lightning split that used to be on the top
  // cards), then every other tradable asset — so a registry of thousands stays navigable via the
  // search box + a capped "All assets" tail. This dropdown is what replaces the removed cards.
  const list = candidates.map(hex => ({
    hex, ticker: C.assetMeta(hex).ticker, name: pickerName(hex), bal: balLine(hex),
    held: balAtoms(hex) > 0n, split: balAtoms(hex) > 0n ? heldSplitStr(hex) : '',
    enabled: hex !== cur,
  }));
  list.sort((a, b) => (b.held ? 1 : 0) - (a.held ? 1 : 0) || a.ticker.localeCompare(b.ticker));
  const anchor = side === 'pay' ? C.$('swPayPick') : C.$('swRecvPick');
  popover(anchor, list, (hex) => {
    if (side === 'pay') S.payAsset = hex; else S.receiveAsset = hex;
    // If the new selection collides with the other side, clear the other side.
    if (S.payAsset && S.payAsset === S.receiveAsset){
      if (side === 'pay') S.receiveAsset = null; else S.payAsset = null;
    }
    // If the other side no longer trades against the new pick, clear it.
    const o = side === 'pay' ? S.receiveAsset : S.payAsset;
    if (o && !counterpartsOf(hex).includes(o)){ if (side === 'pay') S.receiveAsset = null; else S.payAsset = null; }
    S.railsTouched = false; S.modeTouched = false;   // re-arm rail + Take/Post defaults for the new pair
    LAST_QUOTE = null; setReviewEnabled(false);
    paintPanes();
    requote().catch(()=>{});
  });
}
function pickerName(hex){ if (hex === 'BTC') return 'Bitcoin testnet4'; return C.assetMeta(hex).name || 'Asset'; }
// The on-chain/Lightning split for a held asset — the info that used to be on the top cards,
// now shown inline under a held asset's name in the dropdown. HTML (the ⚡ part gets the amber .z).
function heldSplitStr(hex){
  const m = metaOf(hex), instant = instantAtomsFor(hex), onchain = balAtoms(hex);
  return `<span class="z">${C.fmtAtoms(instant, m.precision)} Lightning</span> · ${C.fmtAtoms(onchain, m.precision)} on-chain`;
}

// A lightweight searchable popover anchored under `anchorEl`. `items` are
// { hex, ticker, name, bal:{b,r}, enabled }. onPick(hex) is called on selection.
let _pop = null;
function popover(anchorEl, items, onPick){
  closePopover();
  const { el } = C;
  anchorEl.setAttribute('aria-expanded', 'true');
  const pop = el('div','swpop'); pop.setAttribute('role','listbox');
  const sb = el('div','swpop-search'); const inp = el('input'); inp.placeholder = 'Search assets'; inp.setAttribute('aria-label','Search assets');
  sb.appendChild(inp); pop.appendChild(sb);
  const listEl = el('div','swpop-list'); pop.appendChild(listEl);
  document.body.appendChild(pop);
  // Position under the anchor, clamped to viewport.
  const r = anchorEl.getBoundingClientRect();
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 40) + 'px';
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';

  const ALL_CAP = 40;   // don't render a whole (potentially huge) registry eagerly — search finds the rest
  let kbdIdx = -1, shown = [], optEls = [];
  const rowFor = (it) => {
    const b = el('button','swopt'); b.type = 'button'; b.setAttribute('role','option');
    if (!it.enabled){ b.disabled = true; }
    const t = el('span','swopt-tk', it.ticker);
    const mid = el('div','swopt-mid'); mid.appendChild(el('div','swopt-name', it.name || ''));
    if (it.split){ const sp = el('div','swopt-split'); sp.innerHTML = it.split; mid.appendChild(sp); }
    const bal = el('div','swopt-bal');
    if (it.bal && it.bal.b) bal.appendChild(el('div','b', it.bal.b));
    if (it.bal && it.bal.r) bal.appendChild(el('div','r', it.bal.r));
    b.appendChild(t); b.appendChild(mid); b.appendChild(bal);
    b.onclick = () => { if (it.enabled){ onPick(it.hex); closePopover(); } };
    return b;
  };
  const draw = (q) => {
    listEl.innerHTML = ''; kbdIdx = -1; shown = []; optEls = [];
    const ql = (q || '').toLowerCase();
    const match = items.filter(it => !q || (it.ticker + ' ' + (it.name||'') + ' ' + it.hex).toLowerCase().includes(ql));
    if (!match.length){ listEl.appendChild(el('div','swopt-empty','No matching assets.')); return; }
    // Your held assets FIRST, then everything else. The "All assets" tail is capped until you
    // search, so a registry of thousands never renders thousands of rows.
    const held = match.filter(it => it.held), all = match.filter(it => !it.held);
    const capped = !q && all.length > ALL_CAP;
    const groups = [];
    if (held.length) groups.push(['Your assets', held]);
    if (all.length) groups.push([held.length ? 'All assets' : 'Assets', capped ? all.slice(0, ALL_CAP) : all]);
    for (const [label, arr] of groups){
      listEl.appendChild(el('div','swopt-grp', label));
      for (const it of arr){
        const b = rowFor(it); const idx = shown.length;
        b.onmouseenter = () => { kbdIdx = idx; markKbd(); };
        listEl.appendChild(b); shown.push(it); optEls.push(b);
      }
    }
    if (capped) listEl.appendChild(el('div','swopt-more', `+${all.length - ALL_CAP} more — keep typing to find them.`));
  };
  const markKbd = () => {
    optEls.forEach((c,i)=>c.classList.toggle('kbd', i===kbdIdx));
    const cur = optEls[kbdIdx]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block:'nearest' });
  };
  inp.addEventListener('input', () => draw(inp.value.trim()));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown'){ e.preventDefault(); kbdIdx = Math.min(shown.length-1, kbdIdx+1); markKbd(); }
    else if (e.key === 'ArrowUp'){ e.preventDefault(); kbdIdx = Math.max(0, kbdIdx-1); markKbd(); }
    else if (e.key === 'Enter'){ e.preventDefault(); const it = shown[kbdIdx] || shown[0]; if (it && it.enabled){ onPick(it.hex); closePopover(); } }
    else if (e.key === 'Escape'){ closePopover(); anchorEl.focus(); }
  });
  draw('');
  setTimeout(() => inp.focus(), 0);
  _pop = { pop, anchorEl, onDoc:(ev)=>{ if (!pop.contains(ev.target) && ev.target !== anchorEl) closePopover(); } };
  setTimeout(() => document.addEventListener('mousedown', _pop.onDoc), 0);
}
function closePopover(){
  if (!_pop) return;
  document.removeEventListener('mousedown', _pop.onDoc);
  _pop.anchorEl.setAttribute('aria-expanded', 'false');
  _pop.pop.remove(); _pop = null;
}

// ---------------------------------------------------------------------------
// Review -> route to same-chain swap OR cross-chain wizard
// ---------------------------------------------------------------------------
async function onReview(){
  const { $ } = C; $('swErr').textContent = '';
  const q = LAST_QUOTE;
  if (!q){ $('swErr').textContent = 'Enter an amount to get a quote first.'; return; }
  if (q.kind === 'cross-make') return postCrossOfferReview(q);
  if (q.kind === 'ln') return reviewLn(q);
  if (q.kind === 'mixed') return reviewMixed(q);
  if (q.kind === 'cross') return reviewCross(q);
  if (q.kind === 'same' && q.place) return placeCovenantReview(q);
  return reviewSame(q);
}

// ===========================================================================
// Passive-CLOB covenant resting orders (the same-chain "Place order" path)
// ---------------------------------------------------------------------------
// Placing funds a byte-exact covenant UTXO and rests a signed offer on the relay;
// the order fills whenever it is crossed (by an online taker or the settler),
// permissionlessly, EVEN WHILE THIS WALLET IS OFFLINE — consensus rejects any
// underpay or redirect. When THIS wallet is the taker of an inbound match, it
// verifies the recipe trustlessly and broadcasts the FILL itself.
// ===========================================================================
let COMPANION = null;      // the `eltr` taproot Wollet that WATCHES + spends maker credits
let COVRELAY = null;       // the persistent openRelay handle (matched / order_status)
let PLACED = [];           // this wallet's covenant orders (persisted for cancel + resume)
const PLACED_KEY = 'seqobCovenantOrders.v1';

function loadPlaced(){ try { PLACED = JSON.parse(localStorage.getItem(PLACED_KEY) || '[]') || []; } catch { PLACED = []; } }
function savePlaced(){ try { localStorage.setItem(PLACED_KEY, JSON.stringify(PLACED)); } catch {} }
function nextMakerIndex(){
  let mx = -1; for (const r of PLACED){ if (typeof r.makerIndex === 'number' && r.makerIndex > mx) mx = r.makerIndex; }
  return mx + 1;   // a fresh taproot payout per order, so credits never collide
}

// The companion Wollet: the primary wallet is wpkh (BIP84) and does not track the
// taproot maker-credit payouts, so a second `eltr` (BIP86) Wollet watches them. It
// MUST be registered + scanned so a maker actually sees the funds it is paid.
function ensureCompanion(){
  if (COMPANION) return COMPANION;
  try { COMPANION = new C.wasm.Wollet(C.network, C.signer.covenantMakerDescriptor()); }
  catch { COMPANION = null; }
  return COMPANION;
}
async function scanCompanion(){
  const w = ensureCompanion(); if (!w) return;
  try { const u = await C.client.fullScan(w); if (u) w.applyUpdate(u); } catch {}
}

async function esplora(path, opts){ return C.esploraFetch(path, opts); }

// Fund a covenant spk: send `atoms` of asset A to the covenant address as an
// explicit output (the proven TxBuilder -> sign -> finalize -> broadcast path),
// then resolve the covenant vout by matching the spk on the broadcast tx.
async function fundCovenant(covAddr, spkHex, assetHex, atoms){
  const addr = new C.wasm.Address(covAddr);
  const pset = C.network.txBuilder()
    .addExplicitRecipient(addr, BigInt(atoms), new C.wasm.AssetId(assetHex))
    .feeRate(C.DEFAULT_FEERATE)
    .finish(C.wollet);
  const signed = C.signer.sign(pset);
  const finalized = C.wollet.finalize(signed);
  const t = await C.client.broadcast(finalized);
  const txid = (t && t.toString) ? t.toString() : String(t);
  const vout = await resolveVout(txid, spkHex);
  return { txid, vout };
}
async function resolveVout(txid, spkHex){
  const spk = (spkHex||'').toLowerCase();
  for (let i=0;i<20;i++){
    try {
      const res = await esplora(`/tx/${txid}`);
      if (res && res.ok){ const tx = await res.json();
        for (let v=0; v<(tx.vout||[]).length; v++){ if ((tx.vout[v].scriptpubkey||'').toLowerCase() === spk) return v; } }
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return 0;   // best-effort fallback; the taker's FILL re-verifies the spk before spending
}

// place: derive the covenant, get the maker payout (register the companion wollet
// so the credit is watchable), fund it on-chain, then sign + post the resting offer.
// The partial-fill dust floor for a placed order: the smallest lot a taker may fill AND the
// smallest remainder that may re-rest (planFill rejects a fill leaving a smaller remainder as
// dust-griefing). ~0.1% of the order (min 1 atom) — fine-grained enough that a market order fills
// almost all of the available book, coarse enough that no dust remainder is ever left.
function covenantMinLot(sellAtoms){ const s = BigInt(sellAtoms); const f = s / 1000n; return f > 0n ? f : 1n; }

async function placeCovenant(pay, receive, payAtoms, recvAtoms, onStatus){
  const tip = C.wollet.tip().height();
  const { rateNum, rateDen } = computeRate(payAtoms, recvAtoms);
  const idx = nextMakerIndex();
  const payout = makerPayout(C.signer, C.network, idx);   // { program, spkHex, address, internalKey, descriptor }
  ensureCompanion();                                      // so this wallet SEES the credit it is paid
  const minLot = covenantMinLot(payAtoms);                // PARTIAL-fillable (was all-or-nothing minLot==sell)
  const params = {
    assetA: pay, assetB: receive, sellAtoms: BigInt(payAtoms),
    rateNum, rateDen, minLot,                             // a taker may fill any lot >= minLot; the covenant re-rests the remainder
    expiryLocktime: orderExpiry(tip),
    makerProg: payout.program,                            // the taproot payout the FILL credits
    makerX: payout.internalKey,                           // wallet-derived x-only REFUND authoriser
  };
  const plan = planPlaceOrder(params);
  const covAddr = C.wasm.scriptToAddress(plan.spkHex, C.network);
  onStatus && onStatus('Funding the order on-chain…');
  const { txid, vout } = await fundCovenant(covAddr, plan.spkHex, pay, payAtoms);
  const covenant = buildCovenantTerms(plan.order, txid, vout, plan.tap);
  const offer = buildCovenantOffer({
    assetA: pay, assetB: receive, sellAtoms: BigInt(payAtoms), recvAtoms: BigInt(recvAtoms),
    covenant, makerPubkey: makerPubHex(), recvAddress: payout.address, offerId: seqob.randHex(16),
    allowPartial: true, minLot,                           // fill what crosses now; the covenant's remainder rests on
  });
  onStatus && onStatus('Posting your resting order…');
  await seqob.postCovenantOffer(offer, makerPriv());
  const rec = {
    offerId: offer.offer_id, pay, receive,
    sellAtoms: String(payAtoms), recvAtoms: String(recvAtoms),
    makerIndex: idx, covTxid: txid, covVout: vout, spkHex: plan.spkHex,
    expiry: params.expiryLocktime, created: Date.now(),
  };
  PLACED.push(rec); savePlaced();
  ensureCovenantRelay();   // watch for a match so we can settle / reflect a fill
  return rec;
}

// The taker FILL hooks for an inbound match: the credit asset is asset B, so the fee
// is paid in B too (never asset A — the covenant-fill host rejects that). Amounts are
// coin-selected from THIS wallet's own B + fee UTXOs by the wasm assembler.
function fillHooksFor(matched){
  const ct = matched.covenant || matched.Covenant || {};
  const assetB = String(ct.asset_b || ct.assetB || '').toLowerCase();
  const feeAsset = assetB || C.POLICY_HEX;
  return makeCovenantHooks({
    wasm: C.wasm, wollet: C.wollet, network: C.network, mnemonic: C.mnemonic,
    esploraFetch: C.esploraFetch,
    receiveAddress: covReceiveAddr,   // transparent by default (#6); blinded only if the user opted in
    fee: { asset: feeAsset, atoms: covFeeAtoms(feeAsset) },
    onStatus: (m) => { try { C.toast && C.toast(m); } catch {} },
  });
}
// A network-fee estimate in the given fee asset (open fee market): the native policy
// fee converted via the asset's published exchange rate (a valuable asset pays fewer).
function covFeeAtoms(feeAsset){
  try {
    const rate = (feeAsset === C.POLICY_HEX) ? BigInt(C.EXCHANGE_RATE_SCALE) : C.feeRateFor(feeAsset);
    const nativeFeeSats = (BigInt(C.DEFAULT_FEERATE) * EST_SWAP_VSIZE) / 1000n;
    return ceilDiv(nativeFeeSats * BigInt(C.EXCHANGE_RATE_SCALE), rate);
  } catch { return 1000n; }
}

// Reconstruct the exact covenant Order a local PLACED record placed, so its
// scriptPubKey / taptree re-derive byte-identically for the REFUND reclaim. Throws
// if the re-derived spk does not match the funded one (a corrupt/foreign record).
function orderFromPlaced(rec){
  const payout = makerPayout(C.signer, C.network, rec.makerIndex);
  const { rateNum, rateDen } = computeRate(BigInt(rec.sellAtoms), BigInt(rec.recvAtoms));
  const order = {
    assetA: rec.pay, assetB: rec.receive,
    rateNum, rateDen, minLot: BigInt(rec.sellAtoms),
    makerProg: payout.program, makerVer: 1,
    expiryLocktime: Number(rec.expiry), makerX: payout.internalKey,
  };
  return { order, payout };
}

// The maker REFUND hooks: reclaim an expired covenant's locked asset A. The fee is
// paid in the policy asset (universally accepted) from the wallet's own coins; the
// covenant asset A is never the fee asset here, so the reclaimed A is returned whole.
function refundHooksFor(){
  const feeAsset = C.POLICY_HEX;
  return makeCovenantHooks({
    wasm: C.wasm, wollet: C.wollet, network: C.network, mnemonic: C.mnemonic,
    esploraFetch: C.esploraFetch,
    receiveAddress: covReceiveAddr,   // transparent by default (#6); blinded only if the user opted in
    fee: { asset: feeAsset, atoms: covFeeAtoms(feeAsset) },
    onStatus: (m) => { try { C.toast && C.toast(m); } catch {} },
  });
}

// The persistent relay watcher over every market this wallet has a resting order on.
// onMatched -> this wallet is the taker: verify + FILL + broadcast. onOrderStatus ->
// our resting order was filled by someone else: rescan so the credit shows up.
function covMarkets(){
  const seen = new Set(), out = [];
  for (const r of PLACED){ const k = r.pay+'/'+r.receive; if (!seen.has(k)){ seen.add(k); out.push({ base_asset: r.pay, quote_asset: r.receive }); } }
  return out;
}
function ensureCovenantRelay(){
  const markets = covMarkets();
  if (!markets.length){ if (COVRELAY){ COVRELAY.close(); COVRELAY = null; } return; }
  if (COVRELAY){ for (const m of markets) COVRELAY.subscribe(m); return; }
  COVRELAY = seqob.openRelay(markets, {
    onMatched: (m) => { onCovMatched(m).catch(()=>{}); },
    onOrderStatus: (s) => { onCovOrderStatus(s).catch(()=>{}); },
    onError: () => {},
  });
}
async function onCovMatched(m){
  // Only settle covenant matches (interactive same-chain lifts go through seqob.lift).
  const isCov = m.resting_is_covenant === true || m.restingIsCovenant === true
    || m.resting_is_covenant === 'true' || m.restingIsCovenant === 'true';
  if (!isCov) return;
  try {
    C.toast && C.toast('Order matched — settling the fill on-chain…');
    const { txid } = await covSettleFill(m, fillHooksFor(m));
    C.toast && C.toast('Fill settled — anchor-bound to Bitcoin.',
      txid ? { href:'/explorer/tx/'+txid, label:String(txid).slice(0,18)+'…' } : undefined);
    await C.sync(); await scanCompanion(); try { renderSwap(); } catch {}
  } catch (e){ try { C.toast && C.toast('Fill could not settle: ' + C.prettyErr(e)); } catch {} }
}
async function onCovOrderStatus(s){
  // A resting order of ours moved (likely filled by a taker/settler): rescan the
  // companion wollet (which holds the credit) + the primary, and refresh the UI.
  await scanCompanion(); try { await C.sync(); } catch {}
  try { renderSwap(); } catch {}
}

// Called on wallet open: rehydrate placed orders + resume watching for fills. The
// covenant rests ON-CHAIN, so a fill can happen while the tab was closed; on reopen
// we rescan so any credit already received is reflected, and re-arm the watcher.
export function resumeCovenantOrders(){
  loadPlaced();
  ensureCompanion();
  scanCompanion().catch(()=>{});
  if (PLACED.length){ ensureCovenantRelay(); }
}

async function placeCovenantReview(q){
  const { $ } = C;
  const pay = q.pay, receive = q.receive, payAtoms = q.payAtoms, recvAtoms = q.recvAtoms;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const isMarket = S.mode !== 'post';
  const kv = [
    ['You pay', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You receive', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? `${isMarket ? 'Market · ' : 'Limit · '}1 ${pm.ticker} = ${trim(recvU/payU)} ${rm.ticker}` : '-'],
    ['How it fills', isMarket
      ? `Fills against the order book now at your price or better. If your order is larger than what's resting, the filled part settles on-chain and the unfilled remainder keeps resting at the same price until it's crossed — even while this wallet is closed. Consensus rejects any underpay or redirect.`
      : `Rests on-chain at your price and fills — fully or partially — whenever someone crosses it, even while this wallet is closed. A partial fill settles that part and leaves the rest resting. Consensus rejects any underpay or redirect.`],
    ['You can close the wallet', `The order rests on-chain; when it fills you are credited to a payout address only this wallet controls. Reopen any time to see it.`],
    ['If it does not fill', `Cancel any time to delist it. After the order expires the locked ${pm.ticker} is reclaimable on-chain.`],
    ['Finality', 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  // Market order bigger than the resting book at this price: show the fill-now / rest split honestly.
  const split = isMarket ? marketFillSplit(payAtoms, recvAtoms) : null;
  if (split) kv.splice(3, 0, ['Now / resting',
    `About ${C.fmtAtoms(split.fill, pm.precision)} ${pm.ticker} fills now against the book; the remaining ${C.fmtAtoms(split.rest, pm.precision)} ${pm.ticker} rests at your price until it's crossed.`]);
  const { m: modal, ok, st } = C.modalRows({ title: 'Place order', kv });
  if (ok) ok.textContent = 'Place order';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Funding the order on-chain…';
    try {
      const rec = await placeCovenant(pay, receive, payAtoms, recvAtoms,
        (msg) => { st.innerHTML = '<span class="spin"></span>' + esc(msg); });
      modal.remove();
      C.toast('Order placed — resting on-chain; it fills when matched, even offline.',
        rec.covTxid ? { href:'/explorer/tx/'+rec.covTxid, label:String(rec.covTxid).slice(0,18)+'…' } : undefined);
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not place order: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Mixed rails (one leg LN, one on-chain) — a SUBMARINE swap: the asset leg is an
// anchored on-chain HTLC, the BTC leg is Lightning, bound by one preimage. The LSP's
// POST /swap (payRail/recvRail) dispatches to seqob-cli xsubbuy/xsublift. Only the
// asset-on-chain <-> BTC-Lightning combos are deployed; the mirror combo (asset over
// LN + BTC on-chain) needs a BTC-on-chain HTLC submarine that is not built yet, so it
// fails closed with an honest message. Anchor-gated: the receive is NOT instant-final
// (that is the pure-LN rail) — it settles once the on-chain leg buries under Bitcoin.
async function reviewMixed(q){
  const { $ } = C;
  if (!L || !L.swap){ $('swErr').textContent = 'The mixed (Lightning + on-chain) route needs the Lightning service, which is unavailable in this build.'; return; }
  const am = C.assetMeta(q.seqAsset);
  const side = q.payIsBtc ? 'buy' : 'sell';            // buy the asset (pay BTC) / sell it (pay the asset)
  // Which leg is the ASSET, which is BTC.
  const assetLeg = q.payIsBtc ? q.recvRail : q.payRail;
  const btcLeg   = q.payIsBtc ? q.payRail : q.recvRail;
  // Two mixed shapes settle: the submarine (asset on-chain + BTC-LN), and its MIRROR the
  // sub-asset (asset over LN + BTC on-chain) — a BUY only, gated to pairs with a maker.
  const isSubAsset = (side === 'buy' && assetLeg === 'ln' && btcLeg === 'chain');
  // Sub-asset SELL: pay the asset over Lightning, receive BTC in an on-chain HTLC the wallet
  // claims with the maker-revealed preimage. Gated on live sell-side book liquidity.
  const isSubAssetSell = (side === 'sell' && assetLeg === 'ln' && btcLeg === 'chain');
  const isSubmarine = (assetLeg === 'chain' && btcLeg === 'ln');
  // Rail-agnostic (Stage 3): don't pre-block on a live maker (subassetCapable/sellCapable) — the
  // rail is a settlement preference. Any recognized mixed shape proceeds; the settlement router
  // decides + bridges on Place-order and fails closed CLEANLY (refundable) if there's no
  // counterparty. Only a genuinely unrecognized combo (should not reach here) is refused.
  if (!(isSubmarine || isSubAsset || isSubAssetSell)){
    $('swErr').textContent = `This rail combination isn't a recognized swap shape. Set both legs the same way, or one leg on-chain and one on Lightning.`;
    return;
  }
  // Inline channel provisioning (mirrors reviewLn): if the user PAYS a leg over Lightning
  // but has no usable channel for it, OPEN + FUND it now via the same non-custodial
  // provision+fund flow, then continue — fulfilling paintRailSegs' "one is opened for you
  // when you place the order" promise (the rail lights up like the asset Move-to-Lightning
  // flow). Fails CLOSED before any swap/HTLC step; never half-executes.
  if (q.payRail === 'ln' && L && L.provisionChannel){
    let ra0 = railAvail(S.payAsset, S.receiveAsset);
    if (!ra0.payLn.ok){
      const pm = metaOf(S.payAsset);
      const chain = S.payAsset === 'BTC' ? 'btc' : 'seq';
      const atoms = safeAtoms(C.$('swPayAmt').value, pm.precision || 0);
      if (atoms <= 0n){ $('swErr').textContent = 'Enter an amount so the Lightning channel can be sized.'; return; }
      try {
        $('swErr').textContent = '';
        await L.provisionChannel({ chain, asset: chain === 'seq' ? S.payAsset : undefined, ticker: pm.ticker,
          amount: Number(atoms), onProgress: (t) => { $('swStatus').className = 'status'; $('swStatus').innerHTML = '<span class="spin"></span>' + t; } });
        LNSTATUS = await L.status();
        $('swStatus').textContent = '';
      } catch (e){
        $('swStatus').textContent = '';
        $('swErr').textContent = 'Could not open your Lightning channel: ' + (e && e.message || e);
        return;
      }
      if (!railAvail(S.payAsset, S.receiveAsset).payLn.ok){
        $('swErr').textContent = 'Your Lightning channel opened but is not ready to trade yet — please try again in a moment.';
        return;
      }
    }
  }
  const amount = parseFloat((($('swPayAmt').value || '') + '').trim()) || null;
  const dir = isSubAsset
    ? `Buy ${am.ticker} with Bitcoin on-chain · receive ${am.ticker} over Lightning`
    : isSubAssetSell
    ? `Sell ${am.ticker} over Lightning · receive Bitcoin on-chain`
    : (side === 'buy'
      ? `Buy ${am.ticker} with Bitcoin over Lightning · receive ${am.ticker} on-chain`
      : `Sell ${am.ticker} on-chain · receive Bitcoin over Lightning`);
  const kv = isSubAssetSell ? [
    ['Route', 'Mixed rails · you pay ' + am.ticker + ' over Lightning and receive Bitcoin in an on-chain HTLC your device claims, bound by one preimage'],
    ['Direction', dir],
    ['Pricing', 'Best resting offer · you take a party who locks BTC on-chain for your ' + am.ticker + ' (a maker or any posted offer)'],
    ['Timing', 'You pay ' + am.ticker + ' over Lightning; the taker reveals the preimage on settle; your device claims the BTC on-chain with it.'],
    ['Finality', 'The BTC arrives in a Bitcoin on-chain HTLC your device claims (final to Bitcoin); the ' + am.ticker + ' leg is over Lightning.'],
    ['If it stalls', 'Nothing is lost · if the counterparty never settles, your Lightning payment auto-returns.'],
  ] : isSubAsset ? [
    ['Route', 'Mixed rails · you pay Bitcoin in an on-chain HTLC and receive the asset over Lightning, bound by one preimage'],
    ['Direction', dir],
    ['Pricing', 'Best resting sub-asset offer · whole-swap lift (the LP\'s fixed terms)'],
    ['Timing', 'The asset arrives over Lightning the moment the maker is paid; your BTC is claimed from its on-chain HTLC with the revealed preimage.'],
    ['Finality', 'The BTC leg is a Bitcoin on-chain HTLC (final to Bitcoin); the asset leg settles over Lightning.'],
    ['If it stalls', 'Nothing is lost · you reclaim the BTC HTLC after its on-chain timeout if the asset never arrives.'],
  ] : [
    ['Route', 'Mixed rails · one leg on Lightning, one anchored on-chain (a submarine swap, bound by one preimage)'],
    ['Direction', dir],
    ['Pricing', 'Best resting submarine offer · whole-HTLC lift (the LP\'s fixed terms)'],
    ['Timing', 'Anchor-gated: the on-chain HTLC must bury under Bitcoin before the Lightning leg settles — a few minutes, not instant.'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts) — not the instant-final of the pure-Lightning rail.'],
    ['If it stalls', 'Nothing is lost · each leg refunds after its own timeout.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Review mixed-rail swap', kv });
  ok.onclick = async () => {
    modal.remove();
    resetComposer();
    if (isSubAssetSell){
      // Sub-asset SELL: pay the asset over LN, then CLAIM the maker's BTC HTLC on-chain with the
      // revealed preimage (device claim key via the wasm's xchainBtcClaim). Persisted/resumable —
      // the claim is the fund step and must survive a reload.
      await startSell({ asset: q.seqAsset, amount, offer: q.sellOffer || null });
      return;
    }
    if (isSubAsset){
      // Sub-asset BUY: pay BTC in an on-chain HTLC, receive the asset over Lightning, bound by one
      // preimage the DEVICE owns. Persisted/resumable — the BTC HTLC is funded BEFORE /swap. Source
      // the best resting buy offer here (the composer's mixed-BUY quote doesn't attach one).
      const buyOffer = q.buyOffer || subassetOffers(q.seqAsset, 'buy')[0] || null;
      await startBuy({ asset: q.seqAsset, amount, offer: buyOffer });
      return;
    }
    // Hand off to the persisted, RESUMABLE submarine stepper. The on-chain HTLC leg
    // must survive a page reload (it is only recoverable via its CLTV timeout otherwise),
    // so from here the swap lives in localStorage + the trade-process view, not a modal.
    await startMixed({ side, asset: q.seqAsset, amount, payRail: q.payRail, recvRail: q.recvRail, payIsBtc: q.payIsBtc });
  };
}

// ===========================================================================
// Sub-asset SELL flow — pay the asset over Lightning, then CLAIM the counterparty's BTC HTLC
// on-chain with the maker-revealed preimage, using the device CLAIM key. FUND-CRITICAL: the
// on-chain claim is built by the wasm's xchainBtcClaim (the audited legacy-P2SH spend that
// mirrors the proven xchainBtcRefund) — never hand-rolled here. Flow: xchainBtcClaimPubkey ->
// /swap {side:sell, node_key, btc_claim_pub, offer_id?} -> {settled, preimage, btc_htlc} ->
// VERIFY the returned redeem_script by rebuilding it via xchainBtcHtlc -> xchainBtcClaim ->
// broadcast. Persisted/resumable (the claim is the fund step, must survive a reload).
// [Finalized + testnet-verified once xchainBtcClaim lands in the wasm — stubbed until then so
//  the rail is gated honestly and never half-executes a real BTC claim.]
const SELL_KEY = 'swk.subasset.sell';
let SELL = null;
function saveSell(){ try { localStorage.setItem(SELL_KEY, JSON.stringify(SELL)); } catch {} }
function clearSell(){ SELL = null; try { localStorage.removeItem(SELL_KEY); } catch {} }
// True while a sell is persisted with the preimage but its BTC claim is not yet confirmed —
// the claim is the FUND step, so it must survive a reload (resumeSell re-attempts it).
export function hasSellInFlight(){ return !!(SELL && SELL.state === 'claiming'); }

async function startSell(params){
  const { $ } = C;
  const asset = params.asset, am = C.assetMeta(asset);
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Selling ' + am.ticker + ' over Lightning'));
  const st = C.el('div','status'); card.appendChild(st);
  const act = C.el('div','row'); act.style.marginTop = '12px';
  const closeBtn = C.el('button','ghost','Close'); closeBtn.style.display = 'none'; closeBtn.onclick = () => modal.remove();
  act.appendChild(closeBtn); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  const say = (t, cls) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = (cls ? '' : '<span class="spin"></span>') + esc(t); };
  const done = () => { closeBtn.style.display = ''; };
  try {
    if (!(L && L.swap && L.assetNodeKey)) throw new Error('The Lightning service is unavailable in this build.');
    if (!(C.btcLeg && C.btcLeg.claim && C.btcLeg.claimKey && C.btcLeg.verifyClaimable)) throw new Error('The BTC claim service is unavailable in this build.');
    say('Preparing your sell…');
    const btc_claim_pub = C.btcLeg.claimKey().public_key;   // the device claim key; only we can claim
    const node_key = await L.assetNodeKey(asset);           // our own hosted asset node pays over LN
    const offer = params.offer || null;
    // Bring our asset LN node's device signer ONLINE — a per-user node isn't auto-connected on
    // load, and the LSP needs it serving to command the pay. Idempotent (re-attaches, no re-fund).
    if (L.connectNode){
      say('Bringing your ' + am.ticker + ' Lightning node online…');
      const prov = await L.connectNode(asset);
      if (!(prov && prov.connected)) throw new Error('Could not bring your ' + am.ticker + ' Lightning node online — reopen the wallet and try again.');
    }
    // Pay the asset over Lightning (LSP drives the hold-invoice pay from our node; device co-signs).
    // On settle the maker reveals the preimage, returned here WITH the BTC HTLC terms — the LSP
    // never claims (no claim key) and we claim on-chain ourselves.
    say('Paying ' + am.ticker + ' over Lightning…');
    const resp = await L.swap({ side: 'sell', asset, node_key, btc_claim_pub, amount: params.amount,
      // State the rails EXPLICITLY (asset over Lightning, BTC on-chain) so the LSP routes this to
      // the sub-asset sell (xsubas-sell) rather than defaulting omitted rails to pure-LN (xpln).
      payRail: 'ln', recvRail: 'chain',
      offer_id: offer && offer.offer_id, maker_pubkey: offer && offer.maker_pubkey });
    if (!(resp && resp.settled && resp.preimage && resp.btc_htlc)) throw new Error(resp && resp.error ? resp.error : 'The sell did not settle over Lightning.');
    const H = resp.btc_htlc;
    // Persist BEFORE the on-chain claim: the asset is now paid, so the BTC claim is the fund step
    // and MUST survive a reload — resumeSell() re-attempts it from here.
    SELL = { state: 'claiming', asset, ticker: am.ticker, preimage: resp.preimage, hash_h: resp.hash_h, btc_htlc: H, ts: mixedTip() }; saveSell();
    say('Preimage revealed — verifying and claiming your BTC on-chain…');
    await claimSell();   // verify + claim; updates SELL + st
    say('Done. You paid ' + am.ticker + ' over Lightning and claimed BTC on-chain (' + String(SELL.claim_txid || '').slice(0,16) + '…).', 'ok');
    done();
    try { await C.sync(); } catch {}
    clearSell();
  } catch (e){
    // If the asset was already paid (SELL persisted), keep it for re-claim on reload — never lose it.
    say('Failed: ' + C.prettyErr(e) + (SELL && SELL.state === 'claiming' ? ' — your BTC is still claimable; reopen the wallet to retry the claim.' : ''), 'err');
    done();
  }
}
// Verify the maker's BTC HTLC binds our claim key + H, then claim it on-chain with the preimage.
// Idempotent-ish: a duplicate claim of an already-spent HTLC just errors, which we surface.
async function claimSell(){
  const H = SELL.btc_htlc;
  await C.btcLeg.verifyClaimable({ redeem_script: H.redeem_script, hash_h: SELL.hash_h,
    claim_pub: H.taker_claim_pubkey, maker_refund_pub: H.maker_refund_pubkey, t_btc: H.t_btc,
    preimage: SELL.preimage, txid: H.txid, vout: H.vout, amount: H.amount });
  const claimTxid = await C.btcLeg.claim({ txid: H.txid, vout: H.vout, amount: H.amount, redeem_script: H.redeem_script, preimage: SELL.preimage });
  SELL.state = 'done'; SELL.claim_txid = (claimTxid && claimTxid.toString) ? claimTxid.toString() : String(claimTxid); saveSell();
  logTrade({ id: 'sell:' + (SELL.hash_h || SELL.claim_txid || ''), title: 'Sold ' + SELL.ticker + ' for BTC', status: 'BTC claimed', txid: SELL.claim_txid });
}
// On wallet load: if a sell paid the asset but its BTC claim never confirmed, re-attempt the
// claim (the preimage + HTLC terms are persisted). This is the fund-recovery path.
export async function resumeSell(){
  try { SELL = JSON.parse(localStorage.getItem(SELL_KEY) || 'null'); } catch { SELL = null; }
  if (!SELL || SELL.state !== 'claiming' || !SELL.preimage || !SELL.btc_htlc) return;
  try { await claimSell(); try { C.toast && C.toast('Recovered your sell — BTC claimed on-chain (' + String(SELL.claim_txid||'').slice(0,16) + '…).'); } catch {} try { await C.sync(); } catch {} clearSell(); }
  catch (e){ /* leave persisted; the HTLC may already be claimed, or needs a retry — surfaced when the user re-enters Swap */ }
}
// ===========================================================================
// Sub-asset BUY flow — the MIRROR of the sub-asset SELL, roles flipped. The taker pays BTC in an
// ON-CHAIN HTLC and receives the asset over LIGHTNING, bound by ONE preimage the DEVICE owns.
// The device generates P/H, registers a HODL invoice on H at its OWN hosted asset node (no
// bolt11 — the maker pays H BY HASH), FUNDS a BTC HTLC on H (maker claims with P, device refunds
// after T_btc), then commands the LSP to drive the maker's pay-by-hash. Once the asset payment is
// HELD at the device's node, the device SETTLES with P — releasing the asset to itself AND
// revealing P so the maker claims the BTC. FUND-CRITICAL: the BTC HTLC is locked BEFORE /swap, so
// BUY is persisted+resumable; resumeBuy() settles (asset in) once held, or refunds the BTC after
// T_btc. INVARIANT: the LSP/maker are BLIND to P until the device settles; the maker claims BTC
// with its identity key (seqdex 2152f33). BUY and SELL stay on SEPARATE books (ln_direction 5 vs 4).
const BUY_KEY = 'swk.subasset.buy';
let BUY = null;
function saveBuy(){ try { localStorage.setItem(BUY_KEY, JSON.stringify(BUY)); } catch {} }
function clearBuy(){ BUY = null; try { localStorage.removeItem(BUY_KEY); } catch {} }
// True while a buy has FUNDED its BTC HTLC but is not yet settled/refunded — the BTC is locked, so
// the record must survive a reload (resumeBuy settles on hold, or refunds after T_btc).
export function hasBuyInFlight(){ return !!(BUY && (BUY.state === 'funded' || BUY.state === 'holding')); }
// T_btc safety delta over the current BTC tip (parent-chain blocks), matching the maker's
// BtcLocktimeDelta so the refund branch matures well after the swap should have settled.
const BUY_CLTV_DELTA = 100;

async function startBuy(params){
  const { $ } = C;
  const asset = params.asset, am = C.assetMeta(asset);
  const offer = params.offer || null;
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Buying ' + am.ticker + ' over Lightning'));
  const st = C.el('div','status'); card.appendChild(st);
  const act = C.el('div','row'); act.style.marginTop = '12px';
  const closeBtn = C.el('button','ghost','Close'); closeBtn.style.display = 'none'; closeBtn.onclick = () => modal.remove();
  act.appendChild(closeBtn); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  const say = (t, cls) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = (cls ? '' : '<span class="spin"></span>') + esc(t); };
  const done = () => { closeBtn.style.display = ''; };
  try {
    if (!(L && L.swap && L.assetNodeKey && L.nodeInvoice && L.invoiceStatus && L.nodeSettle)) throw new Error('The Lightning service is unavailable in this build.');
    if (!(C.btcLeg && C.btcLeg.fund && C.btcLeg.refund && C.btcLeg.refundKey && C.btcLeg.tipHeight)) throw new Error('The BTC HTLC service is unavailable in this build.');
    if (!(C.wasm && C.wasm.generateSwapSecret && C.wasm.buildSeqHtlcRedeemScript)) throw new Error('The HTLC builder is unavailable in this build.');
    const makerClaimPub = offer && (offer.maker_claim_pub || offer.maker_claim_pubkey);
    if (!offer || !makerClaimPub) throw new Error('No resting ' + am.ticker + ' buy offer right now — try again shortly.');
    say('Preparing your buy…');
    // 1. DEVICE generates the secret. Only we ever hold P until WE settle.
    const sec = C.wasm.generateSwapSecret();            // { secret_hex, hash_hex }
    const H = sec.hash_hex, P = sec.secret_hex;
    const node_key = await L.assetNodeKey(asset);       // our OWN hosted asset node RECEIVES the asset over LN
    const assetAtoms = Number(offer.asset_amount);      // whole-offer lift at the maker's fixed terms
    const btcSats = Number(offer.btc_sats);
    // Bring our asset LN node's device signer ONLINE so it can register + settle the HODL invoice.
    if (L.connectNode){
      say('Bringing your ' + am.ticker + ' Lightning node online…');
      const prov = await L.connectNode(asset);
      if (!(prov && prov.connected)) throw new Error('Could not bring your ' + am.ticker + ' Lightning node online — reopen the wallet and try again.');
    }
    // Ensure inbound asset liquidity so the maker can pay us over LN (JIT 0-conf; idempotent, best-effort).
    if (L.channelInbound){ say('Preparing inbound Lightning liquidity…'); try { await L.channelInbound({ node_key, asset, amount: assetAtoms }); } catch {} }
    // 2. Register a HODL invoice on H at our OWN node (NO bolt11; the maker pays H BY HASH). Device keeps P.
    say('Registering the Lightning invoice on your node…');
    const inv = await L.nodeInvoice({ node_key, asset, amount: assetAtoms, payment_hash: H });
    if (!(inv && (inv.payment_hash || inv.hodl))) throw new Error('Could not register the Lightning invoice on your node.');
    // 3. Build + FUND the BTC HTLC on H: maker claims with P, device refunds after T_btc (the PROVEN
    //    xswap.js:689-695 engine, roles flipped). T_btc = max(offer.onchain_cltv, tip + delta).
    const refund = C.btcLeg.refundKey();                // device refund key; only we can refund
    const tip = await C.btcLeg.tipHeight();
    const T_btc = Math.max(Number(offer.onchain_cltv || 0), tip + BUY_CLTV_DELTA);
    const redeem = C.wasm.buildSeqHtlcRedeemScript(H, makerClaimPub, refund.public_key, T_btc);
    say('Locking your Bitcoin in the on-chain HTLC…');
    const funded = await C.btcLeg.fund(redeem, btcSats);   // { txid, vout, height, amount }
    const btc_htlc = { txid: String(funded.txid), vout: funded.vout, amount: btcSats,
      redeem_script: redeem, cltv: T_btc, maker_claim_pub: makerClaimPub, taker_refund_pub: refund.public_key };
    // PERSIST BEFORE /swap: the BTC is now locked, so this record is the ONLY recovery handle.
    BUY = { state: 'funded', asset, ticker: am.ticker, preimage: P, hash_h: H, node_key, btc_htlc,
      t_btc: T_btc, asset_amount: assetAtoms, offer_id: offer.offer_id, maker_pubkey: offer.maker_pubkey, ts: mixedTip() };
    saveBuy();
    logTrade({ id: 'buy:' + H, title: 'Buying ' + am.ticker + ' with BTC', status: 'BTC locked' });
    // 4. Command the LSP to drive the maker's pay-by-hash (ASYNC job -> 202 { job_id, poll, held:false }).
    say('Asking the maker to pay you ' + am.ticker + ' over Lightning…');
    const job = await L.swap({ side: 'buy', hodl: true, asset, node_key, payment_hash: H, asset_amount: assetAtoms,
      payRail: 'chain', recvRail: 'ln', btc_htlc, offer_id: offer.offer_id, maker_pubkey: offer.maker_pubkey });
    BUY.job_id = job && (job.job_id || job.jobId); BUY.poll = job && job.poll; saveBuy();
    // 5. Wait for the maker's asset payment to arrive HELD, then DEVICE-SETTLE with P (or refund after T_btc).
    say('Waiting for the maker’s ' + am.ticker + ' payment to arrive…');
    await driveBuy(say);
    if (BUY && BUY.state === 'settled'){ say('Done. Your BTC bought ' + am.ticker + ' — received over Lightning.', 'ok'); done(); try { await C.sync(); } catch {} clearBuy(); }
    else if (BUY && BUY.state === 'refunded'){ say('The maker didn’t pay in time — your Bitcoin was refunded on-chain (' + String(BUY.refund_txid||'').slice(0,16) + '…).', 'ok'); done(); try { await C.sync(); } catch {} clearBuy(); }
    else { done(); }
  } catch (e){
    // If the BTC HTLC was already funded (BUY persisted), keep it for settle/refund on reload — never lose it.
    say('Failed: ' + C.prettyErr(e) + (BUY && (BUY.state === 'funded' || BUY.state === 'holding') ? ' — your Bitcoin is still locked; reopen the wallet to finish or refund it.' : ''), 'err');
    done();
  }
}
// Poll the HODL invoice on our node until the maker's asset payment is HELD, then device-settle with
// P (releases the asset to us AND reveals P so the maker claims the BTC), then best-effort confirm the
// LSP job settled. Bounded by T_btc: if the asset never holds before the BTC HTLC times out, refund
// the BTC (the ONLY loss-avoiding path). Shared by startBuy and resumeBuy. Mutates + persists BUY.
async function driveBuy(say){
  say = say || (() => {});
  const H = BUY.hash_h, node_key = BUY.node_key;
  // Resume-after-crash-before-swap: if we funded the BTC but never commanded the LSP, (re)issue it.
  if (!BUY.job_id && BUY.btc_htlc){
    try {
      const job = await L.swap({ side: 'buy', hodl: true, asset: BUY.asset, node_key, payment_hash: H,
        asset_amount: BUY.asset_amount, payRail: 'chain', recvRail: 'ln', btc_htlc: BUY.btc_htlc,
        offer_id: BUY.offer_id, maker_pubkey: BUY.maker_pubkey });
      BUY.job_id = job && (job.job_id || job.jobId); BUY.poll = job && job.poll; saveBuy();
    } catch {}   // never mind — the refund guard below still protects the funds
  }
  for (;;){
    let tip = 0; try { tip = await C.btcLeg.tipHeight(); } catch {}
    const status = await L.invoiceStatus({ node_key, payment_hash: H }).catch(() => null);
    if (status && status.settled){ BUY.state = 'settled'; saveBuy(); return; }   // already settled (resume)
    if (status && status.held){
      BUY.state = 'holding'; saveBuy();
      say('Payment received — releasing your ' + BUY.ticker + ' and revealing the preimage…');
      await L.nodeSettle({ node_key, payment_hash: H, preimage: BUY.preimage });   // 5. device-settle
      BUY.state = 'settled'; saveBuy();
      logTrade({ id: 'buy:' + H, title: 'Bought ' + BUY.ticker + ' with BTC', status: 'asset received' });
      // 6. best-effort: confirm the maker claimed the BTC (job settled). Non-fatal.
      if (L.jobStatus && (BUY.poll || BUY.job_id)){ try { const j = await L.jobStatus(BUY.poll || ('/swap/' + BUY.job_id)); if (j && j.status) { BUY.detail = j.status; saveBuy(); } } catch {} }
      return;
    }
    if (tip && BUY.t_btc && tip >= BUY.t_btc){ say('The maker didn’t pay in time — refunding your Bitcoin on-chain…'); await refundBuy(); return; }   // 7. refund branch
    await new Promise(r => setTimeout(r, 6000));
  }
}
// Refund the funded BTC HTLC via its CLTV branch after T_btc (a real on-chain reclaim). Terminal.
async function refundBuy(){
  const H = BUY.btc_htlc;
  const txid = await C.btcLeg.refund({ txid: H.txid, vout: H.vout, amount: H.amount, redeem_script: H.redeem_script, locktime: BUY.t_btc });
  BUY.state = 'refunded'; BUY.refund_txid = (txid && txid.toString) ? txid.toString() : String(txid); saveBuy();
  logTrade({ id: 'buy:' + (BUY.hash_h || ''), title: 'Buy refunded (' + BUY.ticker + ')', status: 'BTC refunded', txid: BUY.refund_txid });
}
// On wallet load: if a buy funded its BTC HTLC but never completed, resume it — settle if the asset
// is now held, or refund the BTC once past T_btc. The fund-recovery path (mirrors resumeSell).
export async function resumeBuy(){
  try { BUY = JSON.parse(localStorage.getItem(BUY_KEY) || 'null'); } catch { BUY = null; }
  if (!BUY || !(BUY.state === 'funded' || BUY.state === 'holding') || !BUY.preimage || !BUY.btc_htlc) return;
  try {
    await driveBuy();
    if (BUY.state === 'settled'){ try { C.toast && C.toast('Recovered your buy — ' + BUY.ticker + ' received over Lightning.'); } catch {} try { await C.sync(); } catch {} clearBuy(); }
    else if (BUY.state === 'refunded'){ try { C.toast && C.toast('Your buy timed out — Bitcoin refunded on-chain (' + String(BUY.refund_txid||'').slice(0,16) + '…).'); } catch {} try { await C.sync(); } catch {} clearBuy(); }
  } catch (e){ /* leave persisted; the BTC is still refundable at T_btc — retried when the user re-enters Swap */ }
}
// ===========================================================================
// Mixed-rail (submarine) swap — PERSISTED + RESUMABLE trade-process view.
// The asset leg is an anchored on-chain HTLC; if the swap stalls the ONLY recovery is
// to refund that HTLC after its CLTV timeout. So (like the cross-chain wizard) the
// in-flight swap is persisted to localStorage and resumed on load, with a live "Refund
// BTC leg" off-ramp — never a fire-and-forget modal that a refresh strands.
// ===========================================================================
function saveMixed(){ try { sub.saveSwap(localStorage, MIXED_KEY, MIXED); } catch {} }
function clearMixed(){ MIXED = null; try { sub.clearSwap(localStorage, MIXED_KEY); } catch {} }
// True while a submarine swap is persisted and NOT terminal — the composer resumes the
// stepper (instead of the composer) on tab entry, exactly like the cross-chain wizards.
export function hasMixedInFlight(){ return !!MIXED && !sub.isTerminal(MIXED); }
// The Sequentia tip height, against which the asset-leg HTLC's CLTV refund locktime is
// judged (the asset HTLC is on Sequentia; its refund matures at that height).
function mixedTip(){ try { return C.wollet ? C.wollet.tip().height() : 0; } catch { return 0; } }

// Start (and drive) a submarine swap: persist a live record FIRST (so a refresh mid-call
// still resumes), show the stepper, then command the LSP and fold the result back in.
async function startMixed(params){
  MIXED = sub.newSwap(params); saveMixed();
  showMixed(true); renderMixedSwap();
  try {
    const r = await L.swap({ side: params.side, asset: params.asset, amount: params.amount,
      payRail: params.payRail, recvRail: params.recvRail });
    MIXED = sub.applyStatus(MIXED, r || {}); saveMixed();
    renderMixedSwap();
    if (!sub.isTerminal(MIXED)) pollMixed();
    else if (MIXED.state === sub.ST.SETTLED){
      try { C.toast(`Mixed swap settled · anchor-bound to Bitcoin${MIXED.preimage ? ` · preimage ${String(MIXED.preimage).slice(0, 16)}…` : ''}`); } catch {}
      try { await C.sync(); } catch {}
    }
  } catch (e){
    // A thrown swap: if an on-chain HTLC leg exists it stays SETTLING (refundable at its
    // timeout); with no leg to reclaim it is a clean failure.
    if (MIXED && MIXED.htlc){ MIXED = { ...MIXED, detail: C.prettyErr(e) }; saveMixed(); pollMixed(); }
    else { MIXED = sub.markFailed(MIXED, C.prettyErr(e)); saveMixed(); }
    renderMixedSwap();
  }
}

// Poll the LSP for the swap's progress until terminal (best-effort: needs L.swapStatus).
let _mixedPoll = null;
function pollMixed(){
  if (!MIXED || sub.isTerminal(MIXED) || !(L && L.swapStatus)) return;
  clearTimeout(_mixedPoll);
  _mixedPoll = setTimeout(async () => {
    if (!MIXED || sub.isTerminal(MIXED)) return;
    try {
      const r = await L.swapStatus(MIXED.id);
      MIXED = sub.applyStatus(MIXED, r || {}); saveMixed(); renderMixedSwap();
      if (MIXED.state === sub.ST.SETTLED){ try { await C.sync(); } catch {} }
    } catch {}
    if (!sub.isTerminal(MIXED)) pollMixed();
  }, 8000);
}

// Show/hide the submarine stepper (mutually exclusive with the composer + the other
// wizard hosts), mirroring showCross/showReverse.
function showMixed(on){
  const mw = C.$('swapMixedWrap'), cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (mw) mw.classList.toggle('hide', !on);
  if (on){ if (cw) cw.classList.add('hide'); if (rw) rw.classList.add('hide'); }
  if (comp) comp.classList.toggle('hide', on);
}

// The trade-process view for the in-flight submarine swap: the phase, the on-chain HTLC
// leg, a "Refund BTC leg" off-ramp (live once the HTLC's CLTV timeout is buried), and an
// Abandon/Clear. Rendered on start AND on resume-after-reload.
function renderMixedSwap(){
  const host = C.$('swMixedStepper'); if (!host || !MIXED) return;
  const am = metaOf(MIXED.asset);
  const terminal = sub.isTerminal(MIXED);
  const tip = mixedTip();
  const refundable = sub.isRefundable(MIXED, tip);
  if (terminal) logTrade({ id: 'mx:' + (MIXED.id || MIXED.ts || (MIXED.htlc && MIXED.htlc.refund_locktime) || ''),
    title: (MIXED.side === 'buy' ? 'Bought ' : 'Sold ') + metaOf(MIXED.asset).ticker + ' · submarine', status: MIXED.state });
  const phase = {
    [sub.ST.SETTLING]:  'Settling — the on-chain HTLC leg is burying under Bitcoin (anchor-gated).',
    [sub.ST.REFUNDING]: 'Refunding the on-chain HTLC leg…',
    [sub.ST.REFUNDED]:  'Refunded — the on-chain HTLC leg was reclaimed; your funds are back.',
    [sub.ST.SETTLED]:   'Settled — anchor-bound to Bitcoin (reverts only if Bitcoin reverts).',
    [sub.ST.FAILED]:    'Failed — nothing further to reclaim on-chain.',
  }[MIXED.state] || MIXED.state;
  const dir = MIXED.side === 'buy'
    ? `Buy ${esc(am.ticker)} with BTC over Lightning · receive ${esc(am.ticker)} on-chain`
    : `Sell ${esc(am.ticker)} on-chain · receive BTC over Lightning`;
  const lock = MIXED.htlc && MIXED.htlc.refund_locktime;
  const legLine = MIXED.htlc
    ? (refundable
        ? `On-chain HTLC leg is past its refund timeout (block ${lock}) — reclaimable now.`
        : `On-chain HTLC leg refundable after block ${lock}${tip ? ` (tip ${tip})` : ''}.`)
    : 'The LSP is driving both legs; no separate on-chain leg to reclaim.';
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">${dir}</span>
      <span class="sub">${esc(phase)}</span></div>
    <div class="swbook-row"><span class="sub">${esc(legLine)}${MIXED.detail && !terminal ? ' · ' + esc(MIXED.detail) : ''}</span></div>
    <div class="swbook-row" id="swMixedBtns"></div></div>`;
  const btns = C.$('swMixedBtns');
  if (MIXED.htlc && !terminal && MIXED.state !== sub.ST.REFUNDING){
    const rb = C.el('button', 'danger', 'Refund BTC leg'); rb.id = 'swMixedRefund';
    rb.disabled = !refundable;
    if (!refundable) rb.title = `The on-chain HTLC leg is only refundable after its CLTV timeout (block ${lock}).`;
    rb.onclick = onRefundMixed;
    btns.appendChild(rb);
  }
  const done = terminal;
  const clr = C.el('button', 'ghost', done ? 'Clear' : 'Dismiss');
  clr.onclick = () => {
    // Dismiss only HIDES a live swap (it keeps recovering + resumes; the Active-trades card
    // reopens it); Clear drops a terminal one. The _dismissed flag stops renderSwap from
    // bouncing straight back to this stepper.
    if (done) clearMixed(); else _dismissed.add('mixed');
    showMixed(false); renderSwap();
  };
  btns.appendChild(clr);
}

// Refund the on-chain HTLC leg after its CLTV timeout (a real on-chain reclaim). Mirrors
// xswap.js onRefundBtc: mark refunding, broadcast via the refund hook, mark refunded.
async function onRefundMixed(){
  if (!MIXED || !MIXED.htlc){ return; }
  if (!sub.isRefundable(MIXED, mixedTip())){
    try { C.toast('The on-chain HTLC leg is not refundable until its CLTV timeout is buried.'); } catch {}
    return;
  }
  const kv = [
    ['Network', '⚠ Refunding the on-chain HTLC leg via its CLTV branch (anchor-bound).'],
    ['Refund amount', (MIXED.htlc.amount != null ? MIXED.htlc.amount + ' base units' : 'the locked HTLC amount') + ' (minus the refund tx fee)'],
    ['After this', 'The swap is terminal (refunded); the Lightning leg unwinds on its own hold timeout.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Refund the on-chain leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Refunding the on-chain HTLC leg…';
    MIXED = sub.markRefunding(MIXED); saveMixed(); renderMixedSwap();
    try {
      let txid = null;
      if (L && L.refund) txid = await L.refund({ id: MIXED.id, htlc: MIXED.htlc });
      MIXED = sub.markRefunded(MIXED, txid); saveMixed();
      modal.remove();
      C.toast(txid ? `On-chain HTLC leg refunded: ${String(txid).slice(0, 18)}…` : 'On-chain HTLC leg refund broadcast.');
      try { await C.sync(); } catch {}
      renderMixedSwap();
    } catch (e){
      // Refund failed: revert to SETTLING so the off-ramp stays available to retry.
      MIXED = { ...MIXED, state: sub.ST.SETTLING }; saveMixed();
      st.className = 'status err'; st.textContent = 'Refund failed: ' + C.prettyErr(e); ok.disabled = false;
      renderMixedSwap();
    }
  };
}

// On wallet open: rehydrate any non-terminal submarine swap so its trade-process view +
// Refund off-ramp come back after a reload (fund-safety). Mirrors resumeCrossMakers.
export function resumeMixedSwap(){
  MIXED = sub.resume(localStorage, MIXED_KEY);
  if (!MIXED) return;
  try { showMixed(true); renderMixedSwap(); } catch {}
  if (!sub.isTerminal(MIXED)) pollMixed();
  if (C.toast) try { C.toast('Resuming an interrupted Lightning+on-chain swap — refund the on-chain leg here if it stalls.'); } catch {}
}

// Start a CROSS market from the wallet: post a signed forward cross offer (SELL
// the asset for BTC) and serve lifts over the courier (the maker HTLC runs in
// xmaker.js via the X.makerStart bridge). Unlike same-chain, cross settlement is
// interactive: the wallet must stay open to settle a lift (Bitcoin has no
// covenants). The offer rests only while the listener is open.
async function postCrossOfferReview(q){
  const { $ } = C;
  const reverse = !!q.reverse;   // reverse = BUY the asset with BTC; else SELL the asset for BTC
  const start = reverse ? (X && X.makerStartReverse) : (X && X.makerStart);
  if (!X || !start){ $('swErr').textContent = 'Cross-chain making is unavailable in this build.'; return; }
  const assetHex = q.assetHex;
  const am = C.assetMeta(assetHex);
  // SELL: pay = asset, receive = BTC.  BUY: pay = BTC, receive = asset.
  let assetAtoms, btcSats;
  try {
    if (reverse){
      btcSats    = C.parseAtoms(($('swPayAmt').value || '').trim(), 8);
      assetAtoms = C.parseAtoms(($('swRecvAmt').value || '').trim(), am.precision || 0);
    } else {
      assetAtoms = C.parseAtoms(($('swPayAmt').value || '').trim(), am.precision || 0);
      btcSats    = C.parseAtoms(($('swRecvAmt').value || '').trim(), 8);
    }
    if (assetAtoms <= 0n || btcSats <= 0n) throw 0;
  } catch { $('swErr').textContent = `Enter both amounts - the ${am.ticker} and the BTC.`; return; }
  if (reverse){
    const haveBtc = balAtoms('BTC');
    if (btcSats > haveBtc){ $('swErr').textContent = `You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`; return; }
  } else {
    const onc = balAtoms(assetHex), lnHeld = instantAtomsFor(assetHex);
    if (assetAtoms > onc){
      // A resting CROSS offer locks the asset in an ON-CHAIN HTLC, so it needs on-chain funds. If the
      // only reason for the shortfall is that the asset sits in Lightning, say that plainly rather than
      // a bare "you only hold" that reads wrong when a Lightning balance is visible.
      $('swErr').textContent = (lnHeld > 0n && (onc + lnHeld) >= assetAtoms)
        ? `Posting a resting cross-chain offer locks ${am.ticker} in an on-chain HTLC, but ${C.fmtAtoms(lnHeld, am.precision)} ${am.ticker} of yours is in Lightning and only ${C.fmtAtoms(onc, am.precision)} is on-chain. Move some ${am.ticker} back on-chain to post this on-chain, or use a Lightning rail (coming soon for this direction).`
        : `You only hold ${C.fmtAtoms(onc, am.precision)} ${am.ticker}.`;
      return;
    }
  }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = reverse ? [
    ['Posting', `A resting CROSS bid - you become the maker of the ${am.ticker}/BTC market`],
    ['You pay', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['You buy', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['How it settles', 'You lock BTC in an HTLC; a taker locks the asset; you verify anchoring, claim the asset (revealing the secret); the taker claims your BTC. Atomic - anchor-bound.'],
    ['Keep this tab open', 'Cross-chain settlement is interactive: your wallet must be open to settle a lift. Closing it un-rests the offer; nothing is at risk (a stalled lock refunds after its timeout).'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ] : [
    ['Posting', `A resting CROSS offer - you become the maker of the ${am.ticker}/BTC market`],
    ['You sell', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['You want', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['How it settles', 'A taker pays BTC; you lock the asset in an HTLC; they claim it revealing the secret; you claim the BTC. Atomic - anchor-bound.'],
    ['Keep this tab open', 'Cross-chain settlement is interactive: your wallet must be open to settle a lift. Closing it un-rests the offer; nothing is at risk.'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: reverse ? 'Buy with BTC - start this market' : 'Sell for BTC - start this market', kv });
  if (ok) ok.textContent = reverse ? 'Post cross bid' : 'Post cross offer';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Signing + posting…';
    try {
      const recvAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
      const handle = await start({ assetHex, assetAtoms, btcSats, expirySecs: 3600, recvAddr }, onCrossMakeState);
      XMAKE = { handle, assetHex, assetAtoms, btcSats, reverse, offerId: handle.offer.offer_id, state: 'resting' };
      modal.remove();
      C.toast('Cross offer posted - live in the order book. Keep this tab open to settle.');
      resetComposer();
      renderXMake();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not post: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Settlement-progress callback for a live wallet-made cross offer (drives the
// resting-order panel through lift -> lock -> settled).
function onCrossMakeState(mst){
  if (!XMAKE) return;
  XMAKE.state = mst.state; XMAKE.detail = mst;
  renderXMake();
}

// Render the wallet's live resting cross order + its settlement progress.
function renderXMake(){
  const host = C.$('swMyOrders'); if (!host) return;
  if (!XMAKE){ return; }   // leave same-chain "your orders" render intact when no cross make
  const am = C.assetMeta(XMAKE.assetHex);
  const phases = XMAKE.reverse ? {
    resting:'Resting - waiting for a taker', terms:'A taker is lifting…', btc_locked:'You locked BTC - waiting for the taker to lock the asset…',
    seq_verified:'Asset locked - verifying anchoring…', settled:'Settled - you bought the asset for BTC',
    refunding:'Stalled - refunding your BTC…', refunded:'Refunded - the swap stalled; your BTC is back',
  } : {
    resting:'Resting - waiting for a taker', terms:'A taker is lifting…', btc_verified:'Taker funded BTC - locking your asset…',
    seq_locked:'Asset locked - waiting for the taker to claim…', secret_learned:'Taker claimed; claiming your BTC…',
    settled:'Settled - you sold the asset for BTC', refunded:'Refunded - the swap stalled; your asset is back',
  };
  const label = phases[XMAKE.state] || XMAKE.state;
  const done = XMAKE.state === 'settled' || XMAKE.state === 'refunded';
  if (done) logTrade({ id: 'xm:' + (XMAKE.offerId || ''),
    title: (XMAKE.reverse ? 'Sold ' : 'Bought ') + (C.assetMeta(XMAKE.assetHex).ticker || 'asset') + ' · cross-chain', status: XMAKE.state });
  const headline = XMAKE.reverse
    ? `Your resting cross bid · buy ${esc(C.fmtAtoms(XMAKE.assetAtoms, am.precision))} ${esc(am.ticker)} for ${esc(C.fmtAtoms(XMAKE.btcSats,8))} BTC`
    : `Your resting cross offer · sell ${esc(C.fmtAtoms(XMAKE.assetAtoms, am.precision))} ${esc(am.ticker)} for ${esc(C.fmtAtoms(XMAKE.btcSats,8))} BTC`;
  const resumed = !!XMAKE.resumed;
  const note = resumed
    ? 'Recovering an interrupted swap. It continues in the background; keep this tab open until it settles or refunds.'
    : 'Keep this tab open to settle.';
  const btnLabel = done ? 'Clear' : (resumed ? 'Dismiss' : 'Cancel offer');
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">${esc(headline)}</span>
      <span class="sub">${esc(label)}</span></div>
    <div class="swbook-row"><span class="sub">${esc(note)}</span>
      <button type="button" class="ghost" id="swXMakeCancel">${esc(btnLabel)}</button></div></div>`;
  const btn = C.$('swXMakeCancel');
  if (btn) btn.onclick = () => {
    // A resumed swap has no live listener/offer to close — Dismiss only hides the panel; the
    // background settlement/refund watcher (xmaker) keeps running and drops its record when terminal.
    if (!resumed){ try { XMAKE.handle && XMAKE.handle.close(); } catch {} }
    XMAKE = null; host.innerHTML = '';
    C.toast(resumed ? 'Hidden. The swap keeps recovering in the background.' : 'Cross offer removed.');
    renderSwap();
  };
}

// T11: on load, re-launch any interrupted cross-maker settlement/refund watcher that xmaker.js
// persisted (fund-loss safety), and surface the recovering swap in the resting-order panel. The
// watcher runs regardless of the active tab; here we only mirror its progress into the UI.
export function resumeCrossMakers(){
  if (!X || !X.resumeMakers) return;
  const onState = (st) => {
    if (!st) return;
    const reverse = st.direction === 'reverse';
    // Map the persisted maker record onto the panel's shape (there is no live `handle` on resume).
    XMAKE = { resumed: true, handle: null, assetHex: st.asset,
      assetAtoms: big(st.seq_amount || 0), btcSats: big(st.btc_amount || 0),
      reverse, offerId: st.offer_id, session_id: st.session_id, state: st.state, detail: st };
    try { renderXMake(); } catch {}
  };
  Promise.resolve(X.resumeMakers(onState)).then((list) => {
    if (Array.isArray(list) && list.length && C.toast)
      C.toast('Recovering ' + list.length + ' interrupted cross-chain swap' + (list.length>1?'s':'') + ' - keep this tab open until it settles or refunds.');
  }).catch(() => {});
}

async function reviewSame(q){
  const { $ } = C;
  if (q.startMarket) return postOfferReview(q);   // no resting liquidity -> start the market
  const fm = C.assetMeta(q.feeAsset);
  const kv = [
    ['Network', 'Sequentia (testnet) atomic swap via the order book; not parent-chain BTC'],
    ...(q.confidential ? [['Privacy', 'Blinded book — both legs settle confidentially; amounts and assets are hidden on-chain (Confidential Transactions).']] : []),
    ['You pay', amtRow(q.assetP, q.amountP) + refSuffix(q.assetP, q.amountP)],
    ['You receive', amtRow(q.assetR, q.amountR) + refSuffix(q.assetR, q.amountR)],
    ['Network fee', amtRow(q.feeAsset, q.feeAmount) + '  (estimate)'],
    ['Fee paid in', fm.ticker],
    ['Maker', short(q.offer && (q.offer.maker_pubkey || q.offer.makerPubkey))],
    ['Finality', 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
    ['Settlement', 'Atomic - settles in full or not at all.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Review swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Opening lift…';
    try {
      const txid = await liftOffer(q, st);
      modal.remove();
      C.toast('Swap settled (anchor-bound; reverts only if Bitcoin reverts):', {href:'/explorer/tx/'+txid, label:String(txid).slice(0,18)+'…'});
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Cross-chain: hand the priced quote to the right wizard and show its stepper.
async function reviewCross(q){
  const { $ } = C;
  if (!X){ $('swErr').textContent = 'Cross-chain route unavailable in this build.'; return; }
  // Market order bigger than the best maker's depth: fill what's available now (the HTLC wizard,
  // below) AND rest the remainder as a limit order at the same price. Post the remainder FIRST —
  // it's quick and non-interactive, so it rests even if the user closes the fill wizard — then open
  // the fill. If the remainder post fails, the fill still proceeds and we say so.
  const rem = q.remainderSeqAtoms != null ? BigInt(q.remainderSeqAtoms) : 0n;
  if (rem > 0n){
    const payIsBtc = !!(q.route && q.route.payIsBtc);
    const start = payIsBtc ? (X.makerStartReverse) : (X.makerStart);   // buy -> post a bid; sell -> post an ask
    const sm = C.assetMeta(q.seqAsset);
    if (start){
      try {
        C.toast(`Filling ~${C.fmtAtoms(BigInt(q.fillSeqAtoms), sm.precision)} ${sm.ticker} now; resting ~${C.fmtAtoms(rem, sm.precision)} ${sm.ticker} as a limit order…`);
        const recvAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
        const handle = await start({ assetHex: q.seqAsset, assetAtoms: rem, btcSats: BigInt(q.remainderBtcAtoms), expirySecs: 3600, recvAddr }, onCrossMakeState);
        XMAKE = { handle, assetHex: q.seqAsset, assetAtoms: rem, btcSats: BigInt(q.remainderBtcAtoms), reverse: !payIsBtc, offerId: handle.offer.offer_id, state: 'resting' };
        renderXMake();
      } catch (e){
        $('swErr').textContent = 'The available part will fill, but the remainder could not be rested: ' + C.prettyErr(e);
      }
    }
  }
  if (q.reverse){
    // Reverse (sell asset for BTC): the xrswap.js wizard takes over (its own review
    // modals, leg verification, fund/claim/poll, and localStorage resume).
    if (!X.openReverseFromComposer){ $('swErr').textContent = 'Selling an asset for BTC is unavailable in this build.'; return; }
    showReverse(true);
    X.openReverseFromComposer(q.xq);   // the FILLABLE portion
    return;
  }
  // Forward (pay BTC, receive asset): the xswap.js wizard takes over.
  if (!X.openFromComposer){ $('swErr').textContent = 'Cross-chain route unavailable in this build.'; return; }
  showCross(true);
  X.openFromComposer(q.xq);   // seeds LAST_XQUOTE in xswap.js + renders the lock step (the FILLABLE portion)
}

// --- Instant Lightning (pure-LN) rail -------------------------------------
// A resting LN offer is taken at the LP's fixed terms (§8.6: dynamic per-lift
// pricing is a later refinement), so there is no per-keystroke quote round-trip
// here — we render the rail + the honest (final) finality and enable Review. The
// actual amounts come back in the settle response.
async function requoteLn(route, amtStr){
  const { $ } = C;
  // ONE book: the SAME resting SeqOB (cross) book shows on the Lightning rail too —
  // no rail distinction in the book UI. (Prior bug: the LN rail blanked the book.)
  await loadBtcBook(route);
  deriveXOpposite(route);
  const side = route.payIsBtc ? 'buy' : 'sell';
  LAST_QUOTE = { kind: 'ln', side, seqAsset: route.seqAsset, payIsBtc: route.payIsBtc,
    amount: amtStr ? parseFloat(amtStr) : null };
  paintFee('BTC', null, 'The rate includes the LP spread; there is no separate network fee on the Lightning leg.');
  const am = C.assetMeta(route.seqAsset);
  $('swRate').textContent = `Instant ${am.ticker}/BTC over Lightning · rate includes the LP spread`;
  $('swRoute').textContent = route.payIsBtc ? 'Lightning · buy with BTC' : 'Lightning · sell for BTC';
  $('swStatus').textContent = ''; $('swErr').textContent = '';
  renderTiming(route);
  setReviewEnabled(true);   // LP fixed terms (proven path) — Review is offerable
}

// Execute the pure-LN swap through the LSP (the device co-signs the hosted node's
// commitment updates over the wss link during the call). Honest finality: pure-LN
// is the one state we may call final.
async function reviewLn(q){
  const { $ } = C;
  if (!L || !L.swap){ $('swErr').textContent = 'The Lightning route is unavailable in this build.'; return; }
  // Defense-in-depth: never proceed on a pure-LN swap without a real usable channel on
  // BOTH legs (findRoute already gates this; this catches a stale quote). Fail CLOSED
  // with a clear message + a route to Move-to-Lightning — never a silent flash.
  let ra = railAvail(S.payAsset, S.receiveAsset);
  if (!ra.pureLnOk){
    // No usable channel on one/both legs. Instead of BLOCKING and sending the user to the Balance
    // tab, OPEN the missing channel(s) INLINE now (the same non-custodial provision+fund flow), then
    // continue the swap. Honest, bounded progress; a clear failure — never a silent hang.
    if (!L.provisionChannel){ $('swErr').textContent = 'Opening a channel is unavailable in this build — open one from the Balance tab first.'; return; }
    const provLeg = async (hexOrBtc, amtEl) => {
      const chain = hexOrBtc === 'BTC' ? 'btc' : 'seq';
      const m = metaOf(hexOrBtc);
      const atoms = safeAtoms(C.$(amtEl).value, m.precision || 0);
      if (atoms <= 0n) throw new Error('Enter an amount so the Lightning channel can be sized.');
      await L.provisionChannel({ chain, asset: chain === 'seq' ? hexOrBtc : undefined, ticker: m.ticker,
        amount: Number(atoms), onProgress: (t) => { $('swStatus').className = 'status'; $('swStatus').innerHTML = '<span class="spin"></span>' + t; } });
    };
    try {
      $('swErr').textContent = '';
      if (!ra.payLn.ok)  await provLeg(S.payAsset,     'swPayAmt');
      if (!ra.recvLn.ok) await provLeg(S.receiveAsset, 'swRecvAmt');
      LNSTATUS = await L.status();   // refresh so railAvail sees the freshly-opened channel(s)
      $('swStatus').textContent = '';
    } catch (e){
      $('swStatus').textContent = '';
      $('swErr').textContent = 'Could not open your Lightning channel: ' + (e && e.message || e);
      return;
    }
    ra = railAvail(S.payAsset, S.receiveAsset);
    if (!ra.pureLnOk){ $('swErr').textContent = 'Your Lightning channel opened but is not ready to trade yet — please try again in a moment.'; return; }
  }
  const am = C.assetMeta(q.seqAsset);
  const dir = q.side === 'buy' ? `Buy ${am.ticker} with BTC` : `Sell ${am.ticker} for BTC`;
  const kv = [
    ['Route', 'Instant Lightning (pure-LN) · non-custodial, your keys stay on this device'],
    ['Direction', dir],
    ['Pricing', 'Best resting Lightning offer · rate includes the LP spread (no separate network fee)'],
    ['Finality', L.finalityCopy ? L.finalityCopy() : 'Instant and final · pure Lightning, nothing on-chain, no Bitcoin-reorg risk.'],
    ['If it stalls', 'Nothing moves · the swap unwinds atomically via the Lightning hold timeout.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Review Lightning swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Settling over Lightning…';
    try {
      const r = await L.swap({ side: q.side, asset: q.seqAsset, amount: q.amount });
      const bm = C.assetMeta(r.asset || q.seqAsset);
      const got = (r.direction === 'sold') ? `${r.quote_amount} BTC`
        : `${r.base_amount} ${bm.ticker}`;
      modal.remove();
      C.toast(`Lightning swap settled (final): received ${got} · preimage ${String(r.preimage || '').slice(0, 16)}…`);
      resetComposer();
      await C.sync();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

function resetComposer(){
  const pa = C.$('swPayAmt'), ra = C.$('swRecvAmt');
  pa.value = ''; ra.value = ''; pa._userTyped = false; ra._userTyped = false;
  LAST_QUOTE = null; setReviewEnabled(false);
}

function amtRow(hex, atoms){ const m = C.assetMeta(hex); return C.fmtAtoms(atoms, m.precision) + ' ' + m.ticker; }
function refSuffix(hex, atoms){ const r = C.refValueStr(hex, atoms); return r ? ('  ('+r+')') : ''; }
function trim(n){ if (!isFinite(n)) return '-'; const s = (Math.round(n*1e8)/1e8).toString(); return s; }

// ---------------------------------------------------------------------------
// build -> propose -> sign (add_details + strip bip32) -> complete  (UNCHANGED)
// ---------------------------------------------------------------------------
// Lift a resting offer to settlement over the SeqOB courier. The two wasm-bound
// steps are passed as hooks; seqob.js owns the WS + E2E + protobuf transport.
// The taker builds its half (seqdexSwapRequest), the maker co-signs over the
// relay, then the taker signs + self-broadcasts (the proven 6d-1 finalize path)
// and couriers the SwapComplete receipt back.
async function liftOffer(q, st){
  const { wasm } = C;
  // Receive TRANSPARENTLY by default (principle #6: transparent-by-default). Only a confidential
  // swap (q.confidential — the opt-in Confidential sub-tab) receives to the blinded blech32 address;
  // everywhere else the received amount is explicit, like the Receive tab and the cross-chain wizards.
  const _raw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  // Blinded receive when: the offer is a confidential-book lift (q.confidential), the
  // wallet-wide opt-in is on, OR the Blinded book is active (both legs MUST blind, so a
  // transparent taker output would leak the amount via the swap ratio).
  const receiveAddr = (q.confidential || _confidentialReceive || isConfBook()) ? _raw : (_raw.toUnconfidential ? _raw.toUnconfidential() : _raw);
  const buildRequest = async () => {
    const sreq = C.wollet.seqdexSwapRequest(
      new wasm.AssetId(q.assetP), q.amountP,
      new wasm.AssetId(q.assetR), q.amountR,
      receiveAddr,
      new wasm.AssetId(q.feeAsset), q.feeAmount, q.feeRate,
    );
    return sreq.toJson();
  };
  const finalizeAccept = async (acc) => {
    const pset = new wasm.Pset(acc.transaction);
    pset.addDetails(C.wollet);
    const signed = C.signer.sign(pset);
    const strippedB64 = stripBip32(signed.toString());
    const finalPset = new wasm.Pset(strippedB64);
    const finalized = C.wollet.finalize(finalPset);
    const txid = await C.client.broadcast(finalized);
    return { transaction: strippedB64, txid: (txid && txid.toString) ? txid.toString() : String(txid) };
  };
  const onStatus = (msg) => { st.innerHTML = '<span class="spin"></span>' + msg; };
  return seqob.lift(q.offer, q.takeBase, q.feeAsset, { buildRequest, finalizeAccept, onStatus });
}

// Start a market: post the user's desired trade as a resting offer (they become
// the maker — give `pay`, want `receive`). Honest about filling: it needs the
// maker online to co-sign, which is a follow-up; the offer rests + is cancellable.
async function postOfferReview(q){
  const { $ } = C;
  const pay = q.pay, receive = q.receive;
  let payAtoms, recvAtoms;
  try {
    payAtoms = C.parseAtoms($('swPayAmt').value.trim(), C.assetMeta(pay).precision || 0);
    recvAtoms = C.parseAtoms($('swRecvAmt').value.trim(), C.assetMeta(receive).precision || 0);
    if (payAtoms <= 0n || recvAtoms <= 0n) throw 0;
  } catch { $('swErr').textContent = 'Enter both amounts - what you give and what you want - to start a market.'; return; }
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const kv = [
    ['Posting', 'A resting offer - you become the maker of this market'],
    ...((q.confidential || isConfBook()) ? [['Privacy', 'Blinded book — your offer rests confidentially and fills confidentially; a blinded receive address and blinding pubkey are published so the counterparty can blind their leg too.']] : []),
    ['You give', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You want', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? `1 ${pm.ticker} = ${trim(recvU/payU)} ${rm.ticker}` : '-'],
    ['Filling', 'A taker fills it from the other side. Filling needs you (the maker) online to co-sign; in-wallet co-sign is coming, so for now the offer rests publicly and you can cancel it anytime.'],
    ['Expires', 'In 1 hour (re-post to refresh).'],
    ['Finality', 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Start this market', kv });
  if (ok) ok.textContent = 'Post offer';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Signing + posting…';
    try {
      const conf = !!q.confidential || isConfBook();
      // Transparent book: publish the transparent recv address (principle #6). Blinded
      // book: publish the BLINDED (blech32) recv address + its blinding pubkey so the
      // counterparty can add a blinded output for this leg — both legs blind on-chain.
      let sameChain;
      if (conf){
        const br = blindedReceive();
        sameChain = { maker_recv_address: br.address, maker_blinding_pub: br.blindingPub };
      } else {
        // Transparent (toUnconfidential) by DEFAULT (principle #6), matching covReceiveAddr.
        const raw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
        const t = raw.toUnconfidential ? raw.toUnconfidential() : raw;
        sameChain = { maker_recv_address: t.toString() };
      }
      const now = Math.floor(Date.now()/1000);
      const offer = {
        offer_id: seqob.randHex(16), schema_version: 1,
        pair: { base_asset: pay, quote_asset: receive },
        trade_dir: 1,                       // SELL: maker gives base (= pay)
        base_amount: payAtoms.toString(), offer_amount: payAtoms.toString(), offer_asset: pay,
        want_amount: recvAtoms.toString(), want_asset: receive,
        allow_partial: true,
        created_at_unix: String(now), expires_at_unix: String(now + 3600),
        fee_asset_hint: S.feeAsset || pay,
        confidential: conf,                 // signed book-namespace tag (field 19)
        same_chain: sameChain,
      };
      seqob.signOffer(offer, makerPriv());
      await seqob.postOffer(offer);
      modal.remove();
      C.toast('Offer posted - your market is live in the order book.');
      resetComposer();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not post: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// order-book rendering (resting offers + your own orders)
// ---------------------------------------------------------------------------
function short(s){ s = s || ''; return s.length > 14 ? s.slice(0,8) + '…' + s.slice(-4) : s; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Same-chain SeqOB book, rendered as the shared ladder. Prices are PAY per 1 RECEIVE
// (the conventional quote, matching the mid). ASKS are the offers we can take (give
// pay, get receive) — clickable to lift; BIDS are the opposite side (display-only
// depth, since the taker can't lift them).
function renderBook(pay, receive){
  const host = C.$('swBook'); if (!host) return;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const toU = (a, p) => Number(big(a)) / Math.pow(10, p || 0);
  const MY = (typeof makerPubHex === 'function') ? makerPubHex() : null;   // this wallet's own maker id
  const isMine = (o) => !!(MY && (o.maker_pubkey || o.makerPubkey) === MY);
  let asks = (BOOK.offers || []).map(o => {
    const recvSize = toU(o.offer_amount || o.offerAmount, rm.precision);   // offer asset = receive
    const payWanted = toU(o.want_amount || o.wantAmount, pm.precision);    // want asset  = pay
    return { price: recvSize > 0 ? payWanted / recvSize : 0, size: recvSize,
             id: o.offer_id || o.offerId, maker: o.maker_pubkey || o.makerPubkey, mine: isMine(o) };
  }).filter(r => r.price > 0 && r.size > 0);
  let bids = (BOOK.otherOffers || []).map(o => {
    const payGiven = toU(o.offer_amount || o.offerAmount, pm.precision);   // offer asset = pay
    const recvWanted = toU(o.want_amount || o.wantAmount, rm.precision);   // want asset  = receive
    return { price: recvWanted > 0 ? payGiven / recvWanted : 0, size: recvWanted, mine: isMine(o) };
  }).filter(r => r.price > 0 && r.size > 0);
  const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  // cumulate from the mid outward; display asks high->low, bids high->low
  asks.sort((a, b) => a.price - b.price);
  { let c = 0; const t = asks.reduce((s, r) => s + r.size, 0) || 1; asks.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  asks.reverse();
  bids.sort((a, b) => b.price - a.price);
  { let c = 0; const t = bids.reduce((s, r) => s + r.size, 0) || 1; bids.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  asks = asks.slice(0, 8); bids = bids.slice(0, 8);
  asks.forEach(r => r.onClick = () => fillFromOffer(r.id, r.maker, pay, receive));   // takeable
  LAST_MID = { price: mid, cross: false };
  renderLadder(host, {
    asks, bids, mid, spread,
    priceLabel: `(${pm.ticker}/${rm.ticker})`, sizeLabel: rm.ticker,
    refMidStr: oneUnitRefStr(receive),
    headTitle: 'Order book', headSub: `${(BOOK.offers || []).length} offer${(BOOK.offers || []).length === 1 ? '' : 's'}`,
    emptyMsg: 'No resting offers - enter an amount and Review to start this market.',
  });
  renderPairBar();
}

// Click a book level: seed BOTH amount fields with that resting order's size + the
// pay it wants, as the user's own limit (so placing crosses it at that price). Then
// requote builds the place quote. Both fields are marked user-typed so the derivation
// never overwrites them.
function fillFromOffer(id, maker, pay, receive){
  const o = (BOOK.offers||[]).find(x => (x.offer_id||x.offerId) === id && (x.maker_pubkey||x.makerPubkey) === maker);
  if (!o) return;
  const offerAmt = big(o.offer_amount||o.offerAmount);   // receive units this order gives
  const wantAmt  = big(o.want_amount ||o.wantAmount );   // pay units it wants
  const recvEl = C.$('swRecvAmt'), payEl = C.$('swPayAmt');
  recvEl.value = C.fmtAtoms(offerAmt, C.assetMeta(receive).precision||0); recvEl._userTyped = true;
  payEl.value  = C.fmtAtoms(wantAmt,  C.assetMeta(pay).precision||0);     payEl._userTyped = true;
  S.edited = 'receive';
  LAST_QUOTE = null; setReviewEnabled(false);
  requote().catch(()=>{});
}

// The companion (eltr / BIP86 taproot) wollet's balance — the maker credits this
// wallet has been PAID when its resting covenant orders filled. The primary wpkh
// wallet does not track taproot receives, so this is where a maker SEES its proceeds.
export function covenantCreditBalance(){
  try { return (COMPANION && COMPANION.balance) ? COMPANION.balance().toJSON() : {}; }
  catch { return {}; }
}
export async function scanCovenantCompanion(){ await scanCompanion(); }
// The "credits received" block: proceeds paid into the taproot payout when a resting
// order filled (possibly while the wallet was closed). Sweeping them into the main
// wpkh balance is a follow-up; here the maker at least SEES them (task requirement).
function creditsHtml(){
  const bal = covenantCreditBalance();
  const rows = Object.keys(bal).filter(h => big(bal[h]) > 0n).map(h => {
    const m = C.assetMeta(h);
    return `<div class="swbook-row"><span class="mono">received ${esc(C.fmtAtoms(big(bal[h]), m.precision))} ${esc(m.ticker)}</span>
      <span class="sub">${esc(C.refValueStr(h, big(bal[h])) || '')}</span></div>`;
  }).join('');
  if (!rows) return '';
  return `<div class="swbook"><div class="swbook-head"><span class="lbl">Order credits received</span>
      <span class="sub">paid into a payout only this wallet controls</span></div>${rows}</div>`;
}

// The unified "Active trades" card: every in-flight swap (submarine, sub-asset sell, cross-chain),
// so a DISMISSED one is never lost — each row reopens its process view (clearing the dismiss). A
// trade that may need an on-chain action (refundable / claiming) is flagged so leaving it is a
// deliberate, informed choice. Rendered in the composer (above your resting orders).
function renderInFlightCard(){
  const host = C.$('swInFlight'); if (!host) return;
  const rows = [];
  if (hasMixedInFlight()){
    const am = metaOf(MIXED.asset);
    const need = sub.isRefundable(MIXED, mixedTip());
    rows.push({ view: 'mixed', need,
      title: (MIXED.side === 'buy' ? 'Buy ' : 'Sell ') + esc(am.ticker) + ' · submarine',
      status: need ? 'on-chain HTLC refundable now' : String(MIXED.state) });
  }
  if (hasSellInFlight()){
    rows.push({ view: null, need: true, title: 'Sell ' + esc(SELL.ticker) + ' for BTC',
      status: 'claiming your BTC on-chain (automatic)' });
  }
  if (hasBuyInFlight()){
    rows.push({ view: null, need: true, title: 'Buy ' + esc(BUY.ticker || 'asset') + ' with BTC',
      status: BUY.state === 'holding' ? 'held — settle from your wallet to receive' : 'BTC HTLC funded; awaiting the asset over Lightning' });
  }
  if (X && X.hasInFlight && X.hasInFlight()){
    rows.push({ view: 'cross', need: true, title: 'Buy asset with BTC · cross-chain', status: 'in progress' });
  }
  if (X && X.hasReverseInFlight && X.hasReverseInFlight()){
    rows.push({ view: 'reverse', need: true, title: 'Sell asset for BTC · cross-chain', status: 'in progress' });
  }
  const hist = loadHist();
  if (!rows.length && !hist.length){ host.innerHTML = ''; return; }
  let html = '';
  if (rows.length){
    html += `<div class="swbook"><div class="swbook-head">
        <span class="lbl">Active trades</span><span class="sub">running in the background · reopen anytime</span></div>`
      + rows.map(r => `<div class="swbook-row${r.need ? ' needsact' : ''}">
          <span class="mono">${r.title} · ${esc(r.status)}${r.need ? ' <b class="actneed">action may be needed</b>' : ''}</span>
          ${r.view ? `<button type="button" class="ghost swviewtrade" data-view="${r.view}">View</button>` : '<span class="sub">automatic</span>'}
        </div>`).join('')
      + `</div>`;
  }
  if (hist.length){
    html += `<div class="swbook"><div class="swbook-head">
        <span class="lbl">Recent trades</span><span class="sub">last ${hist.length}</span></div>`
      + hist.slice(0, 6).map(e => `<div class="swbook-row myorder">
          <span class="mono">${esc(e.title)} · ${esc(e.status)}</span>
          ${e.txid ? `<span class="sub mono">${esc(String(e.txid).slice(0, 12))}…</span>` : ''}</div>`).join('')
      + `</div>`;
  }
  host.innerHTML = html;
  host.querySelectorAll('.swviewtrade').forEach(b => b.onclick = () => {
    const v = b.dataset.view; _dismissed.delete(v);
    if (v === 'mixed'){ showMixed(true); renderMixedSwap(); }
    else if (v === 'cross'){ showCross(true); if (X && X.renderXswap) X.renderXswap(); }
    else if (v === 'reverse'){ showReverse(true); if (X && X.renderReverse) X.renderReverse(); }
  });
}

async function renderMyOrders(){
  const host = C.$('swMyOrders'); if (!host) return;
  if (XMAKE) return renderXMake();   // a live wallet cross offer owns this panel

  const credits = creditsHtml();     // maker proceeds from filled resting orders

  let orders = [];
  // On a fetch error, leave whatever is already rendered rather than blanking the panel (a transient
  // relay blip should not make your resting orders vanish from the UI).
  try { orders = await seqob.fetchMyOrders(makerPubHex()); } catch { if (credits) host.innerHTML = credits; return; }
  if (!orders.length){ host.innerHTML = credits; return; }
  const rows = orders.map(o => {
    const give = C.assetMeta(o.offer_asset||o.offerAsset), want = C.assetMeta(o.want_asset||o.wantAsset);
    const isCov = !!(o.covenant || o.Covenant);
    return `<div class="swbook-row myorder">
      <span class="mono">give ${esc(C.fmtAtoms(big(o.offer_amount||o.offerAmount), give.precision))} ${esc(give.ticker)} · want ${esc(C.fmtAtoms(big(o.want_amount||o.wantAmount), want.precision))} ${esc(want.ticker)}${isCov ? ' · resting on-chain' : ''}</span>
      <button type="button" class="ghost swcancel" data-id="${esc(o.offer_id||o.offerId)}">Cancel</button></div>`;
  }).join('');
  host.innerHTML = credits + `<div class="swbook"><div class="swbook-head"><span class="lbl">Your resting orders</span>
      <span class="sub">funded on-chain · fill whenever matched, even offline</span></div>${rows}</div>`;
  host.querySelectorAll('.swcancel').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Cancelling…';
    const id = b.dataset.id;
    const rec = PLACED.find(r => (r.offerId === id));
    try {
      // A funded covenant's locked asset is reclaimable on-chain only via the CLTV
      // REFUND leaf: once expired (tip >= expiry) broadcast the reclaim; before that
      // delist + tell the maker when the funds become reclaimable. A non-covenant
      // (no local funded record) just delists on the relay.
      if (rec && rec.covTxid != null){
        const { order } = orderFromPlaced(rec);
        const payout = makerPayout(C.signer, C.network, rec.makerIndex);
        const recipe = covPlanRefund(order, { txid: rec.covTxid, vout: rec.covVout, locked: BigInt(rec.sellAtoms) });
        recipe.makerKeyPath = payout.path;   // m/86'/coin'/0'/0/index — the leaf's key
        const tipHeight = C.wollet.tip().height();
        const out = await covCancel(id, { recipe, tipHeight, expiryLocktime: Number(rec.expiry) },
          { relayCancel: async (offerId) => seqob.signAndCancel(offerId, makerPriv()), ...refundHooksFor() });
        if (out.refundTxid){
          C.toast('Order cancelled — reclaimed on-chain (' + String(out.refundTxid).slice(0,12) + '…).');
        } else if (out.reclaimable){
          const meta = C.assetMeta(rec.pay);
          C.toast('Order delisted. The locked ' + esc(meta.ticker) + ' is reclaimable on-chain after block ' + out.reclaimable.afterHeight + '.');
        }
      } else {
        await seqob.signAndCancel(id, makerPriv());
      }
      // Drop the local record only once the funds are back (or there were none to
      // reclaim); keep it while still-locked so a later Cancel can reclaim at expiry.
      const stillLocked = rec && rec.covTxid != null && C.wollet.tip().height() < Number(rec.expiry);
      if (!stillLocked){
        const before = PLACED.length;
        PLACED = PLACED.filter(r => r.offerId !== id);
        if (PLACED.length !== before){ savePlaced(); ensureCovenantRelay(); }
      }
      renderSwap();
    }
    catch (e){ b.disabled = false; b.textContent = 'Cancel'; C.toast('Cancel failed: ' + C.prettyErr(e)); }
  });
}

// ---------------------------------------------------------------------------
// PSET bip32 / global-xpub stripper.  (UNCHANGED - verified byte-exact.)
// ---------------------------------------------------------------------------
function b64ToBytes(b64){
  const bin = atob(b64.trim()); const a = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) a[i] = bin.charCodeAt(i);
  return a;
}
function bytesToB64(a){
  let s=''; for (let i=0;i<a.length;i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function stripBip32(b64){
  const b = b64ToBytes(b64);
  const magic = [0x70,0x73,0x65,0x74,0xff];
  for (let i=0;i<5;i++) if (b[i]!==magic[i]) throw new Error('not a PSET');
  let i = 5;
  const out = [0x70,0x73,0x65,0x74,0xff];
  const rdVarint = () => {
    const x = b[i++];
    if (x < 0xfd) return x;
    if (x === 0xfd){ const v = b[i] | (b[i+1]<<8); i+=2; return v; }
    if (x === 0xfe){ const v = (b[i] | (b[i+1]<<8) | (b[i+2]<<16) | (b[i+3]<<24))>>>0; i+=4; return v; }
    let v = 0; for (let k=0;k<8;k++) v += b[i+k] * Math.pow(2, 8*k); i+=8; return v;
  };
  const emitVarint = (v) => {
    if (v < 0xfd) out.push(v);
    else if (v <= 0xffff){ out.push(0xfd, v & 0xff, (v>>8)&0xff); }
    else if (v <= 0xffffffff){ out.push(0xfe, v&0xff, (v>>8)&0xff, (v>>16)&0xff, (v>>>24)&0xff); }
    else { out.push(0xff); for (let k=0;k<8;k++){ out.push(Math.floor(v/Math.pow(2,8*k))&0xff); } }
  };
  const copyMap = (dropTypes) => {
    while (true){
      const klen = rdVarint();
      if (klen === 0){ out.push(0x00); break; }
      const keyStart = i; const keyType = b[i];
      i += klen;
      const vlen = rdVarint();
      const valStart = i; i += vlen;
      if (dropTypes.has(keyType)) continue;
      emitVarint(klen); for (let k=keyStart;k<keyStart+klen;k++) out.push(b[k]);
      emitVarint(vlen); for (let k=valStart;k<valStart+vlen;k++) out.push(b[k]);
    }
  };
  let inCount = 0, outCount = 0;
  { let j = 5;
    const pv = () => { const x = b[j++];
      if (x<0xfd) return x;
      if (x===0xfd){ const v=b[j]|(b[j+1]<<8); j+=2; return v; }
      if (x===0xfe){ const v=(b[j]|(b[j+1]<<8)|(b[j+2]<<16)|(b[j+3]<<24))>>>0; j+=4; return v; }
      let v=0; for (let k=0;k<8;k++) v+=b[j+k]*Math.pow(2,8*k); j+=8; return v; };
    while (true){
      const kl = pv(); if (kl===0) break;
      const kt = b[j]; j += kl;
      const vl = pv(); const vs = j; j += vl;
      if (kt === 0x04){ let v=0; for (let k=0;k<vl;k++) v += b[vs+k]*Math.pow(2,8*k); inCount = v; }
      if (kt === 0x05){ let v=0; for (let k=0;k<vl;k++) v += b[vs+k]*Math.pow(2,8*k); outCount = v; }
    }
  }
  copyMap(new Set([0x01]));
  for (let n=0;n<inCount;n++) copyMap(new Set([0x06]));
  for (let n=0;n<outCount;n++) copyMap(new Set([0x02]));
  return bytesToB64(Uint8Array.from(out));
}

// Test-only exports: drive the REAL same-chain pipeline + the composer mapping
// from a headless harness, no DOM. Adds composerRoute for the reframe's mapping.
export const __test__ = { stripBip32, dexPost,
  setMarkets: (m) => { MARKETS = m; },
  // XMARKETS in the composer are the snake_case shape xswap.js's normMarket emits
  // (and that C.xroute.markets() returns). Normalize camelCase test fixtures to match.
  setXMarkets: (m) => { XMARKETS = (m||[]).map(x => ({
    btc_asset: x.btc_asset ?? x.btcAsset ?? '',
    seq_asset: x.seq_asset ?? x.seqAsset,
    name: x.name || 'BTC / Sequentia asset',
    price_seq_per_btc: x.price_seq_per_btc ?? x.priceSeqPerBtc ?? 0,
  })); },
  orientLegs, pick,
  // Reframe: given (payAsset, receiveAsset) over the loaded markets, return the
  // route the composer would take ({kind:'same', side, market} | {kind:'cross', ...} | null).
  composerRoute: (pay, receive) => findRoute(pay, receive),
  counterpartsOf, startableAssets, allTradableAssets: startableAssets,
  acceptedFee, defaultFeeAsset,
  // Take/Post + rail-combo helpers, for headless verification of the composer's gating.
  postSupported, railSupported, applyAutoMode,
  state: S,
};
