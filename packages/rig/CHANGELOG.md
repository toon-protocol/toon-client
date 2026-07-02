# @toon-protocol/rig

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
