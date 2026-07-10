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
import { lnDeriveNode, lnDeriveAll, lnDeriveAsset, LN_PATHS, LN_ASSET_BRANCH } from './seqln-keys.js';
import {
  connectProvisioned, provisionAndConnect, provisionedState, nodeGetinfo, waitNodeReady, closeChannelLsp,
} from './seqln.js';

let seen = [];
let readyPolls = 0;
// A fake channel-open job that transitions pending_deposit -> active over a few polls,
// so the fundChannel poll loop is exercised end-to-end (Part 3).
const chanJobs = new Map();
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: req.url, auth: req.headers['authorization'], body: b });
    if (u.pathname === '/status') {
      const base = [
        { peer_id: 'ln3', asset_label: 'GOLD', spendable_units: 0, receivable_units: 2000000, state: 'CHANNELD_NORMAL' },
        { peer_id: 'ln2', asset_label: 'BTC', spendable_units: 1000000, receivable_units: 1000000, state: 'CHANNELD_NORMAL' },
      ];
      // The device's OWN provisioned-node channels, reported only for the keys it named via ?nodes=.
      const keys = (u.searchParams.get('nodes') || '').split(',').filter(Boolean);
      const prov = keys.map((k) => ({ peer_id: 'lnP', asset: k.startsWith('seq:') ? k.split(':')[1] : k,
        node_key: k, leg: 'prov', spendable_units: 4242, receivable_units: 0, state: 'CHANNELD_NORMAL' }));
      return res.end(JSON.stringify({ ok: true, node_id: 'ab'.repeat(33), channels: [...base, ...prov],
        provisioned_nodes: keys.map((k) => ({ key: k })),
        funding: { btc: true, assets: [{ id: 'aa'.repeat(32), label: 'GOLD' }] } }));
    }
    if (u.pathname === '/swap') return res.end(JSON.stringify({ ok: true, side: 'buy', direction: 'bought',
      asset_label: 'GOLD', base_amount: 100000, quote_amount: 200000,
      preimage: 'cd'.repeat(32), finality: 'final', settled_ms: 2100 }));
    if (u.pathname === '/channel/close' && req.method === 'POST') {
      const body = JSON.parse(b || '{}');
      // Echo back what the wallet asked to close, plus a closing txid — mirrors the LSP.
      return res.end(JSON.stringify({ ok: true, closing_txid: 'fc'.repeat(32), type: 'mutual',
        scid: body.scid, destination: body.destination, asset_label: 'GOLD' }));
    }
    if (u.pathname === '/node/provision' && req.method === 'POST') {
      const body = JSON.parse(b || '{}');
      // Mirror the real LSP registry keying: a btc node is device-keyed (`btc:<pub>`),
      // a seq node is asset-keyed. The wallet threads this `key` into fundChannel.
      const isBtc = body.chain === 'btc';
      const key = isBtc ? `btc:${String(body.device_transport_pubkey).toLowerCase()}` : body.asset;
      return res.end(JSON.stringify({ ok: true, chain: isBtc ? 'btc' : 'seq', key,
        asset_id: isBtc ? 'btc' : body.asset, label: body.label || 'X',
        status: 'booting', node_id: null, host_pubkey: 'ee'.repeat(33),
        public_ws_path: isBtc ? '/lsp-ws-node/BTC-9' : '/lsp-ws-node/X-0',
        ws_port: 18800, network: isBtc ? 'testnet4' : 'sequentia-testnet' }));
    }
    if (u.pathname === '/node/getinfo') {
      // Not ready for the first 2 polls (fresh node still booting), then ready — exercises
      // waitNodeReady's poll-until-ready loop.
      const key = u.searchParams.get('node') || '';
      readyPolls++;
      const ready = readyPolls >= 3;
      return res.end(JSON.stringify({ ok: true, ready, node_id: ready ? 'ff'.repeat(33) : null,
        blockheight: ready ? 100 : null, synced: ready }));
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
  static async devicePubkey(priv){ return '02' + String(priv).slice(0, 64).padEnd(64, '0'); }
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

// ===========================================================================
// Part 4 — per-asset device identities + provisioned-node connect (dynamic N/M)
// ===========================================================================
// Re-init with the mock SDK (Part 3 reset sdkPath to the default) so the provisioned
// signer connect is exercised in Node without the real wasm.
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN', sdkPath: MOCK });
// A provisioned node's identity is derived on the dedicated per-asset branch and is
// deterministic + distinct per asset (and distinct from the fixed asset/btc leaves).
const ASSET_A = 'aa'.repeat(32), ASSET_B = 'bc'.repeat(32);
const da = lnDeriveAsset(PHRASE, ASSET_A);
const db = lnDeriveAsset(PHRASE, ASSET_B);
assert.ok(da.paths.transport.startsWith(LN_ASSET_BRANCH.transport + '/'), 'asset transport on the per-asset branch');
assert.ok(da.paths.signing.startsWith(LN_ASSET_BRANCH.signing + '/'), 'asset signing on the per-asset branch');
assert.deepEqual(lnDeriveAsset(PHRASE, ASSET_A), da, 'per-asset identity is deterministic');
const keys4 = [da.transportPrivkey, da.signingSeed, db.transportPrivkey, db.signingSeed,
  asset.transportPrivkey, btc.transportPrivkey];
assert.equal(new Set(keys4).size, keys4.length, 'per-asset keys are distinct across assets AND from the fixed asset/btc keys');
console.log('ok: lnDeriveAsset derives deterministic, per-asset-distinct device identities on a dedicated branch');

// The mock SDK is still installed from Part 2b (CFG.sdkPath = MOCK). provisionAndConnect
// derives the identity, provisions the node (POST /node/provision), and connects the
// signer to the provisioned node's ws — all through the same testable seams.
globalThis.__seqlnMockConnects = [];
const res = await provisionAndConnect({
  assetId: ASSET_A,
  deriveIdentity: (id) => lnDeriveAsset(PHRASE, id),
  label: 'NEWX',
});
assert.ok(res.node && res.node.host_pubkey, 'provisionAndConnect returned the provisioned node wiring');
assert.ok(res.connected && /^node-/.test(res.nodeId), 'the provisioned signer connected and derived a node id');
assert.equal(provisionedState()[ASSET_A].connected, true, 'provisioned-node state reflects the live signer');
// It POSTed the provision with the derived device pubkey and connected to that node's ws.
const provPost = seen.filter((s) => s.method === 'POST' && s.path === '/node/provision').at(-1);
assert.equal(JSON.parse(provPost.body).asset, ASSET_A, 'provisionAndConnect provisioned the right asset');
const conn = globalThis.__seqlnMockConnects.at(-1);
assert.ok(conn.wsUrl.endsWith('/lsp-ws-node/X-0'), 'signer connected to the provisioned node public_ws_path');
console.log('ok: provisionAndConnect provisions a per-asset node keyed to the device + brings its signer online');

// ===========================================================================
// Part 5 — provision-then-fund ordering + the per-user node selector (the fix)
// ===========================================================================
// The Move-to-Lightning bug fix: the wallet FIRST provisions the user's OWN node, THEN
// funds a channel routed to THAT node (never the shared demo node). These assert the two
// seams that make it non-custodial-per-user: (a) provisionAndConnect returns the LSP
// registry `key`, and (b) fundChannel threads that key into BOTH /channel/deposit and
// /channel/open so the deposit + device-co-signed funding target the user's node.
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN', sdkPath: MOCK });

// (a) A SEQ provision returns the asset id as its routing key; provision resolves BEFORE
//     we fund (the caller awaits it), and the signer is connected at that point.
globalThis.__seqlnMockConnects = [];
const seqProv = await provisionAndConnect({
  chain: 'seq', assetId: 'de'.repeat(32), deriveIdentity: (id) => lnDeriveAsset(PHRASE, id), label: 'USDX',
});
assert.equal(seqProv.key, 'de'.repeat(32), 'seq provisionAndConnect returns the asset id as the routing key');
assert.ok(seqProv.connected, 'the user node is CONNECTED before any funding is attempted (ordering)');
console.log('ok: provisionAndConnect connects the user node and returns its routing key BEFORE funding');

// (b) fundChannel threads prov.key into the deposit query AND the open body -> the LSP
//     routes to the USER'S node (targetFor uses the node key), not the demo node.
const beforeIdx = seen.length;
await fundChannel({
  chain: 'seq', asset: 'de'.repeat(32), amount: 7000, node: seqProv.key,
  sendOnchain: async () => ({ txid: 'ba'.repeat(32) }), pollMs: 5,
});
const depSel = seen.slice(beforeIdx).find((s) => s.path.startsWith('/channel/deposit'));
assert.ok(depSel.path.includes(`node=${encodeURIComponent(seqProv.key)}`), 'deposit query carries the user node key');
assert.ok(depSel.path.includes('asset=' + 'de'.repeat(32)), 'deposit query carries the asset (right node address)');
const openSel = seen.slice(beforeIdx).filter((s) => s.method === 'POST' && s.path === '/channel/open').at(-1);
assert.deepEqual(JSON.parse(openSel.body), { chain: 'seq', amount: 7000, asset: 'de'.repeat(32), node: seqProv.key },
  'open body routes the fundchannel to the user node key (NOT the demo node)');
console.log('ok: fundChannel targets the user node via the node key in BOTH deposit + open (not the demo node)');

// (c) The BTC leg provisions the per-USER testnet4 node the same way: device-keyed
//     (chain:btc, no asset id), and funds routed to that `btc:<pub>` key.
globalThis.__seqlnMockConnects = [];
const btcProv = await provisionAndConnect({
  chain: 'btc', label: 'BTC',
  deriveIdentity: () => { const k = lnDeriveNode(PHRASE, 'btc'); return { transportPrivkey: k.transportPrivkey, signingSeed: k.signingSeed }; },
});
assert.ok(/^btc:[0-9a-f]{2,}/.test(btcProv.key), 'btc provisionAndConnect returns a device-keyed btc:<pub> routing key');
assert.ok(btcProv.connected, 'btc user node signer connected');
const btcProvPost = seen.filter((s) => s.method === 'POST' && s.path === '/node/provision').at(-1);
const btcBody = JSON.parse(btcProvPost.body);
assert.equal(btcBody.chain, 'btc', 'btc provision sends chain:btc');
assert.ok(!('asset' in btcBody), 'btc provision sends NO asset (device-keyed, not asset-keyed)');
const beforeBtc = seen.length;
await fundChannel({
  chain: 'btc', amount: 40000, node: btcProv.key,
  sendOnchain: async () => ({ txid: 'ca'.repeat(32) }), pollMs: 5,
});
const openBtc = seen.slice(beforeBtc).filter((s) => s.method === 'POST' && s.path === '/channel/open').at(-1);
assert.deepEqual(JSON.parse(openBtc.body), { chain: 'btc', amount: 40000, node: btcProv.key },
  'btc open body routes to the per-user btc node key');
console.log('ok: the BTC leg provisions the per-USER testnet4 node (device-keyed) + funds routed to it');

// (d) Without a node key, fundChannel omits it (back-compat: the demo-node path is only
//     ever hit when the wallet does NOT pass a key — which the fixed UI now always does).
const beforeNoNode = seen.length;
await fundChannel({ chain: 'seq', asset: 'GOLD', amount: 3000, sendOnchain: async () => ({ txid: 'ab'.repeat(32) }), pollMs: 5 });
const openNoNode = seen.slice(beforeNoNode).filter((s) => s.method === 'POST' && s.path === '/channel/open').at(-1);
assert.ok(!('node' in JSON.parse(openNoNode.body)), 'no node key -> open body omits node (no accidental demo-node key)');
console.log('ok: fundChannel only sends a node key when the wallet supplies one (no accidental targeting)');

// ===========================================================================
// Part 6 — node readiness wait (fresh node boots + rescans before its rpc answers)
// ===========================================================================
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN' });
readyPolls = 0;
const progress6 = [];
const ready = await waitNodeReady({ nodeKey: 'seq:' + 'aa'.repeat(32) + ':' + '02'.repeat(33),
  onProgress: (e) => progress6.push(e.phase), pollMs: 5 });
assert.ok(ready.ready === true && /^[0-9a-f]{66}$/.test(ready.node_id), 'waitNodeReady resolves once the node getinfo answers');
assert.ok(progress6.length >= 2 && progress6.every((p) => p === 'preparing'),
  'waitNodeReady emits "preparing" progress while the node is still booting (no dead end)');
assert.ok(readyPolls >= 3, 'it polled /node/getinfo until ready (did not give up early)');
// nodeGetinfo surfaces the raw readiness for the wallet.
readyPolls = 10;   // force ready
const gi = await nodeGetinfo('seq:' + 'aa'.repeat(32) + ':' + '02'.repeat(33));
assert.equal(gi.ready, true, 'nodeGetinfo returns the node readiness');
console.log('ok: waitNodeReady polls /node/getinfo until the fresh node is ready (honest progress)');

// ===========================================================================
// Part 7 — /status reports the DEVICE's OWN provisioned-node channels (2c)
// ===========================================================================
// After a Move-to-Lightning, seqlnGetStatus threads the device's provisioned-node keys via
// ?nodes= so /status also returns THAT device's channels — so the Balance card reflects a
// channel the user just created on their own node (not only the shared demo nodes).
initSeqln({ lspUrl: `http://127.0.0.1:${port}`, token: 'T0KEN', sdkPath: MOCK });
globalThis.__seqlnMockConnects = [];
const OWN = 'ce'.repeat(32);
const ownProv = await provisionAndConnect({ chain: 'seq', assetId: OWN, deriveIdentity: (id) => lnDeriveAsset(PHRASE, id), label: 'OWN' });
const before7 = seen.length;
const st7 = await seqlnGetStatus();
const statusReq = seen.slice(before7).find((s) => s.path.startsWith('/status'));
assert.ok(statusReq.path.includes('nodes=') && statusReq.path.includes(encodeURIComponent(ownProv.key)),
  'seqlnGetStatus threads the device provision key via ?nodes=');
const ownChan = (st7.channels || []).find((c) => c.node_key === ownProv.key);
assert.ok(ownChan && ownChan.state === 'CHANNELD_NORMAL', '/status merges the device\'s OWN provisioned-node channel');
assert.ok((st7.provisioned_nodes || []).some((n) => n.key === ownProv.key), '/status lists the device\'s provisioned node');
console.log('ok: seqlnGetStatus reports the device\'s own provisioned-node channels (Balance card readback)');

// ===========================================================================
// Part 8 — "Move back to chain": closeChannelLsp posts the close request (2c inverse)
// ===========================================================================
// The wallet closes a channel on its own hosted node and names the destination address, so the
// reclaimed funds return on-chain. Verify the POST body carries chain/asset/node/scid/destination
// and the closing txid comes back.
const before8 = seen.length;
const close8 = await closeChannelLsp({ chain: 'seq', asset: 'aa'.repeat(32), node: 'seq:' + 'aa'.repeat(32) + ':' + '02'.repeat(33), scid: '111x2x0', destination: 'tb1qexampledest' });
const closeReq = seen.slice(before8).find((s) => s.path === '/channel/close' && s.method === 'POST');
assert.ok(closeReq, 'closeChannelLsp POSTs to /channel/close');
const cbody = JSON.parse(closeReq.body || '{}');
assert.equal(cbody.scid, '111x2x0', 'close request carries the channel scid');
assert.equal(cbody.destination, 'tb1qexampledest', 'close request carries the wallet destination address');
assert.ok(cbody.node && cbody.node.startsWith('seq:'), 'close request names the device node key');
assert.equal(close8.closing_txid, 'fc'.repeat(32), 'closeChannelLsp returns the closing txid');
console.log('ok: closeChannelLsp drives a device-signed channel close back to the wallet address (Move back to chain)');

srv.close();
console.log('\nALL PASS');
