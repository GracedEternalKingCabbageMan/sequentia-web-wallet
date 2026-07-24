// ---------------------------------------------------------------------------
// subswap.js — the P2P SUBMARINE taker client (both directions) + the LSP
// PAYER leg-bridge client (the buy fallback), for the rail-crossing matrix.
//
// PRINCIPLE (doc/sequentia/rail-crossing-p2p-lsp-design.md): matching is rail-blind;
// settlement picks a mutually-supported rail per the counterparties' capabilities.
// A DIRECT peer-to-peer submarine is the FIRST-CLASS path whenever the counterparties
// line up (an interactive online maker that can itself accept BTC-LN); the LSP
// leg-bridge is the FALLBACK ONLY on a genuine mismatch (an on-chain-only / passive
// covenant maker). This applies symmetrically to BOTH bridge directions.
//
// A BTC<->asset swap has two legs bound by ONE preimage H. On the submarine path the
// asset leg is a Sequentia on-chain HTLC and the BTC leg is a bolt11 (pure Lightning),
// so there is exactly ONE on-chain HTLC and a SINGLE T_seq gate — no coupled locktimes
// (that intricacy only appears when the LSP originates a second on-chain BTC HTLC).
//
// This module is the TAKER transport + settlement glue:
//   • runTakerReverseSubmarine  PAYER/buy  (ln_direction=1): the maker locks the asset
//     on-chain (claim=taker) + mints a plain bolt11 on H; the taker VERIFIES the SEQ
//     leg binds its OWN claim key on H (correct asset/amount/locktime), waits it is
//     anchor-buried, ONLY THEN pays the invoice (learning P), persists P+leg, and
//     claims the asset. The taker can never lose BTC-LN without the verified,
//     anchor-buried asset already locked to its own key.
//   • runTakerSubmarine        RECEIVER/sell (ln_direction=0): the taker mints P/H,
//     mints a bolt11 on H at its OWN BTC-LN node, funds the asset HTLC (claim=maker),
//     announces both, and awaits the maker paying its bolt11 — the taker receives
//     BTC-LN as it settles the hold with P (revealing P so the maker claims the
//     asset). If unpaid, the taker refunds the asset after T_seq.
//   • runLspPayerBridge        PAYER/buy FALLBACK vs an on-chain-only maker: the taker
//     mints H (holds P self-custody), the LSP issues a BTC-LN HOLD on H (POST
//     /bridge/hold), the taker pays it (HELD, not captured), the LSP funds an on-chain
//     BTC HTLC to the maker; the maker locks the asset to the taker's key on H and the
//     LSP relays it; the taker VERIFIES it (claim=my key on H, asset/amount/locktime,
//     anchor) then claims with P self-custody.
//
// Fund-safety (taker side, ALL paths): VERIFY the counterparty's on-chain asset leg
// (claim=my key on H, correct asset id + amount + locktime, anchor-buried >=
// min_anchor_depth) BEFORE the single irreversible act (paying the maker's invoice on
// the reverse buy; or claiming — revealing P — on the LSP payer bridge), and PERSIST
// P + the leg before claiming so a crash between the irreversible act and the claim
// never loses P (the only key to the asset).
//
// Everything fund-safety-critical is a PURE core with real I/O arriving through an
// injected `deps` object (identical discipline to tooling/lsp/bridge-driver.mjs), so
// the control flow is unit-testable in Node without a browser. swap.js builds the real
// `deps` from the wallet's C.seqLeg / C.wasm primitives + the LSP `L` bridge; a test
// builds a scripted fake. The verification logic is the SAME either way.
// ---------------------------------------------------------------------------

import { openCourierSession } from './xcourier.js';
import { chooseSettlementPath, planSettlement } from './tooling/lsp/settlement-router.mjs';
import { matchFromTake, makerRailsFromOffer, crossingShapeSupported } from './tooling/lsp/bridge-driver.mjs';
// REVERSE-SUBMARINE HOLD-CLTV BLOCK-TIME MODEL. The reverse-submarine taker's hold-invoice CLTV gate
// (holdCltvSafeVsTseq) does the INVERSE (a BTC-block window `fc` -> a SEQ settle-deadline) of the forward
// leg-bridge, so it needs the OPPOSITE conservative ends. It is NOT the forward model (HOLD_LIFE_DEFAULTS
// fastBtcSecsPerBlock 150 / seqSecsPerBlock 90 ≈ 1.67), which SIZES a hold to COVER a known T_seq by assuming
// BTC FAST + SEQ SLOW. Here the conservative direction FLIPS: we must UPPER-BOUND how many SEQ slots elapse by
// the LATEST a masqueraded hold could still settle (its incoming HTLC of `fc` BTC blocks finally expiring), so
// we assume Bitcoin SLOW (each of the fc blocks spans the MOST wall-clock) and Sequentia at its EXACT slot. The
// SEQ slot is DETERMINISTIC (g_pos_slot_interval = 30 s), so FAST_SEQ_SECS is EXACTLY 30 — Sequentia cannot run
// faster than its own slot, so NO margin belongs on that side. The ENTIRE margin goes on the VARIABLE Bitcoin
// side: Bitcoin's nominal block is ~600 s, but a sustained hashrate-drop lull can average ~1500-1800 s/block
// over a short window, so SLOW_BTC_SECS = 1800 (a ~3x slowdown) => ratio = 1800/30 = 60 SEQ slots per BTC block.
// This GENEROUS ratio covers a SUSTAINED BTC lull, not just a nominal-or-modest excursion (a mere 900 s window
// would need only ~30x). Using the forward ~1.67 here made this fund-safety gate ~36x too permissive — a hold
// could stay settleable past T_seq undetected (BTC-LN captured, no asset). The two ends are overridable
// (cfg.slowBtcSecs / cfg.fastSeqSecs) for tests.
//
// RESIDUAL (irreducible, documented — NOT a logic bug). This is a FIXED SEQ window vs a VARIABLE, unbounded
// Bitcoin block time. The ratio is sized for a sustained ~1800 s/block lull; if the REAL Bitcoin average over
// the fc-block window EXCEEDS ratio*30 s, a hold-masquerade maker could reveal P PAST the claim window and the
// LSP/taker bears it. It is BOUNDED, never a permanent freeze: the taker caps its OWN outgoing max-cltv-delay at
// fc (payMaxCltv, in runTakerReverseSubmarine), so a HELD payment REFUNDS if the maker never settles — the
// taker's BTC is never left merely HELD unrecoverable, and the loss materialises only if a maker ACTIVELY
// settles late. Mitigated by the generous ratio + the bounded maker fc + this max-cltv cap; NOT eliminated
// (Bitcoin block time is unbounded) — the SAME known limitation as any Lightning CLTV delta. This gate is NOT
// an unconditional guarantee.
const SLOW_BTC_SECS = 1800;  // Bitcoin as SLOW as a sustained hashrate-lull average (~3x nominal 600 s): fc blocks span the MOST wall-clock
const FAST_SEQ_SECS = 30;    // Sequentia at its EXACT deterministic slot (g_pos_slot_interval): no margin here => ratio 1800/30 = 60

// XcSub message type tags — byte-for-byte the seqdex xcourier_submarine.go constants.
export const XcSubType = Object.freeze({
  TermsRequest: 'sub_terms_request',
  Terms:        'sub_terms',         // normal (sell): maker's per-lift terms
  AssetFunded:  'sub_asset_funded',  // normal (sell): taker funded the asset HTLC + bolt11
  AssetLocked:  'sub_asset_locked',  // reverse (buy): maker locked the asset HTLC + bolt11
  Settled:      'sub_settled',       // maker claimed the asset (informational)
  Fail:         'fail',
});

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _hex66 = (s) => /^[0-9a-fA-F]{66}$/.test(String(s || ''));
const _hex64 = (s) => /^[0-9a-fA-F]{64}$/.test(String(s || ''));
function _big(v) { try { return BigInt(v == null ? 0 : v); } catch { return 0n; } }

// bolt11AmountMsat — the invoice amount in msat from a bolt11's human-readable part, or null when the
// amount is absent / not confidently parseable (an amountless invoice, an unknown currency prefix, or a
// sub-msat `p` amount). CONSERVATIVE by design: it returns null rather than guess, so the overpay guard it
// feeds (below) NEVER false-rejects a valid invoice — it only refuses a confidently-parsed OVERPAY. The
// amount encoding is `<digits><multiplier>` right after the `ln<currency>` prefix: m=1e-3, u=1e-6, n=1e-9,
// p=1e-12 BTC; msat = BTC * 1e11. (bcrt is matched before bc so `lnbcrt…` parses.)
export function bolt11AmountMsat(bolt11) {
  if (typeof bolt11 !== 'string') return null;
  const m = /^ln(bcrt|tbs|tsb|bc|tb|sb)(\d*)([munp]?)/i.exec(bolt11.trim());
  if (!m || !m[2]) return null;   // no prefix match, or an amountless invoice
  let n; try { n = BigInt(m[2]); } catch { return null; }
  switch ((m[3] || '').toLowerCase()) {
    case 'm': return n * 100000000n;         // milli-BTC  * 1e8 msat
    case 'u': return n * 100000n;            // micro-BTC  * 1e5 msat
    case 'n': return n * 100n;               // nano-BTC   * 1e2 msat
    case 'p': return (n % 10n === 0n) ? n / 10n : null;   // pico-BTC = 0.1 msat units; sub-msat -> unparseable
    case '':  return n * 100000000000n;      // whole BTC  * 1e11 msat
    default:  return null;
  }
}

