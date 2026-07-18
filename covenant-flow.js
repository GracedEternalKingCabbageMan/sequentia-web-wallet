// ---------------------------------------------------------------------------
// covenant-flow.js — the PURE glue between the unified "Place order" composer and
// the byte-exact covenant stack (covenant.js / covenant-order.js / covenant-fill-
// host.js / seqob.js). Everything here is side-effect-free and unit-tested
// (covenant-flow.test.mjs); swap.js supplies the wallet I/O.
//
// It owns three concerns the UI needs, none of which touch crypto or the chain:
//
//   1. rate math — turn a maker's "sell N of A, want M of B" into the covenant's
//      reduced rate_num/rate_den, and the absolute REFUND expiry height.
//   2. the anti-clobber compose-field rule — "price + one amount derives the
//      other, but NEVER destroys user input" (the first-order-in-empty-market
//      bug where two linked fields wiped each other).
//   3. the seqob.v1.Offer skeleton a covenant resting order posts (assembled from
//      the order + CovenantTerms; signed + posted by swap.js via seqob.js).
// ---------------------------------------------------------------------------

// --- rate math --------------------------------------------------------------

export function gcdBig(a, b){
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b){ [a, b] = [b, a % b]; }
  return a || 1n;
}

// computeRate turns "lock `sellAtoms` of A, want `recvAtoms` of B for a full fill"
// into the covenant's rate: a taker owes ceil(filled * rateNum/rateDen) of B. For a
// full fill (filled == sellAtoms) that is exactly recvAtoms, so rateNum/rateDen =
// recvAtoms/sellAtoms, reduced by gcd to keep the FILL leaf's 64-bit MUL well clear
// of overflow. (Reducing never changes the ceil result for the full-fill amount.)
export function computeRate(sellAtoms, recvAtoms){
  const sell = BigInt(sellAtoms), recv = BigInt(recvAtoms);
  if (sell < 1n || recv < 1n) throw new Error('sell and recv amounts must be >= 1');
  const g = gcdBig(recv, sell);
  return { rateNum: recv / g, rateDen: sell / g };
}

// The absolute-locktime REFUND height baked into a resting order. The maker may
// reclaim the locked A only after this height (until then the order can only be
// filled at the pinned price). Default horizon ~1 day of Sequentia blocks.
export const DEFAULT_ORDER_BLOCKS = 1440;
export function orderExpiry(tipHeight, blocks){
  const h = Number(tipHeight) || 0;
  return h + (Number(blocks) || DEFAULT_ORDER_BLOCKS);
}

// --- compose-field rule (anti-clobber) --------------------------------------

// deriveOtherField decides what, if anything, to write into the amount field the
// user did NOT just edit, WITHOUT ever destroying input they typed.
//
//   edited          'pay' | 'receive' — the side the user just changed
//   editedVal       the number now in that field (0 / NaN = empty)
//   otherUserTyped  true if the OTHER field currently holds a value the USER typed
//                   (vs. a value we derived) — a user limit must never be overwritten
//   price           reference RECEIVE-per-PAY price (from the book), or null/0 if none
//
// Returns { side, value } to write into the other field, or null to leave both
// fields exactly as they are. The invariants (project directive):
//   • edited side empty            -> null (never CLEAR the other side)
//   • other side is a user limit   -> null (never OVERWRITE user input)
//   • no price to derive from       -> null (empty-market first order: user fills
//                                      BOTH by hand; we must not wipe either)
//   • otherwise                     -> derive the other side from price
export function deriveOtherField({ edited, editedVal, otherUserTyped, price }){
  const v = Number(editedVal);
  if (!(v > 0)) return null;                      // nothing typed -> don't touch the other side
  if (otherUserTyped) return null;                // the user's own limit -> leave it
  const p = Number(price);
  if (!(p > 0) || !isFinite(p)) return null;      // no price -> can't derive; DON'T clear
  const otherSide = edited === 'pay' ? 'receive' : 'pay';
  const value = edited === 'pay' ? v * p : v / p;
  if (!(value > 0) || !isFinite(value)) return null;
  return { side: otherSide, value };
}

