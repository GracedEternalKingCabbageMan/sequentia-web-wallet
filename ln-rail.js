// ---------------------------------------------------------------------------
// ln-rail.js — HONEST per-asset Lightning-rail gating for the swap composer.
//
// The swap composer may only OFFER the Lightning settlement rail for a leg when
// there is a REAL, usable Lightning channel for THAT asset (or BTC) — never merely
// because "the LSP is configured" or the device signers are connected. This module
// turns a live LSP /status snapshot (its per-asset `channels`, leg-tagged with
// spendable/receivable) plus the provisioned-node state into a per-leg decision:
//
//   * can this leg PAY from Lightning?     (needs an active channel w/ spendable)
//   * can this leg RECEIVE to Lightning?   (needs an active channel w/ receivable)
//
// and, when it cannot, WHY and what to do about it (Move to Lightning first, or add
// liquidity). It is 100% pure (no DOM, no fetch), so it is unit-testable in Node and
// the composer just reads its verdict. Bitcoin has no channel => no BTC LN leg; an
// asset with no channel => no asset LN leg; a channel that is merely OPENING (not yet
// CHANNELD_*) is NOT usable. This is what kills the old "LSP configured => flash the
// LN rail then silently fall back" bug.
// ---------------------------------------------------------------------------

function big(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  try { return BigInt(v); } catch { return BigInt(Math.trunc(Number(v) || 0)); }
}

// Does channel `c` belong to leg `target`? `target` is the string 'BTC' (the parent
// chain leg) or an asset descriptor { hex, ticker }. A channel is BTC-tagged when its
// asset_label is 'BTC' or it carries a btc leg/chain tag; otherwise it is an asset
// channel, matched by asset id (hex) OR by its ticker label.
export function channelMatches(c, target) {
  if (!c) return false;
  const isBtc = c.asset_label === 'BTC' || c.leg === 'btc' || c.chain === 'btc';
  if (target === 'BTC') return isBtc;
  if (isBtc) return false;
  const hex = String(target.hex || '').toLowerCase();
  const tkr = String(target.ticker || '').toUpperCase();
  const cHex = String(c.asset || c.asset_id || c.channel_asset || '').toLowerCase();
  const cLbl = String(c.asset_label || c.ticker || '').toUpperCase();
  return (!!hex && cHex === hex) || (!!tkr && cLbl === tkr);
}

// A channel is USABLE for a swap leg only while it is in a normal operating state
// (CHANNELD_NORMAL / CHANNELD_AWAITING_LOCKIN etc.). An opening/closing/onchain
// channel carries no live routable liquidity, so it must NOT enable the LN rail.
export function channelActive(c) {
  return String((c && c.state) || '').toUpperCase().startsWith('CHANNELD');
}

// Aggregate the live liquidity across every ACTIVE channel matching `target`.
export function legLiquidity(channels, target) {
  let active = false, spendable = 0n, receivable = 0n, count = 0;
  for (const c of channels || []) {
    // Only the wallet's OWN device-provisioned channels (carry a node_key) count for rail
    // liquidity — never shared/demo-topology channels the LSP's /status also returns. Keeps the
    // Swap tab consistent with the Balance tab: a wallet can only pay/receive over Lightning
    // with channels it actually controls (a fresh wallet has none until it moves funds in).
    if (!c.node_key) continue;
    if (!channelMatches(c, target) || !channelActive(c)) continue;
    active = true; count++;
    spendable += big(c.spendable_units ?? c.spendable ?? 0);
    receivable += big(c.receivable_units ?? c.receivable ?? 0);
  }
  return { active, spendable, receivable, count };
}

export function hasChannel(channels, target) { return legLiquidity(channels, target).active; }
export function canPayFrom(channels, target) { const l = legLiquidity(channels, target); return l.active && l.spendable > 0n; }
export function canReceiveTo(channels, target) { const l = legLiquidity(channels, target); return l.active && l.receivable > 0n; }

function legName(target) { return target === 'BTC' ? 'BTC' : (target.ticker || 'this asset'); }

// The per-leg verdict for offering the Lightning rail. `direction` is 'pay' (this leg
// SENDS over Lightning -> needs spendable) or 'recv' (this leg RECEIVES over Lightning
// -> needs receivable). `provisioned` is the optional provisionedState() map
// (assetHexLower -> { connected, phase }); a provisioned-but-channel-less node changes
// only the wording of the fix (the node is ready, just fund a channel).
//
// Returns { ok, reason, cta, ctaLabel, hint, liquidity }:
//   ok        true  -> the leg may settle over Lightning (surface the LN button live)
//   reason    human-readable why-not (empty when ok)
//   cta       'move' -> route the user to Move-to-Lightning (no channel at all)
//             'add'  -> a channel exists but this side has no room (add / rebalance)
//   ctaLabel  a short button/link label for that action
export function legOption(channels, target, direction, provisioned) {
  const l = legLiquidity(channels, target);
  const name = legName(target);
  if (!l.active) {
    const key = target === 'BTC' ? null : String(target.hex || '').toLowerCase();
    const nodeUp = !!(key && provisioned && provisioned[key] && provisioned[key].connected);
    return {
      ok: false, reason: `No Lightning channel for ${name} yet.`,
      cta: 'move', ctaLabel: `Move ${name} to Lightning`,
      hint: nodeUp
        ? `Your ${name} Lightning node is ready — open a channel from the Balance tab to trade it instantly.`
        : `Move ${name} into a Lightning channel from the Balance tab first, then this rail turns on.`,
      liquidity: l,
    };
  }
  const enough = direction === 'pay' ? l.spendable > 0n : l.receivable > 0n;
  if (!enough) {
    return direction === 'pay'
      ? { ok: false, reason: `Your ${name} Lightning channel has no spendable balance to pay from.`,
          cta: 'add', ctaLabel: `Add ${name} to Lightning`, hint: `Top up the ${name} channel from the Balance tab.`, liquidity: l }
      : { ok: false, reason: `Your ${name} Lightning channel has no inbound room to receive.`,
          cta: 'add', ctaLabel: `Rebalance ${name}`, hint: `Receive to on-chain, or rebalance the ${name} channel.`, liquidity: l };
  }
  return { ok: true, reason: '', cta: null, ctaLabel: '', hint: '', liquidity: l };
}

// The composite verdict for a BTC<->asset pair: whether EACH leg's LN option is real,
// and whether the pure-LN (both legs on Lightning) route is genuinely available.
//   payTarget  / recvTarget : 'BTC' | { hex, ticker } — the composer's pay/receive legs
export function railAvailability({ channels, provisioned, payTarget, recvTarget }) {
  const payLn = legOption(channels, payTarget, 'pay', provisioned);
  const recvLn = legOption(channels, recvTarget, 'recv', provisioned);
  return { payLn, recvLn, pureLnOk: payLn.ok && recvLn.ok };
}

export default {
  channelMatches, channelActive, legLiquidity, hasChannel, canPayFrom, canReceiveTo,
  legOption, railAvailability,
};
