# @toon-protocol/rig

## 2.2.0

### Minor Changes

- dff1e0c: Kill the ~32s fixed bootstrap tax on paid rig commands (#279): daemon-as-accelerator delegation + a standalone topology cache.

  - **Daemon delegation (automatic fast path)**: when a running `toon-clientd` on the loopback control port holds the SAME identity, paid write commands (`push`, `issue`, `comment`, `pr create`, `pr status`) now delegate to its `/git/*` routes instead of refusing with `DaemonIdentityConflictError` — the daemon owns the channel watermark (one writer, the original safety goal) and its bootstrap is warm. Identity is confirmed against `GET /status` before anything is sent. A daemon on a different identity, or no daemon, runs standalone exactly as before. The chosen path prints on stderr and appears in `--json` envelopes as `"path": "daemon" | "standalone"`. `rig fund` / `rig balance` / `rig channel …` have no daemon route and stay standalone (channel mutations still refuse under a same-identity daemon).
  - **Standalone topology cache**: the resolved #264 network topology (kind:10032 announce discovery, payment-peer pick, settlement-chain selection incl. funded-chain probes) is persisted under `TOON_CLIENT_HOME` keyed by relay + identity + explicit config, TTL 15 min (`RIG_TOPOLOGY_TTL_MS` overrides; `0` disables). A cached topology that fails to bootstrap is invalidated and re-resolved live in-process. Claim watermarks and the channel map are never cached — writes still resume from the persisted cumulative.
  - **Happy-path trim**: the on-chain deposit re-read on channel resume is skipped when the channel-map record already carries `depositTotal` (accounting state only, not the claim watermark).
  - **Exit-hang fix (the actual bulk of the 32s)**: instrumentation showed the paid work completes in ~2s — the remaining ~30s was the CLI process failing to exit because the embedded client leaves a keep-alive socket holding the event loop. The `rig` bin now flushes stdio and exits as soon as dispatch resolves (all work is awaited by then). Measured on live devnet: ~32s → ~1.8s cold standalone, ~1.6s warm (cache hit), ~0.5s daemon-delegated.

- cbb631c: The rig CLI read path (#278) — the multi-player half of the forge, all FREE (relay WS reads + Arweave gateway downloads; no payments, no channel, no identity needed). `rig clone <relay-url> <owner-npub-or-hex>/<repo-id> [dir]` bootstraps a repository from TOON: fetches the kind:30617/30618 state, downloads every object the refs need from the gateway fallback chain (parallel with a concurrency cap; SHAs missing from the `arweave` map resolve through the GraphQL Git-SHA resolver), verifies EVERY body against its SHA-1 (verification doubles as type discovery — content matching no git envelope type is rejected, never written), and materializes a real repository via git plumbing (`hash-object -w --stdin -t <type>` with the written SHA re-checked, `update-ref`, HEAD symref, checked-out worktree) — atomically: everything lands in a temp dir and moves into place only on success, and gateway propagation lag (10-20 min for fresh pushes) is an honest error listing the missing SHAs. Clones are immediately push/pull-capable: toon.repoid/toon.owner, the relay as the `origin` remote, remote-tracking refs, and upstream config all land like `git clone`. `rig fetch [remote]` runs the same pipeline against an existing repo — downloads only the missing delta, updates `refs/remotes/<remote>/*` (tags to `refs/tags/*`), and reports movements `git fetch`-style (new/fast-forward/forced); no merge (`rig merge origin/main` via the git passthrough). `rig issue list|show <id>` and `rig pr list|show <id>` read the tracker from the terminal: kind:1621/1617 scoped by the repo `#a` tag, state derived from kind:1630-1633 status events (latest wins; `--state` filters), kind:1622 comments under `show`, and `pr show` prints the full `format-patch` text for `git am` piping — all tolerant of the devnet relay's non-canonical EVENT serialization, all under the strict `--json` stdout contract. `clone` and `fetch` are rig-owned verbs now (they shadow `git clone`/`git fetch` exactly like `rig push` shadows `git push`; the plain git commands stay available by calling git directly).

### Patch Changes

- 671c2fc: `rig fund` UX remediation + CLI polish (#280):

  - **`rig fund` names the right knob first.** On a `custom`/unset network
    without a faucet, the guidance now leads with `TOON_CLIENT_NETWORK=devnet`
    (the actual fix for the shared devnet — no faucet URL needed) and frames
    `TOON_CLIENT_FAUCET_URL` as the self-hosted-network override. When a
    configured relay/proxy/BTP origin is under `*.devnet.toonprotocol.dev`, the
    message says so explicitly.
  - **Calm stderr on paid commands.** The embedded client's expected
    `[Bootstrap] Announce failed … 402 Payment Required` x402 dump is reframed
    as one plain-language info line (harmless, the command continues); repeats
    are dropped, non-402 announce failures still pass through. Internal issue
    numbers are gone from user-facing warnings.
  - **`rig pr create --body <text>` / `--body-file <path>`.** The PR
    description rides in a dedicated `description` tag on the kind:1617 event —
    never in the content, which stays pure `git format-patch` output so
    `git am` keeps applying it (git's patch-format detection hard-fails on
    leading prose). `rig pr show` renders the body as its own section and
    carries it in the `--json` envelope.

## 2.1.0

### Minor Changes

- c17e824: Full client money lifecycle in the CLI (#263): `rig fund`, `rig channel open|close|settle`, and `rig balance`. `rig fund` drips devnet faucet funds to the active identity's wallet (`POST {faucet}/api/request` with the derived chain address; faucet from `TOON_CLIENT_FAUCET_URL` → config `faucetUrl` → the deployed devnet faucet when `network` is devnet) and, on networks without a faucet, prints the wallet address(es) to fund externally. `rig channel open` runs the SAME resume-or-open path paid writes use lazily (recorded in the #262 peer→channel map; `--peer` anchors to an explicit ILP destination, `--deposit` adds collateral); `close`/`settle` drive the client's on-chain withdraw flow over recorded channels — close starts the settlement challenge window, settle releases collateral after it (refused locally, without gas, while the window is open) — recovering deposits stranded by pre-#262 one-channel-per-run behaviour. `rig balance` joins the client's settlement-chain-aware wallet readers with per-channel deposited/claimed/available from the map + claim watermark, uplink-free. On-chain commands follow the push confirm idiom (`--yes` required non-interactively; `--json` without `--yes` is a pure plan) and report the identity chain in their `--json` envelopes.
- b96f186: Real network bootstrap for standalone paid commands (#264, closing out #260's bootstrap root causes): rig now upgrades to `@toon-protocol/core` ^2.0.1 (live devnet genesis seed) and resolves the payment topology from the network instead of hand-fed constants, in strict `explicit config > live kind:10032 announce > genesis seed` order.

  - **Announce discovery**: paid commands discover the payment peer's kind:10032 `IlpPeerInfo` announce on the relay-origin (the relay resolved via `rig remote`). The announce supplies the uplink (`httpEndpoint`/`btpEndpoint`), the channel anchor (`ilpAddress`), the publish/store ILP routes (`routes` map — replacing the #228-era `<base>.relay.store` derivation as the default), and the peer's `supportedChains`/`settlementAddresses`.
  - **tokenNetwork fallback** (#260): per-chain TokenNetwork/token/RPC parameters the announce omits are derived — explicit config > announce > canonical devnet endpoint table > core's deterministic chain presets (matched by chain id) — and back-filled into the client's peer negotiation before the channel opens. A selected EVM chain whose TokenNetwork stays underivable fails with a clear error naming the announce, chain, and relay.
  - **Settlement-chain selection** (#260): explicit config (`TOON_CLIENT_CHAIN`/`chain`/`supportedChains`) > the chain of a live persisted #262 channel > the first announced EVM chain where the wallet holds tokens > the first announced EVM chain, with a printed rationale. The `network` preset field is no longer forwarded to the embedded client (its preset-first chain ordering steered devnet writes to the unfunded public Solana preset).

  Out of the box, `rig init` + `rig remote add origin <relay>` + a faucet-funded identity now completes a paid `rig push` on devnet with no destination/anchor/tokenNetwork/chain configuration.

- 2c2cb1f: Persist the peer→channel mapping so standalone rig reuses payment channels across invocations (#262). Paid commands now record the channel they lazily open in `TOON_CLIENT_HOME/rig-channels.json` (keyed by identity pubkey + peer destination + chain + tokenNetwork) and RESUME it on the next run — `trackChannel` rehydrates the cumulative-claim watermark from the client's `channels.json` — instead of opening (and funding) a fresh on-chain channel per CLI invocation. A corrupt map file refuses the paid operation before anything is opened. New free command: `rig channel list [--json]` shows recorded holdings (peer, chain, channel id, deposit, cumulative claimed, withdraw status).

### Patch Changes

- e9719e5: Strict `--json` stdout (#265, closes the #260 addendum): when `--json` is set on a rig-owned command, stdout carries exactly one parseable JSON document — a machine-readable guarantee for agent consumers (`rig … --json | jq`). A process-level stdout guard reroutes every stray write (including dependencies' `console.log`, e.g. the embedded client's `[Bootstrap] …` lines) to stderr; the io layer sends all human chatter (identity reports, deprecation nudges, migration hints, chain-selection rationales, discovery warnings) to stderr; errors emit one machine envelope on stdout plus human detail on stderr with a non-zero exit; and a backstop envelope covers paths that bail before emitting (usage errors, pre-payment refusals). `rig remote add/remove` gain proper `--json` envelopes. The git passthrough is exempt and documented as such (`rig status --json` is `git status --json`; `rig --json status` passes through untouched). An enforcement matrix test runs every rig-owned command in `--json` mode and asserts the single-document guarantee, with the noisy paths exercised deliberately.

## 2.0.1

### Patch Changes

- 9afc439: Make `npm i -g @toon-protocol/rig` actually work from the registry (#259).

  - `@toon-protocol/arweave` moves from `dependencies` to `devDependencies`: tsup already inlines it (code and types) into dist, but the leftover runtime entry got its `workspace:*` rewritten to a concrete version of a then-private package at publish time, so rig 2.0.0 shipped a hard dependency on an unpublished package and every fresh `npm i -g` died with E404. (`packages/arweave` is also no longer `private`, so the registry gains `@toon-protocol/arweave@0.2.0` and already-published consumers that pin it — rig 2.0.0, views 0.13.1 — become retroactively installable.)
  - `@toon-protocol/client` is now a regular runtime dependency instead of an optional peer: the CLI is standalone-only (#248) and needs the client for identity derivation and every paid command, so installation must pull it automatically. The dynamic imports stay (startup code-splitting), but the "install the optional peer and re-run" failure mode is gone.

## 2.0.0

### Major Changes

- 3629992: Git passthrough + BREAKING `rig status` → `rig pr status` (#250).

  **BREAKING — the NIP-34 status publish moved:** `rig status <target-event-id> <open|applied|closed|draft>` (the paid kind:1630–1633 publish) is now **`rig pr status <target-event-id> <state>`**. Bare `rig status` no longer publishes anything — it passes through to `git status`. Update scripts accordingly; flags (`--yes`, `--json`, `--remote`, `--relay`, `--repo-id`, `--owner`) and the `--json` receipt shape are unchanged apart from `command: "pr status"`.

  - NEW git passthrough: any subcommand rig does not own is executed as `git <argv...>` verbatim — `rig add -p`, `rig commit -m`, `rig log --oneline`, `rig diff`, `rig branch`, `rig checkout`, `rig rebase -i`, everything. The child git runs with `stdio: 'inherit'` (interactive commands, pagers, colors, prompts all work), rig's exit code is git's exit code exactly (signal deaths map to 128+N), and SIGINT/SIGTERM/SIGHUP are relayed so git controls the outcome of a Ctrl-C. A missing system git is a clear error (exit 127).
  - rig-owned verbs always win: `init`, `remote`, `push`, `issue`, `comment`, `pr`, `help`/`-h`/`--help`, and the new `--version`. In particular `rig push` remains the paid TOON push and shadows `git push` — plain-git pushes stay available by running `git push` directly.
  - `rig help` now lists the owned verbs and states that any other command is passed through to git (`rig status` → `git status`).

- d10965e: Standalone-only CLI + RIG_MNEMONIC identity chain + `rig init` (#248).

  BREAKING:

  - Daemon mode is removed from the `rig` CLI: the `--daemon`/`--standalone` flags, the toon-clientd `/status` probe with automatic mode selection, and the CLI's loopback `/git/*` HTTP client are gone. Every command publishes through the embedded, nonce-guarded StandalonePublisher. The daemon's `/git/*` routes and `toon_git_*` MCP tools are unaffected (that's the MCP host path), the shared wire types in `routes.ts` stay exported, and the nonce guard still refuses when a running toon-clientd holds the same identity.
  - Repo config is no longer written as a side effect of the first push. `rig push` and the single-event commands now error with "run `rig init` first" when `toon.repoid` is unconfigured (`--repo-id`/`--owner`/`--relay` flag overrides keep working), and never mutate git config.
  - Human/JSON output no longer carries a `mode` field; paid commands now report the active identity (`identity: { pubkey, source, sourceLabel }` in `--json`; an `Identity:` line in terminal output). The phrase itself is never printed or persisted.

  NEW:

  - Identity resolution precedence: `RIG_MNEMONIC` env > `TOON_CLIENT_MNEMONIC` env (deprecated alias, warns on stderr) > project-local `.env` (walked up from the working directory; ONLY the `RIG_MNEMONIC` line is parsed — never arbitrary env, never required) > `~/.toon-client` keystore/config.
  - `rig init`: one-shot, idempotent repo setup — verifies the git repo (hints at `git init`, never runs it), resolves the identity chain (errors with all three remediation options), writes `toon.repoid` (default: directory basename, `--repo-id` overrides, existing value kept on re-runs) and `toon.owner` (derived pubkey) to the LOCAL git config, and prints the relay follow-up when none is configured. `--json` supported.

### Minor Changes

- 121e8f9: Relays as origins (#249): configure relays as REAL git remotes and push to them like git.

  - NEW `rig remote add <name> <relay-url>` / `rig remote remove <name>` / `rig remote list [--json]` — mapped onto real `git remote` storage, so `git remote -v` shows them and plain git tooling round-trips the config (no parallel store). Junk URLs (anything but ws/wss/http/https) are rejected at add time; adding over an existing name is refused with a `git remote set-url` hint.
  - `rig push [remote] [refspecs...]` — git-like remote resolution: when the first positional matches a configured remote name it is the push target, otherwise it is a refspec and the remote defaults to `origin`. No usable remote → clear ``no origin configured — run `rig remote add origin <relay-url>` `` error. The event commands (`issue`/`comment`/`pr`/`status`) take `--remote <name>` (default `origin`).
  - `--relay <url>` stays as an ad-hoc override on every paid command — it bypasses the configured remotes entirely.
  - One relay URL per remote: a git remote with multiple URLs (`git remote set-url --add`) is refused BEFORE anything is fetched, uploaded, or paid.
  - Migration off `toon.relay` (deprecated, removed in v0.3): paid commands still fall back to it when no relay `origin` exists, printing a one-line migration nudge; `rig init` now migrates a single-valued `toon.relay` to a real `origin` remote automatically (the old key stays readable) and suggests `rig remote add origin <relay-url>` as the follow-up step when nothing is configured. Paid commands no longer silently fall back to the network-default relay.

## 1.0.0

### Minor Changes

- 508aa4d: Push planner/executor for the Rig write path (#226).

  `planPush({ repoReader, remoteState, feeRates, repoId, refs?, force? })`
  classifies every ref update (new / fast-forward / forced via `isAncestor`;
  non-fast-forward without `force` throws `NonFastForwardError` with the
  offending refs), computes the object delta (`objectsBetween` minus the
  remote's `arweave` sha→txId hints, with an injectable `resolveMissing` step
  for SHAs the tags don't cover), hard-errors on objects over the 95KB limit
  (`OversizeObjectsError` carries path + size per object), and returns a
  `PushPlan` with the full new ref state, upload list (ref tips ordered last),
  and a fee estimate (Σ bytes × uploadFeePerByte + per-event fees, announce
  included on first push).

  `executePush({ plan, publisher, remoteState, repoReader, relayUrls })`
  uploads the planned objects through the new `Publisher` interface
  (implemented by the daemon in #227 and the standalone client in #228), then
  publishes ONE cumulative kind:30618 whose `arweave` tags MERGE the remote's
  existing map with the new uploads (NIP-33 replaceable — prior hints are
  never dropped) and whose `r` tags carry the full new ref state, preceded by
  a kind:30617 announcement on first push. Content-addressed uploads make
  re-running after a crash safe: SHAs already in the merged map are skipped
  without paying.

  `GitRepoReader` gains `objectsBetweenWithPaths` (reach paths for actionable
  oversize errors) and `statObjects` (type + size via one
  `cat-file --batch-check` pass, no bodies).

- 3f30e36: Remote-state reader for the Rig write path (#225).

  `@toon-protocol/arweave` now owns the Git-SHA → Arweave txId GraphQL resolver
  (`resolveGitSha`, `seedShaCache`, `clearShaCache`, `shaCacheKey`,
  `isValidArweaveTxId`), extracted from rig's `web/arweave-client.ts` so the
  browser SPA and the Node write path share one implementation. Rig re-exports
  them from the same path, so its importers are unchanged.

  `@toon-protocol/git` gains `fetchRemoteState({ relayUrls, ownerPubkey, repoId })`:
  a NIP-01 WebSocket query for the repository's kind:30617 announcement and
  kind:30618 state (latest per NIP-33 replaceable semantics; tolerates inline
  JSON, double-JSON-encoded, and TOON-encoded EVENT payloads), returning the
  ref map, HEAD symref, `arweave` sha→txId hints, announcement metadata, and a
  `resolveMissing(shas)` helper backed by the shared GraphQL resolver.

- 453f734: Standalone embedded Publisher + daemon-collision nonce guard (#228).

  New `@toon-protocol/git/standalone` subpath export (the core entry stays
  dependency-light — `@toon-protocol/client` is an OPTIONAL peer dependency
  needed only by this entry): `StandalonePublisher` implements the `Publisher`
  interface over an EMBEDDED `ToonClient` built from the caller's config
  (mnemonic + account index, the `packages/client/src/config.ts` shape) for
  CI/servers/one-shot CLI runs with no toon-clientd. Publishes sign with the
  derived Nostr key and pay one balance-proof claim per write at the flat
  per-event fee; `uploadGitObject` mirrors the proven seed pipeline (kind:5094
  store write tagged Git-SHA/Git-Type/Repo, bytes × per-byte bid, routed via
  `proxyPath: '/store'`, Arweave txId decoded from the FULFILL — HTTP-enveloped
  or legacy bare form); `getFeeRates` reports the configured flat event fee +
  per-byte upload rate. Publish/store routes derive from the channel anchor with
  the daemon's `<base>.relay.store` convention.

  Nonce-ownership guard (the load-bearing piece): the payment channel's
  cumulative-claim watermark tolerates exactly ONE writer per identity, so
  before any paid operation the publisher (1) probes the toon-clientd loopback
  control API (`GET /status`, port 8787 / `TOON_CLIENT_HTTP_PORT`) and REFUSES
  with `DaemonIdentityConflictError` when a running daemon reports the same
  Nostr pubkey — use daemon mode or stop the daemon — and (2) holds an exclusive
  per-pubkey advisory lockfile (`standalone-<pubkey>.lock` under
  `~/.toon-client` / `TOON_CLIENT_HOME`) against other standalone processes,
  with stale-lock reclaim by dead-pid detection, released on `stop()` and
  process exit.

- 5e9e0df: `rig issue|comment|pr|status` subcommands (#231): single NIP-34 event publishes over the same two publisher modes as push — daemon (`POST /git/issue|comment|patch|status`) and standalone (local builders + the nonce-guarded embedded publisher, with the pre-pay single-relay guard). Repo addressing (`30617:<owner>:<repoId>`) resolves from the `toon.*` git config keys `rig push` persists, with `--repo-id`/`--owner` overrides and an actionable error when unconfigured. `rig pr create --range` publishes REAL `git format-patch --stdout` output as the kind:1617 content (one event per series; commit/parent-commit tags derived from the patch itself; `--patch-file` publishes verbatim). All four quote the per-event fee (daemon `/status` `feePerEvent` or standalone fee rates) behind the same confirm gate as push (`--yes`, non-TTY refusal, `--json` estimate). Also exports the single-event `/git/*` wire types (`GitRepoAddr`, `Git{Issue,Comment,Patch,Status}Request`, `GitEventResponse`) + `serializeEventReceipt` from `routes.ts`, and adds `GitRepoReader.commitParents`.
- 74f45a7: `rig` CLI bin (#229): `rig push [refspecs...]` with the estimate → confirm → execute flow — fee table (refs, objects, bytes, itemized + total; permanent + non-refundable), `--force`/`--all`/`--tags`/`--yes`/`--json`/`--relay`/`--repo-id`, automatic daemon (toon-clientd `/git/*` routes) vs standalone (embedded nonce-guarded client) publisher selection with `--daemon`/`--standalone` overrides, structured error UX (non-fast-forward → `--force` hint, oversize objects → paths+sizes + #235, funding/daemon-down remediation), and `rig init`-lite persistence of `toon.repoid`/`toon.owner`/`toon.relay` git config after the first successful push. Also exports the `/git/*` wire types + `serializePushPlan`/`serializePushResult` from a new `routes.ts` so `@toon-protocol/client-mcp` can adopt them.

### Patch Changes

- Updated dependencies [68a7150]
- Updated dependencies [3f30e36]
- Updated dependencies [1ff6370]
  - @toon-protocol/client@0.15.0
  - @toon-protocol/arweave@0.2.0
