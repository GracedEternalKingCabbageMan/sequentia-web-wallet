// Integration test for swap.js's SUBMARINE-swap resume glue (requirement 2 wiring):
// proves that, given a MOCK stored in-flight swap in localStorage, the composer resumes
// it on load (hasMixedInFlight + the trade-process view re-renders WITH a Refund button
// once the on-chain HTLC leg's CLTV timeout is buried), and drops a terminal one. Uses a
// tiny DOM shim (no browser); swap.js delegates the state to submarine.js.
import assert from 'node:assert';

// --- localStorage shim (swap.js reads/writes `localStorage` directly) -------------
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
};

// --- a minimal DOM element + registry the ctx.$ resolves ---------------------------
function mkEl(tag = 'div') {
  const s = new Set();
  return {
    tag, innerHTML: '', textContent: '', title: '', disabled: false, id: '', value: '', style: {},
    children: [], onclick: null, dataset: {}, _userTyped: false, _refMode: false,
    classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c, on) => { on ? s.add(c) : s.delete(c); }, contains: (c) => s.has(c) },
    appendChild(c){ this.children.push(c); return c; },
    querySelectorAll(){ return []; },
    addEventListener(){}, setAttribute(){}, removeAttribute(){}, focus(){}, scrollIntoView(){},
  };
}
const REG = {};
for (const id of ['swapMixedWrap','swapCrossWrap','swapReverseWrap','swComposer','swMixedStepper','swMixedBtns']) REG[id] = mkEl('div');

const GOLD = 'aa'.repeat(32);
const C = {
  $: (id) => REG[id] || (REG[id] = mkEl('div')),
  el: (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
  assetMeta: (h) => (h === 'BTC' ? { ticker: 'BTC', precision: 8 } : { ticker: 'GOLD', precision: 0 }),
  wollet: { tip: () => ({ height: () => 300 }) },   // Sequentia tip past the HTLC locktime (250)
  toast: () => {}, prettyErr: (e) => (e && e.message) || String(e), sync: async () => {},
  attachRefHint: () => (() => {}),   // initSwap wires ref-currency hints; stub the updater
};

const { initSwap, resumeMixedSwap, hasMixedInFlight } = await import('./swap.js');
// No L.swapStatus -> pollMixed early-returns, so no lingering timer keeps the test alive.
initSwap({ ...C, ln: { available: () => true, status: async () => ({ channels: [] }), swap: async () => ({}) } });

// --- seed a MOCK stored in-flight submarine swap with a refundable on-chain leg -----
const stored = {
  id: 'sub-mock-1', side: 'sell', asset: GOLD, amount: 100000,
  payRail: 'chain', recvRail: 'ln', payIsBtc: false, state: 'settling',
  htlc: { chain: 'seq', address: 'tsq1qhtlc', txid: 'ab'.repeat(32), vout: 0, amount: '100000',
          refund_locktime: 250, refund_pub: '02'.padEnd(66, 'f'), refund_secret: '11'.repeat(32) },
  preimage: null, detail: '', created: Date.now(), updated: Date.now(),
};
localStorage.setItem('swk.sequentia.submarine', JSON.stringify(stored));

// --- RESUME: the composer rehydrates the swap + re-renders its trade-process view ---
resumeMixedSwap();
assert.ok(hasMixedInFlight(), 'a non-terminal stored submarine swap resumes as in-flight');
assert.ok(!REG.swapMixedWrap.classList.contains('hide'), 'the mixed-swap trade-process view is shown on resume');
assert.ok(REG.swComposer.classList.contains('hide'), 'the composer is hidden while the swap owns the tab');
const html = REG.swMixedStepper.innerHTML;
assert.ok(/Sell GOLD on-chain/.test(html), 'the stepper shows the swap direction');
assert.ok(/HTLC leg/.test(html), 'the stepper surfaces the on-chain HTLC leg');
// The Refund button was appended and is ENABLED (tip 300 >= locktime 250).
const btns = REG.swMixedBtns.children;
const refund = btns.find((b) => b.textContent === 'Refund BTC leg');
assert.ok(refund, 'a "Refund BTC leg" off-ramp is offered for the on-chain HTLC leg');
assert.equal(refund.disabled, false, 'the refund button is ENABLED once the CLTV timeout is buried (tip>=locktime)');
console.log('ok: resumeMixedSwap rehydrates the stepper + enabled Refund off-ramp from a mock stored state');

// --- a terminal stored swap is DROPPED on resume (never re-shows) -------------------
localStorage.setItem('swk.sequentia.submarine', JSON.stringify({ ...stored, state: 'refunded' }));
resumeMixedSwap();
assert.ok(!hasMixedInFlight(), 'a terminal (refunded) stored swap does NOT resume');
assert.equal(localStorage.getItem('swk.sequentia.submarine'), null, 'the terminal record is cleared from storage');
console.log('ok: resumeMixedSwap drops a terminal stored swap and clears it');

// --- before the timeout is buried, the refund off-ramp is DISABLED -----------------
// (real innerHTML='' clears the button host each render; the shim host is persistent,
//  so reset it so we inspect only THIS render's buttons.)
REG.swMixedBtns = mkEl('div');
C.wollet.tip = () => ({ height: () => 100 });   // tip below the locktime (250)
localStorage.setItem('swk.sequentia.submarine', JSON.stringify(stored));
resumeMixedSwap();
const refund2 = REG.swMixedBtns.children.find((b) => b.textContent === 'Refund BTC leg');
assert.ok(refund2 && refund2.disabled === true, 'the refund button is DISABLED until the on-chain HTLC CLTV timeout is buried');
console.log('ok: the Refund off-ramp is gated on the on-chain HTLC CLTV timeout');

console.log('\nALL PASS');
