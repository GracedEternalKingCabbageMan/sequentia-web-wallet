// bridge-maker.mjs — the LSP's MAKER HANDSHAKE for a rail-crossing bridged take.
//
// WHERE THIS SITS. settlement-router.planSettlement decides WHICH legs cross; leg-bridge.nextBridgeStep
// is the pure fund-safety decision core for ONE crossed leg; bridge-driver.runBridgedSwap coordinates the
// whole swap on one shared H. Those are all PURE. This module is the one piece that actually TALKS to the
// live maker fleet: it drives the EXISTING cross-chain courier (xcourier.js — the same relay lift the
// wallet's xswap.js/xrswap.js couriers use) so the LSP becomes the counterparty on the CROSSED leg while
// the real taker keeps its own legs self-custody.
//
// THE ONE COHERENT CONSTRUCTION (see the report + the maker code in seqob-cli xdriver_reverse.go).
// A live `seqob-maker -mode cross` NEVER lets a counterparty pick BOTH "lock your BTC to THIS pubkey" AND
// "on THIS hash H" on the same leg:
//   • a REVERSE (buy) offer lets the taker dictate the maker's BTC *claim pubkey* (taker_btc_claim_pub),
//     but the maker mints H itself;
//   • a FORWARD (sell) offer lets the taker dictate H (and the asset claim pubkey), but there the maker
//     funds only the ASSET leg — the taker funds BTC.
// So the fund-safe bridged shape the io already wires (its value-moves fund/claim a BTC on-chain HTLC and
// pay/settle an LN hold) is: taker SELLS the asset and RECEIVES BTC over Lightning, against a REVERSE
// (buy) cross maker whose BTC leg is on-chain. Concretely:
//   • BTC leg  = BRIDGED, lnSide 'receiver'. The LSP hands the maker its OWN btc-claim pubkey, so the
//     maker locks a real on-chain BTC HTLC whose claim branch pays the LSP on the maker's H. The LSP pays
//     the taker over LN (their hold on that same H) and RECOUPS by claiming that BTC HTLC — bounded to
//     exactly what it fronted. leg-bridge.stepReceiverLn drives it: front only after the recoup is locked
//     to the LSP with runway, then claim with the revealed P. Fund-safe even though the maker (not the
//     taker) minted H, because the core ALWAYS fronts the LN BEFORE it recoups — the taker is paid first.
//   • asset leg = NATIVE on-chain. The real taker funds a Sequentia-asset HTLC to the maker's asset claim
//     pubkey with its OWN keys (the LSP never holds a taker key) and the maker claims it. The LSP only
//     RELAYS the taker's funded asset leg into the maker session (XcSeqLegFunded) — never funds it.
//
// This module is I/O-light and TESTABLE: the handshake is a pure function over an injected CourierSession
// (xcourier.js's session already takes an injectable transport), so the message flow + the fund-safety
// verification of the maker's leg are unit-tested with a scripted fake maker, no node. The one impure
// helper (openReverseBridgeSession) just opens the real relay WS.

import { XcType, CourierSession, openCourierSession } from '../../xcourier.js';
import { setSeqobBase, bytesToHex, hexToBytes } from '../../seqob.js';
import { secp256k1 } from '../../btc.js';
import { LOCKTIME_THRESHOLD } from './leg-bridge.mjs';

export const BRIDGE_MAKER_DEFAULTS = Object.freeze({
  termsWaitMs: 120000,     // the maker mints terms + locks its BTC leg within a couple of minutes
  secretWaitMs: 900000,    // after we relay the taker's asset leg, the maker claims it (reveals P)
});

// ---------------------------------------------------------------------------
// Fund-safety: verify the maker's on-chain BTC HTLC really pays the LSP on H.
// ---------------------------------------------------------------------------
// leg-bridge only fronts the LN once obs.onchain.lockedToLsp is not-false, the amount covers the leg, and
// the CLTV has runway. The FIRST of those is a cryptographic claim the relay/maker could lie about, so it
// must be verified BEFORE the io ever reports lockedToLsp:true — else the LSP could pay the taker over LN
// and then be unable to recoup. Verification is split across the two places that hold the two halves:
//   (a) HERE, purely: parse the maker's redeemScript (the Design-A HTLC from pkg/xchain/primitive.go:
//       OP_IF OP_SHA256 <H> OP_EQUALVERIFY <claimPub> OP_CHECKSIG OP_ELSE <T> OP_CHECKLOCKTIMEVERIFY
//       OP_DROP <refundPub> OP_CHECKSIG OP_ENDIF) and confirm claim==the LSP key, hash==H, refund==the
//       maker key, CLTV==the leg locktime.
//   (b) in the io's observe (seqob-cli xhtlc-observe -redeem <hex>): bind that SAME redeemScript to the
//       funded output — script_bound == (funded scriptPubKey == P2SH(redeem)) — so the maker cannot claim
//       one script and fund a different output.
// (a)&&(b) together are exactly xchain.VerifyBTCLeg's checks, evaluated where the LSP can act on them: the
// io sets onchain.lockedToLsp = (a passed at handshake) && (b passed this observe). Either failing keeps
// leg-bridge fail-closed (no front, no loss).

