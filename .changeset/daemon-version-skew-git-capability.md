---
"@toon-protocol/rig": minor
"@toon-protocol/client-mcp": minor
---

rig: capability-check the daemon before delegating git ops; actionable error against an old toon-clientd (#306)

`rig push` (and `issue`/`comment`/`pr create`/`pr status`) against a running-but-OLD `toon-clientd` used to dead-end with an opaque `daemon rejected the operation (HTTP 404): Not Found`. The daemon-as-accelerator delegation (#279) probes `GET /status` and, on a same-identity match, delegates to the daemon's `/git/*` routes — but those routes only exist since #227, so an older daemon has `/status` yet 404s every git call.

- **client-mcp**: `/status` now advertises `capabilities: ['git']` so a version-skewed rig can gate before it commits to a route the daemon lacks. Backward-compatible additive field; the daemon must be restarted to advertise it. (Fixed-group with `@toon-protocol/views`.)
- **rig**: capability-probes the daemon before delegating. A same-identity daemon that does not advertise `git` (or predates the field) no longer dead-ends — it raises a clear, actionable error naming both remediations (upgrade `@toon-protocol/client-mcp@latest` + restart, or stop the daemon to run standalone). A `/git/*` 404 despite a positive probe degrades to the same message (defense in depth). No silent fallback to standalone: a same-identity daemon makes the #228 nonce guard refuse standalone anyway, so the only correct resolution is upgrading or stopping the daemon.
