# SeqDEX Cross-Rail Bridge — Session Handoff & Verification Guide

_Session `060d0669`, 2026-07-22. Author: agent "Saba". For a fresh session to verify the work and take over._

---

## 0. TL;DR

The rail-blind LSP **leg-bridge** (non-custodial cross-rail atomic swaps: BTC ↔ Sequentia-asset, matched blind to on-chain/Lightning rail choices) got a fund-safety review plus a chain of bring-up fixes this session.

- **Fund-safety: 2 SEVERE fund-loss bugs found + FIXED + LIVE. 3 lower-severity follow-ups addressed** (2 fixed & staged, 1 resolved with reasoning). See §5.
- **Full end-to-end SETTLEMENT is NOT yet witnessed.** Every component is individually proven (handshake, self-custody funding, relay, LSP front, recoup logic, fund-safety). The *full* settle kept losing to testnet4 timing. The last attempt on the **corrected** flow (`final8`) is running now, blocked only on anchor-bound cross-chain finality.
- **Your job:** verify a full settle (`sha256(P)==H` + the LSP recoup, on-chain/LN evidence), then make the staged fund-safety fixes live, then the two independent follow-ups (ln-asset rebuild; verify the anchor-ordering fix holds).

---

## 1. DESIGN SPEC — the intended function / design of the DEX

Canonical design docs live in the **node repo** (`Sequentia`), path `doc/sequentia/` — laptop `/home/aejkohl/SequentiaByClaude/doc/sequentia/`, box `/root/sequentia/SequentiaByClaude/doc/sequentia/`. The ones that define the DEX:

