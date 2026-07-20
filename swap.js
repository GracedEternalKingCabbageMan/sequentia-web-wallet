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
import { verifyAgainstSPK as covVerifyAgainstSPK } from './covenant.js';
import { makeCovenantHooks, makerPayout } from './covenant-fill-host.js';
import { computeRate, orderExpiry, deriveOtherField, buildCovenantOffer, fillRestSplit } from './covenant-flow.js';
// HONEST per-asset Lightning-rail gating (offer LN only with a real usable channel).
import { railAvailability } from './ln-rail.js';
// The mixed-rail (submarine) swap state machine + localStorage resume (fund-safety:
// an in-flight on-chain HTLC leg must survive a reload so it can be refunded).
import * as sub from './submarine.js';
// The SBTC bridge client (the silent peg for resting on-chain-BTC LIMIT orders). Allocates
// peg-in/peg-out addresses only; the wallet's own signed sends move the funds. See sbtc.js.
import * as sbtc from './sbtc.js';

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
// D2 (T13): per-order fill progress from the relay's order_status stream — { offer_id: {active, status} }
// where `active` is the remaining base atoms after any partial fills. Populated live via onCovOrderStatus
// while the wallet is open; renderMyOrders shows "~N% filled" when active < the order's base amount.
const _ordStatus = {};
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
export function logTrade(e){
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
  // TWO independent settlement PREFERENCES the user sets per order: how they PAY and how
  // they RECEIVE, each 'ln' (Lightning) or 'chain' (on-chain). RAIL-BLIND MODEL (spec §5):
  // these NEVER touch the book or matching — the book matches on price/asset/size only.
  // They are honored at settlement per leg (P2P when both sides agree, else the atomic
  // seqob-bridge). They start NULL — there is NO default (spec §6.5): an order cannot be
  // placed until both are chosen, on EVERY pair (same-chain assets can move over SeqLN too).
  payRail: null, recvRail: null,
  // MARKET = walk the book at the best executable price, partial-fill what's there, cancel
  // any remainder (taker). LIMIT = rest a signed order at YOUR price until crossed (maker);
  // the two amounts are independent, their ratio is the price. Always available on every
  // pair (spec §4/§6.3). Default MARKET; the toggle never disappears.
  mode: 'take',
  // KEEP RESTING WHILE OFFLINE (spec §5 / SBTC design §5). Relevant ONLY for an on-chain-BTC-pay
  // LIMIT order: ON -> silently peg the maker's BTC to SBTC and rest it in a covenant (survives
  // the wallet going offline), peg back out to real BTC on fill; OFF -> a native-BTC HTLC (needs
  // the wallet online). Default ON. Market orders and any Lightning leg IGNORE this — pure native
  // BTC. The placement path reads keepResting only when payingBtcOnChain(route) && S.mode==='post'.
  keepResting: true,
};
let INSTANT = {};    // ticker -> { spendable, receivable } atoms (best-effort from the LSP /status)
let LAST_MID = null; // { price, cross, base, quote } for the current pair — feeds the pair bar + cost line

// ---- canonical price direction (C1) ----------------------------------------------------------------
// A pair is priced ONE way — "1 base = N quote" (quote per base) — no matter which side the user is
// paying, so the book / pair bar / rate line / trades / modal never disagree. base/quote are chosen by
// a fixed quote-RANK: the numeraire (BTC, then fiat stables, then the Sequence token, then commodities)
// is the QUOTE, so a pair reads the same whether you buy or sell. The pair-bar flip toggle (S.priceFlip)
// swaps the DISPLAY only.
function _quoteRank(hex){
  if (hex === 'BTC') return 1000;
  const t = String((C.assetMeta(hex) || {}).ticker || '').toUpperCase();
  // ONLY genuine units of account are numeraires (quotes): BTC + the fiat stablecoins. The Sequence
  // token (SEQ/tSEQ) is NOT a numeraire — it's just another issued asset with EQUAL standing (Principle 3),
  // so it sits in the same generic "base" tier as the commodities and any unknown asset, tiebroken by id.
  const r = { USDX:900, EURX:890, FEEUSD:880, USDT:870, USDC:865, USD:860 };
  return (t in r) ? r[t] : 400;
}
// {base, quote} for an UNORDERED pair — the higher-rank asset is the QUOTE (numeraire). Deterministic
// (a rank tie falls back to the asset id) so a pair's direction never flips with the buy/sell side.
function canonicalPair(a, b){
  if (!a || !b) return { base: a || b, quote: b || a };
  const ra = _quoteRank(a), rb = _quoteRank(b);
  if (ra !== rb) return ra > rb ? { base: b, quote: a } : { base: a, quote: b };
  return String(a) < String(b) ? { base: a, quote: b } : { base: b, quote: a };
}
// The pair's DISPLAY direction, honouring the user's flip toggle.
function pairDir(a, b){
  const d = canonicalPair(a, b);
  return S.priceFlip ? { base: d.quote, quote: d.base } : d;
}
// Format "1 base = N quote" from a RECEIVE-per-PAY scalar (what the composer/quote paths natively have).
// qpb (quote per base) = the receive-per-pay rate when base==pay, else its inverse.
function ratePerPayToLine(pay, receive, recvPerPay){
  const { base, quote } = pairDir(pay, receive);
  const bm = metaOf(base), qm = metaOf(quote);
  const qpb = (base === pay) ? recvPerPay : (recvPerPay > 0 ? 1 / recvPerPay : 0);
  return { base, quote, bt: bm.ticker, qt: qm.ticker, qpb, str: `1 ${bm.ticker} = ${fmtPrice(qpb)} ${qm.ticker}` };
}
// "1 base = N quote" for a concrete trade of payU pay -> recvU receive (DISPLAY units). null if no amounts.
function priceLineStr(pay, receive, payU, recvU){
  if (!(payU > 0 && recvU > 0)) return null;
  return ratePerPayToLine(pay, receive, recvU / payU).str;
}
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
    // TAKE mode: the two amounts are LINKED (one price), so editing this side makes the OTHER
    // side a derived value again — clear its user-typed flag so a requote can refresh it. POST/
    // limit mode: both amounts are independent user input (their ratio IS the limit price), so
    // leave the other side's flag alone. This is what lets a fresh keystroke on one side win
    // AND still re-derive the other, without ever stomping a value the user actually typed.
    if (S.mode !== 'post'){
      const other = side === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
      if (other) other._userTyped = false;
    }
    LAST_QUOTE = null;
    setReviewEnabled(false);
    clearTimeout(_quoteTimer);
    _quoteTimer = setTimeout(() => requote().catch(()=>{}), 350);
  });
}
// Programmatically set a field's value and mark it NOT user-typed (so the other
// side's derivation may overwrite this one; the user's own input is protected).
function setDerived(input, value){ if (!input) return; input.value = value; input._userTyped = false; }
// THE anti-clobber invariant (user keystrokes always beat derived values): write a DERIVED value
// into a field ONLY if the user has not typed there and is not editing it right now. Every seed/
// quote/derivation write across ALL rails (same-chain, cross, LN, mixed) MUST go through this — a
// raw `el.value = …` guarded on document.activeElement alone silently overwrote a value the user
// typed the instant the field lost focus (the observed "my typed amount didn't stick" bug).
function writeDerived(el, value){
  if (!el) return;
  if (el._userTyped) return;                   // user's own input — never overwrite
  if (document.activeElement === el) return;   // don't fight the field being edited right now
  el.value = value;                            // remains _userTyped=false: still a derived value
}
// Clear a DERIVED field (same invariant): never wipe a value the user typed or is editing.
function clearDerived(el){
  if (!el) return;
  if (el._userTyped || document.activeElement === el) return;
  el.value = '';
}
// Apply the anti-clobber compose rule: derive the field the user did NOT edit from
// the book's best price, WITHOUT clearing or overwriting anything the user typed.
// The empty-market case (no price) leaves both fields exactly as typed — this is
// the fix for the first-order bug where linked fields wiped each other.
function applyComposeDerivation(pay, receive, price){
  const payEl = C.$('swPayAmt'), recvEl = C.$('swRecvAmt');
  const editedEl = S.edited === 'pay' ? payEl : recvEl;
  const otherEl  = S.edited === 'pay' ? recvEl : payEl;
  const editedAsset = S.edited === 'pay' ? pay : receive;
  const otherAsset  = S.edited === 'pay' ? receive : pay;
  if (document.activeElement === otherEl) return;   // never fight the field being typed in
  // Derive across the two fields even when one/both are in ref-currency (USD) input mode. Read the
  // edited field in NATIVE units (fieldUnits converts a USD number back to native via the asset's ref
  // price), derive the other field's native value from the book price, and write it back HONORING the
  // other field's display mode (converting native->ref when it shows USD). The old early-return in ref
  // mode was the bug where switching an input to USD stopped the auto-fill entirely.
  const r = deriveOtherField({
    edited: S.edited, editedVal: fieldUnits(editedEl, editedAsset),
    otherUserTyped: !!otherEl._userTyped, price,
  });
  if (!r) return;                                    // no derivation -> leave both fields untouched
  const meta = C.assetMeta(otherAsset);
  const otherAtoms = C.parseAtoms(String(trim(r.value)), meta.precision || 0);
  if (otherEl._refMode && C.refValue){
    const rv = C.refValue(otherAsset, otherAtoms);   // native -> ref number for a USD-mode field
    setDerived(otherEl, rv ? String(trim(rv.v)) : C.fmtAtoms(otherAtoms, meta.precision || 0));
  } else {
    setDerived(otherEl, C.fmtAtoms(otherAtoms, meta.precision || 0));
  }
  paintRefHints();
}

// Re-render the whole composer for the current wallet/markets/state.
// B3/D4 (live market data): the order book itself now streams over a WS (startLiveBook) — the ladder
// and the cost-vs-mid line tick in real time as offers appear/expire, and the header shows "· live".
// This 15s timer is the fallback + the READ-ONLY surfaces the stream doesn't carry: recent trades +
// 24h stats, refreshed only when a pair is chosen. It (and the live stream) DELIBERATELY do
// NOT auto-requote the composer — that would risk moving an amount the user is reading or about to
// place; the terms-verify abort already guards a stale price at execution time (B3), so the composer
// stays put while everything around it stays live.
let _liveTimer = null;
function startLiveData(){
  if (_liveTimer) return;
  _liveTimer = setInterval(() => {
    try {
      const sw = C.$('swBook'); if (!sw || sw.offsetParent === null) return;   // Swap tab not visible
      if (S.payAsset && S.receiveAsset){ renderRecentTrades().catch(()=>{}); renderPairStats().catch(()=>{}); }
    } catch {}
  }, 15000);
}

