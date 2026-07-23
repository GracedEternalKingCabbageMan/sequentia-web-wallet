// leg-bridge.mjs — the LSP's NON-CUSTODIAL per-leg bridge for a genuine rail crossing.
//
// planSettlement (settlement-router.mjs) decides WHICH legs cross (rail-blind matching, then a bridge
// ONLY where the two ends' rail choices genuinely differ). THIS module is the fund-safety DECISION CORE
// for executing ONE crossed leg. It is PURE: given the OBSERVED on-chain + Lightning state of the leg's
// two ends, it returns the single next SAFE action. The live driver does the I/O (LN hold pay/settle +
// on-chain HTLC fund/claim/refund, all via the LSP primitives that already exist) and must NEVER deviate
// from this decision. Keeping the decision here, pure, means the fund-safety is exhaustively unit-tested
// without a node, exactly like settlement-router.mjs.
//
// A crossed leg has ONE Lightning end and ONE on-chain end, bound by the SAME preimage H. The LSP is the
// counterparty to BOTH ends. planLeg.lnSide names which endpoint is on Lightning:
//
//   lnSide='receiver' — the RECEIVER wants Lightning; the PAYER is on-chain.
//     The LSP PAYS the receiver over LN (their hold invoice on H) and RECOUPS by claiming the payer's
//     on-chain HTLC — which must be locked to the LSP — with the P the receiver's LN settlement reveals.
//     RULE: front the LN ONLY after the payer's HTLC is on-chain, locked to the LSP, for the agreed
//     amount, with enough CLTV runway to still claim AFTER the receiver settles. Then claim before that
//     CLTV. Never front without that recoup secured — so the LSP can only ever STALL into a refundable
//     no-loss failure (the LN hold returns to the LSP; the HTLC refunds to the payer), never lose value.
//
//   lnSide='payer' — the PAYER wants Lightning; the RECEIVER is on-chain.
//     The LSP RECEIVES the payer's LN (their hold invoice on H, HELD) and FRONTS the receiver's leg
//     on-chain (an HTLC locked to the receiver, refundable to the LSP). The receiver's on-chain claim
//     reveals P; the LSP settles the held LN with it.
//     RULE: fund the on-chain HTLC ONLY after the payer's LN is HELD; give the on-chain HTLC a CLTV that
//     matures WELL BEFORE the LN hold expires (so a no-claim ends in the LSP refunding on-chain AND the
//     LN hold returning to the payer — both no-loss); settle the LN the instant the on-chain claim
//     reveals P. Never fund on-chain without the payer's LN held.
//
// The LSP learns P (that is HOW it recoups) but NEVER holds either party's keys, and its recoup is bounded
// to EXACTLY the value it fronted on that leg — so it can never steal, only stall. That is the
// non-custodial property. Whole-swap atomicity across BOTH legs is one shared H; the caller gates the
// reveal until every leg of the match is locked (settlement-router: atomic.lspCoordinates).

/** @typedef {'receiver'|'payer'} LnSide */

// Default block margins (caller may override per chain/leg). Deliberately conservative.
export const BRIDGE_DEFAULTS = Object.freeze({
  // Min CLTV runway (blocks) the on-chain HTLC must have BEYOND the current tip before the LSP fronts,
  // so there is room for the counterparty to act AND the LSP to recoup before expiry.
  frontRunway: 6,
  // The LSP must recoup (claim/refund) at least this many blocks BEFORE the on-chain CLTV, never racing it.
  claimMargin: 2,
  // lnSide='payer': the on-chain HTLC CLTV must be at least this many blocks INSIDE the LN hold's
  // remaining lifetime, so an unclaimed on-chain HTLC refunds to the LSP before the LN hold is at risk.
  holdBuffer: 6,
  // lnSide='receiver': the COUNTERPARTY's on-chain HTLC (the LSP's recoup target) must have at least this
  // many confirmations before the LSP fronts irreversible LN against it. A 0-conf recoup target can be
  // RBF'd / double-spent out from under the front by a malicious counterparty (who mints P), letting them
  // take the fronted LN AND reclaim their on-chain funds. 1 confirmation removes the fee-bump/RBF path.
  minRecoupConf: 1,
});

/**
 * Decide the next safe action for ONE bridged leg.
 * @param {{lnSide:LnSide, amountSat:number, lspClaimPub?:string, receiverClaimPub?:string}} leg
 * @param {{
 *   tip:number,                       // current block height of the ON-CHAIN end's chain
 *   onchain:null|{ funded:boolean, amountSat:number, cltv:number, lockedToLsp?:boolean, lockedToReceiver?:boolean, spent?:boolean, refundable?:boolean },
 *   ln:{ registered:boolean, held:boolean, settled:boolean, preimage:string|null, expiryBlocks?:number },
 *   swapLocked?:boolean,              // WHOLE-SWAP atomicity: are ALL OTHER legs of this swap locked?
 *                                     // Undefined => true (single-leg / back-compat). When false, the LSP
 *                                     // withholds the ONE value-front action that would let P be revealed
 *                                     // (front-ln for a receiver leg; fund-onchain for a payer leg) so a
 *                                     // partial (this leg reveals, another never locks) is impossible.
 *   crossLock?:{ seqTip:number, seqRefundHeight:number },
 *                                     // reverse-cross receiver leg only: the taker asset HTLC's refund height
 *                                     // T_seq + the LIVE seq tip for the front-time locktime-ordering re-check
 *                                     // against the LIVE tip (W1). The maker BTC-HTLC refund height T_btc is
 *                                     // oc.cltv and the live BTC tip is obs.tip; the gate needs nothing more.
 *   preimage?:string|null,            // reverse-cross receiver leg only: P once it is PUBLIC (the maker has
 *                                     // claimed the taker's relayed asset). Lets the front-time gate ALLOW a
 *                                     // front that is IMMEDIATELY recoupable with the known P (W2b).
 *   recvReady?:boolean,               // reverse-cross receiver leg only (W2 FRONT-BEFORE-FUND): has the taker
 *                                     // registered its BTC-LN hold on H and handed its recv_node_id? The front
 *                                     // is withheld until this is true (===false withholds; undefined/true =>
 *                                     // ready, back-compat) — it REPLACES swapLocked for a crossLock leg, so
 *                                     // the LSP fronts BEFORE the taker exposes its asset (see stepReceiverLn).
 * }} obs
 * @param {object} [cfg] overrides for BRIDGE_DEFAULTS
 * @returns {{action:'wait'|'front-ln'|'fund-onchain'|'recoup-claim'|'recoup-settle'|'refund-onchain'|'fail-closed'|'done', reason:string}}
 */
export function nextBridgeStep(leg, obs, cfg = {}) {
  if (!leg || (leg.lnSide !== 'receiver' && leg.lnSide !== 'payer'))
    throw new Error("nextBridgeStep: leg.lnSide must be 'receiver' or 'payer'");
  if (!obs || !obs.ln || typeof obs.tip !== 'number')
    throw new Error('nextBridgeStep: obs needs {tip, onchain, ln}');
  // FUND-SAFETY: the whole point of this core is "never front more than we recoup". That check compares the
  // recoup HTLC amount against leg.amountSat, so an absent/invalid leg.amountSat silently DEFEATS it
  // (`realAmount < undefined` is false). Refuse to decide at all without a real positive bound — the caller
  // MUST supply the leg's amount. Fail closed (not throw) so a wiring bug becomes a no-loss stall, not a crash.
  if (!Number.isFinite(leg.amountSat) || leg.amountSat <= 0)
    return { action: 'fail-closed', reason: `INVARIANT: leg.amountSat must be a positive number to bound the front (got ${JSON.stringify(leg.amountSat)}) — refuse to front an unbounded amount (caller wiring bug)` };
  const c = { ...BRIDGE_DEFAULTS, ...cfg };
  return leg.lnSide === 'receiver'
    ? stepReceiverLn(leg, obs, c)
    : stepPayerLn(leg, obs, c);
}

