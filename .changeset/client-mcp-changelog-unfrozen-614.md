---
'@toon-protocol/client-mcp': patch
---

This changelog starts again, and the `.mcpb` download page now carries it.

Everything above this entry is new after a ten-day gap. `@toon-protocol/client-mcp` was in `.changeset/config.json`'s `ignore` list, which does two separable things: it stops the package publishing to npm, and it stops changesets **versioning** it. Only the first was wanted (#549 retired it from npm). The second froze `version` at `0.36.9` and meant `changeset version` never consumed a changeset naming only this package — six of them accumulated in `.changeset/` from 2026-08-07 onward, and every description in them reached no changelog anywhere. Since the `.mcpb` this package builds is the artifact users install, that left the only shipped artifact in the repo with no release notes at all, and every build after 08-07 carrying the same version number as every other one.

The package is now `private: true` but **not** `ignore`d — the same shape `packages/rig` already has here. `private` is what keeps it off npm (`changeset publish` filters on it), so the retirement decision is unchanged; dropping `ignore` only restores the version bump and the changelog. The six stranded changesets are consumed by this release, which is why the entries above are dated as far back as `toon_swap`'s `btpUrl` fix.

Two gates now hold it open. `release.yml` builds the `mcpb-latest` release body from the top section of this file instead of emitting version-and-sha only, so a Desktop user reading the download page sees what moved. And CI fails a PR that leaves any changeset unconsumed — the silent, no-error half of the family whose loud half (#611's mixed changeset) was fixed in #612.

Closes #614.
