// Unit tests for bridge-driver.mjs — the live driver's CONTROL FLOW, with all I/O injected as a
// scripted fake `io` "world". The point: prove the driver executes ONLY nextBridgeStep's output, never
// fronts before its recoup is secured or before the whole-swap lock, provisions JIT first, and can't
// deadlock when both legs bridge — all without a node.
import test from 'node:test';
import assert from 'node:assert';
import { runBridgedLeg, runBridgedSwap, classifyLegs, describeBridge, matchFromTake, makerRailsFromOffer } from './bridge-driver.mjs';
import { planSettlement } from './settlement-router.mjs';

const A = 100000;
const DCFG = { pollMs: 0, maxTicks: 200 };   // low ceiling
// A REAL 1ms nap for the fake io: unlike `async () => {}` it yields to the macrotask/timer queue, so
// setTimeout-based test events fire and the driver loop is paced (no microtask starvation).
const nap1 = () => new Promise((r) => setTimeout(r, 1));

// ---------- a fake single-leg "world" for runBridgedLeg ----------
// receiver-LN: the LSP pays the receiver's hold, then claims the payer's on-chain HTLC.
function receiverWorld({ lockedToLsp = true, amount = A, cltv = 200, gate = () => true } = {}) {
  const w = { tip: 100, onchain: { funded: true, amountSat: amount, cltv, lockedToLsp, spent: false },
    ln: { registered: true, held: false, settled: false, preimage: null }, _heldTicks: 0, calls: [] };
  return {
    world: w, swapLocked: gate, sleep: nap1, log: () => {},
    observe: async () => {
      // External event: a few ticks after we front (held), the receiver settles + reveals P.
      if (w.ln.held && !w.ln.settled) { if (++w._heldTicks >= 2) { w.ln.settled = true; w.ln.preimage = 'ab'.repeat(32); } }
      return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln } };
    },
    frontLn: async () => { w.calls.push('frontLn'); w.ln.held = true; },
    recoupClaim: async () => { w.calls.push('recoupClaim'); w.onchain.spent = true; },
  };
}
// payer-LN: the LSP receives the payer's LN (held), funds the receiver's on-chain HTLC; the receiver
// claims (reveals P), the LSP settles the held LN.
function payerWorld({ amount = A, gate = () => true, expiryBlocks = 40 } = {}) {
  const w = { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks },
    _fundedTicks: 0, calls: [] };
  return {
    world: w, swapLocked: gate, sleep: nap1, log: () => {},
    observe: async () => {
      // A few ticks after we fund on-chain, the receiver claims (spent) and P is read from the witness.
      if (w.onchain && w.onchain.funded && !w.onchain.spent) { if (++w._fundedTicks >= 2) { w.onchain.spent = true; w.ln.preimage = 'cd'.repeat(32); } }
      return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln } };
    },
    fundOnchain: async () => { w.calls.push('fundOnchain'); w.onchain = { funded: true, amountSat: amount, cltv: w.tip + 12, lockedToReceiver: true, spent: false }; },
    recoupSettle: async () => { w.calls.push('recoupSettle'); w.ln.settled = true; },
  };
}

test('runBridgedLeg receiver-LN: walks wait->front->...->recoup-claim->done, fronting once', async () => {
  const io = receiverWorld();
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim']);
  assert.equal(r.fronted, true);
});

test('runBridgedLeg payer-LN: walks ->fund-onchain->...->recoup-settle->done', async () => {
  const io = payerWorld();
  const r = await runBridgedLeg({ leg: { lnSide: 'payer', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['fundOnchain', 'recoupSettle']);
});

test('runBridgedLeg receiver-LN: NEVER fronts while the whole-swap gate is closed', async () => {
  let open = false;
  const io = receiverWorld({ gate: () => open });
  // Race the driver against opening the gate after it has already spun several no-front ticks.
  const p = runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 1, maxTicks: 200 } });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(io.world.calls, [], 'must not have fronted while gated');
  open = true;                       // whole swap now locked
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim'], 'fronts only after the gate opens');
});

