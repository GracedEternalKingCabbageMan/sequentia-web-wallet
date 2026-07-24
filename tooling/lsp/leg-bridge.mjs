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

// ============================================================================
// PAYER-BRIDGE REFUND/HOLD WINDOW SIZING — the two named constants that COMPOSE the hold buffer, kept
// module-local so `holdBuffer` is DERIVED from them and the invariant
//
//     holdBuffer === refundFinalityConfs + refundConfirmBudget
//
// can never silently drift into a too-tight window. The window is the SLACK the incoming taker hold keeps
// ABOVE T_btc (B3: T_btc <= holdCLTV - holdBuffer). If no P surfaces by T_btc the LSP refunds its own BTC HTLC
// on-chain, then KEEPS the taker hold ALIVE (stepPayerLn (5)) until that refund BURIES — because a conflicting
// maker CLAIM can still swap in over a shallow refund (RBF/reorg) and the LSP recoups it by settling the
// STILL-LIVE hold with the revealed P. So the hold must OUTLIVE the ENTIRE refund lifecycle: broadcast at
// T_btc -> CONFIRM (refundConfirmBudget blocks) -> BURY refundFinalityConfs deep. The slack that spans both
// IS holdBuffer.
// ----------------------------------------------------------------------------
// refundFinalityConfs — the BTC FINALITY DEPTH (confirmations) that makes the LSP's OWN refund of its funded
// BTC HTLC a TERMINAL fate. A CLAIM reveals P immutably and is safe to act on at ANY depth, but a REFUND is only
// terminal once BURIED to a CONVENTIONAL Bitcoin finality: while the LSP's refund spend is shallower than this, a
// conflicting maker CLAIM can still swap in over it (RBF a 0-conf refund; a reorg < this depth re-mines the claim
// instead), which would take the LSP's BTC HTLC with no recoup if the hold had already been released. So a
// shallow refund is NON-terminal (stepPayerLn (5) keeps the taker hold ALIVE and watches); only
// spendConfs >= refundFinalityConfs releases it. 6 — a conventional BTC finality (the prior 2 was too shallow: a
// 2-deep refund can still be reorged out in favour of a maker claim). Conservatively > minRecoupConf. (Amount-
// scaling to a DEEPER finality for large-value legs is deliberately DEFERRED: it would need a proportionally
// larger holdBuffer AND a larger taker-minted hold, which the current handshake does not size from the BTC-leg
// amount — so a flat, conventional 6 is what is safe with the present hold sizing; revisit alongside a hold-
// sizing change.)
const REFUND_FINALITY_CONFS = 6;
// refundConfirmBudget — a GENEROUS confirmation budget (BTC blocks) for the LSP's T_btc refund to get MINED under
// RBF, BEFORE the refundFinalityConfs-deep burial-wait begins. Round-10's RBF bumping (sizeRefundFee sized off
// estimatesmartfee, then 'refund-bump' escalation, targeting ~3 blocks) makes an honestly-fee'd refund confirm
// fast, so 12 is a comfortable ~4x congestion cushion over that target — NOT a tight fit. Sizing it EXPLICITLY (vs
// the old "+ a few blocks of latency" hand-wave that left holdBuffer at 8 == refundFinalityConfs+2, no real
// confirm room) is the whole point of this round: an adversarial maker pins T_btc to exactly holdCLTV - holdBuffer
// (B3's ceiling), so holdBuffer IS the worst-case wall-clock window a stuck-then-buried refund gets. 12 blocks of
// confirm room + 6 of burial = a real, reasoned margin, not a coincidental one.
const REFUND_CONFIRM_BUDGET = 12;

// RESIDUAL RISK (known, mitigated — NOT a logic bug). A FIXED hold window (holdBuffer blocks) versus real
// on-chain finality carries an IRREDUCIBLE residual: under SUSTAINED, multi-hour congestion where even a
// top-of-mempool, RBF-bumped refund cannot CONFIRM + BURY inside the window, the LSP's refund stalls past the
// taker hold, the hold fails back to the taker, and a maker claim can then take the LSP's BTC HTLC (a front
// loss BORNE BY THE LSP — never by the taker, whose BTC was only ever HELD, and never by the maker). We MITIGATE
// it, we do not eliminate it: (a) a GENEROUS, reasoned window — refundConfirmBudget=12 is ~4x the ~3-block RBF
// target, so only congestion that starves a top-fee tx for 12+ blocks even bites; (b) RBF escalation from the
// first post-refund tick (refundBumpWithin, sizeRefundFee, the 'refund-bump' action); (c) the LSP's concurrent-
// exposure caps bound the worst case. This is the SAME known limitation every HTLC / Lightning system lives with
// (a fixed CLTV delta vs. on-chain confirmation latency — an LN forwarding node can likewise lose an HTLC if it
// cannot confirm a timeout-claim before the incoming CLTV under sustained congestion). Chasing it to ZERO would
// need an UNBOUNDED window, which is itself a liveness / capital-lock failure. So: size it generously (done here),
// document it (here + doc/sequentia/rail-crossing-p2p-lsp-design.md), and STOP — do not treat the residual as a
// bug to be closed.