// bolt11PaymentHash — the invoice's `p` (payment_hash) tagged field, decoded from the bech32 data part, as
// 32-byte lowercased hex, or null when it cannot be confidently extracted. This is the CLIENT-SIDE mirror of
// the Go driver's clnLNLeg.Pay(bolt11, wantHash): the taker MUST prove the invoice it is about to pay is
// bound to the SAME secret hash H as the on-chain asset HTLC it verified — otherwise paying yields a preimage
// P' with sha256(P') != H that opens NOTHING, and the taker loses BTC-LN with no asset (the single worst
// fund-loss on the reverse-submarine buy). The gate that consumes this fails CLOSED on null (an un-decodable
// invoice is never paid). Pure — no I/O. bech32: 5-bit groups; layout = timestamp(7) + tagged fields +
// signature(104) + checksum(6); a tagged field is type(1) + length(2, big-endian 5-bit) + data(length).
const _BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function _fiveBitToHex(groups, nbytes) {
  let acc = 0, bits = 0; const out = [];
  for (const g of groups) {
    acc = (acc << 5) | g; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); if (out.length === nbytes) break; }
    if (out.length === nbytes) break;
  }
  return out.length === nbytes ? out.map((x) => x.toString(16).padStart(2, '0')).join('') : null;
}
export function bolt11PaymentHash(bolt11) {
  if (typeof bolt11 !== 'string') return null;
  const s = bolt11.trim().toLowerCase();
  const sep = s.lastIndexOf('1');                       // bech32 separator (the data part uses no '1')
  if (sep < 1) return null;
  const data = s.slice(sep + 1);
  const vals = [];
  for (const ch of data) { const v = _BECH32.indexOf(ch); if (v < 0) return null; vals.push(v); }
  if (vals.length < 7 + 104 + 6) return null;           // too short to hold timestamp + signature + checksum
  const end = vals.length - 104 - 6;                    // tagged fields end here (before the 104-group signature)
  let i = 7, payHash = null;
  while (i + 3 <= end) {
    const type = vals[i];
    const len = (vals[i + 1] << 5) | vals[i + 2];
    i += 3;
    if (i + len > end) break;                           // malformed length -> stop (payHash stays whatever we found)
    if (type === 1 && len === 52) payHash = _fiveBitToHex(vals.slice(i, i + 52), 32);   // 'p' = payment_hash (52 groups = 260 bits -> 32 bytes)
    i += len;
  }
  return payHash;
}

// bolt11MinFinalCltv — the invoice's `c` (min_final_cltv_expiry) tagged field as a Number, or the BOLT11
// DEFAULT of 18 when the field is ABSENT (a plain invoice carries none), or null when the invoice cannot be
// parsed at all (the CLTV gate then fails closed). A bolt11 HOLD invoice is BYTE-IDENTICAL to a plain one, so
// this value is the ONLY on-invoice signal of how long the recipient could keep an incoming payment HELD
// (settleable) — the reverse-submarine taker gates on it (holdCltvSafeVsTseq below) so a masquerading maker
// cannot hold the taker's payment past T_seq, refund the asset, then settle the hold. Pure — no I/O. bech32
// layout identical to bolt11PaymentHash; the `c` field (type 24) is a big-endian integer over its 5-bit data
// groups. Per BOLT11 the FIRST `c` is authoritative (it is what a spec-compliant payer commits as the incoming
// HTLC's final CLTV), so decode the first and ignore any later decoy.
export function bolt11MinFinalCltv(bolt11) {
  if (typeof bolt11 !== 'string') return null;
  const s = bolt11.trim().toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1) return null;
  const data = s.slice(sep + 1);
  const vals = [];
  for (const ch of data) { const v = _BECH32.indexOf(ch); if (v < 0) return null; vals.push(v); }
  if (vals.length < 7 + 104 + 6) return null;
  const end = vals.length - 104 - 6;
  let i = 7, cltv = null;
  while (i + 3 <= end) {
    const type = vals[i];
    const len = (vals[i + 1] << 5) | vals[i + 2];
    i += 3;
    if (i + len > end) break;
    if (type === 24 && cltv === null) {                 // 'c' = min_final_cltv_expiry (first occurrence wins)
      let acc = 0;
      for (let k = 0; k < len; k++) acc = acc * 32 + vals[i + k];   // big-endian 5-bit integer
      cltv = acc;
    }
    i += len;
  }
  return cltv === null ? 18 : cltv;                     // absent -> BOLT11 default 18
}

// holdCltvSafeVsTseq — the HOLD-INVOICE MASQUERADE gate (fund-loss), pure. A bolt11 hold invoice is byte-
// identical to a plain one, so a malicious interactive reverse-submarine maker can hand the taker a HOLD
// invoice whose min_final_cltv lets it keep the taker's payment HELD (settleable) PAST T_seq: hold the payment,
// REFUND the asset at T_seq, THEN settle the hold — capturing the taker's BTC-LN with NO asset delivered. The
// LATEST the maker can still settle (reveal P) is when the payment's incoming HTLC would fail back: a BTC
// height ~ btcTip + finalCltv. Convert that finalCltv BTC-block window to Sequentia blocks with the CONSERVATIVE
// INVERSE ratio SLOW_BTC_SECS / FAST_SEQ_SECS (Bitcoin as SLOW as a sustained lull + Sequentia at its exact
// deterministic slot => 1 BTC block spans ~60 SEQ slots — the OPPOSITE conservative direction from the forward
// leg-bridge sizing, which is why the shared HOLD_LIFE_DEFAULTS 1.67 was WRONG here), anchor it at the current
// (post-anchor-bury) seq tip, and REQUIRE the taker can still
// claim the asset after that latest reveal: settleDeadlineSeq + claimMargin < T_seq. Returns { ok, reason,
// finalCltv, settleDeadlineSeq, maxSafeCltvBtc }. maxSafeCltvBtc is the largest final CLTV (BTC blocks) that
// still clears the gate — the driver caps its OWN outgoing payment's max-cltv-delay to it so a HELD payment
// fails back (refunds the taker) as EARLY as possible rather than lingering to the invoice's requested delay.
export function holdCltvSafeVsTseq({ finalCltv, seqTip, seqLocktime, claimMargin, cfg = {} }) {
  // CONSERVATIVE inverse ratio = SEQ slots per BTC block, from the OPPOSITE ends of the forward model: BTC as
  // SLOW as a sustained lull (numerator) over SEQ at its exact deterministic slot (denominator). ~60x (1800/30)
  // — see the block-time note. seqTip here is the POST-anchor-bury tip (the driver re-reads it after the bury).
  const slowBtc = Number(cfg.slowBtcSecs) > 0 ? Number(cfg.slowBtcSecs) : SLOW_BTC_SECS;
  const fastSeq = Number(cfg.fastSeqSecs) > 0 ? Number(cfg.fastSeqSecs) : FAST_SEQ_SECS;
  const ratio = slowBtc / fastSeq;
  const fc = Number(finalCltv), st = Number(seqTip), lt = Number(seqLocktime), cm = Number(claimMargin);
  if (finalCltv == null || !Number.isFinite(fc) || fc < 0)
    return { ok: false, reason: 'the invoice min_final_cltv is undecodable — failing closed (never pay a hold that could settle past T_seq)' };
  if (!Number.isFinite(st) || !Number.isFinite(lt) || !Number.isFinite(cm))
    return { ok: false, reason: 'the seq tip / T_seq / claim margin is unreadable — failing closed on the hold-CLTV gate' };
  // The largest safe final CLTV (BTC blocks): the LARGEST fc that still clears the strict gate below. The gate
  // is `ceil(fc * ratio) < claimableSeqBlocks`, so (fc*ratio integer) fc <= (claimableSeqBlocks - 1) / ratio.
  // (The naive inverse floor(claimableSeqBlocks / ratio) lands one block OVER the strict boundary.)
  const claimableSeqBlocks = lt - st - cm;
  const maxSafeCltvBtc = Math.max(0, Math.floor((claimableSeqBlocks - 1) / ratio));
  // The SEQ height by which a finalCltv-block BTC hold's incoming HTLC would fail back (the LATEST the maker
  // could reveal P), anchored at the current seq tip: assuming Bitcoin SLOW + Sequentia FAST, btcTip + finalCltv
  // maps to seqTip + finalCltv*ratio (the MOST SEQ slots that could elapse before that hold finally expires).
  const settleDeadlineSeq = st + Math.ceil(fc * ratio);
  if (!(settleDeadlineSeq + cm < lt))
    return { ok: false, finalCltv: fc, settleDeadlineSeq, maxSafeCltvBtc,
      reason: `the invoice min_final_cltv ${fc} BTC blocks lets a HOLD stay settleable until ~SEQ height ${settleDeadlineSeq}, leaving < ${cm} blocks before T_seq ${lt} to claim — a masqueraded hold could settle past T_seq (BTC-LN captured, no asset). Refuse (safe max ${maxSafeCltvBtc} BTC blocks).` };
  return { ok: true, finalCltv: fc, settleDeadlineSeq, maxSafeCltvBtc,
    reason: `the invoice min_final_cltv ${fc} BTC blocks fails back by ~SEQ height ${settleDeadlineSeq}, leaving >= ${cm} blocks before T_seq ${lt} — the taker can still claim after the latest possible reveal (safe)` };
}

