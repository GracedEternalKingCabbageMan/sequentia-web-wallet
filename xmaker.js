// ---------------------------------------------------------------------------
// xmaker.js — CROSS-CHAIN (BTC <-> Sequentia asset) MAKER for the SeqOB order
// book. This is the piece that lets the WALLET self-start a cross market: post a
// signed cross offer, listen on the courier for a taker's lift, and run the
// maker side of the HTLC settlement. It is the inverse of the taker drivers
// (xswap.js forward-taker, xrswap.js reverse-taker) and mirrors the Go
// seqob-maker (cmd/seqob-maker + internal/seqob/client/xdriver*.go).
//
// FORWARD (this file's first direction, offer side = SELL, cross direction 0 =
// BTC_TO_ASSET): the maker SELLS a Sequentia asset for BTC. A taker BUYS it,
// paying BTC. Funding order: the TAKER funds the BTC leg first; the MAKER then
// locks the asset leg; the TAKER claims the asset (revealing the secret s); the
// MAKER claims the BTC leg with s. The anchor gate is the TAKER's concern here
// (the maker only attaches the advisory anchor height). Refund-on-stall: the
// maker reclaims its asset leg after the (shorter) SEQ locktime.
//
// Interactivity: a cross-chain HTLC is inherently interactive — the wallet must
// stay open to settle a lift. Bitcoin has no covenants, so this holds regardless
// of Simplicity (which could only make the Sequentia leg non-interactive). The
// UI surfaces this honestly.
//
// All HTLC settlement reuses the existing wallet leg bridges (C.btcLeg /
// C.seqLeg) and the HTLC-script wasm binding — only the maker ORCHESTRATION and
// the courier LISTEN (openMakerListener) are new.
// ---------------------------------------------------------------------------

import { XcType, openMakerListener } from './xcourier.js';
import * as seqob from './seqob.js';
import { sha256, secp256k1 } from './btc.js';
import { bytesToHex, hexToBytes } from './seqob.js';

// The maker identity key — the SAME per-browser key swap.js uses (localStorage
// 'seqobMakerKey'), so same-chain and cross offers share one maker pubkey. It
// signs offers + derives the per-lift E2E courier key; it is NOT a fund key.
function makerPriv(){
  let h = (typeof localStorage !== 'undefined') && localStorage.getItem('seqobMakerKey');
  if (!h || !/^[0-9a-f]{64}$/.test(h)){
    const a = new Uint8Array(32); (crypto || window.crypto).getRandomValues(a);
    h = [...a].map(b => b.toString(16).padStart(2,'0')).join('');
    try { localStorage.setItem('seqobMakerKey', h); } catch {}
  }
  return hexToBytes(h);
}
function makerPubHex(){ return bytesToHex(secp256k1.getPublicKey(makerPriv(), true)); }

let C = null;                       // injected app context (see index.html initXmaker)
const LIVE = new Map();             // offer_id -> { listener, offer, sessions:Map }
const LS_KEY = 'swk.sequentia.xmaker';   // persisted maker sessions (resume/refund watch)

const BTC_ESPLORA = () => (typeof location !== 'undefined' ? location.origin : '') + '/testnet4/api';
const SEQ_ESPLORA = () => (typeof location !== 'undefined' ? location.origin : '') + '/api';