// --- market fill / rest split -----------------------------------------------

// fillRestSplit: for a MARKET order of `requestedAtoms` when only `fillableAtoms` can fill NOW
// (the book/maker depth at the price), return the { fill, rest } split — fill = what settles
// immediately, rest = the remainder that rests as a limit order at the same price. Both BigInt
// atoms. A sub-`1/dustDen` sliver of remainder (default <0.5%) is treated as rounding = a full
// fill (returns null, so callers show no split and rest nothing). null also when nothing is
// requested. Used identically by the same-chain (covenant) and cross-chain (HTLC) routes so the
// "fills ~X now, ~Y rests" behaviour + copy read the same on both.
export function fillRestSplit(requestedAtoms, fillableAtoms, dustDen = 200n){
  const req = BigInt(requestedAtoms);
  if (req <= 0n) return null;
  let fillable = BigInt(fillableAtoms); if (fillable < 0n) fillable = 0n;
  const fill = fillable > req ? req : fillable;    // can't fill more than the order
  const rest = req - fill;
  if (rest <= req / dustDen) return null;          // <0.5% sliver -> full fill, no remainder
  return { fill, rest };
}

// --- seqob.v1.Offer skeleton for a covenant resting order -------------------

// buildCovenantOffer assembles the seqob Offer a covenant maker posts: a SELL of
// asset A (offer/base) for asset B (want), carrying the CovenantTerms in the
// settlement oneof (field 23). swap.js signs it (seqob.signOffer / makerPriv) and
// POSTs it (seqob.postCovenantOffer). Pure: ids/amounts in, plain object out.
//   assetA/assetB  32-byte internal-order asset id hex
//   sellAtoms      atoms of A locked in the covenant
//   recvAtoms      atoms of B wanted for a full fill (== requiredBForFull)
//   covenant       the CovenantTerms (from buildCovenantTerms)
//   makerPubkey    the maker identity pubkey hex (seqob makerPubHex)
//   recvAddress    accepted for back-compat but NOT emitted: `covenant` and `same_chain` are BOTH
//                  members of the settlement oneof (field 23), so setting both makes protojson reject
//                  the offer ("oneof settlement is already set"). The covenant self-describes its
//                  payout (CovenantTerms.maker_prog = the taproot output a FILL credits), so a separate
//                  same-chain recv address is redundant; a covenant offer carries ONLY `covenant`.
//   nowUnix/ttl    created/expires timestamps
export function buildCovenantOffer({ assetA, assetB, sellAtoms, recvAtoms, covenant,
                                     makerPubkey, recvAddress, offerId, nowUnix, ttlSecs,
                                     allowPartial, minLot }){
  const now = Number(nowUnix != null ? nowUnix : Math.floor(Date.now() / 1000));
  const ttl = Number(ttlSecs || 3600);
  return {
    offer_id: offerId,
    schema_version: 1,
    pair: { base_asset: assetA, quote_asset: assetB },
    trade_dir: 1,                                   // SELL: maker gives base (= asset A)
    base_amount: String(BigInt(sellAtoms)),
    offer_amount: String(BigInt(sellAtoms)), offer_asset: assetA,
    want_amount: String(BigInt(recvAtoms)),  want_asset: assetB,
    // allow_partial + min_lot let the matcher cross what's available now and leave the covenant's
    // self-replicating remainder resting (a market order bigger than the book fills the book, rests
    // the rest). Defaults keep the old all-or-nothing behaviour for any caller that omits them.
    allow_partial: !!allowPartial,
    ...(minLot != null ? { min_lot: String(BigInt(minLot)) } : {}),
    created_at_unix: String(now),
    expires_at_unix: String(now + ttl),
    maker_pubkey: makerPubkey,
    fee_asset_hint: assetB,
    // ONLY `covenant` in the settlement oneof — see the recvAddress note above. Emitting `same_chain`
    // here too made every browser covenant post fail to decode ("oneof settlement is already set").
    covenant,
  };
}

export const __test__ = { gcdBig, computeRate, orderExpiry, deriveOtherField, buildCovenantOffer, fillRestSplit };