export async function renderSwap(){
  if (!C.wollet) return;
  startLiveData();
  stopLiveBook();   // drop any prior pair's live stream; requoteSame re-subscribes for the selected pair
  // Prune stale dismissals: once a kind's trade has ended, its flag must not suppress a future one.
  if (!hasMixedInFlight()) _dismissed.delete('mixed');
  if (!(X && X.hasInFlight && X.hasInFlight())) _dismissed.delete('cross');
  if (!(X && X.hasReverseInFlight && X.hasReverseInFlight())) _dismissed.delete('reverse');
  // In-flight swaps NEVER hijack the tab (spec §7): the composer stays up and every in-flight/pending
  // trade lives in the COMPACT "Active trades" card (renderInFlightCard) beside it, so you keep trading
  // while they settle — essential for rapid/HFT use. The full-screen stepper is opt-in: the card's
  // "View" button reopens it for detail or a refund off-ramp. (This replaces the old auto-takeover that
  // jumped into a mixed/cross/reverse stepper on entry and owned the whole tab.)
  showCross(false); showReverse(false); showMixed(false);
  const _bh = C.$('swBook'); if (_bh) _bh.innerHTML = '';   // cleared; requote re-renders for the selected pair
  renderInFlightCard();   // any dismissed / background in-flight trade, reopenable
  renderMyOrders();
  await loadMarkets();
  // Validate the persisted pair (drop anything no longer tradable); we do NOT force a default pair —
  // the composer leads, and the user picks pay/receive, which brings up that pair's detail above.
  ensureDefaults();
  renderFeePicker();
  paintPanes();
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
    // A sub-asset SELL (pay asset over LN, receive BTC on-chain) LIFTS a resting sell offer, so it needs
    // one to exist (sellCapable) — an outbound channel alone is necessary but NOT sufficient. Only the
    // pure-LN sell (recv=ln too) is serviceable by the pay channel itself. Without this split, having a
    // funded pay-channel but no resting offer left the mixed sell on 'ln' -> requoteMixed disables Review
    // and mixed isn't postable = dead-end. Degrade to the postable cross rail instead.
    const paySellServiceable = payIsBtc || sellCapable(seqAsset) || (ra && ra.payLn.ok && S.recvRail === 'ln');
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
    for (const c of chans){
      if (!c.node_key) continue;   // ONLY the wallet's own channels count as its Lightning balance
                                   // (never shared/demo) — consistent with the Balance tab + railAvail
      // Key by the RESOLVED ticker (what instantAtomsFor looks up), not the raw channel label: the
      // LSP labels a channel with a TRUNCATED hex when it can't resolve the asset's ticker (e.g.
      // "2a515539…" for USDX), so keying by asset_label put the balance under a key nothing reads,
      // and the composer showed "0 Lightning" for a funded channel. Resolve the full asset hex →
      // metaOf().ticker to match, exactly like the Balance card matches on c.asset.
      const isBtc = (c.leg === 'btc' || c.asset_label === 'BTC' || c.chain === 'btc');   // mirror channelMatches' 3-way BTC test
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
  try { paintPanes(); } catch {}
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
// (The old "holdings chips" strip was removed: its host #swChips never existed in the DOM, so
// renderChips/chipHtml/onChipPick were dead code — and chipHtml's icon styling gave the policy asset a
// privileged look, a latent equal-standing violation. The asset dropdown's "Your assets" group is the
// holdings surface now, and it treats every asset the same.)

// --- pair bar: the selected market + last price (derived from the book mid) ---
function renderPairBar(){
  const host = C.$('swPairBar'); if (!host) return;
  if (!S.payAsset || !S.receiveAsset){ host.innerHTML = ''; host.classList.add('hide'); return; }
  host.classList.remove('hide');
  // The flip toggle inverts the SAME-CHAIN ladder's frame; the cross ladder (renderXBook) is fixed to
  // "1 asset = N BTC" and can't honour it — so hide the toggle on cross pairs and never leave a stale
  // flip applied there (C-3).
  const isCross = S.payAsset === 'BTC' || S.receiveAsset === 'BTC';
  if (isCross) S.priceFlip = false;
  const { base, quote } = pairDir(S.payAsset, S.receiveAsset);
  const bm = metaOf(base), qm = metaOf(quote);
  // LAST_MID.price is quote-per-base in the SAME frame the book just rendered (pairDir already applied),
  // so use it only when its base matches the current display base. Labelled "mid" — it IS the book mid,
  // not a last trade (a real last price needs the durable trade log; until then, don't call it "last").
  let midStr = '-';
  if (LAST_MID && LAST_MID.price != null && isFinite(LAST_MID.price) && LAST_MID.price > 0 && LAST_MID.base === base){
    midStr = `${fmtPrice(LAST_MID.price)} ${qm.ticker}`;
  }
  host.innerHTML = `<div class="swpairsel">${esc(bm.ticker)} <span class="swpair-car">/</span> ${esc(qm.ticker)}`
    + (isCross ? '' : ` <button type="button" class="swpairflip" id="swPairFlip" title="Flip price direction" aria-label="Flip price direction"`
      + ` style="background:none;border:0;color:var(--dim);cursor:pointer;font-size:13px;line-height:1;padding:2px 5px;margin-left:5px;border-radius:5px">&#8645;</button>`)
    + `</div>`
    + `<div class="swpair-last">mid <b class="mono">${esc(midStr)}</b></div>`;
  const fb = C.$('swPairFlip');
  if (fb) fb.onclick = (e) => {
    e.stopPropagation();
    S.priceFlip = !S.priceFlip;                                  // swap the DISPLAY direction only
    renderPairBar();                                             // instant heading flip
    requote().catch(()=>{});                                     // re-render book + rate line in the new frame
    renderRecentTrades().catch(()=>{}); renderPairStats().catch(()=>{});   // keep the feed/stats in step
  };
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
  paintOfflineToggle();
  // One CTA. When a pair is chosen but the settlement rails aren't both set, the CTA prompts for them
  // (and setReviewEnabled keeps it disabled) — no order can be placed on an unstated settlement choice.
  const cta = $('swReview');
  if (cta){
    const needRails = !!(S.payAsset && S.receiveAsset) && !(S.payRail && S.recvRail);
    cta.textContent = needRails ? 'Choose how you pay & receive' : 'Place order';
    if (needRails) cta.disabled = true;
  }
}

// The opt-in confidential-RECEIVE control shows ONLY when you are receiving a Sequentia-issued asset
// ON-CHAIN — a blinded (confidential) address is a Sequentia on-chain concept. So it is HIDDEN when:
// no receive asset is chosen yet; the received leg is BTC (the parent chain has no confidential
// transactions); the received leg is over LIGHTNING (there is no on-chain address to blind); or the
// Blinded book is active (both legs already blind by construction, so a per-swap opt-in is redundant).
function paintConfControl(){
  const wrap = C.$('swConfWrap'); if (!wrap) return;
  const route = (S.payAsset && S.receiveAsset) ? findRoute(S.payAsset, S.receiveAsset) : null;
  const recvOverLn = !!(route && route.recvRail === 'ln');
  // A wizard/stepper owning the tab hides the composer — the opt-in belongs to COMPOSING a
  // swap, so it must never float above an in-flight or failed trade view.
  const comp = C.$('swComposer');
  const wizardOwns = !!(comp && comp.classList.contains('hide'));
  const hide = wizardOwns || !S.receiveAsset || S.receiveAsset === 'BTC' || isConfBook() || recvOverLn;
  wrap.style.display = hide ? 'none' : 'flex';
}

// TRUE when the user is PAYING real Bitcoin ON-CHAIN (as opposed to over Lightning, or paying a
// Sequentia asset). The "keep resting while offline" peg is relevant ONLY for this pay leg.
function payingBtcOnChain(){ return S.payAsset === 'BTC' && S.payRail === 'chain'; }

// The "Keep resting while offline" opt-out (spec §5, SBTC design §5). It is the ONE place SBTC
// touches the DEX, and it appears in exactly one situation: paying on-chain BTC AND a LIMIT
// (resting) order. In every other case (market orders, any Lightning leg, or paying an asset) it
// is HIDDEN and irrelevant — those are pure native BTC. Default ON; the placement path reads
// S.keepResting only when payingBtcOnChain() && S.mode === 'post'.
function paintOfflineToggle(){
  const wrap = C.$('swOfflineWrap'); if (!wrap) return;
  const comp = C.$('swComposer');
  const wizardOwns = !!(comp && comp.classList.contains('hide'));
  const show = !wizardOwns && payingBtcOnChain() && S.mode === 'post';
  wrap.style.display = show ? 'flex' : 'none';
  if (!show) return;
  const chk = C.$('swOfflineChk');
  if (chk){
    chk.checked = !!S.keepResting;
    if (!chk._wired){ chk._wired = true; chk.onchange = () => { S.keepResting = !!chk.checked; }; }
  }
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
  S.payRail = null; S.recvRail = null;   // rails are unselected until the user picks (no default)
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
// Market is the default order type; the Market/Limit toggle is always shown and the user switches
// freely. No auto-override (kept as a no-op reconciler so existing callers stay valid).
function applyAutoMode(bookLen, route){
  // Market is the default; the user switches to Limit to rest at their own price. No auto-override:
  // the Market/Limit toggle is available on every pair and never disappears. (args kept for callers.)
  paintModeSeg();
}
function wireModeSeg(){
  const seg = C.$('swModeSeg'); if (!seg || seg._wired) return; seg._wired = true;
  seg.querySelectorAll('button[data-m]').forEach(b => b.onclick = () => { if (!b.disabled) setMode(b.dataset.m); });
}
// Market / Limit is a first-class control on EVERY pair (spec §4/§6.3): MARKET walks the book at the
// best executable price now (partial-filling what's there); LIMIT rests a signed order at YOUR price.
// The toggle never disappears once a pair is chosen — no per-rail hiding.
function paintModeSeg(){
  if (!C) return;
  const wrap = C.$('swModeWrap'), seg = C.$('swModeSeg');
  const show = !!(S.payAsset && S.receiveAsset);
  if (wrap) wrap.classList.toggle('hide', !show);
  if (seg) seg.querySelectorAll('button[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  const hint = C.$('swModeHint');
  if (hint){
    hint.classList.toggle('hide', !show);
    if (show) hint.textContent = S.mode === 'post'
      ? 'Set both amounts; their ratio is your price. Switch to Market to fill at the best price now.'
      : 'Type an amount; the other fills at the best price. Switch to Limit to set your own.';
  }
}
// Switch mode by hand. Market re-links the fields (requote re-derives the opposite at the book price);
// Limit leaves both fields independent (their ratio is the price).
function setMode(m){
  if (m !== 'take' && m !== 'post') return;
  S.mode = m;
  LAST_QUOTE = null; setReviewEnabled(false);
  paintModeSeg();
  requote().catch(()=>{});
}

// Rail choosers (Pay via / Receive via) for EVERY pair (spec §5). RAIL-BLIND: the rails are
// SETTLEMENT preferences, never a route selector or a book filter. They start UNSELECTED — there
// is NO default (spec §6.5) — and an order cannot be placed until BOTH are chosen (gated in
// paintPanes). We never auto-select or force a rail; we only surface an honest LN-readiness note
// for a leg the user actually set to Lightning. Shown for same-chain pairs too: a Sequentia asset
// can settle over SeqLN, so "pay/receive over Lightning" is a real choice on every pair.
function updateRails(){
  const box = C.$('swRailPicks'); if (!box) return;
  const pay = S.payAsset, receive = S.receiveAsset;
  if (!(pay && receive && pay !== receive)){ box.classList.add('hide'); renderRailNote(null); return; }
  box.classList.remove('hide');
  // Probe the sub-asset book (async, cached) so the LN-readiness note reflects live liquidity.
  if (pay === 'BTC' || receive === 'BTC'){ try { refreshSubassetBook(pay === 'BTC' ? receive : pay); } catch {} }
  const ra = lnDeployed() ? railAvail(pay, receive) : null;
  paintRailSegs(ra);
  renderRailNote(ra);
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
    note.innerHTML = `<span>No Lightning channel for this leg yet · one is opened for you when you place the order (this can take a couple of minutes).</span>`
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
  const badTip = 'Coming soon · this asset-over-Lightning with BTC on-chain shape has no maker yet. '
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
        : 'No channel yet · one is opened for you when you place the order.'; }
      b.disabled = bad;
      if (tip) b.title = tip; else b.removeAttribute('title');   // informative title even when selectable
    }); };
  paint('swPayRailSeg', 'pay');
  paint('swRecvRailSeg', 'recv');
}
// Set ONE leg's settlement rail (leg = 'pay' | 'recv'). Rail-blind model: the choice is a
// SETTLEMENT preference only — it never re-selects a route or reshapes the book. It does gate
// placement (both rails must be chosen) and drive the honest LN-readiness note + fee freeze.
function setRail(leg, r){
  const cur = leg === 'pay' ? S.payRail : S.recvRail;
  if (cur === r) return;
  if (leg === 'pay') S.payRail = r; else S.recvRail = r;
  LAST_QUOTE = null; setReviewEnabled(false);
  const ra = lnDeployed() ? railAvail(S.payAsset, S.receiveAsset) : null;
  paintRailSegs(ra);
  try { renderRailNote(ra); } catch {}   // refresh/clear the LN-channel note for the newly-selected rail
  try { renderFeePicker(); } catch {}   // reflect the pay-from-Lightning fee freeze immediately
  try { paintConfControl(); } catch {}  // the confidential-receive toggle depends on the receive rail (on-chain only)
  try { paintPanes(); } catch {}        // re-evaluate the place-CTA gate (both rails now required)
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
  if (!LAST_QUOTE){ const _d = pairDir(S.payAsset, S.receiveAsset); $('swRate').textContent = '1 ' + tk(_d.base) + ' = … ' + tk(_d.quote); }
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
  [pa._refMode, ra._refMode] = [ra._refMode, pa._refMode];           // ref-input mode rides with its value too
  // Flip the per-leg rails WITH the legs (the pay-leg rail follows the asset that is now the pay leg).
  // They stay whatever the user chose (or null if unchosen) — no auto-default.
  [S.payRail, S.recvRail] = [S.recvRail, S.payRail];
  S.edited = S.edited === 'pay' ? 'receive' : 'pay';
  S.feeAsset = null; S.feeAssetTouched = false;   // fee default re-follows the flipped pay asset (D2/C-11)
  LAST_QUOTE = null; setReviewEnabled(false);
  paintPanes();
  requote().catch(()=>{});
}
function onMax(){
  if (!S.payAsset || S.payAsset === 'BTC') return;
  const m = C.assetMeta(S.payAsset);
  let maxAtoms = balAtoms(S.payAsset);
  // Leave headroom for the network fee when it's paid in the SAME asset you're spending — otherwise
  // "Max" spends the whole balance and leaves nothing to cover the fee, so the order fails (C4).
  const feeAsset = S.feeAsset || defaultFeeAsset();
  if (feeAsset === S.payAsset){ const fee = covFeeAtoms(feeAsset); if (maxAtoms > fee) maxAtoms -= fee; }
  C.$('swPayAmt').value = C.fmtAtoms(maxAtoms, m.precision);
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
  // RAIL-BLIND: the rails NEVER change the book, the matching, or the quoted price. They are the user's
  // settlement preference (set by hand, no default). So requote does not touch S.payRail/S.recvRail at
  // all — it fetches the ONE book for the pair and quotes the market/limit against it, rail-blind.
  const route = findRoute(S.payAsset, S.receiveAsset);
  renderTiming(route);   // timing banner reflects the pair
  paintModeSeg();
  if (!route){ setReviewEnabled(false); clearOpposite(); clearBook(); paintCostLine(); stopLiveBook(); return; }
  const amtStr = typedAmount(S.edited);
  // Do NOT bail on an empty amount: the quote functions fetch and RENDER the ONE
  // order book first (so it is visible the moment a pair is chosen, on EVERY rail),
  // then quote only if an amount is present.
  try {
    // Only the same-chain path has the live WS book; other rails render XBOOK/UBOOK, so tear the
    // same-chain stream down when routing away (else a stale subscription keeps patching a hidden BOOK).
    if (route.kind === 'ln')         { stopLiveBook(); await requoteLn(route, amtStr); }
    else if (route.kind === 'cross') { stopLiveBook(); await requoteCross(route, amtStr); }
    else if (route.kind === 'mixed') { stopLiveBook(); await requoteMixed(route, amtStr); }
    else                             await requoteSame(route, amtStr);
  } finally {
    try { paintCostLine(); } catch {}   // E2: the one cost line, after any rail quotes
    // D5/D3: refresh the recent-trades feed + 24h stats only when the PAIR changes (not per keystroke).
    try {
      const pk = (S.payAsset && S.receiveAsset) ? (S.payAsset + '|' + S.receiveAsset) : null;
      if (pk !== _tradesPair){
        _tradesPair = pk;
        if (pk){ renderRecentTrades().catch(()=>{}); renderPairStats().catch(()=>{}); }
        else { const h = C.$('swTrades'); if (h) h.innerHTML = ''; const s = C.$('swPairStats'); if (s) s.innerHTML = ''; }
      }
    } catch {}
  }
}
function clearBook(){ renderBookPlaceholder(); renderPairBar(); }
// E2: ONE honest cost line. A taker always crosses the spread, so surface that as a positive
// magnitude vs the book mid (direction-safe — avoids a confusing "above/below" that flips between
// buy and sell): the price you take NOW vs resting an order at mid. Only in take mode with a live
// mid + both amounts; cleared otherwise. The network fee (in the reference currency) is already
// shown on the fee row, so this line is specifically the spread/immediacy cost the rate line hides.
function paintCostLine(){
  const el = C.$('swCost'); if (!el) return;
  el.textContent = ''; el.title = ''; el.style.color = '';
  if (S.mode === 'post') return;                              // limit order: you set the price
  if (!LAST_QUOTE || !LAST_MID || !(LAST_MID.price > 0)) return;
  if (LAST_MID.oneSided) return;   // only one side of the book exists: "mid" is just top-of-book, so a "% vs mid" would be fake (C-4)
  const payV = fieldUnits(C.$('swPayAmt'), S.payAsset), recvV = fieldUnits(C.$('swRecvAmt'), S.receiveAsset);
  if (!(payV > 0 && recvV > 0)) return;
  const cross = !!LAST_MID.cross, payIsBtc = S.payAsset === 'BTC';
  // Effective execution price in the SAME units as the mid (quote per base, in the frame the book was
  // rendered in). The taker BUYS the base when they RECEIVE it (base === receiveAsset; for cross that's
  // paying BTC): buying wants a LOWER quote-per-base, selling wants a higher one — so the improvement
  // direction follows the side, never mislabelling a favourable price as a "cost".
  const buyingBase = cross ? payIsBtc : (LAST_MID.base === S.receiveAsset);
  const eff = buyingBase ? (payV / recvV) : (recvV / payV);
  const mid = LAST_MID.price;
  if (!(eff > 0 && mid > 0) || !isFinite(eff)) return;
  const betterWhenLower = buyingBase;
  const rawPct = (eff / mid - 1) * 100;                    // + ⇒ effective above mid
  const improvePct = betterWhenLower ? -rawPct : rawPct;   // + ⇒ better for the taker
  const mag = Math.abs(improvePct);
  if (mag < 0.05){ el.textContent = 'at the mid price'; return; }
  // Never HIDE a large deviation (C4): a big number is real price impact from your size walking a thin
  // book — exactly when the taker most needs to see it. Escalate the wording instead of suppressing.
  if (improvePct > 0){
    el.style.color = '#3ddc84';
    el.textContent = `≈ ${mag.toFixed(mag < 1 ? 2 : 1)}% better than mid`;
    el.title = `You take at ~${trim(eff)} vs the ${trim(mid)} mid · better than resting at the mid price.`;
  } else {
    el.style.color = 'var(--amber2)';
    const label = mag > 8 ? 'price impact (thin book) vs mid' : 'spread cost vs mid';
    el.textContent = `≈ ${mag.toFixed(mag < 1 ? 2 : 1)}% ${label}`;
    el.title = `You take at ~${trim(eff)} vs the ${trim(mid)} mid · the cost of filling now (your size walks the book past the best price) instead of resting at the mid.`;
  }
}
// Before a pair is chosen the composer (the pay/receive selectors) IS the surface: the book area stays
// EMPTY so the selectors are the first thing you see, and the pair's detail (book / trades / stats)
// fills in ABOVE them once both assets are picked. When a pair IS chosen but has no resting orders yet,
// show a muted "order book" stand-in rather than a blank void.
function renderBookPlaceholder(){
  const host = C.$('swBook'); if (!host) return;
  if (!S.payAsset || !S.receiveAsset){ host.innerHTML = ''; return; }   // no pair → the composer leads
  host.innerHTML = `<div class="swladder"><div class="swladder-head">`
    + `<span class="sub" style="color:var(--txt);font-weight:650">Order book</span><span class="sub"></span></div>`
    + `<div class="swladder-empty">No resting orders for this pair yet.</div></div>`;
}

function clearOpposite(){
  const other = S.edited === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
  clearDerived(other);   // never stomp a value the user typed or is editing on the OTHER side
}
function setReviewEnabled(on){
  const b = C.$('swReview'); if (!b) return;
  // RAIL-BLIND gate (spec §6.5): never enable placement until BOTH settlement rails are chosen — there
  // is NO default. A ready quote is necessary but not sufficient. paintPanes labels the CTA to prompt.
  const railsChosen = !!(S.payRail && S.recvRail);
  b.disabled = !(on && railsChosen);
}

// Build BOOK (asks/bids split by trade direction, expiry- and signature-filtered, best-price-first)
// from a flat offer list, then render the ladder. Shared by the REST quote path (requoteSame) and
// the live WS book (startLiveBook) so both produce a byte-identical book from the same offers. The
// relay keys markets by exact base/quote order, so a caller passes BOTH orientations' offers merged;
// this dedups by maker:offer_id. Returns the liftable (ask) side for the caller's quote math.
function applyOffersToBook(allOffers, pay, receive){
  const now = Math.floor(Date.now()/1000);
  const notExpired = (o) => { const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0); return !(exp && exp <= now); };
  const seen = new Set(), liftable = [], otherSide = [];
  for (const o of (allOffers || [])){
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
  return liftable;
}

// --- live book (D4): push, not poll ---
// After the REST snapshot renders, subscribe to the relay's WS stream for the selected same-chain
// pair so the ladder ticks in real time as offers appear/expire. The relay sends a `public_book`
// snapshot on subscribe, then `public_order_created` / `public_order_removed` deltas; we hold a
// verified offer set (both market orientations, since the relay keys by exact base/quote) and, on
// any change, rebuild the ladder via applyOffersToBook. Display-only: it re-renders the BOOK ladder
// but never touches the composer or re-derives amounts (B1), so a live tick can't move a field under
// the user — the quote refreshes on the next interaction. WS failure is silent; the 15s poll remains
// the fallback. Transparent book only (the stream doesn't carry the blinded namespace).
let _liveBook = null;   // { relay, key, pay, receive, offers: Map<maker:offerId, offer>, timer, retryTimer }
function _liveKey(pay, receive){ return pay + '␟' + receive; }
function _liveOid(o){ return (o.maker_pubkey||o.makerPubkey)+':'+(o.offer_id||o.offerId); }
// True when the live WS book is currently connected for the pair on screen — drives the "· live"
// header hint so a user can tell the ladder is streaming, not a stale poll snapshot.
function liveBookOn(){ return !!(_liveBook && _liveBook.connected && _liveBook.pay === S.payAsset && _liveBook.receive === S.receiveAsset); }
function stopLiveBook(){
  const lb = _liveBook;
  if (!lb) return;
  _liveBook = null;   // null FIRST, so a pending onClose sees itself superseded and does NOT reconnect
  if (lb.timer)      { try { clearTimeout(lb.timer); } catch {} }
  if (lb.retryTimer) { try { clearTimeout(lb.retryTimer); } catch {} }
  try { lb.relay && lb.relay.close(); } catch {}
}
function startLiveBook(pay, receive){
  if (!pay || !receive) return;
  const key = _liveKey(pay, receive);
  if (_liveBook && _liveBook.key === key) return;   // already streaming this pair (no reopen on keystrokes)
  stopLiveBook();
  const offers = new Map();
  const lb = { relay: null, key, pay, receive, offers, timer: null, retryTimer: null, connected: false };
  // Live only while THIS pair is still the selected transparent-book pair and the tab is visible.
  const stillLive = () => {
    if (_liveBook !== lb || isConfBook()) return false;
    if (S.payAsset !== pay || S.receiveAsset !== receive) return false;
    const host = C.$('swBook'); return !!(host && host.offsetParent !== null);
  };
  // Coalesce bursts (a maker re-post is a remove+create pair; the covenant book has dozens of rows)
  // into at most ~3 re-renders/sec, and only when this pair is still live. After the ladder re-renders
  // (which recomputes LAST_MID), repaint the cost-vs-mid line (T6 freshness) so the "N% vs mid" figure
  // tracks the moving book. Display-only: paintCostLine reads the composer's amounts + the fresh mid
  // and writes one label — it never re-derives or moves an amount field (B1).
  const rebuild = () => { lb.timer = null; if (!stillLive()) return; applyOffersToBook([...offers.values()], pay, receive); try { paintCostLine(); } catch {} };
  const schedule = () => { if (!lb.timer) lb.timer = setTimeout(rebuild, 300); };
  // Retry a failed/dropped connection with a bounded 3s backoff, but only while this pair is still on
  // screen. Used by BOTH onError (the WS never opened) and onClose (it dropped) — the retryTimer guard
  // dedups the two. Without the onError retry, a WS that never connects would leave the ladder frozen at
  // the initial REST snapshot with no live updates (there is no separate book poll fallback).
  const scheduleReconnect = () => {
    lb.connected = false;
    if (_liveBook !== lb || lb.retryTimer || !stillLive()) return;
    lb.retryTimer = setTimeout(() => { lb.retryTimer = null; if (stillLive()) connect(); }, 3000);
  };
  const connect = () => {
    lb.relay = seqob.openRelay(
      [{ base_asset: receive, quote_asset: pay }, { base_asset: pay, quote_asset: receive }],
      {
        onOpen: () => { offers.clear(); lb.connected = true; },   // fresh snapshot incoming; onBook schedules the render (a schedule() here could rebuild a blank map)
        onBook: (b) => { for (const o of (b.offers||[])) offers.set(_liveOid(o), o); schedule(); },
        onOfferCreated: (o) => { offers.set(_liveOid(o), o); schedule(); },
        onOfferRemoved: (r) => { offers.delete(_liveOid(r)); schedule(); },
        onError: scheduleReconnect,
        onClose: scheduleReconnect,   // relay restarted / dropped: reconnect while this pair is still on-screen
      });
  };
  _liveBook = lb;
  connect();
}