- **`seqdex-orderbook-design.md`** — the order-book DEX: resting signed intents, the matching model, the covenant CLOB.
- **`cross-chain-orderbook-consolidation.md`** — the UNIFIED cross-chain (BTC↔asset) order book (what the bridge lifts).
- **`seqdex-terminal-spec.md`** — the rail-blind trading terminal (the Swap tab): match on {asset, price, size, side}, rails are metadata.
- **`simplicity-dex-covenant-offers-design.md`** (+ .pdf/.html) — passive resting book via tapscript covenants.
- **SeqLN (Lightning):** `seqln-core-lightning-fork-spec.md`, `sequentia-lightning-cln-spec.md`, `seqln-step2-pure-ln-swaps-design.md`, `seqln-phase2-dex-integration.md`, `seqln-phase2-submarine-swaps.md`, `seqln-dex-instant-swap-latency.md`.
- **Consensus (the anchor gate the maker's claim depends on):** `04-proof-of-stake.md`, `proof-of-stake.{html,pdf}`.

**FIRST PRINCIPLES** (Bitcoin-anchoring supremacy; every wallet dual-chain; no privileged coin / open fee market; transparent-by-default; no inflation) are in the Theoretical Paper + white paper, distilled in the agent memory index `MEMORY.md`. The load-bearing one for THIS work: **Bitcoin anchoring is supreme consensus law** — the maker never reveals P until the asset leg is anchored at/above the BTC leg (`VerifySeqLegSafe`), and the whole system reorg-follows Bitcoin.

**Rail-agnostic matching invariant** (agent memory `dex-rail-agnostic-matching`): match rail-blind; the LSP is a value-path counterparty ONLY on a genuine rail cross or a JIT-inbound open — never a coincidence. In-code spec lives at the top of `tooling/lsp/leg-bridge.mjs`, `bridge-driver.mjs`, `bridge-maker.mjs`.

---

## 2. REPOS & THE ONE THING TO KNOW ABOUT EACH

All under `github.com/GracedEternalKingCabbageMan/*`. Deploy pipeline: **edit on laptop → commit → push → `git pull` on the box → build ON the box.** Never edit source on the box. Commit author MUST be `GracedEternalKingCabbageMan <...@users.noreply.github.com>`.

| Repo | Laptop | Box clone | Branch | Holds |
|---|---|---|---|---|
| **sequentia-web-wallet** | `~/sequentia-web-wallet` | `/root/sequentia/sequentia-web-wallet` | `main` | the **LSP bridge** (`tooling/lsp/`), the web wallet, the courier (`xcourier.js`), the E2E harness |
| **seqdex** | `~/seqdex` | `/root/sequentia/seqdex` | `phase3-pure-ln` | the **matching relay** (`seqobd`), the **cross maker** (`seqob-maker`), `seqob-cli`, the xchain swap primitives. `daemon/` is its OWN Go module (`github.com/aejkcs50/seqdex/daemon`) — build from `daemon/`. Go = `~/dev-tools/go/bin` (laptop), `/root/dev-tools/go/bin` (box). |
| **seqln** | `~/seqln` | `/root/sequentia/seqln` | `sequentia-stable` | the CLN fork (lightningd + subdaemons + holdinvoice plugin). Go = `~/dev-tools/go/bin`. |
| **Sequentia** (node) | `~/SequentiaByClaude` | `/root/SequentiaByClaude` (run) + git clone | `master` | elementsd/committee, price-server, docs |

Box access: `ssh seq` (never `ConnectionAttempts>1`). Box = `https://sequentiatestnet.com`.

---

## 3. THE BRIDGE, END TO END (the wired shape)

One shape is wired + fund-safe: **taker SELLS the asset and RECEIVES BTC over Lightning, against a REVERSE (buy) cross maker whose BTC leg is on-chain.** BTC leg = BRIDGED (`lnSide:'receiver'`); asset leg = NATIVE on-chain (taker funds its own HTLC self-custody). Flow:

1. **Handshake** (`bridge-maker.mjs`, LSP↔maker over the courier): LSP hands the maker its OWN btc-claim pubkey; maker mints H, funds a real on-chain BTC HTLC paying the LSP on H, sends terms. LSP parse-verifies claim==LSP / hash==H / refund==maker / CLTV (`verifyMakerBtcHtlc`).
2. **Taker waits for the maker's BTC HTLC to CONFIRM** (harness step 3.5 — added this session; anchor-ordering, see §5/Finding-anchor).
3. **Taker funds its OWN asset HTLC** self-custody (`seqob-cli xfund-seq -no-wait`, 0-conf), claim=maker-with-P, refund=taker-after-T_seq.
4. **Relay**: taker POSTs `/bridge/asset`; LSP relays the funded asset leg to the maker (`relayTakerAssetLeg`) → maker records it.
5. **LSP fronts** the taker's BTC-LN hold on H (`frontLn`) once: maker BTC HTLC ≥ `minRecoupConf` + asset leg locked + whole-swap `swapLocked`. Recoups by claiming the maker's BTC HTLC with P.
6. **Maker claims** the asset HTLC with P (reveals P) once `VerifySeqLegSafe` passes (asset block anchor ≥ maker's BTC-leg height, AnchorStatus "ok", block poscertified).
7. **Taker** reads P off-chain, verifies `sha256(P)==H`, settles its hold → receives BTC-LN. **LSP recoups** the maker's BTC HTLC with P.

Fund-safety core: `leg-bridge.mjs` (pure `nextBridgeStep` — never front unless recoup secured; 63 unit tests). Driver: `bridge-driver.mjs`. Live I/O + job persistence + `/bridge/asset` + resume-on-boot: `lsp-server.mjs`. Maker recovery: `seqob-maker cross`'s `-resume` (seqdex).

---

## 4. CURRENT STATE — and HOW TO CHECK IT (don't trust the pids below; re-derive)

Snapshot at handoff (pids are ephemeral — commands to re-check follow):

- **Matching relay `seqobd` on :9955** — RESTARTED this session with `-xsession-deadline 3h` (was defaulting short → the relay-stale). Cross makers reconnected. Check: `ss -tlnp | grep :9955`, `tr '\0' ' ' </proc/<pid>/cmdline` (must show `xsession-deadline 3h`).
- **Bridge LSP on :9981** — supervised by `/root/sequentia/lsp/run-lsp-b5b1-live-relaunch.sh` (it `exec node …/lsp-server.mjs` from the box files). Running instance HAS the 2 SEVERE fixes live, but **NOT** Findings 4 & 5 (committed after its last restart). To make new code live: `git pull` on box, then `kill` the pid on :9981 — the supervisor auto-relaunches from the pulled files (do NOT hand-launch; port race). Its logs go to a dead socket (unreadable) — patch the supervisor to redirect if you need them.
- **Staging LSP on :9982** — separate instance, not the bridge.
- **Cross maker fleet** — ~148 `seqob-maker -mode cross`, launched by `/root/seqob-test/supervise-xmakers.sh` (churns ~50-70 min). They SHARE one `-xstate-dir /root/seqob-test/xmaker-sessions`.
- **Cross-resume settler** — `/root/seqob-test/supervise-xresume.sh` (single dedicated `-mode cross -resume` loop, `timeout 240`/pass). This is the maker-claim-resumability fix. Check: `pgrep -f supervise-xresume.sh`; log `/root/seqob-test/run/xresume.log`.
- **SeqLN nodes** — `btc-maker` + `btc-taker` (testnet4) UP (the bridge uses these). `ln-asset` (sequentia-testnet) DOWN — see §6.
- **The E2E run `final8`** — harness `/tmp/bridge-e2e-final8.log`; poller task `bt7ol1x13`. Job `c0fc2b1b`, H=`8dc1e924…`, maker BTC HTLC `750cd4be…`. At handoff it is CORRECTLY waiting for that BTC HTLC to confirm on testnet4 before funding the asset.

**Re-run the E2E to verify (the canonical test):**
```
ssh seq
# ensure taker wallet loaded + funded (its tSEQ locks into each run's HTLC; top up from xmm):
curl -s --user seq:seq -H content-type:text/plain http://127.0.0.1:18300/ --data-binary '{"method":"loadwallet","params":["bridge-taker"]}'
# if trusted balance < ~140:  wallet/xmm sendtoaddress <a bridge-taker addr> 300  (wait 1 SEQ block)
cd /root/sequentia/sequentia-web-wallet/tooling/lsp
setsid /root/sequentia/downloads/node22/bin/node bridge-taker-harness.mjs >/tmp/bridge-e2e-fresh.log 2>&1 </dev/null &
tail -f /tmp/bridge-e2e-fresh.log
```
It MUST run under **node22** (`/root/sequentia/downloads/node22/bin/node`) — node18's CJS lexer breaks the `seqob.js` ESM import. Success prints `RESULT {…"sha256_matches":true,"status":"settled"…}`. Verify independently: the asset HTLC is SPENT (maker claimed → P on-chain), the maker's BTC HTLC is SPENT (LSP recouped), `sha256(P)==H`.

**Note `c8eccacf…` IS the policy asset (tSEQ)** — labeled "bitcoin" in getbalances. The harness's ASSET is tSEQ, so it's a tSEQ↔BTC cross.

---

## 5. WHAT THIS SESSION CHANGED (commits + why)

**seqdex (`phase3-pure-ln`):**
- `4c73b0e` → `7a1fcf5` — cross-maker claim resumability. Recovery code existed but only `-resume` (one-shot) reached it; the supervised fleet always restarted in plain serve mode and stranded any swap cycled after recording the asset leg. Fix = a single dedicated `-resume` settler loop (per-maker resume would herd on the shared dir). **Deployed** (`/root/seqob-test/seqob-maker` rebuilt).
- `7521675` — `xfund-seq -no-wait` (0-conf) via new `LockSEQLegNoWait`. Lets the taker relay the asset leg immediately. **Deployed** (`/root/sequentia/seqdex/bin/seqob-cli` rebuilt).

**sequentia-web-wallet (`main`):**
- `6191ddd0` — **the 2 SEVERE fund-loss fixes** (see below). LIVE on 9981.
- `1e794f76` — documented the 3 follow-ups in-code.
- `0407fe30` — **Findings 4 & 5** implemented. STAGED (in files, live on next 9981 restart).
- `70a7514e` — Finding 3 resolved (doc): front-then-relay would reintroduce the relay-stale; the anchor gate already orders the maker's claim after the front. Downgraded MEDIUM→LOW.
- `7fa5bc08` / `591a2d92` — harness: relay at 0-conf, then (the correction) **wait for the maker's BTC HTLC to confirm before funding the asset**.

### Fund-safety review — findings
- **Finding 1 — SEVERE, FIXED (LIVE).** The "never front more than we recoup" amount check was DEAD in the driver wiring (`withAmount` passed `undefined`); a malicious maker could fund a 1-sat BTC HTLC and drain the LSP for full value. Fix: use `withAmt`/`io.legAmountSat`; core fails closed on a non-positive amount. Regression tests added.
- **Finding 2 — SEVERE, FIXED (LIVE).** LSP fronted against 0-conf, RBF-able maker HTLCs. Fix: `BRIDGE_DEFAULTS.minRecoupConf=1` + wire `xhtlc-observe` confirmations into `observe`.
- **Finding 4 — LOW, FIXED (STAGED).** `observeNativeLocked` bound only "funded". Now binds the AGREED asset-id + amount; degrades to the funded check if absent (no false stall).
- **Finding 5 — LOW, FIXED (STAGED).** `frontLn` on resume could duplicate-sendpay and lose P. Now adopts any prior pay on H via `paymentStatusForHash` before issuing a fresh sendpay.
- **Finding 3 — LOW, RESOLVED (no code).** See above.

### The two bring-up bugs the E2E kept hitting (BOTH now fixed)
- **Relay-stale.** The courier lift SESSION had a short co-sign deadline; the LSP's courier WS went idle during the taker's confirmation wait and the session expired (`RunDeadlineSweeper`), so `/bridge/asset` silently failed and the maker never got the asset leg. **Fix: the relay's `-xsession-deadline` (3h for cross-chain) now applies (relay restarted).**
- **Anchor-ordering inversion (my mistake, then fixed).** Relaying/funding the asset at 0-conf let the fast SEQ chain anchor it BELOW the maker's slow testnet4 BTC HTLC, so `VerifySeqLegSafe` (asset anchor ≥ btcLegHeight) never passed and the maker could never claim (final7 died this way, refunds at T_seq). **Fix: the harness now waits for the maker's BTC HTLC to confirm before funding the asset** (what the maker code expects — "the taker waits for OUR confirmation first"). The 3h session covers the wait.

---

## 6. OPEN ITEMS — what to verify / take over (priority order)

1. **Prove a full E2E settlement.** Watch `final8` / re-run (see §4). This is the one thing not yet witnessed. If it stalls: check the maker BTC HTLC confs (`getrawtransaction`) — a low-fee testnet4 HTLC may just be slow; the harness aborts no-loss after 75 min. If it settles: verify on-chain + `sha256(P)==H` and you're done.
2. **Make Findings 4 & 5 live.** After (1) settles: `git pull` on the box, then `kill` the :9981 pid (supervisor relaunches from files). Re-run the E2E once to confirm the happy path still fronts (the new binds/gates could false-stall if wrong — they were written to degrade safely, but verify).
3. **`ln-asset` seqln node — DOWN.** Crashes on startup: `lightning_channeld: bad version 'hsmd-proxy-revert-preRobustness-14-g6c50d2e'` — an INCONSISTENT seqln build (installed `lightningd` newer than its `channeld`). Fix per `[[seqln-robustness-binary-upgrade]]`: a consistent seqln rebuild+install + clean reboot. It does NOT block the cross bridge (that uses `btc-maker`/`btc-taker`, which are UP because they never restarted onto the mismatched binary — a full reinstall would need them cycled too). Config: `/root/sequentia/lsp/ln-asset/config`.
4. **Consider whether the anchor-ordering wait belongs in the LSP, not the harness.** The harness is a test tool; the REAL wallet flow (`swap.js` bridged-take path) must also wait for the maker's BTC HTLC to confirm before funding the asset. Port the same guard there.
5. **Relay session robustness (design).** The re-attach-by-session_id path is CLOSED (the relay binds each role to its WS connection; a fresh WS gets 403). So the long cross-chain session depends on the WS staying alive for hours. `ws.go` has no server-side ping/keepalive — worth adding for robustness on a real network (localhost held for now).

---

## 7. NON-NEGOTIABLES (agent memory `MEMORY.md` — read it)

- **Bitcoin anchoring is supreme** — the anchor gate blocking a claim is CORRECT, never "fix" it by ignoring anchors. The anchor-ordering wait exists BECAUSE of this.
- **Fund-safety > speed.** Every value-move fails closed. Never commit secrets (repos are world-readable). Testnet has no real value — break-and-fix is fine, but the consent rails (never enter creds / trade for the user) and secret hygiene are inviolable.
- **Every stalled swap this session was provable no-loss** (P never went public → nothing settled).

Deeper detail + the running resume-point: agent memory `leg-bridge-fundsafety-and-e2e.md`, `dex-rail-agnostic-matching.md`, `sequentia-anchoring-supremacy.md`.
