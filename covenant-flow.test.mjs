// Tests for covenant-flow.js: rate reduction, REFUND expiry, the anti-clobber
// compose-field rule (first-order-in-empty-market, no field wipe/overwrite), the
// covenant Offer skeleton, AND an end-to-end place -> matched -> FILL wiring test
// that mocks the relay + wasm hooks (proving the taker settlement path without a
// live relay). Run: node covenant-flow.test.mjs

import { gcdBig, computeRate, orderExpiry, deriveOtherField, buildCovenantOffer, DEFAULT_ORDER_BLOCKS } from './covenant-flow.js';
import { ceilPrice, bytesToHex } from './covenant.js';
import { planPlaceOrder, buildCovenantTerms, place, settleFill } from './covenant-order.js';
import * as seqob from './seqob.js';
import { secp256k1 } from './btc.js';

let fails = 0;
function check(name, got, want){
  if (String(got) !== String(want)){ fails++; console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok   ${name}`);
}
function ok(name, cond, msg){ if (cond) console.log(`ok   ${name}`); else { fails++; console.error(`FAIL ${name}: ${msg||''}`); } }

// --- rate math --------------------------------------------------------------
check('gcd', gcdBig(90n*100000000n, 30n*100000000n), 30n*100000000n);
{
  const { rateNum, rateDen } = computeRate(90n*100000000n, 30n*100000000n);
  check('rate_reduced_num', rateNum, 1n);
  check('rate_reduced_den', rateDen, 3n);
  // Full-fill ceilPrice(sell, num, den) must equal the wanted recv exactly.
  check('rate_fullfill', ceilPrice(90n*100000000n, rateNum, rateDen), 30n*100000000n);
}
{
  // A non-reducible ratio must still round-trip the wanted amount on a full fill.
  const sell = 7n, recv = 3n;
  const { rateNum, rateDen } = computeRate(sell, recv);
  check('rate_prime_num', rateNum, 3n);
  check('rate_prime_den', rateDen, 7n);
  check('rate_prime_fullfill', ceilPrice(sell, rateNum, rateDen), recv);
}
check('expiry_default', orderExpiry(1000), 1000 + DEFAULT_ORDER_BLOCKS);
check('expiry_custom', orderExpiry(1000, 50), 1050);

// --- anti-clobber compose-field rule ----------------------------------------
// Empty market (no price): typing one side must NOT derive or clear the other —
// the user fills BOTH by hand (this is the bug that blocked the first trade).
check('empty_market_no_derive',
  deriveOtherField({ edited:'pay', editedVal:10, otherUserTyped:false, price:null }), null);
// Empty edited side must never clear the other.
check('empty_edited_no_clear',
  deriveOtherField({ edited:'pay', editedVal:0, otherUserTyped:true, price:2 }), null);
// A user's own limit (both sides typed) must never be overwritten.
check('user_limit_not_overwritten',
  deriveOtherField({ edited:'pay', editedVal:10, otherUserTyped:true, price:2 }), null);
// With a book price and an empty other side, derive it (pay -> receive = pay*price).
{
  const r = deriveOtherField({ edited:'pay', editedVal:10, otherUserTyped:false, price:2 });
  ok('derive_receive_from_pay', r && r.side === 'receive' && r.value === 20, JSON.stringify(r));
}
// Editing the receive side derives pay = receive/price.
{
  const r = deriveOtherField({ edited:'receive', editedVal:20, otherUserTyped:false, price:2 });
  ok('derive_pay_from_receive', r && r.side === 'pay' && r.value === 10, JSON.stringify(r));
}

// --- covenant Offer skeleton ------------------------------------------------
{
  const assetA = bytesToHex(Uint8Array.from({length:32},(_,i)=>i));
  const assetB = bytesToHex(Uint8Array.from({length:32},(_,i)=>32+i));
  const plan = planPlaceOrder({
    assetA, assetB, sellAtoms: 90n*100000000n,
    rateNum: 1, rateDen: 3, minLot: 90n*100000000n,
    expiryLocktime: 400, makerProg: '11'.repeat(32), makerX: '22'.repeat(32),
  });
  const ct = buildCovenantTerms(plan.order, 'ab'.repeat(32), 0, plan.tap);
  const priv = new Uint8Array(32); priv[31] = 9;
  const pub = seqob.bytesToHex(secp256k1.getPublicKey(priv, true));
  const offer = buildCovenantOffer({
    assetA, assetB, sellAtoms: 90n*100000000n, recvAtoms: plan.requiredBForFull,
    covenant: ct, makerPubkey: pub, recvAddress: 'tex1qexample', offerId: 'cov-2',
    nowUnix: 1000, ttlSecs: 3600,
  });
  check('offer_base', offer.base_asset || offer.pair.base_asset, assetA);
  check('offer_dir_sell', offer.trade_dir, 1);
  check('offer_partial_false', offer.allow_partial, false);
  check('offer_want', offer.want_amount, String(plan.requiredBForFull));
  check('offer_covenant_present', !!offer.covenant, true);
  const signed = seqob.__test__.signOffer({ ...offer }, priv);
  ok('offer_verifies', seqob.__test__.verifyOffer(signed), 'covenant offer must verify');
}

// --- end-to-end place -> matched -> FILL, mocking the relay + wasm -----------
// Proves the wiring covenant-order.place()/settleFill() drive, without a live
// relay: fund is mocked, the offer is captured, then a synthetic `matched` is fed
// back and the FILL recipe is verified + assembled by a mock buildCovenantFillTx.
{
  const assetA = bytesToHex(Uint8Array.from({length:32},(_,i)=>i));
  const assetB = bytesToHex(Uint8Array.from({length:32},(_,i)=>32+i));
  const makerProg = '33'.repeat(32), makerX = '44'.repeat(32);
  const params = {
    assetA, assetB, sellAtoms: 90n*100000000n,
    rateNum: 1, rateDen: 3, minLot: 90n*100000000n,
    expiryLocktime: 400, makerProg, makerX,
  };

  // -- place() drives derive -> fund -> post through injected hooks --
  let funded = null, posted = null;
  const placeHooks = {
    spkToAddress: async (spkHex) => 'ADDR:' + spkHex,
    fundToAddress: async (address, assetHex, atoms) => { funded = { address, assetHex, atoms }; return { txid: 'cd'.repeat(32), vout: 0 }; },
    postCovenantOffer: async (o) => { posted = o; return { ok: true }; },
  };
  const placed = await place(params, placeHooks);
  ok('place_funded_covenant', funded && funded.assetHex === assetA && funded.atoms === 90n*100000000n, funded && (funded.assetHex + ':' + funded.atoms));
  ok('place_address_from_spk', placed.address === 'ADDR:' + placed.plan.spkHex, placed.address);
  ok('place_posted_offer', !!posted && !!posted.covenant, 'posted covenant terms');

  // -- a synthetic Matched (this wallet is the taker) drives settleFill --
  const matched = {
    offer_id: 'o1', resting_is_covenant: true,
    covenant: placed.covenant,
    covenant_locked: String(90n*100000000n),
    fill_base_amount: String(90n*100000000n),
  };
  let builtRecipe = null;
  const fillHooks = {
    fetchUtxoSpk: async () => placed.plan.spkHex,       // the on-chain spk (anti-relay-lie check passes)
    buildCovenantFillTx: async (recipe) => { builtRecipe = recipe; return { rawHex: 'ff00', txid: 'ee'.repeat(32) }; },
    broadcast: async (rawHex) => 'ee'.repeat(32),
  };
  const res = await settleFill(matched, fillHooks);
  ok('settle_broadcast_txid', res.txid === 'ee'.repeat(32), res.txid);
  ok('settle_credit_asset', builtRecipe && builtRecipe.creditAsset === assetB, builtRecipe && builtRecipe.creditAsset);
  ok('settle_credit_prog', builtRecipe && builtRecipe.creditProg === makerProg, builtRecipe && builtRecipe.creditProg);
  check('settle_credit_value', builtRecipe && builtRecipe.creditValue, String(30n*100000000n));
  ok('settle_full_fill', builtRecipe && builtRecipe.partial === false, 'full fill has no remainder');

  // -- a tampered on-chain spk must abort the FILL (trustless verify) --
  let rejected = false;
  try {
    await settleFill(matched, { ...fillHooks, fetchUtxoSpk: async () => placed.plan.spkHex.slice(0,-2) + '00' });
  } catch { rejected = true; }
  ok('settle_rejects_tampered_spk', rejected, 'a lying relay spk must be refused');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