const OP = { IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75, EQUALVERIFY: 0x88, SHA256: 0xa8,
  CHECKSIG: 0xac, CHECKLOCKTIMEVERIFY: 0xb1, HASH160: 0xa9, EQUAL: 0x87 };

// Read one canonical data push (opcodes 0x01..0x4b, plus OP_PUSHDATA1 0x4c) from buf at i.
// Returns { data, next } or null if buf[i] is not a small push. HTLC scripts only use <=75-byte pushes.
function readPush(buf, i) {
  const op = buf[i];
  if (op >= 0x01 && op <= 0x4b) { const n = op; return { data: buf.slice(i + 1, i + 1 + n), next: i + 1 + n }; }
  if (op === 0x4c) { const n = buf[i + 1]; return { data: buf.slice(i + 2, i + 2 + n), next: i + 2 + n }; }
  return null;
}
// Decode a minimally-encoded CScriptNum (little-endian, sign bit in the MSB) — how btcd's AddInt64
// serialises the locktime. Non-negative here (a CLTV height).
function decodeScriptNum(data) {
  if (!data || !data.length) return 0;
  let n = 0n;
  for (let k = 0; k < data.length; k++) n |= BigInt(data[k]) << BigInt(8 * k);
  const negative = (data[data.length - 1] & 0x80) !== 0;
  if (negative) n &= ~(0x80n << BigInt(8 * (data.length - 1)));
  return Number(negative ? -n : n);
}

/**
 * Parse a Design-A HTLC redeemScript into its four bound parameters, or throw. PURE.
 * @param {Uint8Array|Buffer} script
 * @returns {{ hashHex:string, claimPubHex:string, refundPubHex:string, locktime:number }}
 */
export function parseHtlcRedeem(script) {
  const b = script instanceof Uint8Array ? script : Uint8Array.from(script);
  let i = 0;
  const need = (cond, why) => { if (!cond) throw new Error(`redeemScript is not a Design-A HTLC: ${why}`); };
  need(b[i++] === OP.IF, 'missing OP_IF');
  need(b[i++] === OP.SHA256, 'missing OP_SHA256');
  const h = readPush(b, i); need(h && h.data.length === 32, 'hash push must be 32 bytes'); i = h.next;
  need(b[i++] === OP.EQUALVERIFY, 'missing OP_EQUALVERIFY');
  const cp = readPush(b, i); need(cp && cp.data.length === 33, 'claim pubkey push must be 33 bytes'); i = cp.next;
  need(b[i++] === OP.CHECKSIG, 'missing claim OP_CHECKSIG');
  need(b[i++] === OP.ELSE, 'missing OP_ELSE');
  // The locktime is a data push for a value > 16, but btcd's AddInt64 encodes a small integer 1..16 as a
  // single OP_N opcode (OP_1=0x51..OP_16=0x60) and 0 as OP_0 — accept BOTH so a Go-produced small-locktime
  // script round-trips (the inverse of buildHtlcRedeem's pushLocktime).
  let locktime, ltNext;
  const ltOp = b[i];
  if (ltOp >= 0x51 && ltOp <= 0x60) { locktime = ltOp - 0x50; ltNext = i + 1; }        // OP_1..OP_16
  else if (ltOp === 0x00) { locktime = 0; ltNext = i + 1; }                             // OP_0
  else { const lt = readPush(b, i); need(lt, 'missing locktime push'); locktime = decodeScriptNum(lt.data); ltNext = lt.next; }
  i = ltNext;
  need(b[i++] === OP.CHECKLOCKTIMEVERIFY, 'missing OP_CHECKLOCKTIMEVERIFY');
  need(b[i++] === OP.DROP, 'missing OP_DROP');
  const rp = readPush(b, i); need(rp && rp.data.length === 33, 'refund pubkey push must be 33 bytes'); i = rp.next;
  need(b[i++] === OP.CHECKSIG, 'missing refund OP_CHECKSIG');
  need(b[i++] === OP.ENDIF, 'missing OP_ENDIF');
  need(i === b.length, 'trailing bytes after OP_ENDIF');
  return { hashHex: bytesToHex(h.data), claimPubHex: bytesToHex(cp.data),
    refundPubHex: bytesToHex(rp.data), locktime };
}

// Minimal CScriptNum encode (the inverse of decodeScriptNum) — how btcd's ScriptBuilder.AddInt64 serialises a
// non-negative locktime: little-endian bytes, with a trailing 0x00 appended when the MSB of the top byte is set
// (so the value is never read as negative). A CLTV height is always > 0 here, so it is always a multi-byte push.
function encodeScriptNum(nIn) {
  let n = BigInt(nIn);
  if (n === 0n) return new Uint8Array(0);
  const neg = n < 0n; if (neg) n = -n;
  const out = [];
  while (n > 0n) { out.push(Number(n & 0xffn)); n >>= 8n; }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1] |= 0x80;
  return Uint8Array.from(out);
}