const sha256Hex = (hex) => bytesToHex(sha256(hexToBytes(hex)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const big = (v) => BigInt(v == null ? 0 : v);

// Timing knobs (mirror the Go XcTiming, cmd/seqob-maker). Poll 5s; the taker has
// 2h to fund; give the SEQ lock/anchor gate their own windows.
const T = { poll: 5000, termsReqWait: 120000, btcFundWait: 2*60*60*1000, seqLockWait: 15*60*1000,
            anchorWait: 20*60*1000, minBtcConf: 1, seqClaimMargin: 10 };

const ANCHOR_BASE = () => (typeof location !== 'undefined' ? location.origin : '');
// A Sequentia block's Bitcoin-anchor height + the node's anchor status, SELF-DERIVED
// via the explorer's read-only /anchor endpoints (context-overridable for tests).
async function anchorHeightOf(blockHash){
  if (C && C.anchorHeightOf) return C.anchorHeightOf(blockHash);
  const a = await fetch(ANCHOR_BASE() + '/anchor/' + blockHash).then(r => r.ok ? r.json() : null);
  return a && a.anchorheight != null ? Number(a.anchorheight) : null;
}
async function anchorStatusOk(){
  if (C && C.anchorStatusOk) return C.anchorStatusOk();
  const s = await fetch(ANCHOR_BASE() + '/anchorstatus').then(r => r.ok ? r.json() : null);
  return !!(s && (s.anchorstatus === 'ok' || s.anchorStatus === 'ok'));
}

export function initXmaker(ctx){ C = ctx; if (C && C.SEQOB && seqob.setSeqobBase) seqob.setSeqobBase(C.SEQOB); }

async function tipHeight(base){
  const r = await fetch(base + '/blocks/tip/height');
  if (!r.ok) throw new Error('esplora tip ' + r.status);
  return parseInt((await r.text()).trim(), 10);
}
// Chain tips + the on-chain preimage read go through the context when it provides
// them (used by tests + lets the wallet supply a cached height), else esplora.
const btcTip = () => (C && C.btcTip) ? C.btcTip() : tipHeight(BTC_ESPLORA());
const seqTip = () => (C && C.seqTip) ? C.seqTip() : tipHeight(SEQ_ESPLORA());

// Read the secret s off the tx that SPENT the SEQ leg (the taker's claim). The
// claim scriptSig/witness carries the 32-byte preimage whose sha256 == H.
async function readPreimageOnChain(seqLegTxid, vout, hashHex){
  if (C && C.readPreimage) return C.readPreimage(seqLegTxid, vout, hashHex);
  try {
    const os = await fetch(`${SEQ_ESPLORA()}/tx/${seqLegTxid}/outspend/${vout}`).then(r => r.ok ? r.json() : null);
    if (!os || !os.spent || !os.txid) return null;
    const stx = await fetch(`${SEQ_ESPLORA()}/tx/${os.txid}`).then(r => r.ok ? r.json() : null);
    if (!stx) return null;
    const want = String(hashHex).toLowerCase();
    for (const vin of (stx.vin || [])){
      const pushes = [];
      const asm = vin.scriptsig_asm || vin.scriptSig_asm || '';
      for (const tok of asm.split(/\s+/)) if (/^[0-9a-fA-F]{2,}$/.test(tok)) pushes.push(tok.toLowerCase());
      for (const w of (vin.witness || [])) if (/^[0-9a-fA-F]{2,}$/.test(w)) pushes.push(w.toLowerCase());
      for (const p of pushes) if (p.length === 64 && sha256Hex(p) === want) return p;
    }
  } catch {}
  return null;
}

// --- persistence (best-effort; a maker settling while online is the norm, but
// persisting lets a reload resume the claim/refund watch). BigInt -> string. ---
function loadState(){ try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } }
function saveMakerSwap(st){
  try { const all = loadState(); all[st.session_id] = st; localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {}
}
function dropMakerSwap(sid){ try { const all = loadState(); delete all[sid]; localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch {} }

// ---------------------------------------------------------------------------
// Offer builder: a signed FORWARD (SELL asset for BTC) cross offer. Mirrors the
// Go buildCrossOffer (cmd/seqob-maker/main.go): pair base=asset, quote="BTC";
// offer_amount = asset given, want_amount = BTC wanted; cross_chain terms carry
// the DIRECTION and advisory maker fields (the real per-lift keys are minted at
// settle time). direction 0 = DirBTCToAsset = SELL.
// ---------------------------------------------------------------------------
export function buildForwardCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }){
  const now = Math.floor(nowUnix());
  const makerPub = makerPubHex();
  const offer = {
    offer_id: randHex16(),
    schema_version: 1,
    pair: { base_asset: assetHex, quote_asset: 'BTC' },
    offer_asset: assetHex, offer_amount: String(assetAtoms),
    want_asset: 'BTC',     want_amount: String(btcSats),
    base_amount: String(assetAtoms),
    allow_partial: false,                 // cross lifts are whole-HTLC
    created_at_unix: now,
    expires_at_unix: now + (expirySecs || 3600),
    min_anchor_depth: minAnchorDepth || 0,
    cross_chain: {
      btc_sentinel: 'BTC',
      maker_recv_address: recvAddr || '',
      maker_claim_pub: makerPub,          // advisory; real keys minted per-lift
      maker_refund_pub: makerPub,
      maker_leg_locktime: 144,
      direction: 0,                        // SELL: taker pays BTC, receives the asset
    },
  };
  return seqob.signOffer(offer, makerPriv());
}

// ---------------------------------------------------------------------------
// FORWARD maker settlement driver. Runs for ONE lift over an established
// CourierSession. `offer` is the resting offer the taker lifted.
// ---------------------------------------------------------------------------
export async function RunMakerForward(session, lift, offer, onState){
  const emit = (st) => { saveMakerSwap(st); try { onState && onState(st); } catch {} };
  const assetHex   = offer.pair.base_asset || offer.pair.baseAsset;
  const seqAmount  = big(offer.offer_amount || offer.offerAmount);   // asset atoms the maker gives
  const btcAmount  = big(offer.want_amount  || offer.wantAmount);    // sats the maker wants
  const baseAmount = big(offer.base_amount  || offer.baseAmount);

  // whole-HTLC: the lift must take the full resting size (mirror the daemon guard).
  if (lift.takeAmount !== baseAmount){ await session.fail('bad_take', 'cross lifts are whole-HTLC (take the full offer)'); return; }

  // 1. recv terms_request
  await session.recv(XcType.TermsRequest, T.termsReqWait);

  // 2. maker keys (the wallet's fixed HTLC keys; single-lift-at-a-time makes reuse
  //    across sequential lifts safe) + locktimes from the live chain tips.
  const makerBtcClaim  = C.btcLeg.claimKey();     // {public_key, secret_hex} — maker claims BTC with this
  const makerSeqRefund = C.seqLeg.refundKey();    // {public_key, secret_hex} — maker refunds the asset with this
  const btcLocktime = (await btcTip()) + 100;     // BtcLocktimeDelta (~16h parent blocks)
  const seqLocktime = (await seqTip()) + 240;     // SeqLocktimeDelta (~2h SEQ slots); T_seq < T_btc

  const st = {
    direction: 'forward', state: 'terms',
    offer_id: lift.offerId, session_id: lift.sessionId, asset: assetHex,
    seq_amount: seqAmount.toString(), btc_amount: btcAmount.toString(),
    maker_btc_claim: makerBtcClaim, maker_seq_refund: makerSeqRefund,
    btc_locktime: btcLocktime, seq_locktime: seqLocktime,
  };
  emit(st);   // persist keys/locktimes BEFORE anything moves

  // 3. send terms
  await session.send({
    type: XcType.Terms,
    maker_btc_claim_pub: makerBtcClaim.public_key,
    maker_refund_pub:    makerSeqRefund.public_key,   // forward: maker_refund_pub is the SEQ refund
    btc_locktime: btcLocktime, seq_locktime: seqLocktime,
    btc_amount: Number(btcAmount), seq_amount: Number(seqAmount), fee_btc: 0,
  });

  // 4. recv btc_leg_funded (taker funded BTC first)
  const bf = await session.recv(XcType.BtcLegFunded, T.btcFundWait);
  const hashH             = bf.hash_h || bf.hashH;
  const takerSeqClaimPub  = bf.taker_seq_claim_pub || bf.takerSeqClaimPub;
  const takerBtcRefundPub = bf.taker_btc_refund_pub || bf.takerBtcRefundPub;
  const bleg = bf.leg;
  if (!hashH || !takerSeqClaimPub || !takerBtcRefundPub || !bleg){ await session.fail('bad_funded', 'incomplete btc_leg_funded'); return; }
  if (big(bleg.amount) !== btcAmount){ await session.fail('bad_amount', 'btc leg amount != offer'); return; }

  // 5. verify the taker's BTC leg: re-derive the redeem (claim=maker, refund=taker,
  //    T_btc) byte-for-byte, then confirm the P2SH is funded with btc_amount.
  const btcRedeem = C.wasm.buildSeqHtlcRedeemScript(hashH, makerBtcClaim.public_key, takerBtcRefundPub, btcLocktime);
  if (String(btcRedeem).toLowerCase() !== String(bleg.redeem_script || bleg.redeemScript).toLowerCase()){
    await session.fail('bad_script', 'btc redeem script mismatch'); return;
  }
  let f = null; const deadline = nowMs() + T.seqLockWait;
  for (;;){
    try { f = await C.btcLeg.findFunding(bleg.txid, btcRedeem); } catch { f = null; }
    if (f && f.confirmed && big(f.value) === btcAmount) break;
    if (nowMs() > deadline){ await session.fail('btc_unconfirmed', 'taker BTC leg did not confirm in time'); return; }
    await sleep(T.poll);
  }
  st.hash_hex = hashH; st.taker_seq_claim_pub = takerSeqClaimPub; st.taker_btc_refund_pub = takerBtcRefundPub;
  st.btc_leg = { txid: bleg.txid, vout: f.vout, amount: btcAmount.toString(), redeem_script: btcRedeem, locktime: btcLocktime, height: f.height };
  st.state = 'btc_verified'; emit(st);

  // 6. lock the SEQ asset leg (claim = taker, refund = maker, T_seq)
  const seqRedeem = C.wasm.buildSeqHtlcRedeemScript(hashH, takerSeqClaimPub, makerSeqRefund.public_key, seqLocktime);
  const funded = await C.seqLeg.fund(seqRedeem, assetHex, seqAmount);   // -> { txid }
  st.seq_fund_txid = funded.txid; emit(st);
  const conf = await C.seqLeg.waitConf(funded.txid, seqRedeem);         // -> { vout, height, block_hash }
  st.seq_leg = { txid: funded.txid, vout: conf.vout, amount: seqAmount.toString(), asset: assetHex,
                 redeem_script: seqRedeem, locktime: seqLocktime, block_hash: conf.block_hash, anchor_height: conf.height };
  st.state = 'seq_locked'; emit(st);

  // 7. announce seq_leg_locked (courtesy; the leg is on-chain regardless)
  try {
    await session.send({ type: XcType.SeqLegLocked, leg: {
      txid: funded.txid, vout: conf.vout, amount: Number(seqAmount), asset: assetHex,
      redeem_script: seqRedeem, locktime: seqLocktime, block_hash: conf.block_hash, anchor_height: conf.height,
    }});
  } catch {}

  // 8. on-chain settle (no further courier dependency): watch for the taker's SEQ
  //    claim -> learn s -> claim the BTC leg with s. Refund the asset after T_seq.
  return await settleMakerForward(st, onState);
}

// The on-chain tail of a forward maker swap; also the resume entrypoint.
export async function settleMakerForward(st, onState){
  const emit = (s) => { saveMakerSwap(s); try { onState && onState(s); } catch {} };
  for (;;){
    // (a) did the taker claim the SEQ leg (revealing s)?
    const s = await readPreimageOnChain(st.seq_leg.txid, st.seq_leg.vout, st.hash_hex);
    if (s && sha256Hex(s) === String(st.hash_hex).toLowerCase()){
      st.secret_hex = s; st.state = 'secret_learned'; emit(st);
      const claimTxid = await C.btcLeg.claim({
        txid: st.btc_leg.txid, vout: st.btc_leg.vout, amount: Number(big(st.btc_leg.amount)),
        redeem_script: st.btc_leg.redeem_script, preimage: s,
      });
      st.btc_claim_txid = claimTxid; st.state = 'settled'; emit(st);
      dropMakerSwap(st.session_id);
      return { settled: true, btc_claim_txid: claimTxid };
    }
    // (b) refund branch: after T_seq the maker reclaims its own asset leg.
    let tip = 0; try { tip = await seqTip(); } catch {}
    if (tip && tip >= st.seq_locktime){
      const dest = C.seqLeg.refundDestSpk ? await C.seqLeg.refundDestSpk() : undefined;
      const refundTxid = await C.seqLeg.refund({
        txid: st.seq_leg.txid, vout: st.seq_leg.vout, amount: Number(big(st.seq_leg.amount)),
        asset_id: st.asset, redeem_script: st.seq_leg.redeem_script, locktime: st.seq_locktime,
        refund_secret: st.maker_seq_refund.secret_hex, dest_spk: dest, fee: 0,
      });
      st.seq_refund_txid = refundTxid; st.state = 'refunded'; emit(st);
      dropMakerSwap(st.session_id);
      return { settled: false, refunded: true, seq_refund_txid: refundTxid };
    }
    await sleep(15000);
  }
}

// ---------------------------------------------------------------------------
// Post a forward cross offer and serve lifts. Returns a handle:
//   { offer, close(), activeCount(), onState }  — close() stops listening +
//   removes the resting offer's lift route (the offer only rests while open).
// onState(cb) registers a settlement-progress callback for the UI stepper.
// ---------------------------------------------------------------------------
export async function startForwardMaker({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }, onState){
  const offer = buildForwardCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr });
  const rec = { offer, listener: null };
  const listener = await openMakerListener(offer, makerPriv(), async (session, lift) => {
    try { await RunMakerForward(session, lift, offer, onState); }
    catch (e){ try { await session.fail('maker_error', (e && e.message) || String(e)); } catch {} throw e; }
  });
  rec.listener = listener;
  LIVE.set(offer.offer_id, rec);
  return {
    offer,
    close: () => { try { listener.close(); } catch {} LIVE.delete(offer.offer_id); },
    activeCount: () => listener.activeCount(),
  };
}

