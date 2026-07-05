# Hosted-SeqLN LSP (the "we run SeqLN for the user" backend)

This is the backend the wallet's Lightning module (`../../seqln.js`) commands to
deliver the **non-custodial instant-LN asset↔BTC DEX from a thin wallet**. It
implements the LSP / hosted-SeqLN model of the UX audit §8.2 (Tier 2):

- **We host** the SeqLN node (liquidity, channels, routing).
- **The wallet holds the keys.** On unlock it brings an on-device wasm signer
  online over a wss Noise_XK link (the vendored SDK in `../../lightning/`). The
  hosted node has **no `hsm_secret`**: every commitment update is co-signed by
  the device, so the LSP can command routing but can never move channel funds.
- **The wallet commands** swaps via this thin HTTP API; the hosted node takes a
  pure-LN order-book offer (`seqob-cli xpln`) while the device signs.

## API

Auth: `Authorization: Bearer <LSP_TOKEN>` (production must use per-wallet auth —
a RUNE / signed challenge bound to the device pubkey; the shared token is interim).

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/health` | — (no auth) | `{ok:true}` |
| `GET` | `/status` | — | `{node_id, network, channels:[{peer_id, asset_label, spendable_units, receivable_units, state}]}` |
| `POST` | `/swap` | `{side:'buy'|'sell', asset, amount}` | `{ok, preimage, base_amount, quote_amount, finality:'final', settled_ms}` |

`asset` accepts a ticker (`GOLD`) or a 32-byte hex asset id. The pair is
`<asset>/BTC`, where the BTC leg is a real Bitcoin-LN policy channel in
production, or a second issued asset (`BTCX`) as a regtest stand-in.

Pure-LN is the one settlement state honestly labelled **final** (nothing on-chain,
no Bitcoin-reorg surface — DEX 0-conf policy + Principle 1).

## Run

```sh
LNCLI=/path/to/lightning-cli \
HOSTED_RPC=/path/to/hosted/<network>/lightning-rpc \
SEQOB_CLI=/path/to/seqob-cli \
RELAY=http://127.0.0.1:9955 \
GOLD=<gold asset id> BTCX=<btc-stand-in asset id> \
LSP_PORT=9981 LSP_TOKEN=<token> \
  node lsp-server.mjs
```

The service assumes the rest of the hosted backend is already up:

1. **seqobd** relay (`seqobd -listen :9955`).
2. **Keyless hosted SeqLN node** whose `hsmd` is the remote device signer —
   `lightningd --subdaemon=hsmd:<wrapper>` where the wrapper sets
   `SEQLN_SIGNER_LISTEN` (Noise_XK responder), `SEQLN_HOST_PRIVKEY`, and pins the
   device's `SEQLN_SIGNER_PEER_PUBKEY`.
3. **WS↔TCP relay** (`seqln/contrib/seqln-signer/wasm/relay/seqln-ws-relay.mjs`)
   fronting the proxy's TCP listener so the browser device can reach it over wss.
4. **LP maker** `seqob-maker -mode pureln -side sell` with the GOLD leg and the
   BTC-stand-in **hold** leg on **separate peers** (avoids the same-peer
   multi-asset misroute; capstone finding #1).
5. **Announced** asset channels to the hosted node (GOLD inbound + BTC-stand-in
   pushed for outbound). Asset routing (`getroute asset=…`) only matches
   channels whose on-chain asset is in gossip, so the channels must be
   **announced**, not private.

## Wiring the wallet to a running LSP

Set globals before the wallet module loads (mirrors `window.SEQ_SEQOB_URL`):

```js
window.SEQ_LSP_URL         = 'https://host/lsp';   // this service (default: origin + '/lsp')
window.SEQ_LSP_TOKEN       = '<bearer token>';
window.SEQ_LSP_WS          = 'wss://host/lsp-signer'; // the WS↔TCP relay front
window.SEQ_LSP_HOST_PUBKEY = '<hosted proxy static pubkey>';
// local pinning against a fixed harness node (optional):
window.SEQ_LSP_DEV_MNEMONIC = '<hosted node LN seed>';
window.SEQ_LSP_DEV_KEY      = '<pinned device transport privkey>';
```

With `SEQ_LSP_WS` + `SEQ_LSP_HOST_PUBKEY` set, the wallet connects the on-device
signer on unlock and the Swap tab shows an **"Instant (Lightning)"** rail for any
BTC↔asset pair.

## Proof

A Node end-to-end harness drives this exact API + the vendored wallet SDK: it
connects the on-device signer (keys never leave the process), boots the keyless
hosted node, opens the separate-peer asset channels, posts an LP offer, then
`POST /swap buy` settles a pure-LN GOLD↔BTC-stand-in trade — the device serving
`SIGN_REMOTE_COMMITMENT_TX`/`VALIDATE_COMMITMENT_TX`/`ECDH` during the swap, with
**real per-asset movement** (GOLD in, BTC-stand-in out on the correct channels),
not just a shared preimage. See the laptop harness noted in the build report.