// Default block margins (caller may override per chain/leg). Deliberately conservative.
export const BRIDGE_DEFAULTS = Object.freeze({
  // Min CLTV runway (blocks) the on-chain HTLC must have BEYOND the current tip before the LSP fronts,
  // so there is room for the counterparty to act AND the LSP to recoup before expiry.
  frontRunway: 6,
  // The LSP must recoup (claim/refund) at least this many blocks BEFORE the on-chain CLTV, never racing it.
  claimMargin: 2,
  // lnSide='payer': the on-chain HTLC CLTV (T_btc) must be at least this many blocks INSIDE the LN hold's
  // remaining lifetime (B3: T_btc <= holdCLTV - holdBuffer). It bounds the SLACK the incoming hold keeps ABOVE
  // T_btc — an adversarial maker can push T_btc as high as holdCLTV - holdBuffer, so holdBuffer IS the worst-case
  // window a no-reveal refund gets to confirm THEN bury before the hold is at risk. DERIVED, NOT hand-set:
  //   holdBuffer = refundFinalityConfs (6) + refundConfirmBudget (12) = 18
  // — 12 BTC blocks for the refund to CONFIRM under RBF + 6 to BURY to finality. The derivation (see the two
  // module consts above) makes the coupling structural: the confirm budget and the finality depth can never drift
  // out of the window, because holdBuffer is literally their sum (asserted below). The honest fleet rests T_btc
  // well BELOW this ceiling (seqdex BtcLocktimeDelta 180 vs a ~210-block hold => ~30 blocks below, clearing B3
  // with headroom; see checkPayerFundGate + the seqdex maker's BtcLocktimeDelta comment).
  holdBuffer: REFUND_FINALITY_CONFS + REFUND_CONFIRM_BUDGET,
  // lnSide='payer' FORWARD bridge (B1 — checkPayerFundGate): the maker-claim runway. T_btc must be at least
  // this many BTC blocks BEYOND the BTC-height that covers T_seq's wall-clock, so the maker still has room to
  // claim the LSP's BTC HTLC with P AFTER the taker reveals P at ~T_seq — i.e. T_btc's wall-clock is strictly
  // later than T_seq's. Without it a wall-clock inversion (T_btc <= T_seq) lets the LSP refund its BTC before
  // the taker reveals P; this margin forbids that. Conservatively >= claimMargin.
  makerClaimRunwayBlocks: 6,
  // lnSide='receiver': the COUNTERPARTY's on-chain HTLC (the LSP's recoup target) must have at least this
  // many confirmations before the LSP fronts irreversible LN against it. A 0-conf recoup target can be
  // RBF'd / double-spent out from under the front by a malicious counterparty (who mints P), letting them
  // take the fronted LN AND reclaim their on-chain funds. 1 confirmation removes the fee-bump/RBF path.
  minRecoupConf: 1,
  // lnSide='payer' FORWARD bridge: the BTC finality depth that makes the LSP's OWN refund TERMINAL. Sized +
  // documented at REFUND_FINALITY_CONFS above; holdBuffer is DERIVED as this + refundConfirmBudget.
  refundFinalityConfs: REFUND_FINALITY_CONFS,
  // lnSide='payer' FORWARD bridge: the confirm budget (BTC blocks) for the refund to get MINED under RBF before
  // the burial-wait. Sized + documented at REFUND_CONFIRM_BUDGET above; holdBuffer is DERIVED as refundFinality-
  // Confs + this. Surfaced on the object so a caller can override the pair together (the invariant is asserted).
  refundConfirmBudget: REFUND_CONFIRM_BUDGET,
  // lnSide='payer' FORWARD bridge (Fix 2 — REFUND FEE ADEQUACY / RBF re-bump): once the LSP has broadcast its own
  // refund at T_btc it must CONFIRM + BURY inside the taker hold's remaining life, so an UNDER-fee'd refund that
  // sits 0-conf must be FEE-BUMPED (RBF) until it confirms — else the refund stalls past the hold, the hold fails
  // back to the taker, and a maker claim then takes the LSP's BTC HTLC (full front loss). stepPayerLn emits
  // 'refund-bump' while the refund is 0-conf (spendConfs === 0, still mempool-replaceable), no P is public (a
  // public P means the maker is entitled — let its claim win, never race it), and the hold's remaining life is
  // within this many BTC blocks (the danger window). MUST stay >= holdBuffer (asserted below) so the TIGHTEST
  // possible gap — an adversarial maker resting T_btc at the B3 ceiling, gap == holdBuffer — still gets the FULL
  // confirm+bury budget of bumping from the first post-refund tick. Set to 48 so it ALSO comfortably covers the
  // honest fleet's whole T_btc-below-hold gap range (from the B3 ceiling ~holdBuffer up to the reorg+settle margin
  // in BTC blocks, ~60 at the B1 floor; the deployed maker's ~30) — bumping proactively for any honest resting.
  // Harmless if larger: the io re-broadcasts at most once per new BTC block (persisted lastBumpTip) and is a no-op
  // when the current fee already suffices; a mined-but-shallow refund (spendConfs >= 1) is NOT bumpable (RBF
  // cannot replace a confirmed tx) so it falls through to 'wait' (watch for burial / a conflicting claim).
  refundBumpWithin: 48,
});

// INVARIANTS (belt-and-suspenders; holdBuffer is already DERIVED above, but a future edit that hard-codes it — or
// a caller override that violates the coupling — would silently re-open the too-tight window this round closes):
//   (1) holdBuffer === refundFinalityConfs + refundConfirmBudget — the slack spans CONFIRM then BURY, exactly.
//   (2) refundBumpWithin >= holdBuffer — the tightest gap (an adversarial T_btc at the B3 ceiling) still gets the
//       full confirm+bury budget of RBF bumping; if it were smaller a stuck refund at that gap would go un-bumped.
if (BRIDGE_DEFAULTS.holdBuffer !== BRIDGE_DEFAULTS.refundFinalityConfs + BRIDGE_DEFAULTS.refundConfirmBudget)
  throw new Error(`BRIDGE_DEFAULTS invariant: holdBuffer (${BRIDGE_DEFAULTS.holdBuffer}) must equal refundFinalityConfs (${BRIDGE_DEFAULTS.refundFinalityConfs}) + refundConfirmBudget (${BRIDGE_DEFAULTS.refundConfirmBudget}) — the refund/hold window must span CONFIRM then BURY`);
if (BRIDGE_DEFAULTS.refundBumpWithin < BRIDGE_DEFAULTS.holdBuffer)
  throw new Error(`BRIDGE_DEFAULTS invariant: refundBumpWithin (${BRIDGE_DEFAULTS.refundBumpWithin}) must be >= holdBuffer (${BRIDGE_DEFAULTS.holdBuffer}) — the tightest gap must still get the full confirm+bury budget of RBF bumping`);

