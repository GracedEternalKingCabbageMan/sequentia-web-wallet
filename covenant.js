// ---------------------------------------------------------------------------
// SeqOB passive-CLOB covenant — the in-browser port of the proven FILL/REFUND
// primitive. It is byte-for-byte identical to:
//
//   • the audited Python builders  test/functional/seqob_covenant.py
//     (proven by feature_seqob_covenant_fill.py's 11 consensus scenarios), and
//   • the Go production module      seqdex/daemon/pkg/covenant  (leaf.go /
//     order.go / plan.go), which pins itself to that Python with golden vectors.
//
// covenant.test.mjs re-pins THIS file to the SAME golden vectors, so the wallet
// derives the exact covenant scriptPubKey + FILL witness the chain enforces.
//
// A maker locks N atoms of explicit asset A in ONE taproot UTXO ("the order is
// the coin"): internal key = NUMS (no key-path spend) and a two-leaf tree
// {FILL, REFUND}.
//
//   - FILL is permissionless (NO maker signature; witness = [leaf, control_block]
//     only). It enforces, entirely from transaction introspection, that the
//     covenant input at consensus index k credits the maker at output 2k
//     (asset == B, spk == maker_prog, value >= ceil(filled*num/den)) and, for a
//     partial fill, re-pays the remainder of asset A to the SAME covenant spk at
//     output 2k+1 (>= min_lot).
//   - REFUND is <expiry> CLTV DROP <maker_x> CHECKSIG: the maker reclaims after
//     the absolute-locktime expiry.
//
// Only pure JS + the wallet's already-bundled secp256k1/sha256 (btc.js) are used
// for the scriptPubKey + witness. The raw Elements FILL transaction that carries
// this witness is assembled + signed by the wasm host (see covenant-order.js).
// ---------------------------------------------------------------------------

import { schnorr, sha256 } from './btc.js';

// --- byte helpers -----------------------------------------------------------

export function bytesToHex(a){ let s=''; for (let i=0;i<a.length;i++) s += a[i].toString(16).padStart(2,'0'); return s; }
export function hexToBytes(h){
  if (h == null) return new Uint8Array(0);
  if (typeof h !== 'string') return Uint8Array.from(h);
  if (h.length % 2) throw new Error('odd hex length');
  const a = new Uint8Array(h.length/2);
  for (let i=0;i<a.length;i++) a[i] = parseInt(h.substr(i*2,2),16);
  return a;
}
function concat(...arrs){ let n=0; for (const a of arrs) n+=a.length; const out=new Uint8Array(n); let o=0; for (const a of arrs){ out.set(a,o); o+=a.length; } return out; }
function eq(a,b){ if (a.length!==b.length) return false; for (let i=0;i<a.length;i++) if (a[i]!==b[i]) return false; return true; }
// lexicographic byte compare, like Go bytes.Compare (returns <0,0,>0).
function cmp(a,b){ const n=Math.min(a.length,b.length); for (let i=0;i<n;i++){ if (a[i]!==b[i]) return a[i]-b[i]; } return a.length-b.length; }

function bytesToBigBE(b){ let n=0n; for (let i=0;i<b.length;i++) n=(n<<8n)|BigInt(b[i]); return n; }
function bigToBytesBE(n, len){ const out=new Uint8Array(len); for (let i=len-1;i>=0;i--){ out[i]=Number(n & 0xffn); n>>=8n; } return out; }

// --- constants (byte-identical to leaf.go / seqob_covenant.py) --------------

// BIP341 nothing-up-my-sleeve internal key: no known discrete log, so a
// NUMS-internal-key output has no key-path spend.
export const NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

// Elements/Sequentia LEAF_VERSION_TAPSCRIPT (Bitcoin uses 0xc0).
const LEAF_VERSION = 0xc4;