// sizeSubswapTake — SIZE a rail-crossing take to the USER's requested amount, never the whole resting offer
// (spec §2.4: asking to buy/sell 10 must not sign you up for 43). Partial-fill the offer when it allows it and
// the slice clears its min_fill; otherwise flag an OVERSHOOT so the composer BLOCKS Place (fail closed) rather
// than silently lifting the whole offer. The BTC is FLOORED for the slice (never demand more than the
// proportional amount). PURE — the ONE sizing authority the wallet's bridgedTakePlan + the P2P submarine
// review both consume, so Review == what executes. Returns BigInt takeAtoms/takeBtc.
//
// SUBMARINE offers are WHOLE-OFFER-ONLY. The submarine makers (RunMakerReverseSubmarine / RunMakerSubmarine)
// lock the WHOLE offer amount in a single on-chain HTLC — there is NO partial fill on the submarine path
// (partial fill is the covenant CLOB's job). So a submarine take is ALWAYS the whole resting offer: NEVER
// slice it. A `submarine` offer whose requested size differs from the whole offer is flagged
// { overshoot:true, wholeOnly:true } so the composer blocks Place with a "takes the whole resting offer"
// note — never a partial the maker would reject. (Overshoot was already blocked; now PARTIAL is too.)
export function sizeSubswapTake({ want, offerAtoms, offerBtc, allowPartial, minFill, submarine }) {
  const wa = _big(want), oa = _big(offerAtoms), ob = _big(offerBtc);
  let takeAtoms = oa, takeBtc = ob, partial = false, overshoot = false, wholeOnly = false;
  if (submarine) {
    // Whole-offer-only: never slice. A requested size below the whole offer can't be filled by the submarine
    // (it locks the whole thing) -> overshoot + wholeOnly (block Place). want >= whole (or none) -> take whole.
    if (wa > 0n && oa > 0n && wa < oa) { overshoot = true; wholeOnly = true; }
    return { takeAtoms: oa, takeBtc: ob, partial: false, overshoot, wholeOnly };
  }
  if (wa > 0n && oa > 0n && wa < oa) {
    const mf = _big(minFill);
    if (allowPartial && wa >= (mf > 0n ? mf : 1n)) { takeAtoms = wa; takeBtc = (wa * ob) / oa; partial = true; }
    else overshoot = true;                              // this offer can't be sliced to the requested size
  }
  return { takeAtoms, takeBtc, partial, overshoot, wholeOnly };
}

// resolveConfirmedBlock — bind a funding tx to its CONFIRMED block via the ACTUAL txid's status
// (deps.txStatus -> esplora /tx/<txid>/status), NEVER the maker-supplied leg.block_hash. Returns
// { confirmed, block_hash }. Fails CLOSED (confirmed:false) when txStatus is unwired or the tx is still in
// the mempool (0-conf) — so a maker cannot pass a fake/mempool leg with a decoy block_hash. Pure over deps.
async function resolveConfirmedBlock(txid, deps) {
  if (!txid || !deps || typeof deps.txStatus !== 'function') return { confirmed: false, block_hash: null };
  let st = null; try { st = await deps.txStatus(txid); } catch { st = null; }
  if (!st || st.confirmed !== true) return { confirmed: false, block_hash: null };
  const bh = st.block_hash || st.blockhash || null;
  return { confirmed: !!bh, block_hash: bh };
}

// waitAnchorBuried — POLL the SEQ funding block's Bitcoin-anchor depth until it is buried >= minAnchorDepth (or
// the 0-conf cap short-circuits), or a deadline elapses. Mirrors the Go driver's waitAnchorBuried: a FRESH
// (0–2 conf) asset leg is WAITED OUT, never aborted, so a maker that locks + announces immediately still
// settles once the anchor buries. Fails CLOSED on timeout ({ ok:false }). Pure control flow over injected I/O
// (deps.txStatus + deps.anchorHeightOf + deps.btcTip) — the caller must NOT pay on !ok.
//
// CONFIRMED-FUNDING + TXID-BOUND BLOCK: the funding block is derived from the ACTUAL txid's CONFIRMED status,
// NEVER the maker-supplied blockHash — so a maker cannot pass a fake/mempool leg with a deeply-buried decoy
// block. A still-mempool (0-conf) funding is WAITED OUT (never trusted). A bounded 0-conf front (legAtoms <=
// max0ConfAtoms) is the ONLY case that deliberately accepts a mempool leg (small amount, verified on Sequentia).
export async function waitAnchorBuried({ txid, blockHash, minAnchorDepth, legAtoms, max0ConfAtoms, deadlineMs, pollMs }, deps, nap) {
  const sleep = nap || _sleep;
  const deadline = Date.now() + (Number(deadlineMs) || 20 * 60 * 1000);
  const cap = Number(max0ConfAtoms || 0);
  const zeroConfFront = cap > 0 && legAtoms != null && _big(legAtoms) <= _big(cap);
  let last = null;
  for (;;) {
    let v;
    if (zeroConfFront) {
      v = anchorDepthVerdict({ anchorHeight: null, btcTip: null, minAnchorDepth, legAtoms, max0ConfAtoms });
    } else {
      const cb = await resolveConfirmedBlock(txid, deps);
      if (cb.confirmed && cb.block_hash) {
        let ah = null; try { ah = await deps.anchorHeightOf(cb.block_hash); } catch { ah = null; }
        let tip = null; try { tip = await deps.btcTip(); } catch { tip = null; }
        v = anchorDepthVerdict({ anchorHeight: ah, btcTip: tip, minAnchorDepth, legAtoms, max0ConfAtoms });
        if (v.ok) v.boundBlock = cb.block_hash;
      } else {
        v = { ok: false, depth: -1, reason: 'the asset HTLC funding tx is not confirmed on Sequentia yet (0-conf; waiting)' };
      }
    }
    if (v.ok) return v;
    last = v;
    if (Date.now() > deadline) return { ok: false, depth: (last && last.depth != null) ? last.depth : -1, reason: (last && last.reason) || 'asset HTLC not anchor-buried in time', timedOut: true };
    await sleep(Number(pollMs) || 10000);
  }
}

// ===========================================================================
// PURE fund-safety cores (no I/O) — the VerifySEQLeg checks, split so each is
// independently unit-testable, and composed by verifySeqLeg() below.
// ===========================================================================

// rebuildAndCheckRedeem — the counterparty's HTLC redeem script MUST be exactly the
// Design-A HTLC binding OUR claim key + H + the stated refund key + locktime. We
// REBUILD it from those (never trust the maker's bytes) and byte-compare to the
// provided script. This is what proves the asset HTLC's claim branch is spendable by
// US with P. `buildRedeem` is injected (C.wasm.buildSeqHtlcRedeemScript).
// Returns { ok, reason, redeem } — redeem is the canonical lowercased hex.
export function rebuildAndCheckRedeem({ hashH, myClaimPub, makerRefundPub, locktime, providedScript }, buildRedeem) {
  if (!_hex64(hashH)) return { ok: false, reason: 'hash_h must be 32-byte hex' };
  if (!_hex66(myClaimPub)) return { ok: false, reason: 'my claim pubkey must be 33-byte hex' };
  if (!_hex66(makerRefundPub)) return { ok: false, reason: 'maker refund pubkey must be 33-byte hex' };
  const lt = Number(locktime);
  if (!Number.isFinite(lt) || lt <= 0) return { ok: false, reason: 'locktime must be a positive block height' };
  if (typeof buildRedeem !== 'function') return { ok: false, reason: 'no redeem-script builder wired' };
  let rebuilt;
  try { rebuilt = String(buildRedeem(hashH.toLowerCase(), myClaimPub.toLowerCase(), makerRefundPub.toLowerCase(), lt)).toLowerCase(); }
  catch (e) { return { ok: false, reason: 'redeem rebuild failed: ' + ((e && e.message) || String(e)) }; }
  const provided = String(providedScript || '').toLowerCase();
  if (!provided) return { ok: false, reason: 'no redeem_script provided' };
  if (rebuilt !== provided)
    return { ok: false, reason: 'redeem_script does not match H + my-claim/maker-refund keys + locktime (asset HTLC is not locked to this wallet)' };
  return { ok: true, reason: 'redeem binds my claim key on H', redeem: rebuilt };
}

// checkLegBinding — the announced leg's amount/asset/locktime bind to the SIGNED
// offer's expectations (the taker verified the offer before lifting). Amount is exact
// (whole-HTLC lift). Asset is exact when the leg states one. Locktime matches the
// verified terms.
export function checkLegBinding({ leg, expectAsset, expectAtoms, expectLocktime }) {
  if (!leg) return { ok: false, reason: 'no asset leg in the maker message' };
  if (_big(leg.amount) !== _big(expectAtoms))
    return { ok: false, reason: `asset leg amount ${String(leg.amount)} != offer ${String(expectAtoms)}` };
  if (leg.asset && expectAsset && String(leg.asset).toLowerCase() !== String(expectAsset).toLowerCase())
    return { ok: false, reason: `asset leg asset ${leg.asset} != offer ${expectAsset}` };
  if (expectLocktime != null && Number(leg.locktime) !== Number(expectLocktime))
    return { ok: false, reason: `asset leg locktime ${leg.locktime} != terms ${expectLocktime}` };
  if (!leg.txid || leg.vout == null) return { ok: false, reason: 'asset leg has no funding outpoint' };
  return { ok: true, reason: 'leg binds to the offer' };
}

