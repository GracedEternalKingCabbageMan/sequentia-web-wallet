// Per-asset hosted-SeqLN node provisioning (the multi-asset core of "Move to Lightning").
//
// SeqLN nodes are SINGLE-ASSET: one keyless lightningd is denominated in exactly one
// asset (its "sats" ARE that asset's atoms). So "move ANY asset into Lightning" means
// the LSP must be able to spin up a NEW hosted node PER ASSET on demand, keyed to the
// connecting device, and attach that device's signer. This module is that mechanism.
//
// A provisioned node mirrors the demo nodes exactly (verified against demo-asset):
//   * a keyless lightningd (--network=sequentia-testnet) whose hsmd is the Noise-proxy
//     subdaemon (subdaemon=hsmd:lightning_hsmd_proxy) — NO local hsm_secret. The only
//     signer is the user's device, so the LSP can command but never move funds.
//   * the proxy's Noise responder listens on SEQLN_SIGNER_LISTEN (a private TCP port);
//     SEQLN_HOST_PRIVKEY_FILE is the node's Noise static key (its pubkey is what the
//     device pins); SEQLN_SIGNER_PEER_PUBKEY is the DEVICE's transport pubkey the host
//     pins — THIS is the per-device keying (only that device may sign for this node).
//   * a keyless WS<->TCP relay (seqln-ws-relay.mjs) fronts the responder so a browser
//     device can reach it over WebSocket. The relay holds no key (Noise is end-to-end).
//
// Non-custodial + idempotent: re-provisioning the same (asset, device) returns the SAME
// node (same dir/ports/host key), so the device's derived node identity is stable and a
// funded channel is never orphaned. Provisioning creates NO keys that can spend funds.
//
// Public exposure: the relay listens on a private ws port; a browser reaches it through
// the TLS front (Caddy `wss://.../lsp-ws-node/<id>` -> ws://127.0.0.1:<wsPort>). The one
// deploy prerequisite for arbitrary browsers is that wildcard front; on the box the
// mechanism is proven end-to-end over the private ws port with the device-harness.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

// Derive a secp256k1 compressed pubkey (33-byte hex) from a 32-byte hex privkey, the
// same Noise static-key form the device + host use. Uses Node's own EC (no wasm dep):
// an ECDH private key -> its compressed public point.
function pubkeyOf(privHex) {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(privHex, 'hex'));
  return ecdh.getPublicKey('hex', 'compressed');
}

