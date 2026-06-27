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

let C = null;            // injected app context (see index.html initSwapTab)
let X = null;            // the cross-chain route handle ({ openFromComposer, renderXswap, hasInFlight })
let MARKETS = [];        // same-chain: [{ market:{base_asset,quote_asset}, fee }]
let XMARKETS = [];       // cross-chain: [{ btc_asset, seq_asset, ... }] (BTC<->asset)
let LAST_QUOTE = null;   // the priced/oriented same-chain legs for the current composer state

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
  for (const m of MARKETS){
    const b = m.market.base_asset, q = m.market.quote_asset;
    if (b === other) set.add(q);
    if (q === other) set.add(b);
  }
  for (const xm of XMARKETS){
    // BTC <-> seq_asset is a tradable pair in both directions.
    if (other === 'BTC') set.add(xm.seq_asset);
    if (other === xm.seq_asset) set.add('BTC');
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
    const xm = XMARKETS.find(m => m.seq_asset === seqAsset);
    if (!xm) return null;
    // The daemon's cross-chain MVP only offers taker BUYS asset paying BTC, i.e.
    // pay=BTC, receive=asset. (We still let the user flip; we just label the
    // unsupported direction when routing.)
    return { kind: 'cross', xm, payIsBtc: pay === 'BTC' };
  }
  // Same-chain: find the market and the TradeType that yields pay->receive.
  for (const m of MARKETS){
    const b = m.market.base_asset, q = m.market.quote_asset;
    if (b === pay && q === receive)      return { kind: 'same', m, side: 'SELL' }; // sell base, receive quote
    if (q === pay && b === receive)      return { kind: 'same', m, side: 'BUY'  }; // buy base, pay quote
  }
  return null;
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
    : 'Same-chain · SeqDEX maker';
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
  if (!route){ setReviewEnabled(false); clearOpposite(); return; }
  const amtStr = typedAmount(S.edited);
  if (!amtStr || amtStr === '0'){ clearOpposite(); setReviewEnabled(false); return; }

  if (route.kind === 'cross') return requoteCross(route, amtStr);
  return requoteSame(route, amtStr);
}

function clearOpposite(){
  const other = S.edited === 'pay' ? C.$('swRecvAmt') : C.$('swPayAmt');
  // Don't stomp a value the user is actively typing on the OTHER side.
  if (document.activeElement !== other) other.value = '';
}
function setReviewEnabled(on){ const b = C.$('swReview'); if (b) b.disabled = !on; }

