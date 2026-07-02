---
'@toon-protocol/git': minor
---

`rig` CLI bin (#229): `rig push [refspecs...]` with the estimate → confirm → execute flow — fee table (refs, objects, bytes, itemized + total; permanent + non-refundable), `--force`/`--all`/`--tags`/`--yes`/`--json`/`--relay`/`--repo-id`, automatic daemon (toon-clientd `/git/*` routes) vs standalone (embedded nonce-guarded client) publisher selection with `--daemon`/`--standalone` overrides, structured error UX (non-fast-forward → `--force` hint, oversize objects → paths+sizes + #235, funding/daemon-down remediation), and `rig init`-lite persistence of `toon.repoid`/`toon.owner`/`toon.relay` git config after the first successful push. Also exports the `/git/*` wire types + `serializePushPlan`/`serializePushResult` from a new `routes.ts` so `@toon-protocol/client-mcp` can adopt them.
