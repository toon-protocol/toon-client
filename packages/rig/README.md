# @toon-protocol/rig

Git-to-TOON write path core — build git objects and NIP-34 events for the Rig control plane. Ships the **`rig`** CLI: a 1:1 git experience with a TOON remote. rig owns a handful of TOON verbs (table below); **every other command is passed through to system `git` verbatim** — `rig status` runs `git status`, `rig add -p`, `rig commit`, `rig rebase -i`, … all behave exactly like git (same output, same prompts, same exit code).

| command | owner | what it does |
| --- | --- | --- |
| `rig init` | rig (free) | one-shot repo setup: identity + `toon.*` git config |
| `rig remote add/remove/list` | rig (free) | relays as REAL git remotes (`origin` = default publish target) |
| `rig push [remote] [refspecs...]` | rig (paid) | the TOON push: Arweave upload + NIP-34 refs publish. Shadows `git push` — plain-git pushes stay available by running `git push` directly |
| `rig issue create` | rig (paid) | file an issue (kind:1621) |
| `rig comment <root-event-id>` | rig (paid) | comment (kind:1622) on an issue/patch |
| `rig pr create` | rig (paid) | publish a patch (kind:1617) from real `git format-patch` |
| `rig pr status <event-id> <state>` | rig (paid) | set issue/patch status (kind:1630–1633). **Was `rig status` before v2** |
| `rig help` / `rig --version` | rig | usage / version |
| everything else | **git** | executed as `git <args...>` with rig's stdio and git's exit code |

## `rig` quickstart

```sh
npm install -g @toon-protocol/rig

# 1. identity — a BIP-39 seed phrase, either in your environment…
export RIG_MNEMONIC="abandon abandon … about"
#    …or in a project-local .env (gitignore it!):
echo 'RIG_MNEMONIC="abandon abandon … about"' >> .env

# 2. one-shot repo setup (free): writes toon.repoid + toon.owner to the
#    repo's local git config and reports which identity source is active
rig init                     # default repo id = directory name
rig init --repo-id my-repo   # or pick one

# 3. add your relay as an origin (free) — a REAL git remote, so
#    `git remote -v` shows it and git tooling round-trips it
rig remote add origin wss://relay.example
rig remote list              # names + URLs; --json for machines
rig remote remove origin

# 4. work exactly like git — unowned commands pass through to system git:
rig status                   # IS `git status`
rig add -p && rig commit -m "fix"
rig log --oneline            # pagers, colors, prompts all behave like git
rig rebase -i HEAD~3         # interactive works (stdio is inherited)

# 5. push (paid) — defaults to the "origin" remote, exactly like git
rig push                     # plan + price the current branch, confirm, push
rig push main v1.0.0 --yes   # specific refs, skip the confirm prompt
rig push staging main        # push via another configured remote
rig push --all --tags --json # machine-readable plan/receipts (agents)

# issues, comments, patches, and statuses use the same rig init config:
rig issue create --title "Fix the flux" --body "It broke."   # kind:1621
echo "longer body" | rig issue create --title t --yes        # body via stdin
rig comment <root-event-id> --body "Nice catch."             # kind:1622
rig pr create --title "Add feature" --range main..feature    # kind:1617 with
                                                             # REAL format-patch text
rig pr status <event-id> applied                             # kind:1631
                                                             # (bare `rig status` is git's)
```

### Strict `--json` stdout (machine consumers)

With `--json`, stdout carries **exactly one JSON document** — everything human-facing (identity reports, deprecation nudges, migration hints, chain-selection rationales, discovery warnings, progress lines, even stray `console.log` output from dependencies) is routed to stderr, so `rig <command> --json | jq` always parses. Errors emit one machine envelope (`{"error": "<code>", "detail": …}`) on stdout with the human detail on stderr and a non-zero exit; runs that fail before producing output (usage errors, pre-payment refusals) still emit a backstop error envelope. `--json` is a per-subcommand flag on the commands rig owns, **not** a global rig flag — see the passthrough note below.

