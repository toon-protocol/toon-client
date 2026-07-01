---
'@toon-protocol/arweave': minor
'@toon-protocol/git': minor
---

Remote-state reader for the Rig write path (#225).

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