/**
 * Decide the next safe action for ONE bridged leg.
 * @param {{lnSide:LnSide, amountSat:number, lspClaimPub?:string, receiverClaimPub?:string}} leg
 * @param {{
 *   tip:number,                       // current block height of the ON-CHAIN end's chain
 *   onchain:null|{ funded:boolean, amountSat:number, cltv:number, lockedToLsp?:boolean, lockedToReceiver?:boolean, spent?:boolean, refundable?:boolean,
 *                  spendStatus?:'unspent'|'spent_claim'|'spent_refund'|'uncertain', spendConfs?:number },
 *                                     // FORWARD-cross PAYER leg only (CHAIN-TRUTH recoup/refund oracle): the
 *                                     // AUTHORITATIVE on-chain spend classification of the LSP's OWN funded BTC
 *                                     // HTLC, from the seqdex `xsubas-htlc-spend-status` classifier (surfaced by
 *                                     // observe). stepPayerLn keys the recoup-vs-refund decision ENTIRELY on this
 *                                     // fact — NEVER on the racy persisted s.refunded intent flag. 'spent_claim'
 *                                     // (the maker got paid, P revealed) drives recoup-settle at ANY depth (a claim
 *                                     // is immutable once revealed). 'spent_refund' (the LSP reclaimed its BTC =>
 *                                     // the maker is unpaid) RELEASES the taker hold and forbids a recoup double-dip
 *                                     // — but ONLY once it is BURIED (spendConfs >= refundFinalityConfs). 'unspent' defers to
 *                                     // the P-public / T_btc decision; 'uncertain' (or absent over a funded leg)
 *                                     // FAILS CLOSED to 'wait' (neither recoup nor release until the read is
 *                                     // definitive). spendConfs = the spender's confirmation DEPTH (0 when
 *                                     // unspent/mempool/uncertain); it makes the REFUND-terminal decision
 *                                     // reorg-aware: a shallow refund is NON-terminal (a conflicting claim can still
 *                                     // swap in — RBF/reorg), so the hold stays alive until it buries. A crash at
 *                                     // any point recovers because the decision re-derives from the chain each tick.
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
 *   crossFund?:boolean,               // FORWARD-cross PAYER leg only (B — FUND-BEFORE-LOCK): this is the
 *                                     // taker-holds-P payer bridge where the maker's asset leg locks ONLY
 *                                     // AFTER the LSP funds its BTC HTLC + relays XcBtcLegFunded. It is the
 *                                     // MIRROR of the receiver leg's crossLock/recvReady: it REPLACES the
 *                                     // swapLocked gate for the FUND (gating on swapLocked would deadlock —
 *                                     // the asset never locks until after the fund) since funding reveals
 *                                     // nothing (P is the taker's, exposed only when it claims the asset).
 *                                     // The fund-time CLTV ordering is enforced by checkPayerFundGate in the
 *                                     // io before funding. Absent => the generic swapLocked gate applies.
 *   relayPending?:boolean,            // FORWARD-cross PAYER leg only (B — RESUMABLE RELAY): the BTC HTLC is
 *                                     // FUNDED but the maker's asset-leg lock/relay (XcBtcLegFunded ->
 *                                     // XcSeqLegLocked -> on-chain verify -> hand-off to the taker) is NOT yet
 *                                     // complete (io: crossFund && s.htlc && !s.forwardRelayDone). The
 *                                     // fund-onchain io action ALSO drives that (idempotent) relay, so while it
 *                                     // is pending nextBridgeStep RE-RETURNS fund-onchain — the driver re-drives
 *                                     // it every tick until it completes (a one-shot maker-reply timeout, or an
 *                                     // LSP restart, must not strand a funded leg). It only fires when no P is
 *                                     // public, the HTLC is unspent, and T_btc is not yet reached (those take
 *                                     // priority: recoup-settle / refund-onchain). Absent => no relay to resume.
 *   onchainKnownFunded?:boolean,      // FORWARD-cross PAYER leg only (transient-outage / reorg-eviction guard):
 *                                     // the driver's PERSISTED state records this leg's BTC HTLC as funded
 *                                     // (s.htlc.txid), so a tick whose on-chain read reports NOT-funded — a
 *                                     // null/unreadable read (momentary bitcoind outage) OR onchain.funded===false
 *                                     // (a reorg that evicted the funding tx) — is KNOWN to be transient over an
 *                                     // already-funded leg: stepPayerLn WAITS instead of treating it as "not
 *                                     // funded" (no fail-close / no re-fund; a re-fund would double-broadcast).
 *                                     // A funded payer leg is never dropped on a transient read or a reorg.
 *   refunded?:boolean,                // FORWARD-cross PAYER leg only — DEMOTED to a BROADCAST-DEDUP HINT ONLY.
 *                                     // stepPayerLn NO LONGER reads this flag: the recoup/refund/terminal decision
 *                                     // keys ENTIRELY on obs.onchain.spendStatus (chain truth). It is racy across
 *                                     // the persist/broadcast window (crash-before-broadcast => stale true;
 *                                     // RPC-error-after-broadcast => stale false), which is exactly the round-6 hole
 *                                     // this rewrite closes. It survives on the leg state only so runPayerRefundOnce
 *                                     // can dedup a re-broadcast; the authoritative no-double-dip guard is the
 *                                     // on-chain 'spent_refund' classification, not this intent.
 * }} obs
 * @param {object} [cfg] overrides for BRIDGE_DEFAULTS
 * @returns {{action:'wait'|'front-ln'|'fund-onchain'|'recoup-claim'|'recoup-settle'|'refund-onchain'|'refund-bump'|'fail-closed'|'done', reason:string}}
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

// ============================================================================
// B — PAYER-SIDE FUND-TIME GATE (the LSP payer leg-bridge, buy: taker pays BTC over LN, receives the asset
// on-chain). The MIRROR of checkBridgeLocktimeOrdering/verifyFrontRouteExpiry, for the direction where the
// LSP RECEIVES the taker's BTC-LN (a HELD hold on the taker's H, at the LSP's own node) and FUNDS an on-chain
// BTC HTLC to the maker. Both HTLCs live on Bitcoin (the incoming hold's HTLC and the LSP's on-chain HTLC),
// so this is pure BTC-block arithmetic — no second chain, no divisor drift.
//
// The taker mints H + holds P and claims the maker's asset leg with P (revealing it); the maker reads P and
// claims the LSP's BTC HTLC; the LSP reads P (from the asset claim, primary; its BTC HTLC spend, backstop)
// and SETTLES the held hold to recoup exactly its fund. So BEFORE the LSP funds on-chain it must verify, from
// the ACTUAL committed incoming-HTLC CLTV (holdinvoicelookup/listhtlcs — never a merely-requested value):
//   (B0) HELD AMOUNT covers the ordered price: the SUM of the taker's incoming 'in' HTLCs on H (from
//        listhtlcs, summed by the io) is at least the ordered BTC price (orderedAmountSat). The holdinvoice
//        plugin marks a hold HELD on the FIRST incoming HTLC regardless of amount, so a 1-sat pay would else
//        trip funding — the LSP would front the full BTC price for a token payment. Mirror stepReceiverLn's
//        oc.amountSat < leg.amountSat fail-close: fund ONLY once the FULL price is held. (Only enforced when
//        the caller supplies the amounts; fundOnchain always does. The pure CLTV-only tests omit them.)
//   (B1) T_btc's WALL-CLOCK is strictly LATER than T_seq's + a maker-claim runway: convert the T_seq window to
//        BTC blocks with the SAME conservative slow-SEQ/fast-BTC divisors requiredTakerHold uses, and require
//        T_btc >= that BTC-height + makerClaimRunwayBlocks. Otherwise a wall-clock inversion (a maker/self-trader
//        sets T_btc <= T_seq in wall-clock) lets the LSP's BTC HTLC hit its refund height BEFORE the taker
//        reveals P at ~T_seq — the LSP could refund its BTC, and a late P then double-recoups (or strands the
//        maker) — an inversion B2/B3 alone do NOT forbid (they only bound T_btc from ABOVE, via the hold). This
//        is the payer analog of checkBridgeLocktimeOrdering, enforced by the LSP (verify-not-trust the maker).
//   (B2) the incoming hold covers T_seq: its committed CLTV is at least requiredTakerHold(T_seq) blocks above
//        the tip, so the hold stays settleable until strictly after the maker's latest asset claim + margin —
//        else the maker (or a self-trader) waits the hold out, THEN reveals P, and the LSP's dead hold recoups
//        nothing while its on-chain BTC HTLC is claimed. (requiredTakerHold sizes hold_expiry AND this CLTV.)
//   (B3) T_btc matures INSIDE the hold's remaining life (holdBuffer): the LSP's on-chain HTLC (CLTV = T_btc)
//        refunds to the LSP strictly before the incoming hold is at risk, so a NO-reveal ends double-no-loss
//        (BTC refunds to the LSP; the hold expires to the taker) — the LSP is never forced to settle a hold
//        with a P it does not have.
// B1 + B3 together COUPLE T_btc into a non-empty window ABOVE the T_seq-cover height (maker runway) and BELOW
// the hold's refund-safe ceiling — the coupled-locktime relation T_seq < T_btc < hold, verified by the LSP.
// FAIL CLOSED on any missing/invalid/timestamp/degenerate input (never fund on an unverifiable ordering). In
// the payer flow the taker's BTC is merely HELD (nothing captured), so a fund-time refusal is no-loss.
/**
 * @param {{
 *   btcTip:number, incomingHtlcExpiry:number,   // the LSP node's live BTC tip + the ACTUAL committed CLTV of the taker's incoming hold HTLC on H
 *   btcRefundHeight:number,                       // T_btc — the CLTV the LSP will set on the on-chain BTC HTLC it funds (its refund height)
 *   seqTip:number, seqRefundHeight:number,        // the maker's asset HTLC: live SEQ tip + its refund height T_seq (sizes requiredTakerHold)
 *   heldAmountSat?:number, orderedAmountSat?:number,  // (B0) SUM of the taker's incoming HTLCs on H (io-summed) vs the ordered BTC price; enforced only when supplied
 *   cfg?:object                                   // overrides for BRIDGE_DEFAULTS.holdBuffer/makerClaimRunwayBlocks + HOLD_LIFE_DEFAULTS (threaded to requiredTakerHold)
 * }} args
 * @returns {{ ok:boolean, reason:string, requiredTakerBlocks:number, incomingHoldBlocks:number, tBtcInsideHold:boolean, tSeqCoverHeight:number }}
 */
