// Two-node cross-chain rail: derive the per-node device keys for provisioning.
//
// Reproduces, OUTSIDE the browser, the exact per-node device identities the
// wallet derives from the user's ONE mnemonic (single source of truth:
// ../../seqln-keys.js). Use it to provision the two hosted SeqLN nodes and to
// drive the Node device-harness (device-harness.mjs) as a browser stand-in for a
// local end-to-end test.
//
// For each node ('asset' on Sequentia, 'btc' on testnet4) it derives:
//   * transport privkey  (Noise static key)  -> written to <out>/<node>.transport.hex
//   * transport PUBKEY   (host pins this)     -> printed + written to <out>/<node>.transport.pub
//   * signing seed       (keyless node's LN identity) -> the on-disk hsm_secret
//                        form `32 zero bytes || <signingSeed>` -> <out>/<node>.hsm_secret
//
// The hsm_secret file + transport privkey file feed device-harness.mjs directly:
//   node device-harness.mjs asset <wsUrlAsset> <out>/asset.hsm_secret <hostPubAsset> <out>/asset.transport.hex
//   node device-harness.mjs btc   <wsUrlBtc>   <out>/btc.hsm_secret   <hostPubBtc>   <out>/btc.transport.hex
// (the node id each prints is the hosted node's identity — provision that node
// keyless and pin the matching transport PUBKEY as SEQLN_SIGNER_PEER_PUBKEY).
//
// Secret hygiene: the mnemonic is read from a FILE (never argv/ps); secret files
// are written 0600; only the transport PUBKEYS (safe to share/pin) hit stdout.
//
// Usage:
//   node derive-node-keys.mjs <mnemonic_file> <out_dir> [asset|btc|both]
//
// Requires Node >= 22 (the same globals the browser provides).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lnDeriveNode, LN_PATHS, LN_NODES } from '../../seqln-keys.js';
import { SeqlnSigner } from '../../lightning/seqln-signer-sdk.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = readFileSync(join(HERE, '..', '..', 'lightning', 'pkg', 'seqln_signer_wasm_bg.wasm'));

const [mnemonicFile, outDir, whichArg] = process.argv.slice(2);
if (!mnemonicFile || !outDir) {
  console.error('usage: node derive-node-keys.mjs <mnemonic_file> <out_dir> [asset|btc|both]');
  process.exit(2);
}
const which = (whichArg || 'both').toLowerCase();
const nodes = which === 'both' ? LN_NODES : [which];
for (const n of nodes) if (!LN_NODES.includes(n)) { console.error(`unknown node: ${n}`); process.exit(2); }

const mnemonic = readFileSync(mnemonicFile, 'utf8').trim().replace(/\s+/g, ' ');
if (!mnemonic) { console.error('empty mnemonic file'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

// The wasm `fromMnemonic(seed)` builds hsm_secret = 32 zero bytes || utf8(seed).
// Reproduce those exact on-disk bytes so device-harness.mjs (fromHsmSecret) and
// the browser (fromMnemonic) derive the SAME keyless-node identity.
function hsmSecretBytes(signingSeed) {
  const m = new TextEncoder().encode(signingSeed);
  const b = new Uint8Array(32 + m.length);
  b.set(m, 32);
  return b;
}

for (const node of nodes) {
  const d = lnDeriveNode(mnemonic, node);
  const pub = await SeqlnSigner.devicePubkey(d.transportPrivkey, { wasm: WASM });

  const transportHexPath = join(outDir, `${node}.transport.hex`);
  const transportPubPath = join(outDir, `${node}.transport.pub`);
  const hsmSecretPath = join(outDir, `${node}.hsm_secret`);

  writeFileSync(transportHexPath, d.transportPrivkey, { mode: 0o600 });
  writeFileSync(transportPubPath, pub + '\n', { mode: 0o644 });
  writeFileSync(hsmSecretPath, Buffer.from(hsmSecretBytes(d.signingSeed)), { mode: 0o600 });

  console.log(`--- ${node} node ---`);
  console.log(`  transport path   ${LN_PATHS[node].transport}`);
  console.log(`  signing path     ${LN_PATHS[node].signing}`);
  console.log(`  device pubkey    ${pub}   (pin as SEQLN_SIGNER_PEER_PUBKEY on the hosted ${node} node)`);
  console.log(`  hsm_secret file  ${hsmSecretPath}   (device-harness.mjs <hsm_secret_file>)`);
  console.log(`  transport file   ${transportHexPath}   (device-harness.mjs <device_priv_file>)`);
}
console.log('\nSecrets written 0600 under', outDir, '— keep out of git (add to .gitignore).');
