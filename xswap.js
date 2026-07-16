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

import * as xc from './xcourier.js';       // cross-chain courier transport (order book)
import * as seqob from './seqob.js';        // order-book relay client (fetchBook, base, Crypter)

let C = null;            // the injected app context (see index.html initXswapTab)
let XMARKETS = [];       // [{ btc_asset, seq_asset, name, seq_reserve, btc_reserve, price_seq_per_btc }]
let LAST_XQUOTE = null;  // the live quote for the selected market+amount
let SWAP = null;         // the persisted in-flight swap (see loadSwap/saveSwap)
let POLL = null;         // setInterval handle for the GetXchainSwap poll
let COUNTDOWN = null;    // setInterval handle for the quote-expiry countdown
let XSESSION = null;     // live courier CourierSession while a swap auto-drives (null after reload)

// Transport: the order-book COURIER (SeqOB relay) by default; flip to false to
// fall back to the legacy RFQ daemon (/v1/xchain/*) without losing that path.
// The courier discovers resting cross offers and carries the HTLC handshake as
// opaque sealed messages; the client-side settlement (lock/verify/anchor/claim)
// is identical to the RFQ path — only the transport differs.
let USE_COURIER = true;

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
  // Point the order-book client at the relay (same base swap.js uses; both import
  // the one seqob.js module instance, so this is idempotent).
  if (C.SEQOB && seqob.setSeqobBase) seqob.setSeqobBase(C.SEQOB);
  if (typeof C.useCourier === 'boolean') USE_COURIER = C.useCourier;
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
// Composer market/quote entrypoints. Dispatch to the courier (order book) or the
// legacy RFQ by USE_COURIER; the exported names are stable (swap.js/index.html
// call them).
export async function fetchXmarkets(){
  return USE_COURIER ? fetchXmarketsCourier() : fetchXmarketsRFQ();
}
export async function fetchXquote(seqAsset, seqAtoms){
  return USE_COURIER ? fetchXquoteCourier(seqAsset, seqAtoms) : fetchXquoteRFQ(seqAsset, seqAtoms);
}

async function fetchXmarketsRFQ(){
  const resp = await dexPost('/v1/xchain/markets', {});
  XMARKETS = (Array.isArray(pick(resp, 'markets')) ? pick(resp, 'markets') : []).map(normMarket);
  return XMARKETS;
}

// ---- courier (order-book) discovery ----
// A forward cross offer: a resting CrossChainTerms offer to SELL a Sequentia
// asset for BTC (direction BTC_TO_ASSET = 0; protojson omits the field at 0).
// The taker of such an offer pays BTC and receives the asset — this wizard's job.
function xcSettlement(o){ return o.cross_chain || o.crossChain; }
// A resting cross offer is a PLAIN INTENT: the courier mints the HTLC terms (maker keys,
// locktimes, exact fee) PER-LIFT via the session (openCourierSession -> Terms/SeqLegLocked), so the
// resting offer carries NO cross_chain metadata (that field is only populated on a live leg). We
// therefore recognize a cross offer by its parent-BTC leg, NOT by cross_chain: offer_asset/
// want_asset === 'BTC' (the literal string = the parent chain; a hex id = a same-chain asset pair).
// want_asset==='BTC' -> the maker sells the asset for BTC = a taker BUYS (forward). offer_asset===
// 'BTC' -> the maker offers BTC for the asset = a taker SELLS (reverse). Legacy offers that DID carry
// cross_chain still resolve — that leg's asset is 'BTC' too. Signature (_verified) still gates: the
// courier key derives from maker_pubkey, so an unverified offer could let a relay MITM the channel.
function isForwardCrossOffer(o){
  if (!o || o._verified === false) return false;
  return pick(o, 'want_asset', 'wantAsset') === 'BTC';
}
async function seqobGet(path){
  const r = await fetch(seqob.seqobBase() + path, { cache: 'no-store' });
  if (!r.ok) throw new Error('order-book relay ' + r.status);
  return r.json();
}
// List BTC/asset markets that have at least one resting forward offer. Each entry
// carries a representative price (from the best offer) so the composer can convert
// a BTC-typed amount; amounts/keys/locktimes for a specific swap come per-lift.
async function fetchXmarketsCourier(){
  const out = [];
  try {
    const j = await seqobGet('/v1/markets');
    const markets = pick(j, 'markets', 'Markets') || [];
    for (const m of markets){
      const pair = pick(m, 'pair') || {};
      const base = pick(pair, 'base_asset', 'baseAsset');
      const quote = pick(pair, 'quote_asset', 'quoteAsset');
      if (!base || quote !== 'BTC') continue;
      try {
        const bk = await seqob.fetchBook(base, 'BTC');
        const fwd = (bk.offers || []).filter(isForwardCrossOffer);
        if (!fwd.length) continue;
        const best = bestForwardOffer(fwd, 1n);
        out.push({
          btc_asset: '', seq_asset: base, name: 'BTC / ' + C.assetMeta(base).ticker,
          seq_reserve: best.ba, btc_reserve: best.wa,
          price_seq_per_btc: best.wa > 0n ? Number(best.ba) / Number(best.wa) : 0,
        });
      } catch { /* skip a market whose book is unreadable */ }
    }
  } catch (e){ /* no relay / no markets → empty picker */ }
  XMARKETS = out;
  return XMARKETS;
}
// From forward offers, choose the smallest whose size covers `wantAtoms`, else the
// largest available (an order book fills against resting size). Returns {o,ba,wa}.
function bestForwardOffer(fwd, wantAtoms){
  const withAmt = fwd.map(o => ({
    o,
    ba: big(pick(o, 'base_amount', 'baseAmount')),
    wa: big(pick(o, 'want_amount', 'wantAmount')),
    v: !!o._verified,
  })).filter(x => x.ba > 0n && x.wa > 0n);
  const covering = withAmt.filter(x => x.ba >= wantAtoms).sort((a, b) => (a.ba < b.ba ? -1 : a.ba > b.ba ? 1 : 0));
  if (covering.length) return covering[0];
  return withAmt.sort((a, b) => (a.ba > b.ba ? -1 : a.ba < b.ba ? 1 : 0))[0];
}
// A cross offer whose direction is ASSET_TO_BTC (taker SELLS the asset for BTC).
function isReverseCrossOffer(o){
  if (!o || o._verified === false) return false;
  return pick(o, 'offer_asset', 'offerAsset') === 'BTC';   // maker offers BTC for the asset = taker SELLS
}

