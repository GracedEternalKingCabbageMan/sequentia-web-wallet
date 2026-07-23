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
  const lt = readPush(b, i); need(lt, 'missing locktime push'); i = lt.next;
  need(b[i++] === OP.CHECKLOCKTIMEVERIFY, 'missing OP_CHECKLOCKTIMEVERIFY');
  need(b[i++] === OP.DROP, 'missing OP_DROP');
  const rp = readPush(b, i); need(rp && rp.data.length === 33, 'refund pubkey push must be 33 bytes'); i = rp.next;
  need(b[i++] === OP.CHECKSIG, 'missing refund OP_CHECKSIG');
  need(b[i++] === OP.ENDIF, 'missing OP_ENDIF');
  need(i === b.length, 'trailing bytes after OP_ENDIF');
  return { hashHex: bytesToHex(h.data), claimPubHex: bytesToHex(cp.data),
    refundPubHex: bytesToHex(rp.data), locktime: decodeScriptNum(lt.data) };
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