export function checkPayerFundGate({ btcTip, incomingHtlcExpiry, btcRefundHeight, seqTip, seqRefundHeight, heldAmountSat, orderedAmountSat, cfg = {} } = {}) {
  const c = { ...BRIDGE_DEFAULTS, ...cfg };          // holdBuffer + makerClaimRunwayBlocks live here
  const hlc = { ...HOLD_LIFE_DEFAULTS, ...cfg };      // the slow-SEQ / fast-BTC divisors (shared with requiredTakerHold)
  const fail = (reason) => ({ ok: false, reason, requiredTakerBlocks: NaN, incomingHoldBlocks: NaN, tBtcInsideHold: false, tSeqCoverHeight: NaN });
  for (const [k, v] of Object.entries({ btcTip, incomingHtlcExpiry, btcRefundHeight, seqTip, seqRefundHeight })) {
    if (!Number.isFinite(v)) return fail(`payer fund gate: ${k} is not a finite number — cannot verify the hold covers T_seq/T_btc, fail closed (nothing funded)`);
  }
  // A CLTV height >= LOCKTIME_THRESHOLD is a UNIX TIMESTAMP, not a block height; the arithmetic below would be
  // nonsense (and a timestamp would make "blocks" a huge bogus number). Assert height-ness on every counterparty
  // -influenced height (the incoming hold's CLTV, T_btc, T_seq). Tips come from getinfo/getblockcount (heights).
  for (const [k, v] of Object.entries({ incomingHtlcExpiry, btcRefundHeight, seqRefundHeight })) {
    if (v >= LOCKTIME_THRESHOLD) return fail(`payer fund gate: ${k} ${v} is a UNIX TIMESTAMP (>= ${LOCKTIME_THRESHOLD}), not a block height — fail closed`);
  }
  // (B0) HELD-AMOUNT gate — enforced only when the caller supplies the amounts (fundOnchain always does; the
  // pure CLTV-only tests omit them). holdinvoice marks HELD on the first incoming HTLC regardless of amount, so
  // a 1-sat pay must NOT trip funding: require the SUMMED incoming HTLCs on H to cover the ordered BTC price.
  if (orderedAmountSat !== undefined || heldAmountSat !== undefined) {
    if (!Number.isFinite(orderedAmountSat) || orderedAmountSat <= 0)
      return fail(`payer fund gate (B0): the ordered BTC price is not a positive number (got ${JSON.stringify(orderedAmountSat)}) — cannot bound the held-amount check, fail closed (nothing funded)`);
    if (!Number.isFinite(heldAmountSat) || heldAmountSat < orderedAmountSat)
      return { ok: false, requiredTakerBlocks: NaN, incomingHoldBlocks: NaN, tBtcInsideHold: false, tSeqCoverHeight: NaN,
        reason: `payer fund gate (B0): the taker's HELD BTC-LN totals ${Number.isFinite(heldAmountSat) ? heldAmountSat : JSON.stringify(heldAmountSat)} sat across its incoming HTLCs on H, below the ordered ${orderedAmountSat} sat — holdinvoice marks HELD on the first HTLC regardless of amount, so fund the maker's BTC leg ONLY once the FULL price is held. Fail closed (stay unfunded).` };
  }
  // The on-chain BTC HTLC we will fund must not be refundable the instant it is funded.
  if (btcRefundHeight <= btcTip) return fail(`payer fund gate: T_btc ${btcRefundHeight} <= tip ${btcTip} — the BTC HTLC would be refundable immediately, refuse to fund`);
  // requiredTakerHold enforces the T_seq min/max bound + LN max-CLTV feasibility, so a collapsed/too-far/
  // infeasible T_seq fails closed right here (before B1/B2/B3). It also yields the T_seq -> BTC-block conversion.
  const req = requiredTakerHold({ seqTip, seqRefundHeight, cfg });
  if (!req.ok) return fail(`payer fund gate: ${req.reason}`);
  const requiredTakerBlocks = req.minFinalCltvBlocks;
  const incomingHoldBlocks = incomingHtlcExpiry - btcTip;
  // (B1) T_btc WALL-CLOCK ORDERING (the payer analog of checkBridgeLocktimeOrdering). Convert the T_seq window
  // to BTC blocks with the SAME slow-SEQ / fast-BTC divisors requiredTakerHold uses — the earliest BTC-block
  // count by which T_seq's wall-clock can arrive — and require T_btc to sit at least makerClaimRunwayBlocks
  // beyond it. This is a RAW conversion (no reorg/settle margins, so it stays below requiredTakerBlocks and
  // leaves a non-empty window with B3), giving the maker room to claim the LSP's BTC with P AFTER the taker
  // reveals P at ~T_seq. A T_btc below this (a wall-clock inversion) is refused BEFORE anything is funded.
  const tSeqBtcBlocks = Math.ceil(Math.max(0, seqRefundHeight - seqTip) * hlc.seqSecsPerBlock / hlc.fastBtcSecsPerBlock);
  const tSeqCoverHeight = btcTip + tSeqBtcBlocks;
  const tBtcOrderingFloor = tSeqCoverHeight + c.makerClaimRunwayBlocks;
  if (btcRefundHeight < tBtcOrderingFloor)
    return { ok: false, requiredTakerBlocks, incomingHoldBlocks, tBtcInsideHold: false, tSeqCoverHeight,
      reason: `payer fund gate (B1): T_btc ${btcRefundHeight} is below the wall-clock ordering floor ${tBtcOrderingFloor} `
            + `(T_seq ${seqRefundHeight} covers ~${tSeqBtcBlocks} BTC blocks from tip ${btcTip} under slow-SEQ/fast-BTC, + maker-claim runway ${c.makerClaimRunwayBlocks}) — a T_btc this small is a wall-clock inversion (T_btc <= T_seq) that lets the LSP refund its BTC before the taker reveals P at ~T_seq. Refuse to fund (fail closed, nothing at stake).` };
  // (B2) the incoming hold must cover T_seq.
  if (incomingHoldBlocks < requiredTakerBlocks)
    return { ok: false, requiredTakerBlocks, incomingHoldBlocks, tBtcInsideHold: false, tSeqCoverHeight,
      reason: `payer fund gate (B2): the taker's incoming BTC-LN hold gives only ${incomingHoldBlocks} BTC blocks (committed CLTV ${incomingHtlcExpiry} - tip ${btcTip}), below the ${requiredTakerBlocks} needed to stay settleable until after T_seq (${seqRefundHeight}) under conservative-fast BTC — the maker could reveal P after the hold dies. Fail closed (nothing funded).` };
  // (B3) T_btc must mature inside the hold's remaining life (holdBuffer blocks of margin).
  const tBtcInsideHold = btcRefundHeight <= incomingHtlcExpiry - c.holdBuffer;
  if (!tBtcInsideHold)
    return { ok: false, requiredTakerBlocks, incomingHoldBlocks, tBtcInsideHold: false, tSeqCoverHeight,
      reason: `payer fund gate (B3): T_btc ${btcRefundHeight} is NOT inside the incoming hold's life (needs <= hold CLTV ${incomingHtlcExpiry} - holdBuffer ${c.holdBuffer} = ${incomingHtlcExpiry - c.holdBuffer}) — a no-reveal could leave the LSP unable to refund on-chain before the hold is at risk. Fail closed (nothing funded).` };
  return { ok: true, requiredTakerBlocks, incomingHoldBlocks, tBtcInsideHold: true, tSeqCoverHeight,
    reason: `payer fund gate: held amount covers the price, T_seq < T_btc < hold — incoming hold covers T_seq (${incomingHoldBlocks} >= ${requiredTakerBlocks} BTC blocks), T_btc ${btcRefundHeight} is beyond the T_seq wall-clock floor ${tBtcOrderingFloor} (maker runway) AND matures inside the hold (<= ${incomingHtlcExpiry - c.holdBuffer}) — safe to fund the on-chain BTC HTLC` };
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

  // ============================================================================
  // CHAIN-TRUTH recoup/refund decision (STRUCTURAL FIX, round 7). Once OUR BTC HTLC is FUNDED, the
  // recoup-vs-refund-vs-release choice keys ENTIRELY on the AUTHORITATIVE on-chain spend classification
  // (obs.onchain.spendStatus, from the seqdex xsubas-htlc-spend-status classifier) — NEVER on the racy
  // persisted s.refunded intent flag (whose stale-true after a crash-before-broadcast, or stale-false
  // after an RPC-error-after-broadcast, was the round-6 fund-loss hole).
  //
  // INVARIANT: the LSP's BTC HTLC has EXACTLY ONE spend.
  //   - REFUND/CLTV branch (the LSP reclaimed its BTC => the maker is UNPAID) => RELEASE the taker hold
  //     (let it expire / cancel), NEVER recoup-settle. This is the authoritative no-double-dip guard.
  //   - CLAIM branch, spender reveals P (the maker got PAID) => recoup-settle the taker hold with P.
  //   - Before any spend confirms: P public (the taker claimed the maker asset leg) => recoup + never
  //     refund; T_btc passed with no P => refund. Uncertain => fail closed (wait, re-observe).
  // A crash at ANY point recovers because this re-derives from the chain each tick.
  //
  // ORDERING (round-10 Fix 1 — RECOUP NEVER AFTER REFUND): the spend-status classification is decided
  // STRICTLY before any P-public inference. Once the classifier reports EITHER refund fate — BURIED (1) or
  // SHALLOW (4) — the LSP has already reclaimed (or is reclaiming) its BTC on the refund branch, so it must
  // NEVER also recoup-settle the hold, EVEN IF P later goes public. The prior ordering ran the pPublic recoup
  // branch AHEAD of the shallow-refund branch, so a shallow-but-CONFIRMED refund (spendConfs 1..finality-1)
  // plus a late public P double-dipped: it kept the (near-certain-to-bury) refund AND settled the hold, robbing
  // the maker. Now pPublic only drives a recoup on a DEFINITIVELY-UNSPENT HTLC (5); any spent_refund waits for
  // chain truth (burial => done, or a conflicting spent_claim swapping in => recoup at (2)).
  // ============================================================================
  if (oc && oc.funded) {
    const spend = oc.spendStatus;      // 'unspent'|'spent_claim'|'spent_refund'|'uncertain'|undefined
    // BURIAL DEPTH of the LSP's OWN refund spend (from the classifier). A CLAIM reveals P immutably and is
    // safe to act on at ANY depth; a REFUND is a TERMINAL fate ONLY once BURIED to a conventional BTC finality
    // (a 0-conf/shallow refund can be replaced by a conflicting maker CLAIM — RBF the unconfirmed refund, or a
    // reorg < this depth re-mines the claim). Absent/non-finite => 0 (SHALLOW): the fail-safe direction (keep
    // watching, never prematurely release).
    const spendConfs = Number.isFinite(oc.spendConfs) ? oc.spendConfs : 0;
    const buriedRefund = spend === 'spent_refund' && spendConfs >= c.refundFinalityConfs;
    const pPublic = !!obs.ln.preimage; // P public via the maker asset-leg claim (sa.onchain, primary) or a BTC claim witness (backstop)
    // Remaining life (BTC blocks) of the taker's held incoming HTLC — the deadline the refund must confirm
    // inside (Fix 2). Infinity when unknown (holdinvoicelookup/listhtlcs was momentarily unreadable) => the
    // fee-bump danger-window gate below fails SAFE to 'wait' (never bump on an unknown deadline).
    const holdLife = typeof obs.ln.expiryBlocks === 'number' ? obs.ln.expiryBlocks : Infinity;

    // (1) SPENT_VIA_REFUND and BURIED (spendConfs >= refundFinalityConfs) — chain truth: the LSP reclaimed its
    // BTC on the REFUND/CLTV branch AND the refund is now beyond a conventional BTC finality, so no conflicting
    // claim can swap in. RELEASE the taker hold (let it expire / cancel); NEVER recoup-settle — even if P later
    // leaks (the maker's own T_seq negligence). AUTHORITATIVE no-double-dip guard; does NOT consult s.refunded.
    // Terminal (double no-loss: BTC reclaimed to the LSP, the hold expires to the taker).
    if (buriedRefund)
      return { action: 'done', reason: `BTC HTLC spent on the REFUND/CLTV branch and BURIED (${spendConfs} >= finality depth ${c.refundFinalityConfs} confs; on-chain truth: the LSP reclaimed its BTC, the maker is UNPAID) — RELEASE the taker hold, NEVER recoup-settle; double no-loss. A P that leaks after a buried refund is NOT ours to capture.` };

    // (2) SPENT_VIA_CLAIM(P) at ANY depth (incl 0-conf) — chain truth: the maker spent the CLAIM/IF branch
    // REVEALING P, so the maker got PAID. A claim is immutable once revealed (P is public), so it is safe to
    // recoup immediately at any depth. Recoup the held LN with P (idempotent). NOT gated by s.refunded — (1)
    // already excludes a BURIED refund, so no stale flag can block this recoup (the round-6 stale-true hole).
    // This is ALSO the "watch for a conflicting claim" resolution of a prior shallow refund: if the maker's
    // claim swaps in over our unconfirmed refund (spend flips spent_refund -> spent_claim), we recoup HERE.
    if (spend === 'spent_claim')
      return { action: 'recoup-settle', reason: 'BTC HTLC spent on the CLAIM branch (on-chain truth: the maker got paid, P revealed in the spend witness) — settle the held LN with P to recoup exactly our fund (a claim reveals P immutably, safe to act at ANY depth, incl 0-conf)' };

    // (3) UNCERTAIN (or an absent spendStatus over a funded leg — the classifier was momentarily unreadable):
    // we CANNOT tell CLAIM from REFUND => FAIL CLOSED. Never recoup (might already be a buried refund =>
    // double-dip) and never release (might already be a claim => rob the maker). WAIT and re-observe; the
    // classifier is definitive on the next clean read. A stall is no-loss. This holds EVEN when P is public —
    // an uncertain spend could be an already-buried refund, so a public P alone must not force a recoup here.
    if (spend === 'uncertain' || spend === undefined)
      return { action: 'wait', reason: `BTC HTLC spend status is ${spend === undefined ? 'UNAVAILABLE (classifier not yet read)' : 'UNCERTAIN'} — fail closed: neither recoup (a maybe-refund would double-dip) nor release (a maybe-claim would rob the maker) until the chain read is definitive (re-observe)` };

    // (4) SPENT_VIA_REFUND but SHALLOW (spendConfs < refundFinalityConfs) — NOT terminal, and (Fix 1) NEVER a
    // recoup: the LSP already reclaimed (or is reclaiming) its BTC on the refund branch, so settling the hold
    // too would be a double-dip. A public P does NOT change that here — it is decided AFTER the refund fate, so
    // a shallow-but-confirmed refund + a late P can never double-dip (the old ordering's fund-loss hole). Two
    // sub-cases:
    //   (4a) FEE-BUMP (Fix 2): the refund is still 0-conf (spendConfs === 0 => mempool, RBF-replaceable), no P
    //        is public (a public P means the maker is entitled to the BTC — let its claim win, never race it),
    //        and the taker hold's remaining life is inside the danger window (holdLife <= refundBumpWithin). The
    //        refund MUST confirm before the hold expires, so fee-bump it (RBF). The io re-broadcasts at most once
    //        per new BTC block, escalating toward a ceiling, and is a no-op when the current fee already suffices.
    //   (4b) WAIT: a mined-but-shallow refund (spendConfs >= 1) cannot be RBF'd, or a public P (let the maker's
    //        claim win), or an unknown hold deadline — keep the taker hold ALIVE and re-observe. The next tick
    //        recoups if a claim swaps in (2), or goes terminal 'done' once the refund BURIES (1).
    if (spend === 'spent_refund') {
      if (spendConfs === 0 && !pPublic && Number.isFinite(holdLife) && holdLife <= c.refundBumpWithin)
        return { action: 'refund-bump', reason: `BTC HTLC refund is 0-conf (mempool, RBF-replaceable), no P public, and the taker hold has only ${holdLife} BTC block(s) of life left (<= danger window ${c.refundBumpWithin}) — FEE-BUMP the refund (RBF) so it confirms INSIDE the hold; a stalled refund past the hold would fail the hold back to the taker and let a maker claim take our BTC HTLC (full front loss). Never recoup-settle a spent_refund HTLC (no double-dip).` };
      return { action: 'wait', reason: `BTC HTLC spent on the REFUND branch but SHALLOW (${spendConfs} < finality depth ${c.refundFinalityConfs} confs)${pPublic ? ' (P is public — let the maker\'s claim win over our unconfirmed refund, never race it)' : ''} — NOT terminal and NEVER a recoup (we already reclaimed our BTC on the refund branch; settling the hold too would double-dip). A conflicting maker CLAIM can still swap in (RBF/reorg) => recoup at (2); release only once the refund BURIES (1). Keep the taker hold ALIVE and re-observe.` };
    }

    // (5) DEFINITIVELY UNSPENT + P PUBLIC (the taker claimed the maker asset leg — sa.onchain, primary) at ANY
    // depth — the maker is entitled to (and will) claim our still-OPEN BTC HTLC with the now-public P, so recoup
    // NOW (settle the held LN). Gated on spend === 'unspent': a spent_refund was already handled at (4) and NEVER
    // recoups (Fix 1), so pPublic can only force a recoup while the HTLC is genuinely unspent — never over an
    // existing refund spend. Fund-safe: we NEVER refund/release a P-public unspent HTLC.
    if (spend === 'unspent' && pPublic)
      return { action: 'recoup-settle', reason: 'BTC HTLC DEFINITIVELY unspent and P is PUBLIC (the taker claimed the maker asset leg — sa.onchain) — the maker will claim our open HTLC with it, so recoup the held LN now (never refund a P-public unspent HTLC)' };

    // (6) DEFINITIVELY UNSPENT, P NOT public, T_btc reached — refund our BTC HTLC (the taker hold returns on its
    // own; double no-loss). Idempotent: runPayerRefundOnce re-checks DEFINITIVELY-unspent via the classifier
    // before broadcasting, and skips to recoup/done if a claim/refund landed in the interim.
    if (spend === 'unspent' && obs.tip >= oc.cltv)
      return { action: 'refund-onchain', reason: 'BTC HTLC DEFINITIVELY unspent, no P public, tip>=T_btc — refund it (the taker hold returns on its own, double no-loss); idempotent — the io re-verifies unspent via the classifier before any broadcast' };

    // (7) DEFINITIVELY UNSPENT, P NOT public, T_btc NOT reached — RESUMABLE RELAY (crossFund) then WAIT. The
    // fund-onchain io action drives BOTH the fund AND the (idempotent) maker asset-leg relay, so while the relay
    // is pending RE-RETURN fund-onchain to re-drive it (resumable across a one-shot maker-reply timeout / an LSP
    // restart) — never strand a funded leg. Otherwise wait for the taker's asset claim (reveals P) or T_btc.
    if (spend === 'unspent' && obs.crossFund && obs.relayPending)
      return { action: 'fund-onchain', reason: 'BTC HTLC funded (unspent) but the maker asset-leg lock/relay (XcBtcLegFunded -> XcSeqLegLocked -> on-chain verify -> hand-off) is not complete — re-drive the idempotent relay (resumable across a one-shot maker-reply timeout / an LSP restart) so the funded leg is never stranded' };
    if (spend === 'unspent')
      return { action: 'wait', reason: 'BTC HTLC funded and DEFINITIVELY unspent, no P yet, tip<T_btc — awaiting the taker\'s asset claim (reveals P) or T_btc. No claim unwinds no-loss.' };

    // (defensive) any other spendStatus value -> fail closed (wait, re-observe).
    return { action: 'wait', reason: `BTC HTLC spend status ${JSON.stringify(spend)} unrecognized — fail closed (wait, re-observe)` };
  }

  // ---- not yet funded on-chain (oc null or oc.funded false): gate hard on the payer's LN being HELD first ----
  if (!obs.ln.held) return { action: 'wait', reason: 'awaiting the payer\'s LN payment to arrive HELD (our recoup) before we fund the on-chain HTLC' };
  const holdLife = typeof obs.ln.expiryBlocks === 'number' ? obs.ln.expiryBlocks : Infinity;
  // TRANSIENT-OUTAGE / REORG-EVICTION GUARD (funded payer leg). If the driver's persisted state KNOWS this leg's
  // BTC HTLC is already funded (obs.onchainKnownFunded — s.htlc.txid recorded) but THIS tick's on-chain read
  // reports it as NOT funded — a null/unreadable read (a momentary bitcoind outage) OR onchain.funded===false (a
  // reorg that evicted the funding tx) — do NOT fall into the not-funded branch: its fail-close (hold-near-expiry)
  // or RE-FUND path would be wrong for a leg we already funded (a re-fund would double-broadcast; a fail-close
  // would strand it). Treat both as transient and WAIT (re-observe): a hiccup clears next tick, and a reorg
  // re-mines the same funding tx (its txid is unchanged). A funded payer leg is never dropped to terminal 'failed'.
  if ((!oc || oc.funded === false) && obs.onchainKnownFunded === true)
    return { action: 'wait', reason: `BTC HTLC reports ${!oc ? 'unreadable (transient bitcoind outage)' : 'funded:false (reorg evicted the funding tx)'} this tick but it is KNOWN funded (persisted s.htlc) — wait and re-observe rather than fail-close or re-fund; a funded payer leg is never dropped on a momentary outage or a reorg near expiry` };
  // The on-chain HTLC CLTV we will set must mature INSIDE the LN hold's remaining life (holdBuffer).
  if (holdLife !== Infinity && holdLife <= c.holdBuffer) return { action: 'fail-closed', reason: 'LN hold too close to expiry to safely fund an on-chain HTLC inside it — fail closed (LN hold returns to the payer)' };
  // B — FUND-BEFORE-LOCK (the payer BRIDGE, taker holds P). The MIRROR of the receiver leg's crossLock/recvReady
  // FRONT-BEFORE-FUND. Here the maker's asset leg locks ONLY AFTER this fund (the LSP sends XcBtcLegFunded, then
  // the maker locks the asset TO THE TAKER), so gating on swapLocked ("every OTHER leg locked") would DEADLOCK —
  // the asset never locks until after the fund. Funding the BTC HTLC reveals NOTHING (P is the taker's secret,
  // exposed only when the taker claims the asset), so a no-reveal ends double-no-loss. The fund-time CLTV ordering
  // is enforced by checkPayerFundGate in the io BEFORE it funds. Fund the instant the hold is HELD, ignoring swapLocked.
  if (obs.crossFund) return { action: 'fund-onchain', reason: 'payer\'s LN is HELD (FUND-BEFORE-LOCK: the maker\'s asset leg locks only AFTER this fund + our XcBtcLegFunded relay) — fund the maker\'s on-chain BTC HTLC (checkPayerFundGate enforced in the io; a no-reveal is double-no-loss)' };
  // NON-cross-fund (generic single-leg / back-compat, receiver holds P): funding the receiver's on-chain HTLC is
  // the action that lets THEM claim + REVEAL P, so withhold it until every OTHER leg is locked. Safe to stall: the
  // payer's LN is merely HELD and returns untouched. Default (undefined) => locked.
  if (obs.swapLocked === false) return { action: 'wait', reason: 'payer LN held, but WITHHOLDING the on-chain fund until every other leg locks (whole-swap atomicity on the shared H)' };
  return { action: 'fund-onchain', reason: 'payer\'s LN is held — fund the receiver\'s on-chain HTLC (CLTV set inside the hold\'s life, locked to the receiver, refundable to us)' };
}