// ============================================================================
// W1 — LOCKTIME-ORDERING GATE (pure). Fund-safe BY CONSTRUCTION.
//
// The receiver-leg block runway above (frontRunway/claimMargin) only compares BLOCK counts on the
// on-chain end. It does NOT relate the BTC-HTLC refund height to the taker's asset-HTLC refund height
// (T_seq) + the taker's LN hold life. A malicious maker exploits exactly that gap: it sets a SHORT
// BTC-HTLC refund locktime T_btc that still clears the block runway, lets the LSP front the taker's
// long-lived LN hold, WAITS, then at T_btc REFUNDS its own BTC HTLC (reclaiming its BTC) and only AFTER
// that claims the taker's asset HTLC with P — revealing P. The honest taker reads P, settles its LN hold
// (collecting the fronted BTC-LN and revealing P to the LSP), but the LSP's recoup target — the maker's
// BTC HTLC — is already refunded and gone. Full-front loss.
//
// THE ROOT FIX (single BTC-time assumption; no two divisors). Everything the LSP recoups is on Bitcoin:
// the front is a BTC-LN hold HTLC and the recoup target is the maker's BTC HTLC. So the whole safety
// relation lives in BTC BLOCKS from the front block, and is INDEPENDENT of the actual BTC block time:
//
//   requiredTakerBlocks   = the BTC blocks the front HTLC MUST survive to keep the taker's hold settleable
//                           until strictly after the maker's latest asset claim (T_seq) + reorg/settle
//                           margin — sized from T_seq with the ONE conservative-fast BTC block time
//                           (HOLD_LIFE_DEFAULTS.fastBtcSecsPerBlock) via requiredTakerHold. This is EXACTLY
//                           the min-final-CLTV the LSP mints the front HTLC with, so the gate and the mint
//                           share one BTC-time assumption. (The OLD gate used a SECOND, larger BTC divisor
//                           to convert T_btc — 480 vs the mint's 150 — which admitted a fast-BTC band where
//                           the taker was protected but the LSP was not. That divisor is GONE.)
//   recoupDeadlineBlocks  = (T_btc - btcTip) - claimMargin — the BTC block by which the LSP must have
//                           claimed the maker's BTC HTLC with P. A pure BTC-block quantity.
//
// THE GATE: require recoupDeadlineBlocks >= requiredTakerBlocks. If the maker's T_btc is too small to
// cover the taker's required front survival, REFUSE (fail closed — nothing is fronted, and the wallet
// falls back to native). When it PASSES, minFinalCltvBlocks = requiredTakerBlocks is <= recoupDeadlineBlocks
// by construction, so the front HTLC's expiry (frontBtcTip + minFinalCltvBlocks) is SIMULTANEOUSLY
// >= T_seq + margin (taker safe — the hold outlives the maker's latest claim under conservative-fast BTC)
// AND <= T_btc - claimMargin (LSP recoups — it claims before the maker can refund). The safe window is
// non-empty IFF the gate passes, in ANY block-time regime. The honest fleet with a SHORT T_btc (~100 BTC
// blocks) whose T_seq needs a ~210-block front HTLC is now correctly REJECTED — its T_btc simply cannot
// cover the taker's survival — and falls back to native. That is CORRECT and safe; do NOT weaken the gate.
//
// W1-UNIT — a Bitcoin/Elements nLockTime (hence a CLTV height) is a BLOCK HEIGHT only while it is
// < 500,000,000; at or above that BIP-65 LOCKTIME_THRESHOLD it is a UNIX TIMESTAMP. This gate does
// BLOCK-HEIGHT arithmetic (refundHeight - tip), so a TIMESTAMP CLTV is meaningless here — and a malicious
// maker who sets a timestamp locktime would make (btcRefundHeight - btcTip) a HUGE bogus block count that
// clears the inequality trivially = bypass. The maker's BTC CLTV is refused as a non-height at the point it
// is parsed/verified (bridge-maker.verifyMakerBtcHtlc, which imports this constant), so the arithmetic below
// is always valid in production; the gate ALSO asserts height-ness defensively (see checkBridgeLocktimeOrdering)
// so it can NEVER pass on a timestamp regardless of how it is called.
export const LOCKTIME_THRESHOLD = 500000000;

export const LOCKTIME_GATE_DEFAULTS = Object.freeze({
  // BTC blocks the LSP needs to get its recoup claim (spending the maker's BTC HTLC with P) mined BEFORE that
  // HTLC's refund height T_btc: recoupDeadlineBlocks = (T_btc - btcTip) - claimMarginBlocks. A pure BTC-block
  // margin — the front HTLC and the maker HTLC both live on Bitcoin, so this is independent of the block time.
  // Conservatively >= BRIDGE_DEFAULTS.claimMargin (the driver's own claim-imminent margin, 2) so the front
  // HTLC's expiry (<= T_btc - claimMarginBlocks) always leaves the driver strictly more runway than it needs.
  claimMarginBlocks: 6,
});

/**
 * Fund-safety gate for the reverse-cross bridge (W1). Pure and fund-safe BY CONSTRUCTION: works entirely in
 * BTC BLOCKS from the current BTC tip, using the ONE conservative-fast BTC block time (via requiredTakerHold,
 * the SAME function that sizes the front HTLC's min-final-CLTV — no second divisor). Returns whether the
 * maker's T_btc gives enough recoup runway to cover the taker's required front-HTLC survival. Fails closed on
 * any missing/invalid/degenerate input, and delegates the min/max T_seq bound + LN max-CLTV feasibility to
 * requiredTakerHold (so a collapsed/too-far/infeasible T_seq is refused right here).
 *
 * @param {{
 *   btcTip:number, btcRefundHeight:number,     // maker's BTC HTLC: current BTC tip + its CLTV refund height T_btc
 *   seqTip:number, seqRefundHeight:number,      // taker's asset HTLC: current SEQ tip + its CLTV refund height T_seq
 *   cfg?:object                                 // overrides for LOCKTIME_GATE_DEFAULTS + HOLD_LIFE_DEFAULTS (threaded to requiredTakerHold)
 * }} args
 * @returns {{ ok:boolean, reason:string, requiredTakerBlocks:number, recoupDeadlineBlocks:number, minFinalCltvBlocks:number, btcBlocksToRefund:number }}
 */