test('runBridgedLeg receiver-LN: fail-closed (HTLC not locked to LSP) never fronts, no loss', async () => {
  const io = receiverWorld({ lockedToLsp: false });
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.equal(r.fronted, false);
  assert.deepEqual(io.world.calls, []);
});

test('runBridgedLeg receiver-LN: fail-closed on too-short CLTV runway (no front)', async () => {
  const io = receiverWorld({ cltv: 104 });   // tip 100 + frontRunway 6 = 106 needed
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.deepEqual(io.world.calls, []);
});

test('runBridgedLeg: a wait/unmapped action is a pure no-op tick (never a value move)', async () => {
  // onchain=null forever -> the core always says wait; the driver must call NO value method and hit maxTicks.
  const w = { calls: [] };
  const io = { sleep: nap1, log: () => {},
    observe: async () => ({ tip: 100, onchain: null, ln: { registered: true, held: false, settled: false, preimage: null } }),
    frontLn: async () => { w.calls.push('frontLn'); }, recoupClaim: async () => { w.calls.push('recoupClaim'); } };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: { pollMs: 0, maxTicks: 20 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /maxTicks/);
  assert.deepEqual(w.calls, []);
});

test('runBridgedLeg: an execution error is re-observed, not escalated to a different value move', async () => {
  let threw = false;
  const io = receiverWorld();
  const realFront = io.frontLn;
  io.frontLn = async (...a) => { if (!threw) { threw = true; throw new Error('broadcast timeout'); } return realFront(...a); };
  const r = await runBridgedLeg({ leg: { lnSide: 'receiver', amountSat: A }, io, driverCfg: DCFG });
  assert.equal(r.ok, true);   // recovered by re-observing + retrying the SAME core-directed action
  assert.deepEqual(io.world.calls, ['frontLn', 'recoupClaim']);
});

test('runBridgedLeg: rejects a bad lnSide', async () => {
  await assert.rejects(() => runBridgedLeg({ leg: { lnSide: 'x', amountSat: A }, io: { observe: async () => ({}) } }));
});

// ---------- classifyLegs / describeBridge (pure) ----------
test('classifyLegs splits bridged/native/jit from a plan', () => {
  // buyer pays BTC-LN, seller wants BTC on-chain -> BTC leg bridged (payer); asset leg native chain/chain.
  const plan = planSettlement({ asset: 'GOLD', buyer: { btcRail: 'ln', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } });
  const c = classifyLegs(plan);
  assert.equal(c.bridged.length, 1);
  assert.equal(c.bridged[0].unit, 'btc');
  assert.equal(c.native.length, 1);
  assert.equal(c.native[0].unit, 'asset');
});

test('describeBridge flags a coincident match as NOT bridged, LSP out of the value path', () => {
  const d = describeBridge({ asset: 'GOLD', buyer: { btcRail: 'chain', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } });
  assert.equal(d.bridged, false);
  assert.equal(d.happyCoincidence, true);
  assert.equal(d.lspInValuePath, false);
});

test('describeBridge flags a genuine cross as bridged + names the bridged leg', () => {
  const d = describeBridge({ asset: 'GOLD', buyer: { btcRail: 'ln', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } });
  assert.equal(d.bridged, true);
  assert.equal(d.lspInValuePath, true);
  assert.deepEqual(d.bridgeLegs, [{ unit: 'btc', lnSide: 'payer' }]);
});

// ---------- matchFromTake / makerRailsFromOffer (the take -> match contract) ----------
test('makerRailsFromOffer: on-chain offer -> both maker legs chain; ln offer -> asset leg ln, btc chain', () => {
  assert.deepEqual(makerRailsFromOffer({ rail: 'onchain' }), { makerBtcRail: 'chain', makerAssetRail: 'chain' });
  assert.deepEqual(makerRailsFromOffer({ rail: 'ln' }), { makerBtcRail: 'chain', makerAssetRail: 'ln' });
});

test('matchFromTake: BUY vs on-chain offer, taker pays BTC over LN -> BTC leg bridges (payer)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'ln', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' });
  const plan = planSettlement(m);
  assert.equal(plan.happyCoincidence, false);
  assert.equal(plan.btcLeg.bridge, true);
  assert.equal(plan.btcLeg.lnSide, 'payer');
  assert.equal(plan.assetLeg.bridge, false);
});