// ============================================================================
// PAYER-BRIDGE FUND-ONCE ORCHESTRATOR (pure control-flow; ALL I/O injected). The `fund-onchain` io action funds
// the maker's on-chain BTC HTLC exactly once and must NEVER double-fund the deterministic P2SH (a second output
// strands the first, un-refunded = fund-loss). This orchestrator encodes the three UNIFORM disciplines so they
// are exhaustively unit-tested WITHOUT a node (this module's whole philosophy) instead of buried in the server:
//
//   (i)  NEVER BROADCAST ON UNCERTAINTY. Every dry-locate is DEFINITIVE-or-throw: the seqdex `-locate-only` CLI
//        exits non-zero (=> the injected `dryLocate` REJECTS) whenever ANY wallet-aware chain lookup fails, so
//        "I couldn't tell" can never masquerade as funded:false. An uncertain read propagates as a throw and NO
//        broadcast happens — the caller re-drives on the next tick. There is deliberately no catch-and-broadcast.
//   (ii) ADOPT-BEFORE-GATE. When a prior attempt already persisted the funding INTENT (`hasIntent` — the refund
//        key + intended redeemScript are durable, and they are persisted BELOW strictly BEFORE any broadcast), a
//        broadcast to the deterministic P2SH MAY already be on-chain (a crash between broadcast and the s.htlc
//        persist, or a momentarily-unreadable resume locate). So DRY-LOCATE FIRST and ADOPT an already-funded
//        leg, BEFORE runGate() can run. runGate() (checkPayerFundGate) assumes the leg is NOT-yet-funded — it
//        reads the taker's still-live incoming hold + the T_seq/T_btc ordering, which by re-entry may have moved
//        (the hold lapsed, T_seq passed) — so running it against an already-funded leg would THROW and abandon a
//        leg whose BTC is committed (grief->fund; the BTC strands un-refunded). Adoption skips the gate entirely.
//   (iii) PERSIST-INTENT-BEFORE-BROADCAST. On the first-fund path the leg is DEFINITIVELY not funded (adopt-locate
//        certified funded:false, or there was no prior intent so nothing was ever broadcast). Only then run the
//        gate; then persistIntent() (mint+persist the refund key + intended redeemScript) BEFORE any broadcast;
//        then a DEFINITIVE scan-before-broadcast — broadcast ONLY on funded:false, never on a throw.
//
// @param {{
//   hasIntent:boolean,          // a prior attempt persisted the funding intent (refund key + intended script durable)?
//   dryLocate:()=>Promise<{funded?:boolean, btc_htlc_txid?:string}>,  // DEFINITIVE wallet-aware locate; REJECTS on uncertainty
//   runGate:()=>Promise<void>,  // checkPayerFundGate wrapper; REJECTS (throws) on a fail-closed gate (assumes not-yet-funded)
//   persistIntent:()=>Promise<void>,  // mint (idempotent) + persist refund key + intended redeemScript, durable BEFORE broadcast
//   broadcast:()=>Promise<{funded facts}>,  // the irreversible funding broadcast (called at most ONCE, only on a definitive funded:false)
// }} io
// @returns {Promise<{funded:object, broadcasted:boolean, adopted:'pre-gate'|'pre-broadcast'|null}>}
export async function runPayerFundOnce({ hasIntent, dryLocate, runGate, persistIntent, broadcast } = {}) {
  if (typeof dryLocate !== 'function' || typeof runGate !== 'function'
    || typeof persistIntent !== 'function' || typeof broadcast !== 'function')
    throw new Error('runPayerFundOnce: dryLocate/runGate/persistIntent/broadcast must all be functions — fail closed');
  // (1a) ADOPT-BEFORE-GATE — only when a prior intent could have produced a broadcast. DEFINITIVE locate first;
  // a REJECT (uncertain) propagates and nothing is funded (re-drive). A definitive funded:true adopts, skipping
  // the gate; a definitive funded:false falls through to first-fund.
  if (hasIntent) {
    const located = await dryLocate();   // throws on uncertainty -> caller re-drives; NEVER a guess
    if (located && located.funded && located.btc_htlc_txid) return { funded: located, broadcasted: false, adopted: 'pre-gate' };
  }
  // (1b) FIRST-FUND — DEFINITIVELY not funded. The gate (assumes not-yet-funded) is now correct to run.
  await runGate();                       // throws on a fail-closed gate -> nothing funded
  await persistIntent();                 // refund key + intended script durable BEFORE any broadcast
  // DEFINITIVE scan-before-broadcast: broadcast ONLY on funded:false; a REJECT (uncertain) propagates (re-drive),
  // so a transient read over an already-funded leg can never trigger a SECOND broadcast.
  const located = await dryLocate();     // throws on uncertainty
  if (located && located.funded && located.btc_htlc_txid) return { funded: located, broadcasted: false, adopted: 'pre-broadcast' };
  const funded = await broadcast();      // definitively not funded -> broadcast exactly once
  return { funded, broadcasted: true, adopted: null };
}