### Git passthrough

Any subcommand rig does not own is executed as `git <args...>` verbatim: the exact argv tail is handed to the system git with `stdio: 'inherit'` (interactive commands, pagers, colors, and prompts work), and git's exit code is rig's exit code (a child killed by a signal maps to the shell convention 128+N). rig-owned verbs always take precedence — in particular `rig push` is the TOON transport and shadows `git push`; plain-git pushes remain available by calling `git push` directly. If no system git is installed, passthrough fails with a clear error (exit 127).

The passthrough is exempt from the `--json` contract: `rig status --json` runs `git status --json` (git rejects the flag), and flags before the subcommand (`rig --json status`) are not rig's either — the whole argv passes through to git untouched.

### Identity

The CLI is **standalone-only**: it embeds its own payment client built from
your seed phrase (`@toon-protocol/client` is a regular dependency, installed
automatically with the package). The mnemonic is resolved along one
precedence chain — highest first:

1. `RIG_MNEMONIC` environment variable
2. `TOON_CLIENT_MNEMONIC` environment variable — deprecated alias, warns on
   stderr; rename it to `RIG_MNEMONIC`
3. project-local `.env` — found by walking up from the working directory
   (through the repo root); ONLY the `RIG_MNEMONIC` line is parsed out of it
   (rig never loads arbitrary env from the file, and never requires it).
   **Gitignore it** — the phrase must never be committed.
4. the shared `~/.toon-client` state dir (`TOON_CLIENT_HOME` override):
   encrypted keystore (`keystorePath` + `TOON_CLIENT_KEYSTORE_PASSWORD`),
   then the `mnemonic` config field

Every paid command reports which source is active and the derived pubkey
(`Identity: <pubkey> (from …)`, and an `identity` object in `--json`
output) — the phrase itself is never printed and never written to git config
or any repo file.

A running `toon-clientd` daemon on the **same identity** is still refused
(the nonce guard): two writers would race the payment channel's
cumulative-claim watermark. Stop the daemon or publish through its
`toon_git_*` MCP tools instead — the daemon's `/git/*` routes are the MCP
host path and are unaffected by the CLI.

### Pushing

`rig push [remote] [refspecs...]` uploads the object delta to Arweave (paid, content-addressed — a re-push never re-pays for known objects) and publishes the NIP-34 refs event (kind:30618; plus the kind:30617 announcement on first push). It renders the fee table (refs with classification, objects, bytes, itemized + total fee) and asks for confirmation before spending — writes are permanent and non-refundable. `--yes` skips the prompt (and is required when stdin is not a TTY); `--json` without `--yes` is a pure estimate (nothing executed). `--force` allows non-fast-forward updates; `--repo-id <id>` overrides the configured repo id.

