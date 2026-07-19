// ---------------------------------------------------------------------------
// SeqDEX REVERSE cross-chain (Sequentia-asset -> BTC) swap wizard.
//
// The mirror of xswap.js: there the taker BUYS an asset paying BTC; here the
// taker SELLS a Sequentia asset FOR BTC. Roles flip — the MAKER is the secret
// holder and locks the BTC leg FIRST; the taker funds the asset leg second and
// claims the BTC leg with the secret the maker reveals. It drives the daemon's
// reverse RPCs (seqdex.v1 XchainService, REST `/v1/xchain/reverse/*` + the shared
// `/v1/xchain/swap` poll).
//
// Flow (taker = this wallet), matching XchainSwapState:
//   1. Open      OpenReverseXchainSwap{quote_id, taker_btc_claim_pub,
//                taker_seq_refund_pub} -> the maker locks the BTC leg and returns
//                {btc_leg, H, maker_seq_claim_pub, maker_btc_refund_pub, T_btc>T_seq}.
//                We REVERIFY the BTC-leg redeemScript (claim=us, refund=maker, T_btc)
//                before trusting it. State BTC_LOCKED.
//   2. Confirm   poll GetXchainSwap until btc_leg_height > 0 (the maker broadcasts
//                its BTC leg at 0-conf on a live network; we wait for its conf so the
//                Sequentia block can anchor at/above it).
//   3. Fund SEQ  buildSeqHtlcRedeemScript(H, maker_seq_claim_pub, taker_seq_refund_pub,
//                T_seq) -> send the asset to that P2SH as an EXPLICIT output, confirm,
//                capture {txid,vout}. (Real money moves here — a structured review.)
//   4. Submit    SubmitReverseSeqLeg{swap_id, seq_leg} -> the maker admits it; its
//                watcher runs the anchor gate then CLAIMS it, revealing the secret.
//   5. Reveal    poll GetXchainSwap until `preimage` appears (state SEQ_CLAIMED).
//   6. Claim BTC btcLeg.claim(btc_leg, preimage) -> a testnet4 Bitcoin tx spending
//                the maker's BTC leg via the IF branch. State BTC_CLAIMED (done).
//   7. Refund    off-ramp: after T_seq, refund OUR asset leg (the ELSE/CLTV branch)
//                if the maker never claimed it.
//
// Swap state is persisted to localStorage so a reload can resume a claim or refund.
//
// Project UI rules honoured (same as xswap.js): SEQ equal standing (no privileged
// "native" hero — the asset shows by its registry ticker; BTC is the parent leg),
// reference-currency hints, and anchor-aware finality copy (never "instant").
// ---------------------------------------------------------------------------

import * as seqob from './seqob.js';
import * as xcourier from './xcourier.js';
import { sha256 } from './btc.js';

let C = null;            // injected app context (see index.html initSwapTab)
let LAST_RQUOTE = null;  // the live reverse quote for the composer's selection
let SWAP = null;         // the persisted in-flight reverse swap
let POLL = null;         // setInterval handle for the state-machine driver
let COUNTDOWN = null;    // setInterval handle for the quote-expiry countdown
let CLAIMING = false;    // re-entrancy guard for the auto BTC claim
let SETTLING = false;    // re-entrancy guard for the on-chain settle driver

const LS_KEY = 'swk.sequentia.xrswap';   // localStorage key (distinct from xswap.js)

// Transport: the SeqOB order-book COURIER (true) or the legacy RFQ daemon (false).
// The courier is the product direction; the RFQ path is kept as a fallback so the
// transport can be reverted without losing it. Everything below the transport —
// the client-side BTC/SEQ HTLC settlement (openSwap/verifyMakerBtcLeg/fundSeq/
// claimBtc + the C.btcLeg/C.seqLeg bridges) — is identical either way.
const USE_COURIER = true;

// The Sequentia esplora base, same origin-relative path index.html uses (/api).
// The reverse taker reads the maker's revealed preimage OFF-CHAIN from the maker's
// asset-leg claim here, so it never has to trust a courier message to learn the
// secret (a courier 'secret_revealed' is only a verified fast-path hint).
const SEQ_ESPLORA = (typeof location !== 'undefined' ? location.origin : '') + '/api';