test('matchFromTake: BUY vs on-chain offer, both taker rails chain -> HAPPY coincidence (no bridge)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' });
  assert.equal(planSettlement(m).happyCoincidence, true);
});

test('matchFromTake: BUY vs sub-asset LN offer, taker wants asset on-chain -> asset leg bridges (payer)', () => {
  // maker (sub-asset ask): assetRail ln, btcRail chain. Taker buys, pays BTC on-chain, wants asset on-chain.
  const m = matchFromTake({ asset: 'GOLD', side: 'buy', payRail: 'chain', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'ln' });
  const plan = planSettlement(m);
  assert.equal(plan.assetLeg.bridge, true);
  assert.equal(plan.assetLeg.lnSide, 'payer');   // maker (seller) pays the asset over LN
  assert.equal(plan.btcLeg.bridge, false);
});

test('matchFromTake: SELL vs on-chain offer, taker receives BTC over LN -> BTC leg bridges (receiver)', () => {
  const m = matchFromTake({ asset: 'GOLD', side: 'sell', payRail: 'chain', recvRail: 'ln', makerBtcRail: 'chain', makerAssetRail: 'chain', takerBtcInbound: true });
  const plan = planSettlement(m);
  assert.equal(plan.btcLeg.bridge, true);
  assert.equal(plan.btcLeg.lnSide, 'receiver');   // taker (seller) receives BTC over LN
});

test('matchFromTake: rejects a bad rail', () => {
  assert.throws(() => matchFromTake({ asset: 'X', side: 'buy', payRail: 'satellite', recvRail: 'chain', makerBtcRail: 'chain', makerAssetRail: 'chain' }));
});

// ---------- runBridgedSwap coordinator ----------
test('runBridgedSwap refuses a happy coincidence (never routes a native match through a bridge)', async () => {
  const r = await runBridgedSwap({ match: { asset: 'GOLD', buyer: { btcRail: 'chain', assetRail: 'chain' }, seller: { assetRail: 'chain', btcRail: 'chain' } }, io: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /happy coincidence/i);
});

test('runBridgedSwap: JIT first, native drives, bridged leg gated until native locks, then settles', async () => {
  // buyer pays BTC on-chain, receives asset over LN with NO inbound -> asset leg bridged (receiver) + JIT;
  // seller both on-chain -> BTC leg native. So: JIT(asset) -> lock BTC(native) -> front asset -> settle.
  const events = [];
  let nativeChecks = 0;
  // asset leg (bridged, receiver): reuse the receiver world but attach amount + gate wiring via the swap io.
  const assetW = { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: true, spent: false },
    ln: { registered: true, held: false, settled: false, preimage: null }, _h: 0 };
  const io = {
    sleep: nap1, log: () => {},
    legAmountSat: () => A,
    provisionInbound: async (leg) => { events.push('jit:' + leg.unit); },
    startNative: async (leg) => { events.push('startNative:' + leg.unit); },
    // The native leg locks after a few polls (deterministic; the maker funds its HTLC).
    observeNativeLocked: async () => (++nativeChecks >= 3),
    observe: async (leg) => {
      if (leg.unit !== 'asset') return { tip: 100, onchain: null, ln: { registered: false, held: false, settled: false, preimage: null } };
      if (assetW.ln.held && !assetW.ln.settled) { if (++assetW._h >= 2) { assetW.ln.settled = true; assetW.ln.preimage = 'ab'.repeat(32); } }
      return { tip: assetW.tip, onchain: { ...assetW.onchain }, ln: { ...assetW.ln } };
    },
    frontLn: async (leg) => { events.push('front:' + leg.unit); assetW.ln.held = true; },
    recoupClaim: async (leg) => { events.push('claim:' + leg.unit); assetW.onchain.spent = true; },
  };
  // buyer pays BTC on-chain, receives asset over LN with no inbound -> asset leg bridges (receiver) + JIT.
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: false }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 1, maxTicks: 500 } });
  assert.equal(r.ok, true, r.reason);
  // JIT strictly before the front; the front strictly after native lock is observed.
  assert.ok(events.indexOf('jit:asset') >= 0 && events.indexOf('jit:asset') < events.indexOf('front:asset'), 'JIT before front');
  assert.ok(events.indexOf('front:asset') > 0, 'asset leg did front');
  assert.deepEqual(events.filter((e) => e.startsWith('front')), ['front:asset'], 'exactly one front');
});