// ============================================================================
// PAYER-BRIDGE REFUND-ONCE ORCHESTRATOR (pure control-flow; I/O injected). The `refund-onchain` io action
// reclaims the LSP's own funded BTC HTLC at T_btc. Its IDEMPOTENCY + no-double-dip is now enforced by
// CHAIN TRUTH, not by the racy persisted s.refunded intent flag:
//
//   classifySpend() (the seqdex xsubas-htlc-spend-status classifier, DEFINITIVE-or-throw) is consulted FIRST,
//   IMMEDIATELY before broadcasting:
//     - 'spent_claim'  => the maker already claimed our BTC HTLC (revealing P). DO NOT refund — return without
//        broadcasting; the next observe drives a recoup-settle. (A refund broadcast now would fail anyway — the
//        output is spent — but skipping it avoids a wasted/again-racy broadcast and is the correct decision.)
//     - 'spent_refund' => our refund already landed. DONE (idempotent) — return without broadcasting.
//     - 'unspent'      => DEFINITIVELY not yet spent + the driver already gated tip>=T_btc: broadcast the refund
//        exactly once. s.refunded is still persisted FIRST, but purely as a broadcast-DEDUP HINT (it no longer
//        gates recoup — the 'spent_refund' chain fact does).
//     - anything else (uncertain) => THROW: fail closed, do not broadcast on an unresolved chain read; re-drive.
//   classifySpend() also THROWS on an unreadable classifier (exec error), which propagates — never a guess.
//
// On a broadcast FAILURE the refund tx did NOT land (xsubas-refund-btc leaves the HTLC untouched on any error,
// retryable), so clearRefundIntent() clears the dedup hint and the error re-throws so the driver re-drives.
//
// @param {{ classifySpend:()=>Promise<{status:string}>, persistRefundIntent:()=>Promise<void>,
//           broadcastRefund:()=>Promise<any>, clearRefundIntent:()=>Promise<void> }} io
// @returns {Promise<{broadcasted:boolean, status:string, result?:any}>}
export async function runPayerRefundOnce({ classifySpend, persistRefundIntent, broadcastRefund, clearRefundIntent } = {}) {
  if (typeof classifySpend !== 'function' || typeof persistRefundIntent !== 'function'
    || typeof broadcastRefund !== 'function' || typeof clearRefundIntent !== 'function')
    throw new Error('runPayerRefundOnce: classifySpend/persistRefundIntent/broadcastRefund/clearRefundIntent must all be functions — fail closed');
  // CHAIN-TRUTH idempotency: never broadcast a refund unless the BTC HTLC is DEFINITIVELY unspent.
  const cls = await classifySpend();   // DEFINITIVE-or-throw (an uncertain/unreadable classifier propagates)
  const status = cls && cls.status;
  if (status === 'spent_claim')
    return { broadcasted: false, status };   // the maker claimed -> recoup instead (next observe drives recoup-settle); NEVER refund
  if (status === 'spent_refund')
    return { broadcasted: false, status };   // our refund already landed -> done (idempotent)
  if (status !== 'unspent')
    throw new Error(`runPayerRefundOnce: spend status ${JSON.stringify(status)} is not DEFINITIVELY unspent — fail closed (do not broadcast a refund on an unresolved chain read)`);
  // DEFINITIVELY unspent -> persist the dedup hint (NOT a recoup gate), then broadcast exactly once.
  await persistRefundIntent();   // s.refunded = true — broadcast-dedup hint only
  try {
    return { broadcasted: true, status, result: await broadcastRefund() };
  } catch (e) {
    await clearRefundIntent();    // tx did NOT land -> clear the dedup hint; re-drive
    throw e;
  }
}

