---
'@toon-protocol/rig': patch
---

Make `npm i -g @toon-protocol/rig` actually work from the registry (#259).

- `@toon-protocol/arweave` moves from `dependencies` to `devDependencies`: tsup already inlines it (code and types) into dist, but the leftover runtime entry got its `workspace:*` rewritten to a concrete version of a then-private package at publish time, so rig 2.0.0 shipped a hard dependency on an unpublished package and every fresh `npm i -g` died with E404. (`packages/arweave` is also no longer `private`, so the registry gains `@toon-protocol/arweave@0.2.0` and already-published consumers that pin it — rig 2.0.0, views 0.13.1 — become retroactively installable.)
- `@toon-protocol/client` is now a regular runtime dependency instead of an optional peer: the CLI is standalone-only (#248) and needs the client for identity derivation and every paid command, so installation must pull it automatically. The dynamic imports stay (startup code-splitting), but the "install the optional peer and re-run" failure mode is gone.
