// Settlement router — the rail-agnostic matching principle, made concrete.
//
// PRINCIPLE (Andreas, 2026-07-16): the DEX matches on {asset, price, size, side} ALONE.
// Rails (Lightning vs on-chain) are NOT a matching axis — they are a settlement preference
// each party states for the side it holds. This module takes a MATCH that already happened
// (rail-blind) and decides HOW to settle it, inserting an LSP bridge ONLY where the two
// sides' rail choices genuinely cross. When they coincide, the LSP is not in the value path
// at all (it only did matchmaking). See memory dex-rail-agnostic-matching.
//
// A BTC<->asset swap has exactly two legs, atomically bound by ONE preimage H:
//   • BTC leg:   payer = BUYER  (pays BTC),   receiver = SELLER (receives BTC)
//   • asset leg: payer = SELLER (pays asset), receiver = BUYER  (receives asset)
// Each leg's two endpoints each have a rail. Per leg:
//   • endpoints AGREE            -> settle natively on that rail (no bridge)
//   • endpoints DISAGREE (cross) -> the LSP terminates the LN end and originates the
//                                   on-chain end, passing H through: one submarine hop,
//                                   on THAT leg only.
// A receiver on 'ln' with no inbound liquidity needs a JIT channel first (provisionInbound).
//
// This file is a PURE function: no I/O, no config, no fund movement. It is the spine the
// live settlement path (runMixed / the cross-book couriers / pure-LN) will be refactored to
// obey, and it is exhaustively unit-tested in settlement-router.test.mjs.

/** @typedef {'ln'|'chain'} Rail */

/**
 * @param {object} match
 * @param {string} match.asset   asset id (or ticker) being traded against BTC
 * @param {object} match.buyer   { btcRail:Rail, assetRail:Rail, assetInbound?:boolean }
 *   buyer PAYS BTC on btcRail, RECEIVES the asset on assetRail. assetInbound: does the
 *   buyer already hold LN inbound for the asset? (only consulted when assetRail==='ln')
 * @param {object} match.seller  { assetRail:Rail, btcRail:Rail, btcInbound?:boolean }
 *   seller PAYS the asset on assetRail, RECEIVES BTC on btcRail. btcInbound: only consulted
 *   when btcRail==='ln'.
 * @returns {object} a settlement plan (see below)
 */
export function planSettlement(match) {
  if (!match || !match.buyer || !match.seller) throw new Error('planSettlement: match needs buyer and seller');
  const { buyer, seller } = match;
  assertRail(buyer.btcRail, 'buyer.btcRail');
  assertRail(buyer.assetRail, 'buyer.assetRail');
  assertRail(seller.assetRail, 'seller.assetRail');
  assertRail(seller.btcRail, 'seller.btcRail');

  // BTC leg: buyer pays, seller receives. Asset leg: seller pays, buyer receives.
  const btcLeg = planLeg('btc', buyer.btcRail, seller.btcRail, !!seller.btcInbound);
  const assetLeg = planLeg('asset', seller.assetRail, buyer.assetRail, !!buyer.assetInbound);

  const bridged = btcLeg.bridge || assetLeg.bridge;
  return {
    asset: match.asset ?? null,
    btcLeg,
    assetLeg,
    // Whole-swap atomicity is always one shared preimage H. When the LSP bridges a leg it
    // must hold H until BOTH legs are locked (so neither party can be left half-settled);
    // when nothing is bridged, the two real parties bind H directly (on-chain couriers or
    // pure-LN) and the LSP only introduced them.
    atomic: { sharedPreimage: true, lspCoordinates: bridged },
    // The "happy coincidence": both legs settle on the rail each endpoint already wanted,
    // so no submarine hop and no bridge fee. This is the common, cheapest path and must be
    // preferred whenever the match allows it.
    happyCoincidence: !bridged,
    // Everything the caller must actually DO, in order, to make settlement happen.
    steps: buildSteps(btcLeg, assetLeg),
  };
}

/**
 * Decide a single leg. payerRail/receiverRail are the rails the two endpoints chose;
 * receiverInbound says whether an LN receiver already has inbound liquidity.
 */
export function planLeg(unit, payerRail, receiverRail, receiverInbound) {
  assertRail(payerRail, `${unit} payerRail`);
  assertRail(receiverRail, `${unit} receiverRail`);
  const native = payerRail === receiverRail;
  // A receiver on Lightning must have inbound liquidity to receive at all. If not, a JIT
  // channel is opened toward it first (provisionInbound). This is independent of bridging:
  // it applies to a native ln-ln leg too.
  const jitInbound = receiverRail === 'ln' && !receiverInbound;

  if (native) {
    return {
      unit,
      rail: payerRail,
      method: payerRail === 'ln' ? 'ln-htlc' : 'onchain-htlc',
      bridge: false,
      lnSide: null,
      jitInbound,
    };
  }
  // Endpoints cross: exactly one is 'ln'. The LSP is the LN counterparty to the ln end and
  // the on-chain counterparty to the chain end, forwarding the SAME H. One submarine hop.
  return {
    unit,
    rail: 'mixed',
    method: 'submarine',
    bridge: true,
    lnSide: payerRail === 'ln' ? 'payer' : 'receiver',
    jitInbound,
  };
}

function buildSteps(btcLeg, assetLeg) {
  const steps = [];
  // Provision inbound BEFORE anything locks, so an LN receiver can actually receive.
  for (const leg of [btcLeg, assetLeg]) {
    if (leg.jitInbound) steps.push({ op: 'provision-inbound', leg: leg.unit });
  }
  // Lock both legs (order is caller's concern; the router just states what must lock).
  for (const leg of [btcLeg, assetLeg]) {
    steps.push({ op: leg.bridge ? 'lock-submarine' : (leg.method === 'ln-htlc' ? 'lock-ln' : 'lock-onchain'), leg: leg.unit });
  }
  // Reveal H to claim; when any leg is bridged the LSP gates the reveal for atomicity.
  steps.push({ op: 'reveal-preimage', gatedByLsp: btcLeg.bridge || assetLeg.bridge });
  return steps;
}

function assertRail(r, where) {
  if (r !== 'ln' && r !== 'chain') throw new Error(`${where} must be 'ln' or 'chain' (got ${JSON.stringify(r)})`);
}