// checkFundingOutput — the on-chain funding output ACTUALLY pays the HTLC P2SH the
// rebuilt redeem script produces, with the expected amount + asset. `output` is what
// the chain read returned ({ value, asset, spk? }); `expectSpkHex` is the P2SH
// scriptPubkey derived from the (already byte-checked) redeem script.
export function checkFundingOutput({ output, expectSpkHex, expectAtoms, expectAsset }) {
  if (!output) return { ok: false, reason: 'the asset HTLC funding output was not found on-chain (not yet confirmed?)' };
  // REQUIRE the P2SH match — NEVER skip it. The funding output's scriptPubkey MUST equal P2SH(the rebuilt
  // redeem); this is what proves the on-chain asset is locked in the exact HTLC we verified (claim=my key on
  // H) and not some look-alike output the maker pointed us at. FAIL CLOSED when either side is unreadable:
  // paying/exposing against an output we cannot bind to the redeem is the exact hole this closes.
  if (!expectSpkHex) return { ok: false, reason: 'could not derive the HTLC P2SH scriptPubkey to verify the funding output (failing closed)' };
  if (output.spk == null) return { ok: false, reason: 'the funding output scriptPubkey is unreadable — cannot confirm it pays the HTLC P2SH (failing closed)' };
  if (String(output.spk).toLowerCase() !== String(expectSpkHex).toLowerCase())
    return { ok: false, reason: 'the funding output does not pay the HTLC P2SH' };
  if (output.value != null && _big(output.value) !== _big(expectAtoms))
    return { ok: false, reason: `the funding output value ${String(output.value)} != expected ${String(expectAtoms)}` };
  if (output.asset && expectAsset && String(output.asset).toLowerCase() !== String(expectAsset).toLowerCase())
    return { ok: false, reason: `the funding output asset ${output.asset} != expected ${expectAsset}` };
  return { ok: true, reason: 'funding output pays the HTLC P2SH with the right asset + amount' };
}

// anchorDepthVerdict — the SEQ funding block is Bitcoin-anchor-buried to >=
// minAnchorDepth (never pay against a reorg-able asset HTLC). Depth is derived the
// SAME way every wallet watcher does: depth = btcTip - anchorHeight + 1. A 0-conf
// LP-fronting swap (legAtoms <= max0ConfAtoms > 0) skips the DEPTH wait and accepts
// the Bitcoin-reorg risk on that small amount (the leg is still verified + confirmed
// on Sequentia). Pure.
export function anchorDepthVerdict({ anchorHeight, btcTip, minAnchorDepth, legAtoms, max0ConfAtoms }) {
  const cap = Number(max0ConfAtoms || 0);
  if (cap > 0 && legAtoms != null && _big(legAtoms) <= _big(cap))
    return { ok: true, depth: 0, zeroConf: true, reason: `0-conf front (leg ${String(legAtoms)} atoms <= cap ${cap})` };
  const min = Math.max(2, Number(minAnchorDepth || 0) || 3);
  const ah = Number(anchorHeight), tip = Number(btcTip);
  if (!Number.isFinite(ah) || ah <= 0) return { ok: false, depth: -1, reason: 'the SEQ block is not Bitcoin-anchored yet' };
  if (!Number.isFinite(tip)) return { ok: false, depth: -1, reason: 'the Bitcoin tip is unreadable' };
  const depth = Math.max(0, tip - ah + 1);
  if (depth < min) return { ok: false, depth, reason: `asset HTLC anchor depth ${depth} < required ${min}` };
  return { ok: true, depth, reason: `asset HTLC anchor-buried (depth ${depth} >= ${min})` };
}

// verifySeqLeg — compose ALL the checks with real I/O (deps). This is the single
// fund-safety gate the taker runs on the counterparty's on-chain asset HTLC BEFORE its
// irreversible act. It rebuilds + byte-checks the redeem, binds the leg to the offer,
// reads the funding output on-chain (asset/amount/P2SH), and (unless skipAnchor) runs
// the anchor-depth gate. Returns { ok, reason, redeem, leg, anchor } — throws never;
// the caller decides how to surface a failure (and MUST NOT pay/claim on !ok).
//
// deps: { buildRedeem, htlcSpkHex, readOutput, txStatus, anchorHeightOf, btcTip }
//   txStatus(txid) -> { confirmed, block_hash } binds the anchor block to the ACTUAL funding txid (never the
//   maker-supplied leg.block_hash); the anchor gate fails closed unless the tx is CONFIRMED.
export async function verifySeqLeg({
  hashH, myClaimPub, makerRefundPub, leg, expectAsset, expectAtoms, expectLocktime,
  minAnchorDepth, max0ConfAtoms, skipAnchor = false,
}, deps) {
  // 1. Rebuild + byte-check the redeem (proves claim=my key on H).
  const r = rebuildAndCheckRedeem({ hashH, myClaimPub, makerRefundPub, locktime: leg && leg.locktime, providedScript: leg && leg.redeem_script }, deps.buildRedeem);
  if (!r.ok) return { ok: false, reason: r.reason };
  // 2. Bind the leg's amount/asset/locktime to the signed offer's expectations.
  const b = checkLegBinding({ leg, expectAsset, expectAtoms, expectLocktime });
  if (!b.ok) return { ok: false, reason: b.reason };
  // 3. Read the funding output on-chain and confirm it pays the HTLC P2SH.
  let output = null;
  try { output = await deps.readOutput(leg.txid, leg.vout); } catch { output = null; }
  const expectSpkHex = (typeof deps.htlcSpkHex === 'function') ? (() => { try { return deps.htlcSpkHex(r.redeem); } catch { return null; } })() : null;
  const f = checkFundingOutput({ output: output && { ...output, spk: output.spk }, expectSpkHex, expectAtoms, expectAsset });
  if (!f.ok) return { ok: false, reason: f.reason };
  // 4. Anchor-depth gate (the ONLY step that can be skipped, and only for a 0-conf front). CONFIRMED-FUNDING +
  //    TXID-BOUND BLOCK: require the funding tx be CONFIRMED and derive the anchor block from the ACTUAL txid's
  //    OWN confirmed block (deps.txStatus), NEVER the maker-supplied leg.block_hash — so a maker cannot pass a
  //    fake/mempool leg with a deeply-buried decoy block. FAIL CLOSED on unconfirmed / txid->block unbindable.
  let anchor = { ok: true, depth: null, skipped: true, reason: 'anchor gate skipped by caller' };
  if (!skipAnchor) {
    const cap = Number(max0ConfAtoms || 0);
    const zeroConfFront = cap > 0 && leg && leg.amount != null && _big(leg.amount) <= _big(cap);
    if (zeroConfFront) {
      anchor = anchorDepthVerdict({ anchorHeight: null, btcTip: null, minAnchorDepth, legAtoms: leg.amount, max0ConfAtoms });
    } else {
      const cb = await resolveConfirmedBlock(leg && leg.txid, deps);
      if (!cb.confirmed || !cb.block_hash)
        return { ok: false, reason: 'the asset HTLC funding tx is not confirmed on Sequentia (or its block cannot be bound to the txid) — refusing a 0-conf / unbindable leg', anchor: { ok: false, depth: -1, reason: 'funding tx unconfirmed / txid->block unbound' } };
      let anchorHeight = null;
      try { anchorHeight = await deps.anchorHeightOf(cb.block_hash); } catch { anchorHeight = null; }
      let tip = null;
      try { tip = await deps.btcTip(); } catch { tip = null; }
      anchor = anchorDepthVerdict({ anchorHeight, btcTip: tip, minAnchorDepth, legAtoms: leg.amount, max0ConfAtoms });
      if (anchor.ok) anchor.boundBlock = cb.block_hash;
    }
    if (!anchor.ok) return { ok: false, reason: anchor.reason, anchor };
  }
  return { ok: true, reason: 'asset HTLC verified + anchor-gated', redeem: r.redeem, leg, anchor };
}

// ===========================================================================
// DISPATCH — the rail-crossing decision the wallet reads at settlement (a thin,
// intent-shaped wrapper over the shared chooseSettlementPath so the whole wallet has
// ONE import for it). Given a rail-blind TAKE (taker rails + the resting offer) it
// returns { path:'native'|'p2p-submarine'|'lsp-bridge', ln_direction, lnSide }.
// P2P submarine when the maker is interactive + can accept BTC-LN; the LSP bridge on a
// genuine mismatch. PURE.
// ===========================================================================
export function dispatchSubswap({ asset, side, payRail, recvRail, offer }) {
  const { makerBtcRail, makerAssetRail } = makerRailsFromOffer(offer);
  const match = matchFromTake({ asset, side, payRail, recvRail, makerBtcRail, makerAssetRail,
    takerAssetInbound: false, takerBtcInbound: false });
  // The offer's signed capability descriptor (unified-book meta.caps) decides P2P vs the LSP bridge.
  const disp = chooseSettlementPath(match, (offer && offer.meta) || {});
  // OFFER-THEN-REFUSE guard: the P2P submarine AND the wired LSP leg-bridge BOTH require the asset leg to be a
  // single ON-CHAIN HTLC. If the best-price offer rests its asset over Lightning (offer.rail==='ln' ->
  // makerAssetRail 'ln'), the asset leg ALSO crosses and neither settles it — honest-disable ('unsupported')
  // rather than misroute into a doomed native submarine / startMixed. crossingShapeSupported is the SHARED
  // authority for "BTC-leg crossing with a NATIVE asset leg" (identical to the LSP's own bridge admission).
  if ((disp.path === 'p2p-submarine' || disp.path === 'lsp-bridge') && !crossingShapeSupported(planSettlement(match)))
    return { path: 'unsupported', ln_direction: null, lnSide: disp.lnSide,
      reason: 'the maker rests the asset over Lightning; this rail crossing needs an on-chain asset leg' };
  return disp;
}