/**
 * Build a Design-A HTLC redeemScript from its four bound parameters — the exact byte-for-byte inverse of
 * parseHtlcRedeem, mirroring pkg/xchain/primitive.go's LockScript (OP_IF OP_SHA256 <H> OP_EQUALVERIFY <claimPub>
 * OP_CHECKSIG OP_ELSE <T> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPub> OP_CHECKSIG OP_ENDIF, all canonical <=75-byte
 * pushes). PURE. The LSP payer bridge uses it to PRE-COMPUTE the intended redeemScript for the BTC HTLC it is
 * about to fund — so it can persist its own refund key + the intended script BEFORE the irreversible funding
 * broadcast, and then VERIFY-NOT-TRUST that the funding CLI returned exactly this script (never record an HTLC it
 * cannot refund). Throws on a malformed pubkey/hash or a non-height locktime.
 * @param {{ hashHex:string, claimPubHex:string, refundPubHex:string, locktime:number }} a
 * @returns {string} redeemScript hex
 */
export function buildHtlcRedeem({ hashHex, claimPubHex, refundPubHex, locktime }) {
  const H = hexToBytes(hashHex); if (H.length !== 32) throw new Error('buildHtlcRedeem: hashHex must be 32-byte hex H');
  const claim = hexToBytes(claimPubHex); if (claim.length !== 33) throw new Error('buildHtlcRedeem: claimPubHex must be 33-byte compressed hex');
  const refund = hexToBytes(refundPubHex); if (refund.length !== 33) throw new Error('buildHtlcRedeem: refundPubHex must be 33-byte compressed hex');
  const T = Number(locktime);
  if (!Number.isFinite(T) || T <= 0 || T >= LOCKTIME_THRESHOLD) throw new Error(`buildHtlcRedeem: locktime ${locktime} must be a positive block height (< ${LOCKTIME_THRESHOLD})`);
  const out = [];
  const op = (o) => out.push(o);
  const push = (data) => { if (data.length > 0x4b) throw new Error('buildHtlcRedeem: push too large'); out.push(data.length); for (const x of data) out.push(x); };
  // btcd's ScriptBuilder.AddInt64 — which pkg/xchain/primitive.go LockScript uses for the CLTV locktime —
  // emits a SINGLE OP_N opcode (OP_1=0x51 .. OP_16=0x60) for a small integer 1..16, NOT a data push. Mirror
  // that EXACTLY so the redeemScript byte-matches Go across every locktime; a naive always-data-push disagrees
  // at T<=16 (the golden vectors pin T=16 -> OP_16). Real block-height locktimes are >16 so this is a
  // correctness/robustness match, not a hot path — but a mismatch here fund-loses (broadcast-then-verify-throw).
  const pushLocktime = (t) => { if (t >= 1 && t <= 16) op(0x50 + t); else push(encodeScriptNum(t)); };
  op(OP.IF);
  op(OP.SHA256); push(H); op(OP.EQUALVERIFY);
  push(claim); op(OP.CHECKSIG);
  op(OP.ELSE);
  pushLocktime(T); op(OP.CHECKLOCKTIMEVERIFY); op(OP.DROP);
  push(refund); op(OP.CHECKSIG);
  op(OP.ENDIF);
  return bytesToHex(Uint8Array.from(out));
}

/**
 * Fund-safety parse-verdict (half (a)) for the maker's BTC HTLC. PURE. Returns { ok, reason }.
 * ok is TRUE only when the redeemScript binds claim==lspClaimPub, hash==H, refund==maker, and CLTV==T. The
 * funded-output binding (half (b)) is checked by the io via xhtlc-observe. Anything else => ok:false, so
 * the io keeps onchain.lockedToLsp false and leg-bridge fails closed (the LSP never fronts).
 */
export function verifyMakerBtcHtlc({ redeemScriptHex, hashHex, lspClaimPubHex, makerRefundPubHex, locktime }) {
  try {
    const p = parseHtlcRedeem(hexToBytes(redeemScriptHex));
    // W1-UNIT — the BTC-HTLC CLTV MUST be a BLOCK HEIGHT. A Bitcoin nLockTime >= LOCKTIME_THRESHOLD
    // (500,000,000) is a UNIX TIMESTAMP, not a height; nothing else forces the maker to pick a height, so a
    // malicious maker could set a timestamp locktime. The bridge fund-safety gate (checkBridgeLocktimeOrdering)
    // does HEIGHT arithmetic (T_btc - btcTip) — a timestamp there yields a huge bogus "blocks to refund" that
    // trivially clears the gate (bypass). Refuse a non-height CLTV up front so the handshake fails closed and
    // the height arithmetic downstream is always valid. (Also refuse a negative CScriptNum — never a height.)
    if (!Number.isFinite(p.locktime) || p.locktime < 0 || p.locktime >= LOCKTIME_THRESHOLD)
      return { ok: false, reason: `HTLC CLTV ${p.locktime} is not a block height (an nLockTime >= ${LOCKTIME_THRESHOLD} is a UNIX TIMESTAMP; heights are 0..${LOCKTIME_THRESHOLD - 1}) — the bridge locktime-ordering gate needs a height; refuse to front` };
    if (p.hashHex.toLowerCase() !== String(hashHex).toLowerCase())
      return { ok: false, reason: `HTLC hash ${p.hashHex} != swap H ${hashHex}` };
    if (p.claimPubHex.toLowerCase() !== String(lspClaimPubHex).toLowerCase())
      return { ok: false, reason: `HTLC claim pubkey is NOT the LSP key (got ${p.claimPubHex}) — refuse to front` };
    if (makerRefundPubHex && p.refundPubHex.toLowerCase() !== String(makerRefundPubHex).toLowerCase())
      return { ok: false, reason: `HTLC refund pubkey != maker refund pubkey` };
    if (locktime != null && Number(locktime) !== p.locktime)
      return { ok: false, reason: `HTLC CLTV ${p.locktime} != terms T_btc ${locktime}` };
    return { ok: true, reason: 'BTC HTLC parse-verified: claim=LSP on H, refund=maker, CLTV bound' };
  } catch (e) {
    return { ok: false, reason: `HTLC verify failed: ${(e && e.message) || e}` };
  }
}