test('runBridgedSwap: JIT failure fails the swap CLOSED before anything locks', async () => {
  const io = { sleep: nap1, log: () => {}, legAmountSat: () => A, provisionInbound: async () => { throw new Error('no LP liquidity'); },
    observe: async () => ({ tip: 100, onchain: null, ln: {} }) };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: false }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: DCFG });
  assert.equal(r.ok, false);
  assert.match(r.reason, /JIT inbound/i);
});

test('runBridgedSwap: BOTH legs bridged does not deadlock (gate on the other leg LOCK, not its front)', async () => {
  // buyer pays BTC over LN + receives asset on-chain; seller pays asset over LN + receives BTC on-chain.
  // BTC leg: buyer(ln) vs seller(chain) -> cross, PAYER. Asset leg: seller(ln) vs buyer(chain) -> cross,
  // PAYER. So BOTH legs are payer-LN bridges (LSP funds each on-chain HTLC after each LN is held).
  const worlds = {
    btc:   payerLegWorld(),
    asset: payerLegWorld(),
  };
  const fronted = [];
  const io = {
    sleep: nap1, log: () => {}, legAmountSat: () => A,
    provisionInbound: async () => {},
    observe: async (leg) => worlds[leg.unit].observe(),
    fundOnchain: async (leg) => { fronted.push('fund:' + leg.unit); worlds[leg.unit].fund(); },
    recoupSettle: async (leg) => { worlds[leg.unit].settle(); },
  };
  const match = { asset: 'GOLD', buyer: { btcRail: 'ln', assetRail: 'chain' }, seller: { assetRail: 'ln', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 1, maxTicks: 800 } });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fronted.sort(), ['fund:asset', 'fund:btc'], 'both legs funded — no deadlock');
});

test('runBridgedSwap: a bridged-leg fail-closed fails the whole swap', async () => {
  const io = {
    sleep: nap1, log: () => {}, provisionInbound: async () => {},
    startNative: async () => {}, observeNativeLocked: async () => true,
    // asset leg bridged (receiver) but the on-chain HTLC is NOT locked to the LSP -> fail-closed.
    observe: async (leg) => leg.unit === 'asset'
      ? { tip: 100, onchain: { funded: true, amountSat: A, cltv: 200, lockedToLsp: false }, ln: { registered: true, held: false, settled: false, preimage: null } }
      : { tip: 100, onchain: null, ln: {} },
    frontLn: async () => { throw new Error('should never front'); },
  };
  const match = { asset: 'OILX', buyer: { btcRail: 'chain', assetRail: 'ln', assetInbound: true }, seller: { assetRail: 'chain', btcRail: 'chain' } };
  const r = await runBridgedSwap({ match, io, driverCfg: { pollMs: 0, maxTicks: 50 } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /asset:/);
});

// ---- helpers ----
// A minimal payer-leg world usable inside the swap io (fund -> receiver claims -> settle).
function payerLegWorld() {
  const w = { tip: 100, onchain: null, ln: { registered: true, held: true, settled: false, preimage: null, expiryBlocks: 40 }, _f: 0 };
  return {
    observe: () => { if (w.onchain && w.onchain.funded && !w.onchain.spent) { if (++w._f >= 2) { w.onchain.spent = true; w.ln.preimage = 'cd'.repeat(32); } } return { tip: w.tip, onchain: w.onchain ? { ...w.onchain } : null, ln: { ...w.ln } }; },
    fund: () => { w.onchain = { funded: true, amountSat: A, cltv: w.tip + 12, lockedToReceiver: true, spent: false }; },
    settle: () => { w.ln.settled = true; },
  };
}