export function checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight, seqTip, seqRefundHeight, cfg = {} } = {}) {
  const c = { ...LOCKTIME_GATE_DEFAULTS, ...cfg };
  const fail = (reason) => ({ ok: false, reason, requiredTakerBlocks: NaN, recoupDeadlineBlocks: NaN, minFinalCltvBlocks: NaN, btcBlocksToRefund: NaN });
  for (const [k, v] of Object.entries({ btcTip, btcRefundHeight, seqTip, seqRefundHeight })) {
    if (!Number.isFinite(v)) return fail(`locktime gate: ${k} is not a finite number — cannot bound the front, fail closed`);
  }
  // W1-UNIT (defensive) — a CLTV refund locktime >= LOCKTIME_THRESHOLD is a UNIX TIMESTAMP, not a block
  // height, so the height arithmetic below would be nonsense (and a timestamp T_btc would make the "blocks
  // to refund" a huge bogus number that trivially clears the gate). A non-height CLTV is already refused at
  // parse/verify (bridge-maker), but assert it HERE too so the gate can never pass on a timestamp regardless
  // of caller. Either refund locktime looking like a timestamp => fail closed. (Tips come from getblockcount
  // and are always heights; only the two refund locktimes are counterparty-influenced, so those are asserted;
  // seqRefundHeight is re-asserted inside requiredTakerHold/checkTseqWithinBound as belt-and-suspenders.)
  for (const [k, v] of Object.entries({ btcRefundHeight, seqRefundHeight })) {
    if (v >= LOCKTIME_THRESHOLD) return fail(`locktime gate: ${k} ${v} is a UNIX TIMESTAMP (>= ${LOCKTIME_THRESHOLD}), not a block height — height arithmetic is invalid, fail closed`);
  }
  const btcBlocksToRefund = btcRefundHeight - btcTip;
  // The maker's BTC HTLC is already at/after its refund height -> it can refund NOW; never front.
  if (btcBlocksToRefund <= 0) return fail(`locktime gate: maker BTC HTLC is already refundable (T_btc ${btcRefundHeight} <= tip ${btcTip}) — refuse to front`);
  // (a) requiredTakerBlocks — the BTC blocks the front HTLC MUST survive to keep the taker's hold settleable
  // until strictly after the maker's latest asset claim (T_seq) + reorg/settle margin, sized from T_seq with
  // the SINGLE conservative-fast BTC block time via requiredTakerHold. Reusing that exact function is what
  // makes the gate and the minted front-HTLC min-final-CLTV use ONE consistent BTC-time assumption (no second
  // divisor). It ALSO enforces the min/max T_seq bound + LN max-CLTV feasibility, so any of those failing =>
  // fail closed here (the front-HTLC survival requirement would be un-mintable / degenerate anyway).
  const req = requiredTakerHold({ seqTip, seqRefundHeight, cfg });
  if (!req.ok) return fail(`locktime gate: ${req.reason}`);
  const requiredTakerBlocks = req.minFinalCltvBlocks;
  // (b) recoupDeadlineBlocks — the BTC block, counted from the current tip, by which the LSP must have claimed
  // the maker's BTC HTLC with P. Pure BTC blocks (both HTLCs are on Bitcoin), so this is independent of the
  // actual BTC block time — the whole reason the fix works in ANY regime.
  const recoupDeadlineBlocks = btcBlocksToRefund - c.claimMarginBlocks;
  // THE GATE — the front HTLC (which must survive requiredTakerBlocks to protect the taker) can only be
  // recouped if it expires no later than the recoup deadline. If the maker's T_btc is too small to cover the
  // taker's required survival, REJECT (fail closed; the wallet falls back to native — no bridge). When it
  // passes, minFinalCltvBlocks = requiredTakerBlocks <= recoupDeadlineBlocks, so the front HTLC's expiry is
  // simultaneously >= T_seq + margin (taker safe) AND <= T_btc - claimMargin (LSP recoups) — fund-safe by
  // construction, in any block-time regime.
  if (recoupDeadlineBlocks < requiredTakerBlocks) {
    return { ok: false, requiredTakerBlocks, recoupDeadlineBlocks, minFinalCltvBlocks: requiredTakerBlocks, btcBlocksToRefund,
      reason: `locktime ordering UNSAFE: the maker's T_btc gives only ${recoupDeadlineBlocks} BTC blocks of recoup runway `
            + `(T_btc ${btcRefundHeight} - tip ${btcTip} - claim margin ${c.claimMarginBlocks}) < the ${requiredTakerBlocks} BTC blocks the front HTLC must survive to cover T_seq (${seqRefundHeight}) under conservative-fast BTC. `
            + `A T_btc this small lets the maker refund its BTC before the LSP can recoup with P — refuse to front (fail closed, nothing at stake; the wallet falls back to native).` };
  }
  return { ok: true, requiredTakerBlocks, recoupDeadlineBlocks, minFinalCltvBlocks: requiredTakerBlocks, btcBlocksToRefund,
    reason: `locktime ordering safe: recoup runway ${recoupDeadlineBlocks} BTC blocks (T_btc ${btcRefundHeight} - tip ${btcTip} - claim margin ${c.claimMarginBlocks}) >= the ${requiredTakerBlocks} BTC blocks the front HTLC must survive to cover T_seq — the front HTLC's expiry is >= T_seq + margin (taker safe) and <= T_btc - claim margin (LSP recoups)` };
}

// ============================================================================
// W1-MINT — COUPLE the front HTLC's minted expiry to an ABSOLUTE Bitcoin height at PAY time. Fund-safe BY
// CONSTRUCTION, and STALENESS/DRIFT-PROOF.
//
// THE HOLE this closes. The front HTLC's min-final-CLTV used to be sized ONCE at handshake (from the handshake
// seqTip) and then handed to getroute at PAY time. But getroute's final-cltv is a DELTA from the PAY-time tip,
// so the minted incoming-HTLC's ABSOLUTE expiry = payTip + staleDelta — which FLOATS UP as the BTC tip advances
// between handshake and pay. The front-time gate (checkBridgeLocktimeOrdering, re-run at the live tip) derives a
// FRESH requiredTakerBlocks, so the minted HTLC no longer equals what the gate verified: "minted == gated at the
// same tip" breaks. Two failures reopen as the tip drifts up: (i) the minted expiry OVERSHOOTS T_btc - claimMargin
// (the maker refunds its BTC at T_btc before the LSP can recoup with P = full-front loss); (ii) a stale-short delta
// leaves the HTLC dying BEFORE T_seq (the maker waits it out, then reveals P too late = taker's dead hold, asset gone).
//
// THE FIX. At PAY time, PIN the front HTLC's absolute expiry to the maker's ACTUAL refund minus the claim margin —
// H = T_btc - claimMarginBlocks — and set the getroute DELTA = H - payTip so the minted incoming-HTLC's absolute
// expiry == H EXACTLY, independent of any later drift. That couples the UPPER bound to the maker's real BTC refund,
// so the LSP ALWAYS recoups. Then REQUIRE H >= payTip + requiredTakerBlocks(freshSeqTip) — i.e. the SAME
// locktime-ordering gate, at the LIVE tip — so H also covers T_seq (LOWER bound). If T_btc has drifted so the
// window is empty (recoupDeadlineBlocks < requiredTakerBlocks), FAIL CLOSED: do NOT front. In FRONT-BEFORE-FUND the
// taker has exposed nothing yet, so refusing is a no-loss terminal (falls back to native). This is the SINGLE value
// the LSP mints with — never the stale handshake min-final-CLTV — so gated == minted by construction.
//
// INVARIANT (asserted below): at the live pay tip, T_seq_cover_height <= H <= T_btc - claimMarginBlocks, where H is
// the minted absolute expiry and T_seq_cover_height = payTip + requiredTakerBlocks. Upper holds by construction
// (H IS that bound); lower is exactly the gate that just passed. Both are asserted defensively so a future logic
// regression fails closed rather than minting an unsafe HTLC.

/**
 * Compute the front HTLC's mint target from the LIVE pay-time tips: the ABSOLUTE Bitcoin expiry height it must be
 * minted at (H = T_btc - claimMarginBlocks) and the getroute final-CLTV DELTA from the live tip that lands the
 * minted incoming-HTLC's absolute expiry at H EXACTLY. Pure. Re-runs the locktime-ordering gate at the live tip
 * (so a drifted/short/self-traded T_btc or a collapsed/too-far/infeasible T_seq fails closed) and asserts the
 * mint invariant. This is the ONE value the LSP mints the front HTLC with — NOT the stale handshake
 * min-final-CLTV — so no BTC-tip drift between handshake and pay can float the minted expiry past the maker's
 * refund (LSP can't recoup) or below T_seq (taker's hold dies early).
 *
 * @param {{
 *   btcTip:number, btcRefundHeight:number,     // LIVE BTC tip at PAY time + the maker's BTC HTLC refund height T_btc
 *   seqTip:number, seqRefundHeight:number,      // LIVE SEQ tip at PAY time + the taker's asset HTLC refund height T_seq
 *   cfg?:object                                 // overrides for LOCKTIME_GATE_DEFAULTS + HOLD_LIFE_DEFAULTS (threaded through)
 * }} args
 * @returns {{ ok:boolean, reason:string, absoluteExpiryHeight:number, finalCltvDelta:number, requiredTakerBlocks:number, recoupDeadlineBlocks:number, tSeqCoverHeight:number }}
 */
