---
'@toon-protocol/views': patch
---

Parse NIP-34 kind:1618 pull requests and kind:1619 PR updates (issue #446), closing a spec-conformance gap that made any NIP-34 client publishing PRs instead of patches (e.g. block/buzz) invisible to every TOON forge surface.

- `PRMetadata` gains `sourceKind: 1617 | 1618` plus optional `tipCommit`, `cloneUrls`, `branchName`, `mergeBase`, `labels`. Existing kind:1617 output is unchanged apart from the new `sourceKind` field.
- `parsePR()` now accepts kind:1618: title from `subject`, body from `content`, tip/clone/branch/merge-base/labels from their respective tags. `clone` is a single multi-value tag (`["clone", url1, url2, …]`) per Buzz's real builder shape, not one tag per URL.
- New `parsePRUpdate()` for kind:1619, keyed on the NIP-22 **uppercase** `E` tag (a lowercase `e` does not match), and `resolvePRTip()`, which — mirroring `resolvePRStatus` (#287) — honors only updates signed by an authorized author (repo owner ∪ maintainers) and picks the latest by `created_at`.
- `buildPRListFilter()` now requests `kinds: [1617, 1618]`; new `buildPRUpdateFilter()` filters kind:1619 by `#E`.

Read-side only: no write path, and PR objects behind a 1618's `clone` pointer are not fetched.
