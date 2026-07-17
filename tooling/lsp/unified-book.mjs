// Unified order book (Stage 2) — the rail-agnostic matching principle at the book layer.
//
// For a BTC<->asset pair there are today TWO parallel books: on-chain cross offers and sub-asset
// LN offers, resting on different relays but sharing the /v1/market/<asset>/BTC/orderbook shape.
// This module merges them into ONE price-sorted book per pair, keyed on {price, size, side}, with
// rail as metadata. A taker sees ALL resting liquidity merged and takes the best PRICE regardless
// of its rail; the settlement router (settlement-router.mjs) bridges the rails on take. See memory
// dex-rail-agnostic-matching.
//
// Pure + fully unit-tested (unified-book.test.mjs). Amounts are integers (asset atoms, BTC sats);
// price is a float (BTC sats per asset atom) used ONLY for ordering/selection, never settlement.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// side: 'ask' = an offer SELLING the asset (a taker BUYS it); 'bid' = an offer BUYING the asset (a
// taker SELLS into it). rail: 'ln' | 'onchain'. price is BTC sats per asset atom (null if sizeless).
function mk(side, rail, assetAtoms, btcSats, raw, meta) {
  // Require BOTH legs positive: a zero/negative btcSats yields price <= 0, which would survive the
  // `price == null` drop in mergeBook, sort to the TOP of asks, and get auto-selected by bestFor as
  // "the best price". Null it so mergeBook discards the garbage offer.
  const price = (assetAtoms > 0 && btcSats > 0) ? btcSats / assetAtoms : null;
  return {
    side, rail, assetAtoms, btcSats, price,
    id: (raw && (raw.offer_id || raw.offerId)) || null,
    maker: (raw && (raw.maker_pubkey || raw.makerPubkey)) || null,
    expires: num(raw && (raw.expires_at_unix || raw.expires_at)) || null,
    meta: meta || {}, raw,
  };
}

// Classify ONE relay offer (the shared /v1/market/<asset>/BTC/orderbook shape) into a normalized
// entry, or null if unrecognized / signature-unverified. LN offers carry lightning.ln_direction
// (4 = SELL-asset-for-BTC = ask; 5 = BUY-asset-with-BTC = bid). On-chain cross offers are PLAIN
// INTENTS — the courier mints the HTLC terms per-lift, so they carry NO cross_chain metadata;
// recognize them by the parent-BTC leg: want_asset==='BTC' (maker sells the asset for BTC = a taker
// BUYS = ask) or offer_asset==='BTC' (maker offers BTC for the asset = a taker SELLS = bid). The
// literal string 'BTC' = the parent chain; a hex asset id = a same-chain pair (dropped here).
// base_amount is always the asset; the BTC amount is want_amount (ask) or offer_amount (bid).
export function classifyRelayOffer(o) {
  if (!o || o._verified === false) return null;
  const lt = o.lightning || o.Lightning || {};
  const dir = Number(lt.ln_direction);
  if (dir === 4) return mk('ask', 'ln', num(o.offer_amount), num(o.want_amount), o, { ln_direction: 4, interactive: true });
  if (dir === 5) return mk('bid', 'ln', num(o.want_amount), num(o.offer_amount), o, { ln_direction: 5, interactive: false });
  const oa = o.offer_asset ?? o.offerAsset, wa = o.want_asset ?? o.wantAsset;
  const assetAtoms = num(o.base_amount ?? o.baseAmount);
  if (wa === 'BTC') return mk('ask', 'onchain', assetAtoms || num(o.offer_amount), num(o.want_amount), o, { trade_dir: 'sell' });
  if (oa === 'BTC') return mk('bid', 'onchain', assetAtoms || num(o.want_amount), num(o.offer_amount), o, { trade_dir: 'buy' });
  return null;
}

// Merge normalized offers (from any/all relays) into one book: asks ascending by price (cheapest
// first), bids descending (highest first). Sizeless offers are dropped. A stable secondary sort by
// id keeps output deterministic when prices tie (important for tests + caching).
export function mergeBook(offers) {
  const asks = [], bids = [];
  for (const e of offers || []) {
    if (!e || e.price == null) continue;
    (e.side === 'ask' ? asks : bids).push(e);
  }
  const tie = (a, b) => String(a.id || '').localeCompare(String(b.id || ''));
  asks.sort((a, b) => (a.price - b.price) || tie(a, b));
  bids.sort((a, b) => (b.price - a.price) || tie(a, b));
  return { asks, bids };
}

// classify + merge in one step, from raw relay offers.
export function buildUnifiedBook(rawOffers) {
  return mergeBook((rawOffers || []).map(classifyRelayOffer).filter(Boolean));
}

// The offer a taker on `takerSide` ('buy' | 'sell') should take: the best PRICE, rail-blind.
// buy -> the lowest ask; sell -> the highest bid. Null if that side is empty.
export function bestFor(book, takerSide) {
  if (takerSide === 'buy')  return book.asks[0] || null;
  if (takerSide === 'sell') return book.bids[0] || null;
  return null;
}
