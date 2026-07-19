// subas-sell-recovery.mjs
// PURE decision logic + shape helpers for sub-asset SELL crash/retry recovery. No I/O, no config,
// no fund movement — lsp-server.mjs wires the real file reads + node RPC around these. Kept
// separate so the FUND-CRITICAL question "may a same-nonce retry re-pay the asset?" is unit-
// testable in isolation (see subas-sell-recovery.test.mjs).
//
// Background: a sub-asset SELL pays the asset over Lightning INSIDE the /swap call. If that work
// is lost (CLI crash, LSP death, dropped response) the wallet retries with the SAME swap_nonce.
// Re-spawning xsubas-sell RE-PAYS the asset — so before re-spawning we must prove the prior
// attempt did NOT already pay. These helpers encode that proof + the settled-result shape.

import path from 'node:path';
import crypto from 'node:crypto';

const HEX32 = /^[0-9a-f]{64}$/i;

// hashPreimageOk verifies SHA256(preimage) == H, so a preimage is trusted only when it actually
// opens the hashlock (defence in depth; the paying node checks this too).
export function hashPreimageOk(hashHex, preimageHex) {
  if (typeof hashHex !== 'string' || typeof preimageHex !== 'string') return false;
  if (!HEX32.test(hashHex) || !HEX32.test(preimageHex)) return false;
  try {
    const got = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
    return got.toLowerCase() === hashHex.toLowerCase();
  } catch { return false; }
}

// subasSellStateFileForNonce returns the DETERMINISTIC per-nonce state-file path (so a retry for
// the same swap finds the prior attempt's file), or null when the nonce is unusable for cross-call
// idempotency. Sanitized for the filesystem; the nonce is client-supplied. The SAME derivation is
// used by the pre-spawn guard and by the spawn path, so both always agree on the path.
export function subasSellStateFileForNonce(tmpdir, swapNonce) {
  if (typeof swapNonce !== 'string') return null;
  const id = swapNonce.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!id) return null;
  return path.join(tmpdir, `xsubas-sell-${id}.json`);
}

// subasSellGuardVerdict decides whether a same-nonce /swap may safely (re-)spawn xsubas-sell —
// which RE-PAYS the asset over Lightning — WITHOUT ever re-paying an asset a prior attempt may
// already have paid. It is the pure core of the pre-spawn guard.
//
//   st         : the parsed prior-attempt state file, or null when no file exists.
//   nodeStatus : { preimage, pending } read from the taker's node for H, or null when the node was
//                NOT consulted or was UNREADABLE (treated as "uncertain").
//
// Returns exactly one of:
//   { kind: 'rerun' }             -> provably no prior pay: no file, or "verified" + the node shows
//                                    NO send for H. Safe to pre-clean + spawn fresh.
//   { kind: 'recover', preimage } -> the asset WAS paid (persisted preimage, or a COMPLETE node
//                                    pay). Reconstruct the settled result; never re-run.
//   { kind: 'hold', reason }      -> a pay may be in flight, OR we cannot prove it is not (verified
//                                    + pending, node unreadable, or an unreadable state file). Do
//                                    NOT re-run; ask the wallet to retry.
//
// FUND-SAFETY: bias to 'hold' under ANY uncertainty. 'rerun' requires POSITIVE proof of no pay.
export function subasSellGuardVerdict(st, nodeStatus) {
  if (!st || typeof st !== 'object') return { kind: 'rerun' };          // no prior state -> genuine (re)attempt
  const bh = st.btc_htlc;
  const hashH = typeof st.hash_h === 'string' ? st.hash_h.toLowerCase() : '';
  if (!bh || !bh.txid || !HEX32.test(hashH)) {
    return { kind: 'hold', reason: 'prior-state-unreadable' };          // exists but unusable -> don't respawn
  }
  // Phase "paid": a persisted preimage that opens the hashlock proves the asset was paid.
  if (typeof st.preimage === 'string' && hashPreimageOk(hashH, st.preimage)) {
    return { kind: 'recover', preimage: st.preimage.toLowerCase() };
  }
  // Phase "verified": defer to the node's view of the outgoing pay for H.
  if (!nodeStatus) return { kind: 'hold', reason: 'node-unreadable' };  // uncertain -> hold, never re-run blind
  if (typeof nodeStatus.preimage === 'string' && hashPreimageOk(hashH, nodeStatus.preimage)) {
    return { kind: 'recover', preimage: nodeStatus.preimage.toLowerCase() };
  }
  if (nodeStatus.pending) return { kind: 'hold', reason: 'pay-in-flight' };
  return { kind: 'rerun' };                                             // node shows NO send for H -> safe
}

// assembleSubasSellSettled builds the settled /swap response shared by the within-call recovery,
// the cross-call pre-spawn recovery, and (shape-wise) the CLI success path. assetLabelStr is the
// already-resolved label STRING (the module stays pure — no lsp config).
export function assembleSubasSellSettled({ assetId, assetLabelStr, nodeKey, hashH, preimageHex,
                                           makerLnNodeId, btcHtlc, note, dt, requestedAmount }) {
  const r = {
    ok: true, side: 'sell', asset: assetId, asset_label: assetLabelStr,
    rail: 'mixed', pay_rail: 'ln', recv_rail: 'chain',
    settled: true, per_user: true, node_key: nodeKey,
    hash_h: hashH, preimage: preimageHex,
    maker_ln_node_id: makerLnNodeId || null, btc_htlc: btcHtlc,
    finality: 'confirming', anchor_bound: true,
    note, recovered: true,
  };
  if (dt != null) { r.eta_seconds = Math.round(dt / 1000); r.settled_ms = dt; }
  if (requestedAmount !== undefined) r.requested_amount = requestedAmount ?? null;
  return r;
}