export function frontHtlcMintTarget({ btcTip, btcRefundHeight, seqTip, seqRefundHeight, cfg = {} } = {}) {
  const c = { ...LOCKTIME_GATE_DEFAULTS, ...cfg };
  const fail = (reason, extra = {}) => ({ ok: false, reason, absoluteExpiryHeight: NaN, finalCltvDelta: NaN,
    requiredTakerBlocks: NaN, recoupDeadlineBlocks: NaN, tSeqCoverHeight: NaN, ...extra });
  // Re-run the SAME locktime-ordering gate the driver ran, at the LIVE pay tip: it derives requiredTakerBlocks from
  // the FRESH seqTip (one BTC-time assumption via requiredTakerHold) and enforces recoupDeadlineBlocks >=
  // requiredTakerBlocks (plus the min/max T_seq bound + LN max-CLTV feasibility inside requiredTakerHold). Any
  // failure => the safe window is empty/unsafe => fail closed (no front). Because the mint delta below is derived
  // from these very same inputs, gated == minted by construction — there is no second value to drift.
  const g = checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight, seqTip, seqRefundHeight, cfg });
  if (!g.ok) return fail(`front mint target: ${g.reason}`,
    { requiredTakerBlocks: g.requiredTakerBlocks, recoupDeadlineBlocks: g.recoupDeadlineBlocks });
  // Pin the absolute expiry to the UPPER bound — the maker's ACTUAL refund minus the claim margin — so the LSP
  // always recoups (claims the maker's BTC HTLC with P strictly before the maker can refund at T_btc). An ABSOLUTE
  // height, so it is invariant to any later BTC-tip drift.
  const absoluteExpiryHeight = btcRefundHeight - c.claimMarginBlocks;
  // The getroute final-CLTV DELTA from the LIVE pay tip that lands the minted incoming-HTLC's absolute expiry at
  // absoluteExpiryHeight EXACTLY. Derived from the absolute height (not a stale handshake delta), so
  // payTip + finalCltvDelta == absoluteExpiryHeight regardless of how the tip drifts afterward. (It equals
  // recoupDeadlineBlocks = (T_btc - payTip) - claimMargin — the gate's own recoup runway.)
  const finalCltvDelta = absoluteExpiryHeight - btcTip;
  const requiredTakerBlocks = g.requiredTakerBlocks;
  const tSeqCoverHeight = btcTip + requiredTakerBlocks;   // the LOWER bound H must reach to keep the hold settleable to T_seq
  // INVARIANT — T_seq_cover_height <= H <= T_btc - claimMarginBlocks. Upper holds by construction (H IS that bound);
  // lower is the gate that just passed (recoupDeadlineBlocks >= requiredTakerBlocks). Assert BOTH defensively: a
  // violation means a logic regression -> fail closed rather than mint an unsafe HTLC.
  if (!Number.isFinite(finalCltvDelta) || finalCltvDelta <= 0)
    return fail(`front mint target: degenerate final-CLTV delta ${finalCltvDelta} (absolute expiry ${absoluteExpiryHeight} <= live tip ${btcTip}) — fail closed`,
      { absoluteExpiryHeight, requiredTakerBlocks, recoupDeadlineBlocks: g.recoupDeadlineBlocks, tSeqCoverHeight });
  if (!(tSeqCoverHeight <= absoluteExpiryHeight && absoluteExpiryHeight <= btcRefundHeight - c.claimMarginBlocks))
    return fail(`front mint target INVARIANT violated: need T_seq cover ${tSeqCoverHeight} <= H ${absoluteExpiryHeight} <= T_btc-claimMargin ${btcRefundHeight - c.claimMarginBlocks} — fail closed`,
      { absoluteExpiryHeight, finalCltvDelta, requiredTakerBlocks, recoupDeadlineBlocks: g.recoupDeadlineBlocks, tSeqCoverHeight });
  return { ok: true, absoluteExpiryHeight, finalCltvDelta, requiredTakerBlocks, recoupDeadlineBlocks: g.recoupDeadlineBlocks, tSeqCoverHeight,
    reason: `front HTLC minted at absolute BTC height ${absoluteExpiryHeight} (= T_btc ${btcRefundHeight} - claim margin ${c.claimMarginBlocks}); getroute final-CLTV delta ${finalCltvDelta} from live tip ${btcTip}; covers T_seq (H >= required cover ${tSeqCoverHeight})` };
}

// ============================================================================
// W1-MINT-VERIFY — VERIFY-NOT-TRUST the ACTUAL committed front-HTLC expiry, not the intended delta.
//
// THE HOLE this closes (round 6). frontHtlcMintTarget pins the INTENDED absolute expiry to H = T_btc -
// claimMargin and returns finalCltvDelta = H - btcTip, where btcTip is read from BITCOIND (subasBtcRpc).
// But that delta is handed to getroute/sendpay on the CLN node, and getroute commits the final-hop HTLC's
// absolute expiry as (the CLN NODE's OWN blockheight) + (the route's final-hop delay) — NOT bitcoind's tip
// plus our intended delta. So the ACTUAL minted expiry can drift off H two ways even after a clean mint:
//   (i) CHAIN-VIEW SKEW. If the CLN node's height differs from bitcoind's by δ = clnBlockheight - btcTip,
//       a delta computed off bitcoind's tip lands the ACTUAL expiry at H + δ. δ>0 pushes it ABOVE
//       T_btc - claimMargin: the LSP can no longer recoup (a maker/self-trader who knows P waits past T_btc,
//       refunds its BTC HTLC, THEN settles the still-live front with P -> LSP full-front loss).
//   (ii) ROUTE PADDING. getroute may pad the final-hop delay (shadow-routing, a recipient min_final_cltv)
//       ABOVE what was requested, independently pushing the committed expiry past H.
// The old invariant was asserted against the INTENDED H/btcTip; route.route[last].delay was never inspected.
//
// THE FIX (two parts; part 1 lives in the driver, part 2 here). (1) The driver bases the getroute delta on
// the CLN node's OWN blockheight (getinfo.blockheight) — the value getroute adds the final delay to — so a
// clean route lands the ACTUAL expiry at H in CLN's view, regardless of δ. (2) AFTER getroute, BEFORE
// sendpay, re-derive the ACTUAL absolute expiry from CLN's OWN tip + the route's OWN final-hop delay and
// REQUIRE it inside [T_seq_cover_height, T_btc - claimMarginBlocks]. An overshoot above the upper bound means
// the LSP could not recoup; below the lower bound means the taker's hold dies before it can settle. Either
// => DO NOT sendpay, FAIL CLOSED: in FRONT-BEFORE-FUND the taker has exposed nothing, so no front is a
// no-loss terminal (native fallback). This is the LSP-side ACTUAL UPPER bound; the taker independently checks
// the ACTUAL LOWER bound against its own node via listhtlcs (swap.js step-4.5). Together the minted HTLC is
// verified on BOTH bounds, off ACTUAL committed values, by the party each bound protects.

