---
'@toon-protocol/rig': minor
---

feat(rig): `RIG_STANDALONE` / `--standalone` to always bypass the daemon

By default rig delegates paid commands to a running `toon-clientd` that holds
the same identity (#279), and refuses the standalone path outright when that
daemon is too old for the `/git` routes — leaving no way to just run embedded.

Add a durable force-standalone override:

- `RIG_STANDALONE=1` (env; also `true`/`yes`/`on`) — set once, applies to every
  paid command: push, issue/comment/pr, and the money commands
  (channel/site/maintainers) that build the embedded publisher.
- `--standalone` / `--no-daemon` — per-invocation flags on `rig push` and the
  single-event commands, equivalent to the env var for that one run.

When forced, `resolvePaidSession` skips the daemon probe entirely (no
delegation, even when a same-identity daemon supports `/git`), and the embedded
`StandalonePublisher` skips Guard 1 (the same-identity daemon refusal). Guard 2,
the exclusive per-identity advisory lockfile (`NonceLock`), STILL runs, so two
standalone rig processes cannot race the payment channel's cumulative-claim
watermark. If a daemon is also actively signing on the same identity, stop it
(pid in `~/.toon-client/daemon.pid`) to avoid a claim race.