// The cross-chain ORDER BOOK for one BTC<->seqAsset pair, split by taker direction
// so the composer can render it exactly like the same-chain book:
//   forward = taker BUYS the asset paying BTC  (maker offer direction 0)
//   reverse = taker SELLS the asset for BTC    (maker offer direction 1)
// Only signature-verified offers are returned (see isForwardCrossOffer). An empty
// side means no resting cross liquidity for that direction yet.
export async function fetchXbook(seqAsset){
  let offers = [], unreachable = false;
  // T7: distinguish "no such cross market yet" (4xx = genuinely empty) from an unreachable relay
  // (network/5xx). The caller uses `unreachable` to offer a retry instead of inviting a first maker.
  try { const bk = await seqob.fetchBook(seqAsset, 'BTC'); offers = bk.offers || []; }
  catch (e){ if (!/HTTP\s*4\d\d/.test((e && e.message) || '')) unreachable = true; offers = []; }
  return { forward: offers.filter(isForwardCrossOffer), reverse: offers.filter(isReverseCrossOffer), unreachable };
}

// A courier quote is the chosen resting offer's size (whole-HTLC — cross lifts do
// not partial-fill). The maker keys, locktimes and exact fee are minted per-lift
// over the courier (in openFromComposer), so they are blank here.
async function fetchXquoteCourier(seqAsset, seqAtoms){
  const bk = await seqob.fetchBook(seqAsset, 'BTC');
  const fwd = (bk.offers || []).filter(isForwardCrossOffer);
  if (!fwd.length) throw new Error('No cross-chain offers to buy this asset yet. Check back, or post your own.');
  const best = bestForwardOffer(fwd, seqAtoms);
  if (!best) throw new Error('No usable cross-chain offer for this asset.');
  const price = best.wa > 0n ? Number(best.ba) / Number(best.wa) : 0;
  const market = XMARKETS.find(m => m.seq_asset === seqAsset) ||
    { btc_asset: '', seq_asset: seqAsset, name: 'BTC / ' + C.assetMeta(seqAsset).ticker, price_seq_per_btc: price };
  return {
    market, offer: best.o, courier: true, quote_id: 'courier',
    seq_amount: best.ba, btc_amount: best.wa, fee_btc: 0n,
    price_seq_per_btc: price,
    maker_btc_claim_pub: '', maker_seq_refund_pub: '', btc_locktime: 0, seq_locktime: 0, expires_at_unix: 0,
  };
}

// Get a cross-chain quote for `seqAtoms` of `seqAsset` (RFQ). Returns the SAME
// normalized quote object the form's onQuote builds (incl. the T_btc>T_seq check),
// so openFromComposer can drive the rest of the wizard identically.
async function fetchXquoteRFQ(seqAsset, seqAtoms){
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
  if (USE_COURIER && q && (q.courier || q.offer)){
    // Order-book courier: open a session, confirm the maker's terms once, then
    // auto-drive lock -> announce -> anchor gate -> claim.
    runForwardCourier(q);
    return;
  }
  // Legacy RFQ: the composer already showed the quote, so go straight to "lock".
  renderStepper();
  startCountdown();
  onLockBtc();
}

