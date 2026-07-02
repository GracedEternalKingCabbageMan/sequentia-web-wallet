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

let C = null;            // injected app context (see index.html initSwapTab)
let X = null;            // the cross-chain route handle ({ openFromComposer, renderXswap, hasInFlight })
let MARKETS = [];        // legacy RFQ markets (kept only to seed the picker; routing is order-book)
let XMARKETS = [];       // cross-chain: [{ btc_asset, seq_asset, ... }] (BTC<->asset)
let LAST_QUOTE = null;   // the priced/oriented same-chain legs for the current composer state
let BOOK = { offers: [], pair: null };   // the resting offers for the selected same-chain pair
let XBOOK = { offers: [], seqAsset: null, payIsBtc: true };   // resting cross offers for the selected BTC<->asset pair
let XMAKE = null;   // the wallet's OWN live resting cross offer (maker) + its settlement state, if any

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
};

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
    if ($('swXBack')) $('swXBack').onclick = () => { showCross(false); renderSwap(); };
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
    LAST_QUOTE = null;
    setReviewEnabled(false);
    clearTimeout(_quoteTimer);
    _quoteTimer = setTimeout(() => requote().catch(()=>{}), 350);
  });
}

// Re-render the whole composer for the current wallet/markets/state.
export async function renderSwap(){
  if (!C.wollet) return;
  // If a cross-chain swap is already in flight, jump straight to its stepper —
  // the composer's single entry point also resumes an interrupted BTC swap. Two
  // directions, two wizards: forward (pay BTC, get asset) and reverse (sell asset).
  if (X && X.hasInFlight && X.hasInFlight()){
    showCross(true);
    X.renderXswap();
    return;
  }
  if (X && X.hasReverseInFlight && X.hasReverseInFlight()){
    showReverse(true);
    X.renderReverse();
    return;
  }
  showCross(false); showReverse(false);
  const _bh = C.$('swBook'); if (_bh) _bh.innerHTML = '';   // cleared; requote re-renders for the selected pair
  renderMyOrders();
  await loadMarkets();
  // Default the pay/receive assets to the first sensible tradable pair so the
  // composer is never empty: tSEQ on top if it trades, else the first market.
  ensureDefaults();
  renderFeePicker();
  paintPanes();
  await requote().catch(()=>{});
}

function showCross(on){
  const cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (cw) cw.classList.toggle('hide', !on);
  if (on && rw) rw.classList.add('hide');     // forward + reverse hosts are mutually exclusive
  if (comp) comp.classList.toggle('hide', on);
  // "Back to composer" only makes sense before BTC is locked. Once a cross-chain
  // swap is in flight it must be resumed/abandoned/refunded from the stepper, not
  // walked away from — so hide Back whenever a swap is persisted.
  const back = C.$('swXBack');
  if (back) back.classList.toggle('hide', !on || (X && X.hasInFlight && X.hasInFlight()));
}
// Reverse (asset -> BTC) wizard host, symmetric with showCross.
function showReverse(on){
  const cw = C.$('swapCrossWrap'), rw = C.$('swapReverseWrap'), comp = C.$('swComposer');
  if (rw) rw.classList.toggle('hide', !on);
  if (on && cw) cw.classList.add('hide');
  if (comp) comp.classList.toggle('hide', on);
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
  return [...set];
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
    // have no resting offers yet — then it's startable). BTC is always a valid
    // cross-chain counterpart for a Sequentia asset.
    for (const h of startableAssets()){ if (h !== other && h !== 'BTC') set.add(h); }
    set.add('BTC');
  }
  return [...set];
}

