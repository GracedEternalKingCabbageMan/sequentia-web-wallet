// bridge-driver.mjs — the LIVE driver that EXECUTES a rail-crossing settlement, obeying the pure
// decision cores (settlement-router.mjs + leg-bridge.mjs) and never front-running them.
//
// WHERE THIS SITS:
//   • settlement-router.planSettlement(match)  -> WHICH legs cross (rail-blind matching).
//   • leg-bridge.nextBridgeStep(leg, obs)      -> the next SAFE action for ONE crossed leg.
//   • THIS module                              -> the loop that OBSERVES real state, asks
//                                                 nextBridgeStep, and executes EXACTLY its output,
//                                                 plus the whole-swap coordinator (JIT inbound first,
//                                                 the atomicity gate on the shared H, recoup-before-CLTV).
//
// It is I/O-FREE by construction: every side effect (LN hold pay/settle, on-chain HTLC fund/claim/
// refund/observe, JIT inbound, native-leg drive, the clock) arrives through an injected `io` object.
// So the fund-safety-critical CONTROL FLOW is unit-tested without a node — identical discipline to the
// pure cores it drives. The live LSP builds a REAL `io` (LN primitives + the seqob-cli HTLC commands)
// and hands it in; a test builds a scripted fake `io`. The driver's logic is the SAME either way.
//
// THE LOAD-BEARING INVARIANT (verify it survives every edit): the driver NEVER decides to move value on
// its own judgement. For a crossed leg it does ONLY what nextBridgeStep returns; a `wait`/unknown is a
// no-op sleep; a `fail-closed` aborts the leg (and, if anything was fronted, unwinds it via the core's
// own refund/recoup actions — never an ad-hoc spend). Because nextBridgeStep only ever fronts once the
// recoup is secured, the driver can only ever stall into a refundable no-loss failure, never steal.

import { nextBridgeStep, checkBridgeLocktimeOrdering } from './leg-bridge.mjs';
import { planSettlement } from './settlement-router.mjs';

