// Unit test for ln-rail.js — the HONEST per-asset Lightning-rail gating. Proves the
// composer offers the LN rail for a leg ONLY when that asset/BTC has a real, usable
// channel with the liquidity the leg's DIRECTION needs, and otherwise reports WHY +
// the fix (Move to Lightning vs add liquidity). Runs in Node, no browser.
import assert from 'node:assert';
import {
  channelMatches, channelActive, legLiquidity, hasChannel, canPayFrom, canReceiveTo,
  legOption, railAvailability,
} from './ln-rail.js';

const GOLD = 'aa'.repeat(32);
const USDX = 'bc'.repeat(32);
const goldT = { hex: GOLD, ticker: 'GOLD' };
const usdxT = { hex: USDX, ticker: 'USDX' };

// A representative LSP /status channel set. The wallet's OWN channels carry a node_key (only those
// count toward rail liquidity): a live BTC channel (both-sided), a live GOLD channel that is
// RECEIVE-only (no spendable), and a USDX channel still OPENING. Plus a shared/demo-topology BTC
// channel with NO node_key that /status also returns but the wallet does not control — it must be
// excluded, or the Swap tab would offer to pay over a channel the user can't actually spend from.
const CHANNELS = [
  { peer_id: 'ln-btc', asset_label: 'BTC', node_key: 'own-btc', spendable_units: 1_000_000, receivable_units: 500_000, state: 'CHANNELD_NORMAL' },
  { peer_id: 'ln-gold', asset_label: 'GOLD', asset: GOLD, node_key: 'own-gold', spendable_units: 0, receivable_units: 2_000_000, state: 'CHANNELD_NORMAL' },
  { peer_id: 'ln-usdx', asset_label: 'USDX', asset: USDX, node_key: 'own-usdx', spendable_units: 9_000, receivable_units: 9_000, state: 'OPENINGD' },
  { peer_id: 'ln-shared', asset_label: 'BTC', spendable_units: 5_000_000, receivable_units: 5_000_000, state: 'CHANNELD_NORMAL' },
];

// --- channel matching + active-state gating --------------------------------------
assert.ok(channelMatches(CHANNELS[0], 'BTC'), 'BTC channel matches the BTC leg');
assert.ok(!channelMatches(CHANNELS[0], goldT), 'BTC channel is not a GOLD leg');
assert.ok(channelMatches(CHANNELS[1], goldT), 'GOLD channel matches by hex+ticker');
assert.ok(channelMatches({ asset_label: 'GOLD' }, goldT), 'a ticker-only tagged channel still matches by label');
assert.ok(!channelMatches(CHANNELS[1], usdxT), 'GOLD channel is not a USDX leg');
assert.ok(channelActive(CHANNELS[0]) && !channelActive(CHANNELS[2]), 'CHANNELD_* is active; OPENINGD is not');
console.log('ok: channelMatches keys by BTC-tag / asset hex / ticker; only CHANNELD_* is usable');

// --- liquidity aggregation --------------------------------------------------------
const btcL = legLiquidity(CHANNELS, 'BTC');
// count is 1, not 2: the shared node_key-less BTC channel is excluded despite matching + being active.
assert.deepEqual([btcL.active, btcL.spendable, btcL.receivable, btcL.count], [true, 1_000_000n, 500_000n, 1], 'BTC leg liquidity (own channel only; shared excluded)');
const goldL = legLiquidity(CHANNELS, goldT);
assert.deepEqual([goldL.active, goldL.spendable, goldL.receivable], [true, 0n, 2_000_000n], 'GOLD leg is receive-only');
const usdxL = legLiquidity(CHANNELS, usdxT);
assert.equal(usdxL.active, false, 'a still-OPENING USDX channel is NOT usable liquidity');
console.log('ok: legLiquidity aggregates only active channels (spendable/receivable/count)');

// --- direction-aware usability ----------------------------------------------------
assert.ok(hasChannel(CHANNELS, 'BTC') && canPayFrom(CHANNELS, 'BTC') && canReceiveTo(CHANNELS, 'BTC'), 'BTC leg pays + receives');
assert.ok(hasChannel(CHANNELS, goldT), 'GOLD has a channel');
assert.ok(!canPayFrom(CHANNELS, goldT), 'GOLD cannot PAY (no spendable)');
assert.ok(canReceiveTo(CHANNELS, goldT), 'GOLD CAN receive (has inbound)');
assert.ok(!hasChannel(CHANNELS, usdxT) && !canPayFrom(CHANNELS, usdxT), 'USDX has no usable channel yet');
console.log('ok: pay-from needs spendable, receive-to needs receivable, opening channels excluded');

// --- legOption verdicts (why-not + CTA) -------------------------------------------
// No channel at all -> Move to Lightning.
const noChan = legOption(CHANNELS, usdxT, 'pay');
assert.ok(!noChan.ok && noChan.cta === 'move' && /No Lightning channel for USDX/.test(noChan.reason), 'no channel -> move CTA');
// A provisioned-but-channel-less node changes only the wording (node ready, fund a channel).
const provReady = legOption(CHANNELS, usdxT, 'pay', { [USDX]: { connected: true } });
assert.ok(!provReady.ok && provReady.cta === 'move' && /node is ready/.test(provReady.hint), 'provisioned node -> "ready, fund a channel" hint');
// Channel exists but wrong-side liquidity -> add / rebalance (NOT move).
const emptyPay = legOption(CHANNELS, goldT, 'pay');
assert.ok(!emptyPay.ok && emptyPay.cta === 'add' && /no spendable/.test(emptyPay.reason), 'GOLD pay leg: channel but empty -> add');
const okRecv = legOption(CHANNELS, goldT, 'recv');
assert.ok(okRecv.ok && okRecv.reason === '', 'GOLD receive leg is genuinely available');
console.log('ok: legOption distinguishes "no channel -> move" from "empty side -> add" and passes a real leg');

// --- composite pure-LN availability for a BTC<->asset pair -------------------------
// BUY GOLD: pay BTC (from LN) + receive GOLD (to LN). BTC pays, GOLD receives -> pure-LN OK.
const buyGold = railAvailability({ channels: CHANNELS, payTarget: 'BTC', recvTarget: goldT });
assert.ok(buyGold.payLn.ok && buyGold.recvLn.ok && buyGold.pureLnOk, 'buy GOLD with BTC over pure-LN is available');
// SELL GOLD: pay GOLD (from LN) + receive BTC (to LN). GOLD cannot pay -> pure-LN NOT available.
const sellGold = railAvailability({ channels: CHANNELS, payTarget: goldT, recvTarget: 'BTC' });
assert.ok(!sellGold.payLn.ok && sellGold.recvLn.ok && !sellGold.pureLnOk, 'selling GOLD over pure-LN is gated (no spendable GOLD channel)');
// A wallet with ZERO channels: nothing is offerable — never a silent "LSP configured" yes.
const none = railAvailability({ channels: [], payTarget: 'BTC', recvTarget: goldT });
assert.ok(!none.payLn.ok && !none.recvLn.ok && !none.pureLnOk, 'no channels => the LN rail is offered for NEITHER leg');
console.log('ok: railAvailability reflects real per-leg channel liquidity, not "LSP configured"');

console.log('\nALL PASS');