/**
 * Fund-safety parse-verdict for the FORWARD (payer) bridge's maker ASSET leg. PURE. The MIRROR of
 * verifyMakerBtcHtlc: in the payer bridge the taker mints H + holds P and buys the asset on-chain, so the
 * maker must lock its Sequentia-asset HTLC to the REAL TAKER's asset-claim pubkey on the taker's H (never to
 * the LSP — the LSP holds no taker key and must not be able to claim the asset). ok is TRUE only when the
 * redeemScript binds claim==takerSeqClaimPub, hash==H, refund==maker, and CLTV==T_seq. Anything else =>
 * ok:false, so the LSP REFUSES to relay the asset leg to the taker (the taker exposes nothing; the LSP
 * refunds its own BTC HTLC at T_btc — double no-loss). The asset HTLC uses the SAME Design-A redeem format.
 * @returns {{ ok:boolean, reason:string }}
 */
export function verifyMakerAssetLeg({ redeemScriptHex, hashHex, takerSeqClaimPubHex, makerRefundPubHex, locktime }) {
  try {
    const p = parseHtlcRedeem(hexToBytes(redeemScriptHex));
    // A Sequentia nLockTime >= LOCKTIME_THRESHOLD is a UNIX TIMESTAMP, not a height; the bridge's block
    // arithmetic (T_seq bound / hold sizing) needs a height, so refuse a non-height CLTV up front.
    if (!Number.isFinite(p.locktime) || p.locktime < 0 || p.locktime >= LOCKTIME_THRESHOLD)
      return { ok: false, reason: `asset HTLC CLTV ${p.locktime} is not a block height (an nLockTime >= ${LOCKTIME_THRESHOLD} is a UNIX TIMESTAMP; heights are 0..${LOCKTIME_THRESHOLD - 1}) — refuse` };
    if (p.hashHex.toLowerCase() !== String(hashHex).toLowerCase())
      return { ok: false, reason: `asset HTLC hash ${p.hashHex} != swap H ${hashHex}` };
    if (p.claimPubHex.toLowerCase() !== String(takerSeqClaimPubHex).toLowerCase())
      return { ok: false, reason: `asset HTLC claim pubkey is NOT the taker key (got ${p.claimPubHex}) — the maker must lock the asset to the REAL taker's claim key on H; refuse to relay` };
    if (makerRefundPubHex && p.refundPubHex.toLowerCase() !== String(makerRefundPubHex).toLowerCase())
      return { ok: false, reason: `asset HTLC refund pubkey != maker refund pubkey` };
    if (locktime != null && Number(locktime) !== p.locktime)
      return { ok: false, reason: `asset HTLC CLTV ${p.locktime} != terms T_seq ${locktime}` };
    return { ok: true, reason: 'asset HTLC parse-verified: claim=taker on H, refund=maker, CLTV bound' };
  } catch (e) {
    return { ok: false, reason: `asset HTLC verify failed: ${(e && e.message) || e}` };
  }
}

/**
 * Fund-safety ON-CHAIN value-verdict for the FORWARD (payer) bridge's maker ASSET leg (half (b), the MIRROR of
 * the io's observeNativeLocked binding for the receiver bridge). PURE over an already-observed outpoint. The
 * parse verdict (verifyMakerAssetLeg — claim==taker on H, refund==maker, CLTV==T_seq) proves what the maker
 * CLAIMS; this proves the maker actually FUNDED it, for the AGREED asset + amount, bound to that redeemScript —
 * BEFORE the LSP hands the leg to the taker to claim. `observed` is the seqob-cli xhtlc-observe JSON for the
 * maker's asset outpoint (fetched with `-hash H -redeem <script>` so `script_bound` = funded output is
 * P2SH(redeem)). ok is TRUE only when the output is funded, script-bound to the SAME redeem, carries the
 * AGREED asset id, and pays AT LEAST the AGREED atoms. Anything else / unreadable => ok:false, so the LSP
 * REFUSES to relay (the taker exposes nothing; the LSP refunds its BTC HTLC at T_btc — double no-loss).
 * @param {{ observed:object|null, expectAssetId?:string, expectAtoms?:number }} a
 * @returns {{ ok:boolean, reason:string }}
 */
