// Byte-match test: the wallet's in-browser covenant derivation MUST equal the
// PROVEN Go/Python golden vector (seqdex/daemon/pkg/covenant/leaf_test.go, which
// pins itself to test/functional/seqob_covenant.py). Same constants -> same FILL
// leaf, REFUND leaf, leaf hashes, merkle root, tweaked output key, scriptPubKey,
// control block, and FILL witness. If this passes, the wallet produces exactly
// the covenant the chain interpreter enforces.
//
// Run: node covenant.test.mjs

import {
  buildFillLeaf, buildRefundLeaf, leafHash, deriveTaptree, verifyAgainstSPK,
  planFill, ceilPrice, bytesToHex, hexToBytes, NUMS,
} from './covenant.js';

// Golden vector — fixedOrder() in leaf_test.go:
//   asset_a = bytes(range(0,32)); asset_b = bytes(range(32,64))
//   rate_num=3, rate_den=7, min_lot=500000000
//   maker_prog = 0x11*32, expiry=400, maker_x = 0x22*32, internal_key = NUMS
const GOLD = {
  fillLeaf:   'cdc95188cd76938bd59f63cd76938bce518820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f8763cd76938bd1cdca7b8888cd76938bcf518876080065cd1d00000000df6967080000000000000000686708000000000000000068d86976080065cd1d00000000df69080300000000000000d969080600000000000000d769080700000000000000da6977cd7693ce518820202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f88cd7693d1518820111111111111111111111111111111111111111111111111111111111111111188cd7693cf51887cdf',
  refundLeaf: '029001b175202222222222222222222222222222222222222222222222222222222222222222ac',
  fillHash:   '4d1a21f10826870560f07e69520416221c532fb8744bc0a0b2bf38032cd03343',
  refundHash: 'b36045e27b7a5812d8d7339811db86ef98751c7e382a84a1d34949a83b4ae920',
  merkleRoot: '224a2849e4419e6a81593dad51e14766083c08e31081f0aecaea3d1dc7daf3c3',
  outputKey:  'b22544534c99090050a06eece12231a2321f4144661ab3964408d5780821afaa',
  spk:        '5120b22544534c99090050a06eece12231a2321f4144661ab3964408d5780821afaa',
  negflag:    1,
  ctrlBlock:  'c550929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0b36045e27b7a5812d8d7339811db86ef98751c7e382a84a1d34949a83b4ae920',
};

function fixedOrder(){
  const a = new Uint8Array(32), b = new Uint8Array(32), mx = new Uint8Array(32).fill(0x22), prog = new Uint8Array(32).fill(0x11);
  for (let i=0;i<32;i++){ a[i]=i; b[i]=32+i; }
  return { assetA:a, assetB:b, rateNum:3n, rateDen:7n, minLot:500000000n, makerProg:prog, makerVer:1, expiryLocktime:400, makerX:mx };
}

let fails = 0;
function check(name, got, want){
  if (got !== want){ fails++; console.error(`FAIL ${name}\n  got  ${got}\n  want ${want}`); }
  else console.log(`ok   ${name}`);
}

const o = fixedOrder();

check('fill_leaf',   bytesToHex(buildFillLeaf(o.assetA,o.assetB,o.rateNum,o.rateDen,o.minLot,o.makerProg,o.makerVer)), GOLD.fillLeaf);
check('refund_leaf', bytesToHex(buildRefundLeaf(o.expiryLocktime,o.makerX)), GOLD.refundLeaf);

const tap = deriveTaptree(o);
check('fill_hash',    bytesToHex(tap.fillLeafHash), GOLD.fillHash);
check('refund_hash',  bytesToHex(tap.refundLeafHash), GOLD.refundHash);
check('merkle_root',  bytesToHex(tap.merkleRoot), GOLD.merkleRoot);
check('merkle_path',  bytesToHex(tap.merklePath[0]), GOLD.refundHash);   // FILL branch == REFUND hash
check('output_key',   bytesToHex(tap.outputKey), GOLD.outputKey);
check('scriptpubkey', bytesToHex(tap.scriptPubKey), GOLD.spk);
check('negflag',      String(tap.negated), String(GOLD.negflag));
check('control_block',bytesToHex(tap.controlBlock), GOLD.ctrlBlock);
// The FILL witness the covenant input carries on-chain: [leaf, control_block].
check('fill_witness_leaf', bytesToHex(tap.fillWitness[0]), GOLD.fillLeaf);
check('fill_witness_ctrl', bytesToHex(tap.fillWitness[1]), GOLD.ctrlBlock);

// verifyAgainstSPK accepts the correct spk and rejects a tampered one.
try { verifyAgainstSPK(o, GOLD.spk); console.log('ok   verify_accepts_correct_spk'); }
catch (e){ fails++; console.error('FAIL verify_accepts_correct_spk:', e.message); }
{
  const bad = hexToBytes(GOLD.spk); bad[bad.length-1] ^= 0x01;
  let rejected = false; try { verifyAgainstSPK(o, bad); } catch { rejected = true; }
  check('verify_rejects_tampered_spk', String(rejected), 'true');
}
// A non-NUMS internal key is rejected unless explicitly allowed.
{
  const o2 = { ...o, internalKey: o.makerX };  // any non-NUMS x-only
  let rejected = false; try { verifyAgainstSPK(o2, GOLD.spk); } catch { rejected = true; }
  check('verify_rejects_non_nums_key', String(rejected), 'true');
}

// ceilPrice matches the on-chain arithmetic (leaf_test.go TestCeilPrice).
check('ceil_exact', String(ceilPrice(90,1,3)), '30');
check('ceil_roundup', String(ceilPrice(10,1,3)), '4');

// planFill index map + amounts (plan_test.go TestPlanFillFullAndPartial).
{
  const locked = 90n*100000000n;
  const full = planFill(o, locked, locked, 1);
  check('plan_full_credit_idx', String(full.creditIndex), '2');
  check('plan_full_rem_idx', String(full.remainderIndex), '3');
  check('plan_full_partial', String(full.partial), 'false');
  check('plan_full_required_b', String(full.requiredB), String(ceilPrice(locked,3,7)));
  const part = planFill(o, locked, 30n*100000000n, 0);
  check('plan_part_partial', String(part.partial), 'true');
  check('plan_part_remainder', String(part.remainder), String(60n*100000000n));
  check('plan_part_credit_idx', String(part.creditIndex), '0');
  // covenant floors rejected below min_lot.
  let below = false; try { planFill(o, locked, 100000000n, 0); } catch { below = true; }
  check('plan_rejects_below_minlot', String(below), 'true');
  let remBad = false; try { planFill(o, locked, locked - 2n*100000000n, 0); } catch { remBad = true; }
  check('plan_rejects_rem_below_minlot', String(remBad), 'true');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
