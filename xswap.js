// ---------------------------------------------------------------------------
// SeqDEX CROSS-CHAIN (BTC <-> SEQ-asset) swap wizard (Phase 6d-2).
//
// A self-contained module — a sibling of swap.js (same-chain) and btc.js (the
// Bitcoin testnet4 layer) — wired once by the main wallet via initXswap(ctx).
// It drives the daemon's stateful cross-chain swap maker (seqdex.v1
// XchainService, served as REST `/v1/xchain/*` on the one-port daemon).
//
// MVP direction (the only one the daemon offers): the taker BUYS a SEQ asset,
// paying BTC. The taker is the INITIATOR and locks the BTC leg first, so the
// BTC-leg-first ordering rule and the anchor-shortened SEQ confirmation hold.
//
// A 7-step stepper mirrors XchainSwapState
//   QUOTED -> PENDING_BTC_LOCK -> SEQ_LOCKED -> SEQ_CLAIMED -> BTC_CLAIMED
// with REFUNDED/FAILED as terminal off-ramps:
//   1. Quote      GetXchainQuote{seq_asset,seq_amount} -> amounts, maker
//                 pubkeys, T_btc > T_seq, expiry (+ live countdown).
//   2. Lock BTC   generateSwapSecret() -> s,H; Signer.htlcKeypair() -> the
//                 taker's SEQ-claim key; a btc.js HD key -> the taker's
//                 BTC-refund key; build the BTC-leg HTLC redeemScript via the
//                 binding (claim=maker w/ s, refund=taker after T_btc); fund the
//                 P2SH on the Bitcoin chain via btc.js; confirm.
//   3. Propose    ProposeXchainSwap{quote_id,hash,btc_leg,taker pubkeys} ->
//                 XchainSwapAccepted{swap_id, seq_leg{...}} | XchainSwapFail.
//   4. Anchor     MANDATORY gate: verify seq_leg.anchor_height >= btc_leg.height
//                 (and surface the node's anchorstatus). No auto-advance.
//   5. Claim SEQ  buildSeqHtlcClaimTx(spend, redeem_script, claim_secret, s) ->
//                 broadcast via the wallet's Sequentia esplora. Reveals s.
//   6. Done/poll  GetXchainSwap{swap_id} on a setInterval until BTC_CLAIMED.
//   7. Refund     off-ramp: after T_btc, refund the BTC leg via btc.js (the
//                 ELSE/CLTV branch) — a Bitcoin tx, not the SEQ binding.
//
// Swap state (secret, swap_id, legs, timeouts) is persisted to localStorage so
// a page reload can still claim or refund — essential for a time-sensitive
// cross-chain swap.
//
// Project UI rules honoured here (same as swap.js):
//  • SEQ equal standing — the SEQ asset is shown by its `assetMeta` ticker, no
//    privileged "native" hero; BTC is the parent-chain leg, labelled as such.
//  • Reference currency — amounts carry an `≈ <ref>` hint where priced.
//  • Anchor-aware finality — the anchor gate + success copy say the Sequentia leg is
//    bound to a Bitcoin block and can reorg only if Bitcoin does (never
//    "instant/irreversible").
//
// THE BTC-LEG WRINKLE (see also the verify harness): in production the BTC leg
// is a real Bitcoin testnet4 tx built/funded/refunded by btc.js. For headless
// regtest verification the parent "BTC" chain is an Elements-mode regtest node
// whose tx serialization btc.js (a Bitcoin signer) cannot speak, so the harness
// injects a `btcLeg` funder/refunder shim via ctx that funds the SAME HTLC P2SH
// on the parent node by RPC. The HTLC redeemScript is built by the wizard's
// binding path in BOTH cases, so the daemon's byte-for-byte script check passes
// identically. The browser path uses C.btcLeg (wired from btc.js in index.html).
// ---------------------------------------------------------------------------

let C = null;            // the injected app context (see index.html initXswapTab)
let XMARKETS = [];       // [{ btc_asset, seq_asset, name, seq_reserve, btc_reserve, price_seq_per_btc }]
let LAST_XQUOTE = null;  // the live quote for the selected market+amount
let SWAP = null;         // the persisted in-flight swap (see loadSwap/saveSwap)
let POLL = null;         // setInterval handle for the GetXchainSwap poll
let COUNTDOWN = null;    // setInterval handle for the quote-expiry countdown

const LS_KEY = 'swk.sequentia.xswap';   // localStorage key for the in-flight swap

// Stepper states — the FULL proto enum names the grpc-gateway emits.
const ST = {
  QUOTED:     'QUOTED',                            // local-only (pre-propose)
  PENDING:    'XCHAIN_SWAP_STATE_PENDING_BTC_LOCK',
  SEQ_LOCKED: 'XCHAIN_SWAP_STATE_SEQ_LOCKED',
  SEQ_CLAIMED:'XCHAIN_SWAP_STATE_SEQ_CLAIMED',
  BTC_CLAIMED:'XCHAIN_SWAP_STATE_BTC_CLAIMED',
  REFUNDED:   'XCHAIN_SWAP_STATE_REFUNDED',
  FAILED:     'XCHAIN_SWAP_STATE_FAILED',
};

