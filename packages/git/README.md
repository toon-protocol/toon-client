# @toon-protocol/git

Git-to-TOON write path core — build git objects and NIP-34 events for the Rig control plane.

Pure builders only (no network, signing, or payments):

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`, `createGitTree`, `createGitCommit`, `createGitTag` (annotated tags), the `GitObject`/`GitObjectType` types, `hashGitObject`, and the `MAX_OBJECT_SIZE` (95KB) upload guard constant.
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent` (caller signs and publishes): `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618, incl. `arweave` sha→txId tags), `buildIssue` (1621), `buildComment` (1622), `buildPatch` (1617, optional real `git format-patch` content), `buildStatus` (1630–1633).

Promoted from the proven Rig E2E seed pipeline (`packages/rig/tests/e2e/seed/lib`). Repo reading, remote state, push planning, the `Publisher`, and the `rig` CLI land in the follow-up tickets of [epic #222](https://github.com/toon-protocol/toon-client/issues/222).
