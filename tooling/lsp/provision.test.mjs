// Registry-keying unit test for the per-USER provisioner (provision.mjs).
//
// Proves the multi-user keying contract WITHOUT booting real lightningd: provision()
// does not await the node boot, so pointing the binaries at /bin/true (spawn succeeds,
// exits) and lncli at /bin/false (getinfo -> null) exercises purely the key derivation +
// registry logic. The real end-to-end (two devices provisioning GOLD -> two attachable
// nodes) is proven live against the box LSP.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeProvisioner } from './provision.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-test-'));
const P = makeProvisioner({
  dir,
  lightningd: '/bin/true', node: '/bin/true', wsRelay: 'ignored', hsmdProxy: 'ignored',
  lncli: '/bin/false',                       // getinfo -> error -> null (node "down")
  elementsCli: '/bin/true',
  rpcPort: 18300, rpcUser: 'u', rpcPass: 'p',
  chains: { btc: { network: 'testnet4', rpcConnect: '127.0.0.1', rpcPort: 48332, rpcUser: 'u', rpcPass: 'p', cli: '/bin/true', feerate: 1000, extra: [] } },
});

const ASSET = 'aa'.repeat(32);
const DEV_A = '02' + '11'.repeat(32);        // 33-byte compressed pubkeys (66 hex)
const DEV_B = '03' + '22'.repeat(32);

// --- Two DIFFERENT devices provisioning the SAME asset -> two DISTINCT nodes ----------
const a1 = await P.provision({ assetId: ASSET, deviceTransportPubkey: DEV_A, label: 'GOLD' });
const b1 = await P.provision({ assetId: ASSET, deviceTransportPubkey: DEV_B, label: 'GOLD' });

assert.equal(a1.key, `seq:${ASSET}:${DEV_A.toLowerCase()}`, 'device A seq key is seq:<asset>:<pubA>');
assert.equal(b1.key, `seq:${ASSET}:${DEV_B.toLowerCase()}`, 'device B seq key is seq:<asset>:<pubB>');
assert.notEqual(a1.key, b1.key, 'same asset, different devices -> DISTINCT registry keys');
assert.equal(a1.asset_id, ASSET); assert.equal(b1.asset_id, ASSET);
assert.notEqual(a1.host_pubkey, b1.host_pubkey, 'each node has its OWN host Noise key');
assert.notEqual(a1.public_ws_path, b1.public_ws_path, 'each node has a distinct /lsp-ws-node path');
assert.notEqual(a1.ws_port, b1.ws_port, 'port-base allocation stays non-colliding across the growing set');
assert.equal(a1.deviceTransportPubkey, DEV_A.toLowerCase(), 'node A pins device A');
assert.equal(b1.deviceTransportPubkey, DEV_B.toLowerCase(), 'node B pins device B');
console.log('ok: two devices provisioning the same asset get two DISTINCT per-device nodes');

// --- Same device re-provisioning is IDEMPOTENT (re-attach, no duplicate) --------------
const before = P.list().length;
const a2 = await P.provision({ assetId: ASSET, deviceTransportPubkey: DEV_A, label: 'GOLD' });
assert.equal(a2.key, a1.key, 're-provision from the same device returns the SAME node key');
assert.equal(a2.dir, a1.dir, 'same dir (crash-safe: same keys/channels)');
assert.equal(a2.host_pubkey, a1.host_pubkey, 'same host identity');
assert.equal(P.list().length, before, 're-provision does NOT create a duplicate node');
console.log('ok: same device + asset re-provision is idempotent (re-attaches, no duplicate)');

// --- Lookups resolve each device-scoped node -----------------------------------------
assert.equal(P.getByKey(a1.key).host_pubkey, a1.host_pubkey, 'getByKey resolves device A node');
assert.equal(P.getByKey(b1.key).host_pubkey, b1.host_pubkey, 'getByKey resolves device B node');
const byWsA = P.getByWsId(a1.public_ws_path.split('/').pop());
assert.equal(byWsA.key, a1.key, 'getByWsId (the /lsp-ws-node router lookup) resolves node A uniquely');
const byAsset = P.get(ASSET);
assert.ok(byAsset && byAsset.asset_id === ASSET, 'get(asset) returns a node for the asset (coarse legacy fallback)');
console.log('ok: getByKey / getByWsId / get resolve device-scoped nodes correctly');

// --- BTC stays device-keyed (btc:<pub>), one native node per device -------------------
const btcA = await P.provision({ chain: 'btc', deviceTransportPubkey: DEV_A, label: 'BTC' });
assert.equal(btcA.key, `btc:${DEV_A.toLowerCase()}`, 'btc node key is btc:<pub> (device-only)');
assert.equal(btcA.asset_id, 'btc');
assert.notEqual(btcA.key, a1.key, 'the device btc node is distinct from its seq node');
console.log('ok: BTC nodes remain device-keyed (btc:<pub>), distinct from the seq node');

// --- Back-compat: a legacy bare-asset-id keyed node is still resolvable ---------------
const reg = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
reg.nodes[ASSET] = { key: ASSET, chain: 'seq', asset_id: ASSET, label: 'LEGACY',
  host_pubkey: 'de'.repeat(33), public_ws_path: '/lsp-ws-node/LEGACY-99', ws_port: 99999,
  deviceTransportPubkey: DEV_A.toLowerCase(), rpc: '/nonexistent/lightning-rpc', network: 'sequentia-testnet', node_id: null };
fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(reg, null, 2));
assert.equal(P.getByKey(ASSET).label, 'LEGACY', 'a legacy bare-asset-id keyed node is NOT orphaned (getByKey finds it)');
console.log('ok: legacy bare-asset-id keyed nodes remain resolvable (not orphaned)');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nALL PASS');
