// bridge-taker-harness.mjs — plays the TAKER of a rail-crossing bridged SELL, end to end, to PROVE the
// LSP leg-bridge settles both sides under one H. It is the taker side ONLY: it funds its OWN asset HTLC
// with its OWN key (seqob-cli xfund-seq), registers its OWN BTC-LN hold, settles it with the P it reads
// off-chain, and never gives the LSP a claim/refund secret. The LSP is driven purely over its HTTP API.
//
//   node bridge-taker-harness.mjs
//
// Flow: keygen taker refund key -> POST /swap (bridge sell) -> read H + maker asset-claim pub + T_seq from
// bridge_terms -> xfund-seq (fund the asset HTLC claim=maker, refund=us) -> holdinvoice on H at our BTC-LN
// node -> POST /bridge/asset (LSP relays it; the maker claims the asset, revealing P) -> read P from our
// asset HTLC's on-chain claim -> holdinvoicesettle (we receive the BTC-LN) -> poll until the LSP recoups.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setSeqobBase, fetchBook } from '../../seqob.js';

const LSP = 'http://127.0.0.1:9981';
const TOKEN = 'b5b1-d848ec96d29c01d2ff1db6cf';
const RELAY = 'http://127.0.0.1:9955';
const ASSET = 'c8eccacf0953e1931cd31e434d8319101cc36e6c38b0e2104d8687552fae3e40';
const SEQOB = '/root/sequentia/seqdex/bin/seqob-cli';
const LNCLI = '/root/sequentia/seqln/cli/lightning-cli';
const TAKER_LN = ['--lightning-dir=/root/sequentia/lsp/btc-maker', '--network=testnet4'];   // the taker's OWN BTC-LN node
const SEQ_RPC = 'http://seq:seq@127.0.0.1:18300';
const TAKER_SEQ_WALLET = 'bridge-taker';
const SEQ_RPC_FOR_OBSERVE = 'http://seq:seq@127.0.0.1:18300';
const BTC_RPC = 'http://seq:seq@127.0.0.1:48332';   // testnet4 node — poll the maker's BTC HTLC confirmations

const sha256 = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(bin, args, timeout = 300000) {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout, maxBuffer: 8 << 20 }, (e, o, er) => e ? reject(new Error((er || e.message || '').trim())) : resolve(o.trim())));
}
async function http(method, path, body) {
  const r = await fetch(LSP + path, { method, headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _raw: t }; }
  return j;
}
const log = (...a) => console.log('[taker]', ...a);
async function btcConfs(txid) {
  const u = new URL(BTC_RPC);
  const r = await fetch(`${u.protocol}//${u.host}/`, { method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64'), 'content-type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '1.0', method: 'getrawtransaction', params: [txid, true] }) });
  const j = await r.json().catch(() => ({}));
  return (j && j.result && j.result.confirmations) || 0;
}