// Tapscript opcodes (on-wire bytes from the Sequentia test_framework script.py).
const OP_0 = 0x00, OP_1 = 0x51, OP_1NEGATE = 0x4f;
const OP_IF = 0x63, OP_ELSE = 0x67, OP_ENDIF = 0x68, OP_VERIFY = 0x69;
const OP_DROP = 0x75, OP_DUP = 0x76, OP_NIP = 0x77, OP_ROT = 0x7b, OP_SWAP = 0x7c;
const OP_EQUAL = 0x87, OP_EQUALVERIFY = 0x88, OP_1ADD = 0x8b, OP_ADD = 0x93, OP_LESSTHAN = 0x9f;
const OP_CHECKSIG = 0xac, OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_INSPECTINPUTVALUE = 0xc9, OP_INSPECTINPUTSCRIPTPUBKEY = 0xca;
const OP_PUSHCURRENTINPUTINDEX = 0xcd, OP_INSPECTOUTPUTASSET = 0xce;
const OP_INSPECTOUTPUTVALUE = 0xcf, OP_INSPECTOUTPUTSCRIPTPUBKEY = 0xd1;
const OP_INSPECTNUMOUTPUTS = 0xd5;
const OP_ADD64 = 0xd7, OP_SUB64 = 0xd8, OP_MUL64 = 0xd9, OP_DIV64 = 0xda, OP_GREATERTHANOREQUAL64 = 0xdf;

// The covenant input at consensus index k credits the maker at output 2k and
// re-pays its remainder at output 2k+1. Recomputed from OP_PUSHCURRENTINPUTINDEX
// each time (a single push), so the leaf carries no per-spend index state.
const CREDIT_IDX = [OP_PUSHCURRENTINPUTINDEX, OP_DUP, OP_ADD];          // 2k
const REM_IDX    = [OP_PUSHCURRENTINPUTINDEX, OP_DUP, OP_ADD, OP_1ADD]; // 2k+1

// --- CScript serialization (only the forms the leaves need) -----------------

class ScriptBuilder {
  constructor(){ this.b = []; }
  op(o){ this.b.push(o & 0xff); }
  ops(...o){ for (const x of o) this.b.push(x & 0xff); }
  raw(arr){ for (const x of arr) this.b.push(x & 0xff); }
  // Data push, exactly as CScriptOp.encode_op_pushdata: direct length prefix for
  // < 0x4c bytes (the only case the leaves need — 8-byte operands, 32-byte data).
  push(d){
    const n = d.length;
    if (n < 0x4c) this.b.push(n);
    else if (n <= 0xff) this.b.push(0x4c, n);
    else if (n <= 0xffff) this.b.push(0x4d, n & 0xff, (n>>8)&0xff);
    else this.b.push(0x4e, n&0xff, (n>>8)&0xff, (n>>16)&0xff, (n>>24)&0xff);
    for (let i=0;i<n;i++) this.b.push(d[i]);
  }
  // Signed integer push (CScript): OP_0 / OP_1..OP_16 / OP_1NEGATE, else a
  // minimally-encoded little-endian sign-magnitude push. Used for REFUND expiry.
  pushNum(n){
    n = BigInt(n);
    if (n === 0n) return this.op(OP_0);
    if (n >= 1n && n <= 16n) return this.op(OP_1 + Number(n) - 1);
    if (n === -1n) return this.op(OP_1NEGATE);
    this.push(bn2vch(n));
  }
  bytes(){ return Uint8Array.from(this.b); }
}

// Bitcoin little-endian sign-magnitude encoding.
function bn2vch(v){
  v = BigInt(v);
  if (v === 0n) return new Uint8Array(0);
  const neg = v < 0n;
  let av = neg ? -v : v;
  const out = [];
  while (av > 0n){ out.push(Number(av & 0xffn)); av >>= 8n; }
  if (out[out.length-1] & 0x80){ out.push(neg ? 0x80 : 0x00); }
  else if (neg){ out[out.length-1] |= 0x80; }
  return Uint8Array.from(out);
}