// ===========================================================================
// PAYER / BUY — the P2P reverse submarine taker (ln_direction=1, RunTakerReverseSubmarine).
//
//   taker -> XcSubTermsRequest{taker_seq_claim_pub}
//   maker -> XcSubAssetLocked{hash_h, maker_refund_pub, seq_locktime, leg(SEQ), bolt11}
//   taker  : verifySeqLeg (claim=MY key on H, asset/amount/locktime, anchor-buried) ->
//            PayInvoice(bolt11) -> learn P -> persist(P+leg) -> ClaimSEQLeg(P)
//
// The ONLY way to obtain P is to pay the maker's invoice, and paying it IS the maker
// capturing BTC-LN — so the maker cannot capture BTC-LN without handing us the key to
// a pre-locked, pre-verified, anchor-buried asset HTLC. We verify 3+4 before our single
// irreversible act (the pay), and persist P before claiming.
//
// deps (buy): { session?, offer, takeAtoms, feeAsset, seqClaimKey:{public_key,secret_hex},
//   buildRedeem, htlcSpkHex, readOutput, anchorHeightOf, btcTip, seqTip()->number, payInvoice(bolt11)->preimageHex,
//   claimSeq({txid,vout,amount,asset_id,redeem_script,claim_secret,secret_hex})->txid, sha256Hex,
//   expect:{asset,atoms,msat}, minAnchorDepth, max0ConfAtoms, claimMargin, anchorWaitMs, anchorPollMs,
//   onLocked?, onVerified?, onAboutToPay?({leg,hash_h,bolt11}), onPaid?(P,leg), onClaimed?(txid), log?, sleep?, recvWaitMs? }
//
// VERIFY-BEFORE-PAY (ALL fail-closed BEFORE the single irreversible payInvoice): (2) redeem+binding+P2SH
// (claim=my key on H, right asset/amount/locktime, funding pays the HTLC P2SH); (3) seq claim window; (4)
// anchor-buried POLL; (5) bolt11 payment_hash === H; (6) bolt11 amount == the offer price; (7) re-check the
// claim window; (8) persist leg+bolt11+marker; then (9) pay. The taker cannot lose BTC-LN without the
// verified, window-gated, anchor-buried asset already locked to its own key on the same H.
// ===========================================================================
export async function runTakerReverseSubmarine(deps) {
  const log = deps.log || (() => {});
  const nap = deps.sleep || _sleep;
  const claimPub = deps.seqClaimKey && deps.seqClaimKey.public_key;
  const claimSecret = deps.seqClaimKey && deps.seqClaimKey.secret_hex;
  if (!_hex66(claimPub) || !claimSecret) throw new Error('reverse submarine: a 33-byte seq claim key (public_key + secret_hex) is required');
  if (!deps.expect || !deps.expect.asset || !(_big(deps.expect.atoms) > 0n)) throw new Error('reverse submarine: offer expectations (asset + atoms) are required');

  const session = deps.session || await openCourierSession(
    { offer_id: deps.offer.offer_id || deps.offer.id, maker_pubkey: deps.offer.maker_pubkey || deps.offer.maker },
    deps.takeAtoms != null ? deps.takeAtoms : deps.expect.atoms, deps.feeAsset || '');
  try {
    // 1. Request terms; hand the maker our SEQ-claim pubkey up front.
    await session.send({ type: XcSubType.TermsRequest, taker_seq_claim_pub: claimPub.toLowerCase() });
    const locked = await session.recv(XcSubType.AssetLocked, deps.recvWaitMs || 15 * 60 * 1000);
    if (deps.onLocked) { try { deps.onLocked(locked); } catch {} }
    const leg = locked.leg;
    if (!leg || !locked.bolt11) { await session.fail('MISSING_LEG', 'asset leg + bolt11 required'); throw new Error('reverse submarine: maker sent no asset leg / bolt11'); }

    // 2. VERIFY the asset HTLC binds MY claim key on H (redeem byte-check + asset/amount/locktime + the on-chain
    //    funding output pays the HTLC P2SH). skipAnchor here — the anchor gate is a POLL below (step 4).
    const v = await verifySeqLeg({
      hashH: locked.hash_h, myClaimPub: claimPub, makerRefundPub: locked.maker_refund_pub, leg,
      expectAsset: deps.expect.asset, expectAtoms: deps.expect.atoms, expectLocktime: locked.seq_locktime,
      minAnchorDepth: deps.minAnchorDepth, max0ConfAtoms: deps.max0ConfAtoms, skipAnchor: true,
    }, deps);
    if (!v.ok) { await session.fail('SEQ_LEG_INVALID', v.reason); throw new Error('reverse submarine: ' + v.reason); }
    if (deps.onVerified) { try { deps.onVerified(v); } catch {} }

    // 3. SEQ CLAIM WINDOW (P2, mirror of runTakerSubmarine's minSeqClaimWindow): the asset HTLC's T_seq MUST
    //    leave enough runway that after paying + claiming we are still strictly before it. Refuse a leg whose
    //    window is already too small (a maker could otherwise refund the asset out from under a paid taker).
    const seqLt = Number(locked.seq_locktime);
    const claimMargin = Number(deps.claimMargin || 120);
    let seqTip1 = null; try { seqTip1 = Number(await deps.seqTip()); } catch { seqTip1 = null; }
    if (seqTip1 == null || !Number.isFinite(seqTip1)) { await session.fail('SEQ_TIP_UNREADABLE', 'seq tip'); throw new Error('reverse submarine: the Sequentia tip is unreadable (cannot gate the claim window; failing closed)'); }
    if (!(seqLt > seqTip1 + claimMargin)) { await session.fail('BAD_LOCKTIME', 'seq_locktime leaves too small a claim window'); throw new Error(`reverse submarine: seq_locktime ${seqLt} vs tip ${seqTip1} leaves < ${claimMargin}-block claim window`); }

    // 4. ANCHOR GATE (P1): POLL until the asset HTLC funding block is Bitcoin-anchor-buried >= min_anchor_depth
    //    (a fresh 0–2 conf leg is WAITED OUT, not aborted) — a plain invoice cannot be refunded once paid.
    const anchor = await waitAnchorBuried({ txid: leg.txid, blockHash: leg.block_hash, minAnchorDepth: deps.minAnchorDepth,
      legAtoms: leg.amount, max0ConfAtoms: deps.max0ConfAtoms, deadlineMs: deps.anchorWaitMs, pollMs: deps.anchorPollMs }, deps, nap);
    if (!anchor.ok) { await session.fail('ANCHOR_TIMEOUT', anchor.reason); throw new Error('reverse submarine: ' + anchor.reason); }

    // 5. PAYMENT-HASH gate (mirror of clnLNLeg.Pay(bolt11, wantHash)): decode the invoice and REQUIRE its
    //    payment_hash === H BEFORE paying. Paying an invoice whose hash != H yields a preimage that opens
    //    NOTHING — the single worst fund-loss (BTC gone, no asset). FAIL CLOSED when the hash is undecodable.
    const payHash = bolt11PaymentHash(locked.bolt11);
    if (!payHash || payHash !== String(locked.hash_h).toLowerCase()) {
      await session.fail('BAD_INVOICE_HASH', 'bolt11 payment_hash != H');
      throw new Error(`reverse submarine: the invoice payment_hash ${payHash || '(undecodable)'} != the asset HTLC hash H — NOT paying (it would open nothing)`);
    }
    // 6. AMOUNT gate: a STATED invoice amount MUST equal the offer's BTC price (never over/underpay). An
    //    amountless invoice is fine (the taker's node pays exactly the offer amount).
    const invMsat = bolt11AmountMsat(locked.bolt11);
    if (invMsat != null && deps.expect.msat != null && invMsat !== _big(deps.expect.msat)) {
      await session.fail('BAD_INVOICE_AMOUNT', 'bolt11 amount != the offer price');
      throw new Error(`reverse submarine: the invoice demands ${String(invMsat)} msat != the offer's ${String(deps.expect.msat)} msat`);
    }
    // 7. RE-CHECK the claim window immediately before the irreversible pay (the tip may have advanced during
    //    the anchor poll; never pay into a window that has since closed).
    let seqTip2 = null; try { seqTip2 = Number(await deps.seqTip()); } catch { seqTip2 = null; }
    if (seqTip2 == null || !Number.isFinite(seqTip2) || !(seqLt > seqTip2 + claimMargin)) {
      await session.fail('BAD_LOCKTIME', 'seq claim window closed before pay');
      throw new Error(`reverse submarine: the claim window closed before paying (seq_locktime ${seqLt} vs tip ${seqTip2}) — NOT paying`);
    }

    // 7b. HOLD-INVOICE CLTV gate (fund-loss — the hold masquerade). A bolt11 hold invoice is byte-identical to
    //     a plain one, so a malicious interactive maker could hand a HOLD invoice whose min_final_cltv lets it
    //     keep our payment HELD settleable PAST T_seq: hold it, refund the asset at T_seq, THEN settle the hold
    //     — capturing our BTC-LN with no asset for us. Decode min_final_cltv (default 18 if absent) and REQUIRE
    //     that the LATEST the maker could still settle (btcTip + finalCltv, converted to the seq timeframe with
    //     the CONSERVATIVE INVERSE ratio — slow-BTC / fast-SEQ, the OPPOSITE ends from the forward bridge, so the
    //     maker's reach in SEQ height is UPPER-bounded) leaves us a claim margin before T_seq. Fail closed (never
    //     pay) otherwise. The read of btcTip is only a liveness reference — the gate is a pure seq-tip delta, so
    //     an unreadable btcTip does not by itself gate.
    const finalCltv = bolt11MinFinalCltv(locked.bolt11);
    let btcTipNow = null; try { btcTipNow = Number(await deps.btcTip()); } catch { btcTipNow = null; }
    const cltvGate = holdCltvSafeVsTseq({ finalCltv, seqTip: seqTip2, seqLocktime: seqLt, claimMargin });
    if (!cltvGate.ok) {
      await session.fail('BAD_HOLD_CLTV', 'bolt11 min_final_cltv could let a hold settle past T_seq');
      throw new Error('reverse submarine: ' + cltvGate.reason);
    }
    // Cap our OWN outgoing payment's max-cltv-delay at the invoice's own min_final_cltv (fc) so a HELD payment
    // fails back (refunds us) as EARLY as the invoice allows — we must NOT extend the window past what the maker
    // demanded (a larger cap would only let a masqueraded hold linger longer). fc is the floor a route can commit
    // (it cannot promise less than the invoice's min_final_cltv), so pinning the cap to fc keeps the pay feasible
    // while never itself extending the window. The gate already proved this fc is safe (settleDeadline < T_seq).
    const payMaxCltv = Number(finalCltv) || 0;
    log('[subswap/buy] asset HTLC verified, window-gated + anchor-buried (%s); hold-CLTV safe (final_cltv %d, settle-by ~seq %d < T_seq %d, btc tip %s); paying the invoice',
      anchor.reason, Number(finalCltv), cltvGate.settleDeadlineSeq, seqLt, (btcTipNow == null ? '?' : btcTipNow));

    // 8. CRASH GAP: persist the leg outpoint + bolt11 + an 'awaiting-preimage' marker BEFORE payInvoice, so a
    //    crash between the (irreversible) pay and learning P can RECOVER P (resumeReversePay re-queries the node)
    //    and claim — never silently drops a record that may have paid.
    if (deps.onAboutToPay) { try { deps.onAboutToPay({ leg: { ...leg, redeem_script: v.redeem }, hash_h: String(locked.hash_h).toLowerCase(), bolt11: locked.bolt11 }); } catch {} }

    // 9. Pay the invoice -> learn P. IRREVERSIBLE. Persist P + leg BEFORE the claim (crash-safety). Thread
    //    wantHash(H)+amountMsat into the pay so the node can bind the payment_hash + amount (mirror the Go
    //    PayInvoice(bolt11,wantHash,amountMsat)); the client-side pre-pay gates above remain the PRIMARY guard.
    const preimage = String(await deps.payInvoice(locked.bolt11, { wantHash: String(locked.hash_h).toLowerCase(),
      amountMsat: (deps.expect && deps.expect.msat != null) ? deps.expect.msat : undefined, maxCltv: payMaxCltv })).toLowerCase();
    if (!_hex64(preimage)) throw new Error('reverse submarine: the BTC-LN payment returned no 32-byte preimage');
    // Defence-in-depth: the preimage we were paid MUST hash to H (else it opens nothing).
    if (deps.sha256Hex) {
      let ph = ''; try { ph = String(await deps.sha256Hex(preimage)).toLowerCase(); } catch {}
      if (ph && ph !== String(locked.hash_h).toLowerCase()) throw new Error('reverse submarine: the learned preimage does not hash to H');
    }
    const claimRec = { txid: leg.txid, vout: leg.vout, amount: String(leg.amount), asset_id: deps.expect.asset,
      redeem_script: v.redeem, claim_secret: claimSecret, secret_hex: preimage };
    if (deps.onPaid) { try { deps.onPaid(preimage, { ...leg, redeem_script: v.redeem }); } catch {} }

    // 10. Claim the asset with the learned P (RETRYABLE — we hold P; a failure here is recoverable via
    //    claimReverseSeqLeg on the persisted record).
    const claimTxid = await deps.claimSeq(claimRec);
    if (deps.onClaimed) { try { deps.onClaimed(claimTxid); } catch {} }
    log('[subswap/buy] paid BTC-LN, learned P, claimed the asset in %s', claimTxid);
    return { ok: true, preimage, seqClaimTxid: claimTxid, leg: { ...leg, redeem_script: v.redeem } };
  } finally {
    try { session.close && session.close(); } catch {}
  }
}