async function main() {
  // 0. Mint the taker's OWN asset-refund keypair (never shared with the LSP as a secret; only the pubkey is).
  const kg = await run(SEQOB, ['keygen']);
  const takerPriv = kg.match(/priv\s+([0-9a-f]{64})/)[1];
  const takerPub = kg.match(/pub\s+([0-9a-f]{66})/)[1];
  log('taker asset-refund key pub', takerPub);

  // 1-3. Pick a resting REVERSE cross offer (maker offers BTC for the asset -> we SELL, receive BTC) and
  // run the handshake, trying the next maker if one is busy (whole-HTLC, one lift at a time).
  setSeqobBase(RELAY);
  const bk = await fetchBook(ASSET, 'BTC');
  const reverse = (bk.offers || []).filter((o) => (o.offer_asset || o.offerAsset) === 'BTC' && o._verified !== false);
  if (!reverse.length) throw new Error('no verified reverse cross offer');
  log(reverse.length, 'reverse offers resting');
  let jobId = null, terms = null, seqAtoms = 0, btcSats = 0, offerId = null;
  for (const offer of reverse) {
    offerId = offer.offer_id || offer.offerId; const makerPub = offer.maker_pubkey || offer.makerPubkey;
    seqAtoms = Number(offer.want_amount || offer.wantAmount);   // asset atoms we sell
    btcSats = Number(offer.offer_amount || offer.offerAmount);  // sats we receive
    const started = await http('POST', '/swap', { side: 'sell', bridge: true, payRail: 'chain', recvRail: 'ln',
      maker_btc_rail: 'chain', maker_asset_rail: 'chain', taker_btc_inbound: true, asset: ASSET,
      offer_id: offerId, maker_pubkey: makerPub, btc_sats: btcSats, asset_atoms: seqAtoms,
      taker_seq_refund_pub: takerPub, swap_nonce: 'bridge-full-' + Date.now() });
    if (!started.job_id) { log('offer', offerId, 'POST rejected:', started.error); continue; }
    let failed = false;
    for (let i = 0; i < 30 && !terms && !failed; i++) {
      await sleep(1500); const j = await http('GET', '/swap/' + started.job_id);
      if (j.bridge_terms && j.bridge_terms.hash_h) { terms = j.bridge_terms; jobId = started.job_id; }
      else if (j.bridgeHandshake && j.bridgeHandshake.ok === false) { failed = true; log('offer', offerId, 'handshake:', j.bridgeHandshake.error); }
    }
    if (terms) { log('offer', offerId, 'sell', seqAtoms, 'atoms for', btcSats, 'sats -> job', jobId); break; }
  }
  if (!terms) throw new Error('no free maker completed the handshake (all busy?)');
  const H = terms.hash_h;
  log('handshake OK. H=', H, '| maker BTC HTLC', terms.btc_htlc_txid, '| T_seq', terms.seq_locktime, '| maker asset-claim', terms.maker_seq_claim_pub);

  // 3.5 ANCHOR ORDERING: WAIT for the maker's BTC HTLC to confirm BEFORE funding our asset, so our asset's
  //     SEQ block anchors AT/ABOVE the maker's BTC-leg height (the maker's VerifySeqLegSafe gate). Funding
  //     earlier lets the fast SEQ chain anchor the asset BELOW the slow testnet4 BTC leg — the maker can then
  //     never safely claim. This is exactly what the maker code expects (the taker "waits for OUR confirmation
  //     first"); the relay session's 3h cross-chain deadline covers this wait.
  log('waiting for the maker BTC HTLC to confirm before funding the asset (anchor ordering)...');
  {
    let confd = 0;
    for (let i = 0; i < 300 && confd < 1; i++) {
      confd = await btcConfs(terms.btc_htlc_txid).catch(() => 0);
      if (confd >= 1) break;
      if (i % 4 === 0) log('  maker BTC HTLC still 0-conf...', i * 15, 's');
      await sleep(15000);
    }
    if (confd < 1) throw new Error('maker BTC HTLC never confirmed within the wait — abort before funding (no asset committed, no loss)');
    log('maker BTC HTLC confirmed (', confd, 'conf) — funding the asset now so it anchors above the BTC leg');
  }

  // 4. Fund our OWN asset HTLC (claim = the maker's pub with P, refund = OUR key after T_seq), self-custody.
  //    -no-wait: return at 0-conf so we relay the leg to the maker IMMEDIATELY (step 6), before the LSP's
  //    courier session idles through a SEQ block and drops the relay (the maker polls until the leg confirms).
  const fundOut = await run(SEQOB, ['xfund-seq', '-asset', ASSET, '-maker-claim-pub', terms.maker_seq_claim_pub,
    '-hash', H, '-seq-amount', String(seqAtoms), '-seq-locktime', String(terms.seq_locktime),
    '-seq-rpc', SEQ_RPC, '-seq-wallet', TAKER_SEQ_WALLET, '-refund-priv', takerPriv, '-no-wait'], 300000);
  const fund = JSON.parse(fundOut);
  log('asset HTLC funded (self-custody, 0-conf):', fund.seq_htlc_txid, 'vout', fund.seq_htlc_vout, 'block', fund.block_hash || '(0-conf; maker polls to confirm)');

  // Persist the asset-refund material (the taker's refund KEY + HTLC params) so a crash or a
  // failed settle never strands the tSEQ. seqob-cli xrefund-seq reads this xsellState shape and
  // reclaims the leg after T_seq. Before this, takerPriv was minted in-memory and only its pubkey
  // logged, so a stalled run (e.g. final8) stranded its tSEQ with the refund key gone forever.
  const recoveryFile = `/tmp/bridge-taker-recovery-${jobId.slice(0, 8)}.json`;
  writeFileSync(recoveryFile, JSON.stringify({
    created_at: new Date().toISOString(), asset: ASSET, seq_amount: seqAtoms,
    seq_refund_priv_hex: takerPriv, seq_leg_txid: fund.seq_htlc_txid, seq_leg_vout: fund.seq_htlc_vout,
    seq_leg_amount: fund.amount, seq_leg_asset: ASSET, seq_leg_script_hex: fund.redeem_script,
    seq_locktime: terms.seq_locktime, status: 'seq_locked',
  }, null, 2), { mode: 0o600 });
  log(`asset-refund material persisted -> ${recoveryFile} (if this run strands, reclaim after SEQ height ${terms.seq_locktime}: seqob-cli xrefund-seq -state-file ${recoveryFile} -seq-rpc <url> -seq-wallet ${TAKER_SEQ_WALLET} -wait)`);

  // 5. Register a hold on H at OUR BTC-LN node (bare-hash; the seqln holdinvoice has no bolt11). The LSP
  // pays it by routing to our node id + sendpay on H; we settle it with P.
  const label = 'bridge-recv-' + jobId.slice(0, 8);
  // Expiry must comfortably exceed the maker's anchor-gate latency (confirm the BTC HTLC, then wait for a SEQ
  // block anchored ABOVE it) PLUS any Bitcoin reorg recovery — otherwise the hold lapses before P arrives and
  // the swap fails no-loss but never settles. 2h stays well inside the maker's btc/seq locktime deltas.
  await run(LNCLI, [...TAKER_LN, 'holdinvoice', H, String(btcSats * 1000), label, 'bridge BTC receive', '7200']);
  const takerNodeId = JSON.parse(await run(LNCLI, [...TAKER_LN, 'getinfo'])).id;
  log('BTC-LN hold on H registered at our node', takerNodeId);

  // 6. Hand the funded asset leg + our node id to the LSP -> it relays to the maker (maker claims -> P).
  const relayResp = await http('POST', '/bridge/asset', { job_id: jobId, recv_node_id: takerNodeId,
    taker_seq_leg: { txid: fund.seq_htlc_txid, vout: fund.seq_htlc_vout, amount: fund.amount,
      redeem_script: fund.redeem_script, locktime: terms.seq_locktime, asset: ASSET, block_hash: fund.block_hash } });
  log('POST /bridge/asset ->', JSON.stringify(relayResp));
  if (!relayResp.ok) throw new Error('bridge/asset rejected: ' + relayResp.error);

  // 7. Watch OUR asset HTLC for the maker's claim (it reveals P on-chain). This spans the maker's anchor gate:
  // the maker will not claim until our asset HTLC is anchored ABOVE its confirmed BTC HTLC (Bitcoin-anchoring
  // supremacy), which is BTC-block-gated and, during a testnet4 reorg, spans a full cross-chain reorg recovery.
  // 75 min of patience keeps a normal anchor wait (and a modest reorg) from tripping a premature no-P failure.
  let P = null;
  for (let i = 0; i < 900 && !P; i++) {
    await sleep(5000);
    try {
      const o = JSON.parse(await run(SEQOB, ['xhtlc-observe', '-rpc', SEQ_RPC_FOR_OBSERVE, '-txid', fund.seq_htlc_txid, '-vout', String(fund.seq_htlc_vout), '-hash', H]));
      if (o.spent) log('  asset HTLC spent by the maker:', o.spender_txid, o.preimage ? '(P revealed)' : '(reading P...)');
      if (o.preimage) P = o.preimage;
    } catch (e) { /* transient */ }
    if (i % 6 === 0) log('  waiting for the maker to claim the asset (anchor gate)...', i * 5, 's');
  }
  if (!P) throw new Error('maker never claimed the asset HTLC (no P) within the wait');
  log('P revealed by the maker:', P, '| sha256(P)==H ?', sha256(P) === H);
  if (sha256(P) !== H) throw new Error('sha256(P) != H — refuse to settle');

  // 8. Wait for the LSP's payment to be HELD (accepted) at our node, then settle with P -> we RECEIVE BTC-LN.
  for (let i = 0; i < 120; i++) {
    try { const l = JSON.parse(await run(LNCLI, [...TAKER_LN, 'holdinvoicelookup', H])); if (l.state === 'accepted' || l.state === 'settled') { log('  hold state', l.state); break; } } catch {}
    await sleep(2000);
  }
  try { await run(LNCLI, [...TAKER_LN, 'holdinvoicesettle', H, P]); log('BTC-LN hold SETTLED with P — taker received BTC over Lightning'); }
  catch (e) { log('holdinvoicesettle:', e.message, '(may already be settled by the pay resolving)'); }

  // 9. Poll until the LSP recoups (claims the maker's BTC HTLC with P).
  let fin = null;
  for (let i = 0; i < 60; i++) { await sleep(4000); const j = await http('GET', '/swap/' + jobId); fin = j; if (j.status === 'settled' || j.status === 'failed') break; }
  log('FINAL job status:', fin.status, '| legs:', JSON.stringify(fin.legs || fin.error || {}));
  console.log('\nRESULT ' + JSON.stringify({ jobId, H, P, sha256_matches: sha256(P) === H,
    asset_htlc: fund.seq_htlc_txid, maker_btc_htlc: terms.btc_htlc_txid, status: fin.status }));
}
main().then(() => process.exit(0)).catch((e) => { console.error('[taker] FAILED:', e.message); process.exit(1); });