// 64-bit little-endian operand for the OP_*64 arithmetic opcodes.
function le8(n){ const out = new Uint8Array(8); let v = BigInt(n); for (let i=0;i<8;i++){ out[i]=Number(v & 0xffn); v>>=8n; } return out; }

// --- leaves -----------------------------------------------------------------

// buildFillLeaf: the permissionless FILL tapscript for one resting order.
// assetA/assetB are 32-byte INTERNAL-order asset ids; makerProg is the 32-byte
// v1-taproot maker credit witness program.
export function buildFillLeaf(assetA, assetB, rateNum, rateDen, minLot, makerProg, makerVer = 1){
  assetA = hexToBytes(assetA); assetB = hexToBytes(assetB); makerProg = hexToBytes(makerProg);
  rateNum = BigInt(rateNum); rateDen = BigInt(rateDen); minLot = BigInt(minLot);
  if (assetA.length !== 32 || assetB.length !== 32) throw new Error('assetA/assetB must be 32 bytes');
  if (rateNum < 1n || rateDen < 1n || minLot < 1n) throw new Error('rateNum, rateDen, minLot must be >= 1');
  if (makerVer !== 1) throw new Error('this builder pins a v1 taproot maker payout');
  if (makerProg.length !== 32) throw new Error('makerProg must be 32 bytes for a v1 taproot payout');

  const s = new ScriptBuilder();
  // locked = this covenant input's own value (must be explicit).
  s.ops(OP_PUSHCURRENTINPUTINDEX, OP_INSPECTINPUTVALUE);   // [locked8, prefix]
  s.ops(OP_1, OP_EQUALVERIFY);                             // [locked8]

  // remainder = asset A re-paid to output 2k+1 (0 for a full fill).
  s.raw(REM_IDX); s.ops(OP_INSPECTNUMOUTPUTS, OP_LESSTHAN); // [locked8, (2k+1 < numouts)]
  s.op(OP_IF);
    s.raw(REM_IDX); s.op(OP_INSPECTOUTPUTASSET);           // [locked8, asset32, prefix]
    s.ops(OP_1, OP_EQUALVERIFY);                           // explicit
    s.push(assetA); s.op(OP_EQUAL);                        // [locked8, isA]
    s.op(OP_IF);
      // asset A at 2k+1 -> remainder: self-replicate spk, floor, read value.
      s.raw(REM_IDX); s.op(OP_INSPECTOUTPUTSCRIPTPUBKEY);
      s.ops(OP_PUSHCURRENTINPUTINDEX, OP_INSPECTINPUTSCRIPTPUBKEY);
      s.ops(OP_ROT, OP_EQUALVERIFY, OP_EQUALVERIFY);       // outver==inver, outprog==inprog
      s.raw(REM_IDX); s.ops(OP_INSPECTOUTPUTVALUE, OP_1, OP_EQUALVERIFY); // [locked8, remainder8]
      s.op(OP_DUP); s.push(le8(minLot)); s.ops(OP_GREATERTHANOREQUAL64, OP_VERIFY);
    s.op(OP_ELSE);
      s.push(le8(0n));                                     // remainder = 0
    s.op(OP_ENDIF);
  s.op(OP_ELSE);
    s.push(le8(0n));                                       // full fill, remainder = 0
  s.op(OP_ENDIF);

  // filled = locked - remainder, floored by min_lot.
  s.ops(OP_SUB64, OP_VERIFY);
  s.op(OP_DUP); s.push(le8(minLot)); s.ops(OP_GREATERTHANOREQUAL64, OP_VERIFY);

  // required_B = ceil(filled*num/den) = floor((filled*num + den-1)/den).
  s.push(le8(rateNum)); s.ops(OP_MUL64, OP_VERIFY);
  s.push(le8(rateDen - 1n)); s.ops(OP_ADD64, OP_VERIFY);
  s.push(le8(rateDen)); s.ops(OP_DIV64, OP_VERIFY, OP_NIP);

  // credit output at 2k: asset == B, spk == maker, value >= required.
  s.raw(CREDIT_IDX); s.ops(OP_INSPECTOUTPUTASSET, OP_1, OP_EQUALVERIFY);
  s.push(assetB); s.op(OP_EQUALVERIFY);
  s.raw(CREDIT_IDX); s.ops(OP_INSPECTOUTPUTSCRIPTPUBKEY, OP_1, OP_EQUALVERIFY);
  s.push(makerProg); s.op(OP_EQUALVERIFY);
  s.raw(CREDIT_IDX); s.ops(OP_INSPECTOUTPUTVALUE, OP_1, OP_EQUALVERIFY);
  s.ops(OP_SWAP, OP_GREATERTHANOREQUAL64);
  return s.bytes();
}