// POST <DEX>/v1/xchain/... as JSON; returns parsed JSON (or throws a useful
// message). Identical contract to swap.js's dexPost, against the cross-chain
// base (which may differ from the same-chain one — see ctx.XDEX).
async function dexPost(path, body){
  const r = await fetch(C.XDEX + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { _raw: txt }; }
  if (!r.ok) {
    // grpc-gateway errors (incl. quote/swap NotFound) come back as {code,message}.
    const msg = (j && (j.message || j.error)) || j._raw || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return j;
}

// The gateway emits camelCase but accepts snake_case on input; read a field by
// EITHER form so the wizard is robust to the marshaler. uint64/int64 come back
// as JSON strings, uint32 as numbers (see the API notes).
function pick(obj, ...names){
  if (!obj) return undefined;
  for (const n of names){ if (obj[n] !== undefined) return obj[n]; }
  return undefined;
}
const big = v => BigInt(v == null ? 0 : v);
const num = v => (v == null ? 0 : Number(v));

// Normalize a market entry (camel or snake) to the snake_case the module uses.
function normMarket(m){
  return {
    btc_asset:        pick(m, 'btc_asset', 'btcAsset') || '',
    seq_asset:        pick(m, 'seq_asset', 'seqAsset'),
    name:             pick(m, 'name') || 'BTC / Sequentia asset',
    seq_reserve:      big(pick(m, 'seq_reserve', 'seqReserve')),
    btc_reserve:      big(pick(m, 'btc_reserve', 'btcReserve')),
    price_seq_per_btc: num(pick(m, 'price_seq_per_btc', 'priceSeqPerBtc')),
  };
}
// Normalize a seq_leg (camel or snake).
function normSeqLeg(l){
  if (!l) return null;
  return {
    txid:          pick(l, 'txid'),
    vout:          num(pick(l, 'vout')),
    block_hash:    pick(l, 'block_hash', 'blockHash'),
    anchor_height: Number(pick(l, 'anchor_height', 'anchorHeight') ?? -1),
    redeem_script: pick(l, 'redeem_script', 'redeemScript'),
    amount:        big(pick(l, 'amount')),
    asset_id:      pick(l, 'asset_id', 'assetId'),
  };
}

// ---- localStorage persistence (essential for a time-sensitive swap) ----
// We persist everything needed to resume a claim OR a refund across reloads:
// the secret + keys, both legs, the timeouts, the maker pubkeys and the state.
function saveSwap(){
  try {
    if (!SWAP){ localStorage.removeItem(LS_KEY); return; }
    // BigInt isn't JSON-serializable; store amounts as decimal strings.
    const ser = JSON.parse(JSON.stringify(SWAP, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    localStorage.setItem(LS_KEY, JSON.stringify(ser));
  } catch (e){ /* best-effort; a quota/serialization error must not break the UI */ }
}
function loadSwap(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) { SWAP = null; return; }
    const s = JSON.parse(raw);
    // Re-hydrate the amount fields we treat as BigInt.
    if (s.btc_amount != null) s.btc_amount = big(s.btc_amount);
    if (s.seq_amount != null) s.seq_amount = big(s.seq_amount);
    if (s.fee_btc != null)    s.fee_btc = big(s.fee_btc);
    if (s.seq_leg)            s.seq_leg.amount = big(s.seq_leg.amount);
    if (s.btc_leg)            s.btc_leg.amount = big(s.btc_leg.amount);
    SWAP = s;
  } catch (e){ SWAP = null; }
}
function clearSwap(){ SWAP = null; saveSwap(); }

export function initXswap(ctx){
  C = ctx;
  const { $ } = C;
  if ($ && $('btnXswapQuote') && !$('btnXswapQuote')._wired){
    $('btnXswapQuote')._wired = true;
    $('btnXswapQuote').onclick = onQuote;
    $('btnXLockBtc') && ($('btnXLockBtc').onclick = onLockBtc);
    $('btnXPropose') && ($('btnXPropose').onclick = onPropose);
    $('btnXClaim')   && ($('btnXClaim').onclick   = onClaimSeq);
    $('btnXRefund')  && ($('btnXRefund').onclick  = onRefundBtc);
    $('btnXAbandon') && ($('btnXAbandon').onclick = onAbandon);
    $('xMarket') && ($('xMarket').onchange = () => { resetQuote(); updateAmtLabel(); });
    // Reference-currency hint under the amount (denominated in the SEQ asset bought).
    if (C.attachRefHint && $('xAmount')) C.attachRefHint($('xAmount'), () => amountAsset());
  }
}

// ---------------------------------------------------------------------------
// Composer bridge (Phase 6d-3): the symmetric Pay->Receive composer in swap.js
// is the single entry point. It discovers BTC<->asset markets and gets a quote
// through these thin exports, then hands the priced quote to openFromComposer(),
// which seeds LAST_XQUOTE and shows the live wizard stepper. All the proven
// internals (lock/propose/anchor gate/claim/poll, localStorage resume) are reused
// untouched — only the quote FORM is bypassed (the composer replaces it).
// ---------------------------------------------------------------------------
export async function fetchXmarkets(){
  const resp = await dexPost('/v1/xchain/markets', {});
  XMARKETS = (Array.isArray(pick(resp, 'markets')) ? pick(resp, 'markets') : []).map(normMarket);
  return XMARKETS;
}
// Get a cross-chain quote for `seqAtoms` of `seqAsset`. Returns the SAME normalized
// quote object the form's onQuote builds (incl. the T_btc>T_seq ordering check),
// so openFromComposer can drive the rest of the wizard identically.
export async function fetchXquote(seqAsset, seqAtoms){
  const market = XMARKETS.find(m => m.seq_asset === seqAsset);
  const resp = await dexPost('/v1/xchain/quote', { seq_asset: seqAsset, seq_amount: String(seqAtoms) });
  const q = {
    market: market || { btc_asset:'', seq_asset:seqAsset, name:'BTC / Sequentia asset', price_seq_per_btc:0 },
    quote_id:            pick(resp, 'quote_id', 'quoteId'),
    seq_amount:          big(pick(resp, 'seq_amount', 'seqAmount')),
    btc_amount:          big(pick(resp, 'btc_amount', 'btcAmount')),
    price_seq_per_btc:   num(pick(resp, 'price_seq_per_btc', 'priceSeqPerBtc')),
    fee_btc:             big(pick(resp, 'fee_btc', 'feeBtc')),
    maker_btc_claim_pub: pick(resp, 'maker_btc_claim_pub', 'makerBtcClaimPub'),
    maker_seq_refund_pub:pick(resp, 'maker_seq_refund_pub', 'makerSeqRefundPub'),
    btc_locktime:        num(pick(resp, 'btc_locktime', 'btcLocktime')),
    seq_locktime:        num(pick(resp, 'seq_locktime', 'seqLocktime')),
    expires_at_unix:     Number(pick(resp, 'expires_at_unix', 'expiresAtUnix') || 0),
  };
  if (!(q.btc_locktime > q.seq_locktime))
    throw new Error(`maker returned a bad ordering: T_btc(${q.btc_locktime}) must exceed T_seq(${q.seq_locktime})`);
  return q;
}
// Seed the wizard with a composer-supplied quote and show the lock step. The
// stepper host (#xStepper) + the lock review modal (onLockBtc) take over from here.
export function openFromComposer(q){
  LAST_XQUOTE = q;
  if (!XMARKETS.length && q && q.market) XMARKETS = [q.market];
  // No in-flight swap yet → renderStepper shows nothing; we drive the lock review
  // directly (the composer already showed the quote, so we go straight to "lock").
  renderStepper();
  startCountdown();
  onLockBtc();
}
// True when a cross-chain swap is persisted and not terminal — the composer uses
// this to resume the stepper instead of showing the composer on tab entry.
export function hasInFlight(){
  loadSwap();
  if (!SWAP) return false;
  return SWAP.state !== ST.BTC_CLAIMED && SWAP.state !== ST.REFUNDED && SWAP.state !== ST.FAILED;
}

function selMarket(){
  const sel = C.$('xMarket'); if (!sel || !XMARKETS.length) return null;
  return XMARKETS[sel.selectedIndex] || XMARKETS[0];
}
// Never return null: the shared attachRefHint values this immediately at attach
// time (before markets load) and assetMeta(null) would throw — '' is safe.
function amountAsset(){ const m = selMarket(); return m ? m.seq_asset : ''; }
function updateAmtLabel(){
  const m = selMarket(), lbl = C.$('xAmtLbl'); if (!lbl) return;
  if (!m){ lbl.textContent = 'Amount to buy'; return; }
  lbl.textContent = 'Amount to buy (' + C.assetMeta(m.seq_asset).ticker + ')';
}

function resetQuote(){
  LAST_XQUOTE = null;
  if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; }
  const q = C.$('xQuoteBox'); if (q) q.classList.add('hide');
  const e = C.$('xswapErr'); if (e) e.textContent = '';
}