// --- same-chain quote (PreviewTrade) ---
async function requoteSame(route, amtStr){
  const { $ } = C;
  const m = route.m, side = route.side, base = m.market.base_asset, quote = m.market.quote_asset;
  // PreviewTrade is parameterised by the BASE leg amount. Depending on which side
  // the user typed (pay vs receive) and the side (BUY/SELL), the base leg is
  // either the typed amount or the OTHER amount. We can always express the typed
  // amount as the base leg when it IS the base asset; otherwise we quote off the
  // base asset using whichever side carries it.
  // Map: SELL => pay=base, receive=quote.  BUY => pay=quote, receive=base.
  const editedAsset = S.edited === 'pay' ? S.payAsset : S.receiveAsset;
  let baseAtoms, anchoredOnBase;
  try {
    const editedPrec = C.assetMeta(editedAsset).precision || 0;
    const editedAtoms = C.parseAtoms(amtStr, editedPrec);
    if (editedAtoms <= 0n) throw new Error('enter an amount greater than zero');
    if (editedAsset === base){ baseAtoms = editedAtoms; anchoredOnBase = true; }
    else { baseAtoms = null; anchoredOnBase = false; } // need a price to convert the quote-leg input to base
  } catch (e){ $('swErr').textContent = e.message || String(e); setReviewEnabled(false); return; }

  const status = $('swStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Quoting…';
  try {
    // Lazily pick a neutral fee asset (the one you're paying with) the first time we
    // actually quote — no asset is defaulted up front. Persist it so chip/review agree.
    if (!S.feeAsset) S.feeAsset = defaultFeeAsset();
    const feeAsset = S.feeAsset;
    // When the user typed the QUOTE-leg amount, first get the market price to
    // convert it into a base-leg amount the preview can take.
    if (!anchoredOnBase){
      const priced = await dexPost('/v1/market/price', {
        market: { base_asset: base, quote_asset: quote }, fee_asset: feeAsset,
      });
      const sp = pick(priced, 'spot_price', 'spotPrice') || priced;
      // base_price = quote units per 1 base (string). Convert typed quote -> base.
      const bp = Number(pick(sp, 'base_price', 'basePrice') || 0);
      if (!(bp > 0)) throw new Error('no price for this market yet');
      const editedAtoms = C.parseAtoms(amtStr, C.assetMeta(editedAsset).precision || 0);
      const basePrec = C.assetMeta(base).precision || 0, quotePrec = C.assetMeta(quote).precision || 0;
      const quoteUnits = Number(editedAtoms) / Math.pow(10, quotePrec);
      const baseUnits = quoteUnits / bp;
      baseAtoms = BigInt(Math.max(1, Math.round(baseUnits * Math.pow(10, basePrec))));
    }
    const prev = await dexPost('/v1/trade/preview', {
      market: { base_asset: base, quote_asset: quote },
      type: TRADE_TYPE[side], amount: baseAtoms.toString(), asset: base, fee_asset: feeAsset,
    });
    const p = (prev.previews && prev.previews[0]) || null;
    if (!p) throw new Error('no preview returned for this market/amount');
    const legs = orientLegs(m, side, baseAtoms, p);
    const price = pick(p, 'price') || null;
    LAST_QUOTE = { kind:'same', market: m.market, side, ...legs,
      feeAsset: pick(p, 'fee_asset', 'feeAsset') || feeAsset,
      feeAmount: big(pick(p, 'fee_amount', 'feeAmount') || 0),
      price: price ? { base_price: pick(price,'base_price','basePrice'), quote_price: pick(price,'quote_price','quotePrice') } : null };
    status.textContent = '';
    paintQuoteSame();
    setReviewEnabled(true);
  } catch (e){
    status.textContent = '';
    $('swErr').textContent = 'Quote failed: ' + (e.message || e);
    setReviewEnabled(false);
  }
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
    $('swRate').textContent = `1 ${pm.ticker} = ${trim(r)} ${rm.ticker} · SeqDEX maker`;
  }
  paintFee(q.feeAsset, q.feeAmount);
  setFinality('same');
}