// claimReverseSeqLeg — RESUME the claim of a reverse-submarine (or LSP payer-bridge) buy from a persisted
// record that already learned P + the verified leg. Idempotent-safe (a re-claim of an already-spent HTLC
// just fails harmlessly and the asset is already ours). Used on reload so a crash between the irreversible
// act and the claim never strands the asset.
export async function claimReverseSeqLeg(rec, deps) {
  if (!rec || !_hex64(rec.preimage) || !rec.leg || !rec.leg.txid) throw new Error('claimReverseSeqLeg: need a persisted P + verified leg');
  const claimSecret = deps.seqClaimKey && deps.seqClaimKey.secret_hex;
  if (!claimSecret) throw new Error('claimReverseSeqLeg: the seq claim secret is required');
  const leg = rec.leg;
  const txid = await deps.claimSeq({ txid: leg.txid, vout: leg.vout, amount: String(leg.amount), asset_id: rec.asset || leg.asset,
    redeem_script: leg.redeem_script, claim_secret: claimSecret, secret_hex: rec.preimage });
  if (deps.onClaimed) { try { deps.onClaimed(txid); } catch {} }
  return { ok: true, seqClaimTxid: txid };
}

// resumeReversePay — RECOVER a reverse-submarine BUY that crashed AFTER the persist-before-pay (state 'paying':
// leg + bolt11 + H persisted) but BEFORE learning P. This closes the crash gap: a 'paying' record MUST NEVER be
// silently dropped (it may already have paid). We (idempotently) re-drive the payment on the SAME bolt11 — a
// Lightning node returns the CACHED preimage for an invoice it already settled, so re-paying RECOVERS P without
// a second payment — then verify sha256(P)==H and claim. Guarded by the claim window: past T_seq the maker may
// have refunded the asset, so we do NOT (re)pay (no loss) and report not-recovered so the caller keeps it
// resumable. Returns { ok, recovered, preimage?, seqClaimTxid?, reason? }; throws only on a bad record.
// deps: { payInvoice(bolt11)->preimageHex|null, sha256Hex?, seqClaimKey:{secret_hex}, claimSeq, seqTip?, claimMargin?, onClaimed? }
export async function resumeReversePay(rec, deps) {
  if (!rec || !rec.leg || !rec.leg.txid || !rec.bolt11 || !_hex64(rec.hash_h)) throw new Error('resumeReversePay: need a persisted leg + bolt11 + H');
  // Claim-window safety: only (re)drive the payment while the asset HTLC is still ours to claim.
  if (rec.leg.locktime != null && typeof deps.seqTip === 'function') {
    let tip = null; try { tip = Number(await deps.seqTip()); } catch { tip = null; }
    const margin = Number(deps.claimMargin || 120);
    if (tip != null && Number.isFinite(tip) && !(Number(rec.leg.locktime) > tip + margin))
      return { ok: false, recovered: false, reason: 'the claim window has closed; NOT re-paying (no loss)' };
  }
  let preimage = null;
  try { preimage = await deps.payInvoice(rec.bolt11, { wantHash: String(rec.hash_h).toLowerCase() }); } catch { preimage = null; }   // idempotent: cached P if already settled
  if (!preimage || !_hex64(String(preimage).toLowerCase())) return { ok: false, recovered: false, reason: 'the BTC-LN payment has not settled yet — keep resumable' };
  preimage = String(preimage).toLowerCase();
  if (deps.sha256Hex) {
    let ph = ''; try { ph = String(await deps.sha256Hex(preimage)).toLowerCase(); } catch {}
    if (ph && ph !== String(rec.hash_h).toLowerCase()) return { ok: false, recovered: false, reason: 'the recovered preimage does not hash to H' };
  }
  const r = await claimReverseSeqLeg({ preimage, leg: rec.leg, asset: rec.asset || rec.leg.asset }, deps);
  return { ok: true, recovered: true, preimage, seqClaimTxid: r.seqClaimTxid };
}

