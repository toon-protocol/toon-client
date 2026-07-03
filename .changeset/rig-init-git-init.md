---
'@toon-protocol/rig': minor
---

feat(rig): `rig init` initializes the git repo itself instead of dead-ending

`rig init` already offers to mint + persist an identity on a cold start
(#294), but it flatly refused when the cwd was not inside a git repository —
hinting at `git init` and never running it. Creating a `.git` is a smaller,
safer, idempotent action than minting a seed phrase, so init now offers it
too, behind the same consent gate:

- **TTY**: prompts `Initialize a git repository here? [y/N]` (same default-no
  shape as the identity prompt). On yes it runs `git init` in the cwd and
  proceeds with normal init; on no it keeps the existing remediation.
- **`--git-init`**: non-interactive flag that runs `git init` then proceeds
  (the scripting path); also skips the prompt in a TTY.
- **Non-TTY / `--json` without the flag**: still refuses (never silently
  creates a repo), but the `NotAGitRepositoryError` remediation now leads with
  `rig init --git-init` (and still mentions plain `git init`).

`git init` runs in the resolved cwd only (never a parent). Combined with
`--generate-identity`, `rig init --git-init --generate-identity` is a fully
non-interactive fresh setup: an empty directory becomes rig-ready in one
command (git repo → identity → toon config). `--json` reports the new
`initializedGitRepo` field. Closes #300.
