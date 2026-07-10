// Standalone verification of PART 2a: the wallet de-privileges tSEQ across the fee machinery —
// tSEQ is gated on the node's /feerates acceptance feed EXACTLY like any asset, with no privileged
// fallback. index.html is not an ES module (its logic lives in an inline <script>), so this test
// re-implements the exact predicates from index.html's fetchFeeRates / feeRateEntry /
// populateFeeAssets / tx-builder fee-rate branch and asserts the two required behaviours:
//   (A) feed PRICES tSEQ  -> tSEQ is offered + a tSEQ fee builds at the reference scale (unchanged)
//   (B) feed OMITS tSEQ   -> tSEQ is NOT offered (gated out) — no privilege
// Keep this in lockstep with index.html if that logic changes.
import assert from 'node:assert';

const EXCHANGE_RATE_SCALE = 100000000;
const POLICY_HEX = 'pp'.repeat(32);            // stand-in policy (tSEQ) asset id
const GOLD = 'aa'.repeat(32), OILX = 'bb'.repeat(32);
const META = { [POLICY_HEX]: 'tSEQ', [GOLD]: 'GOLD', [OILX]: 'OILX' };
const ticker = (h) => META[h] || h.slice(0, 6);

// --- fetchFeeRates: index the reference (tSEQ) from the feed like any asset; never fabricate ---
function buildFeeRates(feed){
  const map = {};
  const ref = feed.bitcoin;
  if (ref > 0 && POLICY_HEX) map[POLICY_HEX] = { rate: ref, source: 'reference' };   // tSEQ ONLY if fed
  for (const [k, v] of Object.entries(feed)){ if (k === 'bitcoin' || !(v > 0)) continue; map[k] = { rate: v }; }
  return map;
}
const feeRateEntry = (feeRates, hex) => feeRates[hex] || feeRates[ticker(hex)];
// populateFeeAssets: offer a held asset iff the node prices it (tSEQ included, no exception).
function offeredFeeAssets(feeRates, held){
  const out = [];
  for (const h of held){ const e = feeRateEntry(feeRates, h); if (e && e.rate > 0) out.push(h); }
  return out;
}
// tx-builder fee-rate branch (STRUCTURAL, kept): policy asset pays natively at the reference scale.
const txFeeR = (feeRates, feeHex) => (feeHex === POLICY_HEX) ? EXCHANGE_RATE_SCALE : feeRateEntry(feeRates, feeHex).rate;

// (A) feed prices tSEQ (bitcoin present) — held: tSEQ, GOLD, OILX(unpriced by feed)
{
  const feed = { bitcoin: EXCHANGE_RATE_SCALE, GOLD: 200000000 };   // OILX absent from feed
  const fr = buildFeeRates(feed);
  const offered = offeredFeeAssets(fr, [POLICY_HEX, GOLD, OILX]);
  assert.ok(offered.includes(POLICY_HEX), 'A: tSEQ offered when the feed prices it');
  assert.ok(offered.includes(GOLD), 'A: a priced held asset is offered');
  assert.ok(!offered.includes(OILX), 'A: an unpriced held asset is gated out (same rule as tSEQ)');
  assert.equal(txFeeR(fr, POLICY_HEX), EXCHANGE_RATE_SCALE, 'A: a tSEQ fee builds at the reference scale (native, unchanged)');
  console.log('ok: feed PRICES tSEQ -> tSEQ offered + tSEQ fee builds (no regression)');
}

// (B) feed OMITS tSEQ (no bitcoin key) — the node prices fees in USD and refuses SEQ
{
  const feed = { GOLD: 200000000, OILX: 3 };    // NO bitcoin -> SEQ not accepted
  const fr = buildFeeRates(feed);
  assert.ok(!feeRateEntry(fr, POLICY_HEX), 'B: tSEQ absent from feeRates when the feed omits it (no fabricated reference)');
  const offered = offeredFeeAssets(fr, [POLICY_HEX, GOLD, OILX]);
  assert.ok(!offered.includes(POLICY_HEX), 'B: tSEQ is NOT offered when the feed omits it (de-privileged)');
  assert.ok(offered.includes(GOLD) && offered.includes(OILX), 'B: other feed-priced assets are still offered');
  console.log('ok: feed OMITS tSEQ -> tSEQ gated out like any unpriced asset (no privilege)');
}

console.log('\nALL PASS');
