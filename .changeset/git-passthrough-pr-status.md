---
'@toon-protocol/rig': major
---

Git passthrough + BREAKING `rig status` → `rig pr status` (#250).

**BREAKING — the NIP-34 status publish moved:** `rig status <target-event-id> <open|applied|closed|draft>` (the paid kind:1630–1633 publish) is now **`rig pr status <target-event-id> <state>`**. Bare `rig status` no longer publishes anything — it passes through to `git status`. Update scripts accordingly; flags (`--yes`, `--json`, `--remote`, `--relay`, `--repo-id`, `--owner`) and the `--json` receipt shape are unchanged apart from `command: "pr status"`.

- NEW git passthrough: any subcommand rig does not own is executed as `git <argv...>` verbatim — `rig add -p`, `rig commit -m`, `rig log --oneline`, `rig diff`, `rig branch`, `rig checkout`, `rig rebase -i`, everything. The child git runs with `stdio: 'inherit'` (interactive commands, pagers, colors, prompts all work), rig's exit code is git's exit code exactly (signal deaths map to 128+N), and SIGINT/SIGTERM/SIGHUP are relayed so git controls the outcome of a Ctrl-C. A missing system git is a clear error (exit 127).
- rig-owned verbs always win: `init`, `remote`, `push`, `issue`, `comment`, `pr`, `help`/`-h`/`--help`, and the new `--version`. In particular `rig push` remains the paid TOON push and shadows `git push` — plain-git pushes stay available by running `git push` directly.
- `rig help` now lists the owned verbs and states that any other command is passed through to git (`rig status` → `git status`).