export function liveMakerOffers(){ return [...LIVE.values()].map(r => r.offer); }

// ===========================================================================
// REVERSE maker (offer side = BUY, cross direction 1 = ASSET_TO_BTC): the maker
// BUYS a Sequentia asset with BTC. A taker SELLS it for BTC. Funding order: the
// MAKER funds the BTC leg first and HOLDS THE SECRET; the taker funds the asset
// leg; the maker runs the anchor gate on its OWN self-derived view (never the
// taker's claim), then claims the asset REVEALING s; the taker claims the BTC
// with s. Refund-on-stall: the maker reclaims its BTC after the (longer) T_btc.
// Because it holds the secret, the anchor gate here is SELF-DERIVED and mandatory.
// ===========================================================================
export function buildReverseCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }){
  const now = Math.floor(nowUnix());
  const makerPub = makerPubHex();
  const offer = {
    offer_id: randHex16(), schema_version: 1,
    pair: { base_asset: assetHex, quote_asset: 'BTC' },
    offer_asset: 'BTC',     offer_amount: String(btcSats),      // maker gives BTC
    want_asset: assetHex,   want_amount: String(assetAtoms),    // maker wants the asset
    base_amount: String(assetAtoms),
    allow_partial: false, created_at_unix: now, expires_at_unix: now + (expirySecs || 3600),
    min_anchor_depth: minAnchorDepth || 0,
    cross_chain: {
      btc_sentinel: 'BTC', maker_recv_address: recvAddr || '',
      maker_claim_pub: makerPub, maker_refund_pub: makerPub, maker_leg_locktime: 144,
      direction: 1,   // BUY: taker pays the asset, receives BTC
    },
  };
  return seqob.signOffer(offer, makerPriv());
}

