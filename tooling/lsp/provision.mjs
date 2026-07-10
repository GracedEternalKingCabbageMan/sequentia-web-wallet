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
    // Per-chain bitcoin backend. 'seq' (Sequentia/elements) is the default asset
    // chain; 'btc' (testnet4) is added by the LSP env so ONE provisioner can boot
    // BOTH a per-asset Sequentia node AND a per-user testnet4 BTC node. Each chain
    // carries its own bitcoin RPC (port/user/pass), bitcoin-cli, lightningd network,
    // funding feerate, and extra config lines.
    chains: {
      seq: {
        network: opts.network || 'sequentia-testnet',
        rpcConnect: opts.rpcConnect || '127.0.0.1',
        rpcPort: opts.rpcPort, rpcUser: opts.rpcUser, rpcPass: opts.rpcPass,
        cli: opts.elementsCli, feerate: 5000, extra: ['rescan=-1'],
      },
      ...(opts.chains || {}),
    },
    // Port bases: each node claims addrPort, signerPort, wsPort from these ranges.
    // Env-overridable so a second (live) LSP can avoid colliding with a running one.
    addrBase: opts.addrBase || 9760,
    signerBase: opts.signerBase || 9800,
    wsBase: opts.wsBase || 18800,
    publicWsBase: opts.publicWsBase || '/lsp-ws-node',   // Caddy front path prefix
  };
  fs.mkdirSync(CFG.dir, { recursive: true });
  const REG = path.join(CFG.dir, 'registry.json');

  const load = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch { return { nodes: {}, seq: 0 }; } };
  const save = (r) => fs.writeFileSync(REG, JSON.stringify(r, null, 2));

  // Registry key. BOTH chains are keyed by (asset, DEVICE) so each user gets their OWN
  // non-custodial hosted node with their own funds/channels — two different devices
  // provisioning the same asset get two DISTINCT nodes, and the same device re-provisioning
  // re-attaches its existing node (idempotent). A btc node is device-only (`btc:<pub>`, one
  // native testnet4 node per device); a seq node is asset+device (`seq:<assetId>:<pub>`).
  // The device pubkey is baked into the key, so a cross-device collision is impossible.
  // Back-compat: legacy seq nodes keyed by a bare asset id remain resolvable via getByKey /
  // the asset scan below; they are never orphaned, only superseded per device going forward.
  const keyOf = (chain, assetId, devicePub) =>
    chain === 'btc'
      ? `btc:${(devicePub || '').toLowerCase()}`
      : `seq:${assetId.toLowerCase()}:${(devicePub || '').toLowerCase()}`;

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
  async function provision({ assetId, deviceTransportPubkey, label, chain = 'seq' }) {
    const chainCfg = CFG.chains[chain];
    if (!chainCfg) throw new Error(`unknown chain '${chain}' (want 'seq' or 'btc')`);
    if (!/^[0-9a-fA-F]{66}$/.test(deviceTransportPubkey || '')) throw new Error('deviceTransportPubkey must be a 33-byte compressed pubkey hex');
    // A seq node is asset-denominated; a btc node holds native testnet4 BTC (no asset id).
    if (chain === 'seq') {
      if (!/^[0-9a-fA-F]{64}$/.test(assetId)) throw new Error('assetId must be a 32-byte hex id');
    } else {
      assetId = 'btc';
    }
    const reg = load();
    const key = keyOf(chain, assetId, deviceTransportPubkey);
    let rec = reg.nodes[key];

    if (rec) {
      // Idempotent: the SAME device re-attaching gets the same node. A DIFFERENT device
      // is refused (its funds would live under a different node identity) — fail closed.
      if (rec.deviceTransportPubkey.toLowerCase() !== deviceTransportPubkey.toLowerCase()) {
        throw new Error(`this ${chain} node is already provisioned for a different device`);
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
    const baseLabel = label || (chain === 'btc' ? 'BTC' : assetId.slice(0, 8));
    const id = `${baseLabel}-${idx}`.replace(/[^a-zA-Z0-9._-]/g, '');
    const dir = path.join(CFG.dir, `node-${id}`);
    fs.mkdirSync(dir, { recursive: true });

    // Host Noise static keypair (the node's identity the device pins). Random 32 bytes.
    const hostPriv = crypto.randomBytes(32).toString('hex');
    const hostPub = pubkeyOf(hostPriv);
    fs.writeFileSync(path.join(dir, 'host_priv'), hostPriv, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'host_pub'), hostPub + '\n', { mode: 0o644 });

    const config = [
      `bitcoin-rpcuser=${chainCfg.rpcUser}`,
      `bitcoin-rpcpassword=${chainCfg.rpcPass}`,
      `bitcoin-rpcconnect=${chainCfg.rpcConnect || CFG.chains.seq.rpcConnect || '127.0.0.1'}`,
      `bitcoin-rpcport=${chainCfg.rpcPort}`,
      `bitcoin-cli=${chainCfg.cli}`,
      `addr=127.0.0.1:${addrPort}`,
      'funding-confirms=1',
      'allow-deprecated-apis=true',
      `force-feerates=${chainCfg.feerate}`,
      'log-level=debug',
      `log-file=${path.join(dir, 'lightningd.log')}`,
      `subdaemon=hsmd:${CFG.hsmdProxy}`,
      ...(chainCfg.extra || []),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'config'), config);

    rec = {
      key, chain, asset_id: chain === 'btc' ? 'btc' : assetId.toLowerCase(), label: baseLabel,
      dir, addrPort, signerPort, wsPort,
      ws_port: wsPort, public_ws_path: `${CFG.publicWsBase}/${id}`,
      host_pubkey: hostPub, deviceTransportPubkey: deviceTransportPubkey.toLowerCase(),
      rpc: path.join(dir, chainCfg.network, 'lightning-rpc'),
      network: chainCfg.network, node_id: null, status: 'booting', created_ms: Date.now(),
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
      [`--lightning-dir=${rec.dir}`, `--network=${rec.network}`, '--developer'],
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
  // First seq node for `assetId` on ANY device — a coarse legacy fallback (targetFor uses
  // it only when the caller passes no device-scoped node key). Nodes are now device-scoped
  // (`seq:<assetId>:<pub>`), so this scans by asset id and also matches legacy bare-asset
  // keyed nodes (never orphaned). Per-device resolution goes through getByKey(node key).
  function get(assetId) {
    const reg = load(); const want = String(assetId).toLowerCase();
    return Object.values(reg.nodes).find((r) => (r.chain || 'seq') !== 'btc' && r.asset_id === want)
      || reg.nodes[want] || null;
  }
  // Direct registry-key lookup (`seq:<assetId>:<pub>` or `btc:<pub>`, or a legacy bare id).
  function getByKey(key) { const reg = load(); return reg.nodes[String(key).toLowerCase()] || null; }
  // Resolve the node whose public_ws_path is `${publicWsBase}/<id>` — the lookup the
  // central ws-router does to bridge `GET /lsp-ws-node/<id>` to that node's responder.
  // public_ws_path carries the unique per-node `<label>-<idx>`, so it stays 1:1 even when
  // several device-scoped nodes share one asset.
  function getByWsId(id) {
    const want = `${CFG.publicWsBase}/${id}`;
    const reg = load();
    return Object.values(reg.nodes).find((r) => r.public_ws_path === want) || null;
  }
  // Refresh ONE node's live node_id/status by its registry KEY (not asset id — several
  // device-scoped nodes can share an asset id, so each must be refreshed independently).
  async function refresh(key) {
    const reg0 = load(); const rec = reg0.nodes[String(key).toLowerCase()]; if (!rec) return null;
    const info = await getinfo(rec);
    if (info) { const reg = load(); reg.nodes[rec.key].node_id = info.id; reg.nodes[rec.key].status = 'running'; save(reg); return reg.nodes[rec.key]; }
    return rec;
  }

  return { provision, list, get, getByKey, getByWsId, refresh, getinfo, pubkeyOf, CFG };
}

export { pubkeyOf };