// buildRefundLeaf: absolute-CLTV reclaim by the maker after expiry. makerX is the
// maker's 32-byte x-only pubkey.
export function buildRefundLeaf(expiryLocktime, makerX){
  makerX = hexToBytes(makerX);
  if (makerX.length !== 32) throw new Error('makerX must be 32 bytes');
  if (BigInt(expiryLocktime) < 0n) throw new Error('expiryLocktime must be >= 0');
  const s = new ScriptBuilder();
  s.pushNum(expiryLocktime);
  s.ops(OP_CHECKLOCKTIMEVERIFY, OP_DROP);
  s.push(makerX);
  s.op(OP_CHECKSIG);
  return s.bytes();
}

// --- tagged hashes / taproot ------------------------------------------------

const te = new TextEncoder();
function taggedHash(tag, ...data){
  const th = sha256(te.encode(tag));
  return sha256(concat(th, th, ...data));
}
function compactSize(n){
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n>>8)&0xff);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n&0xff, (n>>8)&0xff, (n>>16)&0xff, (n>>24)&0xff);
  const b = new Uint8Array(9); b[0]=0xff; let v=BigInt(n); for (let i=1;i<9;i++){ b[i]=Number(v&0xffn); v>>=8n; } return b;
}
function serString(b){ return concat(compactSize(b.length), b); }

// TapLeaf/elements over (leaf_version || ser_string(script)).
export function leafHash(script){ return taggedHash('TapLeaf/elements', Uint8Array.of(LEAF_VERSION), serString(script)); }

// BIP341 output-key tweak with the Elements TapTweak tag: lift internalX to its
// even-Y point P, Q = P + t*G where t = TapTweak/elements(internalX || root).
// Returns { outKey(32B x-only), negated(0|1) } — negated iff Q has odd Y.
function tweakOutputKey(internalX, root){
  const P = schnorr.utils.lift_x(bytesToBigBE(internalX));
  const tBytes = taggedHash('TapTweak/elements', internalX, root);
  const t = schnorr.Point.Fn.create(bytesToBigBE(tBytes));   // reduce mod n
  const Q = P.add(schnorr.Point.BASE.multiply(t));
  const { x, y } = Q.toAffine();
  return { outKey: bigToBytesBE(x, 32), negated: (y & 1n) ? 1 : 0 };
}

// --- Order / taptree --------------------------------------------------------