export async function RunMakerReverse(session, lift, offer, onState){
  const emit = (st) => { saveMakerSwap(st); try { onState && onState(st); } catch {} };
  const assetHex   = offer.pair.base_asset || offer.pair.baseAsset;
  const seqAmount  = big(offer.want_amount  || offer.wantAmount);    // asset atoms the maker BUYS
  const btcAmount  = big(offer.offer_amount || offer.offerAmount);   // sats the maker PAYS
  const baseAmount = big(offer.base_amount  || offer.baseAmount);
  if (lift.takeAmount !== baseAmount){ await session.fail('bad_take', 'cross lifts are whole-HTLC'); return; }

  // 1. recv terms_request — BOTH taker keys are required (the BTC HTLC's claim
  //    branch pays the taker; the SEQ HTLC's refund branch pays the taker).
  const tr = await session.recv(XcType.TermsRequest, T.termsReqWait);
  const takerSeqRefundPub = tr.taker_seq_refund_pub || tr.takerSeqRefundPub;
  const takerBtcClaimPub  = tr.taker_btc_claim_pub  || tr.takerBtcClaimPub;
  if (!takerSeqRefundPub || !takerBtcClaimPub){ await session.fail('bad_terms_req', 'terms_request missing taker keys'); return; }

  // 2. mint the secret (the maker holds it) + keys + locktimes. PERSIST FIRST —
  //    the secret is the crown jewel; it must survive a reload before any coins move.
  const sec = C.wasm.generateSwapSecret();          // {secret_hex, hash_hex}
  const makerSeqClaim  = C.signer.htlcKeypair();    // maker claims the asset with this (reveals s)
  const makerBtcRefund = C.btcLeg.refundKey();      // maker refunds its BTC leg with this
  const btcLocktime = (await btcTip()) + 100;
  const seqLocktime = (await seqTip()) + 240;       // T_seq < T_btc
  const st = {
    direction: 'reverse', state: 'terms', offer_id: lift.offerId, session_id: lift.sessionId, asset: assetHex,
    seq_amount: seqAmount.toString(), btc_amount: btcAmount.toString(),
    hash_hex: sec.hash_hex, secret_hex: sec.secret_hex,
    maker_seq_claim: makerSeqClaim, maker_btc_refund: makerBtcRefund,
    taker_seq_refund_pub: takerSeqRefundPub, taker_btc_claim_pub: takerBtcClaimPub,
    btc_locktime: btcLocktime, seq_locktime: seqLocktime,
  };
  emit(st);

  // 3. LockBTCLeg FIRST — maker funds BTC: claim=taker, refund=maker, T_btc.
  const btcRedeem = C.wasm.buildSeqHtlcRedeemScript(sec.hash_hex, takerBtcClaimPub, makerBtcRefund.public_key, btcLocktime);
  const funded = await C.btcLeg.fund(btcRedeem, Number(btcAmount), btcLocktime, makerBtcRefund);   // {txid,vout,height,amount}
  st.btc_leg = { txid: funded.txid, vout: funded.vout, amount: btcAmount.toString(), redeem_script: btcRedeem, locktime: btcLocktime, height: funded.height || 0 };
  st.state = 'btc_locked'; emit(st);

  // 4. send btc_leg_locked (the terms ride here). Announce failure is FATAL — the
  //    BTC is already locked, so on any error the maker just refunds after T_btc.
  try {
    await session.send({ type: XcType.BtcLegLocked, hash_h: sec.hash_hex,
      maker_seq_claim_pub: makerSeqClaim.public_key, maker_refund_pub: makerBtcRefund.public_key,
      seq_locktime: seqLocktime, btc_amount: Number(btcAmount), seq_amount: Number(seqAmount), fee_btc: 0,
      leg: { txid: funded.txid, vout: funded.vout, amount: Number(btcAmount), redeem_script: btcRedeem, locktime: btcLocktime } });
  } catch (e){ return await refundReverseBtc(st, onState, 'could not announce btc_leg_locked: ' + (e.message||e)); }

  // 5. recv seq_leg_funded (the taker funds the asset leg against our BTC lock).
  let sf;
  try { sf = await session.recv(XcType.SeqLegFunded, T.btcFundWait); }
  catch (e){ return await refundReverseBtc(st, onState, 'taker never funded the asset leg: ' + (e.message||e)); }
  const sleg = sf.leg;
  if (!sleg || !sleg.txid){ return await refundReverseBtc(st, onState, 'seq_leg_funded had no leg'); }

  // 6. Verify the taker's SEQ leg on-chain: re-derive the redeem (claim=maker,
  //    refund=taker, T_seq), self-derive the funding vout/block (never trust the
  //    courier), and value-bind (asset + >= agreed amount) so a dust/wrong-asset
  //    leg can't trick us into revealing s.
  const seqRedeem = C.wasm.buildSeqHtlcRedeemScript(sec.hash_hex, makerSeqClaim.public_key, takerSeqRefundPub, seqLocktime);
  let conf; try { conf = await C.seqLeg.waitConf(sleg.txid, seqRedeem); }
  catch (e){ return await refundReverseBtc(st, onState, 'taker asset leg did not confirm: ' + (e.message||e)); }
  const out = C.seqLeg.readOutput ? await C.seqLeg.readOutput(sleg.txid, conf.vout) : null;
  if (!out){ return await refundReverseBtc(st, onState, 'could not read the taker asset leg output (blinded/unreadable) — not revealing'); }
  if (out.asset !== assetHex){ await session.fail('bad_asset', 'taker locked the wrong asset'); return await refundReverseBtc(st, onState, 'taker locked the wrong asset'); }
  if (out.value < seqAmount){ await session.fail('bad_amount', 'taker locked less than agreed'); return await refundReverseBtc(st, onState, 'taker locked less than agreed'); }
  st.seq_leg = { txid: sleg.txid, vout: conf.vout, amount: seqAmount.toString(), asset: assetHex, redeem_script: seqRedeem, locktime: seqLocktime, block_hash: conf.block_hash, seq_height: conf.height };
  st.state = 'seq_verified'; emit(st);

  // 7. measure our OWN BTC-leg confirmation height Hp.
  let hp = Number(st.btc_leg.height) || 0;
  if (!hp){ try { const f = await C.btcLeg.findFunding(st.btc_leg.txid, btcRedeem); if (f && f.confirmed) hp = Number(f.height); } catch {} }
  if (!hp){ return await refundReverseBtc(st, onState, 'our BTC leg has not confirmed; not revealing'); }

  // 8. ANCHOR GATE (self-derived, mandatory): the taker's asset block must anchor
  //    at a Bitcoin height >= our BTC-leg height, and the node's anchor status ok,
  //    so a Bitcoin reorg that could undo our BTC lock also undoes the asset leg.
  const deadline = nowMs() + T.anchorWait;
  for (;;){
    let ah = null, okStatus = false;
    try { ah = await anchorHeightOf(conf.block_hash); } catch {}
    try { okStatus = await anchorStatusOk(); } catch {}
    if (ah != null && ah >= hp && okStatus) break;
    if (nowMs() > deadline) return await refundReverseBtc(st, onState, `anchor gate failed (anchor ${ah} < BTC ${hp} or status not ok); not revealing`);
    await sleep(T.poll);
  }

  // 9. no-reveal margin: never reveal so close to T_seq that our claim could miss
  //    its window (leaving s leaked with the asset already refundable to the taker).
  if ((await seqTip()) + T.seqClaimMargin >= seqLocktime){
    return await refundReverseBtc(st, onState, 'too close to the asset locktime; not revealing');
  }

  // 10. claim the asset leg — REVEALS s on-chain.
  const claimTxid = await C.seqLeg.claim({
    txid: st.seq_leg.txid, vout: st.seq_leg.vout, amount: Number(seqAmount),
    asset_id: assetHex, redeem_script: seqRedeem, claim_secret: makerSeqClaim.secret_hex, secret_hex: sec.secret_hex,
  });
  st.seq_claim_txid = claimTxid; st.state = 'settled'; emit(st);

  // 11. courtesy secret_revealed (the taker also reads s off our claim scriptSig).
  try { await session.send({ type: XcType.SecretRevealed, preimage: sec.secret_hex }); } catch {}
  dropMakerSwap(st.session_id);
  return { settled: true, seq_claim_txid: claimTxid };
}