/**
 * Verify the ACTUAL final-hop CLTV a route will commit before paying it. Pure. getroute commits the front
 * HTLC's absolute expiry at (the CLN node's OWN blockheight) + (the route's final-hop delay); this recomputes
 * that ACTUAL value and requires it inside [tSeqCoverHeight, absoluteExpiryHeight] (= [T_seq cover, T_btc -
 * claimMargin]). Fails closed on any overshoot OR any non-finite/degenerate input — never trusting the
 * intended delta the mint target requested. Chain-view skew (δ = clnBlockheight - btcTip) and getroute
 * padding are both caught here because the check is against the route's OWN committed delay, not the request.
 *
 * @param {{
 *   clnBlockheight:number,        // the CLN node's OWN blockheight (getinfo.blockheight) — the base getroute adds the final delay to
 *   actualDelay:number,           // route.route[last].delay — the ACTUAL final-hop CLTV delta the route will commit
 *   tSeqCoverHeight:number,       // LOWER bound: the ABSOLUTE BTC height the front HTLC must still be alive at (covers T_seq)
 *   absoluteExpiryHeight:number,  // UPPER bound: H = T_btc - claimMargin — the HTLC must expire no later, so the LSP recoups first
 * }} args
 * @returns {{ ok:boolean, reason:string, actualAbsExpiry:number }}
 */
export function verifyFrontRouteExpiry({ clnBlockheight, actualDelay, tSeqCoverHeight, absoluteExpiryHeight } = {}) {
  const fail = (reason) => ({ ok: false, reason, actualAbsExpiry: NaN });
  if (!Number.isFinite(clnBlockheight) || !Number.isFinite(actualDelay)
    || !Number.isFinite(tSeqCoverHeight) || !Number.isFinite(absoluteExpiryHeight))
    return fail(`front route verify: a non-finite input (CLN tip ${clnBlockheight}, route delay ${actualDelay}, T_seq cover ${tSeqCoverHeight}, H ${absoluteExpiryHeight}) — cannot verify the actual committed expiry, fail closed (no LN fronted)`);
  if (actualDelay <= 0)
    return fail(`front route verify: non-positive final-hop delay ${actualDelay} — a degenerate route, fail closed (no LN fronted)`);
  // The REAL absolute Bitcoin height at which the minted incoming HTLC times out, exactly as getroute commits
  // it: CLN's OWN tip + the route's OWN final-hop delay. Never the intended delta — this is the value that
  // actually protects (or endangers) the LSP's recoup and the taker's hold.
  const actualAbsExpiry = clnBlockheight + actualDelay;
  if (actualAbsExpiry > absoluteExpiryHeight)
    return fail(`front route verify: the ACTUAL committed front-HTLC expiry ${actualAbsExpiry} (CLN tip ${clnBlockheight} + route delay ${actualDelay}) OVERSHOOTS T_btc - claimMargin ${absoluteExpiryHeight} — the maker could refund its BTC HTLC at T_btc before the LSP recoups with P (full-front loss). Fail closed: no LN fronted, the taker exposed nothing (native fallback).`);
  if (actualAbsExpiry < tSeqCoverHeight)
    return fail(`front route verify: the ACTUAL committed front-HTLC expiry ${actualAbsExpiry} (CLN tip ${clnBlockheight} + route delay ${actualDelay}) is BELOW the T_seq cover height ${tSeqCoverHeight} — the taker's hold would lapse before it can settle to collect the front. Fail closed: no LN fronted, the taker exposed nothing (native fallback).`);
  return { ok: true, actualAbsExpiry,
    reason: `front route verify: ACTUAL committed expiry ${actualAbsExpiry} (CLN tip ${clnBlockheight} + route delay ${actualDelay}) is inside [T_seq cover ${tSeqCoverHeight}, T_btc - claimMargin ${absoluteExpiryHeight}] — safe to sendpay` };
}

// ============================================================================
// W2 — HOLD-LIFE vs T_seq (the taker's BTC-LN hold must outlive the maker's latest asset claim).
//
// THE HOLE. In FRONT-BEFORE-FUND the LSP fronts the taker's BTC-LN hold EARLY (as soon as its recoup is
// secured). But the maker's asset-claim window runs all the way to T_seq (terms.seq_locktime — hours out,
// sized for the anchor gate + reorg headroom). If the taker mints its hold with a life SHORTER than that
// window, an adversarial maker simply WAITS until the hold lapses, THEN claims the taker's asset (revealing
// P). The taker's dead hold can no longer be settled to collect the fronted BTC, yet the asset is now
// maker-claimed (unrefundable) — the taker loses the whole asset with no payment.
//
// THE INVARIANT. The taker's hold must stay SETTLEABLE at ANY wall-clock moment the maker could still reveal
// P — i.e. until strictly AFTER T_seq (the maker's latest possible asset claim; after T_seq the taker
// refunds its own asset and the maker can no longer claim) PLUS a reorg/settle margin. Two quantities govern
// settleability and BOTH must span the window:
//   • the hold INVOICE EXPIRY (seconds) — the node cancels the held HTLC once the invoice expires;
//   • the incoming HTLC's FINAL CLTV (blocks) — the HTLC that carries the LSP's fronted payment fails back
//     (funds return to the LSP, taker can no longer settle) once its CLTV times out. For a BARE-HASH hold
//     (no bolt11) the invoice carries no min-final-CLTV, so the PAYER's route sets it — hence the LSP fronts
//     with a CLTV sized from T_seq (frontMinFinalCltv), and the taker requests it via /bridge/front.
//
// The window, converted from block heights to wall-clock CONSERVATIVELY (assume the maker can claim as LATE
// as possible => a SLOW Sequentia block time, so T_seq arrives later => a LONGER required hold):
//   requiredHoldSecs = max(0, T_seq - seqTip) * seqSecsPerBlock  +  reorgMargin  +  settleMargin
// and the HTLC's final CLTV must cover the same window: ceil(requiredHoldSecs / fastBtcSecsPerBlock) + margin.
// The CLTV divisor is a CONSERVATIVELY-SMALL (fast) Bitcoin block time — see fastBtcSecsPerBlock (BUG #1).
//
// FIX 2 (bound) — reject a maker whose T_seq is unreasonably far from OR too near the live tip: too FAR pins
// the taker's hold + the LSP's fronted-funds lock for an unreasonable time (maxTseqBlocks); too NEAR collapses
// the hold-life/CLTV/T_btc margins toward their floor (minTseqBlocks — the self-trade / margin-collapse guard).
// The honest fleet rests near 240 blocks and clears BOTH with wide headroom.
export const HOLD_LIFE_DEFAULTS = Object.freeze({
  // Conservative-SLOW Sequentia block time: assume the maker can claim-and-reveal P as LATE as possible, so
  // T_seq maps to a LATER wall-clock and the hold must live LONGER. This is the SINGLE source of truth for the
  // SEQ block time across the whole bridge — the locktime gate no longer keeps its own copy; it derives the
  // taker's required front-HTLC survival directly from requiredTakerHold (which uses this), so there is nothing
  // to keep in sync and no way for two divisors to drift apart.
  seqSecsPerBlock: 90,
  // THE SINGLE conservative-fast Bitcoin block time — the ONE BTC-time assumption in the whole bridge. It
  // converts the required hold life into the front HTLC's min-final-CLTV (blocks) AND, because the locktime
  // gate reuses requiredTakerHold to get that exact block count, it is ALSO what the gate measures the maker's
  // T_btc recoup runway against. The front HTLC's wall-clock life = minFinalCltvBlocks * ACTUAL_btc_block_time,
  // and the DANGER is it lapsing BEFORE the maker's latest asset claim — which happens when Bitcoin runs FAST
  // (blocks consumed quickly). So this must be a CONSERVATIVELY-SMALL block time: a SMALLER assumed time yields
  // MORE blocks and thus a LONGER guaranteed wall-clock coverage, never a shorter one. 150s covers even a
  // 150s/block burst; kept <= the fast end of testnet4 block times. (The bug this closes: the gate used to
  // convert T_btc with a SECOND, larger BTC divisor (480) while the mint used 150 — a fast-BTC band where the
  // taker was protected but the LSP was not. There is now exactly one divisor, so no such band can exist.)
  fastBtcSecsPerBlock: 150,
  // Reorg headroom: a Bitcoin reorg can delay the maker's anchor-gated asset claim (the asset HTLC must anchor
  // ABOVE the maker's confirmed BTC HTLC — Bitcoin-anchoring supremacy), pushing the reveal of P LATER. The
  // hold must outlive that so it is still settleable when a post-reorg claim finally reveals P.
  reorgMarginSecs: 2 * 3600,
  // Settle headroom: time for the taker to read P off-chain and land its holdinvoicesettle before the hold/HTLC lapses.
  settleMarginSecs: 30 * 60,
  // Extra CLTV blocks over the wall-clock requirement so the HTLC never lapses at the exact boundary.
  cltvMarginBlocks: 6,
  // FIX 2 — the MAX (T_seq - seqTip), in Sequentia blocks, the LSP/taker will accept. Bounds how long the
  // taker's hold AND the LSP's fronted-funds lock stay open. ~12h at the conservative block time; the honest
  // fleet rests near 240 blocks (~6h conservative / ~4h nominal), so this admits it with ~2x headroom while
  // rejecting an absurdly-far T_seq that would pin the front for an unreasonable time.
  maxTseqBlocks: 480,
  // FIX 2b (self-trade / margin-collapse) — the MIN (T_seq - seqTip), in Sequentia blocks, the LSP/taker will
  // accept. A maker (or a maker==taker self-trader) that picks a TINY T_seq collapses requiredSecs toward the
  // margins-only floor, which lets a TINY T_btc clear the locktime-ordering gate — shrinking the LSP's recoup
  // runway AND the taker's observe-and-settle window to nothing (and a T_seq at/below the live tip means the
  // asset HTLC is already refundable, a degenerate leg). Refuse a T_seq nearer than this so the hold life, the
  // front HTLC's CLTV, and the gate's T_btc demand all stay bounded BELOW by a sane minimum. The honest fleet
  // rests near 240 blocks, so this admits it with wide headroom while rejecting a collapsed/degenerate T_seq.
  minTseqBlocks: 120,
  // The LN protocol/routing ceiling on a single HTLC's final CLTV (blocks). If the required min-final-CLTV
  // exceeds this, the taker CANNOT mint a hold that stays settleable to T_seq -> fail closed (nothing funded).
  maxFinalCltvBlocks: 2016,
});