// deriveTaptree builds the {FILL, REFUND} taptree, Merkle root, tweaked output
// key, scriptPubKey, and the FILL control block — mirroring order_taptree /
// Order.Derive exactly (leaf order [fill, refund], TapBranch over the two leaf
// hashes sorted ascending, TapTweak/elements over internal_key||root).
export function deriveTaptree(order){
  const {
    assetA, assetB, rateNum, rateDen, makerProg, minLot,
    expiryLocktime, makerX,
  } = order;
  const makerVer = order.makerVer == null ? 1 : order.makerVer;
  const internalKey = order.internalKey ? hexToBytes(order.internalKey) : NUMS;

  const fill = buildFillLeaf(assetA, assetB, rateNum, rateDen, minLot, makerProg, makerVer);
  const refund = buildRefundLeaf(expiryLocktime, makerX);
  const fillH = leafHash(fill);
  const refundH = leafHash(refund);

  // BIP341 TapBranch inputs sorted ascending; the FILL leaf's merkle branch is
  // its only sibling — the REFUND leaf hash.
  let lo = fillH, hi = refundH;
  if (cmp(hi, lo) < 0){ const t = lo; lo = hi; hi = t; }
  const root = taggedHash('TapBranch/elements', lo, hi);

  const { outKey, negated } = tweakOutputKey(internalKey, root);
  const spk = concat(Uint8Array.of(OP_1, 0x20), outKey);

  const controlBlock = concat(Uint8Array.of(LEAF_VERSION + negated), internalKey, refundH);

  return {
    fillLeaf: fill, refundLeaf: refund,
    fillLeafHash: fillH, refundLeafHash: refundH,
    merkleRoot: root, merklePath: [refundH],
    outputKey: outKey, negated,
    scriptPubKey: spk,
    controlBlock,
    internalKey,
    // FILL is introspection-driven: witness is just [leaf, control_block].
    fillWitness: [fill, controlBlock],
  };
}

// verifyAgainstSPK is the trustless check a taker MUST run before filling: it
// re-derives the output key from the advertised constants and confirms it equals
// the on-chain scriptPubKey. It also rejects a non-NUMS internal key (a hidden
// maker key-path cancel/rug) unless makerCancellableOK is set.
export function verifyAgainstSPK(order, onchainSpk, makerCancellableOK = false){
  onchainSpk = hexToBytes(onchainSpk);
  const internalKey = order.internalKey ? hexToBytes(order.internalKey) : NUMS;
  if (!makerCancellableOK && !eq(internalKey, NUMS))
    throw new Error('non-NUMS internal key: order is maker-cancellable (key-path rug risk); reject unless explicitly allowed');
  const tap = deriveTaptree(order);
  if (!eq(tap.scriptPubKey, onchainSpk))
    throw new Error(`reconstructed spk ${bytesToHex(tap.scriptPubKey)} != on-chain spk ${bytesToHex(onchainSpk)}`);
  return tap;
}

// ceilPrice = required_B = ceil(filled * rateNum / rateDen), rounding in the
// maker's favour, matching the FILL leaf's on-chain arithmetic.
export function ceilPrice(filled, rateNum, rateDen){
  filled = BigInt(filled); rateNum = BigInt(rateNum); rateDen = BigInt(rateDen);
  return (filled * rateNum + rateDen - 1n) / rateDen;
}

// --- FILL plan --------------------------------------------------------------

// planFill computes the FILL recipe for taking `filled` atoms of asset A from a
// covenant UTXO holding `locked`, spent at consensus input index k. It enforces
// the covenant's own floors (filled >= min_lot; any remainder >= min_lot) so a
// plan the interpreter would reject is caught here, not on broadcast.
export function planFill(order, locked, filled, k){
  locked = BigInt(locked); filled = BigInt(filled); k = BigInt(k);
  const minLot = BigInt(order.minLot);
  if (filled === 0n || filled > locked) throw new Error(`filled ${filled} out of range (locked ${locked})`);
  if (filled < minLot) throw new Error(`filled ${filled} below min_lot ${minLot}`);
  const remainder = locked - filled;
  if (remainder !== 0n && remainder < minLot)
    throw new Error(`remainder ${remainder} below min_lot ${minLot} (would be dust-griefing)`);
  const tap = deriveTaptree(order);
  return {
    inputIndex: Number(k),
    creditIndex: Number(2n*k),
    remainderIndex: Number(2n*k + 1n),
    filled, remainder,
    requiredB: ceilPrice(filled, order.rateNum, order.rateDen),
    partial: remainder !== 0n,
    fillLeaf: tap.fillLeaf,
    controlBlock: tap.controlBlock,
    orderSpk: tap.scriptPubKey,
    witness: tap.fillWitness,      // [leaf, control_block]
    tap,
  };
}

export const __test__ = { bn2vch, le8, taggedHash, leafHash, tweakOutputKey, bytesToBigBE, bigToBytesBE };
