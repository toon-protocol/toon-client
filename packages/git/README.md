# @toon-protocol/git

Git-to-TOON write path core — build git objects and NIP-34 events for the Rig control plane.

No signing or payment code lives here — that stays behind the `Publisher` seam:

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`, `createGitTree`, `createGitCommit`, `createGitTag` (annotated tags), the `GitObject`/`GitObjectType` types, `hashGitObject`, and the `MAX_OBJECT_SIZE` (95KB) upload guard constant.
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent` (caller signs and publishes): `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618, incl. `arweave` sha→txId tags), `buildIssue` (1621), `buildComment` (1622), `buildPatch` (1617, optional real `git format-patch` content), `buildStatus` (1630–1633).
- `repo-reader.ts` — `GitRepoReader`, read-only local-repo access via injection-safe `execFile` git plumbing: `listRefs`, `objectsBetween`(+`WithPaths`), `readObjects`, `statObjects`, `isAncestor`, `formatPatch`, `resolveRef`.
- `remote-state.ts` — `fetchRemoteState`, the "what does the remote have?" reader: kind:30617/30618 relay fetch (NIP-33 latest-wins across a plural relay list) + `resolveMissing` Arweave GraphQL Git-SHA fallback.
- `publisher.ts` — the `Publisher` interface (paid transport seam): `getFeeRates`, `uploadGitObject`, `publishEvent`. Implemented by the daemon (#227) and the standalone embedded client (#228).
- `push.ts` — `planPush` (ref classification, object delta minus known sha→txId hints, oversize hard error, fee estimate) and `executePush` (uploads ref tips last, then ONE cumulative kind:30618 merging the full arweave map, kind:30617 first on first push; crash-resume safe via content-addressed skip).

Pure builders promoted from the proven Rig E2E seed pipeline (`packages/rig/tests/e2e/seed/lib`). The `Publisher` implementations and the `rig` CLI land in the follow-up tickets of [epic #222](https://github.com/toon-protocol/toon-client/issues/222).
