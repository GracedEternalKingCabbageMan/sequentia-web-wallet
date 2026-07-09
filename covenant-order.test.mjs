// Flow tests for the passive-CLOB order module: place-order derivation,
// CovenantTerms <-> Order round-trip, taker Matched -> FILL recipe (trustless
// verify + input-bound output map), and the covenant offer signing/verify.
//
// Run: node covenant-order.test.mjs

import { planPlaceOrder, buildCovenantTerms, orderFromCovenantTerms, planFillFromMatched, __test__ as covOrderTest } from './covenant-order.js';
import { deriveTaptree, bytesToHex } from './covenant.js';
import * as seqob from './seqob.js';
import { secp256k1 } from './btc.js';

let fails = 0;
function check(name, got, want){
  if (got !== want){ fails++; console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok   ${name}`);
}
function ok(name, cond, msg){ if (cond) console.log(`ok   ${name}`); else { fails++; console.error(`FAIL ${name}: ${msg||''}`); } }

// A concrete order: sell 90e8 of asset A, want B at 3/7.
const assetA = bytesToHex(Uint8Array.from({length:32},(_,i)=>i));
const assetB = bytesToHex(Uint8Array.from({length:32},(_,i)=>32+i));
const makerProg = '11'.repeat(32);   // wallet's v1-taproot payout program
const makerX = '22'.repeat(32);      // wallet key authorizing REFUND
const params = {
  assetA, assetB, sellAtoms: 90n*100000000n,
  rateNum: 3, rateDen: 7, minLot: 500000000,
  expiryLocktime: 400, makerProg, makerX,
};

// --- place-order derivation matches the golden covenant spk -----------------
const plan = planPlaceOrder(params);
check('place_spk', plan.spkHex, '5120b22544534c99090050a06eece12231a2321f4144661ab3964408d5780821afaa');
check('place_required_b_full', String(plan.requiredBForFull), String((90n*100000000n*3n+6n)/7n));

// --- CovenantTerms round-trip -----------------------------------------------
const ct = buildCovenantTerms(plan.order, 'ab'.repeat(32), 0, plan.tap);
check('ct_asset_a', ct.asset_a, assetA);
check('ct_rate', ct.rate_num + '/' + ct.rate_den, '3/7');
check('ct_maker_prog', ct.maker_prog, makerProg);
check('ct_internal_key', ct.internal_key, '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
check('ct_merkle_path', ct.merkle_path[0], bytesToHex(plan.tap.refundLeafHash));
const back = orderFromCovenantTerms(ct);
check('ct_roundtrip_spk', bytesToHex(deriveTaptree(back).scriptPubKey), plan.spkHex);

// --- taker Matched -> FILL recipe (full fill) -------------------------------
const onchainSpk = plan.spkHex;   // the funded UTXO's real spk
const matchedFull = {
  offer_id: 'o1', resting_is_covenant: true, covenant: ct,
  covenant_locked: String(90n*100000000n), fill_base_amount: String(90n*100000000n),
};
const recFull = planFillFromMatched(matchedFull, onchainSpk);
check('fill_credit_asset', recFull.creditAsset, assetB);
check('fill_credit_prog', recFull.creditProg, makerProg);
check('fill_credit_value', String(recFull.creditValue), String((90n*100000000n*3n+6n)/7n));
check('fill_partial', String(recFull.partial), 'false');
check('fill_remainder_value', String(recFull.remainderValue), '0');
check('fill_credit_idx', String(recFull.plan.creditIndex), '0');   // covenant is input 0
check('fill_witness_len', String(recFull.covenantWitness.length), '2');
check('fill_witness_leaf', recFull.covenantWitness[0], bytesToHex(plan.tap.fillLeaf));
check('fill_witness_ctrl', recFull.covenantWitness[1], bytesToHex(plan.tap.controlBlock));

// --- taker Matched -> FILL recipe (partial fill, self-replicating remainder) -
const matchedPart = {
  offer_id: 'o1', resting_is_covenant: true, covenant: ct,
  covenant_locked: String(90n*100000000n), fill_base_amount: String(30n*100000000n),
};
const recPart = planFillFromMatched(matchedPart, onchainSpk);
check('fill_part_partial', String(recPart.partial), 'true');
check('fill_part_remainder', String(recPart.remainderValue), String(60n*100000000n));
check('fill_part_rem_spk', recPart.remainderSpkHex, plan.spkHex);   // remainder re-pays the covenant
check('fill_part_rem_idx', String(recPart.plan.remainderIndex), '1');

// --- trustless verify rejects a tampered on-chain spk -----------------------
{
  const bad = plan.spkHex.slice(0,-2) + '00';
  let rejected = false; try { planFillFromMatched(matchedFull, bad); } catch { rejected = true; }
  check('fill_rejects_tampered_spk', String(rejected), 'true');
}
// --- non-covenant matched is refused ----------------------------------------
{
  let rejected = false; try { planFillFromMatched({ resting_is_covenant: false }, onchainSpk); } catch { rejected = true; }
  check('fill_rejects_non_covenant', String(rejected), 'true');
}

// --- covenant offer signs + verifies over the raw-bytes canonical form ------
{
  const priv = new Uint8Array(32); priv[31] = 7;
  const pub = seqob.bytesToHex(secp256k1.getPublicKey(priv, true));
  const offer = {
    offer_id: 'cov-1', schema_version: 1,
    pair: { base_asset: assetA, quote_asset: assetB },
    trade_dir: 'TRADE_DIR_SELL',
    offer_amount: String(90n*100000000n), offer_asset: assetA,
    want_amount: String(plan.requiredBForFull), want_asset: assetB,
    allow_partial: true, min_fill: String(params.minLot),
    maker_pubkey: pub, covenant: ct,
  };
  const signed = seqob.__test__.signOffer({ ...offer }, priv);
  ok('cov_offer_verifies', seqob.__test__.verifyOffer(signed), 'signature over covenant offer must verify');
  // The covenant field is load-bearing in the signature: mutating rate breaks it.
  const tampered = { ...signed, covenant: { ...ct, rate_num: '5' } };
  ok('cov_offer_tamper_detected', !seqob.__test__.verifyOffer(tampered), 'mutated covenant must fail verify');
}

// --- REFUND: planRefund derives the byte-exact reclaim recipe ---------------
{
  const refund = covOrderTest.planRefund(plan.order, { txid: 'cd'.repeat(32), vout: 1, locked: 90n*100000000n });
  // The reclaim prevout spk is the covenant scriptPubKey the FILL side also uses.
  check('refund_covenant_spk', refund.covenantSpkHex, plan.spkHex);
  check('refund_covenant_locked', refund.covenantLocked, String(90n*100000000n));
  check('refund_expiry', String(refund.expiryLocktime), '400');
  // The REFUND leaf is <expiry>CLTV DROP <maker_x> CHECKSIG (byte-exact vs leaf.go).
  check('refund_leaf', refund.refundLeafHex, '029001b175202222222222222222222222222222222222222222222222222222222222222222ac');
  // Its control block commits the sibling (FILL) leaf hash, NOT the refund hash.
  check('refund_control_block', refund.controlBlockHex,
    'c550929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac04d1a21f10826870560f07e69520416221c532fb8744bc0a0b2bf38032cd03343');
  // Maker-key agreement: the leaf's maker_x (last 32 bytes before CHECKSIG) equals
  // the order's makerX — the key the wasm helper signs the reclaim with.
  const leafMakerX = refund.refundLeafHex.slice(-66, -2);
  check('refund_leaf_maker_x_eq_order', leafMakerX, refund.makerX);
}

// --- mocked place -> cancel -> refund-broadcast (mature CLTV) ----------------
{
  const order = plan.order;
  const recipe = covOrderTest.planRefund(order, { txid: 'ef'.repeat(32), vout: 0, locked: 90n*100000000n });
  recipe.makerKeyPath = "m/86'/1'/0'/0/0";

  let delisted = false, built = null, broadcasted = null;
  const hooks = {
    relayCancel: async () => { delisted = true; },
    buildCovenantRefundTx: async (r) => { built = r; return { rawHex: 'aa'+'bb'.repeat(20), txid: 'refundtxid' }; },
    broadcast: async (hex) => { broadcasted = hex; return 'refundtxid'; },
  };
  // Matured (tip >= expiry): delist AND broadcast the REFUND.
  const outMature = await covOrderTest.cancel('off-1', { recipe, tipHeight: 401, expiryLocktime: 400 }, hooks);
  ok('cancel_mature_delisted', outMature.delisted === true, 'relay delist');
  ok('cancel_mature_matured', outMature.matured === true, 'tip >= expiry is matured');
  check('cancel_mature_refund_txid', outMature.refundTxid, 'refundtxid');
  ok('cancel_mature_broadcast', broadcasted !== null, 'refund tx broadcast');
  check('cancel_mature_recipe_spk', built.covenantSpkHex, plan.spkHex);

  // Immature (tip < expiry): delist only, surface reclaimable-after-expiry.
  delisted = false; broadcasted = null;
  const outImm = await covOrderTest.cancel('off-2', { recipe, tipHeight: 100, expiryLocktime: 400 }, hooks);
  ok('cancel_immature_delisted', outImm.delisted === true, 'relay delist still happens');
  ok('cancel_immature_not_matured', outImm.matured === false, 'tip < expiry not matured');
  ok('cancel_immature_no_broadcast', broadcasted === null && outImm.refundTxid === null, 'no on-chain refund pre-expiry');
  check('cancel_immature_reclaim_after', String(outImm.reclaimable && outImm.reclaimable.afterHeight), '400');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
