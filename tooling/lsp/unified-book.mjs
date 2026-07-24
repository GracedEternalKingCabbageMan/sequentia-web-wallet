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

// The maker's advertised LN node pubkey (needed to reach an interactive submarine maker), if any.
const lnNodePub = (o) => (o && (o.maker_ln_node_pubkey ?? o.makerLnNodePubkey)) || null;

// Classify ONE relay offer (the shared /v1/market/<asset>/BTC/orderbook shape) into a normalized
// entry, or null if unrecognized / signature-unverified.
//
// SETTLEMENT SURFACE (meta.caps). Every recognized offer now carries a signed-in-spirit capability
// descriptor the settlement router (chooseSettlementPath) reads to pick the rail: btc_ln (can the
// maker settle the BTC leg over Lightning?), interactive (online + runs the handshake live, false =>
// passive covenant), asset_onchain (is the asset leg on-chain?), and maker_ln_node_pubkey. This
// generalizes the old bare `interactive` flag; matching stays rail-blind, caps are read only on take.
//
// The recognized shapes, by their BTC/asset rails:
//   • SUBMARINE (lightning.ln_direction 0/1): asset leg ON-CHAIN (Sequentia), BTC leg over Lightning.
//     These are the P2P rail-crossing counterparties. ln_direction=1 (REVERSE, LnBTCForAsset) = the
//     maker SELLS the asset (locks it on-chain, mints a bolt11) => a taker BUYS = ask. ln_direction=0
//     (NORMAL, LnAssetForBTC) = the maker BUYS the asset (pays the taker's bolt11) => a taker SELLS =
//     bid. An online interactive maker => caps.btc_ln + interactive + asset_onchain. base_amount is the
//     asset; BTC is want_amount (ask) or offer_amount (bid).
//   • SUB-ASSET LN (ln_direction 4/5): asset leg over Lightning, BTC leg an ON-CHAIN HTLC (btc_ln:false).
//   • ON-CHAIN cross (plain intents): both legs on-chain — recognized by the parent-BTC leg
//     (want_asset==='BTC' => a taker BUYS = ask; offer_asset==='BTC' => a taker SELLS = bid). No LN.
export function classifyRelayOffer(o) {
  if (!o || o._verified === false) return null;
  const lt = o.lightning || o.Lightning || {};
  const dir = Number(lt.ln_direction);
  const nodePub = lnNodePub(o);
  const baseAtoms = num(o.base_amount ?? o.baseAmount);
  // SUBMARINE (asset on-chain + BTC-LN): the P2P rail-crossing offers. An interactive online maker.
  // GATE 0/1 on a GENUINE numeric ln_direction. The zero enum value (LnAssetForBTC=0) COLLIDES with the
  // protobuf/JSON default, so a NON-submarine offer carrying a nil/unpopulated LightningTerms — which
  // protojson EmitUnpopulated can render as ln_direction: null / "" (which `Number(...)` coerces to 0), or
  // an absent field — would otherwise be MIS-classified as a normal (ln_direction=0) submarine bid. Requiring
  // ln_direction to be a real JS number (never a coerced null/""/undefined) keeps an unpopulated block out of
  // the submarine branches; a genuine numeric 0/1 still classifies. (4/5 don't collide with the 0 default, so
  // they keep the plain Number coercion below.)
  const dirIsNum = typeof lt.ln_direction === 'number' && Number.isFinite(lt.ln_direction);
  if (dirIsNum && dir === 1) return mk('ask', 'submarine', baseAtoms || num(o.offer_amount), num(o.want_amount), o,
    { ln_direction: 1, interactive: true, caps: { btc_ln: true, interactive: true, asset_onchain: true, maker_ln_node_pubkey: nodePub } });
  if (dirIsNum && dir === 0) return mk('bid', 'submarine', baseAtoms || num(o.want_amount), num(o.offer_amount), o,
    { ln_direction: 0, interactive: true, caps: { btc_ln: true, interactive: true, asset_onchain: true, maker_ln_node_pubkey: nodePub } });
  // SUB-ASSET LN (asset over LN + BTC on-chain HTLC): the BTC leg cannot go over Lightning (btc_ln:false).
  if (dir === 4) return mk('ask', 'ln', num(o.offer_amount), num(o.want_amount), o,
    { ln_direction: 4, interactive: true, caps: { btc_ln: false, interactive: true, asset_onchain: false, maker_ln_node_pubkey: nodePub } });
  if (dir === 5) return mk('bid', 'ln', num(o.want_amount), num(o.offer_amount), o,
    { ln_direction: 5, interactive: false, caps: { btc_ln: false, interactive: false, asset_onchain: false, maker_ln_node_pubkey: nodePub } });
  const oa = o.offer_asset ?? o.offerAsset, wa = o.want_asset ?? o.wantAsset;
  const assetAtoms = num(o.base_amount ?? o.baseAmount);
  // ON-CHAIN cross (both legs on-chain): a passive fill the LSP bridge settles — no LN, not interactive.
  if (wa === 'BTC') return mk('ask', 'onchain', assetAtoms || num(o.offer_amount), num(o.want_amount), o,
    { trade_dir: 'sell', caps: { btc_ln: false, interactive: false, asset_onchain: true, maker_ln_node_pubkey: null } });
  if (oa === 'BTC') return mk('bid', 'onchain', assetAtoms || num(o.want_amount), num(o.offer_amount), o,
    { trade_dir: 'buy', caps: { btc_ln: false, interactive: false, asset_onchain: true, maker_ln_node_pubkey: null } });
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
