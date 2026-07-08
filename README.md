# Sequentia web wallet

A proof-of-concept, non-custodial browser wallet for the Sequentia testnet, built on
[SWK](https://github.com/GracedEternalKingCabbageMan/SWK) (Sequentia Wallet Kit), live at
**https://sequentiatestnet.com/wallet**.

It is a dual-chain wallet: one 12-word phrase drives both a **Bitcoin testnet4** wallet and a
**Sequentia** wallet, and the same `tb1...` receive address works on both chains. BTC is a
first-class asset alongside every Sequentia-issued asset. All keys are derived and used inside
the browser; no key or phrase ever leaves the page. The app is a single static page (vanilla
JavaScript ES modules, no framework, no bundler) around SWK's `lwk_wasm` WebAssembly bindings.

> **Testnet software.** Everything here runs against the public Sequentia testnet and Bitcoin
> testnet4. There is no mainnet. Coins and assets have no value. This is a proof of concept,
> provided as-is, with no warranty.

## Where this fits in Sequentia

Sequentia is a Bitcoin sidechain for asset tokenization and decentralized exchange, built as a
fork of Blockstream Elements 23.3.3. The pieces this wallet talks to:

| Repo | One-liner |
|---|---|
| [`Sequentia`](https://github.com/GracedEternalKingCabbageMan/Sequentia) | The Sequentia node (`elementsd` fork of Elements 23.3.3): consensus, anchoring, proof of stake, open fee market, plus the canonical protocol documentation in `doc/sequentia/`. |
| [`SWK`](https://github.com/GracedEternalKingCabbageMan/SWK) | Sequentia Wallet Kit: a fork of Blockstream LWK — Rust wallet library, CLI, and WASM bindings for building Sequentia (and Bitcoin testnet4) wallets. |
| [`seqdex`](https://github.com/GracedEternalKingCabbageMan/seqdex) | SeqDEX: non-custodial atomic-swap DEX — P2P order book (seqob), same-chain swaps, and cross-chain BTC↔asset swaps made safe by Bitcoin anchoring. |
| [`seqln`](https://github.com/GracedEternalKingCabbageMan/seqln) | SeqLN: a Core Lightning fork that runs on Sequentia and Bitcoin from the same binary — asset channels, any-asset payments, pure-Lightning swaps. |
| [`openamp`](https://github.com/GracedEternalKingCabbageMan/openamp) | OpenAMP: open-source restricted-asset issuance/transfer-approval service (an AMP2 equivalent) with opt-in confidentiality; zero consensus changes. |
| [`sequentia-electrs`](https://github.com/GracedEternalKingCabbageMan/sequentia-electrs) | The electrs fork: Rust indexer + Esplora REST API for Sequentia and its Bitcoin testnet4 parent chain. |
| [`sequentia-registry`](https://github.com/GracedEternalKingCabbageMan/sequentia-registry) | Sequentia Asset Registry service (asset metadata). |

Protocol-level documentation (anchoring, proof of stake, the open fee market) lives in
[`Sequentia/doc/sequentia/`](https://github.com/GracedEternalKingCabbageMan/Sequentia/tree/main/doc/sequentia).

## Status

Working today on the live deployment:

- Wallet create / restore from a 12-word phrase; balances, send, receive on both chains
- Portfolio and per-amount display in a user-chosen reference currency (USD, BTC, or any priced asset)
- Any-asset fees on Sequentia transactions (open fee market), with fee-asset selection on every send
- Trade tab: SeqDEX order book, taking and posting orders, same-chain atomic swaps
- Cross-chain BTC↔asset HTLC swaps, taker and in-browser maker, with resume-after-reload safety
- Asset issuance, reissue, burn; testnet faucet; asset labels fed by the Asset Registry
- Staking the Sequence token (tSEQ) with the network-minimum CSV lock
- Transaction history on both chains with RBF fee bump, CPFP, and replace
- OpenAMP restricted assets: balances, receive, send (locally signed, never blind-signed)
- QR scanning for addresses (live camera on https, photo upload elsewhere)

Experimental / demo-grade:

- The **Instant (Lightning)** trade rails. The client code is complete and enabled on the live
  page, but it depends on a hosted SeqLN LSP demo backend with an interim shared bearer token.
  See [Lightning](#lightning-experimental) below for an honest description.
- Posting a **same-chain** resting order: the order rests on the book and is cancellable, but
  filling it requires the maker to co-sign, and in-wallet co-signing of same-chain lifts is not
  implemented yet (an external maker process fills them). Cross-chain posted orders ARE served
  by the wallet itself while the tab stays open.

## Using the wallet

Open **https://sequentiatestnet.com/wallet** in a modern desktop or mobile browser
(WebAssembly and `localStorage` required; the live QR camera additionally needs a secure
context, which the live site is). Create a new wallet or restore one from a 12-word phrase.

Get testnet funds from the **Assets** tab: one-click faucet buttons for tSEQ and the demo
assets USDX, EURX, GOLD, SILVR, OILX (the faucet at https://sequentiatestnet.com/faucet pays
straight to your current address).

The tabs:

- **Balance**: a headline portfolio total across parent-chain BTC and every Sequentia asset,
  valued in your chosen reference currency, then one uniform row per asset. No asset is
  pinned or privileged; the Sequence token (tSEQ) is one row among equals.
- **Send**: multi-recipient sends of any owned asset, including BTC (a real Bitcoin testnet4
  transaction) and OpenAMP restricted assets. For Sequentia sends you choose the **fee asset**:
  the fee can be paid in any asset the node publishes an exchange rate for, and the fee-rate
  field is denominated in that asset's own units per vByte (sat/vB applies only to actual BTC
  sends). Every send shows a review dialog before broadcast.
- **Receive**: one address for both chains. The default is the non-confidential `tb1...` form,
  which is Bitcoin-compatible: the same address receives parent-chain BTC and Sequentia assets.
  Confidential (blinded, `tsqb1...`) addresses are available as an explicit opt-in toggle;
  Sequentia is transparent by default and confidentiality is opt-in. A separate panel appears
  for OpenAMP restricted-asset deposits once the wallet is registered with the enclave.
- **Swap** (the Trade tab): see below.
- **Assets**: faucet, issue a new asset (amount, precision 0-8, optional reissuance tokens),
  reissue or burn an existing one, and label unknown assets. Metadata precedence: your local
  labels, then the Asset Registry, then built-in defaults for the public testnet demo assets.
- **Stake**: bond tSEQ to a CSV-time-locked staking output. Minimum stake 40,000 tSEQ;
  the wallet always uses the network-minimum unbonding lock (CSV 43200 blocks, about 15 days),
  because stake weight equals the amount staked and a longer lock earns nothing extra.
- **History**: transactions on both chains, with explorer links, and rescue actions for stuck
  Sequentia transactions: RBF fee bump, CPFP, and replace, each with the same any-asset fee
  selection as a send.
- **Settings**: backend endpoints, network, the policy asset id, reveal-phrase, and
  remove-wallet.

A wallet-wide **"Show values in"** selector picks the reference currency (USD by default, BTC
or any priced asset optional). Every amount field carries a live approximate value in that
currency, and amount inputs can be flipped to be typed directly in the reference currency.

### The Trade tab

One symmetric composer: "You pay X" / "You receive Y". The route is inferred from the pair:

- **Same-chain** (asset ↔ asset on Sequentia): a single atomic transaction co-signed by both
  parties (PSET-based, no escrow, no intermediary), settled against the SeqDEX order book.
- **Cross-chain** (BTC ↔ asset): a hash-time-locked-contract (HTLC) atomic swap between
  Bitcoin testnet4 and Sequentia. Before revealing any secret the wallet verifies the
  counterparty leg on-chain AND checks that the Sequentia block anchors at or above the
  Bitcoin leg's height. Bitcoin anchoring is what makes this safe: if Bitcoin reorganizes,
  Sequentia reorganizes with it, so an anchored Sequentia leg cannot outlive the Bitcoin leg
  it depends on.
- **Instant (Lightning)** and **mixed** rails for BTC ↔ asset appear when the Lightning
  backend is reachable (see below).

Two modes, chosen automatically and switchable:

- **Take**: lift a resting order from the book at its price. Order authenticity is verified
  client-side (each offer carries the maker's signature; forged relay rows are dropped), and
  the swap handshake runs end-to-end encrypted through the relay, which only ever sees
  ciphertext.
- **Post**: rest a signed limit order at your own price. Cross-chain orders are served by your
  own browser while the tab is open (the wallet acts as maker, with persisted fund-safety
  watchers that resume after a reload). Same-chain orders rest on the book but need an
  external maker process to co-sign fills for now.

The tab is honest about finality: on-chain settlement is described as anchor-bound ("reverts
only if Bitcoin reverts"), nothing is called final at 0 confirmations, and only pure-Lightning
settlement (nothing on-chain) is labelled final.

### Lightning (experimental)

The Lightning rails use a hosted-SeqLN LSP model that keeps the wallet non-custodial:

- The server hosts two **keyless** SeqLN nodes (an asset node on Sequentia, a BTC node on
  testnet4). Neither has an `hsm_secret`.
- The browser derives two device identities from your one mnemonic (hardened `m/1017'/...`
  paths, see `seqln-keys.js`) and runs an on-device WASM signer per node, connected over a
  WebSocket Noise_XK (BOLT-8) link. Every commitment update is co-signed on your device, so
  the LSP can route payments but can never move channel funds.
- A trade with both rails set to Lightning settles both legs atomically on one preimage, fully
  off-chain. A mixed rail (one leg on-chain, one Lightning) is a submarine swap.

The status pill next to the wallet title reports the rail: "LN ready" (both device signers
serving), "LN 1/2" (one leg up), or an error state; when Lightning is not configured the pill
is hidden and the composer quietly uses the on-chain rails only.

Honest caveats: this is a demo deployment. The live page ships a shared testnet-demo bearer
token for the LSP API (per-wallet authentication is a known TODO), the backend is a single
hosted instance, and the rail's availability depends on it. Funds safety does not rest on the
token: it rests on the hosted nodes being keyless, with your device as sole signer.

### OpenAMP restricted assets

If the OpenAMP service is reachable, the wallet registers an identity (AID) derived from the
wallet's own keys and then shows restricted assets alongside on-chain ones: balances on the
Balance tab, a deposit address on the Receive tab, and transfers on the Send tab. Transfers
are drafted by the enclave, reviewed in the wallet, and signed locally (Schnorr over the
returned sighashes); the wallet never blind-signs. If the service is unreachable the wallet
works normally without the restricted rows.

## For developers

### Repo layout

| Path | What it is |
|---|---|
| `index.html` | The whole app shell and core wallet logic: boot, create/restore, tabs, balances, send/receive, fees, staking, history, OpenAMP, QR scanner. |
| `pkg/` | **Not tracked.** The `lwk_wasm` WebAssembly bindings built from SWK (see below). |
| `btc.js` | Vendored bundle of `@scure/btc-signer`, `@scure/bip32`, `@scure/bip39`, `@scure/base`, `@noble/hashes` (MIT): the Bitcoin testnet4 side and HD derivation. |
| `swap.js` | The Trade tab: composer, routing, Take/Post modes, same-chain settlement, fee selection. |
| `seqob.js` | SeqDEX order-book (seqob relay) protocol client: wire codec, offer signing/verification, end-to-end crypter, REST + WebSocket lift driver. |
| `xcourier.js` | Cross-chain swap message transport: end-to-end-sealed courier sessions over the relay WebSocket. |
| `xswap.js` / `xrswap.js` | Cross-chain HTLC taker, forward (pay BTC, receive asset) and reverse (pay asset, receive BTC). |
| `xmaker.js` | In-browser cross-chain maker: builds, signs, rests, and serves offers in both directions. |
| `seqln.js` / `seqln-keys.js` | Lightning: hosted-LSP HTTP client, device-signer orchestration, and the `m/1017'/...` key derivation. |
| `lightning/` | The vendored SeqLN device-signer SDK + its WASM build (tracked, unlike `pkg/`). |
| `noble-ciphers.js` | Vendored `@noble/ciphers` (MIT): AES-256-GCM for the end-to-end swap encryption. |
| `jsqr.js` | Vendored jsQR: QR decoding for the scanner. |
| `tooling/lsp/` | The hosted-SeqLN LSP backend service and provisioning/harness scripts, with [its own README](tooling/lsp/README.md). |
| `*.test.mjs` | Node test suites (no browser needed). |

A deeper tour of the module graph, protocols, config globals, and storage keys is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Building `pkg/` (the SWK WASM bindings)

The only build product the wallet needs is `pkg/`, produced from the `sequentia` branch of
SWK with [wasm-pack](https://rustwasm.github.io/wasm-pack/):

```sh
git clone -b sequentia https://github.com/GracedEternalKingCabbageMan/SWK.git
cd SWK/lwk_wasm
wasm-pack build --release
```

Then copy or symlink the output into the wallet checkout:

```sh
ln -s ../SWK/lwk_wasm/pkg ./pkg
```

Sequentia support (the `Network.sequentiaTestnet()` network, explicit-fee PSET building, the
SeqDEX swap and HTLC helpers) is compiled in unconditionally on that branch via `lwk_wollet`'s
`sequentia` feature, so no extra flags are needed.

### Running locally

The app itself is static; any file server works for the UI:

```sh
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

However, all data access is same-origin: the page calls relative paths and expects a reverse
proxy in front of it (this is how the live site is deployed, with the static files and the
proxied services under one origin). To get a functional wallet locally, proxy these paths to
a backend (the public testnet services work):

| Path | Service |
|---|---|
| `/api` | Sequentia Esplora REST API (sequentia-electrs) |
| `/testnet4/api` | Bitcoin testnet4 Esplora REST API |
| `/prices` | Market price feed (reference-currency display) |
| `/feerates` | The node's fee-asset exchange rates (`getfeeexchangerates`) |
| `/faucet` | Testnet faucet |
| `/registry/index.minimal.json` | Asset Registry minimal index (asset metadata; overridable via `window.SEQ_REGISTRY_URL`) |
| `/seqob` (+ WebSocket at `/seqob/v1/ws`) | SeqDEX order-book relay (`seqobd`) |
| `/dex` | Legacy cross-chain DEX daemon (market seeding) |
| `/anchor/<blockhash>`, `/anchorstatus` | Anchor lookups used by the cross-chain maker's safety gate |
| `/openamp` | OpenAMP restricted-asset API (optional; wallet degrades gracefully) |
| `/lsp`, `/lsp-ws-asset`, `/lsp-ws-btc` | Hosted-SeqLN LSP + per-node signer WebSockets (optional; Lightning rails stay off without them) |

Missing optional backends never break the wallet; the corresponding features simply do not
appear. Note that the live camera QR scanner requires https; over plain http the
photo-upload fallback is used automatically.

### Running the tests

The protocol modules are DOM-free and tested under plain Node (22+, no dependencies to
install):

```sh
node --test
```

This runs `seqln.test.mjs` (LSP client, key derivation, two-leg availability logic against a
mock SDK), `xcourier.test.mjs` (courier codec, sealed round-trips, maker listener,
single-flight refusal), and `xmaker.test.mjs` (maker happy paths in both directions plus the
resume-after-reload fund-safety logic). All three pass as of 2026-07-08 on Node v22.

The real WASM + WebSocket + Noise signer path is exercised separately by
`tooling/lsp/device-harness.mjs` against a running backend; see
[`tooling/lsp/README.md`](tooling/lsp/README.md).

### Contributing

Development happens on `main`; open PRs against it. Keep the app dependency-free at runtime:
vendored libraries are checked in as single files, there is no `package.json`, and new code
should follow the existing module pattern (an `init*(ctx)` entry that receives the shared
context from `index.html`).

## Security notes

- **Non-custodial, client-side keys.** The mnemonic and every derived key live only in your
  browser. Transactions are signed locally; servers see only signed transactions, sealed swap
  messages, or (for Lightning) individual signature requests approved by the on-device signer.
- **The phrase is stored in plaintext `localStorage`** so the wallet reopens without re-typing
  it. There is no passphrase encryption yet. Anyone with access to your browser profile can
  read it. Do not use this wallet pattern for real value; this is testnet proof-of-concept
  software.
- The swap handshakes are end-to-end encrypted (ECDH + AES-256-GCM) so the relay cannot read
  or tamper with them, and offer signatures are verified client-side against the maker key in
  the signed offer, not against anything the relay claims.
- The Lightning demo backend uses an interim shared bearer token; treat the Lightning rails as
  a demo. Custody still does not depend on that token (the hosted nodes are keyless).
- No warranty. Testnet only.

## License

This repository does not yet declare a license of its own. Vendored components keep their
upstream licenses: the `@scure`/`@noble` bundles (`btc.js`, `noble-ciphers.js`) are MIT, and
`jsqr.js` is the jsQR project's build. SWK (which produces `pkg/`) carries upstream LWK's
licensing; see [SWK](https://github.com/GracedEternalKingCabbageMan/SWK).
