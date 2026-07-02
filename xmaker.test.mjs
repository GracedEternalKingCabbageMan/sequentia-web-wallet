// Headless node test for xmaker.js (the cross-chain MAKER forward driver).
// Drives RunMakerForward through a full forward settlement with a scripted taker
// (fake CourierSession) and fake leg ops (fake C), asserting the maker: sends
// per-lift terms, verifies the taker's BTC leg by re-derived redeem, locks the
// SEQ leg with claim=taker, announces it, learns the secret off-chain, and claims
// the BTC leg with that secret. No DOM, no relay, no chain. Run: node xmaker.test.mjs
import { __test__, RunMakerForward, initXmaker } from './xmaker.js';

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++; } else console.log('ok:', m); };
const { sha256Hex, setC } = __test__;

// secret/hashlock the "taker" will use.
const secret = 'cc'.repeat(32);
const hashH = sha256Hex(secret);

// deterministic fake HTLC redeem so the maker's re-derivation is checkable.
const redeem = (h, claim, refund, lock) => `redeem:${h}:${claim}:${refund}:${lock}`;

const offer = {
  pair: { base_asset: 'GOLDHEX', quote_asset: 'BTC' },
  offer_amount: '5000000', want_amount: '25000', base_amount: '5000000',
  cross_chain: { direction: 0 },
};
const takerSeqClaimPub  = '03takerSeqClaim';
const takerBtcRefundPub = '03takerBtcRefund';

// captured calls
let fundCall = null, claimCall = null;
const fakeC = {
  SEQOB: '/seqob',
  btcTip: async () => 142500,
  seqTip: async () => 16500,                 // stays < seqLocktime (16740) so no refund path
  readPreimage: async (_txid, _vout, h) => (h.toLowerCase() === hashH.toLowerCase() ? secret : null),
  wasm: { buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeem(h, claim, ref, lock) },
  btcLeg: {
    claimKey: () => ({ public_key: '02makerBtcClaim', secret_hex: 'aa'.repeat(32) }),
    findFunding: async (_txid, _redeem) => ({ vout: 0, value: 25000, confirmed: true, height: 142600 }),
    claim: async (args) => { claimCall = args; return 'btc_claim_txid'; },
  },
  seqLeg: {
    refundKey: () => ({ public_key: '02makerSeqRefund', secret_hex: 'bb'.repeat(32) }),
    fund: async (r, asset, amount) => { fundCall = { r, asset, amount }; return { txid: 'seq_fund_txid' }; },
    waitConf: async (_txid, _redeem) => ({ vout: 0, height: 16700, block_hash: 'seqblk' }),
    refund: async () => 'seq_refund_txid',
  },
};
initXmaker(fakeC); setC(fakeC);

// The BTC leg the taker "funded": its redeem must be the maker's re-derivation
// (claim=maker btc claim, refund=taker btc refund, T_btc = btcTip+100 = 142600).
const btcLegRedeem = redeem(hashH, '02makerBtcClaim', takerBtcRefundPub, 142600);
const scripted = [
  { type: 'terms_request' },
  { type: 'btc_leg_funded', hash_h: hashH, taker_seq_claim_pub: takerSeqClaimPub, taker_btc_refund_pub: takerBtcRefundPub,
    leg: { txid: 'taker_btc_txid', vout: 0, amount: 25000, redeem_script: btcLegRedeem, locktime: 142600, height: 142590 } },
];
let si = 0;
const sent = [];
const session = {
  send: async (m) => { sent.push(m); },
  recv: async (wantType) => {
    const m = scripted[si++];
    if (!m) throw new Error('no more scripted msgs (want ' + wantType + ')');
    if (m.type !== wantType) throw new Error(`maker asked for ${wantType} but next scripted is ${m.type}`);
    return m;
  },
  fail: async (code, message) => { sent.push({ type: 'fail', code, message }); },
  close: () => {},
};

const res = await RunMakerForward(session, { sessionId: 'sessM', offerId: 'offM', takeAmount: 5000000n }, offer);

// 1. Terms sent with the maker's per-lift claim pub + tip-derived locktimes.
const terms = sent.find(m => m.type === 'terms');
ok(terms && terms.maker_btc_claim_pub === '02makerBtcClaim' && terms.maker_refund_pub === '02makerSeqRefund', 'maker sends terms with its BTC-claim + SEQ-refund pubs');
ok(terms && terms.btc_locktime === 142600 && terms.seq_locktime === 16740, 'locktimes = tips + deltas (btc 142600, seq 16740); T_seq < T_btc');
ok(terms && terms.btc_amount === 25000 && terms.seq_amount === 5000000, 'terms carry the offer amounts');

// 2. SEQ leg funded with claim=taker, refund=maker, T_seq — the maker locks the asset.
ok(fundCall && fundCall.asset === 'GOLDHEX' && fundCall.amount === 5000000n, 'maker funds the SEQ asset leg for the offer size');
ok(fundCall && fundCall.r === redeem(hashH, takerSeqClaimPub, '02makerSeqRefund', 16740), 'SEQ leg redeem binds claim=taker, refund=maker, T_seq');

// 3. SeqLegLocked announced with the funded leg.
const locked = sent.find(m => m.type === 'seq_leg_locked');
ok(locked && locked.leg.txid === 'seq_fund_txid' && locked.leg.anchor_height === 16700, 'maker announces seq_leg_locked');

