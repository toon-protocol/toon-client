# @toon-protocol/rig

## 0.2.31

### Patch Changes

- Updated dependencies [3f30e36]
  - @toon-protocol/arweave@0.2.0
  - @toon-protocol/views@0.12.3

## 0.2.30

### Patch Changes

- @toon-protocol/views@0.12.2

## 0.2.29

### Patch Changes

- Updated dependencies [74a79ca]
- Updated dependencies [4b0d0d2]
- Updated dependencies [d0b5f78]
- Updated dependencies [432eca3]
- Updated dependencies [c0cb407]
- Updated dependencies [5d7f58c]
- Updated dependencies [49a2e31]
  - @toon-protocol/views@0.12.1

## 0.2.28

### Patch Changes

- Updated dependencies [b243c10]
  - @toon-protocol/views@0.12.0

## 0.2.27

### Patch Changes

- Updated dependencies [48205b0]
  - @toon-protocol/views@0.11.0

## 0.2.26

### Patch Changes

- @toon-protocol/views@0.10.9

## 0.2.25

### Patch Changes

- Updated dependencies [0f6fc74]
  - @toon-protocol/views@0.10.8

## 0.2.24

### Patch Changes

- @toon-protocol/views@0.10.7

## 0.2.23

### Patch Changes

- Updated dependencies [139e405]
  - @toon-protocol/views@0.10.6

## 0.2.22

### Patch Changes

- @toon-protocol/views@0.10.5

## 0.2.21

### Patch Changes

- @toon-protocol/views@0.10.4

## 0.2.20

### Patch Changes

- Updated dependencies [9a40ac0]
  - @toon-protocol/views@0.10.3

## 0.2.19

### Patch Changes

- Updated dependencies [686f7a3]
  - @toon-protocol/views@0.10.2

## 0.2.18

### Patch Changes

- Updated dependencies [1afc5c8]
  - @toon-protocol/views@0.10.1

## 0.2.17

### Patch Changes

- Updated dependencies [9073156]
- Updated dependencies [24dad85]
  - @toon-protocol/views@0.10.0

## 0.2.16

### Patch Changes

- Updated dependencies [d93211a]
  - @toon-protocol/views@0.9.1

## 0.2.15

### Patch Changes

- Updated dependencies [0e08607]
  - @toon-protocol/views@0.9.0

## 0.2.14

### Patch Changes

- Updated dependencies [5838b79]
  - @toon-protocol/views@0.8.3

## 0.2.13

### Patch Changes

- @toon-protocol/views@0.8.2

## 0.2.12

### Patch Changes

- Updated dependencies [623bb8e]
  - @toon-protocol/views@0.8.1

## 0.2.11

### Patch Changes

- Updated dependencies [801949d]
- Updated dependencies [98f9e74]
- Updated dependencies [83eb81b]
- Updated dependencies [9a917f5]
- Updated dependencies [6c18a4b]
- Updated dependencies [d0b1055]
  - @toon-protocol/views@0.8.0

## 0.2.10

### Patch Changes

- @toon-protocol/views@0.7.1

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