// Is (pay, receive) a routable pair? Same-chain if both are Sequentia assets with
// a market; cross-chain if exactly one side is BTC and the BTC<->asset market exists.
function findRoute(pay, receive){
  if (!pay || !receive || pay === receive) return null;
  const btc = (pay === 'BTC') || (receive === 'BTC');
  if (btc){
    const seqAsset = pay === 'BTC' ? receive : pay;
    if (seqAsset === 'BTC') return null;   // BTC<->BTC is not a market
    // Cross-chain order book: ANY BTC<->asset pair is routable. It may have no
    // resting cross offers yet (the book then shows empty). A live RFQ market, if
    // any, is attached only for its cached price; it is no longer required.
    const xm = XMARKETS.find(m => m.seq_asset === seqAsset) || null;
    return { kind: 'cross', seqAsset, xm, payIsBtc: pay === 'BTC' };
  }
  // Same-chain order book: ANY two distinct Sequentia assets form a market. It may
  // have no resting offers yet, in which case the user can start it by posting one.
  return { kind: 'same', pay, receive };
}

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
  const a = balAtoms(hex), m = metaOf(hex);
  return 'Balance ' + C.fmtAtoms(a, m.precision) + ' ' + m.ticker;
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
  $('swRoute').textContent = route.kind === 'cross'
    ? (route.payIsBtc ? 'Cross-chain · buy with BTC' : 'Cross-chain · sell for BTC')
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
  S.edited = S.edited === 'pay' ? 'receive' : 'pay';
  LAST_QUOTE = null; setReviewEnabled(false);
  paintPanes();
  requote().catch(()=>{});
}
function onMax(){
  if (!S.payAsset || S.payAsset === 'BTC') return;
  const m = C.assetMeta(S.payAsset);
  C.$('swPayAmt').value = C.fmtAtoms(balAtoms(S.payAsset), m.precision);
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
  paintRouteLine();
  const route = findRoute(S.payAsset, S.receiveAsset);
  if (!route){ setReviewEnabled(false); clearOpposite(); const bh = C.$('swBook'); if (bh) bh.innerHTML = ''; return; }
  const amtStr = typedAmount(S.edited);
  // Do NOT bail on an empty amount: requoteSame/requoteCross fetch and RENDER the
  // order book first (so it is visible the moment a pair is chosen), then quote
  // only if an amount is present.
  if (route.kind === 'cross') return requoteCross(route, amtStr);
  return requoteSame(route, amtStr);
}

function clearOpposite(){
  const other = S.edited === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
  // Don't stomp a value the user is actively typing on the OTHER side.
  if (document.activeElement !== other) other.value = '';
}
function setReviewEnabled(on){ const b = C.$('swReview'); if (b) b.disabled = !on; }

