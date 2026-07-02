# @toon-protocol/arweave

## 0.2.0

### Minor Changes

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

## 0.1.1

### Patch Changes

- fec8793: Extract the Arweave gateway preference list into a single shared package `@toon-protocol/arweave` (was hand-duplicated in `views`, `rig`, and `client-mcp`).

  - New private, zero-dep `@toon-protocol/arweave` owns `ARWEAVE_GATEWAYS` + `arweaveTxId` / `arweaveUrls` / `arweaveGatewayCandidates`; `client-mcp` inlines it via tsup `noExternal` so the published bundle keeps zero `@toon-protocol/*` runtime deps.
  - `client-mcp`: upload-side gateway list is now configurable via `TOON_CLIENT_ARWEAVE_GATEWAYS` (comma-separated) > config file > shared default, threaded into `uploadMedia`.
  - `views`: media render imports the shared package (`parsers/arweave.ts` removed); the sandboxed-app CSP `connect`/`resource` domains default to the full gateway list (was `arweave.net` only, which would block ar.io media in the iframe).
  - `rig`: re-exports the shared list/timeout (importers unchanged).