// 4. Maker learned s and claimed the BTC leg WITH that secret -> settled.
ok(claimCall && claimCall.preimage === secret && claimCall.txid === 'taker_btc_txid', 'maker claims the taker BTC leg with the revealed secret');
ok(res && res.settled === true && res.btc_claim_txid === 'btc_claim_txid', 'RunMakerForward reports settled');

// 5. No XcFail was sent on the happy path.
ok(!sent.some(m => m.type === 'fail'), 'no XcFail on the happy path');

// ===========================================================================
// REVERSE maker: maker funds BTC first + holds the secret, verifies the taker's
// asset leg + self-derived anchor gate, then claims the asset REVEALING s.
// ===========================================================================
const { RunMakerReverse } = __test__;
const secretR = 'dd'.repeat(32);
const hashR = sha256Hex(secretR);
const offerR = {
  pair: { base_asset: 'GOLDHEX', quote_asset: 'BTC' },
  offer_asset: 'BTC', offer_amount: '25000',      // maker pays BTC
  want_asset: 'GOLDHEX', want_amount: '5000000',  // maker wants the asset
  base_amount: '5000000', cross_chain: { direction: 1 },
};
const takerSeqRefundPub = '03takerSeqRefund', takerBtcClaimPub = '03takerBtcClaim';
let rFund = null, rClaim = null;
const fakeCR = {
  SEQOB: '/seqob',
  btcTip: async () => 142500, seqTip: async () => 16500,
  anchorHeightOf: async (_h) => 142600,   // >= Hp (142600) -> gate passes
  anchorStatusOk: async () => true,
  posCertifiedOf: async (_h) => true,     // quorum-certified -> gate passes
  wasm: {
    buildSeqHtlcRedeemScript: (h, claim, ref, lock) => redeem(h, claim, ref, lock),
    generateSwapSecret: () => ({ secret_hex: secretR, hash_hex: hashR }),
  },
  signer: { htlcKeypair: () => ({ public_key: '02makerSeqClaim', secret_hex: 'ee'.repeat(32) }) },
  btcLeg: {
    refundKey: () => ({ public_key: '02makerBtcRefund', secret_hex: 'ff'.repeat(32) }),
    fund: async (r, amount, locktime, _refund) => { rFund = { r, amount, locktime }; return { txid: 'maker_btc_txid', vout: 0, height: 142600, amount }; },
    findFunding: async () => ({ confirmed: true, height: 142600 }),
    refund: async () => 'btc_refund_txid',
  },
  seqLeg: {
    waitConf: async (_txid, _redeem) => ({ vout: 0, height: 16700, block_hash: 'seqblkR' }),
    readOutput: async (_txid, _vout) => ({ value: 5000000n, asset: 'GOLDHEX' }),
    claim: async (args) => { rClaim = args; return 'seq_claim_txid'; },
  },
};
initXmaker(fakeCR); __test__.setC(fakeCR);

const scriptedR = [
  { type: 'terms_request', taker_seq_refund_pub: takerSeqRefundPub, taker_btc_claim_pub: takerBtcClaimPub },
  { type: 'seq_leg_funded', leg: { txid: 'taker_seq_txid', vout: 0, amount: 5000000, asset: 'GOLDHEX', block_hash: 'seqblkR', anchor_height: 142600 } },
];
let sriR = 0; const sentR = [];
const sessionR = {
  send: async (m) => { sentR.push(m); },
  recv: async (wantType) => { const m = scriptedR[sriR++]; if (!m) throw new Error('no more scripted (want '+wantType+')'); if (m.type !== wantType) throw new Error(`want ${wantType} got ${m.type}`); return m; },
  fail: async (code, message) => { sentR.push({ type: 'fail', code, message }); },
  close: () => {},
};
const resR = await RunMakerReverse(sessionR, { sessionId: 'sessR', offerId: 'offR', takeAmount: 5000000n }, offerR);

const btcLocked = sentR.find(m => m.type === 'btc_leg_locked');
ok(btcLocked && btcLocked.hash_h === hashR && btcLocked.maker_seq_claim_pub === '02makerSeqClaim', 'reverse: maker sends btc_leg_locked with hash + its SEQ-claim pub');
ok(btcLocked && btcLocked.seq_locktime === 16740 && btcLocked.btc_amount === 25000 && btcLocked.seq_amount === 5000000, 'reverse: btc_leg_locked carries terms (T_seq 16740, amounts)');
ok(rFund && rFund.r === redeem(hashR, takerBtcClaimPub, '02makerBtcRefund', 142600) && rFund.amount === 25000, 'reverse: maker funds BTC leg claim=taker, refund=maker, T_btc');
ok(rClaim && rClaim.claim_secret === 'ee'.repeat(32) && rClaim.secret_hex === secretR, 'reverse: maker claims the asset leg with its claim key, revealing the secret');
const revealed = sentR.find(m => m.type === 'secret_revealed');
ok(revealed && revealed.preimage === secretR, 'reverse: maker sends secret_revealed');
ok(resR && resR.settled === true && resR.seq_claim_txid === 'seq_claim_txid', 'reverse: RunMakerReverse reports settled');
ok(!sentR.some(m => m.type === 'fail'), 'reverse: no XcFail on the happy path');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