const bytesToHex = (a) => { let s = ''; for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0'); return s; };
const hexToBytes = (h) => { if (!h) return new Uint8Array(0); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const sha256Hex = (hex) => bytesToHex(sha256(hexToBytes(hex)));

// Stepper states — the proto enum names the grpc-gateway emits.
const ST = {
  QUOTED:      'QUOTED',                            // local-only (pre-open)
  BTC_LOCKED:  'XCHAIN_SWAP_STATE_BTC_LOCKED',
  SEQ_SUBMITTED:'XCHAIN_SWAP_STATE_SEQ_SUBMITTED',
  SEQ_CLAIMED: 'XCHAIN_SWAP_STATE_SEQ_CLAIMED',
  BTC_CLAIMED: 'XCHAIN_SWAP_STATE_BTC_CLAIMED',
  REFUNDED:    'XCHAIN_SWAP_STATE_REFUNDED',
  FAILED:      'XCHAIN_SWAP_STATE_FAILED',
};

async function dexPost(path, body){
  const r = await fetch(C.XDEX + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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

function pick(obj, ...names){
  if (!obj) return undefined;
  for (const n of names){ if (obj[n] !== undefined) return obj[n]; }
  return undefined;
}
const big = v => BigInt(v == null ? 0 : v);
const num = v => (v == null ? 0 : Number(v));

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
function normBtcLeg(l){
  if (!l) return null;
  return {
    txid:          pick(l, 'txid'),
    vout:          num(pick(l, 'vout')),
    height:        Number(pick(l, 'height') ?? 0),
    redeem_script: pick(l, 'redeem_script', 'redeemScript'),
    amount:        big(pick(l, 'amount')),
    asset_id:      pick(l, 'asset_id', 'assetId') || '',
  };
}

// ---- localStorage persistence ----
function saveSwap(){
  try {
    if (!SWAP){ localStorage.removeItem(LS_KEY); return; }
    const ser = JSON.parse(JSON.stringify(SWAP, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    localStorage.setItem(LS_KEY, JSON.stringify(ser));
  } catch (e){ /* best-effort */ }
}
function loadSwap(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw){ SWAP = null; return; }
    const s = JSON.parse(raw);
    if (s.seq_amount != null) s.seq_amount = big(s.seq_amount);
    if (s.btc_amount != null) s.btc_amount = big(s.btc_amount);
    if (s.fee_btc != null)    s.fee_btc = big(s.fee_btc);
    if (s.btc_leg)            s.btc_leg.amount = big(s.btc_leg.amount);
    if (s.seq_leg && s.seq_leg.amount != null) s.seq_leg.amount = big(s.seq_leg.amount);
    SWAP = s;
  } catch (e){ SWAP = null; }
}
function clearSwap(){ SWAP = null; saveSwap(); }

export function initXrswap(ctx){
  C = ctx;
  // Point the order-book client at the relay base index.html injected (C.SEQOB),
  // falling back to same-origin /seqob.
  try { seqob.setSeqobBase(C.SEQOB || (C.XDEX ? C.XDEX.replace(/\/dex$/, '/seqob') : '/seqob')); } catch {}
}

// ---------------------------------------------------------------------------
// Courier offer discovery + settlement helpers (USE_COURIER path).
// ---------------------------------------------------------------------------

// Direction constants mirror internal/seqob/offer/sentinel.go.
const DIR_ASSET_TO_BTC = 1;   // reverse: taker sells the asset, maker gives BTC

function offerField(o, ...names){ for (const n of names){ if (o[n] !== undefined && o[n] !== null) return o[n]; } return undefined; }

// Find a verified reverse (ASSET_TO_BTC) cross offer to sell `seqAsset` into. The
// book pair is <asset>/BTC; a reverse offer is a maker BUY of the asset (it gives
// BTC). Picks the offer paying the most BTC per asset atom; whole-HTLC (the taker
// sells the offer's full asset amount).
async function findReverseOffer(seqAsset, seqAtoms){
  const book = await seqob.fetchBook(seqAsset, 'BTC');
  const offers = (book.offers || book.Offers || []).filter(o => {
    if (o._verified === false) return false;
    // Mirror the composer's book predicate (isReverseCrossOffer in xswap.js): a reverse offer is simply
    // one whose offer_asset is BTC (the maker gives BTC for the asset = a taker SELL). Daemon/relay-seeded
    // reverse offers carry NO cross_chain field (the maker keys/locktimes are minted per-lift), so the old
    // cross_chain.direction requirement returned null for exactly the seeded liquidity the ladder showed,
    // throwing "No one is buying this asset for BTC right now". Forward offers have want_asset==='BTC'
    // instead, so this never picks one up.
    return offerField(o, 'offer_asset', 'offerAsset') === 'BTC';
  });
  if (!offers.length) return null;
  const norm = (o) => {
    // reverse offer: offer_asset='BTC' (maker gives BTC), want_asset=the asset.
    const btc = big(offerField(o, 'offer_amount', 'offerAmount'));
    const asset = big(offerField(o, 'want_amount', 'wantAmount') || offerField(o, 'base_amount', 'baseAmount'));
    return { o, btc, asset, ratio: asset > 0n ? Number(btc) / Number(asset) : 0 };
  };
  const all = offers.map(norm).filter(x => x.btc > 0n && x.asset > 0n);
  if (!all.length) return null;
  const req = seqAtoms ? big(seqAtoms) : 0n;
  if (req <= 0n) return all.sort((a, b) => b.ratio - a.ratio);   // no size hint -> best price first ([0] best)
  // Whole-HTLC rail: pick the offer CLOSEST in size to the request (mirror the forward's bestForwardOffer)
  // so a small sell doesn't lift a huge offer, while staying within a price tolerance of the best rate.
  // Smallest offer that COVERS the request first, then the largest below it. Consent is still re-taken on
  // the chosen offer's exact whole-HTLC terms before any asset is funded.
  const bestRatio = all.reduce((m, x) => Math.max(m, x.ratio), 0);
  const pool0 = all.filter(x => bestRatio > 0 ? x.ratio >= bestRatio * 0.98 : true);
  const pool = pool0.length ? pool0 : all;
  const cmpAsc = (a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0);
  const covering = pool.filter(x => x.asset >= req).sort(cmpAsc);              // smallest covering first
  const below = pool.filter(x => x.asset < req).sort((a, b) => cmpAsc(b, a));  // then largest below
  return [...covering, ...below];
}

// Read the maker's revealed preimage OFF-CHAIN: find the tx that spent our funded
// asset leg (the maker's claim) via the Sequentia esplora, then extract the push
// whose sha256 equals the agreed hashlock H. Returns the preimage hex, or null if
// the leg is not yet spent / the preimage is not yet visible. Trust-minimising:
// the wallet learns the secret from the chain, never from a courier message alone.
async function readPreimageOnChain(seqLegTxid, vout, hashHex){
  try {
    const os = await fetch(`${SEQ_ESPLORA}/tx/${seqLegTxid}/outspend/${vout}`).then(r => r.ok ? r.json() : null);
    if (!os || !os.spent || !os.txid) return null;
    const stx = await fetch(`${SEQ_ESPLORA}/tx/${os.txid}`).then(r => r.ok ? r.json() : null);
    if (!stx) return null;
    const want = String(hashHex).toLowerCase();
    for (const vin of (stx.vin || [])){
      // Gather every data push from the P2SH scriptSig (and witness, defensively).
      const pushes = [];
      const asm = vin.scriptsig_asm || vin.scriptSig_asm || '';
      for (const tok of asm.split(/\s+/)){
        const m = /^OP_PUSHBYTES_\d+\s*$/.test(tok) ? null : (/^[0-9a-fA-F]{2,}$/.test(tok) ? tok : null);
        if (m) pushes.push(m.toLowerCase());
      }
      for (const w of (vin.witness || [])) if (/^[0-9a-fA-F]{2,}$/.test(w)) pushes.push(w.toLowerCase());
      for (const p of pushes){
        // Match ANY push whose sha256 equals H, not only 32-byte ones. The HTLC redeem has no
        // OP_SIZE guard, so a maker can claim the asset with a non-32-byte secret; gating on
        // p.length===64 meant the taker never recognised such a preimage on-chain and could not
        // claim the BTC (asset gone, BTC unclaimable). sha256(p)===H is the real, sufficient filter.
        if (sha256Hex(p) === want) return p;
      }
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Composer bridge — the symmetric composer in swap.js gets a reverse quote
// through these exports, then hands it to openReverseFromComposer().
// ---------------------------------------------------------------------------
export async function fetchRMarkets(){
  if (!USE_COURIER){
    const resp = await dexPost('/v1/xchain/markets', {});
    return (Array.isArray(pick(resp, 'markets')) ? pick(resp, 'markets') : []).map(normMarket);
  }
  // The order book has no separate "markets" list; a market exists iff a verified
  // reverse offer rests for the asset. The composer discovers per-asset at quote
  // time (fetchRQuote), so this returns an empty seed — callers tolerate it.
  return [];
}
// Quote SELLING `seqAtoms` of `seqAsset` for BTC. Over the courier there is no
// pre-quote round-trip: the price lives in the resting offer, and the load-bearing
// terms (maker keys, locktimes) are minted per-lift once the session opens. So the
// "quote" here carries the chosen OFFER and its fixed whole-HTLC amounts; the real
// terms arrive in the maker's btc_leg_locked during the lift.
export async function fetchRQuote(seqAsset, seqAtoms){
  if (!USE_COURIER){
    const resp = await dexPost('/v1/xchain/reverse/quote', { seq_asset: seqAsset, seq_amount: String(seqAtoms) });
    const q = {
      reverse: true,
      market: { btc_asset:'', seq_asset:seqAsset, name:'BTC / Sequentia asset' },
      quote_id:          pick(resp, 'quote_id', 'quoteId'),
      seq_amount:        big(pick(resp, 'seq_amount', 'seqAmount')),
      btc_amount:        big(pick(resp, 'btc_amount', 'btcAmount')),
      price_seq_per_btc: num(pick(resp, 'price_seq_per_btc', 'priceSeqPerBtc')),
      fee_btc:           big(pick(resp, 'fee_btc', 'feeBtc')),
      btc_locktime:      num(pick(resp, 'btc_locktime', 'btcLocktime')),
      seq_locktime:      num(pick(resp, 'seq_locktime', 'seqLocktime')),
      expires_at_unix:   Number(pick(resp, 'expires_at_unix', 'expiresAtUnix') || 0),
    };
    if (!(q.btc_locktime > q.seq_locktime))
      throw new Error(`maker returned a bad ordering: T_btc(${q.btc_locktime}) must exceed T_seq(${q.seq_locktime})`);
    return q;
  }
  const ranked = await findReverseOffer(seqAsset, seqAtoms);
  if (!ranked) throw new Error('No one is buying this asset for BTC right now. Try again later, or place a same-chain order.');
  const best = ranked[0];
  // T4 retry-down-book (reverse): the other reverse offers as fallbacks if the best maker doesn't
  // respond BEFORE it locks any BTC. Reverse price is BTC-per-asset (ratio), so HIGHER is better for
  // the seller; keep only offers within 2% of best's ratio (never route to a materially worse sale).
  // Each is whole-HTLC (its own size), so onOpen re-shows the confirm for the chosen fallback's terms.
  const RETRY_MAX = 3, PRICE_TOL = 0.02;
  const candidates = ranked.slice(1)
    .filter(x => best.ratio > 0 && x.ratio >= best.ratio * (1 - PRICE_TOL))
    .slice(0, RETRY_MAX)
    .map(x => ({ offer: x.o, seq_amount: x.asset, btc_amount: x.btc,
      price_seq_per_btc: x.ratio > 0 ? (Number(x.asset) / Number(x.btc)) : 0,
      expires_at_unix: Number(offerField(x.o, 'expires_at_unix', 'expiresAtUnix') || 0) }));
  return {
    reverse: true,
    offer: best.o,
    market: { btc_asset:'', seq_asset:seqAsset, name:'BTC / Sequentia asset' },
    seq_amount: best.asset,           // whole-HTLC: you sell the offer's full asset amount
    btc_amount: best.btc,             // and receive its BTC
    price_seq_per_btc: best.ratio > 0 ? (Number(best.asset) / Number(best.btc)) : 0,
    fee_btc: 0n,                       // the maker's fee is disclosed in its per-lift terms
    candidates,
    expires_at_unix: Number(offerField(best.o, 'expires_at_unix', 'expiresAtUnix') || 0),
  };
}
// Seed the wizard with a composer-supplied reverse quote and start the open step.
export function openReverseFromComposer(q){
  LAST_RQUOTE = q;
  renderStepper();
  startCountdown();
  onOpen();
}
// True when a reverse swap is persisted and not terminal.
export function hasInFlight(){
  loadSwap();
  if (!SWAP) return false;
  return ![ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state);
}
// Re-render an in-flight reverse swap (the composer resumes from here on tab entry).
export function renderReverse(){
  loadSwap();
  renderStepper();
  // Resume a courier swap's on-chain tail after a reload. Pre-funding courier swaps can't
  // resume the WS session, but nothing of ours is at risk there.
  if (SWAP && SWAP.courier && ![ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state)){
    if (SWAP.seq_leg){
      driveSettle();                       // asset leg confirmed: read the revealed secret + claim the BTC
    } else if (SWAP.seq_fund_txid){
      // RESUME GAP: the asset HTLC was BROADCAST (seq_fund_txid persisted) but the app died during
      // waitConf, before seq_leg was set. renderReverse used to skip this (it only checked seq_leg),
      // stranding the funded asset — the refund path also keys on seq_leg. Re-enter fundSeq: it is
      // idempotent (reuses seq_fund_txid, never re-funds), waits for the confirmation, sets seq_leg,
      // resubmits to the maker, then settles. Now the asset is always resumable AND refundable.
      fundSeq().then(() => driveSettle()).catch(() => { /* surfaced on the stepper; the CLTV refund off-ramp appears once seq_leg is set */ });
    }
  }
}

function startCountdown(){
  const { $ } = C; const el = $('xrExpiry'); if (!el) return;
  if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; }
  const tick = () => {
    if (!LAST_RQUOTE || !LAST_RQUOTE.expires_at_unix || SWAP){ el.textContent = ''; return; }
    const secs = LAST_RQUOTE.expires_at_unix - Math.floor(Date.now()/1000);
    if (secs <= 0){ el.textContent = 'Quote expired - get a fresh quote.'; el.className = 'sub err';
      if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; } return; }
    el.className = 'sub'; el.textContent = `Quote valid for ${secs}s`;
  };
  tick(); COUNTDOWN = setInterval(tick, 1000);
}

// ---- step 1: open (the maker locks the BTC leg) ----
// Recompute the BTC-leg redeemScript ourselves — it must be claimable by OUR claim
// key with the preimage and refundable by the MAKER only after T_btc. If it does
// not match, the maker's BTC leg is not the one we agreed to; never fund the asset.
function verifyMakerBtcLeg(){
  if (!SWAP || !SWAP.btc_leg) return { ok:false, reason:'no BTC leg yet' };
  const recomputed = C.wasm.buildSeqHtlcRedeemScript(
    SWAP.hash_hex, SWAP.taker_btc_claim_pub, SWAP.maker_btc_refund_pub, SWAP.btc_locktime);
  if (String(recomputed).toLowerCase() !== String(SWAP.btc_leg.redeem_script).toLowerCase())
    return { ok:false, reason:'maker BTC-leg script does not match the agreed terms - do not fund' };
  if (SWAP.btc_leg.amount < SWAP.btc_amount)
    return { ok:false, reason:`maker locked ${SWAP.btc_leg.amount} BTC atoms, less than the agreed ${SWAP.btc_amount}` };
  if (!(SWAP.btc_locktime > SWAP.seq_locktime))
    return { ok:false, reason:'bad timeout ordering (T_btc must exceed T_seq)' };
  return { ok:true };
}

async function openSwap(q){
  const btcClaim = C.btcLeg.claimKey();   // {public_key, secret_hex} — we claim the BTC leg with this
  const seqRefund = C.seqLeg.refundKey(); // {public_key, secret_hex} — we refund the asset leg with this
  const resp = await dexPost('/v1/xchain/reverse/open', {
    quote_id: q.quote_id,
    taker_btc_claim_pub: btcClaim.public_key,
    taker_seq_refund_pub: seqRefund.public_key,
  });
  const fail = pick(resp, 'fail', 'swap_fail', 'swapFail');
  if (fail) throw new Error((pick(fail,'code')||'FAIL') + ': ' + (pick(fail,'message')||'maker rejected the swap'));
  const opened = pick(resp, 'opened', 'reverse_xchain_swap_opened', 'reverseXchainSwapOpened');
  if (!opened) throw new Error('no ReverseXchainSwapOpened in open response');

  const btcLeg = normBtcLeg(pick(opened, 'btc_leg', 'btcLeg'));   // height is 0 on a live network (0-conf at open)
  SWAP = {
    reverse: true,
    state: ST.BTC_LOCKED,
    created: Date.now(),
    market: { btc_asset: q.market.btc_asset, seq_asset: q.market.seq_asset, name: q.market.name },
    quote_id: q.quote_id,
    swap_id: pick(opened, 'swap_id', 'swapId'),
    hash_hex: pick(opened, 'hash'),
    maker_seq_claim_pub: pick(opened, 'maker_seq_claim_pub', 'makerSeqClaimPub'),
    maker_btc_refund_pub: pick(opened, 'maker_btc_refund_pub', 'makerBtcRefundPub'),
    taker_btc_claim_pub: btcClaim.public_key,
    taker_btc_claim_secret: btcClaim.secret_hex,
    taker_seq_refund_pub: seqRefund.public_key,
    taker_seq_refund_secret: seqRefund.secret_hex,
    btc_locktime: num(pick(opened, 'btc_locktime', 'btcLocktime')) || q.btc_locktime,
    seq_locktime: num(pick(opened, 'seq_locktime', 'seqLocktime')) || q.seq_locktime,
    seq_amount: q.seq_amount,
    btc_amount: q.btc_amount,
    fee_btc: q.fee_btc,
    btc_leg: btcLeg,
    btc_leg_height: btcLeg ? btcLeg.height : 0,
  };
  const v = verifyMakerBtcLeg();
  if (!v.ok){ SWAP.state = ST.FAILED; SWAP.detail = 'swap aborted: ' + v.reason; saveSwap(); throw new Error(SWAP.detail); }
  saveSwap();
  return SWAP;
}
async function onOpen(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  const q0 = LAST_RQUOTE;
  if (!q0){ if ($('xrswapErr')) $('xrswapErr').textContent = 'get a quote first'; return; }
  // T4 (reverse): the quoted offer, then the price-bounded fallbacks (courier only). If the best maker
  // never locks any BTC, offer the next resting offer — each with its OWN confirm (a fallback is a
  // different whole-HTLC size, so consent is re-taken, never silently switched under the seller).
  const mkQuote = (c) => ({ reverse:true, offer:c.offer, market:q0.market, seq_amount:c.seq_amount,
    btc_amount:c.btc_amount, price_seq_per_btc:c.price_seq_per_btc, fee_btc:0n, expires_at_unix:c.expires_at_unix });
  const attempts = USE_COURIER ? [q0, ...((q0.candidates || []).map(mkQuote))] : [q0];

  for (let i = 0; i < attempts.length; i++){
    const q = attempts[i];
    const sm = C.assetMeta(q.market.seq_asset);
    const kv = USE_COURIER ? [
      ...(i > 0 ? [['Heads up', `the previous maker didn’t respond; this is the next best resting offer (${i} of ${attempts.length - 1})`]] : []),
      ['You sell', C.fmtAtoms(q.seq_amount, sm.precision) + ' ' + sm.ticker],
      ['You receive', C.fmtAtoms(q.btc_amount, 8) + ' BTC'],
      ['How it works', 'The maker locks the BTC first. Once it confirms, your wallet locks the asset, the maker takes it by revealing a secret, and your wallet uses that secret to claim the BTC - automatically. You only confirm here.'],
      ['You commit', 'your ' + sm.ticker + ' once the maker’s BTC lock confirms - until then nothing is spent'],
      ['If the maker stalls', 'your asset is refundable after the maker’s stated Sequentia timeout (the exact block is shown once the maker locks; the wizard offers the refund then, with a countdown)'],
      ['Settlement', 'the BTC you receive is anchor-bound to Bitcoin; it can revert only if Bitcoin itself reverts'],
    ] : [
      ['Network', 'Cross-chain: you SELL a Sequentia asset and receive BTC on the parent chain'],
      ['You sell', C.fmtAtoms(q.seq_amount, sm.precision) + ' ' + sm.ticker],
      ['You receive', C.fmtAtoms(q.btc_amount, 8) + ' BTC'],
      ['Maker fee', C.fmtAtoms(q.fee_btc, 8) + ' BTC'],
      ['How it works', 'The maker locks the BTC first; you then fund the asset, the maker reveals a secret to take the asset, and you use that secret to claim the BTC.'],
      ['Sequentia refund after', 'block ' + q.seq_locktime + ' (if the maker stalls, you reclaim your asset)'],
    ];
    const { m: modal, ok, st } = C.modalRows({ title: 'Sell ' + sm.ticker + ' for BTC', kv });

    // Wait for the user's Confirm or Cancel on THIS attempt.
    const go = await new Promise((resolve) => {
      ok.onclick = () => { ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Starting the swap…'; resolve(true); };
      const no = modal.querySelector('.ghost'); if (no) no.onclick = () => { modal.remove(); resolve(false); };
    });
    if (!go) return;   // user cancelled — stop the whole flow

    try {
      if (USE_COURIER){
        modal.remove();
        LAST_RQUOTE = null;
        const r = await driveReverse(q);   // auto-drives; returns 'retry' iff no maker locked (pre-lock)
        if (r === 'retry'){
          if (i < attempts.length - 1){ C.toast && C.toast('That maker didn’t respond - showing the next best offer.'); continue; }
          if (C.$('xrswapErr')) C.$('xrswapErr').textContent = `No maker responded${attempts.length > 1 ? ` (tried ${attempts.length} offers)` : ''}. Nothing was spent - try again shortly.`;
        }
        return;   // committed / settled / terminal — done
      } else {
        await openSwap(q);
        modal.remove();
        LAST_RQUOTE = null;
        renderStepper();
        startPoll();
        C.toast && C.toast('Maker locked the BTC leg - waiting for it to confirm.');
        return;
      }
    } catch (e){
      if (modal.isConnected){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
      else { renderStepper(); if (C.$('xrswapErr')) C.$('xrswapErr').textContent = 'Swap failed: ' + C.prettyErr(e); }
      return;   // a thrown error is terminal (post-lock, or RFQ path) — never auto-retry after a lock
    }
  }
}

// ---------------------------------------------------------------------------
// Courier auto-driver: one user confirmation, then the whole reverse handshake
// runs to settlement, updating the live stepper at each step. The COURIER carries
// only the negotiation + leg exchange; every value transfer is a client-side HTLC
// settlement (unchanged), and the revealed secret is read OFF-CHAIN, so no courier
// message is ever trusted with funds.
// ---------------------------------------------------------------------------
function setPhase(phase, detail){ if (SWAP){ SWAP.phase = phase; if (detail !== undefined) SWAP.detail = detail; saveSwap(); renderStepper(); } }

async function driveReverse(q){
  const btcClaim = C.btcLeg.claimKey();     // taker claims the maker BTC leg with the preimage
  const seqRefund = C.seqLeg.refundKey();   // taker refunds the asset leg after T_seq

  // 1. Open the courier session + get the maker's BTC lock. A failure HERE — the session won't open, or
  //    the maker never sends its BtcLegLocked within the fail-fast window — means NO maker committed any
  //    BTC, so return 'retry': onOpen can offer the next resting offer (T4). Once a leg IS received we
  //    are past this point and every later failure is terminal for THIS swap (the maker locked BTC; we
  //    never silently retry and strand it), handled by failAbort/return below exactly as before.
  let session;
  try { session = await xcourier.openCourierSession(q.offer, q.seq_amount, '', {}); }
  catch { return 'retry'; }
  let locked;
  try {
    await session.send({
      type: xcourier.XcType.TermsRequest,
      taker_seq_refund_pub: seqRefund.public_key,
      taker_btc_claim_pub: btcClaim.public_key,
    });
    // 2. The maker locks BTC first and sends terms + the BTC leg. Fail-fast (was 60s): a live maker
    //    locks within seconds, so 30s => move to the next resting offer instead of a long stall.
    locked = await session.recv(xcourier.XcType.BtcLegLocked, 30000);
  } catch { try { session.close(); } catch {} return 'retry'; }

  try {
    const leg = locked.leg || {};
    const tBtc = num(leg.locktime) || num(locked.btc_locktime);
    const tSeq = num(locked.seq_locktime);

    // 3. Build the swap and BIND the maker's terms to the offer we chose.
    SWAP = {
      reverse: true, courier: true, state: ST.BTC_LOCKED, created: Date.now(), phase: 'opening',
      market: { btc_asset: q.market.btc_asset, seq_asset: q.market.seq_asset, name: q.market.name },
      offer_id: q.offer.offer_id || q.offer.offerId,
      maker_pubkey: q.offer.maker_pubkey || q.offer.makerPubkey,
      hash_hex: locked.hash_h,
      maker_seq_claim_pub: locked.maker_seq_claim_pub,
      maker_btc_refund_pub: locked.maker_refund_pub,
      taker_btc_claim_pub: btcClaim.public_key,
      taker_btc_claim_secret: btcClaim.secret_hex,
      taker_seq_refund_pub: seqRefund.public_key,
      taker_seq_refund_secret: seqRefund.secret_hex,
      btc_locktime: tBtc, seq_locktime: tSeq,
      seq_amount: q.seq_amount, btc_amount: q.btc_amount,
      fee_btc: big(locked.fee_btc || 0),
      btc_leg: {
        txid: leg.txid, vout: num(leg.vout), height: 0,
        redeem_script: leg.redeem_script, amount: big(leg.amount), asset_id: '',
      },
      btc_leg_height: 0,
    };
    // Reject bad terms BEFORE funding: amounts must match the offer, script must
    // recompute, and the timelocks must be sane. Nothing is spent on abort.
    if (SWAP.btc_amount !== q.btc_amount){ await failAbort(session, 'terms_mismatch', 'the maker offered fewer sats than the order - nothing was spent'); return; }
    if (big(leg.amount) < q.btc_amount){ await failAbort(session, 'terms_mismatch', 'the maker locked less BTC than agreed - nothing was spent'); return; }
    const v = verifyMakerBtcLeg();
    if (!v.ok){ await failAbort(session, 'btc_leg_invalid', v.reason + ' - nothing was spent'); return; }
    setPhase('await_btc_conf');
    C.toast && C.toast('Maker locked the BTC leg - waiting for it to confirm.');

    // 4. Wait for the maker's BTC leg to confirm on our OWN node before we fund
    //    the asset (so the Sequentia leg anchors at/above it).
    const h = await waitMakerBtcConf(SWAP.btc_leg.txid, SWAP.btc_leg.redeem_script, tBtc);
    if (h == null) return;   // aborted (T_btc passed with no conf; nothing of ours spent)
    SWAP.btc_leg_height = h; SWAP.btc_leg.height = h; setPhase('funding');

    // 5. Fund our asset leg (real money moves here — the single consent above
    //    covered it) and announce it to the maker over the courier.
    const redeem = C.wasm.buildSeqHtlcRedeemScript(SWAP.hash_hex, SWAP.maker_seq_claim_pub, SWAP.taker_seq_refund_pub, SWAP.seq_locktime);
    SWAP.seq_redeem = redeem; saveSwap();
    let fundTxid = SWAP.seq_fund_txid;
    if (!fundTxid){ fundTxid = (await C.seqLeg.fund(redeem, SWAP.market.seq_asset, SWAP.seq_amount)).txid; SWAP.seq_fund_txid = fundTxid; saveSwap(); }
    const conf = await C.seqLeg.waitConf(fundTxid, redeem);
    SWAP.seq_leg = { txid: fundTxid, vout: conf.vout, redeem_script: redeem, amount: SWAP.seq_amount, asset_id: SWAP.market.seq_asset, block_hash: conf.block_hash, height: conf.height };
    SWAP.state = ST.SEQ_SUBMITTED; setPhase('await_reveal');
    await session.send({ type: xcourier.XcType.SeqLegFunded, leg: {
      txid: SWAP.seq_leg.txid, vout: SWAP.seq_leg.vout, amount: Number(SWAP.seq_amount),
      asset: SWAP.market.seq_asset, redeem_script: redeem, locktime: SWAP.seq_locktime,
      block_hash: conf.block_hash, anchor_height: conf.height,
    }});
    C.toast && C.toast('Asset leg funded - waiting for the maker to reveal the secret.');

    // 6. Fast path: the maker may courier a courtesy secret_revealed after it
    //    claims. Accept it only if it hashes to H (else it is worthless). The
    //    authoritative source is the on-chain read in driveSettle, so a withheld
    //    or bogus message costs us nothing.
    try {
      const rev = await session.recv(xcourier.XcType.SecretRevealed, 20000);
      if (rev && rev.preimage && sha256Hex(rev.preimage) === String(SWAP.hash_hex).toLowerCase()){ SWAP.preimage = rev.preimage; saveSwap(); }
    } catch { /* on-chain read will find it */ }
  } finally {
    session.close();
  }

  // 7. Settle on-chain (courier no longer needed): read the revealed secret from
  //    the maker's claim and claim the BTC leg. Resumable across reloads.
  driveSettle();
}

// failAbort: courier a fail note, mark the swap failed, surface it, and render.
async function failAbort(session, code, msg){
  try { await session.fail(code, msg); } catch {}
  if (SWAP){ SWAP.state = ST.FAILED; SWAP.detail = msg; saveSwap(); }
  renderStepper();
  if (C.$('xrswapErr')) C.$('xrswapErr').textContent = msg;
}

// waitMakerBtcConf polls our own node for the maker's BTC-leg confirmation.
// Returns the confirmation height, or null if T_btc passed first (abort — we
// never funded our asset, so nothing of ours is at risk).
async function waitMakerBtcConf(txid, redeemHex, tBtc){
  for (let i = 0; i < 600; i++){
    if (!SWAP || SWAP.state === ST.FAILED) return null;
    try {
      const f = await C.btcLeg.findFunding(txid, redeemHex);
      if (f && f.confirmed && f.height > 0){
        // FUND-SAFETY: verify the ACTUAL on-chain output value meets the agreed amount before we
        // fund our asset leg. verifyMakerBtcLeg only checked the maker-REPORTED btc_leg.amount; a
        // maker can report the agreed amount yet lock LESS on-chain. Since this runs BEFORE fundSeq,
        // an underfunded leg aborts with nothing of ours spent.
        if (BigInt(f.value) < BigInt(SWAP.btc_amount)){
          SWAP.state = ST.FAILED;
          SWAP.detail = `the maker's on-chain BTC lock (${f.value} sats) is less than the agreed ${SWAP.btc_amount} - nothing of yours was spent`;
          saveSwap(); renderStepper();
          return null;
        }
        if (SWAP.btc_leg){ SWAP.btc_leg.vout = f.vout; SWAP.btc_leg.amount = BigInt(f.value); }
        return f.height;
      }
    } catch { /* transient; keep polling */ }
    await new Promise(r => setTimeout(r, 8000));
  }
  SWAP.state = ST.FAILED; SWAP.detail = 'the maker’s BTC lock did not confirm in time - nothing of yours was spent'; saveSwap(); renderStepper();
  return null;
}

// driveSettle: the courier-independent tail. Poll for the revealed secret (fast
// path SWAP.preimage, else read it off the maker's on-chain asset-leg claim),
// then claim the BTC leg. Also the RESUME entrypoint after a reload once the
// asset leg is funded. Idempotent + re-entrancy-guarded.
async function driveSettle(){
  if (SETTLING) return;
  if (!SWAP || !SWAP.courier || !SWAP.seq_leg) return;
  if (SWAP.state === ST.BTC_CLAIMED || SWAP.state === ST.REFUNDED || SWAP.btc_claim_txid) return;
  SETTLING = true;
  stopPoll();
  POLL = setInterval(async () => {
    try {
      if (!SWAP || SWAP.btc_claim_txid || SWAP.state === ST.REFUNDED){ stopPoll(); SETTLING = false; return; }
      if (!SWAP.preimage){
        const pre = await readPreimageOnChain(SWAP.seq_leg.txid, SWAP.seq_leg.vout, SWAP.hash_hex);
        if (pre){ SWAP.preimage = pre; SWAP.state = ST.SEQ_CLAIMED; saveSwap(); renderStepper(); }
      }
      if (SWAP.preimage && !SWAP.btc_claim_txid){
        try { await claimBtc(); } catch (e){ if (C.$('xrswapErr')) C.$('xrswapErr').textContent = 'BTC claim retrying: ' + C.prettyErr(e); }
      }
      if (SWAP && SWAP.btc_claim_txid){ stopPoll(); SETTLING = false; renderStepper(); }
    } catch { /* transient; keep polling */ }
  }, 5000);
}

// ---- step 3: fund the Sequentia asset leg ----
async function fundSeq(){
  if (!SWAP) throw new Error('no in-flight swap');
  // Idempotent recovery: NEVER re-broadcast the asset HTLC. If the leg is already
  // funded + confirmed (e.g. a prior submit was rejected by the maker), just (re)submit.
  if (SWAP.seq_leg && SWAP.seq_leg.txid){ await submitSeq(); return SWAP; }
  if (SWAP.btc_leg_height <= 0) throw new Error('the maker BTC leg has not confirmed yet');
  const v = verifyMakerBtcLeg();
  if (!v.ok) throw new Error('BTC leg check failed: ' + v.reason);
  // Independent on-chain check: the maker's BTC funding output exists with the agreed value.
  const f = await C.btcLeg.findFunding(SWAP.btc_leg.txid, SWAP.btc_leg.redeem_script);
  if (f.value < SWAP.btc_amount) throw new Error('maker BTC output value is below the agreed amount');
  SWAP.btc_leg.vout = f.vout;   // trust our own lookup for the claim later

  // Build the asset-leg HTLC (claim = maker, refund = us, T_seq) and fund its P2SH.
  const redeem = C.wasm.buildSeqHtlcRedeemScript(
    SWAP.hash_hex, SWAP.maker_seq_claim_pub, SWAP.taker_seq_refund_pub, SWAP.seq_locktime);
  SWAP.seq_redeem = redeem;
  saveSwap();
  // Reuse a prior funding broadcast if one exists (don't double-fund); else fund now.
  let txid = SWAP.seq_fund_txid;
  if (!txid){
    txid = (await C.seqLeg.fund(redeem, SWAP.market.seq_asset, SWAP.seq_amount)).txid;
    SWAP.seq_fund_txid = txid;
    saveSwap();
  }
  // Wait for the funding tx to confirm and capture the HTLC vout.
  const conf = await C.seqLeg.waitConf(txid, redeem);
  SWAP.seq_leg = {
    txid, vout: conf.vout, redeem_script: redeem,
    amount: SWAP.seq_amount, asset_id: SWAP.market.seq_asset,
    block_hash: conf.block_hash, height: conf.height,
  };
  saveSwap();
  // Submit the funded leg to the maker.
  await submitSeq();
  return SWAP;
}
async function submitSeq(){
  const resp = await dexPost('/v1/xchain/reverse/submit', {
    swap_id: SWAP.swap_id,
    seq_leg: {
      txid: SWAP.seq_leg.txid, vout: SWAP.seq_leg.vout,
      redeem_script: SWAP.seq_leg.redeem_script,
      amount: SWAP.seq_leg.amount.toString(), asset_id: SWAP.seq_leg.asset_id,
    },
  });
  const fail = pick(resp, 'fail', 'swap_fail', 'swapFail');
  if (fail) throw new Error((pick(fail,'code')||'FAIL') + ': ' + (pick(fail,'message')||'maker rejected the asset leg'));
  const accepted = pick(resp, 'accepted', 'swap_accept', 'swapAccept');
  if (!accepted) throw new Error('no acceptance in submit response');
  SWAP.state = ST.SEQ_SUBMITTED;
  SWAP.detail = '';
  saveSwap();
  return SWAP;
}
async function onFundSeq(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  if (!SWAP){ return; }
  const sm = C.assetMeta(SWAP.market.seq_asset);
  const kv = [
    ['Network', 'Sequentia (testnet): you fund the asset in an HTLC the maker can take only with its secret'],
    ['You fund', C.fmtAtoms(SWAP.seq_amount, sm.precision) + ' ' + sm.ticker],
    ['You will receive', C.fmtAtoms(SWAP.btc_amount, 8) + ' BTC (claimed once the maker reveals the secret)'],
    ['Maker BTC lock', 'confirmed at parent height ' + SWAP.btc_leg_height + ' (verified)'],
    ['Sequentia refund after', 'block ' + SWAP.seq_locktime + ' (reclaim your asset if the maker never takes it)'],
    ['Atomicity', 'The maker can take your asset only by revealing the secret, which lets you claim the BTC.'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Fund the Sequentia asset leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Funding the asset leg…';
    try {
      await fundSeq();
      modal.remove();
      renderStepper();
      startPoll();
      C.toast && C.toast('Asset leg funded and submitted - waiting for the maker to reveal the secret.');
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}

// ---- step 5/6: poll for the revealed secret, then claim the BTC leg ----
// Wallet-set terminal states the daemon CANNOT see (the asset-leg refund and the BTC claim
// are off-daemon): once we're in one, polling the daemon would downgrade us back to
// BTC_LOCKED/SEQ_CLAIMED ("open"). Treat them as final locally.
function localTerminal(){ return SWAP && (SWAP.state === ST.REFUNDED || SWAP.state === ST.BTC_CLAIMED || SWAP.state === ST.FAILED); }
async function pollOnce(){
  if (!SWAP || !SWAP.swap_id) return;
  if (localTerminal()){ stopPoll(); return; }
  const resp = await dexPost('/v1/xchain/swap', { swap_id: SWAP.swap_id });
  // Guard the assignment too, in case this poll was already in flight when we went terminal.
  const state = pick(resp, 'state'); if (state && !localTerminal()) SWAP.state = state;
  const blh = Number(pick(resp, 'btc_leg_height', 'btcLegHeight') ?? 0);
  if (blh > 0 && (!SWAP.btc_leg_height || SWAP.btc_leg_height <= 0)) SWAP.btc_leg_height = blh;
  const pre = pick(resp, 'preimage'); if (pre) SWAP.preimage = pre;
  const sc = pick(resp, 'seq_claim_txid', 'seqClaimTxid'); if (sc) SWAP.seq_claim_txid = sc;
  const det = pick(resp, 'detail'); if (det) SWAP.detail = det;
  saveSwap();
}
async function claimBtc(){
  if (CLAIMING) return;
  if (!SWAP || !SWAP.preimage || !SWAP.btc_leg) return;
  if (SWAP.btc_claim_txid) return;
  CLAIMING = true;
  try {
    const txid = await C.btcLeg.claim({
      txid: SWAP.btc_leg.txid, vout: SWAP.btc_leg.vout,
      amount: SWAP.btc_leg.amount, redeem_script: SWAP.btc_leg.redeem_script,
      preimage: SWAP.preimage,
    });
    SWAP.btc_claim_txid = txid;
    SWAP.state = ST.BTC_CLAIMED;
    SWAP.detail = '';
    saveSwap();
    C.toast && C.toast('BTC leg claimed - swap complete:', { href:'/testnet4/tx/'+txid, label:String(txid).slice(0,18)+'…' });
    C.sync && C.sync().catch(()=>{});   // refresh balances (we received BTC, spent the asset)
  } finally { CLAIMING = false; }
}
async function onClaimBtc(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  try { await claimBtc(); renderStepper(); }
  catch (e){ if ($('xrswapErr')) $('xrswapErr').textContent = 'BTC claim failed: ' + C.prettyErr(e); }
}

function startPoll(){
  if (POLL) return;
  POLL = setInterval(async () => {
    try {
      await pollOnce();
      // Auto-claim the BTC leg as soon as the maker reveals the secret (time-sensitive).
      if (SWAP && SWAP.preimage && !SWAP.btc_claim_txid && SWAP.state !== ST.REFUNDED && SWAP.state !== ST.FAILED){
        try { await claimBtc(); } catch (e){ if (C.$('xrswapErr')) C.$('xrswapErr').textContent = 'Auto BTC claim failed (retry from the button): ' + C.prettyErr(e); }
      }
      renderStepper();
      if (SWAP && [ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state)) stopPoll();
    } catch (e){ /* transient; keep polling */ }
  }, 3000);
}
function stopPoll(){ if (POLL){ clearInterval(POLL); POLL = null; } }

// CLTV-gate the asset-leg refund by the SEQUENTIA tip: the refund tx is non-final (rejected) until the
// tip reaches seq_locktime. Disable with a live countdown until mature; enable once mature. Fail OPEN if
// the tip is unreadable (the on-chain spend still rejects a premature refund, so the user isn't blocked).
async function gateSeqRefundByCltv(btn, locktime){
  let tip = 0; try { tip = C.wollet ? Number(C.wollet.tip().height()) : 0; } catch {}
  if (!btn.isConnected) return;
  const remain = Number(locktime) - tip;
  if (!tip || remain <= 0){ btn.disabled = false; btn.title = 'Reclaim your locked asset (the refund timelock has matured).'; }
  else { btn.disabled = true; btn.title = `Refund unlocks at Sequentia block ${locktime}, about ${remain} more block${remain === 1 ? '' : 's'} away (~${remain} min).`; }
}
// ---- step 7: refund off-ramp (the asset leg, after T_seq) ----
async function onRefundSeq(){
  const { $ } = C;
  if ($('xrswapErr')) $('xrswapErr').textContent = '';
  if (!SWAP || !SWAP.seq_leg){ if ($('xrswapErr')) $('xrswapErr').textContent = 'no asset leg to refund'; return; }
  const sm = C.assetMeta(SWAP.market.seq_asset);
  const kv = [
    ['Network', '⚠ Sequentia: refunding YOUR funded asset leg via the CLTV branch'],
    ['Refund amount', C.fmtAtoms(SWAP.seq_amount, sm.precision) + ' ' + sm.ticker + ' (minus the refund fee)'],
    ['Valid after', 'block ' + SWAP.seq_locktime],
    ['Note', 'Only do this if the maker stalled and never took your asset leg (otherwise the secret is already out and you should claim the BTC instead).'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Refund the asset leg', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Refunding the asset leg…';
    try {
      // Defence in depth: the refund is non-final until the Sequentia tip reaches seq_locktime.
      let _tip = 0; try { _tip = C.wollet ? Number(C.wollet.tip().height()) : 0; } catch {}
      if (_tip && _tip < Number(SWAP.seq_locktime)){
        st.className = 'status err';
        st.textContent = `Not yet · the refund unlocks at Sequentia block ${SWAP.seq_locktime}, about ${Number(SWAP.seq_locktime) - _tip} block(s) away.`;
        ok.disabled = false; return;
      }
      // The refund tx pays its fee IN THE LOCKED ASSET (the HTLC holds only that asset — which could be
      // tSEQ or any other issued asset). Size it as the node's ABSTRACT REFERENCE feerate expressed in
      // THIS asset via its published rate, so every asset (tSEQ included) is treated the same. A valuable
      // asset needs very few atoms; a naive flat atom count would be a huge reference-value fee the node
      // rejects ("Fee exceeds maximum ... maxfeerate").
      let fee = 1;
      try {
        const asset = SWAP.market.seq_asset;
        const rate = Number(C.feeRateFor(asset));   // tSEQ is priced from the feed like every other asset — no SEQ=1 privilege
        const refFee = Math.ceil(C.DEFAULT_FEERATE * 350 / 1000);   // reference-unit fee for a ~350-vB refund tx
        fee = Math.max(1, Math.ceil(refFee * C.EXCHANGE_RATE_SCALE / rate));
      } catch {}
      { const amt = Number(SWAP.seq_amount); if (fee > Math.floor(amt/2)) fee = Math.max(1, Math.floor(amt/2)); }
      const txid = await C.seqLeg.refund({
        txid: SWAP.seq_leg.txid, vout: SWAP.seq_leg.vout, amount: SWAP.seq_amount,
        asset_id: SWAP.market.seq_asset, redeem_script: SWAP.seq_leg.redeem_script,
        locktime: SWAP.seq_locktime, refund_secret: SWAP.taker_seq_refund_secret,
        dest_spk: takerDestSpkHex(), fee,
      });
      SWAP.state = ST.REFUNDED; SWAP.seq_refund_txid = txid;
      SWAP.detail = 'asset leg refunded by you'; saveSwap();
      modal.remove(); renderStepper();
      C.toast && C.toast(`Asset leg refunded: ${String(txid).slice(0,18)}…`);
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}
// A fresh wallet receive-address scriptPubKey, unconfidential, as hex (refund dest).
function takerDestSpkHex(){
  const a = C.wollet.address(C.addrIndex == null ? undefined : C.addrIndex).address();
  const unconf = a.toUnconfidential ? a.toUnconfidential() : a;
  const bytes = unconf.scriptPubkey().bytes();
  return [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
}

function onAbandon(){
  loadSwap();
  // NEVER discard a reverse swap that still holds a locked ASSET leg: clearSwap() drops the
  // seq_leg outpoint (txid/vout/redeem/block) needed to build the CLTV asset refund, stranding
  // it. Keep the record + point at the Refund off-ramp until the asset is refunded or the taker
  // has already claimed the maker's BTC (terminal — nothing of ours left locked).
  const lockedUnrefunded = !!(SWAP && SWAP.seq_leg && SWAP.seq_leg.txid)
    && !SWAP.btc_claim_txid && SWAP.state !== ST.REFUNDED && SWAP.state !== ST.BTC_CLAIMED;
  if (lockedUnrefunded){
    try { C.toast && C.toast('Your asset is still locked in this swap. Refund it (after the timeout) before clearing — otherwise the reclaim data is lost.'); } catch {}
    return;
  }
  stopPoll(); clearSwap(); renderStepper();
  if (C.onExit) C.onExit();
}

// ---- stepper rendering ----
function badge(state){
  const map = {
    [ST.QUOTED]:       ['Quoted', 'b-out'],
    [ST.BTC_LOCKED]:   ['BTC locked', 'b-out'],
    [ST.SEQ_SUBMITTED]:['Asset submitted', 'b-out'],
    [ST.SEQ_CLAIMED]:  ['Secret revealed', 'b-in'],
    [ST.BTC_CLAIMED]:  ['Complete', 'b-in'],
    [ST.REFUNDED]:     ['Refunded', 'b-out'],
    [ST.FAILED]:       ['Failed', 'b-out'],
  };
  return map[state] || ['-', 'b-out'];
}
function renderStepper(){
  const { $, el } = C;
  const wrap = $('xrStepper'); if (!wrap) return;
  if (!SWAP){ wrap.classList.add('hide'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hide');
  wrap.innerHTML = '';

  const sm = C.assetMeta(SWAP.market.seq_asset);
  const [blabel, bcls] = badge(SWAP.state);

  // W6: once the sell finishes (BTC claimed), record a receipt in the shared completed-trade history
  // so it shows in the Active-trades card. logTrade dedups by id, so a re-render logs exactly once.
  if (SWAP.state === ST.BTC_CLAIMED && C.logTrade){
    C.logTrade({ id: 'xsell:' + (SWAP.session_id || SWAP.hash_hex || SWAP.btc_claim_txid || ''),
      title: 'Sold ' + C.fmtAtoms(SWAP.seq_amount || 0, sm.precision) + ' ' + sm.ticker + ' for BTC (cross-chain)',
      status: 'complete', txid: SWAP.btc_claim_txid || null });
  }

  const head = el('div','card');
  const hr = el('div','row');
  hr.appendChild(el('label','lbl', 'Cross-chain sell (asset → BTC)'));
  const b = el('span','badge ' + bcls, blabel); b.style.marginLeft = 'auto'; hr.appendChild(b);
  head.appendChild(hr);
  head.appendChild(kvRow('Selling', C.fmtAtoms(SWAP.seq_amount, sm.precision) + ' ' + sm.ticker));
  head.appendChild(kvRow('Receiving', C.fmtAtoms(SWAP.btc_amount, 8) + ' BTC'));
  head.appendChild(kvRow('Timeouts', `T_btc=${SWAP.btc_locktime} · T_seq=${SWAP.seq_locktime}`));
  head.appendChild(kvRow('Hashlock H', short(SWAP.hash_hex)));
  wrap.appendChild(head);

  wrap.appendChild(stepOpenCard());
  wrap.appendChild(stepConfirmCard());
  wrap.appendChild(stepFundCard());
  wrap.appendChild(stepRevealCard());
  wrap.appendChild(stepClaimCard());

  // Controls.
  const ctl = el('div','card');
  const stat = el('div','status',''); stat.id = 'xrStepStatus'; ctl.appendChild(stat);
  const row = el('div','row'); row.style.marginTop = '6px';
  // Refund the asset leg: offered once it is funded and the swap isn't done.
  // Refund off-ramp: only while NOT complete/refunded AND before the maker has claimed the asset. At
  // SEQ_CLAIMED the maker already took the asset leg (the secret is out), so a refund can only fail —
  // hide it (the user should claim the BTC instead). Gated on the Sequentia CLTV maturity + countdown.
  if (SWAP.seq_leg && ![ST.BTC_CLAIMED, ST.REFUNDED, ST.SEQ_CLAIMED].includes(SWAP.state)){
    const rb = el('button','danger','Refund asset leg'); rb.onclick = onRefundSeq;
    rb.disabled = true; rb.title = 'Checking the refund timelock…';
    row.appendChild(rb);
    gateSeqRefundByCltv(rb, SWAP.seq_locktime);
  }
  const ab = el('button','ghost', [ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state) ? 'Clear' : 'Abandon');
  ab.onclick = onAbandon; row.appendChild(ab);
  ctl.appendChild(row);
  const err = el('div','status err',''); err.id = 'xrswapErr'; err.style.marginTop = '6px'; ctl.appendChild(err);
  wrap.appendChild(ctl);

  // Keep the driver alive across a re-render if we're mid-flight and not terminal.
  const terminal = [ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state);
  if (!terminal){
    if (SWAP.courier){ if (SWAP.seq_leg) driveSettle(); }   // on-chain tail (courier needs no daemon poll)
    else if (SWAP.swap_id) startPoll();                      // RFQ daemon poll
  }
}

function stepOpenCard(){
  const done = !!SWAP.swap_id;
  const body = [
    C.el('div','sub','The maker locks BTC in an HTLC you can claim with the secret it will reveal, refundable by the maker only after T_btc.'),
  ];
  if (done) body.push(kvRowCopy('Swap id', SWAP.swap_id));
  if (SWAP.btc_leg && SWAP.btc_leg.txid) body.push(kvRowHtml('Maker BTC lock tx', txLink(SWAP.btc_leg.txid, true)));
  if (SWAP.state === ST.FAILED) body.push(errLine(SWAP.detail || 'open failed'));
  return stepCard(1, 'Maker locks BTC', done, !done, body);
}
function stepConfirmCard(){
  const locked = !!SWAP.swap_id;
  const done = SWAP.btc_leg_height > 0;
  const body = [ C.el('div','sub','Wait for the maker’s BTC lock to confirm so your Sequentia leg can anchor at or above it.') ];
  if (done) body.push(okLine('BTC leg confirmed at parent height ' + SWAP.btc_leg_height + '.'));
  else if (locked) body.push(C.el('div','status','Waiting for the maker’s BTC lock to confirm - one Bitcoin block, usually 10–20 minutes on testnet4.'));
  return stepCard(2, 'BTC lock confirms', done, locked && !done, body);
}
function stepFundCard(){
  const ready = SWAP.btc_leg_height > 0;
  const funded = !!(SWAP.seq_leg && SWAP.seq_leg.txid);
  const active = ready && !funded && ![ST.FAILED, ST.REFUNDED].includes(SWAP.state);
  const body = [ C.el('div','sub','Fund your asset in an HTLC the maker can take only by revealing the secret - which lets you claim the BTC.') ];
  if (SWAP.seq_leg && SWAP.seq_leg.txid) body.push(kvRowHtml('Asset leg tx', txLink(SWAP.seq_leg.txid, false)));
  const c = stepCard(3, 'Fund the asset leg', funded, active, body);
  // Courier swaps fund automatically; only the RFQ path shows a manual button.
  if (active && !SWAP.courier){
    const btn = C.el('button','primary','Fund asset leg'); btn.onclick = onFundSeq; btn.style.marginTop = '10px'; c.appendChild(btn);
  }
  return c;
}
function stepRevealCard(){
  const submitted = SWAP.state === ST.SEQ_SUBMITTED || !!SWAP.preimage || SWAP.state === ST.SEQ_CLAIMED || SWAP.state === ST.BTC_CLAIMED;
  const done = !!SWAP.preimage;
  const body = [ C.el('div','sub','The maker runs the anchor-ordering gate, then takes your asset leg - revealing the secret on Sequentia.') ];
  if (SWAP.seq_claim_txid) body.push(kvRowHtml('Maker asset-claim tx', txLink(SWAP.seq_claim_txid, false)));
  if (SWAP.preimage) body.push(kvRow('Secret revealed', short(SWAP.preimage)));
  return stepCard(4, 'Maker reveals the secret', done, submitted && !done, body);
}
function stepClaimCard(){
  const done = SWAP.state === ST.BTC_CLAIMED || !!SWAP.btc_claim_txid;
  const canClaim = !!SWAP.preimage && !done;
  const body = [ C.el('div','sub','Claim the maker’s BTC leg with the revealed secret - completing the swap (anchor-bounded; reverts only if Bitcoin reverts).') ];
  if (SWAP.btc_claim_txid) body.push(kvRowHtml('Your BTC claim tx', txLink(SWAP.btc_claim_txid, true)));
  if (SWAP.state === ST.REFUNDED) body.push(okLine('Refunded: ' + (SWAP.detail || 'your asset leg was refunded.')));
  if (done) body.push(okLine('Swap complete - you received BTC for your asset, linked by the secret.'));
  const c = stepCard(5, 'Claim your BTC', done, canClaim, body);
  if (canClaim){
    const btn = C.el('button','primary','Claim BTC now'); btn.onclick = onClaimBtc; btn.style.marginTop = '10px'; c.appendChild(btn);
  }
  return c;
}

// ---- small DOM helpers (mirroring xswap.js) ----
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
function kvRow(k, v){ const d = C.el('div','kv'); d.appendChild(C.el('span','k',k)); d.appendChild(C.el('span','v',v)); return d; }
function kvRowHtml(k, html){ const d = C.el('div','kv'); d.appendChild(C.el('span','k',k)); const v = C.el('span','v'); v.innerHTML = html; d.appendChild(v); return d; }
// Full-value, selectable, click-to-copy row (for ids the user must act on, e.g. swap_id).
// Plain-HTTP is a non-secure context (no navigator.clipboard), so fall back to execCommand.
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
function okLine(t){ const d = C.el('div','status ok'); d.textContent = t; return d; }
function errLine(t){ const d = C.el('div','status err'); d.textContent = t; return d; }

// Test-only exports: drive the reverse pipeline headlessly (no DOM).
export const __test__ = {
  dexPost, pick, normMarket, normBtcLeg, verifyMakerBtcLeg,
  openSwap, fundSeq, submitSeq, pollOnce, claimBtc,
  getSwap: () => SWAP, setSwap: (s) => { SWAP = s; saveSwap(); },
  setQuote: (q) => { LAST_RQUOTE = q; }, getQuote: () => LAST_RQUOTE,
  loadSwap, saveSwap, clearSwap, ST,
};
