// Unit test for the wallet Lightning module (seqln.js) + the two-node key
// derivation (seqln-keys.js). Runs in Node with no browser.
//
//   Part 1 — the LSP HTTP client: stubs a tiny LSP over http and drives the
//     client the same way the Swap tab's `ln` bridge does.
//   Part 2 — the two-node cross-chain rail (item 1 + 3): proves (a) two DISTINCT
//     device signing + transport keys derive deterministically from ONE mnemonic,
//     and (b) the two-connection logic connects TWO signer instances and only
//     reports the rail available once BOTH legs serve. The real on-device signer
//     (wasm + WebSocket + Noise) is browser-gated and proven separately by
//     tooling/lsp/device-harness.mjs; here we inject a mock SDK via CFG.sdkPath.
import http from 'node:http';
import assert from 'node:assert';
import {
  initSeqln, seqlnConfigured, seqlnState, seqlnAvailable,
  connectDevice, disconnectDevice, seqlnGetStatus, seqlnSwap, lnFinalityCopy,
  seqlnChannels, seqlnFunding, seqlnNodes, provisionNode, fundChannel,
} from './seqln.js';
import { lnDeriveNode, lnDeriveAll, LN_PATHS } from './seqln-keys.js';

let seen = [];
// A fake channel-open job that transitions pending_deposit -> active over a few polls,
// so the fundChannel poll loop is exercised end-to-end (Part 3).
const chanJobs = new Map();
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: req.url, auth: req.headers['authorization'], body: b });
    if (u.pathname === '/status') return res.end(JSON.stringify({ ok: true, node_id: 'ab'.repeat(33), channels: [
      { peer_id: 'ln3', asset_label: 'GOLD', spendable_units: 0, receivable_units: 2000000, state: 'CHANNELD_NORMAL' },
      { peer_id: 'ln2', asset_label: 'BTC', spendable_units: 1000000, receivable_units: 1000000, state: 'CHANNELD_NORMAL' },
    ], funding: { btc: true, assets: [{ id: 'aa'.repeat(32), label: 'GOLD' }] } }));
    if (u.pathname === '/swap') return res.end(JSON.stringify({ ok: true, side: 'buy', direction: 'bought',
      asset_label: 'GOLD', base_amount: 100000, quote_amount: 200000,
      preimage: 'cd'.repeat(32), finality: 'final', settled_ms: 2100 }));
    if (u.pathname === '/node/provision' && req.method === 'POST') {
      const body = JSON.parse(b || '{}');
      return res.end(JSON.stringify({ ok: true, asset_id: body.asset, label: body.label || 'X',
        status: 'booting', node_id: null, host_pubkey: 'ee'.repeat(33),
        public_ws_path: '/lsp-ws-node/X-0', ws_port: 18800, network: 'sequentia-testnet' }));
    }
    if (u.pathname === '/node/list') {
      return res.end(JSON.stringify({ ok: true, nodes: [
        { asset_id: 'aa'.repeat(32), label: 'USDX', status: 'running', node_id: 'dd'.repeat(33) },
      ] }));
    }
    if (u.pathname === '/channel/deposit') {
      const chain = u.searchParams.get('chain');
      return res.end(JSON.stringify({ ok: true, chain, node_id: 'cc'.repeat(33), address: chain === 'btc' ? 'tb1qdeposit' : 'tb1qseqdeposit' }));
    }
    if (u.pathname === '/channel/open' && req.method === 'POST') {
      const body = JSON.parse(b || '{}');
      const id = 'job-' + (chanJobs.size + 1);
      const job = { ok: true, job_id: id, chain: body.chain, asset_id: body.asset || null,
        requested_amount: body.amount, status: 'pending_deposit', polls: 0, poll: `/channel/open/${id}` };
      chanJobs.set(id, job);
      res.statusCode = 202; return res.end(JSON.stringify(job));
    }
    if (u.pathname.startsWith('/channel/open/')) {
      const id = u.pathname.slice('/channel/open/'.length);
      const job = chanJobs.get(id);
      if (!job) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'unknown job' })); }
      job.polls++;
      // pending_deposit -> opening -> awaiting_lockin -> active
      job.status = ['pending_deposit', 'opening', 'awaiting_lockin', 'active'][Math.min(job.polls, 3)];
      if (job.status === 'active') { job.short_channel_id = '999x1x0'; job.spendable_msat = 30000000; job.state = 'CHANNELD_NORMAL'; }
      return res.end(JSON.stringify({ ...job, ok: true }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'nope' }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

// ===========================================================================
// Part 1 — the LSP HTTP client
// ===========================================================================
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN' });
assert.ok(seqlnConfigured(), 'configured after initSeqln');
assert.equal(seqlnState().connected, false, 'no signer connected in Node (browser-only)');
assert.equal(seqlnAvailable(), false, 'no LN rail without device signers');
console.log('ok: initSeqln configures the LSP client; the rail is unavailable with no signers');

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

assert.ok(/final/i.test(lnFinalityCopy()), 'finality copy states pure-LN is final');
console.log('ok: lnFinalityCopy() states pure-LN is instant + final');

// ===========================================================================
// Part 2a — two DISTINCT device identities from ONE mnemonic (item 1)
// ===========================================================================
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// The documented paths (the re-provisioning step must derive the SAME children).
assert.equal(LN_PATHS.asset.transport, "m/1017'/0'/0'", 'asset transport path (== legacy single-node path)');
assert.equal(LN_PATHS.btc.transport,   "m/1017'/0'/1'", 'btc transport path');
assert.equal(LN_PATHS.asset.signing,   "m/1017'/1'/0'", 'asset signing path');
assert.equal(LN_PATHS.btc.signing,     "m/1017'/1'/1'", 'btc signing path');

const all = lnDeriveAll(PHRASE);
const asset = lnDeriveNode(PHRASE, 'asset');
const btc = lnDeriveNode(PHRASE, 'btc');
const four = [asset.transportPrivkey, asset.signingSeed, btc.transportPrivkey, btc.signingSeed];
assert.ok(four.every((k) => /^[0-9a-f]{64}$/.test(k)), 'all four keys are 64-hex');
assert.equal(new Set(four).size, 4, 'transport + signing keys are all distinct across both nodes');
// deterministic: a re-derive from the same phrase reproduces every key exactly.
assert.deepEqual(lnDeriveNode(PHRASE, 'asset'), asset, 'asset keys are deterministic');
assert.deepEqual(lnDeriveNode(PHRASE, 'btc'), btc, 'btc keys are deterministic');
assert.equal(all.asset.transportPrivkey, asset.transportPrivkey, 'lnDeriveAll matches lnDeriveNode');
console.log('ok: one mnemonic -> two DISTINCT deterministic (transport + signing) device identities');

// ===========================================================================
// Part 2b — the two-connection logic (item 3), with a mock SDK (no wasm/WS)
// ===========================================================================
// A tiny mock of the vendored SeqlnSigner SDK, injected via CFG.sdkPath. It
// records each connect and derives a node id from the transport privkey, so the
// test can assert TWO independent connections with the two distinct identities.
globalThis.__seqlnMockConnects = [];
const MOCK_SRC = `
globalThis.__seqlnMockConnects = globalThis.__seqlnMockConnects || [];
export class SeqlnSigner {
  static async fromMnemonic(seed){ const s = new SeqlnSigner(); s._seed = seed; return s; }
  setPolicy(m){ this._policy = m; return this; }
  async connect({ wsUrl, hostStaticPubkey, deviceStaticPrivkey }){
    this._nodeId = 'node-' + String(deviceStaticPrivkey).slice(0, 16);
    globalThis.__seqlnMockConnects.push({ seed: this._seed, policy: this._policy,
      priv: deviceStaticPrivkey, wsUrl, hostPub: hostStaticPubkey, nodeId: this._nodeId });
    if (this.onStatus) this.onStatus({ state: 'node_id', nodeId: this._nodeId });
  }
  async whenNodeId(){ return this._nodeId; }
  disconnect(){ this._connected = false; }
}
export default SeqlnSigner;
`;
const MOCK = 'data:text/javascript,' + encodeURIComponent(MOCK_SRC);

initSeqln({
  lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN', sdkPath: MOCK,
  nodes: {
    asset: { wsUrl: 'ws://asset.local/lsp-signer', hostPubkey: 'aa'.repeat(33) },
    btc:   { wsUrl: 'ws://btc.local/lsp-signer',   hostPubkey: 'bb'.repeat(33) },
  },
});
assert.equal(seqlnState().deployed, true, 'both nodes enabled by config');
assert.equal(seqlnAvailable(), false, 'rail unavailable before any signer connects');

// Connect the ASSET leg only (ws/host come from CFG.nodes[node]).
const idA = await connectDevice({ node: 'asset', deviceSigningSeed: asset.signingSeed, deviceTransportPrivkey: asset.transportPrivkey });
assert.ok(idA, 'asset signer connected');
assert.equal(seqlnState().nodes.asset.connected, true, 'asset leg serving');
assert.equal(seqlnState().nodes.btc.connected, false, 'btc leg still down');
assert.equal(seqlnAvailable(), false, 'ONE leg is not enough — a cross-chain swap needs BOTH');
console.log('ok: one connected leg does NOT make the cross-chain rail available');

// Connect the BTC leg -> both serving -> rail available.
const idB = await connectDevice({ node: 'btc', deviceSigningSeed: btc.signingSeed, deviceTransportPrivkey: btc.transportPrivkey });
assert.ok(idB, 'btc signer connected');
assert.equal(seqlnAvailable(), true, 'rail available once BOTH legs serve');
const s2 = seqlnState();
assert.equal(s2.connected, true);
assert.equal(s2.connectedCount, 2); assert.equal(s2.enabledCount, 2);
assert.notEqual(s2.nodes.asset.nodeId, s2.nodes.btc.nodeId, 'two distinct hosted-node identities');
console.log('ok: connecting BOTH legs brings the rail up (available) with two distinct node ids');

// The mock saw two independent connects with the two distinct transport keys,
// signing seeds, and per-node endpoints (from CFG.nodes).
const c = globalThis.__seqlnMockConnects;
assert.equal(c.length, 2, 'exactly two device connections');
assert.notEqual(c[0].priv, c[1].priv, 'distinct transport privkeys');
assert.notEqual(c[0].seed, c[1].seed, 'distinct signing seeds');
assert.deepEqual(new Set(c.map((x) => x.wsUrl)),
  new Set(['ws://asset.local/lsp-signer', 'ws://btc.local/lsp-signer']), 'each leg used its own wss endpoint');
assert.deepEqual(new Set(c.map((x) => x.hostPub)),
  new Set(['aa'.repeat(33), 'bb'.repeat(33)]), 'each leg pinned its own host pubkey');
console.log('ok: two device signers connected — distinct keys, seeds, endpoints, and host pubkeys per leg');

// Disconnect drops the whole rail.
disconnectDevice();
assert.equal(seqlnAvailable(), false, 'disconnect() drops both legs');
console.log('ok: disconnectDevice() tears down both legs and the rail goes unavailable');

// ===========================================================================
// Part 3 — "Move to Lightning" channel funding (fundChannel + seqlnChannels)
// ===========================================================================
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN' });

// seqlnChannels() surfaces just the channel list for the Balance UI.
const chans = await seqlnChannels();
assert.equal(chans.length, 2, 'seqlnChannels() returns the /status channel list');
console.log('ok: seqlnChannels() returns the leg-tagged channel list for the Balance tab');

// seqlnFunding() surfaces which chains/assets Move-to-Lightning can fund (dynamic).
const funding = await seqlnFunding();
assert.equal(funding.btc, true, 'funding.btc advertises the BTC leg');
assert.equal(funding.assets.length, 1, 'funding.assets lists the one provisioned asset node (GOLD)');
assert.equal(funding.assets[0].label, 'GOLD', 'the provisioned asset is GOLD');
console.log('ok: seqlnFunding() advertises the fundable chains/assets (single-asset-node reality)');

// provisionNode() POSTs {asset, device_transport_pubkey} to spin up a per-asset node.
const prov = await provisionNode({ asset: 'ab'.repeat(32), deviceTransportPubkey: 'cc'.repeat(33), label: 'NEWX' });
assert.ok(prov.ok && prov.host_pubkey && prov.public_ws_path, 'provisionNode returns node wiring');
const provReq = seen.filter((s) => s.method === 'POST' && s.path === '/node/provision').at(-1);
assert.deepEqual(JSON.parse(provReq.body), { asset: 'ab'.repeat(32), device_transport_pubkey: 'cc'.repeat(33), label: 'NEWX' },
  'provisionNode forwards asset + device pubkey + label');
const nodes = await seqlnNodes();
assert.equal(nodes.length, 1, 'seqlnNodes lists the provisioned nodes (the dynamic M)');
console.log('ok: provisionNode()/seqlnNodes() drive per-asset node provisioning (dynamic N/M)');

// fundChannel: gets the deposit address, calls the wallet's OWN send hook (the wallet
// signs the deposit — the LSP never holds the key), starts the open, polls to active.
const progress = [];
let sentArgs = null;
const result = await fundChannel({
  chain: 'btc', amount: 30000,
  // The wallet-supplied on-chain send hook — proves seqln.js delegates signing.
  sendOnchain: async (a) => { sentArgs = a; return { txid: 'ee'.repeat(32) }; },
  onProgress: (e) => progress.push(e.phase),
  pollMs: 5,
});
assert.equal(sentArgs.chain, 'btc', 'send hook got the chain');
assert.equal(sentArgs.amount, 30000, 'send hook got the amount');
assert.equal(sentArgs.address, 'tb1qdeposit', 'send hook got the hosted node deposit address');
assert.equal(result.status, 'active', 'fundChannel resolves once the channel is active');
assert.equal(result.short_channel_id, '999x1x0', 'active job carries the short_channel_id');
assert.equal(result.spendable_msat, 30000000, 'active job reports spendable_msat');
assert.ok(progress.includes('deposit-address') && progress.includes('sending') && progress.includes('sent'),
  'progress surfaced deposit-address -> sending -> sent');
assert.ok(progress.includes('awaiting_lockin') && progress.at(-1) === 'active',
  'progress surfaced the lock-in -> active transition');
// The deposit address was fetched, the open POSTed with {chain,amount}, and polled.
const depReq = seen.find((s) => s.path.startsWith('/channel/deposit'));
assert.ok(depReq && depReq.auth === 'Bearer T0KEN', 'deposit fetch sent the bearer token');
const openReq = seen.find((s) => s.method === 'POST' && s.path === '/channel/open');
assert.deepEqual(JSON.parse(openReq.body), { chain: 'btc', amount: 30000 }, 'POST /channel/open body');
console.log('ok: fundChannel() delegates the deposit to the wallet hook, then opens + polls to active');

// A missing send hook is rejected (the wallet MUST sign the deposit; the LSP cannot).
await assert.rejects(() => fundChannel({ chain: 'btc', amount: 1000 }), /sendOnchain hook is required/,
  'fundChannel refuses to proceed without the wallet send hook (non-custodial)');
// An asset channel passes the asset through to /channel/open.
await fundChannel({ chain: 'seq', asset: 'GOLD', amount: 5000,
  sendOnchain: async () => ({ txid: 'ab'.repeat(32) }), pollMs: 5 });
const openSeq = seen.filter((s) => s.method === 'POST' && s.path === '/channel/open').at(-1);
assert.deepEqual(JSON.parse(openSeq.body), { chain: 'seq', amount: 5000, asset: 'GOLD' }, 'asset open forwards the asset');
console.log('ok: fundChannel() forwards the asset for a Sequentia asset channel; refuses without a send hook');

srv.close();
console.log('\nALL PASS');