export function checkMakerAssetLegObserved({ observed, expectAssetId, expectAtoms } = {}) {
  if (!observed || typeof observed !== 'object')
    return { ok: false, reason: 'maker asset leg on-chain observe returned nothing — cannot confirm the maker funded it; refuse to relay (fail closed)' };
  if (!observed.funded)
    return { ok: false, reason: 'maker asset HTLC outpoint is NOT funded on-chain — the maker has not locked the asset; refuse to relay (fail closed)' };
  // script_bound = the funded scriptPubKey is P2SH(the SAME redeemScript we parse-verified). Without it the
  // maker could parse-verify one script yet fund a different (e.g. unencumbered) output. Require it.
  if (observed.script_bound !== true)
    return { ok: false, reason: 'maker asset HTLC funded output is NOT P2SH(redeem) — the funded output is not bound to the verified HTLC script; refuse to relay (fail closed)' };
  // Asset id MUST be present AND equal the agreed asset — the taker is about to claim THIS output; a wrong /
  // unreadable asset id must not be relayed.
  if (expectAssetId) {
    if (!observed.asset_id)
      return { ok: false, reason: `maker asset HTLC has no readable asset id to bind to the agreed ${expectAssetId} — refuse to relay (fail closed)` };
    if (String(observed.asset_id).toLowerCase() !== String(expectAssetId).toLowerCase())
      return { ok: false, reason: `maker asset HTLC carries asset ${observed.asset_id}, not the agreed ${expectAssetId} — refuse to relay (fail closed)` };
  }
  // Amount MUST cover the agreed atoms (the maker may over-deliver, never under-deliver).
  if (Number(expectAtoms) > 0 && Number(observed.amount || 0) < Number(expectAtoms))
    return { ok: false, reason: `maker asset HTLC pays ${observed.amount} atoms, below the agreed ${expectAtoms} — refuse to relay (fail closed)` };
  return { ok: true, reason: `maker asset HTLC observed on-chain: funded + script-bound + asset ${observed.asset_id || '(unchecked)'} + amount ${observed.amount} >= agreed ${expectAtoms || 0} — safe to relay to the taker` };
}

// ---------------------------------------------------------------------------
// The reverse-maker handshake (pure over an injected CourierSession).
// ---------------------------------------------------------------------------

/**
 * Drive a REVERSE (buy) cross maker up to XcBtcLegLocked, inserting the LSP as the BTC-claim counterparty.
 * Sends XcTermsRequest{ taker_btc_claim_pub = the LSP's key, taker_seq_refund_pub = the TAKER's key }, then
 * receives the maker's XcBtcLegLocked and VERIFIES its on-chain BTC HTLC binds to the LSP claim key on the
 * maker's H (fund-safety gate). Returns everything the io needs for the bridged BTC leg + the native asset
 * leg — WITHOUT funding or claiming anything. PURE: all effects go through `session`.
 *
 * @param {object} a
 * @param {CourierSession} a.session   an OPEN courier session to the maker (openReverseBridgeSession or a fake)
 * @param {string} a.lspBtcClaimPubHex 33-byte hex — the maker locks its BTC claim branch to this
 * @param {string} a.takerSeqRefundPubHex 33-byte hex — the taker's own asset-refund key (never the LSP's)
 * @param {{ btcSats:number, seqAtoms:number }} a.expect  amounts from the resting offer (bind the terms)
 * @param {object} [a.cfg]  { termsWaitMs }
 * @returns {Promise<{ hashHex, btcHtlc:{txid,vout,amount,redeemScriptHex,cltv,refundPubHex},
 *                     makerSeqClaimPubHex, seqLocktime, btcAmount, seqAmount, feeBtc }>}
 */