/**
 * FIX 2 — bound how far T_seq may be from the live Sequentia tip, on BOTH sides: not too FAR (maxTseqBlocks)
 * and not too NEAR (minTseqBlocks — the self-trade / margin-collapse guard). Pure. Fails closed on
 * invalid/timestamp input. Shared by the LSP handshake (prepareBridgeLegs) and the taker's own pre-mint check.
 * @returns {{ ok:boolean, reason:string, blocks:number, maxBlocks:number, minBlocks:number }}
 */
export function checkTseqWithinBound({ seqTip, seqRefundHeight, cfg = {} } = {}) {
  const c = { ...HOLD_LIFE_DEFAULTS, ...cfg };
  const fail = (reason) => ({ ok: false, reason, blocks: NaN, maxBlocks: c.maxTseqBlocks, minBlocks: c.minTseqBlocks });
  for (const [k, v] of Object.entries({ seqTip, seqRefundHeight })) {
    if (!Number.isFinite(v)) return fail(`T_seq bound: ${k} is not a finite number — cannot bound the hold, fail closed`);
  }
  // A Sequentia nLockTime >= LOCKTIME_THRESHOLD is a UNIX TIMESTAMP, not a height; the block arithmetic below
  // would be nonsense (and a timestamp T_seq would make "blocks out" a huge bogus number that trivially clears
  // the bound). Refuse it here defensively (verifyMakerBtcHtlc refuses the BTC side's timestamp likewise).
  if (seqRefundHeight >= LOCKTIME_THRESHOLD)
    return fail(`T_seq bound: seqRefundHeight ${seqRefundHeight} looks like a UNIX TIMESTAMP (>= ${LOCKTIME_THRESHOLD}), not a Sequentia block height — fail closed`);
  const blocks = seqRefundHeight - seqTip;
  if (blocks > c.maxTseqBlocks)
    return { ok: false, blocks, maxBlocks: c.maxTseqBlocks, minBlocks: c.minTseqBlocks,
      reason: `T_seq is ${blocks} Sequentia blocks beyond the live tip — above the max ${c.maxTseqBlocks} (~${Math.round(c.maxTseqBlocks * c.seqSecsPerBlock / 3600)}h at the conservative block time). Refuse: it would lock the taker's hold + the LSP's front for an unreasonable time (fail closed, nothing at stake).` };
  // FIX 2b — too NEAR: a tiny (or at/below-tip) T_seq collapses the hold life, the front HTLC's CLTV, and the
  // gate's T_btc demand toward their margins-only floor, so a maker (or a maker==taker self-trader) could then
  // clear the locktime gate with a tiny T_btc and race the LSP's recoup. Refuse it — nothing is at stake yet.
  if (blocks < c.minTseqBlocks)
    return { ok: false, blocks, maxBlocks: c.maxTseqBlocks, minBlocks: c.minTseqBlocks,
      reason: `T_seq is only ${blocks} Sequentia blocks beyond the live tip — below the min ${c.minTseqBlocks} (~${Math.round(c.minTseqBlocks * c.seqSecsPerBlock / 3600)}h at the conservative block time). Refuse: a T_seq this near collapses the hold-life/CLTV/T_btc margins (the self-trade / margin-collapse guard) — fail closed, nothing at stake.` };
  return { ok: true, blocks, maxBlocks: c.maxTseqBlocks, minBlocks: c.minTseqBlocks, reason: `T_seq is ${blocks} blocks out (min ${c.minTseqBlocks} <= ${blocks} <= max ${c.maxTseqBlocks}) — within bound` };
}

/**
 * Compute the taker's required BTC-LN hold sizing from T_seq: the invoice expiry (seconds) and the front
 * HTLC's min-final-CLTV (blocks) that together keep the hold SETTLEABLE until strictly after the maker's
 * latest asset claim + reorg/settle margin. Pure. Enforces the FIX 2 bound and the LN max-CLTV feasibility.
 * @returns {{ ok:boolean, reason:string, requiredSecs:number, holdExpirySecs:number, minFinalCltvBlocks:number, blocks:number, maxBlocks:number }}
 */