// ============================================================================
// PAYER-BRIDGE REFUND FEE SIZING (Fix 2 — REFUND FEE ADEQUACY). PURE. Given a fresh sat/vB estimate (from
// estimatesmartfee, targeting confirmation inside the hold's remaining life) and the refund tx vsize, return
// the ABSOLUTE fee (sats) to target — clamped to [floor, min(ceil, amountSat - dust)]. Used for BOTH the
// INITIAL refund broadcast (lastFee 0, bumpFactor 1) and each RBF bump (lastFee = the prior fee, bumpFactor
// > 1 so the replacement clears the min-increment even if the estimate itself has not risen). Fee value is
// PRESERVED across the HTLC by never letting the fee eat past (amount - dust): a refund must still pay out.
//
// @param {{ estSatPerVb:number, vsize:number, amountSat:number, floorSats:number, ceilSats:number,
//           dustSats?:number, lastFee?:number, bumpFactor?:number }} a
// @returns {number} the absolute fee in sats to set (>= 0)
export function sizeRefundFee({ estSatPerVb, vsize, amountSat, floorSats, ceilSats, dustSats = 546, lastFee = 0, bumpFactor = 1 } = {}) {
  const vb = Number(vsize) > 0 ? Number(vsize) : 250;
  const estFee = (Number.isFinite(estSatPerVb) && estSatPerVb > 0) ? Math.ceil(estSatPerVb * vb) : 0;
  const factor = Number(bumpFactor) > 1 ? Number(bumpFactor) : 1;
  const bumpFloor = Math.ceil((Number(lastFee) || 0) * factor);
  let fee = Math.max(estFee, bumpFloor, Number(floorSats) || 0);
  // Never fee more than the HTLC value can spare (the refund output must still be >= dust). This ceiling
  // dominates the configured ceil for a small HTLC — a fee that would strand the output is refused implicitly.
  const spendCap = Math.max(0, (Number(amountSat) || 0) - (Number(dustSats) || 0));
  const ceil = Math.min(Number.isFinite(Number(ceilSats)) ? Number(ceilSats) : Infinity, spendCap > 0 ? spendCap : Infinity);
  if (Number.isFinite(ceil)) fee = Math.min(fee, ceil);
  return Math.max(0, Math.floor(fee));
}