export async function runReverseBridgeTerms({ session, lspBtcClaimPubHex, takerSeqRefundPubHex, expect, cfg = {} }) {
  const c = { ...BRIDGE_MAKER_DEFAULTS, ...cfg };
  if (!/^[0-9a-fA-F]{66}$/.test(lspBtcClaimPubHex || '')) throw new Error('runReverseBridgeTerms: lspBtcClaimPubHex must be 33-byte hex');
  if (!/^[0-9a-fA-F]{66}$/.test(takerSeqRefundPubHex || '')) throw new Error('runReverseBridgeTerms: takerSeqRefundPubHex must be 33-byte hex');

  await session.send({ type: XcType.TermsRequest,
    taker_btc_claim_pub: lspBtcClaimPubHex,      // the maker locks BTC claim=LSP -> the LSP recoups
    taker_seq_refund_pub: takerSeqRefundPubHex });  // the taker's OWN asset refund key (self-custody)

  const bl = await session.recv(XcType.BtcLegLocked, c.termsWaitMs);
  const leg = bl.leg || {};
  const hashHex = String(bl.hash_h || bl.hashH || '').toLowerCase();
  const redeemScriptHex = String(leg.redeem_script || leg.redeemScript || '');
  const cltv = Number(leg.locktime || bl.btc_locktime || bl.btcLocktime || 0);
  const makerRefundPubHex = String(bl.maker_refund_pub || bl.makerRefundPub || '');
  const makerSeqClaimPubHex = String(bl.maker_seq_claim_pub || bl.makerSeqClaimPub || '');
  const seqLocktime = Number(bl.seq_locktime || bl.seqLocktime || 0);
  const btcAmount = Number(bl.btc_amount || bl.btcAmount || leg.amount || 0);
  const seqAmount = Number(bl.seq_amount || bl.seqAmount || 0);
  const feeBtc = Number(bl.fee_btc || bl.feeBtc || 0);

  // Bind the maker's terms to the offer we took (never proceed on a mismatch).
  if (!/^[0-9a-f]{64}$/.test(hashHex)) throw new Error('maker BtcLegLocked has no 32-byte hash H');
  if (!redeemScriptHex || !leg.txid) throw new Error('maker BtcLegLocked has no funded BTC leg');
  if (!/^[0-9a-fA-F]{66}$/.test(makerSeqClaimPubHex)) throw new Error('maker BtcLegLocked has no asset claim pubkey');
  if (seqLocktime <= 0) throw new Error('maker BtcLegLocked has no asset (SEQ) locktime');
  if (expect && Number(expect.btcSats) > 0 && btcAmount < Number(expect.btcSats))
    throw new Error(`maker BTC leg pays ${btcAmount} sats, below the offered ${expect.btcSats} — refuse`);
  if (expect && Number(expect.seqAtoms) > 0 && seqAmount > Number(expect.seqAtoms))
    throw new Error(`maker wants ${seqAmount} asset atoms, above the offered ${expect.seqAtoms} — refuse`);

  // Fund-safety: the redeemScript MUST bind claim=LSP on H (P2SH binding is checked by the io against the
  // funded output). We verify the parse here so a structurally-wrong or wrong-key leg aborts the handshake
  // (nothing fronted) rather than surfacing later as an un-recoupable front.
  const v = verifyMakerBtcHtlc({ redeemScriptHex, hashHex, lspClaimPubHex: lspBtcClaimPubHex,
    makerRefundPubHex, locktime: cltv });
  if (!v.ok) { try { await session.fail('htlc_not_locked_to_lsp', v.reason); } catch {} throw new Error(`maker BTC HTLC verify failed: ${v.reason}`); }

  return {
    hashHex,
    btcHtlc: { txid: String(leg.txid), vout: Number(leg.vout || 0), amount: btcAmount,
      redeemScriptHex, cltv, refundPubHex: makerRefundPubHex },
    makerSeqClaimPubHex, seqLocktime, btcAmount, seqAmount, feeBtc,
  };
}

/**
 * After the taker has funded its asset HTLC self-custody, RELAY it into the maker session so the maker
 * claims it (revealing P). Returns the preimage the maker courtesy-reveals (the LSP also reads P from the
 * BTC HTLC witness on recoup, so this is a convenience, never the sole source). PURE over `session`.
 * @param {object} a
 * @param {CourierSession} a.session
 * @param {{txid,vout,amount,redeem_script,locktime,asset,block_hash,anchor_height}} a.takerSeqLeg
 * @param {object} [a.cfg] { secretWaitMs }
 * @returns {Promise<{ preimageHex:string|null }>}
 */
export async function relayTakerAssetLeg({ session, takerSeqLeg, cfg = {} }) {
  const c = { ...BRIDGE_MAKER_DEFAULTS, ...cfg };
  if (!takerSeqLeg || !takerSeqLeg.txid || !takerSeqLeg.redeem_script) throw new Error('relayTakerAssetLeg: takerSeqLeg needs {txid, redeem_script, ...}');
  await session.send({ type: XcType.SeqLegFunded, leg: takerSeqLeg });
  try {
    const sr = await session.recv(XcType.SecretRevealed, c.secretWaitMs);
    const p = String(sr.preimage || '').toLowerCase();
    return { preimageHex: /^[0-9a-f]{64}$/.test(p) ? p : null };
  } catch {
    // The maker may never courtesy-reveal; that is fine — the LSP reads P from the on-chain SEQ/BTC claim.
    return { preimageHex: null };
  }
}

// A fresh secp256k1 keypair for the LSP's BTC claim on the bridged leg. Its private key stays LSP-side and
// bounds the recoup to exactly this HTLC (the LSP can claim only what the maker locked to this pubkey).
export function newBridgeClaimKeypair() {
  const priv = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : crypto.getRandomValues(new Uint8Array(32));
  const pub = secp256k1.getPublicKey(priv, true);
  return { privHex: bytesToHex(priv), pubHex: bytesToHex(pub) };
}

// Open a live reverse-bridge session to the maker over the relay. Impure (real WS); thin wrapper so the
// handshake above stays pure/testable. `offer` is a VERIFIED resting reverse cross offer from the book.
export async function openReverseBridgeSession({ offer, relayBase, takeAtoms }) {
  if (relayBase) setSeqobBase(relayBase);
  return openCourierSession(offer, takeAtoms, '');
}