export const DRIVER_DEFAULTS = Object.freeze({
  pollMs: 3000,          // how often to re-observe a leg between actions
  maxTicks: 100000,      // hard ceiling so a wedged observe can never spin forever (fails closed)
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Map a nextBridgeStep action to the io method that performs it. Kept as a table (not a switch) so it
// is impossible for the driver to invent an action the core never returned: an action absent here is a
// no-op observation tick, never a value move.
const ACTION_IO = Object.freeze({
  'front-ln':       'frontLn',
  'fund-onchain':   'fundOnchain',
  'recoup-claim':   'recoupClaim',
  'recoup-settle':  'recoupSettle',
  'refund-onchain': 'refundOnchain',
});

/**
 * Drive ONE crossed leg to completion by repeatedly observing its two ends and executing EXACTLY the
 * action nextBridgeStep returns. Pure control-flow; all effects via `io`.
 *
 * @param {object} args
 * @param {{lnSide:'receiver'|'payer', amountSat:number, unit?:string}} args.leg
 * @param {{
 *   observe: () => Promise<{tip:number, onchain:object|null, ln:object}>,   // the leg's live state
 *   frontLn?: Function, fundOnchain?: Function,                              // value-front actions
 *   recoupClaim?: Function, recoupSettle?: Function, refundOnchain?: Function,
 *   swapLocked?: () => boolean,   // whole-swap gate: are ALL OTHER legs locked? (default true)
 *   sleep?: (ms:number)=>Promise, log?: Function, signal?: {aborted:boolean},
 * }} args.io
 * @param {object} [args.cfg]  leg-bridge cfg overrides (frontRunway/claimMargin/holdBuffer)
 * @param {object} [args.driverCfg]  { pollMs, maxTicks }
 * @returns {Promise<{ok:boolean, reason:string, fronted:boolean, lastAction:string}>}
 */
export async function runBridgedLeg({ leg, io, cfg = {}, driverCfg = {} }) {
  if (!leg || (leg.lnSide !== 'receiver' && leg.lnSide !== 'payer'))
    throw new Error("runBridgedLeg: leg.lnSide must be 'receiver' or 'payer'");
  if (!io || typeof io.observe !== 'function') throw new Error('runBridgedLeg: io.observe is required');
  const d = { ...DRIVER_DEFAULTS, ...driverCfg };
  const nap = io.sleep || sleep;
  const log = io.log || (() => {});
  // fronted := has the LSP put value at stake on this leg yet? It flips true the instant we execute a
  // front-ln/fund-onchain, and it gates whether a fail-closed must unwind. (leg-bridge only ever
  // fail-closes BEFORE a front, so this stays false there; it is defence-in-depth, not the primary bar.)
  let fronted = false, lastAction = 'none';
  for (let tick = 0; tick < d.maxTicks; tick++) {
    if (io.signal && io.signal.aborted) return { ok: false, reason: 'aborted', fronted, lastAction };
    let obs;
    try { obs = await io.observe(); }
    catch (e) { log('[bridge-leg] observe failed, retrying:', e && e.message); await nap(d.pollMs); continue; }
    // Feed the whole-swap atomicity gate to the PURE core, so the front is withheld there (not by an
    // ad-hoc driver branch): the driver still executes exactly nextBridgeStep's output.
    if (io.swapLocked) obs = { ...obs, swapLocked: !!io.swapLocked() };
    const step = nextBridgeStep(leg, obs, cfg);
    lastAction = step.action;
    if (step.action === 'done') { log('[bridge-leg] done:', step.reason); return { ok: true, reason: step.reason, fronted, lastAction }; }
    if (step.action === 'fail-closed') {
      // Nothing was fronted (the core only fail-closes before a front), so aborting is no-loss. If a
      // future core ever fail-closed AFTER a front, `fronted` surfaces it loudly for the operator.
      log('[bridge-leg] FAIL-CLOSED', fronted ? '(AFTER a front — operator attention!)' : '(no value fronted, no loss)', step.reason);
      return { ok: false, reason: step.reason, fronted, lastAction };
    }
    const method = ACTION_IO[step.action];
    if (!method) { await nap(d.pollMs); continue; }   // 'wait' or anything unmapped -> observe again; NEVER a value move
    if (typeof io[method] !== 'function') return { ok: false, reason: `io.${method} not wired for action ${step.action}`, fronted, lastAction };
    if (step.action === 'front-ln' || step.action === 'fund-onchain') fronted = true;
    try {
      log('[bridge-leg] exec', step.action, '—', step.reason);
      await io[method](step, obs);
    } catch (e) {
      // An execution error is NOT a decision to move value differently: re-observe and let the core
      // re-decide from the true on-chain/LN state (e.g. a broadcast that actually landed shows up as
      // funded; a genuinely failed front shows up as still-unfunded and is retried safely).
      log('[bridge-leg]', step.action, 'raised, re-observing:', e && e.message);
    }
    await nap(d.pollMs);
  }
  // maxTicks exhausted. If NOTHING was fronted, no value is at stake and the leg is RESUMABLE — surface
  // `interrupted` so the whole-swap layer marks the job 'interrupted' (re-driven by resume-on-boot) rather
  // than 'failed' (which would strand a taker whose asset leg is already committed). A POST-front exhaustion
  // is a genuine anomaly needing attention, so it stays a plain (non-resumable) failure with fronted:true.
  return { ok: false, reason: 'exceeded maxTicks without terminal state — failing closed', fronted, lastAction,
    interrupted: !fronted };
}

// Split a settlement plan's two legs into { bridged, native, jit }. Each entry carries the router leg
// plus its unit ('btc'|'asset'). Amounts/keys are attached by the caller (they come from the match).
export function classifyLegs(plan) {
  const legs = [plan.btcLeg, plan.assetLeg].filter(Boolean);
  return {
    bridged: legs.filter((l) => l.bridge),
    native:  legs.filter((l) => !l.bridge),
    jit:     legs.filter((l) => l.jitInbound),
  };
}

/**
 * Coordinate a WHOLE bridged swap on the ONE shared preimage H.
 *
 * Ordering (this is the atomicity spine):
 *   0. JIT: provision inbound for every leg whose LN receiver lacks it, BEFORE anything locks.
 *   1. Kick off each NATIVE leg on the existing path (taker<->maker / the mapped xsub* CLI). The LSP is
 *      NOT in a native leg's value path; it only OBSERVES the leg's lock to gate the bridged front.
 *   2. Drive each CROSSED leg with runBridgedLeg, feeding it a swapLocked() gate = "every OTHER leg of
 *      this swap is locked". nextBridgeStep therefore WITHHOLDS the one value-front that reveals P until
 *      the whole swap is committed — so a partial (one leg reveals, another never locks) is impossible.
 *   3. Await all legs. Any crossed-leg fail-closed fails the swap (no value fronted, refundable).
 *
 * A leg is "locked" when, if P appeared now, it would settle and cannot be refunded out from under us:
 *   • native  -> io.observeNativeLocked(leg)  (maker funded the HTLC / the LN payment is held)
 *   • bridged -> its recoup is secured, i.e. nextBridgeStep(swapLocked:true) would front (not still
 *                waiting for its own recoup, and not failing). Computed via io.observe(leg) so no leg's
 *                readiness ever depends on another leg's FRONT — only on its lock — which rules out a
 *                mutual-wait deadlock when BOTH legs bridge.
 *
 * @param {object} args
 * @param {object} args.match       a planSettlement match ({asset, buyer, seller})
 * @param {object} args.io          whole-swap effects (see makeLegIo below) — one io per leg + provisionInbound
 * @param {object} [args.cfg]       leg-bridge cfg
 * @param {object} [args.driverCfg] driver cfg
 * @returns {Promise<{ok:boolean, plan:object, legs:object[], reason?:string}>}
 */
export async function runBridgedSwap({ match, io, cfg = {}, driverCfg = {} }) {
  const plan = planSettlement(match);
  if (plan.happyCoincidence) {
    // No leg crosses -> the LSP must NOT be in the value path. Refuse here so a coincident match can
    // never be silently routed through a bridge (and charged a bridge fee). The caller settles it
    // natively (the existing review/execute or xsub* dispatch).
    return { ok: false, plan, legs: [], reason: 'happy coincidence — settle natively, not via the bridge (the LSP is not a value-path counterparty here)' };
  }
  const d = { ...DRIVER_DEFAULTS, ...driverCfg };
  const nap = (io.sleep) || sleep;
  const log = io.log || (() => {});
  const { bridged, native, jit } = classifyLegs(plan);
  // The router leg does not carry the amount the front must be bounded to; the match does, surfaced via
  // io.legAmountSat(leg). Enrich each leg so nextBridgeStep's amount check (never front more than we
  // recoup) has a real bound. A missing legAmountSat is a wiring bug -> fail closed rather than front unbounded.
  const amtOf = (leg) => (io.legAmountSat ? Number(io.legAmountSat(leg)) : leg.amountSat);
  const withAmt = (leg) => ({ lnSide: leg.lnSide, amountSat: amtOf(leg), unit: leg.unit, bridge: leg.bridge, jitInbound: leg.jitInbound });

  // W2(a) — AUTHORITATIVE DRIVER-LIVENESS. Mark the driver LIVE for exactly the window it can still front,
  // and CLEAR it the instant the leg drivers stop (BELOW, before the post-loop awaits). The /bridge/asset
  // handler gates the taker's asset hand-off on THIS flag (via bridgeAssetHandoffAdmissible) instead of the
  // job.status, which LAGS termination by the post-loop awaits — a window in which a maxTicks-exhausted
  // driver (no front will ever happen) still shows status 'confirming', so relaying the asset would strand
  // it. `io.setDriverLive` is optional (bridge-driver stays node-free / job-agnostic; the live LSP io binds
  // it to job._driverLive). clearLive is idempotent and covers every exit — early return, throw, or normal.
  if (io.setDriverLive) io.setDriverLive(true);
  const clearLive = () => { if (io.setDriverLive) io.setDriverLive(false); };

  // 0. JIT inbound FIRST (an LN receiver with no inbound cannot receive at all). Fail closed on error:
  //    nothing is locked yet, so aborting is free.
  for (const leg of jit) {
    try { await io.provisionInbound(leg); log('[bridge-swap] JIT inbound provisioned for', leg.unit); }
    catch (e) { clearLive(); return { ok: false, plan, legs: [], reason: `JIT inbound for ${leg.unit} failed (fail closed, nothing locked): ${e && e.message}` }; }
  }

  // 1. Kick off native legs on the existing path. Non-blocking: they lock, then settle once P flows.
  const nativeRuns = native.map((leg) => ({ leg, p: Promise.resolve(io.startNative ? io.startNative(leg) : undefined) }));

  // The cross-leg lock oracle. `self` is excluded so a leg never gates on itself.
  const legKey = (l) => l.unit;
  async function legLocked(leg) {
    if (leg.bridge) {
      // Ready-to-front == recoup secured. Ask the core with swapLocked:true (ignore the whole-swap gate)
      // and treat a front/recoup/done as "locked"; a wait-for-recoup or fail as "not locked".
      let obs;
      try { obs = await io.observe(leg); } catch { return false; }
      const s = nextBridgeStep(withAmt(leg), { ...obs, swapLocked: true }, cfg);
      return s.action === 'front-ln' || s.action === 'fund-onchain'
          || s.action === 'recoup-claim' || s.action === 'recoup-settle' || s.action === 'done';
    }
    try { return !!(await io.observeNativeLocked(leg)); } catch { return false; }
  }
  // swapLocked for a given bridged leg = every OTHER leg locked. Cached per tick by the leg loop's own
  // re-observe cadence; here we compute it on demand from the live oracle.
  const otherLegsLocked = async (self) => {
    for (const l of plan.btcLeg && plan.assetLeg ? [plan.btcLeg, plan.assetLeg] : [plan.btcLeg, plan.assetLeg].filter(Boolean)) {
      if (!l || legKey(l) === legKey(self)) continue;
      if (!(await legLocked(l))) return false;
    }
    return true;
  };

  // 2. Drive each crossed leg, gated on the whole-swap lock. We snapshot the gate each observe tick via
  //    a synchronous flag the coordinator refreshes, so runBridgedLeg stays synchronous in swapLocked().
  const gate = new Map();   // unit -> boolean (is every OTHER leg locked?)
  for (const leg of bridged) gate.set(legKey(leg), false);
  let coordinating = true;
  const refresh = (async () => {
    while (coordinating) {
      for (const leg of bridged) {
        try { gate.set(legKey(leg), await otherLegsLocked(leg)); } catch { /* keep last */ }
      }
      await nap(Math.max(500, Math.floor(d.pollMs / 2)));
    }
  })();

  const bridgedRuns = bridged.map((leg) => runBridgedLeg({
    leg: withAmt(leg),
    io: legIoFor(io, leg, () => !!gate.get(legKey(leg))),
    cfg, driverCfg,
  }).then((r) => ({ leg, r })));

  let results;
  try {
    results = await Promise.all(bridgedRuns);
  } finally {
    // The leg drivers have stopped — CLEAR driver-liveness NOW, before the post-loop awaits below, so the
    // /bridge/asset gate refuses a hand-off the instant no driver will front it (closes the ~1.5s lag).
    clearLive();
  }
  coordinating = false; await refresh.catch(() => {});
  // Let native legs finish settling (they self-complete once P is public). Best-effort await.
  await Promise.allSettled(nativeRuns.map((n) => n.p));

  const failed = results.filter((x) => !x.r.ok);
  const legs = results.map((x) => ({ unit: x.leg.unit, ...x.r }));
  if (failed.length) {
    // The whole swap is INTERRUPTED (resumable) only if EVERY failed leg is a pre-front maxTicks
    // exhaustion (nothing fronted, nothing lost). A single genuine fail-closed / post-front failure makes
    // it a real failure that must NOT be silently resumed.
    const interrupted = failed.every((f) => f.r.interrupted === true);
    return { ok: false, plan, legs, interrupted,
      reason: failed.map((f) => `${f.leg.unit}: ${f.r.reason}`).join('; ') };
  }
  return { ok: true, plan, legs };
}

// W3(b) — does a rail-blind TAKE genuinely CROSS rails (i.e. REQUIRE a bridge)? Pure; used by the LSP
// /swap dispatch to REFUSE a crossed take that omitted bridge:true, which would otherwise misroute into
// the CUSTODIAL submarine path and move the LSP's OWN funds on an unrelated swap while reporting success.
// Returns false when the shape can't be determined (missing/invalid rails throw in matchFromTake) — the
// caller then falls through to its normal, individually-guarded dispatch rather than over-refusing.
export function takeRailsCrossed(take) {
  try {
    const plan = planSettlement(matchFromTake(take));
    return !plan.happyCoincidence;
  } catch { return false; }
}

// P3.2 — CROSSING-SHAPE CAPABILITY. A crossing may be REQUIRED (takeRailsCrossed/plan.bridged) yet not be
// one the LSP's live bridge io actually SETTLES. Today EXACTLY ONE shape is wired end to end: the BTC leg
// is BRIDGED with the LSP on the LN-receiver side (the taker SELLS the asset and RECEIVES BTC over
// Lightning) while the asset leg settles NATIVELY (direct taker<->maker). This is the SINGLE source of
// truth for "is this crossing settleable" — the LSP's prepareBridgeLegs admission (`canBridge`) and the
// wallet's PRE-REVIEW check both call it, so a Review can never promise a bridge the LSP refuses
// post-confirm. Pure. `plan` is a planSettlement result.
export function crossingShapeSupported(plan) {
  if (!plan || plan.happyCoincidence) return false;   // not a crossing -> settle natively, not via the bridge
  const btc = plan.btcLeg, asset = plan.assetLeg;
  return !!(btc && btc.bridge && btc.lnSide === 'receiver' && (!asset || !asset.bridge));
}

// P3.2 — the wallet's pre-Review verdict for a rail-blind TAKE: does this crossing settle on the LSP's
// bridge? Match-based wrapper over crossingShapeSupported so the wallet composer can FALL BACK to the
// native/on-chain path (same price) instead of promising a bridge that fails post-confirm. Fails safe:
// an undeterminable shape (bad rails throw in matchFromTake) returns false -> the wallet does not promise
// a bridge. Never throws.
export function bridgedTakeSupported(take) {
  try { return crossingShapeSupported(planSettlement(matchFromTake(take))); }
  catch { return false; }
}

// P3.2 — the LSP capability descriptor published on /status, so any client (Ambra, future wallets) can
// read what crossing shapes the bridge settles WITHOUT re-deriving the wired-shape predicate. Enumerated
// over the four taker rail combinations against a unified-book maker (BTC leg on-chain; asset leg follows
// the offer rail), tagging each genuine crossing supported/unsupported via the ONE predicate above. Pure.
export function describeCrossingSupport() {
  const shapes = [];
  for (const side of ['buy', 'sell'])
    for (const payRail of ['ln', 'chain'])
      for (const recvRail of ['ln', 'chain'])
        for (const makerAssetRail of ['ln', 'chain']) {
          let plan;
          try { plan = planSettlement(matchFromTake({ asset: 'x', side, payRail, recvRail, makerBtcRail: 'chain', makerAssetRail })); }
          catch { continue; }
          if (plan.happyCoincidence) continue;   // only genuine crossings appear
          shapes.push({ side, payRail, recvRail, makerAssetRail, supported: crossingShapeSupported(plan) });
        }
  return {
    wired_shape: 'taker SELLS the asset and RECEIVES BTC over Lightning, against an on-chain reverse maker (BTC leg bridged LN-receiver, asset leg native)',
    supported_crossings: shapes.filter((s) => s.supported),
    unsupported_crossings: shapes.filter((s) => !s.supported),
  };
}

// W2(a) — the /bridge/asset admission predicate. The taker's asset hand-off is accepted ONLY while a
// bridged driver is authoritatively LIVE to front it (job._driverLive, set/cleared synchronously with
// runBridgedSwap above) AND the courier session that relays the leg to the maker is still open. Gating on
// this — NOT the lagging job.status — closes the window where a maxTicks-exhausted driver's post-loop
// awaits still show status 'confirming' (+ a non-null session) yet no front will ever happen, so relaying
// the asset would hand it to the maker and strand the taker. Pure; shared by the handler and its test.
export function bridgeAssetHandoffAdmissible(job) {
  return !!(job && job._driverLive === true && job._bridgeSession);
}

// W2(a) — the RELAY-time LOCKTIME verdict for /bridge/asset. The taker's asset leg becomes EXPOSED to the
// maker's claim the INSTANT it is relayed (the maker can then claim it with P and reveal P; the taker can
// no longer be protected by anything but its own T_seq asset refund). So the SAME wall-clock locktime
// ordering the front enforces MUST also gate the relay — and against LIVE tips, because a short T_btc may
// have DRIFTED into the danger window since the handshake gate passed. This reads the two CLTV refund
// heights from the SAME job fields the front-time gate uses (the maker BTC HTLC's CLTV; the taker asset
// HTLC's refund height T_seq) and defers the wall-clock decision to checkBridgeLocktimeOrdering against the
// LIVE btc + seq tips the handler just read. A refusal => DO NOT relay (fail closed): the taker keeps its
// asset and refunds at T_seq. Pure (the handler does the I/O of reading tips); shared with its test. An
// unreadable tip arrives here as NaN and the gate fails closed — never relay on an unverifiable ordering.
export function bridgeAssetRelayLocktimeVerdict({ job, btcTip, seqTip, holdInvoiceLifeSecs, cfg } = {}) {
  const sbHtlc = (job && job.legState && job.legState.btc && job.legState.btc.htlc) || {};
  const saState = (job && job.legState && job.legState.asset) || {};
  const btcRefundHeight = Number(sbHtlc.cltv);
  const seqRefundHeight = Number(saState.seqLocktime ?? (job && job.bridge_terms && job.bridge_terms.seq_locktime));
  return checkBridgeLocktimeOrdering({ btcTip, btcRefundHeight, seqTip, seqRefundHeight, holdInvoiceLifeSecs, cfg });
}

// W3(c) — a ln/ln take is the UNCHANGED pure-LN route ONLY when it is NOT a bridged take. A genuine
// bridged take can carry BOTH taker rails on Lightning (the resting MAKER's rails differ, so a leg still
// crosses); it MUST fall through to the bridged driver, never be swallowed by pure-LN runSwap — which
// would settle an UNRELATED swap over the shared node and falsely report 'settled'. Pure; shared by the
// LSP /swap dispatch and its test so the ordering bug (ln/ln branch firing before the bridge branch, with
// no bridge exemption) cannot silently regress.
export function isPureLnTake({ payRail, recvRail, bridge }) {
  return payRail === 'ln' && recvRail === 'ln' && bridge !== true;
}

// Build the per-leg io view runBridgedLeg expects from the whole-swap io, binding the swapLocked gate.
function legIoFor(io, leg, swapLockedFn) {
  const bind = (name) => (typeof io[name] === 'function' ? (step, obs) => io[name](leg, step, obs) : undefined);
  return {
    observe: () => io.observe(leg),
    frontLn: bind('frontLn'), fundOnchain: bind('fundOnchain'),
    recoupClaim: bind('recoupClaim'), recoupSettle: bind('recoupSettle'), refundOnchain: bind('refundOnchain'),
    swapLocked: swapLockedFn,
    sleep: io.sleep, log: io.log, signal: io.signal,
  };
}

// Build a planSettlement match from a rail-blind TAKE: the taker's chosen rails + the resting offer's
// rails. Used identically by the wallet (to decide happy-coincidence vs cross, and to render honest net
// terms) and the LSP /swap dispatch (to drive the bridge) — ONE source of truth so both agree on which
// legs cross. The taker is the buyer on a 'buy' and the seller on a 'sell'; the maker is the other side.
// A resting maker's LN leg is served by its always-on hosted node, so it is assumed to hold inbound
// (no JIT for the maker) unless told otherwise; only the TAKER may need a JIT open.
export function matchFromTake({
  asset, side, payRail, recvRail, makerBtcRail, makerAssetRail,
  takerAssetInbound = false, takerBtcInbound = false, makerAssetInbound = true, makerBtcInbound = true,
}) {
  assertR(payRail, 'payRail'); assertR(recvRail, 'recvRail');
  assertR(makerBtcRail, 'makerBtcRail'); assertR(makerAssetRail, 'makerAssetRail');
  if (side === 'buy') {
    // taker BUYS: pays BTC on payRail, receives the asset on recvRail.
    return { asset,
      buyer:  { btcRail: payRail, assetRail: recvRail, assetInbound: !!takerAssetInbound },
      seller: { assetRail: makerAssetRail, btcRail: makerBtcRail, btcInbound: !!makerBtcInbound } };
  }
  if (side === 'sell') {
    // taker SELLS: pays the asset on payRail, receives BTC on recvRail.
    return { asset,
      seller: { assetRail: payRail, btcRail: recvRail, btcInbound: !!takerBtcInbound },
      buyer:  { btcRail: makerBtcRail, assetRail: makerAssetRail, assetInbound: !!makerAssetInbound } };
  }
  throw new Error("matchFromTake: side must be 'buy' or 'sell'");
}
function assertR(r, w) { if (r !== 'ln' && r !== 'chain') throw new Error(`matchFromTake: ${w} must be 'ln' or 'chain' (got ${JSON.stringify(r)})`); }

// Derive a unified-book offer's per-leg maker rails. The unified book merges ONLY on-chain cross offers
// (both legs on-chain) and sub-asset LN offers (asset leg over LN, BTC leg on-chain — that is exactly
// what ln_direction 4/5 encode). So a maker's BTC leg is ALWAYS on-chain here, and only the asset leg
// follows the offer's rail. (Pure-LN offers live in a different book, not the unified one.)
export function makerRailsFromOffer(offer) {
  const railLn = !!offer && (offer.rail === 'ln');
  return { makerBtcRail: 'chain', makerAssetRail: railLn ? 'ln' : 'chain' };
}

// A convenience describer for the wallet's HONEST net-terms display: does this match need a bridge
// and/or a JIT open, and on which legs. Pure; no fees computed here (the caller adds its fee model).
export function describeBridge(match) {
  const plan = planSettlement(match);
  const { bridged, jit } = classifyLegs(plan);
  return {
    bridged: !plan.happyCoincidence,
    happyCoincidence: plan.happyCoincidence,
    bridgeLegs: bridged.map((l) => ({ unit: l.unit, lnSide: l.lnSide })),
    jitLegs: jit.map((l) => l.unit),
    lspInValuePath: !plan.happyCoincidence || jit.length > 0,
  };
}