// ============================================================================
// PAYER-BRIDGE REFUND FEE-BUMP ORCHESTRATOR (Fix 2, pure control-flow; I/O injected). While the LSP's own
// T_btc refund sits 0-conf it must be RBF-BUMPED until it confirms inside the taker hold's life — else a
// stalled refund past the hold fails the hold back to the taker and a maker claim then takes the LSP's BTC
// HTLC (full front loss). Disciplines (mirror of runPayerRefundOnce's chain-truth gating):
//   (i)   RE-CLASSIFY FIRST (chain truth): only bump an HTLC the classifier STILL reads as spent_refund AND
//         still 0-conf (spendConfs === 0 => mempool, RBF-replaceable). A flip to spent_claim / a BURIED
//         refund / an unspent read => do NOT bump (the driver's recoup / done / refund path takes over).
//         classifySpend() is DEFINITIVE-or-throw; an uncertain/unreadable classifier propagates => no bump.
//   (ii)  THROTTLE to at most one bump per new BTC block (tipAdvanced) so a ~3s driver tick cannot spam
//         replacements (each replacement pays the min-relay increment; unthrottled it would burn to the ceiling
//         in seconds). tipAdvanced() is true only when the BTC tip rose since the last bump.
//   (iii) STRICTLY-HIGHER fee only: computeFee() returns { fee, bump } — bump is false when the current fee
//         already suffices or the ceiling is hit, so the replacement is a no-op rather than an equal-fee churn.
// A failed rebroadcast (RBF rejected / node hiccup) leaves the prior refund untouched (retryable) and the
// error propagates so the driver re-observes — never a double no-op.
//
// @param {{ classifySpend:()=>Promise<{status:string, spendConfs?:number}>,
//           tipAdvanced:()=>Promise<boolean>|boolean,
//           computeFee:()=>Promise<{fee:number, bump:boolean}>,
//           rebroadcast:(fee:number)=>Promise<any> }} io
// @returns {Promise<{bumped:boolean, status?:string, fee?:number, reason?:string, result?:any}>}
export async function runPayerRefundBumpOnce({ classifySpend, tipAdvanced, computeFee, rebroadcast } = {}) {
  if (typeof classifySpend !== 'function' || typeof tipAdvanced !== 'function'
    || typeof computeFee !== 'function' || typeof rebroadcast !== 'function')
    throw new Error('runPayerRefundBumpOnce: classifySpend/tipAdvanced/computeFee/rebroadcast must all be functions — fail closed');
  const cls = await classifySpend();     // DEFINITIVE-or-throw (an uncertain/unreadable classifier propagates)
  const status = cls && cls.status;
  const confs = Number.isFinite(cls && cls.spendConfs) ? cls.spendConfs : 0;
  // Only a STILL-0-conf spent_refund is RBF-bumpable. Anything else — a mined refund (can't RBF a confirmed
  // tx), a claim that swapped in, a buried refund, or an unspent read — is the main driver path's business.
  if (status !== 'spent_refund' || confs !== 0)
    return { bumped: false, status, reason: `not a 0-conf refund (status=${status}, confs=${confs}) — no bump` };
  if (!(await tipAdvanced()))
    return { bumped: false, status, reason: 'no new BTC block since the last bump — throttled' };
  const { fee, bump } = await computeFee();   // fresh estimate vs the last fee -> a strictly-higher target, or bump:false
  if (!bump)
    return { bumped: false, status, fee, reason: 'current refund fee already sufficient / ceiling reached — no bump' };
  const result = await rebroadcast(fee);      // RBF-replace the refund with the higher fee (throws => retry next tick)
  return { bumped: true, status, fee, result };
}
