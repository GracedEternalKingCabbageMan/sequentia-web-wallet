// ---------------------------------------------------------------------------
// seqln-keys.js — deterministic per-node key derivation for the two-node
// cross-chain Lightning rail (LSP / hosted-SeqLN, Tier-2).
//
// The cross-chain pure-LN rail is TWO hosted SeqLN nodes co-signed by ONE thin
// wallet: an ASSET node (holds the GOLD channel on Sequentia) and a BTC node
// (holds the BTC channel on testnet4). Both hosted nodes are KEYLESS — the
// browser device is the sole signer for BOTH — so the user's ONE mnemonic must
// deterministically yield TWO independent device identities. This module is the
// single source of truth for that derivation, imported by BOTH the wallet
// (index.html) and any Node provisioning/test harness so they derive identically.
//
// Per hosted node we derive two independent keys from the one BIP39 wallet seed:
//
//   * transportPrivkey — the BOLT-8 Noise_XK static privkey the device uses to
//     authenticate to the hosted node's responder. Its pubkey is what the LSP
//     operator PINS (`SEQLN_SIGNER_PEER_PUBKEY`) when provisioning the node.
//
//   * signingSeed — the string fed to `SeqlnSigner.fromMnemonic` (the wasm
//     Signer synthesizes the on-disk `32 zero bytes || <signingSeed>` hsm_secret
//     form). Because the hosted node is keyless, THIS value alone determines the
//     node's LN identity (node_id + channel keys); it is derived, deterministic,
//     and unique per node, so the same node_id (and its channels) survive across
//     sessions and are recoverable from the wallet mnemonic.
//
// Derivation paths (all hardened, from the one wallet BIP39 seed). The branch
// index selects the ROLE (0' = Noise transport, 1' = SeqLN signing seed) and the
// leaf selects the NODE (0' = asset/Sequentia, 1' = btc/testnet4):
//
//   m/1017'/0'/0'   asset node  Noise transport privkey   (== the legacy single-node transport path)
//   m/1017'/0'/1'   btc   node  Noise transport privkey
//   m/1017'/1'/0'   asset node  SeqLN signing seed
//   m/1017'/1'/1'   btc   node  SeqLN signing seed
//
// Transport and signing keys live on SEPARATE branches so no 32-byte child is
// ever reused for two cryptographic roles. The asset transport reuses the legacy
// `m/1017'/0'/0'` path so a re-provisioned asset node can pin the same device
// pubkey the old single-node build registered.
//
// The signingSeed is the hex of the child privkey (64 lowercase hex chars). The
// M2a wasm Signer treats the "mnemonic" string opaquely (no BIP39 checksum
// validation — verified), and since the device is the sole signer of a keyless
// node, a deterministic unique string is all that is required; a checksummed
// BIP39 phrase would need the 2048-word English list, which this wallet bundle
// deliberately does not ship. (If a future non-keyless fallback node ever needs a
// loadable phrase, swap `signingSeed` for a real entropy->mnemonic here — the two
// call sites read it through `lnDeriveNode` and need no change.)
// ---------------------------------------------------------------------------

import { HDKey, mnemonicToSeedSync } from './btc.js';

// Role branch (0' transport, 1' signing) + node leaf (0' asset, 1' btc).
export const LN_PATHS = {
  asset: { transport: "m/1017'/0'/0'", signing: "m/1017'/1'/0'" },
  btc:   { transport: "m/1017'/0'/1'", signing: "m/1017'/1'/1'" },
};

export const LN_NODES = ['asset', 'btc'];

function normPhrase(phrase) {
  return String(phrase).trim().replace(/\s+/g, ' ');
}
function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
function childPriv(master, path) {
  const k = master.derive(path);
  if (!k.privateKey) throw new Error('no private key at ' + path);
  return toHex(k.privateKey);
}

// Derive both keys for one node ('asset' | 'btc') from the wallet mnemonic.
// Returns { transportPrivkey, signingSeed } (both 64-hex).
export function lnDeriveNode(phrase, node) {
  const p = LN_PATHS[node];
  if (!p) throw new Error('unknown LN node: ' + node);
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(normPhrase(phrase)));
  return {
    node,
    transportPrivkey: childPriv(master, p.transport),
    signingSeed: childPriv(master, p.signing),
    paths: { ...p },
  };
}

// Derive every node's keys in one pass: { asset:{...}, btc:{...} }.
export function lnDeriveAll(phrase) {
  const master = HDKey.fromMasterSeed(mnemonicToSeedSync(normPhrase(phrase)));
  const out = {};
  for (const node of LN_NODES) {
    const p = LN_PATHS[node];
    out[node] = {
      node,
      transportPrivkey: childPriv(master, p.transport),
      signingSeed: childPriv(master, p.signing),
      paths: { ...p },
    };
  }
  return out;
}

export default { LN_PATHS, LN_NODES, lnDeriveNode, lnDeriveAll };
