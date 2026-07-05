// Unit test for the wallet Lightning module's LSP HTTP client (seqln.js). Runs in
// Node with no browser: it stubs a tiny LSP over http and drives the client the
// same way the Swap tab's `ln` bridge does. The on-device signer path
// (connectDevice) needs a browser (WebSocket + wasm + IndexedDB) and is proven
// separately by tmp/lsp/proof-harness.mjs.
import http from 'node:http';
import assert from 'node:assert';
import { initSeqln, seqlnConfigured, seqlnState, seqlnGetStatus, seqlnSwap, lnFinalityCopy } from './seqln.js';

let seen = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    seen.push({ method: req.method, path: req.url, auth: req.headers['authorization'], body: b });
    if (req.url === '/status') return res.end(JSON.stringify({ ok: true, node_id: 'ab'.repeat(33), channels: [
      { peer_id: 'ln3', asset_label: 'GOLD', spendable_units: 0, receivable_units: 2000000, state: 'CHANNELD_NORMAL' },
      { peer_id: 'ln2', asset_label: 'BTC', spendable_units: 1000000, receivable_units: 1000000, state: 'CHANNELD_NORMAL' },
    ] }));
    if (req.url === '/swap') return res.end(JSON.stringify({ ok: true, side: 'buy', direction: 'bought',
      asset_label: 'GOLD', base_amount: 100000, quote_amount: 200000,
      preimage: 'cd'.repeat(32), finality: 'final', settled_ms: 2100 }));
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'nope' }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN' });
assert.ok(seqlnConfigured(), 'configured after initSeqln');
assert.equal(seqlnState().connected, false, 'signer not connected in Node (browser-only)');
console.log('ok: initSeqln configures the LSP client; signer stays offline in Node');

const st = await seqlnGetStatus();
assert.ok(st.ok && st.channels.length === 2, 'GET /status returns channels');
assert.equal(seen.at(-1).auth, 'Bearer T0KEN', 'bearer token sent');
console.log('ok: seqlnGetStatus() sends the bearer token and parses channels');

const sw = await seqlnSwap({ side: 'buy', asset: 'GOLD', amount: 100000 });
assert.ok(sw.ok && /^[0-9a-f]{64}$/.test(sw.preimage), 'swap returns a preimage');
assert.equal(sw.base_amount, 100000);
const swReq = seen.at(-1);
assert.equal(swReq.method, 'POST'); assert.equal(swReq.path, '/swap');
assert.deepEqual(JSON.parse(swReq.body), { side: 'buy', asset: 'GOLD', amount: 100000 });
console.log('ok: seqlnSwap() POSTs {side,asset,amount} and parses the settle (preimage + amounts)');

// error propagation: a non-ok LSP body rejects with the server's error message.
initSeqln({ lspUrl: `http://127.0.0.1:${port}/nope-prefix`, token: 'T0KEN' });
await assert.rejects(() => seqlnGetStatus(), /nope/, 'non-ok LSP response rejects with the error');
console.log('ok: a non-ok LSP response rejects with the server error message');
// restore the good base for any later use
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN' });

assert.ok(/final/i.test(lnFinalityCopy()), 'finality copy states pure-LN is final');
console.log('ok: lnFinalityCopy() states pure-LN is instant + final');

srv.close();
console.log('\nALL PASS');