// --- same-chain: the unified PLACE-ORDER path (passive-CLOB covenant) ---
// Every same-chain order is "Place order": the two amount fields are the user's own
// limit (their ratio IS the price), and Place funds a self-enforcing covenant that
// rests on-chain and fills whenever it is crossed — even while the wallet is closed.
// The book still renders on the left (any resting orders); clicking a level seeds
// the fields. There is NO take-vs-post distinction — the matcher crosses the order.
let _reqSameGen = 0;   // supersession guard: a newer requoteSame invalidates an older one's in-flight book fetch
async function requoteSame(route, amtStr){
  const { $ } = C;
  const pay = route.pay, receive = route.receive;
  const myGen = ++_reqSameGen;
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
    // Supersession: if a newer requoteSame started (user switched pair) while our two fetches were in
    // flight, bail — rendering now would paint this stale pair's ladder over the new one AND point the
    // live WS subscription at the wrong pair (out-of-order resolution). The newer call owns the render.
    if (myGen !== _reqSameGen) return;
    // Split into asks (liftable: give `receive`, want `pay`) + the opposite side (feeds spread/mid +
    // the depth display), expiry- and signature-filtered, best-price-first. Shared with the live WS
    // book so a REST snapshot and a pushed delta render an identical ladder (see applyOffersToBook).
    const liftable = applyOffersToBook([...(b1.offers||[]), ...(b2.offers||[])], pay, receive);
    // Keep the book live: after the REST snapshot, subscribe to the relay's push stream so the ladder
    // ticks as offers appear/expire, not only on the 15s poll. Transparent book only (the WS stream
    // doesn't carry the blinded namespace); the confidential book toggles the live stream off.
    if (isConfBook()) stopLiveBook(); else startLiveBook(pay, receive);

    // T7: relay unreachable AND nothing to show — say so and let the user retry.
    if (reachErr && !liftable.length){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swRate').textContent = 'Order book unreachable - retry.';
      $('swRoute').textContent = '';
      $('swErr').textContent = 'Could not reach the order-book relay (' + (reachErr.message || reachErr) + '). Check your connection and try again (re-enter the amount to retry).';
      return;
    }
    status.textContent = '';

    // MARKET (default): fill the empty side from the book's best EXECUTABLE price, WITHOUT wiping
    // user input. LIMIT (S.mode==='post'): the two fields are independent — the user sets their own
    // price, so we never auto-derive. (Empty market: best is null -> no derivation either way.)
    const best = bestReceivePerPay(liftable, pay, receive);
    if (S.mode === 'take') applyComposeDerivation(pay, receive, best);
    paintPlaceRate(pay, receive, best, liftable.length);
    if (!S.feeAsset) S.feeAsset = defaultFeeAsset();
    paintFee(S.feeAsset, covFeeAtoms(S.feeAsset));   // compose-time estimate in the chosen fee asset, not "-"
    setFinality('same');

    // Enable Place order once BOTH amounts are set and the pay leg is affordable.
    const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
    const payAtoms  = fieldAtoms($('swPayAmt'), pay);
    const recvAtoms = fieldAtoms($('swRecvAmt'), receive);
    if (payAtoms <= 0n || recvAtoms <= 0n){ LAST_QUOTE = null; setReviewEnabled(false); return; }
    // Affordability: the pay leg AND the funding fee must both be covered. The covenant funding fee is
    // paid in the chosen fee asset (C-1), so when that's the pay asset the balance must cover BOTH; when
    // it's a different asset, that asset must separately cover the fee (C-2).
    const _feeAsset = S.feeAsset || defaultFeeAsset();
    const _feeAtoms = covFeeAtoms(_feeAsset);
    if (payAtoms + (_feeAsset === pay ? _feeAtoms : 0n) > balAtoms(pay)){
      LAST_QUOTE = null; setReviewEnabled(false);
      $('swErr').textContent = _feeAsset === pay
        ? `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker} · not enough for the amount plus the fee.`
        : `You only hold ${C.fmtAtoms(balAtoms(pay), pm.precision)} ${pm.ticker}.`;
      return;
    }
    if (_feeAsset !== pay && _feeAtoms > balAtoms(_feeAsset)){
      LAST_QUOTE = null; setReviewEnabled(false);
      const _fm = C.assetMeta(_feeAsset);
      $('swErr').textContent = `You need about ${C.fmtAtoms(_feeAtoms, _fm.precision)} ${_fm.ticker} for the fee, but hold ${C.fmtAtoms(balAtoms(_feeAsset), _fm.precision)}.`;
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
    $('swErr').textContent = 'Order book: ' + C.prettyErr(e);
    setReviewEnabled(false);
  }
}

