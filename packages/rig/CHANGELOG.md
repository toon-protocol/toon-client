# @toon-protocol/rig

## 0.2.9

### Patch Changes

- fec8793: Extract the Arweave gateway preference list into a single shared package `@toon-protocol/arweave` (was hand-duplicated in `views`, `rig`, and `client-mcp`).

  - New private, zero-dep `@toon-protocol/arweave` owns `ARWEAVE_GATEWAYS` + `arweaveTxId` / `arweaveUrls` / `arweaveGatewayCandidates`; `client-mcp` inlines it via tsup `noExternal` so the published bundle keeps zero `@toon-protocol/*` runtime deps.
  - `client-mcp`: upload-side gateway list is now configurable via `TOON_CLIENT_ARWEAVE_GATEWAYS` (comma-separated) > config file > shared default, threaded into `uploadMedia`.
  - `views`: media render imports the shared package (`parsers/arweave.ts` removed); the sandboxed-app CSP `connect`/`resource` domains default to the full gateway list (was `arweave.net` only, which would block ar.io media in the iframe).
  - `rig`: re-exports the shared list/timeout (importers unchanged).

- Updated dependencies [fec8793]
- Updated dependencies [c90d97d]
- Updated dependencies [44da9c9]
- Updated dependencies [2bdb1b5]
  - @toon-protocol/arweave@0.1.1
  - @toon-protocol/views@0.7.0

## 0.2.8

### Patch Changes

- @toon-protocol/views@0.6.1

## 0.2.7

### Patch Changes

- Updated dependencies [9aef6b9]
  - @toon-protocol/views@0.6.0

## 0.2.6

### Patch Changes

- Updated dependencies [f188433]
  - @toon-protocol/views@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [1db36cb]
  - @toon-protocol/views@0.4.0

## 0.2.4

### Patch Changes

- Updated dependencies [188ffa0]
  - @toon-protocol/views@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [bddc54d]
- Updated dependencies [4f51ba1]
- Updated dependencies [25d0473]
  - @toon-protocol/views@0.2.0

## 0.2.2

### Patch Changes

- Updated dependencies [dcb9c89]
- Updated dependencies [7d9b1db]
  - @toon-protocol/views@0.1.2

## 0.2.1

### Patch Changes

- Updated dependencies [a91f5c5]
  - @toon-protocol/views@0.1.1