// ===========================================================================
// RECEIVER / SELL — the P2P normal submarine taker (ln_direction=0, RunTakerSubmarine).
//
//   taker -> XcSubTermsRequest
//   maker -> XcSubTerms{maker_seq_claim_pub, seq_locktime, seq_amount, min_anchor_depth}
//   taker  : mint P/H; mint a bolt11 on H at its OWN BTC-LN node (a HODL hold, device holds P);
//            fund the asset HTLC (claim=maker, refund=taker)
//   taker -> XcSubAssetFunded{hash_h, taker_seq_refund_pub, leg(SEQ), bolt11}
//   maker  : verify -> anchor-gate -> pay the bolt11 (HELD at the taker's node)
//   taker  : sees the hold HELD -> settle it with P -> RECEIVES BTC-LN + reveals P -> maker claims asset
//   If the maker never pays before T_seq, the taker refunds the asset HTLC.
//
// Single on-chain HTLC, single T_seq gate. The taker's ONE irreversible act is settling the hold — which
// simultaneously captures the BTC and reveals P — so it can never reveal P without capturing the BTC.
//
// deps (sell): { session?, offer, takeAtoms, feeAsset, seqRefundKey:{public_key,secret_hex},
//   randomSecret()->32-byte hex, sha256Hex(hex)->hex, buildRedeem, htlcSpkHex,
//   fundSeq({redeemHex,asset,atoms})->{txid,vout,block_hash,height}, anchorHeightOf,
//   mintHold({hashH,preimage,msat,expirySecs})->{node_id,bolt11?}, invoiceStatus({hashH})->{held,settled},
//   settleHold({hashH,preimage})->any, seqTip()->number,
//   expect:{asset,atoms,msat}, minSeqClaimWindow, holdExpirySecs,
//   onAboutToFund?({hash_h,preimage,redeem,seq_locktime,node_id,refund_pub,refund_secret,asset,atoms}),
//   onFunded?(rec), onHeld?(), onSettled?(), log?, sleep?, holdPollMs?, holdWaitMs?, recvWaitMs? }
//
// SELL PERSIST-BEFORE-FUND (fund-loss): P/H/redeem + the intended leg are persisted via onAboutToFund BEFORE
// fundSeq broadcasts the asset HTLC (mirror of the reverse buy's onAboutToPay). fundSeq broadcasts then waits
// ~12min to confirm; a reload in that window MUST be able to recover H/P/redeem and re-derive the funding
// outpoint (findFundingByAddress) — never strand a funded-but-unpersisted asset. There is NO window where the
// asset HTLC is funded but H/P are unpersisted.
// ===========================================================================
export async function runTakerSubmarine(deps) {
  const log = deps.log || (() => {});
  const nap = deps.sleep || _sleep;
  const refundPub = deps.seqRefundKey && deps.seqRefundKey.public_key;
  if (!_hex66(refundPub)) throw new Error('normal submarine: a 33-byte seq refund key (public_key) is required');
  if (!deps.expect || !deps.expect.asset || !(_big(deps.expect.atoms) > 0n) || !(_big(deps.expect.msat) > 0n))
    throw new Error('normal submarine: offer expectations (asset + atoms + msat) are required');

  const session = deps.session || await openCourierSession(
    { offer_id: deps.offer.offer_id || deps.offer.id, maker_pubkey: deps.offer.maker_pubkey || deps.offer.maker },
    deps.takeAtoms != null ? deps.takeAtoms : deps.expect.atoms, deps.feeAsset || '');
  try {
    // 1. Request terms.
    await session.send({ type: XcSubType.TermsRequest });
    const terms = await session.recv(XcSubType.Terms, deps.recvWaitMs || 2 * 60 * 1000);

    // 2. Validate terms against the signed offer + a live-tip claim window.
    if (!_hex66(terms.maker_seq_claim_pub)) { await session.fail('BAD_PUBKEY', 'maker_seq_claim_pub'); throw new Error('normal submarine: bad maker_seq_claim_pub'); }
    if (_big(terms.seq_amount) !== _big(deps.expect.atoms)) { await session.fail('BAD_AMOUNT', 'seq_amount != offer'); throw new Error(`normal submarine: seq_amount ${terms.seq_amount} != offer ${deps.expect.atoms}`); }
    const seqTip = Number(await deps.seqTip());
    const minWindow = Number(deps.minSeqClaimWindow || 120);
    const seqLocktime = Number(terms.seq_locktime);
    if (!(seqLocktime > seqTip) || (seqLocktime - seqTip) < minWindow) {
      await session.fail('BAD_LOCKTIME', 'seq_locktime leaves too small a refund window');
      throw new Error(`normal submarine: seq_locktime ${seqLocktime} vs tip ${seqTip} (min window ${minWindow})`);
    }

    // 3. Mint P/H, mint a bolt11 (HODL hold on H) at our OWN BTC-LN node — we RECEIVE its BTC-LN.
    const preimage = String(await deps.randomSecret()).toLowerCase();
    if (!_hex64(preimage)) throw new Error('normal submarine: randomSecret must return 32-byte hex');
    const hashH = String(await deps.sha256Hex(preimage)).toLowerCase();
    if (!_hex64(hashH)) throw new Error('normal submarine: sha256Hex must return 32-byte hex');
    // Mint a PLAIN bolt11 on H at our OWN node, PASSING P so the node auto-settles on payment (receives the
    // BTC-LN + reveals P to the maker via update_fulfill_htlc). A payable bolt11 is what the maker's driver
    // requires (RunMakerSubmarine needs Bolt11 != ''); we also carry node_id + amount_msat so a pay-by-hash
    // maker can pay when no bolt11 is available. If the node still returns no bolt11, the settle-with-P loop
    // below (HODL fallback) still captures the BTC once the maker's pay lands HELD.
    const hold = await deps.mintHold({ hashH, preimage, msat: Number(deps.expect.msat), expirySecs: Number(deps.holdExpirySecs || 0) || undefined });
    if (!(hold && hold.node_id)) throw new Error('normal submarine: could not mint the BTC-LN invoice on your node');

    // 4. Build the redeem, then PERSIST P/H/redeem + the INTENDED leg BEFORE broadcasting the asset HTLC
    //    (crash-safety, mirror of the buy's onAboutToPay): fundSeq broadcasts + waits ~12min to confirm, and a
    //    reload in that window must RECOVER H/P/redeem and re-derive the funding — never strand a
    //    funded-but-unpersisted asset. ONLY after the persist do we broadcast. Then onFunded records the outpoint.
    const redeem = String(deps.buildRedeem(hashH, String(terms.maker_seq_claim_pub).toLowerCase(), String(refundPub).toLowerCase(), seqLocktime)).toLowerCase();
    if (deps.onAboutToFund) { try { deps.onAboutToFund({ hash_h: hashH, preimage, redeem, seq_locktime: seqLocktime,
      node_id: hold.node_id, refund_pub: refundPub, refund_secret: deps.seqRefundKey.secret_hex,
      asset: deps.expect.asset, atoms: String(deps.expect.atoms) }); } catch {} }
    const funded = await deps.fundSeq({ redeemHex: redeem, asset: deps.expect.asset, atoms: deps.expect.atoms });
    const leg = { txid: funded.txid, vout: funded.vout, amount: String(deps.expect.atoms), asset: deps.expect.asset,
      redeem_script: redeem, locktime: seqLocktime, block_hash: funded.block_hash || null, height: funded.height || null };
    const rec = { hash_h: hashH, preimage, seq_locktime: seqLocktime, node_id: hold.node_id, leg,
      refund_pub: refundPub, refund_secret: deps.seqRefundKey.secret_hex };
    if (deps.onFunded) { try { deps.onFunded(rec); } catch {} }

    // 5. Announce the funded leg + the invoice (the maker verifies + anchor-gates + pays).
    let anchorHeight = null; try { anchorHeight = await deps.anchorHeightOf(leg.block_hash); } catch {}
    await session.send({ type: XcSubType.AssetFunded, hash_h: hashH, taker_seq_refund_pub: refundPub.toLowerCase(),
      bolt11: hold.bolt11 || undefined,
      taker_ln_node_id: hold.node_id, amount_msat: Number(deps.expect.msat),   // pay-by-hash fallback when no payable bolt11
      leg: { txid: leg.txid, vout: leg.vout, amount: Number(leg.amount), asset: deps.expect.asset, redeem_script: redeem,
        locktime: seqLocktime, block_hash: leg.block_hash || undefined, anchor_height: anchorHeight || undefined } });
    log('[subswap/sell] asset HTLC funded %s:%d; awaiting the maker paying our hold on H=%s', leg.txid, leg.vout, hashH);

    // 6. Await the hold being HELD, then SETTLE it with P (receive BTC-LN + reveal P -> maker claims asset).
    const deadline = Date.now() + (Number(deps.holdWaitMs) || 2 * 60 * 60 * 1000);
    for (;;) {
      let s = null; try { s = await deps.invoiceStatus({ hashH }); } catch {}
      if (s && s.settled) { if (deps.onSettled) { try { deps.onSettled(); } catch {} } return { ok: true, preimage, leg, settled: true }; }
      if (s && s.held) {
        if (deps.onHeld) { try { deps.onHeld(); } catch {} }
        await deps.settleHold({ hashH, preimage });   // captures the BTC + reveals P; idempotent
        if (deps.onSettled) { try { deps.onSettled(); } catch {} }
        log('[subswap/sell] hold HELD -> settled with P; received BTC-LN, maker claims the asset');
        return { ok: true, preimage, leg, settled: true };
      }
      if (Date.now() > deadline) return { ok: false, preimage, leg, reason: 'the maker never paid the hold in time; refund the asset after T_seq', refundable: true };
      await nap(Number(deps.holdPollMs) || 5000);
    }
  } finally {
    try { session.close && session.close(); } catch {}
  }
}