// ---------------------------------------------------------------------------
// Courier forward driver (order book): start once, then it settles itself.
// Reuses the client-side settlement verbatim (lockBtcLeg / verifyLeg /
// verifyAnchor / claimSeq); only the transport is the SeqOB courier instead of
// the RFQ HTTP calls. Mirrors the Go RunMakerForward peer's handshake.
// ---------------------------------------------------------------------------
async function runForwardCourier(q){
  const { $ } = C;
  if ($('xswapErr')) $('xswapErr').textContent = '';
  if (!C.btcLeg){ if ($('xswapErr')) $('xswapErr').textContent = 'BTC leg unavailable in this build.'; return; }
  const offer = q.offer;
  const sm = C.assetMeta(q.market.seq_asset);
  const takeAtoms = q.seq_amount;   // whole-HTLC: the resting offer's full size

  // In-memory progress SWAP so the stepper renders during the pre-lock phase; it
  // is NOT persisted until real BTC is committed (so a reload before lock just
  // returns to the composer, nothing to recover).
  SWAP = {
    state: ST.QUOTED, courier: true, created: Date.now(),
    market: { btc_asset: q.market.btc_asset, seq_asset: q.market.seq_asset, name: q.market.name },
    offer_id: offer.offer_id || offer.offerId,
    maker_pubkey: offer.maker_pubkey || offer.makerPubkey,
    seq_amount: q.seq_amount, btc_amount: q.btc_amount, fee_btc: 0n, hash_hex: '',
  };
  renderStepper();
  setStepStatus('terms', 'Contacting the maker over the order-book relay…', true);

  let session = null;
  try {
    session = await xc.openCourierSession(offer, takeAtoms, '');
    XSESSION = session;
    await session.send({ type: xc.XcType.TermsRequest });
    setStepStatus('terms', 'Waiting for the maker’s terms…', true);
    const terms = await session.recv(xc.XcType.Terms, 120000);

    // Bind the maker's terms to the offer we chose (never fund on a mismatch).
    const tSeq = big(pick(terms, 'seq_amount', 'seqAmount'));
    const tBtc = big(pick(terms, 'btc_amount', 'btcAmount'));
    const tFee = big(pick(terms, 'fee_btc', 'feeBtc') || 0);
    const bl = Number(pick(terms, 'btc_locktime', 'btcLocktime'));
    const sl = Number(pick(terms, 'seq_locktime', 'seqLocktime'));
    const makerBtcClaimPub = pick(terms, 'maker_btc_claim_pub', 'makerBtcClaimPub');
    const makerSeqRefundPub = pick(terms, 'maker_refund_pub', 'makerRefundPub');
    if (tBtc !== q.btc_amount)
      throw abortTerms(session, `the maker quoted ${C.fmtAtoms(tBtc,8)} BTC, not the offered ${C.fmtAtoms(q.btc_amount,8)} BTC`);
    if (tSeq !== q.seq_amount)
      throw abortTerms(session, `the maker quoted ${C.fmtAtoms(tSeq, sm.precision)} ${sm.ticker}, not the offered ${C.fmtAtoms(q.seq_amount, sm.precision)} ${sm.ticker}`);
    if (!makerBtcClaimPub || !makerSeqRefundPub)
      throw abortTerms(session, 'the maker’s terms were missing a key');
    if (!(bl > sl))
      throw abortTerms(session, `bad locktime ordering (T_btc ${bl} must exceed T_seq ${sl})`);
    // Fee sanity: never accept a maker fee above ~1% of the trade (defends against
    // a maker quoting a punitive fee once the session is open).
    if (tFee > (q.btc_amount / 100n) + 1000n)
      throw abortTerms(session, `the maker fee ${C.fmtAtoms(tFee,8)} BTC is too high`);

    const fq = {
      market: q.market, quote_id: 'courier',
      seq_amount: q.seq_amount, btc_amount: q.btc_amount, fee_btc: tFee,
      maker_btc_claim_pub: makerBtcClaimPub, maker_seq_refund_pub: makerSeqRefundPub,
      btc_locktime: bl, seq_locktime: sl,
    };
    SWAP.fee_btc = tFee; SWAP.btc_locktime = bl; SWAP.seq_locktime = sl; renderStepper();

    // One confirmation before real BTC moves (never blind-lock), then auto-drive.
    const okConfirm = await confirmLockModal(fq, sm);
    if (!okConfirm){
      await session.fail('cancelled', 'taker cancelled before locking'); session.close();
      SWAP = null; renderStepper(); if (C.onExit) C.onExit();
      return;
    }

    setStepStatus('lock', `Locking your ${C.fmtAtoms(fq.btc_amount,8)} BTC and waiting for 1 confirmation (about one Bitcoin block - often ~20 min on testnet4)…`, true);
    await lockBtcLeg(fq);                 // funds + confirms the BTC HTLC; sets SWAP (PENDING) + saveSwap
    SWAP.courier = true;                  // lockBtcLeg rebuilt SWAP; restore courier identity
    SWAP.offer_id = offer.offer_id || offer.offerId;
    SWAP.maker_pubkey = offer.maker_pubkey || offer.makerPubkey;
    saveSwap(); renderStepper();

    setStepStatus('lock', 'BTC locked and confirmed. Sending the leg to the maker…', true);
    await session.send({
      type: xc.XcType.BtcLegFunded,
      hash_h: SWAP.hash_hex,
      taker_seq_claim_pub: SWAP.seq_claim_pub,
      taker_btc_refund_pub: SWAP.btc_refund_pub,
      leg: {
        txid: SWAP.btc_leg.txid, vout: SWAP.btc_leg.vout, amount: Number(SWAP.btc_leg.amount),
        redeem_script: SWAP.btc_redeem_script, locktime: SWAP.btc_locktime, height: Number(SWAP.btc_leg.height),
      },
    });

    setStepStatus('seq', `Maker is locking ${C.fmtAtoms(SWAP.seq_amount, sm.precision)} ${sm.ticker} on Sequentia…`, true);
    const locked = await session.recv(xc.XcType.SeqLegLocked, 900000);   // ~15 min budget
    if (!locked.leg) throw new Error('the maker sent no Sequentia leg');
    SWAP.seq_leg = normCourierSeqLeg(locked.leg);
    SWAP.state = ST.SEQ_LOCKED; saveSwap(); renderStepper();

    // Value gate + anchor gate (reused). Never reveal the secret on a bad leg.
    const lg = verifyLeg();
    if (!lg.ok){ SWAP.state = ST.FAILED; SWAP.detail = lg.reason; saveSwap();
      await session.fail('seq_leg_invalid', lg.reason); renderStepper();
      if ($('xswapErr')) $('xswapErr').textContent = 'Stopped before revealing your secret: ' + lg.reason + ' Your BTC is refundable after block ' + SWAP.btc_locktime + '.';
      return;
    }
    setStepStatus('anchor', 'Checking the asset is anchored to a Bitcoin block at or above your lock…', true);
    let gate = verifyAnchor(await fetchLiveAnchor());
    if (!gate.ok && gate.lag){
      // Transient lag: wait for the committee to anchor forward past your BTC lock rather than
      // dead-ending to refund. Bails out only near T_btc. The secret stays unrevealed throughout.
      gate = await awaitAnchor();
    }
    if (!gate.ok){ SWAP.detail = gate.reason; saveSwap(); renderStepper();
      if ($('xswapErr')) $('xswapErr').textContent = (gate.timedout
        ? 'Anchor did not confirm before your refund window: ' + gate.reason
        : 'Anchor check did not pass: ' + gate.reason + ' Your secret was NOT revealed; refund your BTC after block ' + SWAP.btc_locktime + '.');
      return;
    }

    setStepStatus('claim', `Anchor verified. Claiming your ${sm.ticker}…`, true);
    const claimTxid = await claimSeq();                 // reveals the secret; state -> SEQ_CLAIMED
    setStepStatus('done', '', false);
    renderStepper();
    C.toast && C.toast('Swap complete - ' + sm.ticker + ' claimed (anchor-bound to Bitcoin).',
      { href: '/explorer/tx/' + claimTxid, label: String(claimTxid).slice(0, 18) + '…' });
    session.close();
  } catch (e){
    if (session) { try { session.close(); } catch {} }
    if (SWAP && SWAP.btc_leg && SWAP.btc_leg.txid){
      // BTC is committed and persisted — the swap is recoverable (claim on resume
      // if the asset was locked, else refund after T_btc).
      renderStepper();
      if ($('xswapErr')) $('xswapErr').textContent = describeForwardFailure(e);
    } else {
      // Nothing spent yet — back to the composer with an explanation.
      SWAP = null; renderStepper();
      if ($('xswapErr')) $('xswapErr').textContent = 'Could not start the swap: ' + C.prettyErr(e) + ' - nothing was spent.';
      if (C.onExit) C.onExit();
    }
  } finally {
    XSESSION = null;
  }
}
// Seal a terms-mismatch abort into a thrown Error (the caller catches it).
function abortTerms(session, why){
  try { session.fail('terms_mismatch', why); } catch {}
  return new Error('Terms didn’t match the offer: ' + why + ' - nothing was spent.');
}
function normCourierSeqLeg(l){
  if (!l) return null;
  return {
    txid: pick(l, 'txid'),
    vout: num(pick(l, 'vout')),
    block_hash: pick(l, 'block_hash', 'blockHash'),
    anchor_height: Number(pick(l, 'anchor_height', 'anchorHeight') ?? -1),
    redeem_script: pick(l, 'redeem_script', 'redeemScript'),
    amount: big(pick(l, 'amount')),
    asset_id: pick(l, 'asset', 'asset_id', 'assetId'),
  };
}
function describeForwardFailure(e){
  const T = SWAP && SWAP.btc_locktime;
  const base = 'The swap didn’t complete: ' + C.prettyErr(e);
  if (SWAP && SWAP.seq_claim_txid) return base + ' - but your asset was already claimed.';
  return base + (T ? ` Your BTC is refundable after block ${T} (use “Refund BTC leg”).` : '');
}
// One confirmation modal with the maker's real per-lift terms; resolves true/false.
function confirmLockModal(fq, sm){
  return new Promise((resolve) => {
    const kv = [
      ['Network', '⚠ Bitcoin: you lock BTC in a cross-chain HTLC (parent chain)'],
      ['You lock', C.fmtAtoms(fq.btc_amount, 8) + ' BTC'],
      ['You receive', C.fmtAtoms(fq.seq_amount, sm.precision) + ' ' + sm.ticker],
      ['Maker fee', C.fmtAtoms(fq.fee_btc, 8) + ' BTC'],
      ['BTC refund after', 'block ' + fq.btc_locktime + ' (if the maker stalls, you reclaim the BTC)'],
      ['Then, automatically', 'the maker locks the asset, the wallet checks the Bitcoin anchor, and claims your asset. Anchor-bound to Bitcoin - reverts only if Bitcoin reverts.'],
    ];
    const { m, ok } = C.modalRows({ title: 'Confirm cross-chain swap', kv });
    if (ok) ok.textContent = 'Lock BTC & swap';
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { m.remove(); } catch {} resolve(v); };
    if (ok) ok.onclick = () => finish(true);
    const cancel = m.querySelector && m.querySelector('button.ghost');
    if (cancel) cancel.onclick = () => finish(false);
  });
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
// Resume hook: a courier forward BUY persisted at SEQ_LOCKED (asset locked, not yet claimed).
// After a reload the courier WS session is gone, so runForwardCourier won't re-run — but the
// claim is purely on-chain and session-independent. Re-run the anchor WAIT + claim in the
// background so a reloaded wallet completes the swap once the anchor catches up, instead of
// stranding it at the stale-snapshot failure. Idempotent: guarded against re-entry, and a
// double claim just rebroadcasts the same preimage tx (same txid). Never waits on a mismatched
// leg (verifyLeg gates first).
let _resumeClaiming = false;
async function resumeAnchorClaim(){
  if (_resumeClaiming) return;
  if (!SWAP || !SWAP.courier || SWAP.state !== ST.SEQ_LOCKED) return;
  if (!SWAP.seq_leg || SWAP.seq_claim_txid) return;
  const lg = verifyLeg(); if (!lg.ok) return;
  _resumeClaiming = true;
  try {
    let gate = verifyAnchor(await fetchLiveAnchor());
    if (!gate.ok && gate.lag) gate = await awaitAnchor();
    if (!gate.ok) { renderStepper(); return; }   // timed out near T_btc; stepper shows refund guidance
    const txid = await claimSeq();
    renderStepper();
    C.toast && C.toast('Swap complete - asset claimed (anchor-bound to Bitcoin).',
      { href: '/explorer/tx/' + txid, label: String(txid).slice(0, 18) + '…' });
  } catch { /* transient; the manual Claim button + next resume retry */ }
  finally { _resumeClaiming = false; }
}

