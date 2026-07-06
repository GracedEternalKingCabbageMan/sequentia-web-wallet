// Browser-model device signer harness (SeqLN Tier-2, B5b-2a).
//
// This is the EXACT in-browser Lightning rail minus the DOM: it loads the same
// vendored wasm signer (../../lightning/pkg) through the same vendored SDK
// (../../lightning/seqln-signer-sdk.js) the wallet page imports, opens a real
// WebSocket to the hosted node's Noise_XK responder (through the WS<->TCP relay),
// authenticates with BOLT-8 Noise_XK, and SERVES the hosted lightningd's hsmd
// sign-request stream from wasm for the life of the connection. The host holds no
// key; it only asks the device (this wasm signer) to co-sign.
//
// The node id is derived by the wasm over the link, so seeding from the same
// hsm_secret keeps the hosted node's identity (and its existing channels) intact.
//
// Usage:
//   node device-harness.mjs <label> <wsUrl> <hsm_secret_file> <host_pub_hex> <device_priv_hex> [--enforce]
//
// It prints the transport pubkey the host must pin, the Noise result, the derived
// node id (NODE_ID <hex> on stdout for the parent to compare against getinfo), a
// live per-request co-sign log, and a periodic tally, then serves until the link
// closes. Requires Node >= 22 (global WebSocket + crypto.getRandomValues), the
// same globals a browser provides.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SeqlnSigner } from '../../lightning/seqln-signer-sdk.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = readFileSync(join(HERE, '..', '..', 'lightning', 'pkg', 'seqln_signer_wasm_bg.wasm'));

const [label, wsUrl, secretPath, hostPubHex, devicePrivHex, ...rest] = process.argv.slice(2);
if (!label || !wsUrl || !secretPath || !hostPubHex || !devicePrivHex) {
  console.error('usage: node device-harness.mjs <label> <wsUrl> <hsm_secret_file> <host_pub_hex> <device_priv_hex> [--enforce]');
  process.exit(2);
}
const enforce = rest.includes('--enforce');

// hsmd types that constitute the device actually CO-SIGNING money movement, so the
// log makes the proof obvious (as opposed to read-only ECDH/point derivation).
const COSIGN = new Set([5, 7, 12, 13, 14, 19, 20, 21, 142, 143, 144]);
const NAME = {
  1: 'ECDH', 5: 'SIGN_COMMITMENT_TX', 7: 'SIGN_WITHDRAWAL', 8: 'SIGN_INVOICE',
  11: 'INIT', 12: 'SIGN_DELAYED_PAYMENT_TO_US', 13: 'SIGN_REMOTE_HTLC_TO_US',
  14: 'SIGN_PENALTY_TO_US', 18: 'GET_PER_COMMITMENT_POINT', 19: 'SIGN_REMOTE_COMMITMENT_TX',
  20: 'SIGN_REMOTE_HTLC_TX', 21: 'SIGN_MUTUAL_CLOSE_TX',
  142: 'SIGN_ANY_DELAYED_PAYMENT_TO_US', 143: 'SIGN_ANY_REMOTE_HTLC_TO_US', 144: 'SIGN_ANY_PENALTY_TO_US',
};

const secret = new Uint8Array(readFileSync(secretPath));
const signer = await SeqlnSigner.fromHsmSecret(secret, { wasm: WASM });
if (enforce) signer.setPolicy('enforce');

signer.onStatus = (st) => {
  if (st.state === 'node_id') console.error(`[${label}] wasm derived node id ${st.nodeId}`);
  else console.error(`[${label}] noise: [${st.state}] ${st.detail || ''}`);
};
signer.onRequest = (r) => {
  const tag = COSIGN.has(r.type) ? 'CO-SIGN' : 'served';
  if (COSIGN.has(r.type) || r.rejected || r.seq <= 6)
    console.error(`[${label}]   #${r.seq} ${tag} ${r.name} -> ${r.rejected ? 'REJECTED (policy)' : r.replyBytes + 'B'}`);
};

const devicePub = await SeqlnSigner.devicePubkey(devicePrivHex, { wasm: WASM });
console.error(`[${label}] device transport pubkey ${devicePub} (host pins this)`);
console.error(`[${label}] connecting ${wsUrl} (Noise_XK initiator, policy=${enforce ? 'enforce' : 'permissive'})`);

try {
  await signer.connect({ wsUrl, hostStaticPubkey: hostPubHex, deviceStaticPrivkey: devicePrivHex });
} catch (e) {
  console.error(`[${label}] connect failed: ${e.message}`);
  process.exit(1);
}

try {
  const id = await signer.whenNodeId(30000);
  console.log(`NODE_ID ${label} ${id}`);
} catch (e) {
  console.error(`[${label}] ${e.message}`);
}

function dumpTally() {
  const counts = [...signer.servedCounts().entries()].sort((a, b) => a[0] - b[0]);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  const cosigns = counts.filter(([t]) => COSIGN.has(t)).reduce((s, [, n]) => s + n, 0);
  console.error(`[${label}] served ${total} hsmd requests (${cosigns} co-signs): ` +
    counts.map(([t, n]) => `${NAME[t] || 'type' + t}:${n}`).join(' '));
}
const iv = setInterval(() => {
  if (signer.state() === 'closed' || signer.state() === 'error') { clearInterval(iv); dumpTally(); process.exit(0); }
}, 500);
process.on('SIGTERM', () => { dumpTally(); process.exit(0); });
process.on('SIGINT', () => { dumpTally(); process.exit(0); });