// ---------------------------------------------------------------------------
// The FORWARD-maker handshake (payer bridge) — pure over an injected CourierSession.
// ---------------------------------------------------------------------------
// The MIRROR of the reverse handshake, for the PAYER shape (buy: the taker pays BTC over LN, receives the
// asset on-chain). Here the TAKER mints H + holds P; the LSP funds the on-chain BTC HTLC to the maker and
// RELAYS the maker's asset leg to the taker. The forward flow is a TWO-round handshake (unlike the reverse's
// single BtcLegLocked), so it is split:
//   (1) runForwardBridgeTerms — send XcTermsRequest, receive the maker's XcTerms {maker_btc_claim_pub,
//       maker_refund_pub (asset), T_btc, T_seq, amounts}. TERMS ONLY (no funding), so the LSP records the
//       recoup wiring (fund an on-chain BTC HTLC claim=maker_btc_claim_pub on H, refund=LSP at T_btc) and
//       sizes the taker's BTC-LN hold from T_seq BEFORE the taker pays anything.
//   (2) sendForwardBtcLegFunded — AFTER the LSP has funded that BTC HTLC (only once the taker's hold is HELD),
//       send XcBtcLegFunded {H, taker_seq_claim_pub = the REAL taker's key, taker_btc_refund_pub = the LSP's
//       key, the funded BTC leg}, receive the maker's XcSeqLegLocked, and VERIFY-NOT-TRUST it binds the asset
//       to the REAL taker's claim key on H (verifyMakerAssetLeg) before returning it for relay to the taker.
// The maker side is RunMakerForward (seqdex xdriver.go:665): it mints per-lift keys, verifies the LSP-funded
// BTC leg, locks the asset to the taker, and NEVER learns P (P is the taker's).

/**
 * FORWARD terms round (payer bridge). Sends XcTermsRequest and parses the maker's XcTerms. PURE over
 * `session`. Binds the maker's amounts to the offer the taker took (the LSP funds btc_amount for the taker;
 * the maker delivers seq_amount to the taker) — refuse a maker that wants MORE BTC than agreed or delivers
 * LESS asset. Returns the terms the LSP needs to fund the BTC leg + size the hold, WITHOUT funding anything.
 * @param {object} a
 * @param {CourierSession} a.session   an OPEN forward session to the maker (openForwardBridgeSession or a fake)
 * @param {{ btcSats:number, seqAtoms:number }} a.expect  amounts from the resting offer (bind the terms)
 * @param {object} [a.cfg]  { termsWaitMs }
 * @returns {Promise<{ makerBtcClaimPubHex, makerSeqRefundPubHex, btcLocktime, seqLocktime, btcAmount, seqAmount, feeBtc }>}
 */
export async function runForwardBridgeTerms({ session, expect, cfg = {} }) {
  const c = { ...BRIDGE_MAKER_DEFAULTS, ...cfg };
  await session.send({ type: XcType.TermsRequest });
  const t = await session.recv(XcType.Terms, c.termsWaitMs);
  const makerBtcClaimPubHex = String(t.maker_btc_claim_pub || t.makerBtcClaimPub || '');
  const makerSeqRefundPubHex = String(t.maker_refund_pub || t.makerRefundPub || '');
  const btcLocktime = Number(t.btc_locktime || t.btcLocktime || 0);
  const seqLocktime = Number(t.seq_locktime || t.seqLocktime || 0);
  const btcAmount = Number(t.btc_amount || t.btcAmount || 0);
  const seqAmount = Number(t.seq_amount || t.seqAmount || 0);
  const feeBtc = Number(t.fee_btc || t.feeBtc || 0);

  if (!/^[0-9a-fA-F]{66}$/.test(makerBtcClaimPubHex)) throw new Error('maker Terms has no BTC claim pubkey');
  if (!/^[0-9a-fA-F]{66}$/.test(makerSeqRefundPubHex)) throw new Error('maker Terms has no asset (SEQ) refund pubkey');
  if (!(btcLocktime > 0)) throw new Error('maker Terms has no BTC (T_btc) locktime');
  if (!(seqLocktime > 0)) throw new Error('maker Terms has no asset (T_seq) locktime');
  // FUND-SAFETY — VERIFY-NOT-TRUST the maker's stated BTC PRICE. The LSP FUNDS exactly terms.btcAmount for the
  // taker, so a non-positive BTC price is nonsense — and it is a fund-loss trap: a maker quoting btcAmount <= 0
  // SLIPS PAST the upper-bound check below (0 > btcSats is false), then the fallback funds body.btc_sats while
  // persisting bridge_terms.btc_amount = 0, so a boot-resume driving off the maker-stated amount would drive a
  // 0-sat (or NaN) leg. Refuse a non-positive price up front so terms.btcAmount ALWAYS equals the funded amount.
  if (!(btcAmount > 0))
    throw new Error(`maker Terms quotes a non-positive BTC price (btcAmount ${btcAmount}) — the LSP funds exactly this amount; refuse (fail closed, nothing funded)`);
  // Bind to the offer we took. The LSP FUNDS the BTC leg for the taker -> refuse a maker that wants MORE BTC
  // than the taker agreed. The maker DELIVERS the asset -> refuse one that delivers LESS asset than offered.
  if (expect && Number(expect.btcSats) > 0 && btcAmount > Number(expect.btcSats))
    throw new Error(`maker wants ${btcAmount} BTC sats, above the offered ${expect.btcSats} — refuse`);
  if (expect && Number(expect.seqAtoms) > 0 && seqAmount < Number(expect.seqAtoms))
    throw new Error(`maker delivers ${seqAmount} asset atoms, below the offered ${expect.seqAtoms} — refuse`);
  return { makerBtcClaimPubHex, makerSeqRefundPubHex, btcLocktime, seqLocktime, btcAmount, seqAmount, feeBtc };
}