// ===========================================================================
// LSP PAYER BRIDGE — the buy FALLBACK vs an on-chain-only maker.
//
//   0. mint H (hold P self-custody); POST /swap {side:'buy', bridge:true, payRail:'ln', recvRail:'chain',
//      hash_h:H, taker_seq_claim_pub, offer_id, maker_pubkey, btc_sats, asset_atoms, ...} -> job
//   1. poll GET /swap/<id> for bridge_terms (the forward-maker terms secured)
//   2. POST /bridge/hold {job_id} -> the LSP issues a BTC-LN HOLD on H at its node -> pay it (HELD)
//   3. the LSP funds the on-chain BTC HTLC to the maker; the maker locks the asset to OUR key on H and
//      the LSP relays it -> job.maker_seq_leg
//   4. VERIFY the maker asset leg (claim=my key on H, asset/amount/locktime, anchor) then ClaimSEQLeg(P)
//      self-custody. Claiming reveals P -> the LSP recoups its front (settles our hold) — WE already have
//      the asset. We never expose P until we hold the verified, anchor-buried asset locked to our key.
//
// deps (payer bridge): { lspSwap(body)->resp, lspSwapStatus(jobId)->resp, lspBridgeHold({job_id})->resp,
//   payHold({node_id,bolt11,hashH,minFinalCltv})->preimageHex|any, randomSecret()->hex, sha256Hex,
//   seqClaimKey, buildRedeem, htlcSpkHex, readOutput, anchorHeightOf, btcTip, claimSeq, persist?(rec),
//   onPaid?(P,leg), onClaimed?(txid), asset, assetAtoms, btcSats, offer, minAnchorDepth, max0ConfAtoms,
//   log?, sleep?, pollMs?, handshakeWaitMs?, legWaitMs? }
// ===========================================================================
export async function runLspPayerBridge(deps) {
  const log = deps.log || (() => {});
  const nap = deps.sleep || _sleep;
  const pollMs = Number(deps.pollMs) || 4000;
  const claimPub = deps.seqClaimKey && deps.seqClaimKey.public_key;
  const claimSecret = deps.seqClaimKey && deps.seqClaimKey.secret_hex;
  if (!_hex66(claimPub) || !claimSecret) throw new Error('payer bridge: a 33-byte seq claim key is required');
  if (!(deps.offer && (deps.offer.id || deps.offer.offer_id) && (deps.offer.maker || deps.offer.maker_pubkey)))
    throw new Error('payer bridge: offer_id + maker_pubkey are required to lift the forward maker');
  if (!(_big(deps.btcSats) > 0n)) throw new Error('payer bridge: btc_sats > 0 is required to bound the price the LSP funds');

  // 0. Mint P self-custody; H = sha256(P). The LSP + maker only ever see H.
  const preimage = String(await deps.randomSecret()).toLowerCase();
  if (!_hex64(preimage)) throw new Error('payer bridge: randomSecret must return 32-byte hex');
  const hashH = String(await deps.sha256Hex(preimage)).toLowerCase();
  const rec = { hash_h: hashH, preimage, asset: deps.asset, state: 'starting' };
  if (deps.persist) { try { deps.persist(rec); } catch {} }

  // POST /swap bridge:true buy — the taker mints H (holds P) and hands its OWN asset-claim key.
  const swapBody = { side: 'buy', bridge: true, payRail: 'ln', recvRail: 'chain', asset: deps.asset,
    amount: String(deps.assetAtoms), asset_atoms: String(deps.assetAtoms), btc_sats: String(deps.btcSats),
    offer_id: deps.offer.offer_id || deps.offer.id, maker_pubkey: deps.offer.maker_pubkey || deps.offer.maker,
    hash_h: hashH, taker_seq_claim_pub: claimPub.toLowerCase(),
    maker_btc_rail: 'chain', maker_asset_rail: 'chain', taker_asset_inbound: false, taker_btc_inbound: false };
  const started = await deps.lspSwap(swapBody);
  const jobId = (started && (started.job_id || started.jobId)) || null;
  const poll = (started && started.poll) || jobId;
  if (!poll) throw new Error('payer bridge: the LSP /swap returned no job handle');
  rec.job_id = jobId; rec.poll = poll; rec.state = 'confirming';
  if (deps.persist) { try { deps.persist(rec); } catch {} }

  // 1. Poll for the forward-maker terms (bridge_terms).
  let terms = null;
  const hsDeadline = Date.now() + (Number(deps.handshakeWaitMs) || 10 * 60 * 1000);
  for (;;) {
    const j = await deps.lspSwapStatus(poll).catch(() => null);
    if (j && j.bridge_terms && j.bridge_terms.hash_h) {
      if (String(j.bridge_terms.hash_h).toLowerCase() !== hashH) throw new Error('payer bridge: the LSP handshake bound a different H');
      terms = j.bridge_terms; break;
    }
    if (j && (j.status === 'failed' || (j.bridgeHandshake && j.bridgeHandshake.ok === false)))
      throw new Error('payer bridge: the forward-maker handshake failed: ' + ((j.bridgeHandshake && j.bridgeHandshake.error) || j.error || 'unknown'));
    if (Date.now() > hsDeadline) throw new Error('payer bridge: the forward-maker terms never arrived (nothing committed)');
    await nap(pollMs);
  }

  // 2. Ask the LSP to issue the BTC-LN hold on H, then PAY it (HELD, not captured). ALL fail-closed BEFORE the
  //    single irreversible act (paying the hold) — zero exposure on any failure.
  const holdResp = await deps.lspBridgeHold({ job_id: jobId });
  if (!(holdResp && holdResp.ok !== false)) throw new Error('payer bridge: the LSP refused to issue the hold: ' + ((holdResp && holdResp.error) || 'unknown'));
  // FAIL CLOSED with ZERO exposure when the LSP cannot issue a PAYABLE hold bolt11 (the seqln node's
  // hold-invoice minting is not yet lit up). Never pay-by-hash blindly here — without a decodable invoice we
  // cannot prove the hold binds our H before paying.
  if (!holdResp.bolt11) throw new Error('payer bridge: the LSP issued no payable BTC-LN hold invoice (bolt11) — the hold-invoice node update is needed; use an interactive maker for now (zero exposure)');
  // PAYMENT-HASH assert (both the stated field AND the decoded bolt11): the hold MUST bind OUR H, or paying it
  // hands the LSP a preimage that opens nothing of ours.
  if (holdResp.payment_hash && String(holdResp.payment_hash).toLowerCase() !== hashH) throw new Error('payer bridge: the LSP hold payment_hash != our H — NOT paying');
  const holdHash = bolt11PaymentHash(holdResp.bolt11);
  if (!holdHash || holdHash !== hashH) throw new Error('payer bridge: the hold bolt11 payment_hash != our H — NOT paying (it would open nothing of ours)');
  // OVERPAY guard: never HOLD-pay more BTC than the offer's price (btc_sats). amount_msat is authoritative when
  // present, else the decoded invoice amount; an amountless hold is fine (we pay exactly the offer amount).
  const holdMsat = (holdResp.amount_msat != null) ? _big(holdResp.amount_msat) : bolt11AmountMsat(holdResp.bolt11);
  const maxMsat = _big(deps.btcSats) * 1000n;
  if (holdMsat != null && holdMsat > maxMsat) throw new Error(`payer bridge: the hold demands ${String(holdMsat)} msat > the offer's ${String(maxMsat)} msat — NOT paying`);
  // Thread the min-final-CLTV (>= the LSP-committed hold_min_final_cltv) into the hold payment so its incoming
  // HTLC stays settleable past T_seq.
  await deps.payHold({ node_id: holdResp.node_id, bolt11: holdResp.bolt11, hashH,
    minFinalCltv: Number(holdResp.hold_min_final_cltv) || undefined, amountMsat: Number(holdResp.amount_msat) || undefined });
  rec.state = 'held'; if (deps.persist) { try { deps.persist(rec); } catch {} }
  log('[subswap/payer-bridge] BTC-LN hold on H paid (HELD); the LSP funds the maker BTC leg');

  // 3. Wait for the maker's asset leg (the LSP relays it to us after funding + verify).
  let leg = null;
  const legDeadline = Date.now() + (Number(deps.legWaitMs) || 45 * 60 * 1000);
  for (;;) {
    const j = await deps.lspSwapStatus(poll).catch(() => null);
    const ml = j && (j.maker_seq_leg || (j.bridge_terms && j.bridge_terms.maker_seq_leg));
    if (ml && ml.txid) { leg = ml; break; }
    if (j && j.status === 'failed') throw new Error('payer bridge: the swap failed before the asset leg locked: ' + (j.error || 'unknown'));
    if (Date.now() > legDeadline) throw new Error('payer bridge: the maker never locked the asset leg (the hold expires no-loss)');
    await nap(pollMs);
  }

  // 4. VERIFY the maker asset leg binds MY claim key on H + anchor-buried, THEN claim with P (reveals P;
  //    the LSP recoups by settling our hold — we already hold the asset).
  const v = await verifySeqLeg({
    hashH, myClaimPub: claimPub, makerRefundPub: terms.maker_seq_refund_pub, leg: {
      txid: leg.txid, vout: leg.vout, amount: leg.amount, asset: leg.asset || deps.asset,
      redeem_script: leg.redeem_script, locktime: leg.locktime },
    expectAsset: deps.asset, expectAtoms: deps.assetAtoms, expectLocktime: Number(terms.seq_locktime) || leg.locktime,
    minAnchorDepth: deps.minAnchorDepth, max0ConfAtoms: deps.max0ConfAtoms,
  }, { ...deps, readOutput: deps.readOutput, anchorHeightOf: (bh) => deps.anchorHeightOf(bh || leg.block_hash) });
  if (!v.ok) throw new Error('payer bridge: the maker asset leg failed verification (NOT claiming; the hold expires no-loss): ' + v.reason);

  const legFull = { txid: leg.txid, vout: leg.vout, amount: String(leg.amount), asset: deps.asset, redeem_script: v.redeem, locktime: Number(terms.seq_locktime) || leg.locktime };
  rec.leg = legFull; rec.state = 'claiming'; if (deps.persist) { try { deps.persist(rec); } catch {} }
  if (deps.onPaid) { try { deps.onPaid(preimage, legFull); } catch {} }
  const claimTxid = await deps.claimSeq({ txid: leg.txid, vout: leg.vout, amount: String(leg.amount), asset_id: deps.asset,
    redeem_script: v.redeem, claim_secret: claimSecret, secret_hex: preimage });
  rec.state = 'settled'; rec.seq_claim_txid = claimTxid; if (deps.persist) { try { deps.persist(rec); } catch {} }
  if (deps.onClaimed) { try { deps.onClaimed(claimTxid); } catch {} }
  log('[subswap/payer-bridge] claimed the asset in %s (P now public; the LSP recoups its front)', claimTxid);
  return { ok: true, preimage, seqClaimTxid: claimTxid, leg: legFull };
}

export default {
  XcSubType, bolt11AmountMsat, bolt11PaymentHash, bolt11MinFinalCltv, holdCltvSafeVsTseq, sizeSubswapTake, waitAnchorBuried,
  rebuildAndCheckRedeem, checkLegBinding, checkFundingOutput, anchorDepthVerdict, verifySeqLeg,
  dispatchSubswap, runTakerReverseSubmarine, claimReverseSeqLeg, resumeReversePay, runTakerSubmarine, runLspPayerBridge,
};
