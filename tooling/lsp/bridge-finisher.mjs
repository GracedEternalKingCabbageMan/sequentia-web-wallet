// bridge-finisher.mjs — robust completion + verification of an in-flight bridged SELL, independent of the
// taker harness (which times out). Given the job's H, the taker's asset HTLC, the maker's BTC HTLC, and the
// taker's BTC-LN node, it: waits for the maker to claim the asset (revealing P on-chain), verifies
// sha256(P)==H, settles the taker's hold with P (taker receives BTC-LN), and confirms the LSP recouped the
// maker's BTC HTLC with P. Prints a full before/after RESULT.
//
//   node bridge-finisher.mjs <jobId> <H> <assetHtlcTxid:vout> <makerBtcHtlcTxid:vout>

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const [jobId, H, assetRef, makerBtcRef] = process.argv.slice(2);
const [assetTxid, assetVout] = assetRef.split(':');
const [mbTxid, mbVout] = makerBtcRef.split(':');
const SEQOB = '/root/sequentia/seqdex/bin/seqob-cli';
const LNCLI = '/root/sequentia/seqln/cli/lightning-cli';
const TAKER_LN = ['--lightning-dir=/root/sequentia/lsp/btc-maker', '--network=testnet4'];
const SEQ_RPC = 'http://seq:seq@127.0.0.1:18300';
const BTC = ['-rpcconnect=127.0.0.1', '-rpcport=48332', '-rpcuser=seq', '-rpcpassword=seq'];
const TOKEN = 'b5b1-d848ec96d29c01d2ff1db6cf';
const sha256 = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (bin, args, t = 60000) => new Promise((res, rej) => execFile(bin, args, { timeout: t, maxBuffer: 8 << 20 }, (e, o, er) => e ? rej(new Error((er || e.message || '').trim())) : res(o.trim())));
const log = (...a) => console.log('[finish]', new Date().toISOString().slice(11, 19), ...a);
async function job() { const r = await fetch('http://127.0.0.1:9981/swap/' + jobId, { headers: { authorization: 'Bearer ' + TOKEN } }); return r.json(); }
async function btcBal(w) { try { return Number(await run('bitcoin-cli', [...BTC, '-rpcwallet=' + w, 'getbalance'])); } catch { return null; } }
async function lnSpendable(dir) { try { const j = JSON.parse(await run(LNCLI, ['--lightning-dir=' + dir, '--network=testnet4', 'listfunds'])); return (j.channels || []).reduce((s, c) => s + Number(String(c.our_amount_msat || 0).replace(/msat/, '')), 0); } catch { return null; } }

async function main() {
  const before = { takerLn: await lnSpendable('/root/sequentia/lsp/btc-maker'), lspLn: await lnSpendable('/root/sequentia/lsp/btc-taker'), recoup: await btcBal('lsp-bridge-recoup') };
  log('BEFORE  taker-LN', before.takerLn, 'lsp-LN', before.lspLn, 'recoup', before.recoup);

  // 1. Wait for the maker to claim the asset (reveal P) — spans the anchor gate + the next Bitcoin block.
  let P = null;
  for (let i = 0; i < 360 && !P; i++) {
    try { const o = JSON.parse(await run(SEQOB, ['xhtlc-observe', '-rpc', SEQ_RPC, '-txid', assetTxid, '-vout', String(assetVout || 0), '-hash', H])); if (o.spent) log('asset HTLC spent by maker', o.spender_txid || '', o.preimage ? 'P=' + o.preimage : '(reading P)'); if (o.preimage) P = o.preimage; } catch {}
    if (!P) await sleep(15000);
  }
  if (!P) throw new Error('maker never claimed the asset (no P) within ~90 min');
  log('P =', P, '| sha256(P)==H ?', sha256(P) === H);
  if (sha256(P) !== H) throw new Error('sha256(P) != H');

  // 2. Settle the taker's hold with P -> taker receives BTC-LN.
  for (let i = 0; i < 40; i++) { try { const l = JSON.parse(await run(LNCLI, [...TAKER_LN, 'holdinvoicelookup', H])); if (l.state === 'accepted') break; if (l.state === 'settled') break; } catch {} await sleep(2000); }
  try { await run(LNCLI, [...TAKER_LN, 'holdinvoicesettle', H, P]); log('hold SETTLED with P — taker received BTC-LN'); } catch (e) { log('settle:', e.message); }

  // 3. Confirm the LSP recouped the maker's BTC HTLC with P + the job settled.
  let recouped = false;
  for (let i = 0; i < 40 && !recouped; i++) {
    try { const o = JSON.parse(await run(SEQOB, ['xhtlc-observe', '-rpc', 'http://seq:seq@127.0.0.1:48332', '-txid', mbTxid, '-vout', String(mbVout || 0), '-hash', H])); if (o.spent) { recouped = true; log('maker BTC HTLC SPENT (LSP recoup)', o.spender_txid || '', o.preimage ? 'witness P=' + o.preimage : ''); } } catch {}
    if (!recouped) await sleep(8000);
  }
  let fin = null; for (let i = 0; i < 30; i++) { fin = await job(); if (fin.status === 'settled' || fin.status === 'failed') break; await sleep(4000); }
  const after = { takerLn: await lnSpendable('/root/sequentia/lsp/btc-maker'), lspLn: await lnSpendable('/root/sequentia/lsp/btc-taker'), recoup: await btcBal('lsp-bridge-recoup') };
  log('AFTER   taker-LN', after.takerLn, 'lsp-LN', after.lspLn, 'recoup', after.recoup);
  console.log('\nRESULT ' + JSON.stringify({ jobId, H, P, sha256_matches: sha256(P) === H, maker_recouped: recouped, job_status: fin && fin.status,
    taker_ln_delta_msat: after.takerLn - before.takerLn, lsp_ln_delta_msat: after.lspLn - before.lspLn, lsp_recoup_delta_btc: (after.recoup - before.recoup) }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error('[finish] FAILED:', e.message); process.exit(1); });