/**
 * FORWARD BTC-leg-funded round (payer bridge). AFTER the LSP has funded the on-chain BTC HTLC (claim=maker on
 * H, refund=LSP at T_btc), send XcBtcLegFunded and receive+verify the maker's XcSeqLegLocked. PURE over
 * `session`. VERIFY-NOT-TRUST: the maker's asset leg MUST bind claim==the REAL taker's asset-claim key on the
 * taker's H (verifyMakerAssetLeg) — else the LSP refuses to relay (the taker exposes nothing; the LSP refunds
 * its BTC at T_btc). Returns the verified maker asset leg for the LSP to relay to the taker.
 * @param {object} a
 * @param {CourierSession} a.session
 * @param {string} a.hashHex               the taker's H (32-byte hex)
 * @param {string} a.takerSeqClaimPubHex   33-byte hex — the maker must lock the asset to this (the taker's key)
 * @param {string} a.lspBtcRefundPubHex    33-byte hex — the LSP's own BTC refund key on the funded HTLC
 * @param {{txid,vout,amount,redeem_script}} a.btcLeg   the LSP-funded BTC HTLC outpoint
 * @param {number} a.takeSeqAtoms          asset atoms the taker buys (the maker locks this slice)
 * @param {string} a.makerSeqRefundPubHex  the maker's asset refund key (from the terms)
 * @param {number} a.seqLocktime           T_seq (from the terms)
 * @param {object} [a.cfg]  { secretWaitMs }
 * @returns {Promise<{ makerSeqLeg:{txid,vout,amount,asset,redeem_script,locktime,block_hash,anchor_height} }>}
 */
export async function sendForwardBtcLegFunded({ session, hashHex, takerSeqClaimPubHex, lspBtcRefundPubHex,
  btcLeg, takeSeqAtoms, makerSeqRefundPubHex, seqLocktime, cfg = {} }) {
  const c = { ...BRIDGE_MAKER_DEFAULTS, ...cfg };
  if (!/^[0-9a-f]{64}$/.test(String(hashHex || '').toLowerCase())) throw new Error('sendForwardBtcLegFunded: hashHex must be 32-byte hex H');
  if (!/^[0-9a-fA-F]{66}$/.test(takerSeqClaimPubHex || '')) throw new Error('sendForwardBtcLegFunded: takerSeqClaimPubHex must be 33-byte hex');
  if (!/^[0-9a-fA-F]{66}$/.test(lspBtcRefundPubHex || '')) throw new Error('sendForwardBtcLegFunded: lspBtcRefundPubHex must be 33-byte hex');
  if (!btcLeg || !btcLeg.txid || !btcLeg.redeem_script) throw new Error('sendForwardBtcLegFunded: btcLeg needs {txid, redeem_script, ...}');

  await session.send({ type: XcType.BtcLegFunded, hash_h: String(hashHex).toLowerCase(),
    taker_seq_claim_pub: takerSeqClaimPubHex, taker_btc_refund_pub: lspBtcRefundPubHex,
    seq_amount: Number(takeSeqAtoms) || 0, leg: btcLeg });

  const sl = await session.recv(XcType.SeqLegLocked, c.secretWaitMs);
  const leg = sl.leg || {};
  const redeemScriptHex = String(leg.redeem_script || leg.redeemScript || '');
  if (!redeemScriptHex || !leg.txid) throw new Error('maker SeqLegLocked has no funded asset leg');

  // Fund-safety: the maker's asset HTLC MUST bind claim=the REAL taker on H (never the LSP).
  const v = verifyMakerAssetLeg({ redeemScriptHex, hashHex, takerSeqClaimPubHex,
    makerRefundPubHex: makerSeqRefundPubHex, locktime: seqLocktime });
  if (!v.ok) { try { await session.fail('asset_leg_not_locked_to_taker', v.reason); } catch {} throw new Error(`maker asset leg verify failed: ${v.reason}`); }

  return {
    makerSeqLeg: {
      txid: String(leg.txid), vout: Number(leg.vout || 0), amount: Number(leg.amount || 0),
      asset: String(leg.asset || ''), redeem_script: redeemScriptHex, locktime: Number(leg.locktime || seqLocktime),
      block_hash: leg.block_hash || leg.blockHash || '', anchor_height: Number(leg.anchor_height || leg.anchorHeight || 0),
    },
  };
}

// Open a live forward-bridge session to the maker over the relay. Impure (real WS); thin wrapper so the
// forward handshake above stays pure/testable. `offer` is a VERIFIED resting forward cross offer from the
// book. (The courier session is direction-agnostic — the maker's serve loop runs forward vs reverse per its
// own offer direction — so this mirrors openReverseBridgeSession.)
export async function openForwardBridgeSession({ offer, relayBase, takeAtoms }) {
  if (relayBase) setSeqobBase(relayBase);
  return openCourierSession(offer, takeAtoms, '');
}
