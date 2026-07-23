// W5 — SBTC MIS-SELL BINDING (swap.js). A BTC-advertised covenant is treated as a pegged-BTC (SBTC
// silent-peg) bid: filling it pays the taker in SBTC that the wallet auto-redeems to real BTC. That
// promise is ONLY sound if the covenant actually LOCKS SBTC. A malicious maker can rest a covenant that
// locks a WORTHLESS asset while advertising the row on a BTC market; a taker who fills it pays real
// EURX/GOLD and receives junk. covenantLocksAsset() binds the take to the SBTC asset id and fails closed
// otherwise. This test exercises the pure guard in isolation (a minimal shim is enough to import swap.js).
import assert from 'node:assert';

// swap.js reads `localStorage` at module load; a no-op shim is all the import needs.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { __test__ } = await import('./swap.js');
const { covenantLocksAsset } = __test__;
assert.equal(typeof covenantLocksAsset, 'function', 'covenantLocksAsset is exported for the mis-sell guard');

const SBTC = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

// A covenant that genuinely LOCKS SBTC is a valid pegged-BTC bid -> bind (safe to fill + auto-redeem).
assert.equal(covenantLocksAsset({ covenant: { asset_a: SBTC } }, SBTC), true, 'a covenant locking SBTC binds');
assert.equal(covenantLocksAsset({ Covenant: { assetA: SBTC.toUpperCase() } }, SBTC), true, 'case-insensitive + camelCase Covenant/assetA shape binds');

// THE ATTACK: a BTC-advertised covenant that locks any OTHER asset must be REFUSED (never quoted/taken).
assert.equal(covenantLocksAsset({ covenant: { asset_a: OTHER } }, SBTC), false, 'a BTC-advertised covenant locking a DIFFERENT asset is refused (mis-sell trap)');
assert.equal(covenantLocksAsset({ covenant: {} }, SBTC), false, 'a covenant with no locked asset is refused');
assert.equal(covenantLocksAsset(null, SBTC), false, 'a missing offer is refused');

// Fail closed when SBTC is unavailable on this network (sbtcAssetId() -> null): nothing can be pegged BTC.
assert.equal(covenantLocksAsset({ covenant: { asset_a: SBTC } }, null), false, 'no SBTC id -> nothing is treated as pegged BTC (fail closed)');
assert.equal(covenantLocksAsset({ covenant: { asset_a: SBTC } }, ''), false, 'empty SBTC id -> fail closed');

console.log('ok: covenantLocksAsset binds a pegged-BTC covenant to the SBTC asset id, refusing every other asset (W5)');
console.log('\nALL PASS');
