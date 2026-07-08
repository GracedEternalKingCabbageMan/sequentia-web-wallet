// ---------------------------------------------------------------------------
// Host seam for the passive-CLOB covenant order flow. covenant-order.js builds
// and byte-verifies every field of a FILL (the covenant scriptPubKey, the
// introspection-only [leaf, control_block] witness, the credit/remainder/receipt
// amounts). The ONE thing it cannot do from JS is assemble + sign the raw
// Elements FILL transaction: a taproot script-path covenant input (no signature)
// at index 0, the taker's own key-path funding inputs signed from the seed, and
// the explicit outputs in the covenant's fixed order. That is the wasm helper
// `buildCovenantFillTx` (LWK / lwk_wasm). This module wires it, plus the two
// I/O hooks (`spkToAddress`, `fetchUtxoSpk`, `broadcast`), into the shapes
// covenant-order.js's place()/settleFill() consume.
//
// Nothing here re-derives covenant bytes — covenant-order.js already produced and
// verified the recipe. This module only:
//   * selects the taker's own asset-B (and fee-asset) funding UTXOs,
//   * hands the wallet derivation coordinates (chain/index) of each to the signer,
//   * calls the wasm assembler, and broadcasts.
// ---------------------------------------------------------------------------

// makeCovenantHooks builds the hooks object covenant-order.js expects.
//
// ctx = {
//   wasm,                       // the lwk_wasm module (scriptToAddress, buildCovenantFillTx)
//   wollet,                     // the LWK Wollet (utxos(), address())
//   network,                    // the lwk_wasm Network
//   mnemonic,                   // the recovery phrase (used only to sign, in-memory)
//   esploraFetch,               // async (path) -> Response, against the wallet's OWN /api
//   receiveAddress,             // () -> address string for the taker asset-A receipt
//   changeAddress,              // () -> address string for change (defaults to receiveAddress)
//   fee: { asset, atoms },      // the on-chain network fee (open fee market)
//   opts,                       // forwarded to planFillFromMatched (e.g. makerCancellableOK)
//   onStatus,                   // optional progress callback
// }
export function makeCovenantHooks(ctx){
  const receive = () => (ctx.receiveAddress ? ctx.receiveAddress() : ctx.wollet.address(undefined).address().toString());
  const change  = () => (ctx.changeAddress ? ctx.changeAddress() : receive());

  return {
    opts: ctx.opts,
    onStatus: ctx.onStatus,

    // Turn a covenant scriptPubKey into the address the maker funds (place()).
    spkToAddress: (spkHex) => ctx.wasm.scriptToAddress(spkHex, ctx.network),

    // The funded UTXO's real scriptPubKey, so planFillFromMatched can enforce the
    // covenant equality check against the on-chain output (anti-relay-lie).
    fetchUtxoSpk: async (txid, vout) => {
      try {
        const res = await ctx.esploraFetch(`/tx/${txid}`);
        if (!res.ok) return null;
        const tx = await res.json();
        const o = tx.vout && tx.vout[vout];
        return o && o.scriptpubkey ? o.scriptpubkey : null;
      } catch { return null; }
    },

    // THE assembly seam. `recipe` is the verified output of planFillFromMatched;
    // we add the taker's funding selection + addresses + fee + seed and call wasm.
    buildCovenantFillTx: async (recipe) => {
      const feeAsset = ctx.fee.asset;
      const feeAtoms = BigInt(ctx.fee.atoms);
      const creditAsset = recipe.creditAsset;
      const creditValue = BigInt(recipe.creditValue);

      // How much of each asset the taker must fund: the maker credit (asset B) plus
      // the network fee (fee asset). Asset A comes from the covenant, never funded.
      const need = new Map();
      const add = (asset, amt) => need.set(asset, (need.get(asset) || 0n) + amt);
      add(creditAsset, creditValue);
      add(feeAsset, feeAtoms);
      if (need.has(recipe.covenantAsset))
        throw new Error('fee/credit asset must not be the covenant sold asset A');

      // Greedy largest-first coin selection over the wallet's own UTXOs, per asset.
      const utxos = ctx.wollet.utxos();
      const byAsset = new Map();
      for (const u of utxos){
        const asset = u.unblinded().asset().toString();
        if (!need.has(asset)) continue;
        if (!byAsset.has(asset)) byAsset.set(asset, []);
        byAsset.get(asset).push(u);
      }

      const takerFundingUtxos = [];
      for (const [asset, target] of need){
        const cands = (byAsset.get(asset) || []).slice().sort((a,b) =>
          (b.unblinded().value() > a.unblinded().value() ? 1 : -1));
        let sum = 0n;
        for (const u of cands){
          if (sum >= target) break;
          const op = u.outpoint();
          const spk = u.scriptPubkey();
          takerFundingUtxos.push({
            txid: op.txid().toString(),
            vout: op.vout(),
            value: String(u.unblinded().value()),
            asset,
            spkHex: (spk.toString ? spk.toString() : bytesHex(spk.bytes())),
            chain: (u.extInt && String(u.extInt()).toLowerCase().includes('internal')) ? 1 : 0,
            index: u.wildcardIndex(),
          });
          sum += BigInt(u.unblinded().value());
        }
        if (sum < target)
          throw new Error(`insufficient ${asset}: need ${target}, have ${sum}`);
      }

      const full = {
        covenantTxid: recipe.covenantTxid,
        covenantVout: recipe.covenantVout,
        covenantAsset: recipe.covenantAsset,
        covenantLocked: String(recipe.covenantLocked),
        fillLeafHex: recipe.fillLeafHex,
        controlBlockHex: recipe.controlBlockHex,
        creditAsset: recipe.creditAsset,
        creditProg: recipe.creditProg,
        creditProgVer: recipe.creditProgVer == null ? 1 : recipe.creditProgVer,
        creditValue: String(recipe.creditValue),
        partial: !!recipe.partial,
        remainderAsset: recipe.remainderAsset,
        remainderValue: recipe.partial ? String(recipe.remainderValue) : undefined,
        remainderSpkHex: recipe.remainderSpkHex,
        takerFundingUtxos,
        takerReceiptAddr: receive(),
        takerChangeAddr: change(),
        feeAtoms: String(feeAtoms),
        feeAsset,
        mnemonic: ctx.mnemonic,
      };
      // wasm returns { rawHex, txid }.
      return ctx.wasm.buildCovenantFillTx(full, ctx.network);
    },

    // Broadcast a raw Elements tx hex against the wallet's OWN node; returns txid.
    broadcast: async (rawHex) => {
      const res = await ctx.esploraFetch('/tx', { method: 'POST', body: rawHex });
      const txt = (await res.text()).trim();
      if (!res.ok) throw new Error(`broadcast failed: ${txt}`);
      return txt;
    },
  };
}

// A maker's taproot payout: derive a BIP86 taproot receive the wallet controls and
// return { program, spkHex, address, descriptor } — program is the offer's
// maker_prog, descriptor is the companion `eltr` wollet that watches + spends the
// credit (the primary wpkh wollet does not track taproot receives).
export function makerPayout(signer, network, index = 0){
  const a = signer.covenantMakerAddress(network, index);
  return {
    program: a.program,
    spkHex: a.spkHex,
    address: a.address,
    internalKey: a.internalKey,
    path: a.path,
    descriptor: signer.covenantMakerDescriptor().toString(),
  };
}

function bytesHex(u8){ let s=''; for (const b of u8) s += b.toString(16).padStart(2,'0'); return s; }
