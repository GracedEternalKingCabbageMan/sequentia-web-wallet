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
// Can the LSP JIT-FRONT this leg for a wallet that holds NO channel of its own? Reads
// /status.frontable (the LP's live inventory). This is what lets a channel-less wallet trade over
// Lightning at all — the whole point of the LSP — so the readiness verdict must see it, not only the
// wallet's own channels. Direction- and leg-aware, mirroring how the LSP actually fronts each leg:
//   • RECEIVE asset X -> the LP opens INBOUND to the user, funded from ITS X inventory -> needs frontable.assets[X].
//   • RECEIVE BTC     -> the LSP DELIVERS BTC over LN from its own outbound              -> needs frontable.btc.out_sat.
//   • PAY asset X     -> the user funds their OWN JIT channel (they hold X); the LP need only be UP to
//                        service an asset LN leg (one node fronts every asset)            -> LP has ANY inventory.
//   • PAY BTC         -> the user pays INTO the LSP, which RECEIVES it                    -> needs frontable.btc.in_sat.
// Any positive amount qualifies (the JIT channel is sized at trade time); we only decide can-it-at-all.
export function lspCanFront(target, direction, frontable) {
  if (!frontable) return false;
  if (target === 'BTC') {
    const b = frontable.btc || {};
    return direction === 'pay' ? big(b.in_sat) > 0n : big(b.out_sat) > 0n;
  }
  const assets = frontable.assets || {};
  if (direction === 'recv') return big(assets[String(target.hex || '').toLowerCase()]) > 0n;
  return Object.values(assets).some((v) => big(v) > 0n);   // pay: the LP being up (any inventory) is enough
}

export function legOption(channels, target, direction, provisioned, frontable) {
  const l = legLiquidity(channels, target);
  const name = legName(target);
  const fronts = lspCanFront(target, direction, frontable);
  if (!l.active) {
    // No own channel. If the LSP can front this leg, it IS Lightning-ready (near-instant, provisioned
    // when the order is placed) — flagged `fronted` so the composer says so instead of nagging.
    if (fronts) return { ok: true, fronted: true, name, direction, reason: '', cta: null, ctaLabel: '', hint: '', liquidity: l };
    const key = target === 'BTC' ? null : String(target.hex || '').toLowerCase();
    const nodeUp = !!(key && provisioned && provisioned[key] && provisioned[key].connected);
    if (frontable == null) {
      // No frontable DATA (the LSP /status didn't carry it, or is briefly unreachable) -> do NOT
      // pessimise: keep the prior assumption that a channel is provisioned INLINE on Place-order
      // (selectable, not blocked). We only gate honestly when we actually KNOW the LSP can't front.
      return { ok: false, provisionable: true, name, direction, reason: `No Lightning channel for ${name} yet.`,
        cta: 'move', ctaLabel: `Move ${name} to Lightning`,
        hint: nodeUp ? `Your ${name} Lightning node is ready. Open a channel from the Balance tab.`
                     : `A ${name} Lightning channel is opened for you when you place the order.`, liquidity: l };
    }
    // No own channel AND the LSP genuinely can't front it -> honestly UNavailable over Lightning.
    return {
      ok: false, unfrontable: true, name, direction, reason: `Lightning isn't available for ${name} right now.`,
      cta: 'move', ctaLabel: `Move ${name} to Lightning`,
      hint: nodeUp
        ? `Your ${name} Lightning node is ready. Open a channel from the Balance tab to trade ${name} over Lightning.`
        : `The service has no ${name} Lightning liquidity to front right now — use on-chain, or move ${name} into a channel from the Balance tab.`,
      liquidity: l,
    };
  }
  const enough = direction === 'pay' ? l.spendable > 0n : l.receivable > 0n;
  if (!enough) {
    // Own channel is short this side — but the LSP can still front it, so it's ready (fronted).
    if (fronts) return { ok: true, fronted: true, name, direction, reason: '', cta: null, ctaLabel: '', hint: '', liquidity: l };
    return direction === 'pay'
      ? { ok: false, name, direction, reason: `Your ${name} Lightning channel has no spendable balance to pay from.`,
          cta: 'add', ctaLabel: `Add ${name} to Lightning`, hint: `Top up the ${name} channel from the Balance tab.`, liquidity: l }
      : { ok: false, name, direction, reason: `Your ${name} Lightning channel has no inbound room to receive.`,
          cta: 'add', ctaLabel: `Rebalance ${name}`, hint: `Receive to on-chain, or rebalance the ${name} channel.`, liquidity: l };
  }
  return { ok: true, name, direction, reason: '', cta: null, ctaLabel: '', hint: '', liquidity: l };
}

// The composite verdict for a BTC<->asset pair: whether EACH leg's LN option is real,
// and whether the pure-LN (both legs on Lightning) route is genuinely available.
//   payTarget  / recvTarget : 'BTC' | { hex, ticker } — the composer's pay/receive legs
export function railAvailability({ channels, provisioned, payTarget, recvTarget, frontable }) {
  const payLn = legOption(channels, payTarget, 'pay', provisioned, frontable);
  const recvLn = legOption(channels, recvTarget, 'recv', provisioned, frontable);
  return { payLn, recvLn, pureLnOk: payLn.ok && recvLn.ok };
}

export default {
  channelMatches, channelActive, legLiquidity, hasChannel, canPayFrom, canReceiveTo,
  lspCanFront, legOption, railAvailability,
};
