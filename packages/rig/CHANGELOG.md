# @toon-protocol/rig

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
