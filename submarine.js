// ---------------------------------------------------------------------------
// submarine.js — pure state + persistence for the mixed-rail (SUBMARINE) swap.
//
// A submarine swap trades an asset over ONE rail against BTC over the OTHER: the
// asset leg is an anchored ON-CHAIN HTLC, the BTC leg is Lightning, bound by ONE
// preimage. Unlike the pure-LN rail (instant + final, nothing on-chain), the on-chain
// HTLC leg is a real, time-locked commitment: if the swap stalls, the ONLY way funds
// come back is to REFUND that HTLC after its CLTV timeout. So — exactly like the
// cross-chain wizard (xswap.js) — the in-flight swap MUST be persisted to localStorage
// and RESUMED on load, or a page refresh strands the user with no stepper and no
// "Refund BTC leg" button until the raw timeout.
//
// This module owns that state machine + (storage-injected) persistence, with NO DOM
// and NO fetch, so it is fully unit-testable in Node. swap.js wires the verdicts to
// the trade-process view (render, resume, refund button gating) and the LSP calls.
//
// States:  settling -> {settled | refunding -> refunded | failed}
//   settling   the swap is live: the LN leg is paying / the on-chain HTLC is maturing.
//   refunding  the user has broadcast (or is broadcasting) the HTLC refund.
//   settled    the preimage was revealed on both legs — done (anchor-bound, not the
//              instant-final of pure-LN).
//   refunded   the on-chain HTLC leg was reclaimed after its timeout — funds are back.
//   failed     a hard failure with nothing further to do on-chain.
// ---------------------------------------------------------------------------

export const ST = {
  SETTLING: 'settling',
  REFUNDING: 'refunding',
  REFUNDED: 'refunded',
  SETTLED: 'settled',
  FAILED: 'failed',
};
export const TERMINAL = new Set([ST.SETTLED, ST.REFUNDED, ST.FAILED]);

export function isTerminal(rec) { return !!rec && TERMINAL.has(rec.state); }

// The on-chain HTLC leg is REFUNDABLE only once the chain has buried past its CLTV
// locktime (and the swap is still live). Before that the funds are committed to the
// swap and a refund would be rejected by consensus.
export function isRefundable(rec, tipHeight) {
  if (!rec || isTerminal(rec) || !rec.htlc) return false;
  const lock = Number(rec.htlc.refund_locktime || 0);
  return lock > 0 && Number(tipHeight || 0) >= lock;
}

// Normalize whatever HTLC-leg shape the LSP surfaces into the fields the refund needs.
export function normHtlc(h) {
  if (!h) return null;
  return {
    chain: h.chain || 'seq',
    address: h.address || h.htlc_address || null,
    txid: h.txid || h.htlc_txid || null,
    vout: h.vout ?? null,
    amount: h.amount != null ? String(h.amount) : null,
    refund_locktime: Number(h.refund_locktime || h.locktime || 0) || 0,
    refund_pub: h.refund_pub || null,
    refund_secret: h.refund_secret || null,
    refund_address: h.refund_address || null,
  };
}

// Build the initial in-flight record from the composer quote + the LSP's start
// response. `htlc` is the on-chain HTLC leg the LSP funded (its refund_locktime is what
// gates the refund button); absent for a swap the LSP settles wholly server-side.
export function newSwap({ side, asset, amount, payRail, recvRail, payIsBtc, htlc, id, detail } = {}) {
  const now = Date.now();
  return {
    id: id || ('sub-' + now.toString(16) + '-' + Math.random().toString(16).slice(2, 8)),
    side, asset, amount,
    payRail, recvRail, payIsBtc: !!payIsBtc,
    state: ST.SETTLING,
    htlc: normHtlc(htlc),
    preimage: null,
    detail: detail || '',
    created: now, updated: now,
  };
}

// Advance the record from an LSP /swap or poll response. Recognizes settled/failed and
// otherwise stays SETTLING, capturing any on-chain HTLC leg (so a later refund is
// possible) and the preimage (so a settle is provable). Terminal records are frozen.
export function applyStatus(rec, resp) {
  if (!rec || isTerminal(rec)) return rec;
  const next = { ...rec, updated: Date.now() };
  const fin = String((resp && (resp.finality || resp.status || resp.state)) || '').toLowerCase();
  if (resp && resp.preimage) next.preimage = resp.preimage;
  if (resp && (resp.htlc || resp.onchain_leg)) next.htlc = normHtlc(resp.htlc || resp.onchain_leg);
  if (resp && (resp.detail || resp.message)) next.detail = resp.detail || resp.message;
  if (fin === 'final' || fin === 'settled' || fin === 'complete' || (resp && resp.settled === true)) {
    next.state = ST.SETTLED;
  } else if (fin === 'failed' || fin === 'error' || (resp && resp.ok === false)) {
    next.state = ST.FAILED;
    next.detail = (resp && (resp.error || resp.detail)) || next.detail;
  } else {
    next.state = ST.SETTLING;
  }
  return next;
}

export function markRefunding(rec) { return { ...rec, state: ST.REFUNDING, updated: Date.now() }; }
export function markRefunded(rec, txid) { return { ...rec, state: ST.REFUNDED, refund_txid: txid || null, updated: Date.now() }; }
export function markSettled(rec, preimage) { return { ...rec, state: ST.SETTLED, preimage: preimage || rec.preimage, updated: Date.now() }; }
export function markFailed(rec, reason) { return { ...rec, state: ST.FAILED, detail: reason || rec.detail, updated: Date.now() }; }

// --- persistence (storage is localStorage-shaped: getItem/setItem/removeItem) --------
export function serialize(rec) { return rec ? JSON.stringify(rec) : null; }
export function deserialize(raw) { try { return raw ? JSON.parse(raw) : null; } catch { return null; } }

export function saveSwap(storage, key, rec) {
  try { if (!rec) storage.removeItem(key); else storage.setItem(key, serialize(rec)); } catch {}
  return rec;
}
export function loadSwap(storage, key) {
  try { return deserialize(storage.getItem(key)); } catch { return null; }
}
export function clearSwap(storage, key) { try { storage.removeItem(key); } catch {} }

// On wallet open: rehydrate the persisted swap and DROP it if it is already terminal
// (mirrors the xmaker/covenant resume that cleans settled/refunded records so a stale
// terminal swap never re-shows). Returns the live (non-terminal) record, or null.
export function resume(storage, key) {
  const rec = loadSwap(storage, key);
  if (!rec) return null;
  if (isTerminal(rec)) { clearSwap(storage, key); return null; }
  return rec;
}

export default {
  ST, TERMINAL, isTerminal, isRefundable, normHtlc, newSwap, applyStatus,
  markRefunding, markRefunded, markSettled, markFailed,
  serialize, deserialize, saveSwap, loadSwap, clearSwap, resume,
};