// A provisioning context, built once from the LSP env.
export function makeProvisioner(opts) {
  const CFG = {
    dir: opts.dir,                       // base dir for provisioned nodes + registry
    lightningd: opts.lightningd,         // seqln lightningd binary
    hsmdProxy: opts.hsmdProxy,           // lightning_hsmd_proxy subdaemon
    wsRelay: opts.wsRelay,               // seqln-ws-relay.mjs
    node: opts.node,                     // node22 binary (to run the relay)
    lncli: opts.lncli,                   // lightning-cli
    network: opts.network || 'sequentia-testnet',
    elementsCli: opts.elementsCli,       // bitcoin-cli= for the config (elements-cli)
    rpcConnect: opts.rpcConnect || '127.0.0.1',
    rpcPort: opts.rpcPort,               // Sequentia (elements) node RPC port
    rpcUser: opts.rpcUser, rpcPass: opts.rpcPass,
    // Port bases: each node claims addrPort, signerPort, wsPort from these ranges.
    addrBase: opts.addrBase || 9760,
    signerBase: opts.signerBase || 9800,
    wsBase: opts.wsBase || 18800,
    publicWsBase: opts.publicWsBase || '/lsp-ws-node',   // Caddy front path prefix
  };
  fs.mkdirSync(CFG.dir, { recursive: true });
  const REG = path.join(CFG.dir, 'registry.json');

  const load = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch { return { nodes: {}, seq: 0 }; } };
  const save = (r) => fs.writeFileSync(REG, JSON.stringify(r, null, 2));

  // A stable key per (asset, device). One device today, so keyed by asset; the device
  // pubkey is recorded + must match on re-provision (a different device => a new node).
  const keyOf = (assetId) => assetId.toLowerCase();

  function nodeRpcAlive(rec) {
    try { execFile(CFG.lncli, [`--rpc-file=${rec.rpc}`, 'getinfo']); return true; } catch { return false; }
  }

  // Is the node's lightning-rpc answering? (async, real check)
  function getinfo(rec) {
    return new Promise((resolve) => {
      execFile(CFG.lncli, [`--rpc-file=${rec.rpc}`, 'getinfo'], { timeout: 8000 }, (err, out) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
    });
  }

  // Provision (or return the existing) hosted node for `assetId`, keyed to the device's
  // transport pubkey. Boots lightningd + the relay if not already running.
  async function provision({ assetId, deviceTransportPubkey, label }) {
    if (!/^[0-9a-fA-F]{64}$/.test(assetId)) throw new Error('assetId must be a 32-byte hex id');
    if (!/^[0-9a-fA-F]{66}$/.test(deviceTransportPubkey || '')) throw new Error('deviceTransportPubkey must be a 33-byte compressed pubkey hex');
    const reg = load();
    const key = keyOf(assetId);
    let rec = reg.nodes[key];

    if (rec) {
      // Idempotent: the SAME device re-attaching gets the same node. A DIFFERENT device
      // is refused (its funds would live under a different node identity) — fail closed.
      if (rec.deviceTransportPubkey.toLowerCase() !== deviceTransportPubkey.toLowerCase()) {
        throw new Error('this asset node is already provisioned for a different device');
      }
      const info = await getinfo(rec);
      if (info) { rec.node_id = info.id; rec.status = 'running'; save(reg); return rec; }
      // Node dir exists but lightningd is down -> re-boot it (crash-safe: same dir/keys).
      bootNode(rec, deviceTransportPubkey);
      rec.status = 'booting'; save(reg);
      return rec;
    }

    // Fresh provision: claim the next port slot + write the node dir.
    const idx = reg.seq++;
    const addrPort = CFG.addrBase + idx;
    const signerPort = CFG.signerBase + idx;
    const wsPort = CFG.wsBase + idx;
    const id = `${(label || assetId.slice(0, 8))}-${idx}`.replace(/[^a-zA-Z0-9._-]/g, '');
    const dir = path.join(CFG.dir, `node-${id}`);
    fs.mkdirSync(dir, { recursive: true });

    // Host Noise static keypair (the node's identity the device pins). Random 32 bytes.
    const hostPriv = crypto.randomBytes(32).toString('hex');
    const hostPub = pubkeyOf(hostPriv);
    fs.writeFileSync(path.join(dir, 'host_priv'), hostPriv, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'host_pub'), hostPub + '\n', { mode: 0o644 });

    const config = [
      `bitcoin-rpcuser=${CFG.rpcUser}`,
      `bitcoin-rpcpassword=${CFG.rpcPass}`,
      `bitcoin-rpcconnect=${CFG.rpcConnect}`,
      `bitcoin-rpcport=${CFG.rpcPort}`,
      `bitcoin-cli=${CFG.elementsCli}`,
      `addr=127.0.0.1:${addrPort}`,
      'funding-confirms=1',
      'allow-deprecated-apis=true',
      'force-feerates=5000',
      'log-level=debug',
      `log-file=${path.join(dir, 'lightningd.log')}`,
      `subdaemon=hsmd:${CFG.hsmdProxy}`,
      'rescan=-1',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'config'), config);

    rec = {
      key, asset_id: assetId.toLowerCase(), label: label || assetId.slice(0, 8),
      dir, addrPort, signerPort, wsPort,
      ws_port: wsPort, public_ws_path: `${CFG.publicWsBase}/${id}`,
      host_pubkey: hostPub, deviceTransportPubkey: deviceTransportPubkey.toLowerCase(),
      rpc: path.join(dir, CFG.network, 'lightning-rpc'),
      network: CFG.network, node_id: null, status: 'booting', created_ms: Date.now(),
    };
    reg.nodes[key] = rec;
    save(reg);
    bootNode(rec, deviceTransportPubkey);
    return rec;
  }

  // Boot (or re-boot) lightningd + the ws relay for a node record, detached.
  function bootNode(rec, deviceTransportPubkey) {
    const env = {
      ...process.env,
      SEQLN: path.dirname(path.dirname(CFG.lightningd)),
      SEQLN_SIGNER_LISTEN: `127.0.0.1:${rec.signerPort}`,
      SEQLN_HOST_PRIVKEY_FILE: path.join(rec.dir, 'host_priv'),
      SEQLN_SIGNER_PEER_PUBKEY: (deviceTransportPubkey || rec.deviceTransportPubkey),
    };
    const lnLog = fs.openSync(path.join(rec.dir, 'boot.out'), 'a');
    const ld = spawn(CFG.lightningd,
      [`--lightning-dir=${rec.dir}`, `--network=${CFG.network}`, '--developer'],
      { env, detached: true, stdio: ['ignore', lnLog, lnLog] });
    ld.unref();
    // The relay: ws front -> the proxy's Noise responder. --tcp-retry-ms rides out the
    // gap before lightningd execs the proxy (which binds the responder at startup).
    const relayLog = fs.openSync(path.join(rec.dir, 'relay.out'), 'a');
    const rl = spawn(CFG.node,
      [CFG.wsRelay, '--ws-port', String(rec.wsPort), '--tcp', `127.0.0.1:${rec.signerPort}`, '--tcp-retry-ms', '120000'],
      { detached: true, stdio: ['ignore', relayLog, relayLog] });
    rl.unref();
    rec.pids = { lightningd: ld.pid, relay: rl.pid };
  }

  function list() { const reg = load(); return Object.values(reg.nodes); }
  function get(assetId) { const reg = load(); return reg.nodes[keyOf(assetId)] || null; }
  async function refresh(assetId) {
    const rec = get(assetId); if (!rec) return null;
    const info = await getinfo(rec);
    if (info) { const reg = load(); reg.nodes[rec.key].node_id = info.id; reg.nodes[rec.key].status = 'running'; save(reg); return reg.nodes[rec.key]; }
    return rec;
  }

  return { provision, list, get, refresh, getinfo, pubkeyOf, CFG };
}

export { pubkeyOf };