// --- cross-chain quote (GetXchainQuote) ---
async function requoteCross(route, amtStr){
  const { $ } = C;
  if (!X || !X.quote){ $('swErr').textContent = 'Cross-chain route unavailable in this build.'; setReviewEnabled(false); return; }
  // Both directions are quoted on the SEQ-asset amount (the daemon prices in
  // seq_amount): forward = pay BTC, receive asset; reverse = sell asset for BTC.
  const seqAsset = route.xm.seq_asset;
  const seqPrec = C.assetMeta(seqAsset).precision || 0;
  const editedIsSeq = (S.edited === 'pay' ? S.payAsset : S.receiveAsset) === seqAsset;
  const status = $('swStatus'); status.className = 'status'; status.innerHTML = '<span class="spin"></span>Quoting…';
  try {
    let seqAtoms;
    if (editedIsSeq){
      seqAtoms = C.parseAtoms(amtStr, seqPrec);
    } else {
      // The user typed BTC; convert to a seq_amount via the market price, then quote.
      const btcUnits = Number(C.parseAtoms(amtStr, 8)) / 1e8;
      const seqPerBtc = route.xm.price_seq_per_btc || 0;
      if (!(seqPerBtc > 0)) throw new Error('no cross-chain price yet');
      seqAtoms = BigInt(Math.max(1, Math.round(btcUnits * 1e8 * seqPerBtc)));   // seq-atoms per btc-atom
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
    $('swErr').textContent = 'Quote failed: ' + (e.message || e);
    setReviewEnabled(false);
  }
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
  if (q.kind === 'cross') return reviewCross(q);
  return reviewSame(q);
}

async function reviewSame(q){
  const { $ } = C;
  const pm = C.assetMeta(q.assetP), rm = C.assetMeta(q.assetR), fm = C.assetMeta(q.feeAsset);
  const kv = [
    ['Network', 'Sequentia (testnet) atomic swap; not parent-chain BTC'],
    ['You pay', amtRow(q.assetP, q.amountP) + refSuffix(q.assetP, q.amountP)],
    ['You receive', amtRow(q.assetR, q.amountR) + refSuffix(q.assetR, q.amountR)],
    ['Network fee', amtRow(q.feeAsset, q.feeAmount)],
    ['Fee paid in', fm.ticker],
    ['Finality', 'Settles in ~1 block · anchor-bound to Bitcoin (reverts only if Bitcoin reverts).'],
    ['Settlement', 'Atomic — settles in full or not at all.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Review swap', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Proposing…';
    try {
      const txid = await proposeSignComplete(q, st);
      modal.remove();
      C.toast('Swap settled (anchor-bound; reverts only if Bitcoin reverts):', {href:'/tx/'+txid, label:String(txid).slice(0,18)+'…'});
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
async function proposeSignComplete(q, st){
  const { wasm } = C;
  const receiveAddr = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const sreq = C.wollet.seqdexSwapRequest(
    new wasm.AssetId(q.assetP), q.amountP,
    new wasm.AssetId(q.assetR), q.amountR,
    receiveAddr,
    new wasm.AssetId(q.feeAsset), q.feeAmount,
  );
  st.innerHTML = '<span class="spin"></span>Proposing…';
  const propose = await dexPost('/v1/trade/propose', {
    market: { base_asset: q.market.base_asset, quote_asset: q.market.quote_asset },
    type: TRADE_TYPE[q.side],
    swap_request: sreq.toJson(),
    fee_amount: q.feeAmount.toString(),
    fee_asset: q.feeAsset,
  });
  const fail = pick(propose, 'swap_fail', 'swapFail');
  if (fail) throw new Error('Provider rejected the swap: ' + (pick(fail,'failure_message','failureMessage') || 'unknown reason'));
  const accept = pick(propose, 'swap_accept', 'swapAccept');
  const acceptTx = accept && pick(accept, 'transaction');
  if (!acceptTx) throw new Error('no SwapAccept returned');
  const acceptId = pick(accept, 'id');

  st.innerHTML = '<span class="spin"></span>Signing…';
  const pset = new wasm.Pset(acceptTx);
  pset.addDetails(C.wollet);
  const signed = C.signer.sign(pset);
  const strippedB64 = stripBip32(signed.toString());

  st.innerHTML = '<span class="spin"></span>Completing…';
  try {
    const done = await dexPost('/v1/trade/complete', {
      swap_complete: { id: randId(), accept_id: acceptId, transaction: strippedB64 },
    });
    const cfail = pick(done, 'swap_fail', 'swapFail');
    if (cfail) throw new Error(pick(cfail,'failure_message','failureMessage') || 'CompleteTrade failed');
    const txid = pick(done, 'txid');
    if (txid) return txid;
    throw new Error('CompleteTrade returned no txid');
  } catch (e){
    st.innerHTML = '<span class="spin"></span>Self-broadcasting…';
    const finalPset = new wasm.Pset(strippedB64);
    const finalized = C.wollet.finalize(finalPset);
    const txid = await C.client.broadcast(finalized);
    return txid.toString ? txid.toString() : String(txid);
  }
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
export const __test__ = { proposeSignComplete, stripBip32, dexPost,
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
