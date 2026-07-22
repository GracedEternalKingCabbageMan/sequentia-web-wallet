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
    // WHOLE-SWAP ATOMICITY: fronting the LN (paying the receiver's hold on H) is the action that lets
    // the receiver settle and REVEAL P. Withhold it until every OTHER leg of the swap is locked, or a
    // partial (this leg reveals + settles while another leg never locks) becomes possible. A stall here
    // is no-loss: nothing fronted yet. swapLocked===undefined => locked (single-leg / back-compat).
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