export async function renderXswap(){
  const { $ } = C;
  if (!C.wollet) return;
  loadSwap();
  const status = $('xswapStatus');
  if (status){ status.className = 'status'; status.innerHTML = '<span class="spin"></span>Loading cross-chain markets…'; }
  try {
    await fetchXmarkets();               // courier or RFQ per USE_COURIER
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
  // A reloaded forward buy stuck at the anchor gate finishes on its own (session-independent).
  resumeAnchorClaim();
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
    if (secs <= 0){ el.textContent = 'Quote expired - get a fresh quote.'; el.className = 'sub err';
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
      C.toast && C.toast('BTC leg locked - propose the swap to the maker next.');
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
// The cross-chain quote is SINGLE-USE: the first propose consumes it on the maker.
// The propose then blocks ~1-2 min while the maker locks AND confirms the Sequentia
// leg, so a double-click in that window would hit the maker with an already-consumed
// quote and fail "unknown or expired quote_id". Guard against it and disable the button.
let PROPOSING = false;
async function onPropose(){
  const { $ } = C;
  if (PROPOSING) return;
  PROPOSING = true;
  const btn = $('btnXPropose'); if (btn) btn.disabled = true;
  $('xswapErr').textContent = '';
  setStepStatus('propose', 'Proposing to the maker; locking and confirming the Sequentia leg (can take 1-2 min on testnet). Please wait, do not re-click.', true);
  try {
    await propose();
    renderStepper();
    C.toast && C.toast('Sequentia leg locked by the maker; verify the anchor next.');
  } catch (e){
    $('xswapErr').textContent = 'Propose failed: ' + C.prettyErr(e);
    renderStepper();
  } finally {
    PROPOSING = false;
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
    return { ok:false, reason:`maker locked ${C.assetMeta(SWAP.seq_leg.asset_id).ticker}, not the agreed ${C.assetMeta(want).ticker} - do not claim; refund your BTC` };
  try {
    if (SWAP.seq_amount != null && BigInt(String(SWAP.seq_leg.amount)) < BigInt(String(SWAP.seq_amount)))
      return { ok:false, reason:'maker locked less than agreed - do not claim; refund your BTC' };
  } catch { return { ok:false, reason:'unreadable leg amount - do not claim' }; }
  return { ok:true };
}
// verifyAnchor(liveAnchor?): the gate compares the FRESHEST anchor we know to the BTC-leg
// height. The maker's anchor_height is a lock-time SNAPSHOT that never rises on its own; the
// live value (the Sequentia tip's current Bitcoin-anchor, from fetchLiveAnchor) climbs as the
// committee anchors forward. Passing it lets a lagging anchor CLEAR instead of dead-ending on
// a stale number. A failure here is always a transient LAG (a wrong-asset/short-amount leg is
// rejected earlier and terminally by verifyLeg), so callers may WAIT on it.
function verifyAnchor(liveAnchor){
  if (!SWAP || !SWAP.seq_leg) return { ok: false, reason: 'no Sequentia leg yet' };
  const snap = Number(SWAP.seq_leg.anchor_height);
  const live = Number.isFinite(Number(liveAnchor)) ? Number(liveAnchor) : -1;
  const ah = Math.max(Number.isFinite(snap) ? snap : -1, live);
  const bh = Number(SWAP.btc_leg.height);
  if (ah < 0)
    return { ok: false, anchor_height: ah, btc_height: bh, lag: true, reason: 'the Sequentia block is not anchored to Bitcoin yet' };
  if (!(ah >= bh))
    return { ok: false, anchor_height: ah, btc_height: bh, lag: true, reason: `anchor_height ${ah} < BTC-leg height ${bh}: Sequentia leg is NOT yet bound to a Bitcoin block at/after your lock` };
  return { ok: true, anchor_height: ah, btc_height: bh };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The Sequentia tip's LIVE Bitcoin-anchor height, read from the LSP's public /anchor endpoint
// (the LSP runs a full txindex Sequentia node). Returns -1 on any error, so callers fall back
// to the maker snapshot rather than blocking.
async function fetchLiveAnchor(){
  try {
    const base = (typeof location !== 'undefined' ? location.origin : '') + '/lsp';
    const r = await fetch(base + '/anchor', { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j && j.ok && Number.isFinite(Number(j.anchor_height))) return Number(j.anchor_height);
  } catch {}
  return -1;
}

// The Bitcoin (testnet4) tip height — used only to decide when the refund window is close.
async function btcTipHeight(){
  try {
    const base = (typeof location !== 'undefined' ? location.origin : '') + '/testnet4/api';
    const r = await fetch(base + '/blocks/tip/height', { signal: AbortSignal.timeout(6000) });
    const h = Number((await r.text()).trim());
    if (Number.isFinite(h)) return h;
  } catch {}
  return -1;
}

// The anchor gate is a WAIT, not a dead-end. A lagging anchor (the parent-chain tip can be
// contested — e.g. testnet4's min-difficulty churn — so the committee correctly holds at the
// last uncontested height) clears as Bitcoin stabilizes and the committee anchors forward.
// Poll the live Sequentia anchor until it reaches the BTC-lock height (then claim), or bail to
// a refund only once the BTC refund window (T_btc) is close. Nothing is at risk while waiting:
// the preimage is never revealed until the gate passes.
async function awaitAnchor(){
  const MARGIN = 6;   // stop waiting when the BTC tip is within this many blocks of T_btc
  for (;;){
    if (!SWAP || SWAP.state === ST.FAILED || SWAP.state === ST.REFUNDED)
      return { ok: false, reason: 'swap no longer active' };
    const gate = verifyAnchor(await fetchLiveAnchor());
    if (gate.ok){
      SWAP.seq_leg.anchor_height = gate.anchor_height; saveSwap();   // persist the cleared anchor
      return gate;
    }
    const btcTip = await btcTipHeight();
    if (btcTip >= 0 && SWAP.btc_locktime && btcTip >= (Number(SWAP.btc_locktime) - MARGIN))
      return { ok: false, timedout: true, anchor_height: gate.anchor_height, btc_height: gate.btc_height,
        reason: `the parent-chain anchor did not reach your BTC-lock height (${gate.btc_height}) before your refund window; refund the BTC leg after block ${SWAP.btc_locktime}` };
    setStepStatus('anchor', `Waiting for the Bitcoin anchor to bury your lock (Sequentia tip anchored at ${gate.anchor_height} < your BTC height ${gate.btc_height}; the parent-chain tip is contested — this clears as Bitcoin stabilizes)…`, true);
    await sleep(20000);
  }
}

// ---- step 5: claim the Sequentia leg (reveals the preimage) ----
// Build the claim with the 6c-2 binding (IF/redeem branch, revealing s) and
// broadcast via the wallet's Sequentia esplora. The destination is a fresh
// wallet address' (unconfidential) scriptPubKey; the claim fee is an explicit
// Elements fee output (C.seqClaimFee atoms, default 100000 — the taker CLI's
// ClaimSEQLeg fee).
async function claimSeq(){
  if (!SWAP || !SWAP.seq_leg) throw new Error('no Sequentia leg to claim');
  const gate = verifyAnchor(await fetchLiveAnchor());   // confirm against the LIVE anchor at the moment of claim
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
  const gate = verifyAnchor(await fetchLiveAnchor());
  if (!gate.ok){ $('xswapErr').textContent = gate.lag
    ? 'not yet claimable: ' + gate.reason + ' (this clears as the Bitcoin anchor advances — the wallet retries automatically).'
    : 'cannot claim: ' + gate.reason; return; }
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
      if (!SWAP.courier) startPoll();   // courier: no RFQ poll; the maker claims BTC off-chain
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
  return map[state] || ['-', 'b-out'];
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
  // Courier swaps have no RFQ poll endpoint — the maker claims BTC off-chain and
  // the taker is done after its own SEQ claim — so never poll for them.
  if (!SWAP.courier && SWAP.swap_id && (SWAP.state === ST.SEQ_LOCKED || SWAP.state === ST.SEQ_CLAIMED)) startPoll();
}

function kvRow(k, v){
  const d = C.el('div','kv'); d.appendChild(C.el('span','k',k)); d.appendChild(C.el('span','v',v)); return d;
}
// Like kvRow but the value is shown in full (monospace, wrapping), selectable, and
// click-to-copy. Used for ids the user must act on (e.g. a swap_id to refund), where
// truncation would force manual transcription. The wallet is served over plain HTTP,
// a non-secure context where navigator.clipboard is unavailable, so fall back to the
// textarea + execCommand trick (same as index.html's btnCopy).
function kvRowCopy(k, value){
  const d = C.el('div','kv'); d.appendChild(C.el('span','k',k));
  const v = C.el('span','v'); v.textContent = value || '-';
  v.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;cursor:pointer;user-select:all';
  v.title = 'Click to copy';
  const fb = C.el('span','',''); fb.style.cssText = 'margin-left:6px;color:#3fb950;font-size:.8em;opacity:0;transition:opacity .15s';
  v.onclick = async () => {
    if (!value) return; let ok = false;
    try{ if (navigator.clipboard?.writeText){ await navigator.clipboard.writeText(value); ok = true; } }catch{}
    if (!ok){ const ta = document.createElement('textarea'); ta.value = value;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta);
      ta.focus(); ta.select(); try{ ok = document.execCommand('copy'); }catch{} document.body.removeChild(ta); }
    fb.textContent = ok ? 'Copied!' : 'Copy failed'; fb.style.opacity = '1';
    setTimeout(()=>{ fb.style.opacity = '0'; }, 1200);
  };
  d.appendChild(v); d.appendChild(fb); return d;
}
function short(s){ return s ? (String(s).slice(0,10) + '…' + String(s).slice(-6)) : '-'; }
function txLink(txid, parent){
  if (!txid) return '-';
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
  if (done && SWAP.swap_id && !SWAP.courier) body.push(kvRowCopy('Swap id', SWAP.swap_id));
  if (SWAP.seq_leg && SWAP.seq_leg.txid) body.push(kvRowHtml('Sequentia lock tx', txLink(SWAP.seq_leg.txid, false)));
  if (SWAP.state === ST.FAILED) body.push(errLine(SWAP.detail || 'propose failed'));
  const c = stepCard(2, SWAP.courier ? 'Maker locks the asset' : 'Propose to maker', done, active, body);
  // Courier swaps advance automatically (no manual propose); the RFQ path keeps
  // the explicit button.
  if (active && !SWAP.courier){
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
      body.push(okLine(`Anchor verified: anchor_height ${gate.anchor_height} ≥ your BTC-leg height ${gate.btc_height} - the Sequentia leg is bound to a Bitcoin block ≥ your BTC lock, so it can't outlive your BTC.`));
    } else {
      body.push(errLine('Anchor NOT verified: ' + (gate.reason || 'ordering not satisfied') + ' - do NOT claim; refund the BTC leg after T_btc instead.'));
    }
  }
  return stepCard(3, 'Verify anchor ordering', done, have && !done, body);
}
function stepClaimCard(){
  const have = !!(SWAP.seq_leg && SWAP.seq_leg.txid);
  const gate = have ? verifyAnchor() : { ok:false };
  const claimed = !!(SWAP.seq_claim_txid) || SWAP.state === ST.SEQ_CLAIMED || SWAP.state === ST.BTC_CLAIMED;
  const active = have && gate.ok && !claimed;
  const body = [ C.el('div','sub','Claim the Sequentia leg with your secret. This reveals the secret on-chain so the maker can claim your BTC - completing the atomic swap.') ];
  if (SWAP.seq_claim_txid) body.push(kvRowHtml('Sequentia claim tx', txLink(SWAP.seq_claim_txid, false)));
  const c = stepCard(4, 'Claim Sequentia leg', claimed, active, body);
  // Courier swaps claim automatically while the session is live; a manual button
  // appears only when resuming after a reload (XSESSION lost) so the user can
  // still complete the claim. The RFQ path always shows the button.
  if (active && (!SWAP.courier || !XSESSION)){
    const btn = C.el('button','primary', SWAP.courier ? 'Claim your asset' : 'Claim Sequentia leg');
    btn.id = 'btnXClaim'; btn.onclick = onClaimSeq;
    btn.style.marginTop = '10px'; c.appendChild(btn);
  } else if (have && !gate.ok && !claimed){
    c.appendChild(C.el('div','warn','Claiming is blocked until the anchor gate passes.'));
  }
  return c;
}
function stepDoneCard(){
  // For a courier swap the taker's side is complete once it has claimed the
  // asset (SEQ_CLAIMED): the maker then claims the BTC leg off-chain, which the
  // wallet does not poll for. The RFQ path waits for the on-chain BTC_CLAIMED.
  const done = SWAP.state === ST.BTC_CLAIMED || (SWAP.courier && SWAP.state === ST.SEQ_CLAIMED);
  const body = [ C.el('div','sub', SWAP.courier
    ? 'You have your asset. The maker uses your revealed secret to claim the BTC leg, finishing their side; your asset is settled (anchor-bound to Bitcoin - reverts only if Bitcoin does).'
    : 'The maker extracts your revealed secret and claims the BTC leg. The swap is then complete (anchor-bounded; reorgs only if Bitcoin does).') ];
  if (SWAP.btc_claim_txid) body.push(kvRowHtml('BTC claim tx (maker)', txLink(SWAP.btc_claim_txid, true)));
  if (SWAP.preimage) body.push(kvRow('Preimage revealed', short(SWAP.preimage)));
  if (SWAP.state === ST.REFUNDED){ body.push(okLine('Refunded: ' + (SWAP.detail || 'the BTC leg was refunded to you.'))); }
  if (done) body.push(okLine(SWAP.courier ? 'Swap complete - your asset is claimed and settled.' : 'Swap complete - both legs settled, linked by your secret.'));
  return stepCard(5, 'Done', done, !done && SWAP.state === ST.SEQ_CLAIMED, body);
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
  lockBtcLeg, propose, verifyAnchor, verifyLeg, claimSeq, pollOnce,
  takerDestSpkHex, broadcastSeqTx, startCountdown: () => {},
  // courier internals
  isForwardCrossOffer, bestForwardOffer, normCourierSeqLeg, fetchXquoteCourier, fetchXmarketsCourier,
  setUseCourier: (v) => { USE_COURIER = !!v; }, getUseCourier: () => USE_COURIER,
  // state accessors for the harness
  getSwap: () => SWAP, setSwap: (s) => { SWAP = s; saveSwap(); },
  setQuote: (q) => { LAST_XQUOTE = q; }, getQuote: () => LAST_XQUOTE,
  setMarkets: (m) => { XMARKETS = m.map(normMarket); },
  loadSwap, saveSwap, clearSwap, ST,
};
