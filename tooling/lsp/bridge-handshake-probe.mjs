// bridge-handshake-probe.mjs — a LIVE proof harness for the reverse-maker bridge handshake.
//
// Drives runReverseBridgeTerms against a REAL `seqob-maker -mode cross -side buy` on the relay: the LSP
// hands the maker its OWN btc-claim pubkey, the maker locks a REAL on-chain BTC HTLC whose claim branch
// pays the LSP on the maker's H, and this harness parse-verifies + prints it (so an outer shell can
// xhtlc-observe / bitcoin-cli the funded output and confirm P2SH binding). It STOPS after XcBtcLegLocked —
// it funds/claims nothing — so the maker simply refunds its BTC HTLC after T_btc (no-loss). This proves
// the maker handshake end-to-end against the live fleet without needing the full taker coordination.
//
//   node bridge-handshake-probe.mjs -relay http://127.0.0.1:9955 -asset <hex> [-offer-id <id>]
//
// Prints one JSON object: { ok, offer_id, maker_pubkey, lsp_claim_pub, lsp_claim_priv, taker_seq_refund_pub,
//   hash_h, btc_htlc:{txid,vout,amount,redeem_script,cltv,refund_pub}, maker_seq_claim_pub, seq_locktime,
//   btc_amount, seq_amount } or { ok:false, error }.

import { setSeqobBase, fetchBook } from '../../seqob.js';
import { openReverseBridgeSession, runReverseBridgeTerms, newBridgeClaimKeypair, verifyMakerBtcHtlc } from './bridge-maker.mjs';

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

const relay = arg('-relay', 'http://127.0.0.1:9955');
const asset = arg('-asset', '');
const offerId = arg('-offer-id', '');

async function main() {
  if (!asset) throw new Error('need -asset <hex>');
  setSeqobBase(relay);
  const bk = await fetchBook(asset, 'BTC');
  const offers = (bk.offers || []).filter((o) => {
    const oa = o.offer_asset || o.offerAsset; return oa === 'BTC' && o._verified !== false;   // reverse: maker offers BTC for the asset
  });
  if (!offers.length) throw new Error(`no verified reverse (offer_asset=BTC) cross offer for ${asset}/BTC`);
  const offer = offerId ? offers.find((o) => (o.offer_id || o.offerId) === offerId) : offers[0];
  if (!offer) throw new Error(`offer ${offerId} not found among ${offers.length} reverse offers`);

  const wantAtoms = BigInt(offer.want_amount || offer.wantAmount || 0);   // asset atoms the taker sells
  const btcSats = Number(offer.offer_amount || offer.offerAmount || 0);   // sats the taker receives
  const lsp = newBridgeClaimKeypair();
  const takerSeqRefund = newBridgeClaimKeypair();   // stands in for the real taker's OWN asset-refund key

  const session = await openReverseBridgeSession({ offer, relayBase: relay, takeAtoms: wantAtoms });
  try {
    const r = await runReverseBridgeTerms({ session,
      lspBtcClaimPubHex: lsp.pubHex, takerSeqRefundPubHex: takerSeqRefund.pubHex,
      expect: { btcSats, seqAtoms: Number(wantAtoms) } });
    // Re-run the pure verify explicitly so the proof shows the fund-safety verdict on the REAL script.
    const v = verifyMakerBtcHtlc({ redeemScriptHex: r.btcHtlc.redeemScriptHex, hashHex: r.hashHex,
      lspClaimPubHex: lsp.pubHex, makerRefundPubHex: r.btcHtlc.refundPubHex, locktime: r.btcHtlc.cltv });
    console.log(JSON.stringify({ ok: true, verify: v,
      offer_id: offer.offer_id || offer.offerId, maker_pubkey: offer.maker_pubkey || offer.makerPubkey,
      lsp_claim_pub: lsp.pubHex, lsp_claim_priv: lsp.privHex, taker_seq_refund_pub: takerSeqRefund.pubHex,
      hash_h: r.hashHex,
      btc_htlc: { txid: r.btcHtlc.txid, vout: r.btcHtlc.vout, amount: r.btcHtlc.amount,
        redeem_script: r.btcHtlc.redeemScriptHex, cltv: r.btcHtlc.cltv, refund_pub: r.btcHtlc.refundPubHex },
      maker_seq_claim_pub: r.makerSeqClaimPubHex, seq_locktime: r.seqLocktime,
      btc_amount: r.btcAmount, seq_amount: r.seqAmount }, null, 2));
  } finally {
    try { session.close(); } catch {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); process.exit(1); });