// --- same-chain quote (SeqOB order book) ---
// "No price" is never an error: we render the resting offers, and if there are
// none the user can start the market by posting their own offer.
async function requoteSame(route, amtStr){
  const { $ } = C;
  const pay = route.pay, receive = route.receive;
  const status = $('swStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading the order book…';
  $('swErr').textContent = '';
  try {
    if (!S.feeAsset) S.feeAsset = defaultFeeAsset();
    // The relay keys markets by exact base/quote order, so fetch BOTH orientations
    // and keep the offers we can TAKE for pay->receive: maker gives `receive`, wants `pay`.
    const [b1, b2] = await Promise.all([
      seqob.fetchBook(receive, pay).catch(()=>({offers:[]})),
      seqob.fetchBook(pay, receive).catch(()=>({offers:[]})),
    ]);
    const now = Math.floor(Date.now()/1000);
    const seen = new Set(), liftable = [];
    for (const o of [...(b1.offers||[]), ...(b2.offers||[])]){
      const id = (o.maker_pubkey||o.makerPubkey)+':'+(o.offer_id||o.offerId);
      if (seen.has(id)) continue; seen.add(id);
      if (o._verified === false) continue;                       // untrusted relay: skip forged rows
      if ((o.offer_asset||o.offerAsset) !== receive || (o.want_asset||o.wantAsset) !== pay) continue;
      const exp = Number(o.expires_at_unix || o.expiresAtUnix || 0);
      if (exp && exp <= now) continue;
      liftable.push(o);
    }
    liftable.sort((a,bb)=> ratioRecvPerPay(bb) - ratioRecvPerPay(a));  // best price for the taker first
    BOOK = { pair:{ base_asset: receive, quote_asset: pay }, offers: liftable };
    renderBook(pay, receive);

    if (!amtStr || !amtStr.trim()){ status.textContent=''; clearOpposite(); setReviewEnabled(false); paintEmptyRate(pay, receive, liftable.length); return; }

    if (!liftable.length){
      // No resting liquidity: offer to START the market rather than erroring.
      status.textContent = '';
      LAST_QUOTE = { kind:'same', startMarket:true, pay, receive };
      $('swRate').textContent = `No resting offers yet — Review to post your own and start this market.`;
      $('swRoute').textContent = 'Order book · be the first';
      paintFee(S.feeAsset, null);
      setFinality('same');
      setReviewEnabled(true);
      return;
    }

    const editedAsset = S.edited === 'pay' ? pay : receive;
    const typed = C.parseAtoms(amtStr, C.assetMeta(editedAsset).precision || 0);
    if (typed <= 0n) throw new Error('enter an amount greater than zero');
    LAST_QUOTE = executableQuote(liftable[0], pay, receive, editedAsset, typed);
    status.textContent = '';
    paintQuoteSame();
    setReviewEnabled(true);
  } catch (e){
    status.textContent = '';
    $('swErr').textContent = 'Order book: ' + (e.message || e);
    setReviewEnabled(false);
  }
}

function ratioRecvPerPay(o){
  const off = Number(o.offer_amount || o.offerAmount || 0), want = Number(o.want_amount || o.wantAmount || 0);
  return want > 0 ? off/want : 0;
}
function ceilDiv(a, b){ return (a + b - 1n) / b; }

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
    ? `${n} resting offer${n>1?'s':''} for ${C.assetMeta(receive).ticker} — enter an amount.`
    : `No resting offers for ${C.assetMeta(receive).ticker}/${C.assetMeta(pay).ticker} yet — enter an amount to start this market.`;
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

// --- cross-chain quote (GetXchainQuote) ---
async function requoteCross(route, amtStr){
  const { $ } = C;
  if (!X || !X.quote){ $('swErr').textContent = 'Cross-chain route unavailable in this build.'; setReviewEnabled(false); return; }
  const seqAsset = route.seqAsset;
  const am = C.assetMeta(seqAsset);
  const seqPrec = am.precision || 0;
  const status = $('swStatus'); status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading the cross-chain order book…';
  $('swErr').textContent = '';
  try {
    // Fetch + render the cross order book for this pair, then pick the side that
    // matches the taker's direction: buy asset with BTC = forward offers; sell
    // asset for BTC = reverse offers. "No offers" is not an error — it renders an
    // empty book (cross markets need a maker with BTC reserves, so unlike a
    // same-chain pair the wallet can't self-start one yet).
    let book = { forward: [], reverse: [] };
    if (X.book) book = await X.book(seqAsset).catch(() => ({ forward: [], reverse: [] }));
    const offers = route.payIsBtc ? (book.forward || []) : (book.reverse || []);
    XBOOK = { seqAsset, payIsBtc: route.payIsBtc, offers };
    renderXBook(seqAsset, route.payIsBtc, offers);

    if (!offers.length){
      status.textContent = ''; clearOpposite(); setFinality('cross');
      if (!route.payIsBtc && X && X.makerStart){
        // SELL asset for BTC with no resting bid: self-start via the FORWARD maker
        // (the wallet holds the asset, locks it, claims the taker's BTC).
        LAST_QUOTE = { kind: 'cross-make', reverse: false, assetHex: seqAsset };
        $('swRate').textContent = `No resting offers yet — Review to post your own and sell ${am.ticker} for BTC.`;
        $('swRoute').textContent = 'Cross-chain · be the first (sell for BTC)';
        setReviewEnabled(true);
      } else if (route.payIsBtc && X && X.makerStartReverse){
        // BUY asset with BTC with no resting ask: self-start via the REVERSE maker
        // (the wallet funds a BTC bid, holds the secret, claims the taker's asset).
        LAST_QUOTE = { kind: 'cross-make', reverse: true, assetHex: seqAsset };
        $('swRate').textContent = `No resting offers yet — Review to post your own and buy ${am.ticker} with BTC.`;
        $('swRoute').textContent = 'Cross-chain · be the first (buy with BTC)';
        setReviewEnabled(true);
      } else {
        LAST_QUOTE = null; setReviewEnabled(false);
        $('swRate').textContent = `No resting offers for ${am.ticker}/BTC yet — a market maker needs to post one.`;
        $('swRoute').textContent = route.payIsBtc ? 'Cross-chain · buy with BTC' : 'Cross-chain · sell for BTC';
      }
      return;
    }

    if (!amtStr || !amtStr.trim()){
      status.textContent = ''; clearOpposite(); setReviewEnabled(false);
      const n = offers.length;
      $('swRate').textContent = `${n} resting cross-chain offer${n>1?'s':''} — enter an amount.`;
      $('swRoute').textContent = route.payIsBtc ? 'Cross-chain · buy with BTC' : 'Cross-chain · sell for BTC';
      setFinality('cross');
      return;
    }

    // seq_amount to quote (the daemon prices in the asset amount): use the typed
    // asset amount, or convert a typed BTC amount via the best resting offer.
    const editedIsSeq = (S.edited === 'pay' ? S.payAsset : S.receiveAsset) === seqAsset;
    let seqAtoms;
    if (editedIsSeq){
      seqAtoms = C.parseAtoms(amtStr, seqPrec);
    } else {
      const btcAtoms = C.parseAtoms(amtStr, 8);
      const { asset, btc } = xOfferAmts(offers[0], route.payIsBtc);
      if (!(asset > 0n && btc > 0n)) throw new Error('no cross-chain price yet');
      seqAtoms = (btcAtoms * asset) / btc;   // asset-atoms per btc-atom, from the best offer
    }
    if (seqAtoms <= 0n) throw new Error('enter an amount greater than zero');
    if (route.payIsBtc){
      const xq = await X.quote(seqAsset, seqAtoms);          // { seq_amount, btc_amount, fee_btc, ... }
      LAST_QUOTE = { kind:'cross', reverse:false, route, xq, seqAsset };
    } else {
      if (!X.reverseQuote) throw new Error('selling an asset for BTC is unavailable in this build');
      const rq = await X.reverseQuote(seqAsset, seqAtoms);   // same shape; btc_amount is what you receive (net of fee)
      LAST_QUOTE = { kind:'cross', reverse:true, route, xq: rq, seqAsset };
    }
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
// rendered into the shared #swBook host like the same-chain book.
function renderXBook(seqAsset, payIsBtc, offers){
  const host = C.$('swBook'); if (!host) return;
  const am = C.assetMeta(seqAsset);
  offers = offers || [];
  const rows = offers.slice(0, 12).map(o => {
    const { asset, btc } = xOfferAmts(o, payIsBtc);
    const assetU = Number(asset)/Math.pow(10, am.precision||0), btcU = Number(btc)/1e8;
    const price = assetU > 0 ? btcU/assetU : 0;
    return `<div class="swbook-row">
      <span class="mono">${esc(C.fmtAtoms(asset, am.precision))} ${esc(am.ticker)}</span>
      <span class="sub">@ ${esc(trim(price))} BTC/${esc(am.ticker)}</span></div>`;
  }).join('');
  const dirLbl = payIsBtc ? `${esc(am.ticker)} for BTC` : `BTC for ${esc(am.ticker)}`;
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">Cross-chain order book · ${dirLbl}</span>
      <span class="sub">${offers.length} resting offer${offers.length===1?'':'s'}</span></div>
    ${rows || '<div class="sub" style="padding:6px 2px">No resting cross-chain offers yet — a market maker with BTC reserves needs to post one.</div>'}</div>`;
  renderMyOrders();
}

function paintQuoteCross(){
  const { $ } = C; const q = LAST_QUOTE; if (!q || q.kind !== 'cross') return;
  const sm = C.assetMeta(q.seqAsset);
  const seqStr = C.fmtAtoms(q.xq.seq_amount, sm.precision);
  const btcStr = C.fmtAtoms(q.xq.btc_amount, 8);
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
  const seqUnits = Number(q.xq.seq_amount) / Math.pow(10, sm.precision || 0);
  const btcUnits = Number(q.xq.btc_amount) / 1e8;
  if (btcUnits > 0) $('swRate').textContent = `1 BTC = ${trim(seqUnits / btcUnits)} ${sm.ticker} · cross-chain HTLC`;
  // Cross-chain "fee" is the maker fee in BTC (no open fee-asset market on the BTC leg).
  paintFee('BTC', q.xq.fee_btc, 'Maker fee, paid in BTC on the parent chain.');
  setFinality('cross');
}

// ---------------------------------------------------------------------------
// fee market (open: pay the network fee in any asset the node prices)
// ---------------------------------------------------------------------------
function paintFee(feeAssetHex, feeAtoms, noteOverride){
  const { $ } = C;
  const fm = C.assetMeta(feeAssetHex);
  $('swFeeTk').textContent = fm.ticker;
  $('swFeeAmt').textContent = (feeAtoms != null) ? (C.fmtAtoms(feeAtoms, fm.precision) + ' ' + fm.ticker) : '—';
  const ref = (feeAtoms != null) ? (C.refValueStr(feeAssetHex, feeAtoms) || '') : '';
  $('swFeeRef').textContent = ref;
  $('swFeeNote').textContent = noteOverride || 'Pay the fee in any asset the network prices.';
  // The fee picker is disabled for the cross-chain (BTC-only) leg.
  const cross = LAST_QUOTE && LAST_QUOTE.kind === 'cross';
  $('swFeePick').disabled = !!cross;
  $('swFeePick').style.opacity = cross ? '.5' : '';
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
  const fa = S.feeAsset || (S.payAsset ? defaultFeeAsset() : null);
  C.$('swFeeTk').textContent = fa ? C.assetMeta(fa).ticker : '—';
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
// finality line (anchor-aware; never "instant")
// ---------------------------------------------------------------------------
function setFinality(kind){
  const t = C.$('swFinText'); if (!t) return;
  t.textContent = kind === 'cross'
    ? 'Settles across both chains · the Sequentia leg is anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'
    : 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).';
}

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
  // If choosing the FIRST side (other unset), also let any tradable asset be picked.
  const list = candidates.map(hex => ({
    hex, ticker: C.assetMeta(hex).ticker, name: pickerName(hex), bal: balLine(hex),
    enabled: hex !== (side === 'pay' ? S.payAsset : S.receiveAsset),
  }));
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
    LAST_QUOTE = null; setReviewEnabled(false);
    paintPanes();
    requote().catch(()=>{});
  });
}
function pickerName(hex){ if (hex === 'BTC') return 'Bitcoin testnet4'; return C.assetMeta(hex).name || 'Asset'; }

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

  let kbdIdx = -1, shown = [];
  const draw = (q) => {
    listEl.innerHTML = ''; kbdIdx = -1;
    shown = items.filter(it => {
      if (!q) return true;
      const s = (it.ticker + ' ' + (it.name||'') + ' ' + it.hex).toLowerCase();
      return s.includes(q.toLowerCase());
    });
    if (!shown.length){ listEl.appendChild(el('div','swopt-empty','No matching assets.')); return; }
    shown.forEach((it, i) => {
      const b = el('button','swopt'); b.type = 'button'; b.setAttribute('role','option');
      if (!it.enabled){ b.disabled = true; }
      const t = el('span','swopt-tk', it.ticker);
      const mid = el('div','swopt-mid'); mid.appendChild(el('div','swopt-name', it.name || ''));
      const bal = el('div','swopt-bal');
      if (it.bal && it.bal.b) bal.appendChild(el('div','b', it.bal.b));
      if (it.bal && it.bal.r) bal.appendChild(el('div','r', it.bal.r));
      b.appendChild(t); b.appendChild(mid); b.appendChild(bal);
      b.onclick = () => { if (it.enabled){ onPick(it.hex); closePopover(); } };
      b.onmouseenter = () => { kbdIdx = i; markKbd(); };
      listEl.appendChild(b);
    });
  };
  const markKbd = () => {
    [...listEl.children].forEach((c,i)=>c.classList && c.classList.toggle('kbd', i===kbdIdx));
    const cur = listEl.children[kbdIdx]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block:'nearest' });
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
  if (q.kind === 'cross') return reviewCross(q);
  return reviewSame(q);
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
  } catch { $('swErr').textContent = `Enter both amounts — the ${am.ticker} and the BTC.`; return; }
  if (reverse){
    const haveBtc = balAtoms('BTC');
    if (btcSats > haveBtc){ $('swErr').textContent = `You only hold ${C.fmtAtoms(haveBtc, 8)} BTC.`; return; }
  } else {
    const have = balAtoms(assetHex);
    if (assetAtoms > have){ $('swErr').textContent = `You only hold ${C.fmtAtoms(have, am.precision)} ${am.ticker}.`; return; }
  }
  const assetU = Number(assetAtoms)/Math.pow(10, am.precision||0), btcU = Number(btcSats)/1e8;
  const kv = reverse ? [
    ['Posting', `A resting CROSS bid — you become the maker of the ${am.ticker}/BTC market`],
    ['You pay', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['You buy', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '—'],
    ['How it settles', 'You lock BTC in an HTLC; a taker locks the asset; you verify anchoring, claim the asset (revealing the secret); the taker claims your BTC. Atomic — anchor-bound.'],
    ['Keep this tab open', 'Cross-chain settlement is interactive: your wallet must be open to settle a lift. Closing it un-rests the offer; nothing is at risk (a stalled lock refunds after its timeout).'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ] : [
    ['Posting', `A resting CROSS offer — you become the maker of the ${am.ticker}/BTC market`],
    ['You sell', amtRow(assetHex, assetAtoms) + refSuffix(assetHex, assetAtoms)],
    ['You want', C.fmtAtoms(btcSats, 8) + ' BTC'],
    ['Price', assetU>0 ? `1 ${am.ticker} = ${trim(btcU/assetU)} BTC` : '—'],
    ['How it settles', 'A taker pays BTC; you lock the asset in an HTLC; they claim it revealing the secret; you claim the BTC. Atomic — anchor-bound.'],
    ['Keep this tab open', 'Cross-chain settlement is interactive: your wallet must be open to settle a lift. Closing it un-rests the offer; nothing is at risk.'],
    ['Finality', 'Anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: reverse ? 'Buy with BTC — start this market' : 'Sell for BTC — start this market', kv });
  if (ok) ok.textContent = reverse ? 'Post cross bid' : 'Post cross offer';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Signing + posting…';
    try {
      const recvAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
      const handle = await start({ assetHex, assetAtoms, btcSats, expirySecs: 3600, recvAddr }, onCrossMakeState);
      XMAKE = { handle, assetHex, assetAtoms, btcSats, reverse, offerId: handle.offer.offer_id, state: 'resting' };
      modal.remove();
      C.toast('Cross offer posted — live in the order book. Keep this tab open to settle.');
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
    resting:'Resting — waiting for a taker', terms:'A taker is lifting…', btc_locked:'You locked BTC — waiting for the taker to lock the asset…',
    seq_verified:'Asset locked — verifying anchoring…', settled:'Settled — you bought the asset for BTC',
    refunding:'Stalled — refunding your BTC…', refunded:'Refunded — the swap stalled; your BTC is back',
  } : {
    resting:'Resting — waiting for a taker', terms:'A taker is lifting…', btc_verified:'Taker funded BTC — locking your asset…',
    seq_locked:'Asset locked — waiting for the taker to claim…', secret_learned:'Taker claimed; claiming your BTC…',
    settled:'Settled — you sold the asset for BTC', refunded:'Refunded — the swap stalled; your asset is back',
  };
  const label = phases[XMAKE.state] || XMAKE.state;
  const done = XMAKE.state === 'settled' || XMAKE.state === 'refunded';
  const headline = XMAKE.reverse
    ? `Your resting cross bid · buy ${esc(C.fmtAtoms(XMAKE.assetAtoms, am.precision))} ${esc(am.ticker)} for ${esc(C.fmtAtoms(XMAKE.btcSats,8))} BTC`
    : `Your resting cross offer · sell ${esc(C.fmtAtoms(XMAKE.assetAtoms, am.precision))} ${esc(am.ticker)} for ${esc(C.fmtAtoms(XMAKE.btcSats,8))} BTC`;
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">${headline}</span>
      <span class="sub">${esc(label)}</span></div>
    <div class="swbook-row"><span class="sub">Keep this tab open to settle. </span>
      <button type="button" class="ghost" id="swXMakeCancel">${done ? 'Clear' : 'Cancel offer'}</button></div></div>`;
  const btn = C.$('swXMakeCancel');
  if (btn) btn.onclick = () => {
    try { XMAKE.handle && XMAKE.handle.close(); } catch {}
    XMAKE = null; host.innerHTML = ''; C.toast('Cross offer removed.'); renderSwap();
  };
}

async function reviewSame(q){
  const { $ } = C;
  if (q.startMarket) return postOfferReview(q);   // no resting liquidity -> start the market
  const fm = C.assetMeta(q.feeAsset);
  const kv = [
    ['Network', 'Sequentia (testnet) atomic swap via the order book; not parent-chain BTC'],
    ['You pay', amtRow(q.assetP, q.amountP) + refSuffix(q.assetP, q.amountP)],
    ['You receive', amtRow(q.assetR, q.amountR) + refSuffix(q.assetR, q.amountR)],
    ['Network fee', amtRow(q.feeAsset, q.feeAmount) + '  (estimate)'],
    ['Fee paid in', fm.ticker],
    ['Maker', short(q.offer && (q.offer.maker_pubkey || q.offer.makerPubkey))],
    ['Finality', 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
    ['Settlement', 'Atomic — settles in full or not at all.'],
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
  if (q.reverse){
    // Reverse (sell asset for BTC): the xrswap.js wizard takes over (its own review
    // modals, leg verification, fund/claim/poll, and localStorage resume).
    if (!X.openReverseFromComposer){ $('swErr').textContent = 'Selling an asset for BTC is unavailable in this build.'; return; }
    showReverse(true);
    X.openReverseFromComposer(q.xq);
    return;
  }
  // Forward (pay BTC, receive asset): the xswap.js wizard takes over.
  if (!X.openFromComposer){ $('swErr').textContent = 'Cross-chain route unavailable in this build.'; return; }
  showCross(true);
  X.openFromComposer(q.xq);   // seeds LAST_XQUOTE in xswap.js + renders the lock step
}

function resetComposer(){
  C.$('swPayAmt').value = ''; C.$('swRecvAmt').value = '';
  LAST_QUOTE = null; setReviewEnabled(false);
}

function amtRow(hex, atoms){ const m = C.assetMeta(hex); return C.fmtAtoms(atoms, m.precision) + ' ' + m.ticker; }
function refSuffix(hex, atoms){ const r = C.refValueStr(hex, atoms); return r ? ('  ('+r+')') : ''; }
function trim(n){ if (!isFinite(n)) return '—'; const s = (Math.round(n*1e8)/1e8).toString(); return s; }

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
  const receiveAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
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
  } catch { $('swErr').textContent = 'Enter both amounts — what you give and what you want — to start a market.'; return; }
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const payU = Number(payAtoms)/Math.pow(10, pm.precision||0), recvU = Number(recvAtoms)/Math.pow(10, rm.precision||0);
  const kv = [
    ['Posting', 'A resting offer — you become the maker of this market'],
    ['You give', amtRow(pay, payAtoms) + refSuffix(pay, payAtoms)],
    ['You want', amtRow(receive, recvAtoms) + refSuffix(receive, recvAtoms)],
    ['Price', payU>0 ? `1 ${pm.ticker} = ${trim(recvU/payU)} ${rm.ticker}` : '—'],
    ['Filling', 'A taker fills it from the other side. Filling needs you (the maker) online to co-sign; in-wallet co-sign is coming, so for now the offer rests publicly and you can cancel it anytime.'],
    ['Expires', 'In 1 hour (re-post to refresh).'],
    ['Finality', 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Start this market', kv });
  if (ok) ok.textContent = 'Post offer';
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Signing + posting…';
    try {
      const recvAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
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
        same_chain: { maker_recv_address: recvAddr },
      };
      seqob.signOffer(offer, makerPriv());
      await seqob.postOffer(offer);
      modal.remove();
      C.toast('Offer posted — your market is live in the order book.');
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

function renderBook(pay, receive){
  const host = C.$('swBook'); if (!host) return;
  const offers = BOOK.offers || [];
  const pm = C.assetMeta(pay), rm = C.assetMeta(receive);
  const rows = offers.slice(0, 12).map(o => {
    const offerAmt = big(o.offer_amount||o.offerAmount), wantAmt = big(o.want_amount||o.wantAmount);
    const recvU = Number(offerAmt)/Math.pow(10, rm.precision||0), payU = Number(wantAmt)/Math.pow(10, pm.precision||0);
    const price = payU > 0 ? recvU/payU : 0;
    return `<button type="button" class="swbook-row" data-id="${esc(o.offer_id||o.offerId)}" data-maker="${esc(o.maker_pubkey||o.makerPubkey)}">
      <span class="mono">${esc(C.fmtAtoms(offerAmt, rm.precision))} ${esc(rm.ticker)}</span>
      <span class="sub">@ ${esc(trim(price))} ${esc(rm.ticker)}/${esc(pm.ticker)}</span></button>`;
  }).join('');
  host.innerHTML = `<div class="swbook"><div class="swbook-head">
      <span class="lbl">Order book · ${esc(rm.ticker)} for ${esc(pm.ticker)}</span>
      <span class="sub">${offers.length} resting offer${offers.length===1?'':'s'}</span></div>
    ${rows || '<div class="sub" style="padding:6px 2px">No resting offers — enter an amount and Review to start this market.</div>'}</div>`;
  host.querySelectorAll('.swbook-row').forEach(b => b.onclick = () => fillFromOffer(b.dataset.id, b.dataset.maker, pay, receive));
  renderMyOrders();
}

function fillFromOffer(id, maker, pay, receive){
  const o = (BOOK.offers||[]).find(x => (x.offer_id||x.offerId) === id && (x.maker_pubkey||x.makerPubkey) === maker);
  if (!o) return;
  const offerAmt = big(o.offer_amount||o.offerAmount);
  S.edited = 'receive';
  C.$('swRecvAmt').value = C.fmtAtoms(offerAmt, C.assetMeta(receive).precision||0);
  LAST_QUOTE = executableQuote(o, pay, receive, receive, offerAmt);
  C.$('swPayAmt').value = C.fmtAtoms(LAST_QUOTE.amountP, C.assetMeta(pay).precision||0);
  paintQuoteSame();
  setReviewEnabled(true);
}

async function renderMyOrders(){
  const host = C.$('swMyOrders'); if (!host) return;
  if (XMAKE) return renderXMake();   // a live wallet cross offer owns this panel

  let orders = [];
  try { orders = await seqob.fetchMyOrders(makerPubHex()); } catch { host.innerHTML = ''; return; }
  if (!orders.length){ host.innerHTML = ''; return; }
  const rows = orders.map(o => {
    const give = C.assetMeta(o.offer_asset||o.offerAsset), want = C.assetMeta(o.want_asset||o.wantAsset);
    return `<div class="swbook-row myorder">
      <span class="mono">give ${esc(C.fmtAtoms(big(o.offer_amount||o.offerAmount), give.precision))} ${esc(give.ticker)} · want ${esc(C.fmtAtoms(big(o.want_amount||o.wantAmount), want.precision))} ${esc(want.ticker)}</span>
      <button type="button" class="ghost swcancel" data-id="${esc(o.offer_id||o.offerId)}">Cancel</button></div>`;
  }).join('');
  host.innerHTML = `<div class="swbook"><div class="swbook-head"><span class="lbl">Your resting orders</span>
      <span class="sub">co-sign coming; offers rest until then</span></div>${rows}</div>`;
  host.querySelectorAll('.swcancel').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Cancelling…';
    try { await seqob.signAndCancel(b.dataset.id, makerPriv()); renderSwap(); }
    catch (e){ b.disabled = false; b.textContent = 'Cancel'; C.toast('Cancel failed: ' + C.prettyErr(e)); }
  });
}

function randId(){
  const a = new Uint8Array(8); (crypto || window.crypto).getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2,'0')).join('');
}

// ---------------------------------------------------------------------------
// PSET bip32 / global-xpub stripper.  (UNCHANGED — verified byte-exact.)
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
  state: S,
};
