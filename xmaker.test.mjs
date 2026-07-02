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

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