Repo addressing (`30617:<owner>:<repoId>`) comes from the `toon.repoid`/`toon.owner` git config keys `rig init` writes — an unconfigured repo is a clear "run `rig init`" error, and pushing never mutates git config. Objects over 95KB are a hard error in v1 (large-object support: toon-client#235).

### Relays are origins

Relays are configured as **real git remotes** (`rig remote add` is `git remote add` underneath — `git remote -v` shows them, and remotes added with plain git work too, as long as the URL is `ws://`/`wss://`/`http://`/`https://`):

- `rig remote add origin <relay-url>` / `rig remote remove <name>` / `rig remote list` (`--json` supported). Junk URLs are rejected at add time; an existing name is refused with a `git remote set-url` hint.
- `rig push` publishes via `origin`; `rig push <remote> [refspecs...]` via a named remote. Git-like resolution: when the first positional matches a configured remote name it is the remote, otherwise it is a refspec and the remote defaults to `origin`. No usable remote → a clear ``no origin configured — run `rig remote add origin <relay-url>` `` error.
- The event commands take `--remote <name>` (default `origin`).
- `--relay <url>` stays as an **ad-hoc override** on every paid command: it bypasses the configured remotes entirely (for push, every positional is then a refspec).
- One relay URL per remote: a remote with multiple URLs (`git remote set-url --add`) is refused **before anything is uploaded, published, or paid** — rig publishes to exactly one relay per paid command.
- Migration from v0.1: a configured `git config toon.relay` still works as a fallback when no relay `origin` exists (paid commands print a one-line deprecation nudge), and `rig init` migrates it to a real `origin` remote automatically. The `toon.relay` key is removed in v0.3.

The single-event subcommands follow the same paid-write discipline as push — the per-event fee is quoted and confirmed before publishing; `--yes` skips, `--json` without `--yes` is a free estimate:

- `rig issue create --title <t> [--body <b> | --body-file <f> | stdin] [--label <l>]…` — kind:1621.
- `rig comment <root-event-id> --body <b> [--parent-author <pubkey>] [--marker root|reply]` — kind:1622.
- `rig pr create --title <t> (--range <A..B> | --patch-file <f>) [--branch <name>]` — kind:1617; `--range` runs real `git format-patch --stdout` locally and derives the `commit`/`parent-commit` tags. A multi-commit range publishes ONE event carrying the whole series (cover-letter threading is out of scope in v1).
- `rig pr status <target-event-id> <open|applied|closed|draft>` — kind:1630–1633, with the repo `a` tag attached. (This was top-level `rig status` before v2; bare `rig status` now passes through to `git status`.)

`--repo-id`/`--owner` override the git config address (use `--owner` for repos you don't own).

## Library

No signing or payment code lives in the core — that stays behind the `Publisher` seam:

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`, `createGitTree`, `createGitCommit`, `createGitTag` (annotated tags), the `GitObject`/`GitObjectType` types, `hashGitObject`, and the `MAX_OBJECT_SIZE` (95KB) upload guard constant.
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent` (caller signs and publishes): `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618, incl. `arweave` sha→txId tags), `buildIssue` (1621), `buildComment` (1622), `buildPatch` (1617, optional real `git format-patch` content), `buildStatus` (1630–1633).
- `repo-reader.ts` — `GitRepoReader`, read-only local-repo access via injection-safe `execFile` git plumbing: `listRefs`, `objectsBetween`(+`WithPaths`), `readObjects`, `statObjects`, `isAncestor`, `formatPatch`, `resolveRef`.
- `remote-state.ts` — `fetchRemoteState`, the "what does the remote have?" reader: kind:30617/30618 relay fetch (NIP-33 latest-wins across a plural relay list) + `resolveMissing` Arweave GraphQL Git-SHA fallback.
- `publisher.ts` — the `Publisher` interface (paid transport seam): `getFeeRates`, `uploadGitObject`, `publishEvent`. Implemented by the daemon (#227) and the standalone embedded client (#228).
- `push.ts` — `planPush` (ref classification, object delta minus known sha→txId hints, oversize hard error, fee estimate) and `executePush` (uploads ref tips last, then ONE cumulative kind:30618 merging the full arweave map, kind:30617 first on first push; crash-resume safe via content-addressed skip).
- `routes.ts` — the JSON wire shapes of the daemon's `/git/*` control routes (bigints as decimal strings, Maps as records) + the matching `serializePushPlan`/`serializePushResult` helpers, shared with `@toon-protocol/client-mcp` (the daemon keeps these routes; only the CLI stopped using them).
- `cli/` — the `rig` bin: `init` (#248), `remote` (#249, relays as real git remotes + the shared relay resolution), `push` (#229), the single-event `issue`/`comment`/`pr create`/`pr status` subcommands (#231, nested under `pr` since #250), and the git passthrough (#250, `dispatch.ts` + `git-passthrough.ts`), all standalone-only with the `identity.ts` resolution chain.

Pure builders promoted from the proven Rig E2E seed pipeline (`packages/rig-web/tests/e2e/seed/lib`). Part of [epic #222](https://github.com/toon-protocol/toon-client/issues/222) and [epic #246](https://github.com/toon-protocol/toon-client/issues/246).
