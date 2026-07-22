---
---

chore: stand up the `.sandcastle/` software factory (agent:implement / agent:review runners, dry-run plan, agent image) and add a per-package `typecheck` gate.

Empty changeset on purpose: the touched publishable packages (`client`, `client-mcp`, `rig`) only gain a `typecheck` npm script — there is no runtime/API change to release, so no version bump is warranted. This file exists solely to satisfy the CI changeset gate. See toon-protocol/toon-meta#186.
