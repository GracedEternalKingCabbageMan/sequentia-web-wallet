// Tests for the unified order book. Run: node unified-book.test.mjs
import { classifyRelayOffer, mergeBook, buildUnifiedBook, bestFor } from './unified-book.mjs';

let passed = 0, failed = 0;
function eq(a, e, msg){ if (JSON.stringify(a) === JSON.stringify(e)) passed++; else { failed++; console.error(`FAIL ${msg}\n  exp ${JSON.stringify(e)}\n  got ${JSON.stringify(a)}`); } }
function ok(c, msg){ if (c) passed++; else { failed++; console.error(`FAIL ${msg}`); } }

// --- classify: LN offers ---
const lnAsk = classifyRelayOffer({ offer_id:'a1', maker_pubkey:'m1', offer_amount:1000, want_amount:50, lightning:{ ln_direction:4 } });
eq({ side:lnAsk.side, rail:lnAsk.rail, asset:lnAsk.assetAtoms, btc:lnAsk.btcSats, price:lnAsk.price },
   { side:'ask', rail:'ln', asset:1000, btc:50, price:0.05 }, 'LN dir4 -> ask, price btc/asset');
const lnBid = classifyRelayOffer({ offer_id:'b1', offer_amount:60, want_amount:1000, lightning:{ ln_direction:5 } });
eq({ side:lnBid.side, rail:lnBid.rail, asset:lnBid.assetAtoms, btc:lnBid.btcSats, price:lnBid.price },
   { side:'bid', rail:'ln', asset:1000, btc:60, price:0.06 }, 'LN dir5 -> bid, asset=want btc=offer');

// --- classify: on-chain cross offers (plain intent, recognized by the parent-BTC leg) ---
// forward/ask: maker sells the asset for BTC (want_asset='BTC'); base=asset, want=BTC.
const ocAsk = classifyRelayOffer({ offer_id:'c1', base_amount:1000, offer_amount:1000, want_amount:52, offer_asset:'GOLD', want_asset:'BTC' });
eq({ side:ocAsk.side, rail:ocAsk.rail, asset:ocAsk.assetAtoms, btc:ocAsk.btcSats, price:ocAsk.price }, { side:'ask', rail:'onchain', asset:1000, btc:52, price:0.052 }, 'want_asset=BTC -> ask');
// reverse/bid: maker offers BTC for the asset (offer_asset='BTC'); base=asset, offer=BTC.
const ocBid = classifyRelayOffer({ offer_id:'c2', base_amount:1000, offer_amount:58, want_amount:1000, offer_asset:'BTC', want_asset:'GOLD' });
eq({ side:ocBid.side, rail:ocBid.rail, asset:ocBid.assetAtoms, btc:ocBid.btcSats, price:ocBid.price }, { side:'bid', rail:'onchain', asset:1000, btc:58, price:0.058 }, 'offer_asset=BTC -> bid');

// --- classify: rejects ---
ok(classifyRelayOffer({ _verified:false, lightning:{ ln_direction:4 } }) === null, 'signature-unverified rejected');
ok(classifyRelayOffer({ offer_id:'x' }) === null, 'unrecognized (no rail metadata) rejected');
ok(classifyRelayOffer(null) === null, 'null rejected');

// --- merge: asks ascending, bids descending, rails interleaved by PRICE ---
const raws = [
  { offer_id:'oc-ask', base_amount:1000, offer_amount:1000, want_amount:52, offer_asset:'GOLD', want_asset:'BTC' }, // ask 0.052 onchain
  { offer_id:'ln-ask', offer_amount:1000, want_amount:50, lightning:{ ln_direction:4 } },                          // ask 0.050 ln (cheaper)
  { offer_id:'oc-bid', base_amount:1000, offer_amount:58, want_amount:1000, offer_asset:'BTC', want_asset:'GOLD' }, // bid 0.058 onchain (higher)
  { offer_id:'ln-bid', offer_amount:55, want_amount:1000, lightning:{ ln_direction:5 } },                          // bid 0.055 ln
];
const book = buildUnifiedBook(raws);
eq(book.asks.map(a => [a.id, a.rail]), [['ln-ask','ln'], ['oc-ask','onchain']], 'asks: cheaper LN ask ranks above the on-chain ask (rail-blind)');
eq(book.bids.map(b => [b.id, b.rail]), [['oc-bid','onchain'], ['ln-bid','ln']], 'bids: higher on-chain bid ranks above the LN bid (rail-blind)');

// --- bestFor: rail-blind best price ---
ok(bestFor(book, 'buy').id  === 'ln-ask', 'best BUY = lowest ask, regardless of rail (LN here)');
ok(bestFor(book, 'sell').id === 'oc-bid', 'best SELL = highest bid, regardless of rail (on-chain here)');
ok(bestFor({ asks:[], bids:[] }, 'buy') === null, 'empty side -> null');

// --- merge drops sizeless offers ---
const withZero = buildUnifiedBook([{ offer_id:'z', offer_amount:0, want_amount:10, lightning:{ ln_direction:4 } }]);
ok(withZero.asks.length === 0, 'zero-size offer dropped (no price)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