// ---- markets ----
export async function renderXswap(){
  const { $ } = C;
  if (!C.wollet) return;
  loadSwap();
  const status = $('xswapStatus');
  if (status){ status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading cross-chain markets…'; }
  try {
    const resp = await dexPost('/v1/xchain/markets', {});
    XMARKETS = (Array.isArray(pick(resp, 'markets')) ? pick(resp, 'markets') : []).map(normMarket);
    if (status) status.textContent = '';
    populateMarketSelect();
    renderMarketList();
    updateAmtLabel();
  } catch (e) {
    if (status){ status.className = 'status err'; status.textContent = 'Could not load cross-chain markets: ' + (e?.message ?? e); }
    XMARKETS = [];
    populateMarketSelect();
    renderMarketList();
  }
  // If a swap is in flight (persisted), show its stepper; otherwise the quote form.
  renderStepper();
}

function marketLabel(m){
  // "BTC / <SEQ ticker>" — BTC is the parent-chain leg; the SEQ asset is shown
  // by its registry ticker (equal standing, no privileged name).
  return 'BTC / ' + C.assetMeta(m.seq_asset).ticker;
}
function populateMarketSelect(){
  const { $, el } = C;
  const sel = $('xMarket'); if (!sel) return;
  const prev = sel.value; sel.innerHTML = '';
  if (!XMARKETS.length){ const o = el('option'); o.value=''; o.textContent='No cross-chain markets'; sel.appendChild(o); return; }
  XMARKETS.forEach((m, idx) => { const o = el('option'); o.value = String(idx); o.textContent = marketLabel(m); sel.appendChild(o); });
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}
function renderMarketList(){
  const { $, el } = C;
  const list = $('xMarketList'); if (!list) return;
  list.innerHTML = '';
  if (!XMARKETS.length){ list.appendChild(el('div','muted','No cross-chain markets on this provider.')); return; }
  for (const m of XMARKETS){
    const row = el('div','asset-row');
    row.appendChild(el('span','tk', marketLabel(m)));
    const mid = el('div','grow');
    const sm = C.assetMeta(m.seq_asset);
    mid.appendChild(el('div','sub',
      `maker reserve ${C.fmtAtoms(m.seq_reserve, sm.precision)} ${sm.ticker} · price ${m.price_seq_per_btc} ${sm.ticker}-atoms per BTC-atom`));
    row.appendChild(mid);
    list.appendChild(row);
  }
}

// ---- step 1: quote ----
async function onQuote(){
  const { $ } = C;
  $('xswapErr').textContent = '';
  const m = selMarket();
  if (!m){ $('xswapErr').textContent = 'select a market'; return; }
  let amtAtoms;
  try {
    const amtStr = ($('xAmount').value || '').trim();
    amtAtoms = C.parseAtoms(amtStr, C.assetMeta(m.seq_asset).precision || 0);
    if (amtAtoms <= 0n) throw new Error('enter an amount greater than zero');
  } catch (e){ $('xswapErr').textContent = e?.message ?? String(e); return; }

  const status = $('xswapStatus');
  status.className = 'status'; status.innerHTML = '<span class="spin"></span>Quoting…';
  try {
    const resp = await dexPost('/v1/xchain/quote', { seq_asset: m.seq_asset, seq_amount: amtAtoms.toString() });
    LAST_XQUOTE = {
      market: m,
      quote_id:            pick(resp, 'quote_id', 'quoteId'),
      seq_amount:          big(pick(resp, 'seq_amount', 'seqAmount')),
      btc_amount:          big(pick(resp, 'btc_amount', 'btcAmount')),
      price_seq_per_btc:   num(pick(resp, 'price_seq_per_btc', 'priceSeqPerBtc')),
      fee_btc:             big(pick(resp, 'fee_btc', 'feeBtc')),
      maker_btc_claim_pub: pick(resp, 'maker_btc_claim_pub', 'makerBtcClaimPub'),
      maker_seq_refund_pub:pick(resp, 'maker_seq_refund_pub', 'makerSeqRefundPub'),
      btc_locktime:        num(pick(resp, 'btc_locktime', 'btcLocktime')),
      seq_locktime:        num(pick(resp, 'seq_locktime', 'seqLocktime')),
      expires_at_unix:     Number(pick(resp, 'expires_at_unix', 'expiresAtUnix') || 0),
    };
    // The ordering invariant the whole mechanism rests on: T_btc > T_seq.
    if (!(LAST_XQUOTE.btc_locktime > LAST_XQUOTE.seq_locktime))
      throw new Error(`maker returned a bad ordering: T_btc(${LAST_XQUOTE.btc_locktime}) must exceed T_seq(${LAST_XQUOTE.seq_locktime})`);
    status.textContent = '';
    showQuote();
  } catch (e){
    status.textContent = '';
    $('xswapErr').textContent = 'Quote failed: ' + (e?.message ?? e);
  }
}

function showQuote(){
  const { $ } = C; const q = LAST_XQUOTE; if (!$('xQuoteBox')) return;
  const sm = C.assetMeta(q.market.seq_asset);
  $('xQuoteBox').classList.remove('hide');
  $('xQBuy').textContent = C.fmtAtoms(q.seq_amount, sm.precision) + ' ' + sm.ticker;
  $('xQBuyRef').textContent = (C.refValueStr && C.refValueStr(q.market.seq_asset, q.seq_amount)) || '';
  $('xQPay').textContent = C.fmtAtoms(q.btc_amount, 8) + ' BTC';
  $('xQPayRef').textContent = (C.refValueStr && C.refValueStr('BTC', q.btc_amount)) || '';
  $('xQFee').textContent = C.fmtAtoms(q.fee_btc, 8) + ' BTC';
  $('xQTimeouts').textContent = `T_btc=${q.btc_locktime} (you refund BTC) · T_seq=${q.seq_locktime} (maker refunds on Sequentia)`;
  startCountdown();
  $('btnXLockBtc') && $('btnXLockBtc').classList.remove('hide');
}
function startCountdown(){
  const { $ } = C; const el = $('xQExpiry'); if (!el) return;
  if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; }
  const tick = () => {
    if (!LAST_XQUOTE || !LAST_XQUOTE.expires_at_unix){ el.textContent = ''; return; }
    const secs = LAST_XQUOTE.expires_at_unix - Math.floor(Date.now()/1000);
    if (secs <= 0){ el.textContent = 'Quote expired — get a fresh quote.'; el.className = 'sub err';
      if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; } return; }
    el.className = 'sub'; el.textContent = `Quote valid for ${secs}s`;
  };
  tick(); COUNTDOWN = setInterval(tick, 1000);
}