export function requiredTakerHold({ seqTip, seqRefundHeight, cfg = {} } = {}) {
  const c = { ...HOLD_LIFE_DEFAULTS, ...cfg };
  const bound = checkTseqWithinBound({ seqTip, seqRefundHeight, cfg });
  if (!bound.ok)
    return { ok: false, reason: bound.reason, requiredSecs: NaN, holdExpirySecs: NaN, minFinalCltvBlocks: NaN, blocks: bound.blocks, maxBlocks: bound.maxBlocks };
  const blocks = Math.max(0, seqRefundHeight - seqTip);   // checkTseqWithinBound already rejected blocks < minTseqBlocks
  const requiredSecs = blocks * c.seqSecsPerBlock + c.reorgMarginSecs + c.settleMarginSecs;
  const holdExpirySecs = Math.ceil(requiredSecs);
  // Size the front HTLC's min-final-CLTV with the SINGLE conservative-fast BTC block time, so the HTLC spans
  // requiredSecs of wall-clock EVEN if Bitcoin runs fast (a smaller divisor => MORE blocks => LONGER guaranteed
  // coverage). This SAME block count is what the locktime gate measures the maker's T_btc recoup runway against
  // (checkBridgeLocktimeOrdering reuses this function), so the taker's survival and the LSP's recoup use one
  // consistent BTC-time assumption — no second divisor, no fast-BTC band where only one side is protected.
  const minFinalCltvBlocks = Math.ceil(requiredSecs / c.fastBtcSecsPerBlock) + c.cltvMarginBlocks;
  if (minFinalCltvBlocks > c.maxFinalCltvBlocks)
    return { ok: false, requiredSecs, holdExpirySecs, minFinalCltvBlocks, blocks: seqRefundHeight - seqTip, maxBlocks: c.maxTseqBlocks,
      reason: `cannot mint a long-enough hold: the required min-final-CLTV ${minFinalCltvBlocks} blocks exceeds the LN maximum ${c.maxFinalCltvBlocks} — refuse to proceed (fail closed, nothing funded)` };
  return { ok: true, requiredSecs, holdExpirySecs, minFinalCltvBlocks, blocks: seqRefundHeight - seqTip, maxBlocks: c.maxTseqBlocks,
    reason: `hold must stay settleable ~${holdExpirySecs}s (>= ${blocks} SEQ blocks * ${c.seqSecsPerBlock}s + reorg ${c.reorgMarginSecs}s + settle ${c.settleMarginSecs}s); front HTLC min-final-CLTV ${minFinalCltvBlocks} BTC blocks` };
}

/**
 * Verify an ACTUAL hold (its expiry, and optionally the front HTLC's min-final-CLTV) is settleable until
 * strictly after T_seq. Pure. Used by the taker to FAIL CLOSED when its node capped the mint below what was
 * required, and as the LSP belt-and-suspenders (FIX 3) at front time. Fails closed on invalid input.
 * @returns {{ ok:boolean, reason:string, requiredSecs:number, minFinalCltvBlocks?:number }}
 */
export function takerHoldSettleableToTseq({ seqTip, seqRefundHeight, holdExpirySecs, minFinalCltvBlocks, cfg = {} } = {}) {
  const req = requiredTakerHold({ seqTip, seqRefundHeight, cfg });
  if (!req.ok) return { ok: false, reason: req.reason, requiredSecs: req.requiredSecs };
  if (!Number.isFinite(holdExpirySecs) || holdExpirySecs <= 0)
    return { ok: false, requiredSecs: req.requiredSecs, reason: `hold expiry ${JSON.stringify(holdExpirySecs)} is not a positive number — fail closed` };
  if (holdExpirySecs < req.requiredSecs)
    return { ok: false, requiredSecs: req.requiredSecs,
      reason: `hold expiry ${Math.round(holdExpirySecs)}s is SHORTER than the ~${Math.round(req.requiredSecs)}s needed to stay settleable until T_seq (${seqRefundHeight}) + reorg/settle margin — the maker could reveal P after the hold dies. Fail closed (nothing funded).` };
  if (minFinalCltvBlocks !== undefined && (!Number.isFinite(minFinalCltvBlocks) || minFinalCltvBlocks < req.minFinalCltvBlocks))
    return { ok: false, requiredSecs: req.requiredSecs, minFinalCltvBlocks: req.minFinalCltvBlocks,
      reason: `the front HTLC's min-final-CLTV ${JSON.stringify(minFinalCltvBlocks)} blocks is below the ${req.minFinalCltvBlocks} needed to keep the HTLC that carries the LSP's front alive until T_seq — it would lapse before P. Fail closed.` };
  return { ok: true, requiredSecs: req.requiredSecs, minFinalCltvBlocks: req.minFinalCltvBlocks,
    reason: `hold (expiry ${Math.round(holdExpirySecs)}s${minFinalCltvBlocks !== undefined ? `, min-final-CLTV ${minFinalCltvBlocks} blocks` : ''}) stays settleable until after T_seq — safe` };
}

