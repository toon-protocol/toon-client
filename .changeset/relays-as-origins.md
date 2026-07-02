---
'@toon-protocol/rig': minor
---

Relays as origins (#249): configure relays as REAL git remotes and push to them like git.

- NEW `rig remote add <name> <relay-url>` / `rig remote remove <name>` / `rig remote list [--json]` — mapped onto real `git remote` storage, so `git remote -v` shows them and plain git tooling round-trips the config (no parallel store). Junk URLs (anything but ws/wss/http/https) are rejected at add time; adding over an existing name is refused with a `git remote set-url` hint.
- `rig push [remote] [refspecs...]` — git-like remote resolution: when the first positional matches a configured remote name it is the push target, otherwise it is a refspec and the remote defaults to `origin`. No usable remote → clear ``no origin configured — run `rig remote add origin <relay-url>` `` error. The event commands (`issue`/`comment`/`pr`/`status`) take `--remote <name>` (default `origin`).
- `--relay <url>` stays as an ad-hoc override on every paid command — it bypasses the configured remotes entirely.
- One relay URL per remote: a git remote with multiple URLs (`git remote set-url --add`) is refused BEFORE anything is fetched, uploaded, or paid.
- Migration off `toon.relay` (deprecated, removed in v0.3): paid commands still fall back to it when no relay `origin` exists, printing a one-line migration nudge; `rig init` now migrates a single-valued `toon.relay` to a real `origin` remote automatically (the old key stays readable) and suggests `rig remote add origin <relay-url>` as the follow-up step when nothing is configured. Paid commands no longer silently fall back to the network-default relay.