// ---- step 2: lock the BTC leg ----
// Build the swap secret + the taker's two keys, the BTC-leg HTLC redeemScript
// (via the binding — byte-identical to the daemon's recompute), then FUND its
// P2SH on the Bitcoin chain via btc.js (or the injected harness shim) and wait
// for the agreed confirmations. Captures {txid,vout,height,redeem_script}.
async function lockBtcLeg(q){
  const { wasm } = C;
  // 1) secret s + H, and the taker's keys.
  const sec = wasm.generateSwapSecret();                 // {secret_hex, hash_hex}
  const seqKp = C.signer.htlcKeypair();                  // {public_key, secret_hex} at m/3/0 — SEQ claim key
  const btcRefund = C.btcLeg.refundKey();                // {public_key, secret_hex (or wif/priv)} — BTC refund key from btc.js
  // 2) the BTC-leg HTLC redeemScript: claim=maker (with s), refund=taker after T_btc.
  const redeem = wasm.buildSeqHtlcRedeemScript(sec.hash_hex, q.maker_btc_claim_pub, btcRefund.public_key, q.btc_locktime);
  // 3) fund the P2SH on the Bitcoin chain, wait for >= minconf, capture the outpoint.
  const funded = await C.btcLeg.fund(redeem, q.btc_amount, q.btc_locktime, btcRefund);  // -> {txid, vout, height, amount, asset_id}

  SWAP = {
    state: ST.PENDING,
    created: Date.now(),
    market: { btc_asset: q.market.btc_asset, seq_asset: q.market.seq_asset, name: q.market.name },
    quote_id: q.quote_id,
    secret_hex: sec.secret_hex,
    hash_hex: sec.hash_hex,
    seq_claim_pub: seqKp.public_key,
    seq_claim_secret: seqKp.secret_hex,
    btc_refund_pub: btcRefund.public_key,
    btc_refund_secret: btcRefund.secret_hex,
    btc_redeem_script: redeem,
    btc_locktime: q.btc_locktime,
    seq_locktime: q.seq_locktime,
    seq_amount: q.seq_amount,
    btc_amount: q.btc_amount,
    fee_btc: q.fee_btc,
    maker_btc_claim_pub: q.maker_btc_claim_pub,
    maker_seq_refund_pub: q.maker_seq_refund_pub,
    btc_leg: {
      txid: funded.txid, vout: funded.vout, height: funded.height,
      amount: big(funded.amount), asset_id: funded.asset_id || '', redeem_script: redeem,
    },
  };
  saveSwap();
  return SWAP;
}
async function onLockBtc(){
  const { $ } = C;
  $('xswapErr').textContent = '';
  const q = LAST_XQUOTE;
  if (!q){ $('xswapErr').textContent = 'get a quote first'; return; }
  if (!C.btcLeg){ $('xswapErr').textContent = 'BTC leg unavailable in this build'; return; }
  const sm = C.assetMeta(q.market.seq_asset);
  // Structured review (never blind-sign): this LOCKS real BTC on the parent chain.
  const kv = [
    ['Network', '⚠ Bitcoin: locking BTC in a cross-chain HTLC (parent chain, not a Sequentia asset)'],
    ['You lock', C.fmtAtoms(q.btc_amount, 8) + ' BTC'],
    ['You will receive', C.fmtAtoms(q.seq_amount, sm.precision) + ' ' + sm.ticker],
    ['Maker fee', C.fmtAtoms(q.fee_btc, 8) + ' BTC'],
    ['BTC refund after', 'block ' + q.btc_locktime + ' (if the maker stalls, you reclaim the BTC)'],
    ['Atomicity', 'The BTC is claimable by the maker only with your secret; you can refund it after the timeout.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Lock the BTC leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Locking BTC leg…';
    try {
      await lockBtcLeg(q);
      modal.remove();
      resetQuote();
      renderStepper();
      C.toast && C.toast('BTC leg locked — propose the swap to the maker next.');
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}

// ---- step 3: propose (maker verifies BTC leg + locks Sequentia leg) ----
async function propose(){
  if (!SWAP) throw new Error('no in-flight swap');
  const resp = await dexPost('/v1/xchain/propose', {
    quote_id: SWAP.quote_id,
    hash: SWAP.hash_hex,
    btc_leg: {
      txid: SWAP.btc_leg.txid, vout: SWAP.btc_leg.vout, height: SWAP.btc_leg.height,
      redeem_script: SWAP.btc_redeem_script, amount: SWAP.btc_leg.amount.toString(),
      asset_id: SWAP.btc_leg.asset_id || '',
    },
    taker_seq_claim_pub: SWAP.seq_claim_pub,
    taker_btc_refund_pub: SWAP.btc_refund_pub,
  });
  // The propose oneof flattens to either `accepted` or `fail`.
  const fail = pick(resp, 'fail', 'swap_fail', 'swapFail');
  if (fail) {
    const code = pick(fail, 'code') || 'FAIL';
    const msg = pick(fail, 'message') || 'maker rejected the swap';
    SWAP.state = ST.FAILED; SWAP.detail = code + ': ' + msg; saveSwap();
    throw new Error(`${code}: ${msg}`);
  }
  const accepted = pick(resp, 'accepted', 'swap_accept', 'swapAccept');
  if (!accepted) throw new Error('no XchainSwapAccepted in propose response');
  SWAP.swap_id = pick(accepted, 'swap_id', 'swapId');
  SWAP.seq_leg = normSeqLeg(pick(accepted, 'seq_leg', 'seqLeg'));
  { const lg = verifyLeg(); if (!lg.ok){ SWAP.state = ST.FAILED; SWAP.detail = lg.reason; saveSwap(); throw new Error('swap aborted: ' + lg.reason); } }
  SWAP.state = ST.SEQ_LOCKED;
  saveSwap();
  return SWAP;
}
async function onPropose(){
  const { $ } = C;
  $('xswapErr').textContent = '';
  setStepStatus('propose', 'Proposing to the maker…', true);
  try {
    await propose();
    renderStepper();
    C.toast && C.toast('Sequentia leg locked by the maker — verify the anchor next.');
  } catch (e){
    $('xswapErr').textContent = 'Propose failed: ' + C.prettyErr(e);
    renderStepper();
  }
}

// ---- step 4: anchor-ordering verification (FIRST-CLASS, MANDATORY GATE) ----
// The Sequentia value-add. We REQUIRE seq_leg.anchor_height >= btc_leg.height
// before allowing the SEQ claim: the Sequentia leg is bound to a Bitcoin block at or
// after the one your BTC lock confirmed in, so it can't outlive your BTC — if
// Bitcoin reorgs your lock away, the Sequentia leg reorgs with it. We verify the
// maker-returned anchor_height against our own btc_leg.height, and (when a SEQ
// anchor-status reader is wired) surface the node's live anchorstatus too.
// Value-binding gate: the maker's locked Sequentia leg must match what we agreed to
// buy (asset + at least the agreed amount). Without it, a malicious maker locks dust
// or a substituted asset; we claim it, leak the preimage, and they sweep our full BTC.
function verifyLeg(){
  if (!SWAP || !SWAP.seq_leg) return { ok:false, reason:'no Sequentia leg yet' };
  const want = SWAP.market && SWAP.market.seq_asset;
  if (want && SWAP.seq_leg.asset_id !== want)
    return { ok:false, reason:`maker locked ${C.assetMeta(SWAP.seq_leg.asset_id).ticker}, not the agreed ${C.assetMeta(want).ticker} — do not claim; refund your BTC` };
  try {
    if (SWAP.seq_amount != null && BigInt(String(SWAP.seq_leg.amount)) < BigInt(String(SWAP.seq_amount)))
      return { ok:false, reason:'maker locked less than agreed — do not claim; refund your BTC' };
  } catch { return { ok:false, reason:'unreadable leg amount — do not claim' }; }
  return { ok:true };
}
function verifyAnchor(){
  if (!SWAP || !SWAP.seq_leg) return { ok: false, reason: 'no Sequentia leg yet' };
  const ah = SWAP.seq_leg.anchor_height;
  const bh = Number(SWAP.btc_leg.height);
  if (ah == null || ah < 0)
    return { ok: false, anchor_height: ah, btc_height: bh, reason: 'maker returned no anchor height (-1): the Sequentia block is not anchored' };
  if (!(ah >= bh))
    return { ok: false, anchor_height: ah, btc_height: bh, reason: `anchor_height ${ah} < BTC-leg height ${bh}: Sequentia leg is NOT bound to a Bitcoin block at/after your lock` };
  return { ok: true, anchor_height: ah, btc_height: bh };
}

// ---- step 5: claim the Sequentia leg (reveals the preimage) ----
// Build the claim with the 6c-2 binding (IF/redeem branch, revealing s) and
// broadcast via the wallet's Sequentia esplora. The destination is a fresh
// wallet address' (unconfidential) scriptPubKey; the claim fee is an explicit
// Elements fee output (C.seqClaimFee atoms, default 100000 — the taker CLI's
// ClaimSEQLeg fee).
async function claimSeq(){
  if (!SWAP || !SWAP.seq_leg) throw new Error('no Sequentia leg to claim');
  const gate = verifyAnchor();
  if (!gate.ok) throw new Error('anchor gate not satisfied: ' + gate.reason);   // belt-and-suspenders; the UI also gates the button
  const lg = verifyLeg();
  if (!lg.ok) throw new Error('leg mismatch: ' + lg.reason);   // never reveal the preimage on a mismatched leg
  const { wasm } = C;
  // Destination SPK: a fresh wallet address, unconfidential (explicit output).
  const destSpk = takerDestSpkHex();
  // Claim fee paid IN THE CLAIMED ASSET (the HTLC holds only the asset, no native tSEQ):
  // convert the native policy fee to the asset via its published rate. A flat 100000 atoms
  // of a valuable asset is a huge native-equivalent fee the node rejects ("Fee exceeds
  // maximum ... maxfeerate") — a valuable asset needs only ~1 atom.
  const claimAsset = SWAP.seq_leg.asset_id;
  let fee = 1;
  try {
    const rate = (claimAsset === C.POLICY_HEX) ? C.EXCHANGE_RATE_SCALE : Number(C.feeRateFor(claimAsset));
    const nativeFeeSats = Math.ceil(C.DEFAULT_FEERATE * 350 / 1000);   // ~policy fee (tSEQ-sats), ~350-vB claim
    fee = Math.max(1, Math.ceil(nativeFeeSats * C.EXCHANGE_RATE_SCALE / rate));
  } catch {}
  { const amt = Number(SWAP.seq_leg.amount); if (fee > Math.floor(amt/2)) fee = Math.max(1, Math.floor(amt/2)); }
  const spend = {
    txid: SWAP.seq_leg.txid,
    vout: SWAP.seq_leg.vout,
    amount: Number(SWAP.seq_leg.amount),
    asset_id: SWAP.seq_leg.asset_id,
    dest_spk: destSpk,
    fee,
  };
  const claimHex = wasm.buildSeqHtlcClaimTx(spend, SWAP.seq_leg.redeem_script, SWAP.seq_claim_secret, SWAP.secret_hex);
  const txid = await broadcastSeqTx(claimHex);
  SWAP.seq_claim_txid = txid;
  SWAP.seq_claim_hex = claimHex;
  SWAP.state = ST.SEQ_CLAIMED;     // local optimism; the daemon will confirm via poll
  saveSwap();
  return txid;
}
// The taker's fresh receive-address scriptPubKey, unconfidential, as hex.
function takerDestSpkHex(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const unconf = a.toUnconfidential ? a.toUnconfidential() : a;
  const bytes = unconf.scriptPubkey().bytes();
  return [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
}
// Broadcast a raw signed Elements tx hex on the wallet's Sequentia chain.
// Prefers the esplora client's broadcastTx(Transaction); falls back to a direct
// esplora `/tx` POST (the swap settles regardless of who relays the tx).
async function broadcastSeqTx(rawHex){
  if (C.broadcastSeqTx) return C.broadcastSeqTx(rawHex);   // harness/override hook
  if (C.wasm.Transaction && C.client && C.client.broadcastTx){
    try {
      const tx = new C.wasm.Transaction(rawHex);
      const txid = await C.client.broadcastTx(tx);
      return txid && txid.toString ? txid.toString() : String(txid);
    } catch (e){ /* fall through to the esplora POST */ }
  }
  const base = C.SEQ_ESPLORA || (typeof location !== 'undefined' ? (location.origin + '/api') : '');
  const r = await fetch(base + '/tx', { method: 'POST', body: rawHex });
  const txt = (await r.text()).trim();
  if (!r.ok) throw new Error(txt || ('HTTP ' + r.status));
  if (!/^[0-9a-fA-F]{64}$/.test(txt)) throw new Error('unexpected broadcast response: ' + txt.slice(0,80));
  return txt;
}
async function onClaimSeq(){
  const { $ } = C;
  $('xswapErr').textContent = '';
  const gate = verifyAnchor();
  if (!gate.ok){ $('xswapErr').textContent = 'cannot claim: ' + gate.reason; return; }
  const leg = verifyLeg();
  if (!leg.ok){ $('xswapErr').textContent = 'cannot claim: ' + leg.reason; return; }
  const sm = C.assetMeta(SWAP.seq_leg.asset_id);
  const kv = [
    ['Network', 'Sequentia (testnet): claiming the Sequentia leg reveals your secret on-chain'],
    ['You receive', C.fmtAtoms(SWAP.seq_leg.amount, sm.precision) + ' ' + sm.ticker],
    ['Anchor verified', `Sequentia anchor_height ${gate.anchor_height} ≥ your BTC-leg height ${gate.btc_height}`],
    ['Effect', 'Revealing the secret lets the maker claim your BTC, completing the atomic swap.'],
    ['Finality', 'Anchor-bounded: this can reorg only if the Bitcoin block it is anchored to does.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Claim the Sequentia leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Claiming Sequentia leg…';
    try {
      const txid = await claimSeq();
      modal.remove();
      renderStepper();
      startPoll();
      C.toast && C.toast('Sequentia leg claimed (anchor-bounded):', {href:'/explorer/tx/'+txid, label:String(txid).slice(0,18)+'…'});
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}

// ---- step 6: poll until the maker claims the BTC leg ----
async function pollOnce(){
  if (!SWAP || !SWAP.swap_id) return null;
  const resp = await dexPost('/v1/xchain/swap', { swap_id: SWAP.swap_id });
  const state = pick(resp, 'state');
  if (state) SWAP.state = state;
  const sc = pick(resp, 'seq_claim_txid', 'seqClaimTxid'); if (sc) SWAP.seq_claim_txid = sc;
  const bc = pick(resp, 'btc_claim_txid', 'btcClaimTxid'); if (bc) SWAP.btc_claim_txid = bc;
  const pre = pick(resp, 'preimage'); if (pre) SWAP.preimage = pre;
  const det = pick(resp, 'detail'); if (det) SWAP.detail = det;
  const sl = normSeqLeg(pick(resp, 'seq_leg', 'seqLeg')); if (sl && sl.txid) SWAP.seq_leg = sl;
  saveSwap();
  return SWAP;
}
function startPoll(){
  if (POLL) return;
  POLL = setInterval(async () => {
    try {
      await pollOnce();
      renderStepper();
      if (SWAP && (SWAP.state === ST.BTC_CLAIMED || SWAP.state === ST.REFUNDED || SWAP.state === ST.FAILED)) stopPoll();
    } catch (e){ /* transient; keep polling */ }
  }, 2000);
}
function stopPoll(){ if (POLL){ clearInterval(POLL); POLL = null; } }

// ---- step 7: refund off-ramp (BTC leg, after T_btc — a Bitcoin tx via btc.js) ----
async function onRefundBtc(){
  const { $ } = C;
  $('xswapErr').textContent = '';
  if (!SWAP || !SWAP.btc_leg){ $('xswapErr').textContent = 'no BTC leg to refund'; return; }
  if (!C.btcLeg || !C.btcLeg.refund){ $('xswapErr').textContent = 'BTC refund unavailable in this build'; return; }
  const kv = [
    ['Network', '⚠ Bitcoin: refunding YOUR locked BTC leg (parent chain) via the CLTV branch'],
    ['Refund amount', C.fmtAtoms(SWAP.btc_leg.amount, 8) + ' BTC (minus the refund tx fee)'],
    ['Valid after', 'block ' + SWAP.btc_locktime],
    ['Note', 'Only do this if the maker stalled / the quote expired and the Sequentia leg was never safely claimable.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Refund the BTC leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Refunding BTC leg…';
    try {
      const txid = await C.btcLeg.refund({
        txid: SWAP.btc_leg.txid, vout: SWAP.btc_leg.vout, amount: SWAP.btc_leg.amount,
        redeem_script: SWAP.btc_redeem_script, locktime: SWAP.btc_locktime,
        refund_secret: SWAP.btc_refund_secret, refund_pub: SWAP.btc_refund_pub,
      });
      SWAP.state = ST.REFUNDED; SWAP.btc_refund_txid = txid; SWAP.detail = 'BTC leg refunded by the taker'; saveSwap();
      modal.remove(); renderStepper();
      C.toast && C.toast(`BTC leg refunded: ${String(txid).slice(0,18)}…`);
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}

// Abandon/clear a terminal or stuck swap from local storage (after BTC_CLAIMED /
// REFUNDED / FAILED, or to start over). Does not touch on-chain funds. With no
// swap left, hand control back to the composer (the single swap entry point).
function onAbandon(){
  stopPoll(); clearSwap(); renderStepper();
  if (C.onExit) C.onExit();
}

// ---- stepper rendering ----
function badge(state){
  // Map a state to a small badge label + class.
  const map = {
    [ST.QUOTED]:      ['Quoted', 'b-out'],
    [ST.PENDING]:     ['BTC locked', 'b-out'],
    [ST.SEQ_LOCKED]:  ['Sequentia locked', 'b-out'],
    [ST.SEQ_CLAIMED]: ['Sequentia claimed', 'b-in'],
    [ST.BTC_CLAIMED]: ['Complete', 'b-in'],
    [ST.REFUNDED]:    ['Refunded', 'b-out'],
    [ST.FAILED]:      ['Failed', 'b-out'],
  };
  return map[state] || ['—', 'b-out'];
}
function setStepStatus(_step, msg, spin){
  const el = C.$('xStepStatus'); if (!el) return;
  el.className = 'status'; el.innerHTML = (spin ? '<span class="spin"></span>' : '') + msg;
}
// Render the wizard body for the current SWAP (or the quote form if none).
function renderStepper(){
  const { $, el } = C;
  const wrap = $('xStepper'); const form = $('xQuoteForm');
  if (!wrap) return;
  if (!SWAP){
    // No in-flight swap: show the quote form, hide the stepper.
    if (form) form.classList.remove('hide');
    wrap.classList.add('hide'); wrap.innerHTML = '';
    return;
  }
  if (form) form.classList.add('hide');
  wrap.classList.remove('hide');
  wrap.innerHTML = '';

  const sm = C.assetMeta(SWAP.market.seq_asset);
  const [blabel, bcls] = badge(SWAP.state);

  // Header card: market + overall badge + amounts + the secret/timeouts.
  const head = el('div','card');
  const hr = el('div','row');
  hr.appendChild(el('label','lbl', 'Cross-chain swap'));
  const b = el('span','badge ' + bcls, blabel); b.style.marginLeft = 'auto'; hr.appendChild(b);
  head.appendChild(hr);
  head.appendChild(kvRow('Buying', C.fmtAtoms(SWAP.seq_amount, sm.precision) + ' ' + sm.ticker));
  head.appendChild(kvRow('Paying', C.fmtAtoms(SWAP.btc_amount, 8) + ' BTC'));
  head.appendChild(kvRow('Timeouts', `T_btc=${SWAP.btc_locktime} · T_seq=${SWAP.seq_locktime}`));
  head.appendChild(kvRow('Hashlock H', short(SWAP.hash_hex)));
  wrap.appendChild(head);

  // Step cards.
  wrap.appendChild(stepLockCard());
  wrap.appendChild(stepProposeCard());
  wrap.appendChild(stepAnchorCard());
  wrap.appendChild(stepClaimCard());
  wrap.appendChild(stepDoneCard());

  // Per-stepper status line + controls.
  const ctl = el('div','card');
  ctl.appendChild(el('div','status',''));   // becomes xStepStatus below via id
  const stat = ctl.firstChild; stat.id = 'xStepStatus';
  const row = el('div','row'); row.style.marginTop = '6px';
  // Refund off-ramp is offered whenever the BTC leg is locked and the swap
  // hasn't completed — the user decides; the copy notes it's only valid after T_btc.
  if (SWAP.btc_leg && SWAP.state !== ST.BTC_CLAIMED && SWAP.state !== ST.REFUNDED){
    const rb = el('button','danger','Refund BTC leg'); rb.id = 'btnXRefund'; rb.onclick = onRefundBtc; row.appendChild(rb);
  }
  const ab = el('button','ghost', (SWAP.state === ST.BTC_CLAIMED || SWAP.state === ST.REFUNDED || SWAP.state === ST.FAILED) ? 'Clear' : 'Abandon');
  ab.id = 'btnXAbandon'; ab.onclick = onAbandon; row.appendChild(ab);
  ctl.appendChild(row);
  wrap.appendChild(ctl);

  // Keep polling alive across a re-render if we're past propose and not terminal.
  if (SWAP.swap_id && (SWAP.state === ST.SEQ_LOCKED || SWAP.state === ST.SEQ_CLAIMED)) startPoll();
}

function kvRow(k, v){
  const d = C.el('div','kv'); d.appendChild(C.el('span','k',k)); d.appendChild(C.el('span','v',v)); return d;
}
function short(s){ return s ? (String(s).slice(0,10) + '…' + String(s).slice(-6)) : '—'; }
function txLink(txid, parent){
  if (!txid) return '—';
  const href = parent ? ('/testnet4/tx/' + txid) : ('/explorer/tx/' + txid);
  return `<a href="${href}" target="_blank" rel="noopener">${short(txid)}</a>`;
}

function stepCard(n, title, done, active, bodyNodes){
  const c = C.el('div','card');
  const hr = C.el('div','row');
  hr.appendChild(C.el('label','lbl', `${n}. ${title}`));
  const [lbl, cls] = done ? ['Done','b-in'] : active ? ['Now','b-out'] : ['Pending','b-out'];
  const b = C.el('span','badge ' + cls, lbl); b.style.marginLeft = 'auto'; hr.appendChild(b);
  c.appendChild(hr);
  for (const node of bodyNodes) if (node) c.appendChild(node);
  return c;
}

function stepLockCard(){
  const done = !!(SWAP.btc_leg && SWAP.btc_leg.txid);
  const body = [
    C.el('div','sub','You locked BTC in an HTLC claimable by the maker with your secret, refundable by you after T_btc.'),
    SWAP.btc_leg && SWAP.btc_leg.txid ? kvRowHtml('BTC lock tx', txLink(SWAP.btc_leg.txid, true)) : null,
    SWAP.btc_leg && SWAP.btc_leg.height ? kvRow('Confirmed at height', String(SWAP.btc_leg.height)) : null,
  ];
  return stepCard(1, 'Lock BTC leg', done, !done, body);
}
function stepProposeCard(){
  const done = !!(SWAP.swap_id);
  const active = !done && !!(SWAP.btc_leg && SWAP.btc_leg.txid) && SWAP.state !== ST.FAILED;
  const body = [ C.el('div','sub','The maker verifies your BTC leg, then locks the Sequentia leg in an anchored Sequentia block.') ];
  if (done) body.push(kvRow('Swap id', short(SWAP.swap_id)));
  if (SWAP.seq_leg && SWAP.seq_leg.txid) body.push(kvRowHtml('Sequentia lock tx', txLink(SWAP.seq_leg.txid, false)));
  if (SWAP.state === ST.FAILED) body.push(errLine(SWAP.detail || 'propose failed'));
  const c = stepCard(2, 'Propose to maker', done, active, body);
  if (active){
    const btn = C.el('button','primary','Propose swap'); btn.id = 'btnXPropose'; btn.onclick = onPropose;
    btn.style.marginTop = '10px'; c.appendChild(btn);
  }
  return c;
}
function stepAnchorCard(){
  const have = !!(SWAP.seq_leg && SWAP.seq_leg.txid);
  const gate = have ? verifyAnchor() : { ok:false };
  const done = have && gate.ok;
  const body = [
    C.el('div','sub','Mandatory anchor gate (the Sequentia value-add): the Sequentia leg must be bound to a Bitcoin block at or after your BTC lock.'),
  ];
  if (have){
    body.push(kvRow('Sequentia anchor_height', String(SWAP.seq_leg.anchor_height)));
    body.push(kvRow('Your BTC-leg height', String(SWAP.btc_leg.height)));
    if (gate.ok){
      body.push(okLine(`Anchor verified: anchor_height ${gate.anchor_height} ≥ your BTC-leg height ${gate.btc_height} — the Sequentia leg is bound to a Bitcoin block ≥ your BTC lock, so it can't outlive your BTC.`));
    } else {
      body.push(errLine('Anchor NOT verified: ' + (gate.reason || 'ordering not satisfied') + ' — do NOT claim; refund the BTC leg after T_btc instead.'));
    }
  }
  return stepCard(3, 'Verify anchor ordering', done, have && !done, body);
}
function stepClaimCard(){
  const have = !!(SWAP.seq_leg && SWAP.seq_leg.txid);
  const gate = have ? verifyAnchor() : { ok:false };
  const claimed = !!(SWAP.seq_claim_txid) || SWAP.state === ST.SEQ_CLAIMED || SWAP.state === ST.BTC_CLAIMED;
  const active = have && gate.ok && !claimed;
  const body = [ C.el('div','sub','Claim the Sequentia leg with your secret. This reveals the secret on-chain so the maker can claim your BTC — completing the atomic swap.') ];
  if (SWAP.seq_claim_txid) body.push(kvRowHtml('Sequentia claim tx', txLink(SWAP.seq_claim_txid, false)));
  const c = stepCard(4, 'Claim Sequentia leg', claimed, active, body);
  if (active){
    const btn = C.el('button','primary','Claim Sequentia leg'); btn.id = 'btnXClaim'; btn.onclick = onClaimSeq;
    btn.style.marginTop = '10px'; c.appendChild(btn);
  } else if (have && !gate.ok && !claimed){
    c.appendChild(C.el('div','warn','Claiming is blocked until the anchor gate passes.'));
  }
  return c;
}
function stepDoneCard(){
  const done = SWAP.state === ST.BTC_CLAIMED;
  const body = [ C.el('div','sub','The maker extracts your revealed secret and claims the BTC leg. The swap is then complete (anchor-bounded; reorgs only if Bitcoin does).') ];
  if (SWAP.btc_claim_txid) body.push(kvRowHtml('BTC claim tx (maker)', txLink(SWAP.btc_claim_txid, true)));
  if (SWAP.preimage) body.push(kvRow('Preimage revealed', short(SWAP.preimage)));
  if (SWAP.state === ST.REFUNDED){ body.push(okLine('Refunded: ' + (SWAP.detail || 'the BTC leg was refunded to you.'))); }
  if (done) body.push(okLine('Swap complete — both legs settled, linked by your secret.'));
  return stepCard(5, 'Done', done, SWAP.state === ST.SEQ_CLAIMED, body);
}

function kvRowHtml(k, html){
  const d = C.el('div','kv'); d.appendChild(C.el('span','k',k));
  const v = C.el('span','v'); v.innerHTML = html; d.appendChild(v); return d;
}
function okLine(t){ const d = C.el('div','status ok'); d.textContent = t; return d; }
function errLine(t){ const d = C.el('div','status err'); d.textContent = t; return d; }

// Test-only exports: let a headless harness drive the REAL wizard pipeline
// (quote -> lockBTC -> propose -> verifyAnchor -> claimSEQ -> poll) without a
// browser/DOM. Unused by the browser app (which imports initXswap/renderXswap).
export const __test__ = {
  dexPost, pick, normMarket, normSeqLeg,
  lockBtcLeg, propose, verifyAnchor, claimSeq, pollOnce,
  takerDestSpkHex, broadcastSeqTx, startCountdown: () => {},
  // state accessors for the harness
  getSwap: () => SWAP, setSwap: (s) => { SWAP = s; saveSwap(); },
  setQuote: (q) => { LAST_XQUOTE = q; }, getQuote: () => LAST_XQUOTE,
  setMarkets: (m) => { XMARKETS = m.map(normMarket); },
  loadSwap, saveSwap, clearSwap, ST,
};
