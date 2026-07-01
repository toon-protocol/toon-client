---
'@toon-protocol/git': minor
---

Push planner/executor for the Rig write path (#226).

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
