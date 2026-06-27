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

let C = null;            // injected app context (see index.html initSwapTab)
let LAST_RQUOTE = null;  // the live reverse quote for the composer's selection
let SWAP = null;         // the persisted in-flight reverse swap
let POLL = null;         // setInterval handle for the state-machine driver
let COUNTDOWN = null;    // setInterval handle for the quote-expiry countdown
let CLAIMING = false;    // re-entrancy guard for the auto BTC claim

const LS_KEY = 'swk.sequentia.xrswap';   // localStorage key (distinct from xswap.js)

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

export function initXrswap(ctx){ C = ctx; }

// ---------------------------------------------------------------------------
// Composer bridge — the symmetric composer in swap.js gets a reverse quote
// through these exports, then hands it to openReverseFromComposer().
// ---------------------------------------------------------------------------
export async function fetchRMarkets(){
  const resp = await dexPost('/v1/xchain/markets', {});
  return (Array.isArray(pick(resp, 'markets')) ? pick(resp, 'markets') : []).map(normMarket);
}
// Quote SELLING `seqAtoms` of `seqAsset` for BTC.
export async function fetchRQuote(seqAsset, seqAtoms){
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
}

function startCountdown(){
  const { $ } = C; const el = $('xrExpiry'); if (!el) return;
  if (COUNTDOWN){ clearInterval(COUNTDOWN); COUNTDOWN = null; }
  const tick = () => {
    if (!LAST_RQUOTE || !LAST_RQUOTE.expires_at_unix || SWAP){ el.textContent = ''; return; }
    const secs = LAST_RQUOTE.expires_at_unix - Math.floor(Date.now()/1000);
    if (secs <= 0){ el.textContent = 'Quote expired — get a fresh quote.'; el.className = 'sub err';
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
    return { ok:false, reason:'maker BTC-leg script does not match the agreed terms — do not fund' };
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
  const q = LAST_RQUOTE;
  if (!q){ if ($('xrswapErr')) $('xrswapErr').textContent = 'get a quote first'; return; }
  const sm = C.assetMeta(q.market.seq_asset);
  const kv = [
    ['Network', 'Cross-chain: you SELL a Sequentia asset and receive BTC on the parent chain'],
    ['You sell', C.fmtAtoms(q.seq_amount, sm.precision) + ' ' + sm.ticker],
    ['You receive', C.fmtAtoms(q.btc_amount, 8) + ' BTC'],
    ['Maker fee', C.fmtAtoms(q.fee_btc, 8) + ' BTC'],
    ['How it works', 'The maker locks the BTC first; you then fund the asset, the maker reveals a secret to take the asset, and you use that secret to claim the BTC.'],
    ['Sequentia refund after', 'block ' + q.seq_locktime + ' (if the maker stalls, you reclaim your asset)'],
  ];
  const { m: modal, ok, st } = C.modalRows({ title: 'Start the sell (maker locks BTC)', kv });
  ok.onclick = async () => {
    ok.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>Asking the maker to lock BTC…';
    try {
      await openSwap(q);
      modal.remove();
      LAST_RQUOTE = null;
      renderStepper();
      startPoll();
      C.toast && C.toast('Maker locked the BTC leg — waiting for it to confirm.');
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}

// ---- step 3: fund the Sequentia asset leg ----
async function fundSeq(){
  if (!SWAP) throw new Error('no in-flight swap');
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
  const { txid } = await C.seqLeg.fund(redeem, SWAP.market.seq_asset, SWAP.seq_amount);
  SWAP.seq_fund_txid = txid;
  saveSwap();
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
      C.toast && C.toast('Asset leg funded and submitted — waiting for the maker to reveal the secret.');
    } catch (e){ st.className = 'status err'; st.textContent = 'Failed: ' + C.prettyErr(e); ok.disabled = false; }
  };
}

// ---- step 5/6: poll for the revealed secret, then claim the BTC leg ----
async function pollOnce(){
  if (!SWAP || !SWAP.swap_id) return;
  const resp = await dexPost('/v1/xchain/swap', { swap_id: SWAP.swap_id });
  const state = pick(resp, 'state'); if (state) SWAP.state = state;
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
    C.toast && C.toast('BTC leg claimed — swap complete:', { href:'/testnet4/tx/'+txid, label:String(txid).slice(0,18)+'…' });
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
      const fee = C.seqClaimFee != null ? Number(C.seqClaimFee) : 100000;
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
  return map[state] || ['—', 'b-out'];
}
function renderStepper(){
  const { $, el } = C;
  const wrap = $('xrStepper'); if (!wrap) return;
  if (!SWAP){ wrap.classList.add('hide'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hide');
  wrap.innerHTML = '';

  const sm = C.assetMeta(SWAP.market.seq_asset);
  const [blabel, bcls] = badge(SWAP.state);

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
  if (SWAP.seq_leg && ![ST.BTC_CLAIMED, ST.REFUNDED].includes(SWAP.state)){
    const rb = el('button','danger','Refund asset leg'); rb.onclick = onRefundSeq; row.appendChild(rb);
  }
  const ab = el('button','ghost', [ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state) ? 'Clear' : 'Abandon');
  ab.onclick = onAbandon; row.appendChild(ab);
  ctl.appendChild(row);
  const err = el('div','status err',''); err.id = 'xrswapErr'; err.style.marginTop = '6px'; ctl.appendChild(err);
  wrap.appendChild(ctl);

  // Keep the driver alive across a re-render if we're mid-flight and not terminal.
  if (SWAP.swap_id && ![ST.BTC_CLAIMED, ST.REFUNDED, ST.FAILED].includes(SWAP.state)) startPoll();
}

function stepOpenCard(){
  const done = !!SWAP.swap_id;
  const body = [
    C.el('div','sub','The maker locks BTC in an HTLC you can claim with the secret it will reveal, refundable by the maker only after T_btc.'),
  ];
  if (done) body.push(kvRow('Swap id', short(SWAP.swap_id)));
  if (SWAP.btc_leg && SWAP.btc_leg.txid) body.push(kvRowHtml('Maker BTC lock tx', txLink(SWAP.btc_leg.txid, true)));
  if (SWAP.state === ST.FAILED) body.push(errLine(SWAP.detail || 'open failed'));
  return stepCard(1, 'Maker locks BTC', done, !done, body);
}
function stepConfirmCard(){
  const locked = !!SWAP.swap_id;
  const done = SWAP.btc_leg_height > 0;
  const body = [ C.el('div','sub','Wait for the maker’s BTC lock to confirm so your Sequentia leg can anchor at or above it.') ];
  if (done) body.push(okLine('BTC leg confirmed at parent height ' + SWAP.btc_leg_height + '.'));
  else if (locked) body.push(C.el('div','status','Waiting for the maker’s BTC lock to confirm (testnet4 ~10 min blocks)…'));
  return stepCard(2, 'BTC lock confirms', done, locked && !done, body);
}
function stepFundCard(){
  const ready = SWAP.btc_leg_height > 0;
  const funded = !!(SWAP.seq_leg && SWAP.seq_leg.txid);
  const active = ready && !funded && ![ST.FAILED, ST.REFUNDED].includes(SWAP.state);
  const body = [ C.el('div','sub','Fund your asset in an HTLC the maker can take only by revealing the secret — which lets you claim the BTC.') ];
  if (SWAP.seq_leg && SWAP.seq_leg.txid) body.push(kvRowHtml('Asset leg tx', txLink(SWAP.seq_leg.txid, false)));
  const c = stepCard(3, 'Fund the asset leg', funded, active, body);
  if (active){
    const btn = C.el('button','primary','Fund asset leg'); btn.onclick = onFundSeq; btn.style.marginTop = '10px'; c.appendChild(btn);
  }
  return c;
}
function stepRevealCard(){
  const submitted = SWAP.state === ST.SEQ_SUBMITTED || !!SWAP.preimage || SWAP.state === ST.SEQ_CLAIMED || SWAP.state === ST.BTC_CLAIMED;
  const done = !!SWAP.preimage;
  const body = [ C.el('div','sub','The maker runs the anchor-ordering gate, then takes your asset leg — revealing the secret on Sequentia.') ];
  if (SWAP.seq_claim_txid) body.push(kvRowHtml('Maker asset-claim tx', txLink(SWAP.seq_claim_txid, false)));
  if (SWAP.preimage) body.push(kvRow('Secret revealed', short(SWAP.preimage)));
  return stepCard(4, 'Maker reveals the secret', done, submitted && !done, body);
}
function stepClaimCard(){
  const done = SWAP.state === ST.BTC_CLAIMED || !!SWAP.btc_claim_txid;
  const canClaim = !!SWAP.preimage && !done;
  const body = [ C.el('div','sub','Claim the maker’s BTC leg with the revealed secret — completing the swap (anchor-bounded; reverts only if Bitcoin reverts).') ];
  if (SWAP.btc_claim_txid) body.push(kvRowHtml('Your BTC claim tx', txLink(SWAP.btc_claim_txid, true)));
  if (SWAP.state === ST.REFUNDED) body.push(okLine('Refunded: ' + (SWAP.detail || 'your asset leg was refunded.')));
  if (done) body.push(okLine('Swap complete — you received BTC for your asset, linked by the secret.'));
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
function short(s){ return s ? (String(s).slice(0,10) + '…' + String(s).slice(-6)) : '—'; }
function txLink(txid, parent){
  if (!txid) return '—';
  const href = parent ? ('/testnet4/tx/' + txid) : ('/tx/' + txid);
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
