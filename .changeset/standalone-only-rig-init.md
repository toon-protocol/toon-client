---
'@toon-protocol/rig': major
---

Standalone-only CLI + RIG_MNEMONIC identity chain + `rig init` (#248).

BREAKING:

- Daemon mode is removed from the `rig` CLI: the `--daemon`/`--standalone` flags, the toon-clientd `/status` probe with automatic mode selection, and the CLI's loopback `/git/*` HTTP client are gone. Every command publishes through the embedded, nonce-guarded StandalonePublisher. The daemon's `/git/*` routes and `toon_git_*` MCP tools are unaffected (that's the MCP host path), the shared wire types in `routes.ts` stay exported, and the nonce guard still refuses when a running toon-clientd holds the same identity.
- Repo config is no longer written as a side effect of the first push. `rig push` and the single-event commands now error with "run `rig init` first" when `toon.repoid` is unconfigured (`--repo-id`/`--owner`/`--relay` flag overrides keep working), and never mutate git config.
- Human/JSON output no longer carries a `mode` field; paid commands now report the active identity (`identity: { pubkey, source, sourceLabel }` in `--json`; an `Identity:` line in terminal output). The phrase itself is never printed or persisted.

NEW:

- Identity resolution precedence: `RIG_MNEMONIC` env > `TOON_CLIENT_MNEMONIC` env (deprecated alias, warns on stderr) > project-local `.env` (walked up from the working directory; ONLY the `RIG_MNEMONIC` line is parsed — never arbitrary env, never required) > `~/.toon-client` keystore/config.
- `rig init`: one-shot, idempotent repo setup — verifies the git repo (hints at `git init`, never runs it), resolves the identity chain (errors with all three remediation options), writes `toon.repoid` (default: directory basename, `--repo-id` overrides, existing value kept on re-runs) and `toon.owner` (derived pubkey) to the LOCAL git config, and prints the relay follow-up when none is configured. `--json` supported.