// lnSide='receiver': LSP pays the receiver's LN, claims the payer's on-chain HTLC. The LSP's exposure is
// the LN it fronts; its recoup is the on-chain claim. Order everything so the recoup is secured first.
function stepReceiverLn(leg, obs, c) {
  const oc = obs.onchain;
  // Terminal: recouped.
  if (oc && oc.spent) return { action: 'done', reason: 'on-chain HTLC claimed — LN front recouped' };
  // The receiver revealed P (settled our LN) -> we MUST claim the on-chain HTLC now, before its CLTV.
  if (obs.ln.settled) {
    if (!oc || !oc.funded) return { action: 'fail-closed', reason: 'INVARIANT VIOLATION: LN settled but no on-chain HTLC to recoup — should have been impossible (never front without it)' };
    if (obs.tip >= oc.cltv - c.claimMargin) return { action: 'recoup-claim', reason: 'LN settled; on-chain CLTV imminent — claim IMMEDIATELY with the revealed P' };
    return { action: 'recoup-claim', reason: 'LN settled (P revealed) — claim the on-chain HTLC to recoup' };
  }
  // Not yet fronted: gate hard on the recoup being locked to us with runway.
  if (!oc || !oc.funded) return { action: 'wait', reason: 'awaiting the payer to fund the on-chain HTLC (our recoup) before we front the LN' };
  if (oc.lockedToLsp === false) return { action: 'fail-closed', reason: 'on-chain HTLC is NOT locked to the LSP — cannot recoup; refuse to front' };
  if (oc.amountSat < leg.amountSat) return { action: 'fail-closed', reason: 'on-chain HTLC amount is below the leg amount — refuse to front (would front more than we recoup)' };
  if (oc.cltv - obs.tip < c.frontRunway) return { action: 'fail-closed', reason: 'on-chain HTLC CLTV runway too short to recoup after the reveal — refuse to front (fail closed, no exposure)' };
  if (!obs.ln.held) {
    // The recoup target is the COUNTERPARTY's on-chain HTLC. While it is unconfirmed it can be RBF'd /
    // double-spent away, so fronting irreversible LN against it is unsafe: a malicious maker (who mints P)
    // would front-run the reveal, take the LN, and reclaim its on-chain funds. Wait for it to bury first.
    // This gates ONLY the front; once fronted (ln.held) confs are moot, and a settle recoups at the top.
    // Transient wait (re-observe until confirmed), NOT a fail — the recoup is otherwise secured.
    if ((oc.confs || 0) < c.minRecoupConf) return { action: 'wait', reason: `recoup HTLC has only ${oc.confs || 0} confirmation(s) (need ${c.minRecoupConf}) — wait for it to bury before fronting (an unconfirmed recoup target can be replaced out from under the front)` };
    // W1 (FRONT-TIME) — re-run the LOCKTIME-ORDERING gate against the LIVE tip at the moment of fronting,
    // not only at handshake. `obs.crossLock` carries the reverse-cross cross-leg inputs the handshake gate
    // used (the taker asset-HTLC refund height T_seq + the LIVE seq tip, and optionally the real hold life);
    // the maker BTC-HTLC refund height T_btc is oc.cltv and the LIVE btc tip is obs.tip. A maker that set
    // T_btc to JUST clear the handshake gate can let the BTC tip DRIFT (idle, or across an LSP restart, so
    // the resumed front re-enters here) until T_btc is inside the danger window; an un-gated front would
    // then pay the taker's ~2h hold while the maker refunds its BTC at T_btc and reveals P too late for the
    // LSP to recoup = full-front loss. So refuse to front once the wall-clock ordering no longer holds.
    // Absent crossLock (payer leg, non-reverse shapes, back-compat single-leg) => skip, exactly like
    // swapLocked===undefined. Fail closed: nothing is fronted yet, and a drifted BTC tip only worsens, so
    // refusing is a no-loss terminal (never a spin) — the taker is protected by its own T_seq asset refund.
    if (obs.crossLock) {
      const g = checkBridgeLocktimeOrdering({
        btcTip: obs.tip, btcRefundHeight: oc.cltv,
        seqTip: obs.crossLock.seqTip, seqRefundHeight: obs.crossLock.seqRefundHeight,
      });
      if (!g.ok) {
        // W2(b) — a front-time refusal must NOT strand a taker whose asset was ALREADY relayed and claimed:
        // once P is PUBLIC (obs.preimage) and our recoup HTLC is still unspent + claimable (CLTV not reached —
        // the frontRunway gate above already guaranteed oc.cltv - obs.tip >= frontRunway; re-assert defensively),
        // the LSP fronts and IMMEDIATELY recoups with the known P — ZERO exposure window, so the ordering is
        // moot and refusing would only trap the taker (its asset is gone, it cannot refund). Proceed to front.
        // Only when P is NOT yet public does an un-recoupable-after-refund window exist -> keep fail-closed.
        // (In the W2 FRONT-BEFORE-FUND ordering P is never public at front time — the taker funds its asset
        // AFTER this front — so this exception is defence for the resume/back-compat path, not the happy one.)
        const pPublic = typeof obs.preimage === 'string' && /^[0-9a-f]{64}$/i.test(obs.preimage);
        const recoupClaimable = !!oc && oc.spent !== true && (oc.cltv - obs.tip) > c.claimMargin;
        if (!(pPublic && recoupClaimable))
          return { action: 'fail-closed', reason: `front-time locktime gate REFUSED (live tip drifted since handshake): ${g.reason}` };
      }
      // W2 — FRONT-BEFORE-FUND (the reverse-cross receiver leg, identified by obs.crossLock). The taker exposes
      // its asset leg ONLY AFTER this front (front the hold on H -> taker funds its asset HTLC -> maker claims
      // it, revealing P -> taker settles the hold with P). So the OTHER leg (the native asset leg) is NO LONGER
      // a precondition of the front: gating on swapLocked here would DEADLOCK the new ordering (the asset never
      // locks until AFTER the front) and force the very fund-loss hole this fixes (front driven after the asset
      // is relayed = maker can take the asset before the taker is paid). The recoup is already secured at this
      // point (locked to us, amount + runway + minRecoupConf + the wall-clock locktime ordering above). The one
      // remaining precondition is that the taker is HOLD-READY — it has registered its BTC-LN hold on H and
      // handed its recv_node_id — so the LSP's pay lands in a live hold rather than the void. recvReady===false
      // withholds (no-loss: nothing fronted); undefined/true proceeds (back-compat, mirroring swapLocked).
      if (obs.recvReady === false) return { action: 'wait', reason: 'recoup secured, but awaiting the taker to register its BTC-LN hold on H + hand its recv_node_id (hold-ready) before fronting — FRONT-BEFORE-FUND: the taker exposes its asset ONLY after this front' };
      return { action: 'front-ln', reason: 'recoup secured + taker hold-ready — pay the receiver\'s hold invoice on H BEFORE the taker exposes its asset (FRONT-BEFORE-FUND: a declined/undriven front strands nothing, the taker has funded nothing yet)' };
    }
    // Non-reverse-cross receiver leg (no crossLock — payer-mirror / single-leg / back-compat): the WHOLE-SWAP
    // ATOMICITY gate still applies. Fronting the LN reveals P, so withhold it until every OTHER leg is locked,
    // or a partial (this leg reveals + settles while another never locks) becomes possible. A stall is no-loss:
    // nothing fronted yet. swapLocked===undefined => locked (single-leg / back-compat).
    if (obs.swapLocked === false) return { action: 'wait', reason: 'recoup secured, but WITHHOLDING the LN front until every other leg locks (whole-swap atomicity on the shared H)' };
    return { action: 'front-ln', reason: 'recoup secured (HTLC locked to us, amount + runway ok) — pay the receiver\'s hold invoice on H' };
  }
  // Fronted, awaiting the receiver to settle. A stall is safe: the LN hold returns to us, the HTLC
  // refunds to the payer — no loss, so just wait.
  return { action: 'wait', reason: 'LN fronted and held — awaiting the receiver to settle (reveal P). A stall unwinds no-loss.' };
}

// lnSide='payer': LSP receives the payer's LN (held), funds the receiver's on-chain HTLC. The LSP's
// exposure is the on-chain HTLC it funds; its recoup is settling the held LN. Fund on-chain only after
// the LN is held, and give the HTLC a CLTV inside the hold's life so an unclaimed leg is doubly no-loss.
function stepPayerLn(leg, obs, c) {
  const oc = obs.onchain;
  // Terminal: LN settled (recouped) — nothing more to do here.
  if (obs.ln.settled) return { action: 'done', reason: 'LN hold settled with P — our on-chain fund recouped' };
  // The receiver claimed the on-chain HTLC (revealed P) -> settle the held LN NOW to recoup.
  if (oc && oc.spent && obs.ln.preimage) return { action: 'recoup-settle', reason: 'receiver claimed on-chain (P revealed) — settle the held LN to recoup' };
  if (oc && oc.spent && !obs.ln.preimage) return { action: 'wait', reason: 'on-chain HTLC spent but P not yet read — read the claim tx witness for P, then settle the LN' };
  // The receiver never claimed and the on-chain CLTV matured -> refund our on-chain HTLC; the LN hold
  // returns to the payer on its own. Both no-loss.
  if (oc && oc.funded && !oc.spent && obs.tip >= oc.cltv) return { action: 'refund-onchain', reason: 'on-chain HTLC CLTV reached with no claim — refund it (LN hold returns to the payer, no loss)' };
  // Not yet funded on-chain: gate hard on the payer's LN being HELD (our recoup) first.
  if (!obs.ln.held) return { action: 'wait', reason: 'awaiting the payer\'s LN payment to arrive HELD (our recoup) before we fund the on-chain HTLC' };
  const holdLife = typeof obs.ln.expiryBlocks === 'number' ? obs.ln.expiryBlocks : Infinity;
  if (!oc || !oc.funded) {
    // The on-chain HTLC CLTV we will set must mature INSIDE the LN hold's remaining life (holdBuffer).
    if (holdLife !== Infinity && holdLife <= c.holdBuffer) return { action: 'fail-closed', reason: 'LN hold too close to expiry to safely fund an on-chain HTLC inside it — fail closed (LN hold returns to the payer)' };
    // WHOLE-SWAP ATOMICITY: funding the receiver's on-chain HTLC is the action that lets them claim and
    // REVEAL P. Withhold it until every OTHER leg is locked, or a partial becomes possible. Safe to
    // stall: the payer's LN is merely HELD and returns to them untouched. Default (undefined) => locked.
    if (obs.swapLocked === false) return { action: 'wait', reason: 'payer LN held, but WITHHOLDING the on-chain fund until every other leg locks (whole-swap atomicity on the shared H)' };
    return { action: 'fund-onchain', reason: 'payer\'s LN is held — fund the receiver\'s on-chain HTLC (CLTV set inside the hold\'s life, locked to the receiver, refundable to us)' };
  }
  // Funded, awaiting the receiver's on-chain claim. Safe to wait: no claim ends in on-chain refund + LN
  // hold return (handled above).
  return { action: 'wait', reason: 'on-chain HTLC funded and locked to the receiver — awaiting their claim (reveals P). No claim unwinds no-loss.' };
}