// Refund the maker's BTC leg after T_btc (the reverse stall path). Safe because
// s is never revealed on any path that reaches here; T_seq < T_btc, so the taker's
// asset refund window is already open by the time our BTC refund is spendable.
async function refundReverseBtc(st, onState, reason){
  const emit = (s) => { saveMakerSwap(s); try { onState && onState(s); } catch {} };
  st.refund_reason = reason; st.state = 'refunding'; emit(st);
  for (;;){
    let tip = 0; try { tip = await btcTip(); } catch {}
    if (tip && tip >= st.btc_locktime){
      const txid = await C.btcLeg.refund({
        txid: st.btc_leg.txid, vout: st.btc_leg.vout, amount: Number(big(st.btc_leg.amount)),
        redeem_script: st.btc_leg.redeem_script, locktime: st.btc_locktime,
      });
      st.btc_refund_txid = txid; st.state = 'refunded'; emit(st); dropMakerSwap(st.session_id);
      return { settled: false, refunded: true, btc_refund_txid: txid, reason };
    }
    await sleep(30000);
  }
}

export async function startReverseMaker({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr }, onState){
  const offer = buildReverseCrossOffer({ assetHex, assetAtoms, btcSats, expirySecs, minAnchorDepth, recvAddr });
  const listener = await openMakerListener(offer, makerPriv(), async (session, lift) => {
    try { await RunMakerReverse(session, lift, offer, onState); }
    catch (e){ try { await session.fail('maker_error', (e && e.message) || String(e)); } catch {} throw e; }
  });
  LIVE.set(offer.offer_id, { offer, listener });
  return { offer, close: () => { try { listener.close(); } catch {} LIVE.delete(offer.offer_id); }, activeCount: () => listener.activeCount() };
}

// --- small utils (no Date.now-in-tests concern; browser only) ---
function nowUnix(){ return Math.floor(Date.now() / 1000); }
function nowMs(){ return Date.now(); }
function randHex16(){ const a = new Uint8Array(8); (crypto || window.crypto).getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2,'0')).join(''); }

export const __test__ = { RunMakerForward, settleMakerForward, buildForwardCrossOffer, RunMakerReverse, buildReverseCrossOffer, readPreimageOnChain, sha256Hex, setC: (c) => { C = c; } };