// The rate + route lines for the place-order composer.
function paintPlaceRate(pay, receive, best, bookLen){
  const { $ } = C;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payV = fieldUnits($('swPayAmt'), pay), recvV = fieldUnits($('swRecvAmt'), receive);
  const yourPrice = (payV > 0 && recvV > 0) ? recvV / payV : 0;
  // Display "1 base = N quote" (canonical direction); the crossing test stays in native receive-per-pay.
  const yourLine = yourPrice > 0 ? ratePerPayToLine(pay, receive, yourPrice).str : null;
  const bestQ = best ? ratePerPayToLine(pay, receive, best).qpb : 0;
  if (S.mode === 'post'){
    // LIMIT: the user's own price. Compare to the book so they know if/when it crosses.
    if (yourPrice > 0){
      let s = `Limit · ${yourLine}`;
      if (best) s += yourPrice <= best ? ` · crosses now (best ${fmtPrice(bestQ)})` : ` · rests until crossed (best ${fmtPrice(bestQ)})`;
      $('swRate').textContent = s;
    } else {
      $('swRate').textContent = 'Limit · set both amounts; their ratio is your price.';
    }
  } else {
    // MARKET: fill at the best executable offer.
    if (yourPrice > 0 && best){
      // If the order is bigger than the resting depth at this price, it fills what's there now and
      // rests the remainder as a limit — surface that split.
      const split = marketFillSplit(fieldAtoms($('swPayAmt'), pay), fieldAtoms($('swRecvAmt'), receive));
      let s = `Market · ${yourLine} (best offer)`;
      if (split) s += ` · fills ~${trim(Number(split.fill)/Math.pow(10, pm.precision||0))} ${pm.ticker} now, ~${trim(Number(split.rest)/Math.pow(10, pm.precision||0))} rests`;
      $('swRate').textContent = s;
    } else if (best){
      $('swRate').textContent = `Market · fills at ${ratePerPayToLine(pay, receive, best).str} · set an amount.`;
    } else {
      $('swRate').textContent = bookLen
        ? 'No crossable offers yet · set both amounts to rest an order (their ratio is your price).'
        : 'No resting orders yet · set both amounts to place the first order.';
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

// THE amount a field actually MEANS, in the asset's atoms. When the ⇄ toggle put the
// field in reference-currency (USD) input mode, its raw text is a USD number, NOT native
// units — C.assetAmountOf converts it back to the exact asset amount string (the same one
// the ⇄ hint shows). Reading `el.value` raw in USD mode was the bug where "10 USD" became
// "10 BTC" (470,159 EURX for a $6 buy). Every compose/quote/review/place atoms-read MUST
// go through this, never safeAtoms(el.value, …) directly on a user-facing amount field.
function fieldAtoms(el, hex){
  if (!el) return 0n;
  const prec = C.assetMeta(hex).precision || 0;
  let s;
  try { s = C.assetAmountOf(el, hex); } catch { s = null; }
  if (s == null) s = el._refMode ? '' : (el.value || '');   // fail safe: never treat a USD number as native
  return safeAtoms(s, prec);
}
// numVal that honors ref mode: the field's numeric value in ASSET units (for affordability
// display / >0 checks). In USD mode the raw number is meaningless as an asset amount.
function fieldUnits(el, hex){ const a = fieldAtoms(el, hex); const prec = C.assetMeta(hex).precision || 0; return Number(a) / Math.pow(10, prec); }

// Write a fixed NATIVE amount into a field for a whole-offer lift (the amount the user can't
// change — it's the maker's exact terms). Force the field OUT of ⇄ reference-currency mode so
// the native number is never mislabeled as USD (and a later fieldAtoms read doesn't try to
// convert a native number as if it were USD). Marks it derived, not user-typed.
function setNativeField(el, str){
  if (!el) return;
  if (el._refMode){ el._refMode = false; try { paintRefHints(); } catch {} }
  el._userTyped = false;
  el.value = str;
}

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
  const pv = fieldUnits($('swPayAmt'), pay), rv = fieldUnits($('swRecvAmt'), receive);
  const hasBook = !!(BOOK.offers && BOOK.offers.length);
  LAST_QUOTE = { kind:'same', startMarket:true, post:true, pay, receive };
  if (pv > 0 && rv > 0){
    $('swRate').textContent = `Your price · ${ratePerPayToLine(pay, receive, rv/pv).str} · Post to rest this offer.`;
  } else {
    $('swRate').textContent = hasBook
      ? `Set both amounts · their ratio is your limit price · then Post a resting offer.`
      : `No resting offers yet · set both amounts (their ratio is your price) to post the first order.`;
  }
  $('swRoute').textContent = hasBook ? 'Order book · post a limit order' : 'Order book · be the first';
  paintFee(S.feeAsset, covFeeAtoms(S.feeAsset));   // compose-time estimate in the chosen fee asset, not "-"
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
    feeRate = C.feeRateFor(feeAsset);   // tSEQ is priced from the feed like every other asset — no SEQ=1 privilege
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
  // Write the side we did NOT edit (writeDerived guarantees the user's typed field is never stomped).
  if (S.edited === 'pay'){
    writeDerived($('swRecvAmt'), C.fmtAtoms(q.amountR, rm.precision));
  } else {
    writeDerived($('swPayAmt'), C.fmtAtoms(q.amountP, pm.precision));
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
      writeDerived(ra, fmtUnits(other, btcIsPay ? aprec : 8));
    } else {
      const v = numVal(ra); if (!(v > 0)) return;
      const other = btcIsPay ? (v * btcPerAsset) : (v / btcPerAsset);
      // derived leg is the PAY side: BTC when BTC is paid, otherwise the asset.
      writeDerived(pa, fmtUnits(other, btcIsPay ? 8 : aprec));
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
      $('swRate').textContent = `No resting ${am.ticker}→BTC sell offer right now · try again shortly.`;
      $('swRoute').textContent = 'Mixed rails · sell over Lightning, receive BTC on-chain';
      setReviewEnabled(false); renderTiming(route); return;
    }
    // MED-4: format each leg at its own precision (asset at am.precision, BTC at 8), not the
    // generic 8dp trim(), so a sub-8-decimal asset writes a re-parseable value into the field.
    const assetStr = C.fmtAtoms(BigInt(offer.asset_amount), am.precision || 0);
    const btcStr = C.fmtAtoms(BigInt(offer.btc_sats), 8);
    setNativeField($('swPayAmt'), assetStr);
    setNativeField($('swRecvAmt'), btcStr);
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
      $('swRate').textContent = `No resting BTC→${am.ticker} buy offer right now · try again shortly.`;
      $('swRoute').textContent = 'Mixed rails · buy over Lightning, pay BTC on-chain';
      setReviewEnabled(false); renderTiming(route); return;
    }
    const assetStr = C.fmtAtoms(BigInt(offer.asset_amount), am.precision || 0);
    const btcStr = C.fmtAtoms(BigInt(offer.btc_sats), 8);
    // Capture what the user typed to SPEND (the BTC pay field) BEFORE we overwrite it with the offer's
    // amounts: this rail lifts the WHOLE offer, so if the offer's BTC differs materially from the typed
    // amount, say so (mirror the cross/pure-LN whole-offer note) instead of silently overwriting.
    const typedBtcU = parseFloat(String($('swPayAmt').value || '').replace(/,/g, '')) || 0;
    const offerBtcU = Number(BigInt(offer.btc_sats)) / 1e8;
    setNativeField($('swRecvAmt'), assetStr);
    setNativeField($('swPayAmt'), btcStr);
    let mixRate = `${btcStr} BTC → ${assetStr} ${am.ticker} · best resting offer`;
    if (typedBtcU > 0 && offerBtcU > 0 && Math.abs(offerBtcU - typedBtcU) / offerBtcU > 0.02)
      mixRate += ` · ⚠ lifts the whole offer (${btcStr} BTC), not the ${trim(typedBtcU)} you entered`;
    $('swRate').textContent = mixRate;
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
      ? `1 ${am.ticker} = ${trim(btcU / assetU)} BTC · best resting offer`
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
  const both = fieldUnits($('swPayAmt'), S.payAsset) > 0 && fieldUnits($('swRecvAmt'), S.receiveAsset) > 0;
  $('swRate').textContent = both
    ? `Your price · ${reverse ? `buy ${am.ticker} with BTC` : `sell ${am.ticker} for BTC`} · Post to rest this offer.`
    : `Set both amounts (the ${am.ticker} and the BTC) · their ratio is your price · then Post.`;
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
      $('swErr').textContent = 'Could not reach the cross-chain order book (' + (unreachable === true ? 'relay unreachable' : unreachable) + '). Check your connection and try again (re-enter the amount to retry).';
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
    // Courier lifts the chosen offer WHOLE (no partial fill): when its size EXCEEDS the request there
    // is no "rests" remainder — the taker simply takes MORE than they typed, and locks the offer's
    // larger BTC. Carry that so the paint, the affordability gate, and Review all use the REAL
    // committed amounts, not the smaller request (mirrors the pure-LN whole-offer note). The courier
    // quote's fee_btc is 0 because the maker sets the lift fee at claim time, not a genuine zero.
    const wholeOffer = !!rawXq.courier;
    const offerSeqAtoms = big(rawXq.seq_amount), offerBtcAtoms = big(rawXq.btc_amount);
    const overshoot = wholeOffer && offerSeqAtoms > reqSeqAtoms;
    LAST_QUOTE = { kind:'cross', reverse: !route.payIsBtc, route, xq: rawXq, seqAsset,
      requestedSeqAtoms: reqSeqAtoms, requestedBtcAtoms: reqBtcAtoms, fillSeqAtoms: fillSeq,
      remainderSeqAtoms: hasRemainder ? remSeq : 0n, remainderBtcAtoms: remBtc,
      wholeOffer, overshoot, offerSeqAtoms: String(offerSeqAtoms), offerBtcAtoms: String(offerBtcAtoms) };
    status.textContent = '';
    paintQuoteCross();
    // AFFORDABILITY (C4): the cross take funds the fill now AND rests the remainder, so the FULL
    // requested pay amount is committed — gate Review on it, like the same-chain path, instead of
    // letting the user start a swap they can't fund. For a whole-offer overshoot the real commit is the
    // OFFER's size, which is larger than the request, so gate on THAT (else a user who can afford their
    // typed amount but not the whole offer passes Review and fails at funding).
    const _payAtoms = overshoot ? (route.payIsBtc ? offerBtcAtoms : offerSeqAtoms)
                                : (route.payIsBtc ? reqBtcAtoms : reqSeqAtoms);
    const _payBal   = balAtoms(route.payIsBtc ? 'BTC' : seqAsset);
    // Paying BTC funds an on-chain HTLC whose funding tx also needs a Bitcoin miner fee on top of the
    // locked amount, so reserve a little headroom (the exact fee is computed at btcBuildTx). Without it a
    // near-max BTC buy passes Review and then fails when the funding tx is built. Same class as onMax's
    // same-asset fee headroom; BTC side only.
    const _payNeed = route.payIsBtc ? (_payAtoms + 1000n) : _payAtoms;
    if (_payNeed > _payBal){
      $('swErr').textContent = `You only hold ${C.fmtAtoms(_payBal, route.payIsBtc ? 8 : seqPrec)} ${route.payIsBtc ? 'BTC' : am.ticker}${route.payIsBtc ? ' (an on-chain fee is also needed)' : ''} · reduce the amount.`;
      setReviewEnabled(false);
      return;
    }
    setReviewEnabled(true);
  } catch (e){
    status.textContent = '';
    $('swErr').textContent = 'Cross-chain order book: ' + C.prettyErr(e);
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
  bids.sort((a, b) => b.price - a.price);
  { let c = 0; const t = bids.reduce((s, r) => s + r.size, 0) || 1; bids.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  // (onClick was assigned per-branch above: seed-amount for the merged book, fillFromXOffer for the
  // on-chain fallback. The clickable side is the one takeable in the user's current direction.)
  const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  LAST_MID = { price: mid, cross: true, base: seqAsset, quote: 'BTC', oneSided: !(bestAsk != null && bestBid != null) };
  renderLadder(host, {
    asks: asks.slice(0, 8).reverse(), bids: bids.slice(0, 8), mid, spread,   // 8 BEST (lowest) asks, shown high->low near the mid
    priceLabel: `(${am.ticker}/BTC)`, sizeLabel: am.ticker,
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
  // Clicking a book level is an EXPLICIT user amount — mark it _userTyped so the requote's
  // derivation fills the OTHER leg and never overwrites this chosen size.
  if (XBOOK.payIsBtc){ S.edited = 'receive'; const el = C.$('swRecvAmt'); el.value = C.fmtAtoms(asset, am.precision || 0); el._userTyped = true; const o = C.$('swPayAmt'); if (o) o._userTyped = false; }
  else               { S.edited = 'pay';     const el = C.$('swPayAmt');  el.value = C.fmtAtoms(asset, am.precision || 0); el._userTyped = true; const o = C.$('swRecvAmt'); if (o) o._userTyped = false; }
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
      <span>${r.mine ? '<i class="swlyou">you</i>' : ''}${esc(fmtPrice(r.price))}</span><span>${esc(fmtGroup(r.size))}</span><span>${esc(fmtGroup(r.cum != null ? r.cum : r.size))}</span>
      <i class="swldepth" style="width:${w}%"></i></button>`;
  };
  const asks = o.asks || [], bids = o.bids || [];
  const asksHtml = asks.map((r, i) => rowHtml('ask', r, i)).join('');
  const bidsHtml = bids.map((r, i) => rowHtml('bid', r, i)).join('');
  const hasRows = asks.length || bids.length;
  const cols = `<div class="swladder-cols"><span>Price ${esc(o.priceLabel || '')}</span><span>Size${o.sizeLabel ? ' (' + esc(o.sizeLabel) + ')' : ''}</span><span>Sum</span></div>`;
  const midHtml = hasRows
    ? `<div class="swlmid"><b>${o.mid != null ? esc(fmtPrice(o.mid)) : '-'}</b> <span class="sp">${o.spread != null ? 'spread ' + esc(fmtPrice(o.spread)) + ' · mid' : 'best price'}</span> <span>${esc(o.refMidStr || '')}</span></div>`
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
  // Show the user's FULL requested amount (never the fillable sliver): the order they typed. EXCEPT a
  // courier whole-offer overshoot, where the lift takes the OFFER's larger size — show THAT (the real
  // commit), not the smaller request, so the panes match what actually locks.
  const reqSeq = q.overshoot ? BigInt(q.offerSeqAtoms)
                             : (q.requestedSeqAtoms != null ? BigInt(q.requestedSeqAtoms) : big(q.xq.seq_amount));
  const reqBtc = q.overshoot ? BigInt(q.offerBtcAtoms)
                             : (q.requestedBtcAtoms != null ? BigInt(q.requestedBtcAtoms) : big(q.xq.btc_amount));
  const seqStr = C.fmtAtoms(reqSeq, sm.precision);
  const btcStr = C.fmtAtoms(reqBtc, 8);
  // Map BTC<->asset onto pay/receive panes (whichever the user has on each side).
  const btcIsPay = (S.payAsset === 'BTC');
  if (btcIsPay){
    writeDerived($('swPayAmt'),  btcStr);
    writeDerived($('swRecvAmt'), seqStr);
  } else {
    writeDerived($('swPayAmt'),  seqStr);
    writeDerived($('swRecvAmt'), btcStr);
  }
  paintRefHints();
  const seqUnits = Number(reqSeq) / Math.pow(10, sm.precision || 0);
  const btcUnits = Number(reqBtc) / 1e8;
  let line = seqUnits > 0 ? `1 ${sm.ticker} = ${trim(btcUnits / seqUnits)} BTC · cross-chain HTLC` : `cross-chain HTLC`;
  // Market order bigger than the maker's depth: say how much fills now and how much rests — the
  // same "fills ~X now, ~Y rests" language the same-chain route uses. No more "Capped — reduce it".
  const rem = q.remainderSeqAtoms != null ? BigInt(q.remainderSeqAtoms) : 0n;
  if (rem > 0n){
    const fillU = Number(BigInt(q.fillSeqAtoms)) / Math.pow(10, sm.precision || 0);
    const restU = Number(rem) / Math.pow(10, sm.precision || 0);
    line += ` · fills ~${trim(fillU)} ${sm.ticker} now, ~${trim(restU)} rests`;
  }
  // Whole-offer overshoot: the courier lifts this offer IN FULL (no partial fill on the cross rail), so
  // it takes more than the user typed. Say so plainly in the composer's info line — the same honesty the
  // pure-LN rail's Review note gives — rather than surfacing the larger amount only in the final modal.
  if (q.overshoot){
    const reqU = Number(BigInt(q.requestedSeqAtoms)) / Math.pow(10, sm.precision || 0);
    line += ` · ⚠ fills whole: takes ${trim(Number(reqSeq) / Math.pow(10, sm.precision || 0))} ${sm.ticker} for ${btcStr} BTC (more than the ${trim(reqU)} you entered · partial fills aren't possible here)`;
  }
  $('swRate').textContent = line;
  // Cross-chain "fee" is the maker fee in BTC (no open fee-asset market on the BTC leg). The courier
  // quote does not know it up front (the maker sets it at lift), so never show a misleading "0 BTC".
  if (q.wholeOffer && (!q.xq.fee_btc || big(q.xq.fee_btc) === 0n))
    paintFee('BTC', null, 'Maker fee set at lift · added to the BTC you lock on the parent chain.');
  else
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
    ? `In ${fm.ticker} · the asset you pay over Lightning.`
    : payIsBtc
    ? 'In BTC · the Bitcoin network fee for the parent-chain leg (sat/vB).'
    : 'Pay the fee in any asset the network prices.');
  // The fee picker is disabled when paying from Lightning (fee frozen to the pay asset), and for
  // the cross-chain (BTC-only) leg / LN leg / mixed rail (their cost is the LP spread / BTC-leg fee
  // baked into the rate, not a taker-funded open-market network fee).
  const noFee = payFromLn || (LAST_QUOTE && (LAST_QUOTE.kind === 'cross' || LAST_QUOTE.kind === 'ln' || LAST_QUOTE.kind === 'mixed'));
  $('swFeePick').disabled = !!noFee;
  $('swFeePick').style.opacity = noFee ? '.5' : '';
  if (payFromLn) $('swFeePick').title = `Paying over Lightning · the fee is in ${fm.ticker}, the asset you pay.`;
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
    S.feeAsset = hex; S.feeAssetTouched = true; renderFeePicker();
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
    tx.innerHTML = '<b>Instant &amp; final</b> · both legs on Lightning, nothing on-chain, no reorg risk.';
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
    S.payRail = null; S.recvRail = null;   // rails reset to unselected for the new pair (no default; user must pick)
    S.feeAsset = null; S.feeAssetTouched = false; S.priceFlip = false;   // fee default re-follows the new pay asset; a manual pick + display flip are per-pair, not global (D2/C-11)
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
    // E1: verified ✓ / unregistered ⚠ trust badge next to the ticker (same signal as the Balance list).
    try { const tb = C.trustBadge && C.trustBadge(it.hex); if (tb) t.appendChild(tb); } catch {}
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
    if (capped) listEl.appendChild(el('div','swopt-more', `+${all.length - ALL_CAP} more · keep typing to find them.`));
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
  if (q.kind === 'cross-make'){
    // BUY-with-BTC LIMIT + "keep resting while offline" ON -> the SBTC silent peg: rest as a covenant
    // that survives the wallet closing (spec §5). `reverse` = BUY the asset with BTC (the only side
    // that PAYS BTC). Everything else (SELL for BTC, toggle OFF, or no SBTC on this network) stays on
    // the interactive HTLC maker path.
    if (q.reverse && S.keepResting && payingBtcOnChain() && sbtcAssetId()) return postPeggedBtcReview(q);
    return postCrossOfferReview(q);
  }
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
async function fundCovenant(covAddr, spkHex, assetHex, atoms, feeAsset){
  const addr = new C.wasm.Address(covAddr);
  // C-1: pay the funding fee in the CHOSEN fee asset (open fee market), not silently in tSEQ. applyFee
  // prices any asset — tSEQ included — from the feed, so the fee the user is shown ("Fee paid in: X") is
  // the fee actually charged. Falls back to the pay asset if no fee asset was resolved.
  const b = C.network.txBuilder().addExplicitRecipient(addr, BigInt(atoms), new C.wasm.AssetId(assetHex));
  const pset = C.applyFee(b, feeAsset || assetHex).finish(C.wollet);
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

async function placeCovenant(pay, receive, payAtoms, recvAtoms, onStatus, opts){
  opts = opts || {};
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
  // FUND-SAFETY (persist-BEFORE-broadcast): fundCovenant broadcasts the on-chain funding tx and then
  // polls ~30s to resolve the vout. A tab close/crash/reload in that window would lock asset A in a
  // covenant with NO local record — permanently stranded, because the reclaim needs makerIndex +
  // sellAtoms/recvAtoms + expiry + spkHex to re-derive the refund taptree. So persist the full reclaim
  // material NOW, with covTxid null; resumeCovenantOrders locates the outpoint by spkHex on the next
  // load if we die mid-broadcast. offerId is minted here (deterministic, no dependence on the funded tx).
  const offerId = seqob.randHex(16);
  const rec = {
    offerId, pay, receive,
    sellAtoms: String(payAtoms), recvAtoms: String(recvAtoms),
    makerIndex: idx, covTxid: null, covVout: null, spkHex: plan.spkHex,
    expiry: params.expiryLocktime, created: Date.now(), posted: false,
    // SBTC silent peg: the covenant locks `pay` (SBTC) but was ADVERTISED as `advertiseOfferAssetAs`
    // (BTC). Tag it so the cancel/refund path knows to peg the reclaimed SBTC back OUT to real BTC
    // (the user paid BTC and expects BTC back). Absent for ordinary same-chain orders.
    ...(opts.advertiseOfferAssetAs ? { pegged: true, advertiseAs: opts.advertiseOfferAssetAs } : {}),
  };
  PLACED.push(rec); savePlaced();
  onStatus && onStatus('Funding the order on-chain…');
  const { txid, vout } = await fundCovenant(covAddr, plan.spkHex, pay, payAtoms, S.feeAsset || defaultFeeAsset());
  rec.covTxid = txid; rec.covVout = vout; savePlaced();   // outpoint known -> reclaim is fully self-contained
  const covenant = buildCovenantTerms(plan.order, txid, vout, plan.tap);
  const offer = buildCovenantOffer({
    assetA: pay, assetB: receive, sellAtoms: BigInt(payAtoms), recvAtoms: BigInt(recvAtoms),
    covenant, makerPubkey: makerPubHex(), recvAddress: payout.address, offerId,
    allowPartial: true, minLot,                           // fill what crosses now; the covenant's remainder rests on
    advertiseOfferAssetAs: opts.advertiseOfferAssetAs,     // SBTC peg: advertise BTC while the covenant locks SBTC
  });
  onStatus && onStatus('Posting your resting order…');
  await seqob.postCovenantOffer(offer, makerPriv());
  rec.posted = true; savePlaced();   // the relay accepted it; it is now a live resting order
  ensureCovenantRelay();   // watch for a match so we can settle / reflect a fill
  return rec;
}

// ---------------------------------------------------------------------------
// SBTC silent peg — rest an on-chain-BTC LIMIT order while the wallet is offline
// ---------------------------------------------------------------------------
// The ONE place SBTC touches the DEX (spec §5, sbtc-peg-design.md). Used ONLY for BUY-with-BTC LIMIT
// orders with "keep resting while offline" ON. Everything else (market orders, any Lightning leg,
// selling an asset for BTC) stays pure native BTC on the interactive cross rail.

// The SBTC asset id, resolved from the registry (ticker SBTC), or null if the bridge asset isn't
// registered on this network — then the silent peg is simply unavailable and we fall back to native.
function sbtcAssetId(){
  try { return sbtc.resolveSbtcAsset((C.registryAssets && C.registryAssets()) || [], (h) => (C.assetMeta(h) || {}).ticker); }
  catch { return null; }
}

// Persisted pending peg-ins so a BUY-with-BTC resting order survives the wallet closing during the
// (multi-block) peg-in wait and resumes to post its covenant on reopen. FUND-SAFETY: the bridge
// credits SBTC to `seqAddr` regardless of this wallet, so a crash never loses funds — worst case the
// user simply holds SBTC to reconcile, and resumePegIns finishes the covenant post next load.
const PEGPENDING_KEY = 'swk.sequentia.pegpending';
function loadPegPending(){ try { return JSON.parse(localStorage.getItem(PEGPENDING_KEY) || '[]'); } catch { return []; } }
function savePegPending(list){ try { localStorage.setItem(PEGPENDING_KEY, JSON.stringify(list)); } catch {} }
function upsertPegPending(rec){ const l = loadPegPending().filter((r) => r.id !== rec.id); l.push(rec); savePegPending(l); }
function dropPegPending(id){ savePegPending(loadPegPending().filter((r) => r.id !== id)); }

// Poll THIS wallet's SBTC balance until it has risen by >= `amount` (the bridge minted the peg-in).
// Generous timeout: a peg-in needs BTC confirmations. The caller shows a waiting status; on timeout
// the funds are safe (SBTC will still arrive) and the order can be re-opened once credited.
async function awaitSbtcCredit(sbtcHex, before, amount, timeoutMs){
  const deadline = Date.now() + (timeoutMs || 45 * 60 * 1000);
  while (Date.now() < deadline){
    try { if (C.refreshBalances) await C.refreshBalances(); } catch {}
    if (balAtoms(sbtcHex) - before >= amount) return true;
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('The peg-in hasn’t been credited yet. Your BTC is safe at the bridge and your SBTC will arrive; re-open the order once it does.');
}

// Maker flow: peg the maker's real BTC IN to SBTC, then rest that SBTC in a covenant ADVERTISED as a
// BTC offer on the asset/BTC market (advertiseOfferAssetAs='BTC') so BTC takers find + fill it (and
// peg out to real BTC). btcSats = BTC paid; assetHex/assetAtoms = the asset + amount wanted.
async function placePeggedBtcCovenant(assetHex, btcSats, assetAtoms, onStatus){
  const sbtcHex = sbtcAssetId();
  if (!sbtcHex) throw new Error('SBTC (the pegged-BTC asset) isn’t available on this network, so an offline-resting BTC order can’t be placed. Turn off “keep resting while offline” to rest as native BTC.');
  if (BigInt(btcSats) <= 0n || BigInt(assetAtoms) <= 0n) throw new Error('Enter both the BTC you pay and the amount you want.');
  const haveBtc = balAtoms('BTC');
  if (BigInt(btcSats) > haveBtc) throw new Error(`You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`);

  // A fresh TRANSPARENT Sequentia address of THIS wallet to receive the minted SBTC (principle #6).
  const seqAddrRaw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const seqAddr = (seqAddrRaw.toUnconfidential ? seqAddrRaw.toUnconfidential() : seqAddrRaw).toString();

  onStatus && onStatus('Preparing the peg-in…');
  const depositAddr = await sbtc.requestPegIn(seqAddr);

  // Persist the intent BEFORE broadcasting the BTC deposit, so a crash after broadcast can resume.
  const rec = { id: seqob.randHex(8), seqAddr, depositAddr, btcSats: String(btcSats),
                assetHex, assetAtoms: String(assetAtoms), sbtcHex, btcTxid: null,
                beforeSbtc: String(balAtoms(sbtcHex)), phase: 'depositing', created: Date.now() };
  upsertPegPending(rec);

  onStatus && onStatus('Sending your BTC to the peg…');
  await C.btcLeg.payAddress(depositAddr, Number(btcSats), (txid) => {
    rec.btcTxid = txid; rec.phase = 'minting'; upsertPegPending(rec);
  });

  onStatus && onStatus('Waiting for the bridge to mint SBTC (this can take a few blocks)…');
  await awaitSbtcCredit(sbtcHex, BigInt(rec.beforeSbtc), BigInt(btcSats));

  onStatus && onStatus('Resting your order…');
  const posted = await placeCovenant(sbtcHex, assetHex, BigInt(btcSats), BigInt(assetAtoms), onStatus,
    { advertiseOfferAssetAs: 'BTC' });
  dropPegPending(rec.id);   // peg-in complete + order resting
  return posted;
}

// Resume any peg-in that was mid-flight when the wallet last closed: if its SBTC has since been
// credited, finish by posting the covenant; otherwise leave it pending (it will credit and resume
// later). Called on load, alongside resumeCovenantOrders. Never re-sends BTC (idempotent by record).
export async function resumePegIns(){
  for (const rec of loadPegPending()){
    try {
      if (!rec.btcTxid) { dropPegPending(rec.id); continue; }   // never broadcast; nothing pegged in
      const have = balAtoms(rec.sbtcHex) - BigInt(rec.beforeSbtc || '0');
      if (have < BigInt(rec.btcSats)) continue;                 // not yet credited; leave it pending
      await placeCovenant(rec.sbtcHex, rec.assetHex, BigInt(rec.btcSats), BigInt(rec.assetAtoms), null,
        { advertiseOfferAssetAs: 'BTC' });
      dropPegPending(rec.id);
    } catch (e){ /* leave pending; a later load retries */ }
  }
}

// TAKER path: fill a resting pegged-BTC covenant (a bid advertised as BTC, locking SBTC) by posting a
// crossing order over the covenant relay WS. The relay matches it against the covenant and hands us
// the terms; onCovMatched settles the fill (we pay `assetHex`, receive SBTC) and then pegs the SBTC
// out to real BTC. assetHex/assetAtoms = what we pay; btcSats = the BTC we're buying.
async function takePeggedCovenant(assetHex, assetAtoms, btcSats, onStatus){
  if (BigInt(assetAtoms) <= 0n || BigInt(btcSats) <= 0n) throw new Error('Enter both amounts.');
  const m = C.assetMeta(assetHex);
  const have = balAtoms(assetHex);
  if (BigInt(assetAtoms) > have) throw new Error(`You only hold ${C.fmtAtoms(have, m.precision)} ${m.ticker}.`);
  // Watch the covenant's market (BTC/asset shelf) so onCovMatched fires + settles when we cross it.
  if (!EXTRA_COV_MARKETS.some((x) => x.base_asset === 'BTC' && x.quote_asset === assetHex))
    EXTRA_COV_MARKETS.push({ base_asset: 'BTC', quote_asset: assetHex });
  ensureCovenantRelay();
  const raw = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const recvAddr = (raw.toUnconfidential ? raw.toUnconfidential() : raw).toString();
  const now = Math.floor(Date.now() / 1000);
  // BUY base=BTC with quote=asset on the BTC/asset shelf — the counter-side of the covenant's SELL of
  // BTC (validator BUY: offer_asset==quote, want_asset==base, want_amount==base_amount).
  const offer = {
    offer_id: seqob.randHex(16), schema_version: 1,
    pair: { base_asset: 'BTC', quote_asset: assetHex },
    trade_dir: 2,                                    // BUY
    base_amount: String(btcSats),
    offer_amount: String(assetAtoms), offer_asset: assetHex,
    want_amount: String(btcSats),  want_asset: 'BTC',
    allow_partial: true,
    created_at_unix: String(now), expires_at_unix: String(now + 3600),
    fee_asset_hint: assetHex,
    same_chain: { maker_recv_address: recvAddr },    // for any resting remainder
  };
  seqob.signOffer(offer, makerPriv());
  onStatus && onStatus('Posting your order to cross the resting bid…');
  await postToCovRelay(offer);
  return { offerId: offer.offer_id };
}

// Post an offer over the covenant relay WS (so a resulting match routes back to onCovMatched). Waits
// briefly for the WS to open. Reuses the shared COVRELAY (already carrying the onMatched -> settle +
// peg-out wiring); the market must already be subscribed (takePeggedCovenant adds it).
async function postToCovRelay(offer){
  ensureCovenantRelay();
  if (!COVRELAY) throw new Error('order-book relay unavailable');
  const ws = COVRELAY.ws;
  if (!(ws && ws.readyState === 1)){
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the order-book relay did not open in time')), 8000);
      const tick = () => {
        if (ws && ws.readyState === 1){ clearTimeout(t); resolve(); }
        else if (!ws || ws.readyState >= 2){ clearTimeout(t); reject(new Error('relay connection closed')); }
        else setTimeout(tick, 150);
      };
      tick();
    });
  }
  COVRELAY.post(offer);
}

// Send `atoms` of a Sequentia asset to `toAddr` (a plain transfer; fee in the chosen fee asset).
// Used by the taker peg-OUT to hand the just-received SBTC back to the bridge.
async function sendSeqAsset(toAddr, assetHex, atoms){
  const addr = new C.wasm.Address(toAddr);
  const b = C.network.txBuilder().addExplicitRecipient(addr, BigInt(atoms), new C.wasm.AssetId(assetHex));
  const pset = C.applyFee(b, S.feeAsset || defaultFeeAsset()).finish(C.wollet);
  const signed = C.signer.sign(pset);
  const finalized = C.wollet.finalize(signed);
  const t = await C.client.broadcast(finalized);
  return (t && t.toString) ? t.toString() : String(t);
}

// Peg the taker's just-received SBTC back OUT to real BTC. When a taker fills a covenant that was
// ADVERTISED as BTC (the SBTC silent peg), the on-chain fill pays them in SBTC — but they were buying
// BTC, so the wallet immediately redeems it: ask the bridge for a peg-out address bound to a wallet
// BTC address, send the SBTC there, and the bridge releases real BTC. Best-effort + safe: on any
// failure the user simply holds redeemable SBTC (never lost). `atoms` = the SBTC just received.
async function pegOutReceivedSbtc(atoms){
  if (BigInt(atoms) <= 0n) return;
  const btcDest = C.btcLeg && C.btcLeg.receiveAddress ? C.btcLeg.receiveAddress() : null;
  if (!btcDest) throw new Error('no BTC address to redeem to');
  const sbtcAddr = await sbtc.requestPegOut(btcDest);
  await sendSeqAsset(sbtcAddr, sbtcAssetId(), BigInt(atoms));
  try { C.toast && C.toast('Redeeming your SBTC to BTC at the bridge…'); } catch {}
}

// TRUE if an inbound covenant match paid us in SBTC for what we were buying as BTC — i.e. we lifted a
// silent-peg bid (advertised BTC, locks SBTC) and must peg the SBTC out. Distinguished from a genuine
// SBTC trade (where the market itself is SBTC/…, so the advertised pair carries no BTC sentinel).
function isPeggedFillToRedeem(m){
  const ct = m.covenant || m.Covenant || {};
  const gotAsset = String(ct.asset_a || ct.assetA || '').toLowerCase();
  const sbtcHex = (sbtcAssetId() || '').toLowerCase();
  if (!sbtcHex || gotAsset !== sbtcHex) return false;           // we didn't receive SBTC
  const pair = m.pair || m.Pair || {};
  const advertisedBtc = String(pair.base_asset || pair.baseAsset || '') === 'BTC'
    || String(pair.quote_asset || pair.quoteAsset || '') === 'BTC';
  return advertisedBtc;                                          // received SBTC on a BTC-advertised market -> redeem
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
    const rate = C.feeRateFor(feeAsset);   // tSEQ is priced from the feed like every other asset — no SEQ=1 privilege
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
    // minLot MUST equal what placeCovenant committed into the funded covenant
    // (covenantMinLot(sellAtoms) = sellAtoms/1000), NOT the all-or-nothing sellAtoms:
    // minLot is pushed into the fill leaf, which sets the merkle root, the tweaked
    // output key/spk AND the refund control block's sibling hash. The old
    // BigInt(rec.sellAtoms) re-derived a DIFFERENT taptree, so every cancel/refund
    // built a consensus-invalid taproot spend and the locked asset was unreclaimable.
    rateNum, rateDen, minLot: covenantMinLot(BigInt(rec.sellAtoms)),
    makerProg: payout.program, makerVer: 1,
    expiryLocktime: Number(rec.expiry), makerX: payout.internalKey,
  };
  // The promised guard (was missing): re-derive the spk and refuse to build a refund
  // against a record whose taptree does not reproduce the funded covenant. verifyAgainstSPK
  // throws loudly on a mismatch — better than silently broadcasting a consensus-invalid spend.
  if (rec.spkHex) covVerifyAgainstSPK(order, rec.spkHex);
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
// Extra markets the covenant relay must also watch even without a resting order of ours on them:
// when we are the TAKER crossing someone's covenant (e.g. lifting a pegged-BTC bid), we must be
// subscribed so onCovMatched fires and we settle the fill. Added by takePeggedCovenant.
let EXTRA_COV_MARKETS = [];
function covMarkets(){
  const seen = new Set(), out = [];
  const add = (base, quote) => { const k = base+'/'+quote; if (!seen.has(k)){ seen.add(k); out.push({ base_asset: base, quote_asset: quote }); } };
  for (const r of PLACED){ add(r.pay, r.receive); }
  for (const m of EXTRA_COV_MARKETS){ add(m.base_asset, m.quote_asset); }
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
    C.toast && C.toast('Order matched · settling the fill on-chain…');
    const { txid } = await covSettleFill(m, fillHooksFor(m));
    C.toast && C.toast('Fill settled · anchor-bound to Bitcoin.',
      txid ? { href:'/explorer/tx/'+txid, label:String(txid).slice(0,18)+'…' } : undefined);
    await C.sync(); await scanCompanion(); try { renderSwap(); } catch {}
    // SBTC silent peg (taker side): if this fill paid us SBTC on a BTC-advertised market, we were
    // buying real BTC — peg the received SBTC back OUT. Best-effort: on failure we simply hold
    // redeemable SBTC (fund-safe). The amount received is the covenant fill's base (asset_a) amount.
    if (isPeggedFillToRedeem(m)){
      const got = BigInt(m.fill_base_amount || m.fillBaseAmount || m.covenant_locked || m.covenantLocked || 0);
      try { await pegOutReceivedSbtc(got); await C.sync(); try { renderSwap(); } catch {} }
      catch (e){ try { C.toast && C.toast('Received SBTC (redeemable to BTC); auto-redeem will retry.'); } catch {} }
    }
  } catch (e){ try { C.toast && C.toast('Fill could not settle: ' + C.prettyErr(e)); } catch {} }
}
async function onCovOrderStatus(s){
  // A resting order of ours moved (likely filled by a taker/settler): record the remaining size so
  // renderMyOrders can show per-order fill progress (D2/T13), rescan the companion wollet (which holds
  // the credit) + the primary, and refresh the UI.
  try {
    const id = s.offer_id || s.offerId;
    if (id) _ordStatus[id] = { active: big(s.active_amount || s.activeAmount || 0), status: s.status || '' };
  } catch {}
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
  reconcileUnfundedPlaced().catch(()=>{});   // recover any record that died mid-broadcast
  if (PLACED.length){ ensureCovenantRelay(); }
}

// A record persisted BEFORE the funding broadcast (covTxid null) whose tab died in
// the resolve window: locate the covenant outpoint by its spkHex on-chain and fill in
// txid/vout so the reclaim path is whole. If nothing is found after a grace period past
// creation, the broadcast almost certainly never landed (nothing was spent) — drop it so
// it doesn't linger as a fake resting order. Esplora indexes by scripthash = sha256(spk)
// reversed; /scripthash/:h/utxo returns the funded outpoints.
async function reconcileUnfundedPlaced(){
  let changed = false;
  for (const rec of PLACED){
    if (rec.covTxid || !rec.spkHex) continue;
    try {
      const sh = await scripthashOf(rec.spkHex);
      const res = await esplora(`/scripthash/${sh}/utxo`);
      const utxos = (res && res.ok) ? await res.json() : [];
      if (Array.isArray(utxos) && utxos.length){
        // The covenant output is the one paying exactly this spk; take the first.
        rec.covTxid = utxos[0].txid; rec.covVout = utxos[0].vout; changed = true;
      } else if (Date.now() - (rec.created||0) > 10 * 60 * 1000){
        rec._orphan = true; changed = true;   // 10 min, no on-chain output -> the funding tx never landed
      }
    } catch { /* transient esplora error; retry on the next resume */ }
  }
  if (changed){
    const before = PLACED.length;
    for (let i = PLACED.length - 1; i >= 0; i--) if (PLACED[i]._orphan) PLACED.splice(i, 1);
    savePlaced();
    if (PLACED.length !== before) { try { C.toast && C.toast('Cleared an order whose funding never confirmed (nothing was spent).'); } catch {} }
  }
}

// scripthash = SHA-256 of the raw scriptPubKey bytes, BYTE-REVERSED (Esplora/Electrum convention).
async function scripthashOf(spkHex){
  const bytes = new Uint8Array((spkHex.match(/../g) || []).map(h => parseInt(h, 16)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  digest.reverse();
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function placeCovenantReview(q){
  const { $ } = C;
  const pay = q.pay, receive = q.receive, payAtoms = q.payAtoms, recvAtoms = q.recvAtoms;
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const isMarket = S.mode !== 'post';
  const feeAsset = S.feeAsset || defaultFeeAsset();
  const feeAtoms = covFeeAtoms(feeAsset);
  const kv = [
    ['You pay', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You receive', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? `${isMarket ? 'Market · ' : 'Limit · '}${ratePerPayToLine(pay, receive, recvU/payU).str}` : '-'],
    ['Network fee', amtRow(feeAsset, feeAtoms) + refSuffix(feeAsset, feeAtoms) + '  (estimate)'],
    ['Fee paid in', C.assetMeta(feeAsset).ticker],
    ['How it fills', isMarket
      ? `Fills against the order book now at your price or better. If your order is larger than what's resting, the filled part settles on-chain and the unfilled remainder keeps resting at the same price until it's crossed · even while this wallet is closed. Consensus rejects any underpay or redirect.`
      : `Rests on-chain at your price and fills · fully or partially · whenever someone crosses it, even while this wallet is closed. A partial fill settles that part and leaves the rest resting. Consensus rejects any underpay or redirect.`],
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
      C.toast('Order placed · resting on-chain; it fills when matched, even offline.',
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
  // FUND-SAFETY (see reviewCross): the submarine (MIXED), the sub-asset BUY (BUY) and the sub-asset
  // SELL (SELL) each persist their on-chain HTLC leg under a SINGLE localStorage key, recoverable only
  // via Refund — so starting a second of the SAME kind overwrites and strands it. The per-kind guard is
  // below, once we know which shape this is (the earlier mixed-only guard missed buy + sell).
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
  // Per-kind in-flight guard (fund-safety): refuse a second swap of the SAME kind (its single-key
  // recovery handle would be overwritten). startMixed/startBuy/startSell also self-guard below.
  if ((isSubmarine && hasMixedInFlight()) || (isSubAsset && hasBuyInFlight()) || (isSubAssetSell && hasSellInFlight())){
    $('swErr').textContent = 'You already have a swap of this kind in progress. Finish or refund it first (open it under Active trades) before starting another.';
    return;
  }
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
      const atoms = fieldAtoms(C.$('swPayAmt'), S.payAsset);
      if (atoms <= 0n){ $('swErr').textContent = 'Enter an amount so the Lightning channel can be sized.'; return; }
      try {
        $('swErr').textContent = '';
        await L.provisionChannel({ chain, asset: chain === 'seq' ? S.payAsset : undefined, ticker: pm.ticker,
          amount: Number(atoms), onProgress: (t) => { $('swStatus').className = 'status'; $('swStatus').innerHTML = '<span class="spin"></span>' + t; } });
        LNSTATUS = await L.status();
        $('swStatus').textContent = '';
      } catch (e){
        $('swStatus').textContent = '';
        $('swErr').textContent = 'Could not open your Lightning channel: ' + C.prettyErr(e);
        return;
      }
      if (!railAvail(S.payAsset, S.receiveAsset).payLn.ok){
        $('swErr').textContent = 'Your Lightning channel opened but is not ready to trade yet · please try again in a moment.';
        return;
      }
    }
  }
  const amount = fieldUnits($('swPayAmt'), S.payAsset) || null;
  const dir = isSubAsset
    ? `Buy ${am.ticker} with Bitcoin on-chain · receive ${am.ticker} over Lightning`
    : isSubAssetSell
    ? `Sell ${am.ticker} over Lightning · receive Bitcoin on-chain`
    : (side === 'buy'
      ? `Buy ${am.ticker} with Bitcoin over Lightning · receive ${am.ticker} on-chain`
      : `Sell ${am.ticker} on-chain · receive Bitcoin over Lightning`);
  const kv = isSubAssetSell ? [
    ['Route', 'Mixed rails · you pay ' + am.ticker + ' over Lightning and receive Bitcoin into an on-chain lock your device claims. Both legs share one secret, so they settle together or not at all.'],
    ['Direction', dir],
    ['Pricing', 'Best resting offer · you take a party who locks BTC on-chain for your ' + am.ticker + ' (a maker or any posted offer)'],
    ['Timing', 'You pay ' + am.ticker + ' over Lightning; the counterparty reveals the shared secret to settle, and your device uses it to claim the BTC on-chain.'],
    ['Finality', 'The BTC arrives in an on-chain Bitcoin lock your device claims (final to Bitcoin); the ' + am.ticker + ' leg is over Lightning.'],
    ['If it stalls', 'Nothing is lost · if the counterparty never settles, your Lightning payment auto-returns.'],
  ] : isSubAsset ? [
    ['Route', 'Mixed rails · you pay Bitcoin into an on-chain lock and receive the asset over Lightning. Both legs share one secret, so they settle together or not at all.'],
    ['Direction', dir],
    ['Pricing', 'Best resting sub-asset offer · whole-swap lift (the LP\'s fixed terms)'],
    ['Timing', 'The asset arrives over Lightning the moment the maker is paid; your BTC is released from its on-chain lock by the same shared secret.'],
    ['Finality', 'The BTC leg is an on-chain Bitcoin lock (final to Bitcoin); the asset leg settles over Lightning.'],
    ['If it stalls', 'Nothing is lost · you reclaim the BTC from its lock after the on-chain timeout if the asset never arrives.'],
  ] : [
    ['Route', 'Mixed rails · one leg on Lightning, one anchored on-chain (a submarine swap, with both legs sharing one secret)'],
    ['Direction', dir],
    ['Pricing', 'Best resting submarine offer · whole-swap lift (the LP\'s fixed terms)'],
    ['Timing', 'Anchor-gated: the on-chain leg must bury under Bitcoin before the Lightning leg settles. A few minutes, not instant.'],
    ['Finality', 'Anchored to Bitcoin (reverts only if Bitcoin reverts), so not the instant finality of the pure-Lightning rail.'],
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
// A fresh 32-byte random hex idempotency key for a sub-asset sell (same CSPRNG the maker key uses).
// The wallet persists it in the 'paying' record BEFORE the asset-paying /swap, and re-sends the SAME
// value on recovery so the LSP returns the already-settled result rather than re-paying the asset.
function newSwapNonce(){ const a = new Uint8Array(32); (crypto || window.crypto).getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2,'0')).join(''); }
// After this long, a still-'paying' record can't complete (any unsettled Lightning payment has
// auto-returned past its own timeout), so resumeSell clears it rather than re-attempting forever.
const SELL_PAYING_TTL_MS = 24 * 60 * 60 * 1000;
// Synchronous in-flight sentinel. SELL.state only becomes 'claiming' AFTER the LN-pay prologue
// (assetNodeKey / connectNode / L.swap), so hasSellInFlight is blind during it. With the progress
// modal now dismissable, a user could start a SECOND sell in that window and overwrite SELL (the
// single-key handle to the BTC claim). Set true synchronously at the top of startSell, cleared in
// its finally, so the guard covers the whole pre-claim prologue too.
let _sellStarting = false;
function saveSell(){ try { localStorage.setItem(SELL_KEY, JSON.stringify(SELL)); } catch {} }
function clearSell(){ SELL = null; try { localStorage.removeItem(SELL_KEY); } catch {} }
// True while a sell is starting or is persisted with the preimage but its BTC claim is not yet
// confirmed — the claim is the FUND step, so it must survive a reload (resumeSell re-attempts it).
// 'paying' is ALSO in-flight: the asset may already be paid but its response was lost, so the record
// is the ONLY recovery handle (its nonce) — a second sell must never overwrite it (fund-safety).
export function hasSellInFlight(){ return !!(_sellStarting || (SELL && (SELL.state === 'claiming' || SELL.state === 'paying'))); }

async function startSell(params){
  const { $ } = C;
  const asset = params.asset, am = C.assetMeta(asset);
  // FUND-SAFETY self-guard: a second sell would overwrite SELL (the single-key handle to the BTC claim).
  if (hasSellInFlight()){ if (C.toast) C.toast('You already have a sub-asset sell in progress (claiming your BTC) · finish or refund it first under Active trades.'); return; }
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Selling ' + am.ticker + ' over Lightning'));
  const st = C.el('div','status'); card.appendChild(st);
  const act = C.el('div','row'); act.style.marginTop = '12px';
  // The sell is persisted + resumable (resumeSell re-attempts on reload), so this modal is a
  // progress view, not a lock: closing it never cancels the swap, and a second sell stays blocked
  // by hasSellInFlight. Dismissable from the start via the button and a backdrop click; the label
  // firms to "Close" once it settles (W5).
  const closeBtn = C.el('button','ghost','Run in background'); closeBtn.onclick = () => modal.remove();
  act.appendChild(closeBtn); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  const say = (t, cls) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = (cls ? '' : '<span class="spin"></span>') + esc(t); };
  const done = () => { closeBtn.textContent = 'Close'; };
  // Set true the instant BEFORE the asset-paying L.swap. In the catch it separates a LOST RESPONSE
  // (network error after we may have paid -> keep the 'paying' record for recovery) from a pre-pay or
  // definitive-rejection error (asset NOT paid -> discard it so it neither blocks nor re-runs).
  let paidCallStarted = false;
  try {
    _sellStarting = true;   // block a concurrent second sell through the whole pre-claim prologue (TOCTOU)
    if (!(L && L.swap && L.assetNodeKey)) throw new Error('The Lightning service is unavailable in this build.');
    if (!(C.btcLeg && C.btcLeg.claim && C.btcLeg.claimKey && C.btcLeg.verifyClaimable)) throw new Error('The BTC claim service is unavailable in this build.');
    say('Preparing your sell…');
    const btc_claim_pub = C.btcLeg.claimKey().public_key;   // the device claim key; only we can claim
    const node_key = await L.assetNodeKey(asset);           // our own hosted asset node pays over LN
    const offer = params.offer || null;
    // FUND-SAFETY: this rail pays the asset over Lightning and can only compare the maker's returned BTC
    // HTLC against the quote AFTER that (irrevocable) payment. Never pay without a resting offer's
    // btc_sats to compare against — otherwise expected_btc falls back to 0, the shortfall gate in
    // claimSell is skipped entirely, and a maker handing back a dust HTLC goes completely unwarned. This
    // makes the economic gate reliable; verifying the BTC HTLC BEFORE paying needs a 2-phase LSP
    // handshake (the atomic flow reveals the preimage only after the pay), tracked as an LSP change.
    const expectedBtc = Number((offer && offer.btc_sats) || 0);
    if (!(expectedBtc > 0)) throw new Error('This sell has no resting Bitcoin offer to price against · refresh the order book and pick an offer, so the Bitcoin you will receive is known before you pay the asset.');
    // Bring our asset LN node's device signer ONLINE — a per-user node isn't auto-connected on
    // load, and the LSP needs it serving to command the pay. Idempotent (re-attaches, no re-fund).
    if (L.connectNode){
      say('Bringing your ' + am.ticker + ' Lightning node online…');
      const prov = await L.connectNode(asset);
      if (!(prov && prov.connected)) throw new Error('Could not bring your ' + am.ticker + ' Lightning node online · reopen the wallet and try again.');
    }
    // FUND-SAFETY: the asset is paid INSIDE L.swap. Persist a PENDING ('paying') record carrying a
    // fresh swap_nonce + everything needed to RE-CALL /swap, BEFORE that call. If the response is lost
    // after the LSP already paid the asset, resumeSell() re-calls with this SAME nonce and the LSP
    // returns the settled {preimage, btc_htlc} idempotently (it never re-pays for a stored nonce).
    const swap_nonce = newSwapNonce();
    SELL = { state: 'paying', swap_nonce, asset, ticker: am.ticker, amount: params.amount ?? null,
      node_key, btc_claim_pub, offer, ts: Date.now() }; saveSell();
    // Pay the asset over Lightning (LSP drives the hold-invoice pay from our node; device co-signs).
    // On settle the maker reveals the preimage, returned here WITH the BTC HTLC terms — the LSP
    // never claims (no claim key) and we claim on-chain ourselves.
    say('Paying ' + am.ticker + ' over Lightning…');
    paidCallStarted = true;   // from here a lost response means the asset MAY be paid -> keep for recovery
    const resp = await L.swap({ side: 'sell', asset, node_key, btc_claim_pub, amount: params.amount,
      // State the rails EXPLICITLY (asset over Lightning, BTC on-chain) so the LSP routes this to
      // the sub-asset sell (xsubas-sell) rather than defaulting omitted rails to pure-LN (xpln).
      payRail: 'ln', recvRail: 'chain',
      offer_id: offer && offer.offer_id, maker_pubkey: offer && offer.maker_pubkey,
      swap_nonce });
    if (!(resp && resp.settled && resp.preimage && resp.btc_htlc)) throw new Error(resp && resp.error ? resp.error : 'The sell did not settle over Lightning.');
    const H = resp.btc_htlc;
    // Persist BEFORE the on-chain claim: the asset is now paid, so the BTC claim is the fund step
    // and MUST survive a reload — resumeSell() re-attempts it from here.
    SELL = { state: 'claiming', asset, ticker: am.ticker, preimage: resp.preimage, hash_h: resp.hash_h, btc_htlc: H,
      expected_btc: expectedBtc, swap_nonce, ts: mixedTip() }; saveSell();
    say('Preimage revealed · verifying and claiming your BTC on-chain…');
    await claimSell();   // verify + claim; updates SELL + st
    say('Done. You paid ' + am.ticker + ' over Lightning and claimed BTC on-chain (' + String(SELL.claim_txid || '').slice(0,16) + '…).', 'ok');
    done();
    try { await C.sync(); } catch {}
    clearSell();
  } catch (e){
    // Was the asset possibly paid? Only if we reached L.swap AND the failure was a LOST RESPONSE — a
    // network/fetch error (surfaced as a TypeError; the LSP may already have settled). A DEFINITIVE
    // rejection (a completed round-trip returning ok:false, thrown as a plain Error by lspFetch) means
    // the sub-asset sell never settled, so NO asset was paid. Keep the 'paying' record only in the
    // lost-response case (resumeSell recovers via its nonce); else discard it so it neither blocks a
    // future sell nor triggers a surprise re-run.
    const msg = String((e && e.message) || '');
    const lostResponse = paidCallStarted && ((e instanceof TypeError) || (e && e.name === 'AbortError')
      || /failed to fetch|networkerror|network error|network request failed|load failed|fetch failed|connection|timed? ?out|timeout/i.test(msg));
    if (SELL && SELL.state === 'paying' && !lostResponse) clearSell();   // definitive failure / pre-pay error: nothing was paid
    const recoverable = !!(SELL && (SELL.state === 'claiming' || SELL.state === 'paying'));
    say('Failed: ' + C.prettyErr(e) + (recoverable ? ' · your funds are safe; reopen the wallet to complete this sell.' : ''), 'err');
    done();
  } finally {
    _sellStarting = false;   // hand off to the SELL.state guard (or clear if the prologue never funded)
  }
}
// Verify the maker's BTC HTLC binds our claim key + H, then claim it on-chain with the preimage.
// Idempotent-ish: a duplicate claim of an already-spent HTLC just errors, which we surface.
async function claimSell(){
  const H = SELL.btc_htlc;
  // ECONOMIC gate: the maker's returned BTC HTLC must be worth at least what we were QUOTED (offer.btc_sats).
  // verifyClaimable only checks the HTLC's on-chain value equals what the LSP reported — NOT that it meets
  // the quote — so a shortchanging/buggy counterparty could hand back a dust HTLC after we already paid the
  // asset over LN. We STILL claim (recovering the dust beats letting the maker refund it), but surface the
  // shortfall loudly instead of reporting a clean success. (Proper prevention needs verifying the BTC HTLC
  // BEFORE paying the asset — an LSP/flow change tracked separately.)
  try {
    const got = BigInt(String(H.amount || 0)), want = BigInt(String(SELL.expected_btc || 0));
    if (want > 0n && got < want) {
      SELL.shortfall = { got: String(got), want: String(want) }; saveSell();
      C.toast && C.toast(`Warning: the BTC HTLC is only ${C.fmtAtoms(got, 8)} BTC, less than the quoted ${C.fmtAtoms(want, 8)} BTC · claiming it anyway.`, { level: 'warn' });
    }
  } catch {}
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
  if (!SELL) return;
  // (A) Asset paid + response received: SELL holds the preimage + HTLC -> re-attempt the on-chain
  //     claim (the FUND step). The original recovery path, unchanged.
  if (SELL.state === 'claiming' && SELL.preimage && SELL.btc_htlc){
    try {
      await claimSell();
      try { C.toast && C.toast('Recovered your sell · BTC claimed on-chain (' + String(SELL.claim_txid||'').slice(0,16) + '…).'); } catch {}
      try { await C.sync(); } catch {}
      clearSell();
    } catch (e){
      // The claim failed. Record WHY (so the Active-trades row can SHOW it instead of a silent
      // 'claiming' spinner), and decide whether it's terminal: if the HTLC outpoint is already SPENT
      // on-chain (the maker reclaimed it after its CLTV — the classic "wallet stayed closed too long"
      // case), the claim can NEVER succeed, so mark it terminal so it STOPS wedging every future sell.
      // Otherwise keep 'claiming' for a Retry (transient, or the timelock not yet mature).
      SELL.error = C.prettyErr(e); saveSell();
      try {
        const H = SELL.btc_htlc;
        if (H && H.txid != null && H.vout != null && C.btcLeg && C.btcLeg.outspend){
          const os = await C.btcLeg.outspend(H.txid, H.vout);
          if (os.known && os.spent){
            SELL.state = 'failed';
            SELL.error = 'The Bitcoin HTLC was already resolved on-chain — either your claim confirmed, or the maker reclaimed it after the timeout. Your balance is up to date; you can clear this.';
            saveSell();
            try { await C.sync(); } catch {}
          }
        }
      } catch { /* spend-check best-effort; leave as retryable */ }
      try { renderInFlightCard(); } catch {}   // surface the error + a Retry/Clear off-ramp
    }
    return;
  }
  // (B) Asset MAY have been paid but the /swap response was LOST (a network blip after the LSP
  //     settled): SELL is at 'paying' with a nonce but no preimage. RE-CALL /swap with the SAME
  //     nonce — the LSP returns the already-settled {preimage, btc_htlc} idempotently (it never
  //     re-pays for a stored nonce), then we claim as usual. This closes the fund-loss window.
  if (SELL.state === 'paying' && SELL.swap_nonce && !SELL.preimage){
    // FUND-SAFETY: NEVER clear on the TTL before an idempotent recovery re-call. The old code
    // cleared any old 'paying' record assuming "unsettled -> auto-returned" — but a payment that
    // DID settle and only lost its response left the asset spent and the BTC owed; clearing it
    // abandoned that BTC. So re-call FIRST; only clear once the LSP confirms the payment did not
    // settle. If the service is unavailable, keep the record (retry next load) regardless of age.
    if (!(L && L.swap && L.assetNodeKey)) return;                                             // service unavailable in this build; retry next load
    if (!(C.btcLeg && C.btcLeg.claim && C.btcLeg.claimKey && C.btcLeg.verifyClaimable)) return;
    try {
      const asset = SELL.asset, offer = SELL.offer || null;
      const btc_claim_pub = C.btcLeg.claimKey().public_key;     // re-derived the SAME way startSell does
      const node_key = await L.assetNodeKey(asset);
      if (L.connectNode){ const prov = await L.connectNode(asset); if (!(prov && prov.connected)) return; }
      const resp = await L.swap({ side: 'sell', asset, node_key, btc_claim_pub, amount: SELL.amount,
        payRail: 'ln', recvRail: 'chain',
        offer_id: offer && offer.offer_id, maker_pubkey: offer && offer.maker_pubkey,
        swap_nonce: SELL.swap_nonce });
      if (!(resp && resp.settled && resp.preimage && resp.btc_htlc)){
        // Confirmed NOT settled. Only now is a TTL clear safe: past the Lightning leg's own timeout
        // an unsettled asset payment has auto-returned, so this record can never complete. Within the
        // TTL, keep it for a later retry.
        if (SELL.ts && (Date.now() - SELL.ts) > SELL_PAYING_TTL_MS){ clearSell(); try { C.toast && C.toast('A sub-asset sell that never completed has expired; any Lightning payment has auto-returned.'); } catch {} }
        return;
      }
      SELL = { state: 'claiming', asset, ticker: SELL.ticker || ((C.assetMeta(asset)||{}).ticker || ''),
        preimage: resp.preimage, hash_h: resp.hash_h, btc_htlc: resp.btc_htlc,
        expected_btc: Number((offer && offer.btc_sats) || SELL.expected_btc || 0),
        swap_nonce: SELL.swap_nonce, ts: mixedTip() }; saveSell();
      await claimSell();
      try { C.toast && C.toast('Recovered your sell · BTC claimed on-chain (' + String(SELL.claim_txid||'').slice(0,16) + '…).'); } catch {}
      try { await C.sync(); } catch {}
      clearSell();
    } catch (e){ /* leave the 'paying' record; its nonce keeps recovery idempotent on the next load */ }
    return;
  }
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
// Synchronous in-flight sentinel (mirror of _sellStarting). BUY.state only becomes 'funded' AFTER the
// pre-fund prologue, so without this a dismissed modal lets a second buy fund a SECOND BTC HTLC and
// overwrite BUY (the single-key handle to the locked BTC). Set at the top of startBuy, cleared in its
// finally, so the guard covers the whole pre-fund prologue too.
let _buyStarting = false;
function saveBuy(){ try { localStorage.setItem(BUY_KEY, JSON.stringify(BUY)); } catch {} }
function clearBuy(){ BUY = null; try { localStorage.removeItem(BUY_KEY); } catch {} }
// True while a buy is starting or has FUNDED its BTC HTLC but is not yet settled/refunded — the BTC is
// locked, so the record must survive a reload (resumeBuy settles on hold, or refunds after T_btc).
export function hasBuyInFlight(){ return !!(_buyStarting || (BUY && (BUY.state === 'funding' || BUY.state === 'funded' || BUY.state === 'holding'))); }
// T_btc safety delta over the current BTC tip (parent-chain blocks), matching the maker's
// BtcLocktimeDelta so the refund branch matures well after the swap should have settled.
const BUY_CLTV_DELTA = 100;

async function startBuy(params){
  const { $ } = C;
  const asset = params.asset, am = C.assetMeta(asset);
  const offer = params.offer || null;
  // FUND-SAFETY self-guard: a second buy would overwrite BUY (the single-key handle to the locked BTC).
  if (hasBuyInFlight()){ if (C.toast) C.toast('You already have a sub-asset buy in progress (Bitcoin locked) · finish or refund it first under Active trades.'); return; }
  const modal = C.el('div','modal'); const card = C.el('div','card');
  card.appendChild(C.el('label','lbl','Buying ' + am.ticker + ' over Lightning'));
  const st = C.el('div','status'); card.appendChild(st);
  const act = C.el('div','row'); act.style.marginTop = '12px';
  // Persisted + resumable (resumeBuy settles on hold / refunds the BTC after its timeout on reload),
  // so this modal is a progress view, not a lock: closing it never cancels the buy, and a second buy
  // stays blocked by hasBuyInFlight. Dismissable from the start; label firms to "Close" on settle (W5).
  const closeBtn = C.el('button','ghost','Run in background'); closeBtn.onclick = () => modal.remove();
  act.appendChild(closeBtn); card.appendChild(act);
  modal.appendChild(card); document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  const say = (t, cls) => { st.className = 'status' + (cls ? ' ' + cls : ''); st.innerHTML = (cls ? '' : '<span class="spin"></span>') + esc(t); };
  const done = () => { closeBtn.textContent = 'Close'; };
  try {
    _buyStarting = true;   // block a concurrent second buy through the whole pre-fund prologue (TOCTOU)
    if (!(L && L.swap && L.assetNodeKey && L.nodeInvoice && L.invoiceStatus && L.nodeSettle)) throw new Error('The Lightning service is unavailable in this build.');
    if (!(C.btcLeg && C.btcLeg.fund && C.btcLeg.refund && C.btcLeg.refundKey && C.btcLeg.tipHeight)) throw new Error('The BTC HTLC service is unavailable in this build.');
    if (!(C.wasm && C.wasm.generateSwapSecret && C.wasm.buildSeqHtlcRedeemScript)) throw new Error('The HTLC builder is unavailable in this build.');
    const makerClaimPub = offer && (offer.maker_claim_pub || offer.maker_claim_pubkey);
    if (!offer || !makerClaimPub) throw new Error('No resting ' + am.ticker + ' buy offer right now · try again shortly.');
    say('Preparing your buy…');
    // 1. DEVICE generates the secret. Only we ever hold P until WE settle.
    const sec = C.wasm.generateSwapSecret();            // { secret_hex, hash_hex }
    const H = sec.hash_hex, P = sec.secret_hex;
    const node_key = await L.assetNodeKey(asset);       // our OWN hosted asset node RECEIVES the asset over LN
    // T8 partial fill: default to the whole offer, but if the user entered LESS BTC than the offer's
    // full price, take a proportional slice — assetAtoms scaled by the BTC fraction, then btcSats
    // recomputed as the ceil-proportional price (matching the maker's ProportionalBtc, so it never
    // rejects us). The maker re-rests the remainder. params.amount is the pay (BTC) field, in BTC.
    const wholeAsset = Number(offer.asset_amount), wholeBtc = Number(offer.btc_sats);
    let assetAtoms = wholeAsset, btcSats = wholeBtc;
    const reqBtcSats = (params.amount != null && Number(params.amount) > 0) ? Math.round(Number(params.amount) * 1e8) : 0;
    if (reqBtcSats > 0 && reqBtcSats < wholeBtc){
      // BigInt, NOT float: the price must EXACTLY equal the maker's integer ProportionalBtc(ceil). A
      // float multiply overflows 2^53 for large offers and diverged by +1 in ~0.6% of cases, so the
      // maker would reject AFTER the BTC HTLC is funded → stranded until the CLTV refund. assetAtoms =
      // floor slice of the entered BTC; btcSats = ceil(wholeBtc*assetAtoms/wholeAsset) = the maker's need.
      const bW = BigInt(wholeAsset), bB = BigInt(wholeBtc);
      let a = (bW * BigInt(reqBtcSats)) / bB;   // floor
      if (a < 1n) a = 1n;
      assetAtoms = Number(a);
      btcSats = Number(ceilDiv(bB * a, bW));
    }
    // Bring our asset LN node's device signer ONLINE so it can register + settle the HODL invoice.
    if (L.connectNode){
      say('Bringing your ' + am.ticker + ' Lightning node online…');
      const prov = await L.connectNode(asset);
      if (!(prov && prov.connected)) throw new Error('Could not bring your ' + am.ticker + ' Lightning node online · reopen the wallet and try again.');
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
    // PERSIST-BEFORE-BROADCAST (fund-safety): the funding tx below locks BTC and then BLOCKS for a
    // confirmation (minutes). H is random (NOT HD-derivable) and the redeem script embeds it, so losing
    // it before the txid is captured strands the BTC with no refund. Persist the recovery material as
    // 'funding' NOW, capture the txid via onBroadcast (BEFORE the confirmation wait), and advance to
    // 'funded' only once the outpoint is known. resumeBuy recovers a 'funding' record by its txid.
    BUY = { state: 'funding', asset, ticker: am.ticker, preimage: P, hash_h: H, node_key,
      btc_htlc: { redeem_script: redeem, cltv: T_btc, amount: btcSats, maker_claim_pub: makerClaimPub, taker_refund_pub: refund.public_key },
      t_btc: T_btc, asset_amount: assetAtoms, offer_id: offer.offer_id, maker_pubkey: offer.maker_pubkey, ts: mixedTip() };
    saveBuy();
    say('Locking your Bitcoin in the on-chain HTLC…');
    const funded = await C.btcLeg.fund(redeem, btcSats, (txid) => { if (BUY && BUY.btc_htlc){ BUY.btc_htlc.txid = String(txid); saveBuy(); } });
    BUY.btc_htlc.txid = String(funded.txid); BUY.btc_htlc.vout = funded.vout; BUY.state = 'funded'; saveBuy();
    const btc_htlc = BUY.btc_htlc;   // { txid, vout, amount, redeem_script, cltv, ... } for the /swap call
    logTrade({ id: 'buy:' + H, title: 'Buying ' + am.ticker + ' with BTC', status: 'BTC locked' });
    // 4. Command the LSP to drive the maker's pay-by-hash (ASYNC job -> 202 { job_id, poll, held:false }).
    say('Asking the maker to pay you ' + am.ticker + ' over Lightning…');
    const job = await L.swap({ side: 'buy', hodl: true, asset, node_key, payment_hash: H, asset_amount: assetAtoms,
      payRail: 'chain', recvRail: 'ln', btc_htlc, offer_id: offer.offer_id, maker_pubkey: offer.maker_pubkey });
    BUY.job_id = job && (job.job_id || job.jobId); BUY.poll = job && job.poll; saveBuy();
    // 5. Wait for the maker's asset payment to arrive HELD, then DEVICE-SETTLE with P (or refund after T_btc).
    say('Waiting for the maker’s ' + am.ticker + ' payment to arrive…');
    await driveBuy(say);
    if (BUY && BUY.state === 'settled'){ say('Done. Your BTC bought ' + am.ticker + ' · received over Lightning.', 'ok'); done(); try { await C.sync(); } catch {} clearBuy(); }
    else if (BUY && BUY.state === 'refunded'){ say('The maker didn’t pay in time · your Bitcoin was refunded on-chain (' + String(BUY.refund_txid||'').slice(0,16) + '…).', 'ok'); done(); try { await C.sync(); } catch {} clearBuy(); }
    else { done(); }
  } catch (e){
    // If the BTC HTLC was already funded (BUY persisted), keep it for settle/refund on reload — never lose it.
    say('Failed: ' + C.prettyErr(e) + (BUY && (BUY.state === 'funded' || BUY.state === 'holding') ? ' · your Bitcoin is still locked; reopen the wallet to finish or refund it.' : ''), 'err');
    done();
  } finally {
    _buyStarting = false;   // hand off to the BUY.state guard (or clear if the prologue never funded)
  }
}
// Poll the HODL invoice on our node until the maker's asset payment is HELD, then device-settle with
// P (releases the asset to us AND reveals P so the maker claims the BTC), then best-effort confirm the
// LSP job settled. Bounded by T_btc: if the asset never holds before the BTC HTLC times out, refund
// the BTC (the ONLY loss-avoiding path). Shared by startBuy and resumeBuy. Mutates + persists BUY.
async function driveBuy(say){
  say = say || (() => {});
  const H = BUY.hash_h, node_key = BUY.node_key;
  // Reconcile a dropped/interrupted LSP job. The LSP now PERSISTS jobs, so a restart no longer 404s
  // ours — it reloads the job and, because the in-process driver died with the old process, marks it
  // 'interrupted'. Either signal (404/gone, 'failed', or 'interrupted') means the maker's pay-by-hash
  // is no longer being driven, so drop the stale id and let the re-issue below re-command the maker.
  // Safe to repeat: the on-chain HTLC is already funded and the hosted node's hold invoice on H can
  // only be paid once, so a duplicate command is idempotent. (Skipped on a fresh startBuy, whose
  // job_id points at a live job.)
  if (BUY.job_id && L.jobStatus){
    const alive = await L.jobStatus(BUY.poll || ('/swap/' + BUY.job_id))
      .then(j => !!(j && j.ok !== false && j.status !== 'failed' && j.status !== 'interrupted' && !j.interrupted), () => false);
    if (!alive){ BUY.job_id = null; BUY.poll = null; saveBuy(); }
  }
  // Resume-after-crash-before-swap (or after the reconcile above): funded the BTC but no live LSP job.
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
      say('Payment received · releasing your ' + BUY.ticker + ' and revealing the preimage…');
      await L.nodeSettle({ node_key, payment_hash: H, preimage: BUY.preimage });   // 5. device-settle
      BUY.state = 'settled'; saveBuy();
      logTrade({ id: 'buy:' + H, title: 'Bought ' + BUY.ticker + ' with BTC', status: 'asset received' });
      // 6. best-effort: confirm the maker claimed the BTC (job settled). Non-fatal.
      if (L.jobStatus && (BUY.poll || BUY.job_id)){ try { const j = await L.jobStatus(BUY.poll || ('/swap/' + BUY.job_id)); if (j && j.status) { BUY.detail = j.status; saveBuy(); } } catch {} }
      return;
    }
    if (tip && BUY.t_btc && tip >= BUY.t_btc){ say('The maker didn’t pay in time · refunding your Bitcoin on-chain…'); await refundBuy(); return; }   // 7. refund branch
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
  if (!BUY || !BUY.preimage || !BUY.btc_htlc) return;
  // A 'funding' record died between persist-before-broadcast and confirmation. If onBroadcast captured
  // the txid, the BTC is locked -> recover the outpoint and advance to 'funded'. If no txid was ever
  // captured, the funding never broadcast (nothing locked) -> drop the stub.
  if (BUY.state === 'funding'){
    if (!BUY.btc_htlc.txid){ clearBuy(); return; }
    if (BUY.btc_htlc.vout == null){
      try {
        const f = await C.btcLeg.findFunding(BUY.btc_htlc.txid, BUY.btc_htlc.redeem_script);
        if (f && f.vout != null){ BUY.btc_htlc.vout = f.vout; BUY.state = 'funded'; saveBuy(); }
        else return;   // not indexed yet; retry next load — the BTC stays refundable at T_btc
      } catch { return; }
    } else { BUY.state = 'funded'; saveBuy(); }
  }
  if (!(BUY.state === 'funded' || BUY.state === 'holding')) return;
  try {
    await driveBuy();
    if (BUY.state === 'settled'){ try { C.toast && C.toast('Recovered your buy · ' + BUY.ticker + ' received over Lightning.'); } catch {} try { await C.sync(); } catch {} clearBuy(); }
    else if (BUY.state === 'refunded'){ try { C.toast && C.toast('Your buy timed out · Bitcoin refunded on-chain (' + String(BUY.refund_txid||'').slice(0,16) + '…).'); } catch {} try { await C.sync(); } catch {} clearBuy(); }
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
let _mixedStarting = false;
async function startMixed(params){
  // Synchronous double-start guard: two confirmed reviews (double-tap / a second Review before the
  // first awaits) would each overwrite MIXED — the single-key handle to a funded submarine HTLC leg —
  // stranding the first. hasMixedInFlight covers a persisted swap; _mixedStarting covers the window
  // before the first newSwap persists.
  if (_mixedStarting || hasMixedInFlight()){ try { C.toast && C.toast('A submarine swap is already in progress · finish or refund it first under Active trades.'); } catch {} return; }
  _mixedStarting = true;
  try {
    MIXED = sub.newSwap(params);
    // Idempotency key (fund-safety): the LSP dedupes a same-nonce re-POST to ONE submarine HTLC, so a
    // lost /swap response + a retry (or a restart-then-resume) never funds a second on-chain leg. Persist
    // it in the record and re-send the SAME value on any resume.
    MIXED.swap_nonce = MIXED.swap_nonce || newSwapNonce();
    saveMixed();
    showMixed(true); renderMixedSwap();
    const r = await L.swap({ side: params.side, asset: params.asset, amount: params.amount,
      payRail: params.payRail, recvRail: params.recvRail, swap_nonce: MIXED.swap_nonce });
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
  } finally {
    _mixedStarting = false;
  }
}

// Poll the LSP for the swap's progress until terminal (best-effort: needs L.swapStatus).
let _mixedPoll = null;
function pollMixed(){
  // Poll the LSP JOB handle (poll path / job_id captured from the 202), NOT MIXED.id (a LOCAL id from
  // newSwap that the LSP never knew). Without a handle there is no async job to poll — a sub-0-conf
  // submarine already answered synchronously and is terminal, so there is nothing to do.
  const pollRef = MIXED && (MIXED.poll || MIXED.job_id);
  if (!MIXED || sub.isTerminal(MIXED) || !(L && L.swapStatus) || !pollRef) return;
  clearTimeout(_mixedPoll);
  _mixedPoll = setTimeout(async () => {
    if (!MIXED || sub.isTerminal(MIXED)) return;
    try {
      const r = await L.swapStatus(MIXED.poll || MIXED.job_id);
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
    [sub.ST.SETTLING]:  'Settling · the on-chain HTLC leg is burying under Bitcoin (anchor-gated).',
    [sub.ST.REFUNDING]: 'Refunding the on-chain HTLC leg…',
    [sub.ST.REFUNDED]:  'Refund broadcast · the on-chain leg is being reclaimed; your funds return once it confirms.',
    [sub.ST.SETTLED]:   'Settled · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).',
    [sub.ST.FAILED]:    MIXED.htlc ? 'Failed · reclaim the on-chain leg below.' : 'Failed · nothing was spent.',
  }[MIXED.state] || MIXED.state;
  const dir = MIXED.side === 'buy'
    ? `Buy ${esc(am.ticker)} with BTC over Lightning · receive ${esc(am.ticker)} on-chain`
    : `Sell ${esc(am.ticker)} on-chain · receive BTC over Lightning`;
  const lock = MIXED.htlc && MIXED.htlc.refund_locktime;
  const legLine = MIXED.htlc
    ? (refundable
        ? `On-chain HTLC leg is past its refund timeout (block ${lock}) · reclaimable now.`
        : `On-chain HTLC leg refundable after block ${lock}${tip ? ` (tip ${tip})` : ''}.`)
    : (MIXED.state === sub.ST.FAILED
        ? 'The swap did not start: no on-chain leg was ever funded, so there is nothing to reclaim.'
        : 'The LSP is driving both legs; no separate on-chain leg to reclaim.');
  // ALWAYS show the failure/progress detail — hiding it on terminal states left users
  // staring at a bare "Failed" with the actual reason discarded.
  const detail = MIXED.detail ? ' · ' + esc(MIXED.detail) : '';
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">${dir}</span>
      <span class="sub">${esc(phase)}</span></div>
    <div class="swbook-row"><span class="sub">${esc(legLine)}${detail}</span></div>
    <div class="swbook-row" id="swMixedBtns"></div></div>`;
  const btns = C.$('swMixedBtns');
  // Only offer the reclaim button when a REAL refund mechanism exists (L.refund). Without it the
  // button used to broadcast nothing yet mark the swap REFUNDED — a fake success that told the user
  // their BTC was coming back while it stayed locked. When the LSP owns the on-chain leg, its own
  // driver reclaims after the CLTV timeout; we say so instead of offering a button we can't honour.
  const canRefund = !!(L && L.refund);
  if (MIXED.htlc && !terminal && MIXED.state !== sub.ST.REFUNDING){
    if (canRefund){
      const rb = C.el('button', 'danger', 'Refund BTC leg'); rb.id = 'swMixedRefund';
      rb.disabled = !refundable;
      if (!refundable) rb.title = `The on-chain HTLC leg is only refundable after its CLTV timeout (block ${lock}).`;
      rb.onclick = onRefundMixed;
      btns.appendChild(rb);
    } else {
      const note = C.el('span', 'sub');
      note.textContent = `The on-chain HTLC leg is refundable after its timeout (block ${lock}); the swap service reclaims it automatically — nothing to do here.`;
      btns.appendChild(note);
    }
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
    // NEVER fake a refund: without a real broadcast mechanism, a "refund" that returns no txid must
    // NOT mark the swap REFUNDED (that told the user their BTC was reclaimed while it stayed locked).
    if (!(L && L.refund)){
      st.className = 'status err';
      st.textContent = 'This build cannot broadcast the reclaim from the wallet; the swap service reclaims the on-chain leg automatically after its timeout.';
      return;
    }
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Refunding the on-chain HTLC leg…';
    MIXED = sub.markRefunding(MIXED); saveMixed(); renderMixedSwap();
    try {
      const txid = await L.refund({ id: MIXED.id, htlc: MIXED.htlc });
      if (!txid) throw new Error('the refund did not return a transaction id (nothing was broadcast)');
      MIXED = sub.markRefunded(MIXED, txid); saveMixed();
      modal.remove();
      C.toast(`On-chain HTLC leg refunded: ${String(txid).slice(0, 18)}…`);
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
  if (C.toast) try { C.toast('Resuming an interrupted Lightning+on-chain swap · refund the on-chain leg here if it stalls.'); } catch {}
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
      btcSats    = fieldAtoms($('swPayAmt'), 'BTC');
      assetAtoms = fieldAtoms($('swRecvAmt'), assetHex);
    } else {
      assetAtoms = fieldAtoms($('swPayAmt'), assetHex);
      btcSats    = fieldAtoms($('swRecvAmt'), 'BTC');
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

// Review + confirm for a BUY-with-BTC LIMIT order that rests via the SBTC silent peg (keepResting ON).
// Mirrors postCrossOfferReview's reverse (bid) modal, but on confirm pegs the BTC in and rests an SBTC
// covenant advertised as BTC (placePeggedBtcCovenant) instead of the interactive, wallet-must-stay-open
// HTLC maker. This is the ONLY place the peg is entered from the composer.
async function postPeggedBtcReview(q){
  const { $ } = C;
  const assetHex = q.assetHex;
  const am = C.assetMeta(assetHex);
  let btcSats, assetAtoms;
  try {
    btcSats    = fieldAtoms($('swPayAmt'), 'BTC');
    assetAtoms = fieldAtoms($('swRecvAmt'), assetHex);
    if (btcSats <= 0n || assetAtoms <= 0n) throw 0;
  } catch { $('swErr').textContent = `Enter both the BTC and the ${am.ticker}.`; return; }
  const haveBtc = balAtoms('BTC');
  if (btcSats > haveBtc){ $('swErr').textContent = `You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`; return; }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = [
    ['Posting', `A resting BID that stays live while you're offline — you become a maker of the ${am.ticker}/BTC market`],
    ['You pay', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['You buy', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['How it rests', `Your BTC is pegged to SBTC and locked in a covenant that fills even while your wallet is closed. On a fill the taker receives real BTC and you receive the ${am.ticker}.`],
    ['If it cancels', 'Cancel anytime — your funds return to you as regular BTC.'],
    ['Heads up', 'Pegging in needs a few Bitcoin confirmations before the bid goes live; you can close the wallet and it resumes.'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Buy with BTC — rest this bid offline', kv });
  if (ok) ok.textContent = 'Peg in & rest bid';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Pegging in…';
    try {
      await placePeggedBtcCovenant(assetHex, btcSats, assetAtoms, (m) => { st.innerHTML = '<span class="spin"></span>' + esc(m); });
      modal.remove();
      C.toast('Your BTC bid is resting — it stays live even if you close the wallet.');
      resetComposer();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not place: ' + C.prettyErr(e); ok.disabled = false;
    }
  };
}

// Review + confirm for filling a resting pegged-BTC covenant bid (taker sells the asset for BTC). On
// confirm we post a crossing order (takePeggedCovenant); the relay matches it, we settle the covenant
// fill on-chain (receiving SBTC), and the SBTC is auto-redeemed to real BTC — all handled by
// onCovMatched. `offer` is the resting covenant we detected in the reverse book.
async function takePeggedCovenantReview(q, offer){
  const { $ } = C;
  const assetHex = q.seqAsset;
  const am = C.assetMeta(assetHex);
  let assetAtoms, btcSats;
  try {
    assetAtoms = fieldAtoms($('swPayAmt'), assetHex);
    btcSats    = fieldAtoms($('swRecvAmt'), 'BTC');
    if (assetAtoms <= 0n || btcSats <= 0n) throw 0;
  } catch { $('swErr').textContent = `Enter both the ${am.ticker} and the BTC.`; return; }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = [
    ['Filling', `A resting BTC bid — you sell ${am.ticker} for BTC`],
    ['You pay', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['You receive', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '-'],
    ['How it settles', 'You fill the covenant on-chain (permissionless) and receive SBTC, which is automatically redeemed to real BTC at the bridge.'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: `Sell ${am.ticker} for BTC`, kv });
  if (ok) ok.textContent = 'Fill bid';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Crossing the bid…';
    try {
      await takePeggedCovenant(assetHex, assetAtoms, btcSats, (msg) => { st.innerHTML = '<span class="spin"></span>' + esc(msg); });
      modal.remove();
      C.toast('Order posted to cross the bid; settlement and BTC redemption happen automatically.');
      resetComposer();
      renderSwap();
    } catch (e){
      st.className = 'status err'; st.textContent = 'Could not fill: ' + C.prettyErr(e); ok.disabled = false;
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
    ...(q.confidential ? [['Privacy', 'Blinded book · both legs settle confidentially; amounts and assets are hidden on-chain (Confidential Transactions).']] : []),
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
      // Receipt into the persistent history so the Active-trades card is a record, not just live
      // status — same-chain taker lifts were the one completed flow that never logged one (W6).
      logTrade({ id: 'lift:' + txid,
        title: 'Swapped ' + C.assetMeta(q.assetP).ticker + ' for ' + C.assetMeta(q.assetR).ticker,
        status: 'settled', txid });
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
  // FUND-SAFETY: one cross swap per direction at a time. An in-flight swap — even one dismissed to the
  // Active-trades tray — holds a locked BTC leg / HTLC persisted under a single localStorage key;
  // starting another would OVERWRITE it and strand those funds (no way left to claim or refund). Require
  // finishing or refunding the current one first. (Concurrent same-rail swaps would need a keyed-per-swap
  // persistence store + independent resume — a separate, carefully-verified change; this guard closes
  // the strand hole safely in the meantime.)
  if (q.reverse ? (X.hasReverseInFlight && X.hasReverseInFlight()) : (X.hasInFlight && X.hasInFlight())){
    $('swErr').textContent = 'You already have a cross-chain swap in progress. Finish or refund it first (open it under Active trades) before starting another.';
    return;
  }
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
    // A pegged-BTC covenant bid (advertised as BTC, locking SBTC) among the reverse offers settles as
    // a COVENANT, not an HTLC — cross it and peg out (spec §5) rather than the xrswap wizard. Detected
    // by the presence of covenant settlement terms on the best takeable reverse offer.
    const best = (XBOOK.offers || [])[0];
    if (best && (best.covenant || best.Covenant)) return takePeggedCovenantReview(q, best);
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
  const am = C.assetMeta(route.seqAsset);
  const aprec = am.precision || 0;
  $('swRoute').textContent = route.payIsBtc ? 'Lightning · buy with BTC' : 'Lightning · sell for BTC';
  $('swStatus').textContent = ''; $('swErr').textContent = '';
  renderTiming(route);
  // The pure-LN CLI (xpln) has NO partial fill: it lifts the best resting offer IN FULL, so the size
  // that actually executes is the OFFER'S size, not the typed amount. Price + PIN off the SAME book
  // xpln lifts from — the LSP's /lnbook, sourced from the pure-LN relay (:9965) — NOT the on-chain
  // cross book (XBOOK, a DIFFERENT market on :9955). Quoting the cross book showed a price/amounts the
  // settle never honoured and enabled Review whenever cross had liquidity but pure-LN did not. Carry
  // the chosen offer's real amounts AND its id/maker_pubkey so Review shows what will move and the
  // settle lifts exactly THIS offer (pinned), never a relay-arbitrary one.
  let lnOffer = null;
  if (L && L.lnBook){
    try {
      const lb = await L.lnBook(route.seqAsset);
      const best = ((side === 'buy' ? lb.buy_offers : lb.sell_offers) || [])[0];
      if (best && Number(best.asset_amount) > 0 && Number(best.btc_sats) > 0)
        lnOffer = { assetAtoms: String(best.asset_amount), btcAtoms: String(best.btc_sats),
          offer_id: best.offer_id || null, maker_pubkey: best.maker_pubkey || null };
    } catch { /* LSP unreachable / older LSP without /lnbook -> treat as no pure-LN liquidity (honest) */ }
  }
  if (!lnOffer){
    LAST_QUOTE = null; setReviewEnabled(false);
    paintFee('BTC', null, null);
    $('swRate').textContent = `No resting Lightning offer for ${am.ticker}/BTC yet · use the on-chain book above.`;
    return;
  }
  LAST_QUOTE = { kind: 'ln', side, seqAsset: route.seqAsset, payIsBtc: route.payIsBtc,
    amount: amtStr ? parseFloat(amtStr) : null, lnOffer };
  paintFee('BTC', null, 'This rail lifts the best resting offer in full · the rate includes the LP spread (no separate network fee).');
  const assetStr = C.fmtAtoms(big(lnOffer.assetAtoms), aprec), btcStr = C.fmtAtoms(big(lnOffer.btcAtoms), 8);
  $('swRate').innerHTML = `Instant over Lightning · lifts the best offer <b>in full</b>: ${assetStr} ${am.ticker} for ${btcStr} BTC`;
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
    if (!L.provisionChannel){ $('swErr').textContent = 'Opening a channel is unavailable in this build · open one from the Balance tab first.'; return; }
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
    if (!ra.pureLnOk){ $('swErr').textContent = 'Your Lightning channel opened but is not ready to trade yet · please try again in a moment.'; return; }
  }
  const am = C.assetMeta(q.seqAsset);
  const aprec = am.precision || 0;
  const dir = q.side === 'buy' ? `Buy ${am.ticker} with BTC` : `Sell ${am.ticker} for BTC`;
  // xpln lifts the whole offer, so the amounts that actually move come from the offer, NOT q.amount.
  // Show them explicitly and warn if they differ materially from what the user typed.
  const off = q.lnOffer || null;
  const assetStr = off ? (C.fmtAtoms(big(off.assetAtoms), aprec) + ' ' + am.ticker) : null;
  const btcStr = off ? (C.fmtAtoms(big(off.btcAtoms), 8) + ' BTC') : null;
  const payStr = off ? (q.side === 'buy' ? btcStr : assetStr) : null;
  const recvStr = off ? (q.side === 'buy' ? assetStr : btcStr) : null;
  const kv = [
    ['Route', 'Instant Lightning (pure-LN) · non-custodial, your keys stay on this device'],
    ['Direction', dir],
  ];
  if (payStr){ kv.push(['You pay', payStr], ['You receive', recvStr]); }
  kv.push(
    ['Pricing', 'Lifts the best resting Lightning offer IN FULL · rate includes the LP spread (no separate network fee)'],
    ['Finality', L.finalityCopy ? L.finalityCopy() : 'Instant and final · pure Lightning, nothing on-chain, no Bitcoin-reorg risk.'],
    ['If it stalls', 'Nothing moves · the swap unwinds atomically via the Lightning hold timeout.'],
  );
  // Loud mismatch warning: the executed size is the offer's, so if the user typed something ~different,
  // say so before they commit (this rail cannot fill a partial amount).
  if (off && q.amount > 0){
    const execUnits = q.side === 'buy' ? (Number(big(off.btcAtoms)) / 1e8) : (Number(big(off.assetAtoms)) / Math.pow(10, aprec));
    if (execUnits > 0 && Math.abs(execUnits - q.amount) / execUnits > 0.05)
      kv.push(['⚠ Note', `This lifts the whole offer (${q.side === 'buy' ? btcStr : assetStr}), which differs from the ${C.fmtAtoms(BigInt(Math.round(q.amount * Math.pow(10, q.side === 'buy' ? 8 : aprec))), q.side === 'buy' ? 8 : aprec)} ${q.side === 'buy' ? 'BTC' : am.ticker} you entered. Partial fills are not possible on this rail.`]);
  }
  const { m: modal, ok, st } = C.modalRows({ title: 'Review Lightning swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Settling over Lightning…';
    try {
      // PIN the exact offer the user just reviewed: the LSP forwards offer_id/maker_pubkey to xpln so
      // it lifts THIS resting offer, not a relay-arbitrary one at a different price.
      const r = await L.swap({ side: q.side, asset: q.seqAsset, amount: q.amount,
        offer_id: (q.lnOffer && q.lnOffer.offer_id) || undefined,
        maker_pubkey: (q.lnOffer && q.lnOffer.maker_pubkey) || undefined });
      const bm = C.assetMeta(r.asset || q.seqAsset);
      const got = (r.direction === 'sold') ? `${r.quote_amount} BTC`
        : `${r.base_amount} ${bm.ticker}`;
      modal.remove();
      // Receipt into the persistent history (W6); no on-chain txid on this rail, so key by the
      // payment hash. Drop the raw preimage from the toast — it is protocol jargon, not user info (C-7).
      logTrade({ id: 'ln:' + (r.hash_h || r.preimage || Date.now()),
        title: (r.direction === 'sold' ? 'Sold ' + bm.ticker + ' for BTC' : 'Bought ' + bm.ticker + ' with BTC') + ' over Lightning',
        status: 'settled' });
      C.toast(`Lightning swap settled and final: received ${got}.`);
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
function trim(n){
  if (!isFinite(n)) return '-';
  const r = Math.round(n * 1e8) / 1e8;
  if (r === 0) return '0';
  // Never emit scientific notation: Number.toString() switches to "1e-7" below 1e-6, which reads wrong
  // in the UI and, if written into an amount field, makes parseAtoms() throw. Render fixed to 8dp (BTC
  // precision, the finest we quote) and strip trailing zeros.
  let s = r.toFixed(8);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
// Group the integer part of an already-formatted number string with thousands separators.
function _group(s){ const neg = s[0] === '-'; if (neg) s = s.slice(1); const [i, f] = s.split('.'); const ig = i.replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (neg ? '-' : '') + (f ? ig + '.' + f : ig); }
// Size/amount for DISPLAY: trim()'s precision + thousands separators. NEVER write this into an input.
function fmtGroup(n){ return _group(trim(n)); }
// PRICE for DISPLAY: magnitude-appropriate precision (a ~2350 price doesn't need 8dp) + separators.
function fmtPrice(n){
  if (!isFinite(n)) return '-';
  if (n === 0) return '0';
  const a = Math.abs(n);
  if (a < 1e-8) return (n < 0 ? '-' : '') + '<0.00000001';   // nonzero but below 8dp resolution — never show a real price as "0" (e.g. a cheap asset priced in BTC)
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  let s = (Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp)).toFixed(dp);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return _group(s);
}

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
    payAtoms = fieldAtoms($('swPayAmt'), pay);
    recvAtoms = fieldAtoms($('swRecvAmt'), receive);
    if (payAtoms <= 0n || recvAtoms <= 0n) throw 0;
  } catch { $('swErr').textContent = 'Enter both amounts - what you give and what you want - to start a market.'; return; }
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const kv = [
    ['Posting', 'A resting offer - you become the maker of this market'],
    ...((q.confidential || isConfBook()) ? [['Privacy', 'Blinded book · your offer rests confidentially and fills confidentially; a blinded receive address and blinding pubkey are published so the counterparty can blind their leg too.']] : []),
    ['You give', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You want', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? ratePerPayToLine(pay, receive, recvU/payU).str : '-'],
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
// pay, get receive) · clickable to lift; BIDS are the opposite side (display-only
// depth, since the taker can't lift them).
// D5: recent-trades feed for the active pair, backed by seqobd's /trades (T1). Resting offers use ONE
// canonical base/quote per market, so exactly one direction has data — query the composer's direction
// first, fall back to the inverse, and display whichever has trades (never merge — the two are
// inverse-priced). Compact: price (quote/base) · size (base) · time-ago. Empty ⇒ no section (honest).
let _tradesPair = null, _tradesReq = 0;
async function renderRecentTrades(){
  const host = C.$('swTrades'); if (!host) return;
  const pay = S.payAsset, recv = S.receiveAsset;
  if (!pay || !recv){ host.innerHTML = ''; return; }
  const req = ++_tradesReq;
  const fetchDir = async (base, quote) => {
    try {
      const r = await fetch(seqob.seqobBase() + '/v1/market/' + encodeURIComponent(base) + '/' + encodeURIComponent(quote) + '/trades?limit=30', { cache: 'no-store' });
      if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.trades) ? j.trades : [];
    } catch { return []; }
  };
  // ONE canonical base/quote per pair ("1 base = N quote") — query that direction, else the inverse and
  // invert its prices, so the feed reads the SAME way as the book + rate line.
  const canon = pairDir(pay, recv);
  let sizeAsset = canon.base, inv = false, trades = await fetchDir(canon.base, canon.quote);
  if (!trades.length){ const alt = await fetchDir(canon.quote, canon.base); if (alt.length){ trades = alt; inv = true; sizeAsset = canon.quote; } }
  if (req !== _tradesReq) return;                 // superseded by a newer pair
  if (!trades.length){ host.innerHTML = ''; return; }
  trades.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const bm = C.assetMeta(canon.base), qm = C.assetMeta(canon.quote), sm = C.assetMeta(sizeAsset);
  const px = (t) => { const p = Number(t.price); return (p > 0 && inv) ? 1 / p : p; };   // quote per canonical base
  const nowS = Math.floor(Date.now() / 1000);
  const ago = (ts) => { const s = Math.max(0, nowS - (ts || 0)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s/60) + 'm' : s < 86400 ? Math.floor(s/3600) + 'h' : Math.floor(s/86400) + 'd'; };
  const row = (t) => '<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 10px;font-size:12px">'
    + '<span class="mono">' + trim(px(t)) + '</span>'
    + '<span class="mono sub">' + esc(C.fmtAtoms(big(String(t.size || 0)), sm.precision || 0)) + ' ' + esc(sm.ticker) + '</span>'
    + '<span class="sub" style="min-width:30px;text-align:right">' + ago(t.ts) + '</span></div>';
  host.innerHTML = '<div class="swladder" style="margin-top:8px"><div class="swladder-head">'
    + '<span class="sub" style="color:var(--txt);font-weight:650">Recent trades</span>'
    + '<span class="sub">price ' + esc(bm.ticker) + '/' + esc(qm.ticker) + '</span></div>'
    + trades.slice(0, 30).map(row).join('') + '</div>';
}

// D3: 24h stats + a mini sparkline for the active pair, from seqobd /candles (T1). Same
// one-canonical-direction handling as the trades feed. Sparse on testnet (renders whatever exists);
// richer as trades accumulate. Cleared when no pair / no candle data.
let _statsPair = null, _statsReq = 0;
async function renderPairStats(){
  const host = C.$('swPairStats'); if (!host) return;
  const pay = S.payAsset, recv = S.receiveAsset;
  if (!pay || !recv){ host.innerHTML = ''; return; }
  const req = ++_statsReq;
  const fetchDir = async (base, quote) => {
    try {
      const r = await fetch(seqob.seqobBase() + '/v1/market/' + encodeURIComponent(base) + '/' + encodeURIComponent(quote) + '/candles?interval=3600&limit=48', { cache: 'no-store' });
      if (!r.ok) return []; const j = await r.json(); return Array.isArray(j.candles) ? j.candles : [];
    } catch { return []; }
  };
  const canon = pairDir(pay, recv);
  let sizeAsset = canon.base, inv = false, candles = await fetchDir(canon.base, canon.quote);
  if (!candles.length){ const alt = await fetchDir(canon.quote, canon.base); if (alt.length){ candles = alt; inv = true; sizeAsset = canon.quote; } }
  if (req !== _statsReq) return;
  if (!candles.length){ host.innerHTML = ''; return; }
  // Normalise every candle to the canonical quote-per-base frame; inverting an inverse-direction feed
  // swaps each candle's high and low. vol stays in the candle's own (size) asset.
  const iv = (x) => { const n = Number(x); return (n > 0) ? 1 / n : 0; };
  const cN = candles.map(c => inv
    ? { t: c.t, o: iv(c.o), c: iv(c.c), h: iv(c.l), l: iv(c.h), v: c.v }
    : { t: c.t, o: Number(c.o), c: Number(c.c), h: Number(c.h), l: Number(c.l), v: c.v });
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const win = cN.filter(c => (c.t || 0) >= cutoff);
  const use = win.length ? win : cN.slice(-1);   // nothing in 24h → show the latest as a flat point
  let hi = -Infinity, lo = Infinity, vol = 0n;
  for (const c of use){ if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; vol += big(String(c.v || 0)); }
  const first = use[0], lastc = use[use.length - 1];
  const changePct = (first && first.o > 0) ? ((lastc.c - first.o) / first.o * 100) : 0;
  const bm = C.assetMeta(sizeAsset);
  const pts = use.map(c => c.c).filter(isFinite);
  const up = changePct >= 0, col = up ? '#3ddc84' : 'var(--amber2)';
  let spark = '';
  if (pts.length >= 2){
    const min = Math.min(...pts), max = Math.max(...pts), rng = (max - min) || 1, W = 84, H = 20;
    const d = pts.map((p, i) => (i / (pts.length - 1) * W).toFixed(1) + ',' + (H - (p - min) / rng * H).toFixed(1)).join(' ');
    spark = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="vertical-align:middle"><polyline points="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.5"/></svg>';
  }
  const chg = (up ? '+' : '') + changePct.toFixed(2) + '%';
  host.innerHTML = '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:4px 2px;font-size:12px" class="sub">'
    + spark
    + '<span>24h <b style="color:' + col + '">' + chg + '</b></span>'
    + (hi > -Infinity ? '<span>H <span class="mono">' + trim(hi) + '</span></span><span>L <span class="mono">' + trim(lo) + '</span></span>' : '')
    + '<span>vol <span class="mono">' + esc(C.fmtAtoms(vol, bm.precision || 0)) + '</span> ' + esc(bm.ticker) + '</span>'
    + '</div>';
}

function renderBook(pay, receive){
  const host = C.$('swBook'); if (!host) return;
  const { base, quote } = pairDir(pay, receive);
  const bm = C.assetMeta(base), qm = C.assetMeta(quote);
  const toU = (a, p) => Number(big(a)) / Math.pow(10, p || 0);
  const MY = (typeof makerPubHex === 'function') ? makerPubHex() : null;   // this wallet's own maker id
  const isMine = (o) => !!(MY && (o.maker_pubkey || o.makerPubkey) === MY);
  // Every offer, mapped into the FIXED base/quote frame: price = quote per base ("1 base = N quote"),
  // size in base units. An offer that GIVES the base is selling base (an ASK); giving quote is a BID.
  // `take` marks the liftable side (only BOOK.offers can be lifted) — it flips with buy/sell, not display.
  const classify = (o, offerAsset, take) => {
    const offerIsBase = (offerAsset === base);
    const baseA  = big(offerIsBase ? (o.offer_amount || o.offerAmount) : (o.want_amount || o.wantAmount));
    const quoteA = big(offerIsBase ? (o.want_amount || o.wantAmount)  : (o.offer_amount || o.offerAmount));
    const baseU = toU(baseA, bm.precision), quoteU = toU(quoteA, qm.precision);
    return { price: baseU > 0 ? quoteU / baseU : 0, size: baseU, isAsk: offerIsBase, take,
             id: o.offer_id || o.offerId, maker: o.maker_pubkey || o.makerPubkey, mine: isMine(o) };
  };
  const rows = [
    ...(BOOK.offers || []).map(o => classify(o, receive, true)),     // give receive, want pay — liftable
    ...(BOOK.otherOffers || []).map(o => classify(o, pay, false)),   // give pay, want receive — the other side
  ].filter(r => r.price > 0 && r.size > 0);
  let asks = rows.filter(r => r.isAsk);
  let bids = rows.filter(r => !r.isAsk);
  const bestAsk = asks.length ? Math.min(...asks.map(a => a.price)) : null;
  const bestBid = bids.length ? Math.max(...bids.map(b => b.price)) : null;
  const mid = (bestAsk != null && bestBid != null) ? (bestAsk + bestBid) / 2 : (bestAsk != null ? bestAsk : bestBid);
  const spread = (bestAsk != null && bestBid != null) ? (bestAsk - bestBid) : null;
  // cumulate from the mid outward; display asks high->low, bids high->low
  asks.sort((a, b) => a.price - b.price);
  { let c = 0; const t = asks.reduce((s, r) => s + r.size, 0) || 1; asks.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  bids.sort((a, b) => b.price - a.price);
  { let c = 0; const t = bids.reduce((s, r) => s + r.size, 0) || 1; bids.forEach(r => { c += r.size; r.cum = c; r.frac = c / t; }); }
  // Show the 8 offers NEAREST the mid (the BEST asks + BEST bids), never the farthest: asks is sorted
  // ascending, so slice the 8 LOWEST then reverse for the high->low display (best ask sits right above
  // the mid); bids are already best-first (descending). Previously the ask side reversed BEFORE slicing,
  // so it showed the 8 HIGHEST asks and hid the best ones — visibly inconsistent with the spread/mid.
  asks = asks.slice(0, 8); asks.reverse(); bids = bids.slice(0, 8);
  // Only the liftable rows (from BOOK.offers) are clickable — seed the composer at that level's price.
  const wire = (r) => { if (r.take) r.onClick = () => fillFromOffer(r.id, r.maker, pay, receive); };
  asks.forEach(wire); bids.forEach(wire);
  LAST_MID = { price: mid, cross: false, base, quote, oneSided: !(bestAsk != null && bestBid != null) };
  renderLadder(host, {
    asks, bids, mid, spread,
    priceLabel: `(${bm.ticker}/${qm.ticker})`, sizeLabel: bm.ticker,
    refMidStr: oneUnitRefStr(base),
    headTitle: 'Order book', headSub: `${(BOOK.offers || []).length} offer${(BOOK.offers || []).length === 1 ? '' : 's'}${liveBookOn() ? ' · live' : ''}`,
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
// E3: notify when a RESTING order fills — including one that filled while the wallet was CLOSED.
// The maker-credit balance is the fill signal (a covenant fill pays a payout only this wallet
// controls). Persist the last-seen balance across sessions; any per-asset INCREASE is a fill, so
// toast the delta. The very first observation just baselines (no toast). Cheap + idempotent, so it's
// safe to call on every renderMyOrders (live fills via onCovOrderStatus, and on reopen via resume).
let _seenCredits = undefined;
function notifyNewCredits(){
  let bal; try { bal = covenantCreditBalance(); } catch { return; }
  const cur = {}; for (const h of Object.keys(bal || {})){ const v = big(bal[h]); if (v > 0n) cur[h] = v.toString(); }
  if (_seenCredits === undefined){ try { _seenCredits = JSON.parse(localStorage.getItem('swk.seenCredits.v1') || 'null'); } catch { _seenCredits = null; } }
  if (_seenCredits == null){ _seenCredits = cur; try { localStorage.setItem('swk.seenCredits.v1', JSON.stringify(cur)); } catch {} return; }
  for (const h of Object.keys(cur)){
    const now = big(cur[h]), was = big(_seenCredits[h] || '0');
    if (now > was){
      const m = C.assetMeta(h);
      try { C.toast && C.toast(`Your resting order filled · received ${C.fmtAtoms(now - was, m.precision)} ${m.ticker}.`); } catch {}
    }
  }
  _seenCredits = cur; try { localStorage.setItem('swk.seenCredits.v1', JSON.stringify(cur)); } catch {}
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
  // Gate on the OBJECT, not just the predicate: hasSell/BuyInFlight() also returns true off the
  // synchronous _sellStarting/_buyStarting sentinel DURING the pre-fund prologue, before SELL/BUY is
  // assigned — a bare predicate check here would deref null. The prologue has nothing to show in this
  // card anyway (the progress modal covers it); the row appears once the record exists.
  // Show the sell row while it is genuinely in flight, AND when it has stopped with an error — a
  // terminal 'failed' (the maker reclaimed the BTC) or a transient claim error. Without this a stuck
  // sell either silently wedged the rail (old bug: 'claiming' forever, no message) or, once terminal,
  // vanished with no explanation. A failed sell offers Clear (safe: the HTLC is resolved on-chain); a
  // transient one offers Retry.
  if (SELL && (hasSellInFlight() || SELL.state === 'failed' || SELL.error)){
    const failed = SELL.state === 'failed';
    const status = failed
      ? (SELL.error || 'This sell could not be completed.')
      : (SELL.error ? (SELL.error + ' · will retry') : 'claiming your BTC on-chain (automatic)');
    rows.push({ view: null, need: !failed, title: 'Sell ' + esc(SELL.ticker) + ' for BTC',
      status, action: failed ? 'clear-sell' : (SELL.error ? 'retry-sell' : null) });
  }
  if (BUY && hasBuyInFlight()){
    rows.push({ view: null, need: true, title: 'Buy ' + esc(BUY.ticker || 'asset') + ' with BTC',
      status: BUY.state === 'holding' ? 'held · settle from your wallet to receive' : 'BTC HTLC funded; awaiting the asset over Lightning' });
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
          ${r.view ? `<button type="button" class="ghost swviewtrade" data-view="${r.view}">View</button>`
            : r.action === 'clear-sell' ? `<button type="button" class="ghost swclearsell">Clear</button>`
            : r.action === 'retry-sell' ? `<button type="button" class="ghost swretrysell">Retry</button>`
            : '<span class="sub">automatic</span>'}
        </div>`).join('')
      + `</div>`;
  }
  if (hist.length){
    html += `<div class="swbook"><div class="swbook-head">
        <span class="lbl">Your recent trades</span><span class="sub">last ${hist.length}</span></div>`
      + hist.slice(0, 6).map(e => `<div class="swbook-row myorder">
          <span class="mono">${esc(e.title)} · ${esc(e.status)}</span>
          ${e.txid ? `<span class="sub mono">${esc(String(e.txid).slice(0, 12))}…</span>` : ''}</div>`).join('')
      + `</div>`;
  }
  host.innerHTML = html;
  // Clear a terminally-failed sub-asset sell: its BTC HTLC is already resolved on-chain, so removing
  // the record loses no funds and unblocks the sell rail. Retry re-drives resumeSell for a transient one.
  host.querySelectorAll('.swclearsell').forEach(b => b.onclick = () => {
    clearSell(); try { renderInFlightCard(); } catch {} try { updateRails(); } catch {}
  });
  host.querySelectorAll('.swretrysell').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Retrying…';
    try { SELL && (SELL.error = null, saveSell()); await resumeSell(); } catch {}
    try { renderInFlightCard(); } catch {}
  });
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
  notifyNewCredits();                // E3: toast any newly-filled resting order (incl. filled-while-away)

  let orders = [];
  // On a fetch error, leave whatever is already rendered rather than blanking the panel (a transient
  // relay blip should not make your resting orders vanish from the UI).
  try { orders = await seqob.fetchMyOrders(makerPubHex()); } catch { if (credits) host.innerHTML = credits; return; }
  // D2/T13: prune fill-progress for orders no longer resting, so a stale entry can't paint a wrong
  // "~N% filled" if the relay ever re-uses an offer_id.
  const relayIds = new Set(orders.map(o => o.offer_id || o.offerId));
  { for (const k of Object.keys(_ordStatus)) if (!relayIds.has(k)) delete _ordStatus[k]; }
  // LOCAL reclaim rows: covenant orders THIS wallet funded on-chain that the relay no longer
  // lists (its offer TTL is far shorter than the ~24h on-chain lock) but whose locked asset is
  // still reclaimable via the CLTV refund. Without these the reclaim UI vanished with the relay
  // listing and the funds became unreachable through the wallet.
  const localReclaim = PLACED.filter(r => r.covTxid != null && !relayIds.has(r.offerId) && !r._orphan);
  const localRows = localReclaim.map(r => {
    const give = C.assetMeta(r.pay);
    return `<div class="swbook-row myorder">
      <span class="mono">give ${esc(C.fmtAtoms(BigInt(r.sellAtoms), give.precision))} ${esc(give.ticker)} · funded on-chain (delisted from the relay)</span>
      <button type="button" class="ghost swcancel" data-id="${esc(r.offerId)}">Reclaim</button></div>`;
  }).join('');
  if (!orders.length && !localRows){ host.innerHTML = credits; return; }
  const rows = orders.map(o => {
    const give = C.assetMeta(o.offer_asset||o.offerAsset), want = C.assetMeta(o.want_asset||o.wantAsset);
    const isCov = !!(o.covenant || o.Covenant);
    // D2/T13: per-order fill progress. active_amount (remaining base atoms) < base_amount ⇒ partially
    // filled; show ~N% done. Only when we've seen an order_status for it (live, this session).
    const id = o.offer_id||o.offerId;
    const base = big(o.base_amount||o.baseAmount||0);
    const stat = _ordStatus[id];
    let fillHint = '';
    if (stat && base > 0n && stat.active >= 0n && stat.active < base){
      const pct = Number((base - stat.active) * 100n / base);
      fillHint = pct >= 100 ? ' · <span style="color:#3ddc84">filled</span>' : ` · <span style="color:#3ddc84">~${pct}% filled</span>`;
    }
    return `<div class="swbook-row myorder">
      <span class="mono">give ${esc(C.fmtAtoms(big(o.offer_amount||o.offerAmount), give.precision))} ${esc(give.ticker)} · want ${esc(C.fmtAtoms(big(o.want_amount||o.wantAmount), want.precision))} ${esc(want.ticker)}${isCov ? ' · resting on-chain' : ''}${fillHint}</span>
      <button type="button" class="ghost swcancel" data-id="${esc(id)}">Cancel</button></div>`;
  }).join('');
  host.innerHTML = credits + `<div class="swbook"><div class="swbook-head"><span class="lbl">Your resting orders</span>
      <span class="sub">funded on-chain · fill whenever matched, even offline</span></div>${rows}${localRows}</div>`;
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
          C.toast('Order cancelled · reclaimed on-chain (' + String(out.refundTxid).slice(0,12) + '…).');
          // SBTC silent peg: the reclaimed asset is SBTC, but the maker paid BTC and expects BTC back.
          // Redeem it (best-effort; on failure the user simply holds redeemable SBTC — fund-safe).
          if (rec.pegged){ try { await C.sync(); await pegOutReceivedSbtc(BigInt(rec.sellAtoms)); } catch {} }
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
