# @toon-protocol/rig

Git-to-TOON write path core — build git objects and NIP-34 events for the Rig control plane. Ships the **`rig`** CLI: a 1:1 git experience with a TOON remote. rig owns a handful of TOON verbs (table below); **every other command is passed through to system `git` verbatim** — `rig status` runs `git status`, `rig add -p`, `rig commit`, `rig rebase -i`, … all behave exactly like git (same output, same prompts, same exit code).

| command | owner | what it does |
| --- | --- | --- |
| `rig init` | rig (free) | one-shot repo setup: identity + `toon.*` git config |
| `rig remote add/remove/list` | rig (free) | relays as REAL git remotes (`origin` = default publish target) |
| `rig clone <relay-url> <owner>/<repo-id> [dir]` | rig (free) | bootstrap a repo from TOON: relay state + SHA-verified Arweave objects → a real, push-capable git repository. Shadows `git clone` |
| `rig fetch [remote]` | rig (free) | download the missing object delta + update `refs/remotes/<remote>/*` (no merge — `rig merge origin/main`). Shadows `git fetch` |
| `rig push [remote] [refspecs...]` | rig (paid) | the TOON push: Arweave upload + NIP-34 refs publish. Shadows `git push` — plain-git pushes stay available by running `git push` directly |
| `rig issue list` / `rig issue show <id>` | rig (free) | the repo's issues + comments from the terminal (state derived from kind:1630-1633, latest wins) |
| `rig pr list` / `rig pr show <id>` | rig (free) | the repo's patches/PRs; `show` prints the full patch text (pipe it to `git am`) |
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

### The second contributor (reads are FREE)

Someone published a repo on TOON? You can pick it up with **nothing
configured** — no identity, no wallet, no channel. Reads are free:

```sh
npm install -g @toon-protocol/rig

# 1. clone — relay state + SHA-verified Arweave objects → a real git repo
#    (owner as npub1… or 64-char hex; dir defaults to the repo id)
rig clone wss://relay.example npub1…/their-repo
cd their-repo                # toon.* config + origin remote already set

# 2. read the tracker from the terminal
rig issue list               # issues + derived state (latest status wins)
rig issue show <event-id>    # one issue + its comments
rig pr list --state open     # patches/PRs
rig pr show <event-id> --json | jq -r .pr.content | git am   # apply a patch

# 3. stay current — fetch downloads only the missing delta
rig fetch                    # updates refs/remotes/origin/*, like git fetch
rig merge origin/main        # integrating is plain git (passthrough)

# 4. ready to contribute back? writes are paid — add an identity + funds:
export RIG_MNEMONIC="abandon abandon … about"
export TOON_CLIENT_NETWORK=devnet   # shared devnet: enables `rig fund` (no faucet URL needed)
rig fund                     # devnet faucet drip
rig issue create --title "found a bug" --body "details"      # kind:1621
rig push                     # or publish commits (your own repos)
```

Note: freshly pushed objects can take **10-20 minutes** to become fetchable
from Arweave gateways — `rig clone`/`rig fetch` right after a push reports
the missing SHAs honestly; retry after propagation. A failed clone never
leaves a partial repository behind.

### Strict `--json` stdout (machine consumers)

With `--json`, stdout carries **exactly one JSON document** — everything human-facing (identity reports, deprecation nudges, migration hints, chain-selection rationales, discovery warnings, progress lines, even stray `console.log` output from dependencies) is routed to stderr, so `rig <command> --json | jq` always parses. Errors emit one machine envelope (`{"error": "<code>", "detail": …}`) on stdout with the human detail on stderr and a non-zero exit; runs that fail before producing output (usage errors, pre-payment refusals) still emit a backstop error envelope. `--json` is a per-subcommand flag on the commands rig owns, **not** a global rig flag — see the passthrough note below.

### Git passthrough

Any subcommand rig does not own is executed as `git <args...>` verbatim: the exact argv tail is handed to the system git with `stdio: 'inherit'` (interactive commands, pagers, colors, and prompts work), and git's exit code is rig's exit code (a child killed by a signal maps to the shell convention 128+N). rig-owned verbs always take precedence — in particular `rig push` is the TOON transport and shadows `git push`; plain-git pushes remain available by calling `git push` directly. If no system git is installed, passthrough fails with a clear error (exit 127).

The passthrough is exempt from the `--json` contract: `rig status --json` runs `git status --json` (git rejects the flag), and flags before the subcommand (`rig --json status`) are not rig's either — the whole argv passes through to git untouched.

### Identity

The CLI is **standalone by default**: it embeds its own payment client built
from your seed phrase (`@toon-protocol/client` is a regular dependency,
installed automatically with the package) — no daemon is ever required. The
mnemonic is resolved along one precedence chain — highest first:

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

### Daemon as accelerator (#279)

Every standalone paid command pays a fixed bootstrap cost (relay discovery,
peer negotiation, channel resume). Two things remove most of it:

- **Automatic daemon delegation** — when a running `toon-clientd` on the
  loopback control port (`TOON_CLIENT_HTTP_PORT`, default 8787) holds the
  **same identity**, paid write commands (`push`, `issue`, `comment`,
  `pr create`, `pr status`) delegate to its `/git/*` routes instead of
  bootstrapping an embedded client. The daemon already owns the payment
  channel's cumulative-claim watermark, so one process signs all claims —
  the exact safety property the pre-#279 nonce-guard *refusal* protected,
  achieved by delegation instead. The identity match is confirmed against
  `GET /status` **before** anything is sent. A daemon on a different
  identity, or no daemon at all, runs standalone as always. The chosen path
  prints on stderr (`rig: paid path: …`) and lands in `--json` envelopes as
  `"path": "daemon" | "standalone"`. Note: the single-event daemon routes
  publish via the daemon's configured relay route; a resolved relay that
  differs from it draws a warning. Commands the daemon has **no route
  for** — `rig fund`, `rig balance`, `rig channel open|close|settle` — always
  run standalone; the on-chain channel mutations among them still refuse
  while a same-identity daemon runs (they must not race its live claims):
  stop the daemon for those.
- **Standalone topology cache** — the resolved network topology (announce
  discovery, payment-peer pick, settlement-chain selection incl. the
  funded-chain probes) is cached under `TOON_CLIENT_HOME`
  (`rig-topology-cache.json`), keyed by relay + identity + explicit config,
  for 15 minutes (`RIG_TOPOLOGY_TTL_MS` overrides; `0` disables). A cached
  topology that fails to bootstrap is invalidated and re-resolved live
  automatically. Money state (claim watermarks, channel map) is never
  cached.

The `rig` bin also exits as soon as a command finishes and stdio is flushed:
the embedded client can leave a keep-alive socket that would otherwise hold
the process open for ~30 more seconds — which was, in fact, the bulk of the
uniform "~32s per paid command" the #279 study measured.

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
- `rig pr create --title <t> (--range <A..B> | --patch-file <f>) [--body <b> | --body-file <f>] [--branch <name>]` — kind:1617; `--range` runs real `git format-patch --stdout` locally and derives the `commit`/`parent-commit` tags. A multi-commit range publishes ONE event carrying the whole series (cover-letter threading is out of scope in v1). `--body`/`--body-file` attach the PR description in a dedicated `description` tag — the event content stays pure format-patch output, so `rig pr show`'s patch text still pipes straight into `git am`.
- `rig pr status <target-event-id> <open|applied|closed|draft>` — kind:1630–1633, with the repo `a` tag attached. (This was top-level `rig status` before v2; bare `rig status` now passes through to `git status`.)

`--repo-id`/`--owner` override the git config address (use `--owner` for repos you don't own).

### Cloning & fetching (free reads, #278)

`rig clone <relay-url> <owner>/<repo-id> [dir]` reconstructs the repository from public data alone: the kind:30618 `arweave` sha→txId map drives parallel downloads across the gateway fallback chain (SHAs the map misses resolve via the Arweave GraphQL `Git-SHA` tag index), **every body is verified against its SHA-1 before it is written** (verification doubles as object-type discovery; corrupt/tampered content is rejected), and the repository is materialized through git's own plumbing — `git hash-object -w --stdin -t <type>` (written SHA re-checked), `git update-ref`, HEAD from the 30618 symref, checked-out worktree. Everything happens in a temp dir moved into place on success, so a failed clone never leaves a partial repo. `rig fetch [remote]` is the same pipeline as a delta: only locally-missing objects are downloaded, and `refs/remotes/<remote>/*` (tags → `refs/tags/*`) move with a `git fetch`-style report.

`rig issue list|show` and `rig pr list|show` are pure relay reads (kind:1621/1617 by the repo `#a` tag; state from kind:1630-1633, latest wins; kind:1622 comments under `show`), tolerant of the devnet relay's non-canonical EVENT payload encodings.

## Library

No signing or payment code lives in the core — that stays behind the `Publisher` seam:

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`, `createGitTree`, `createGitCommit`, `createGitTag` (annotated tags), the `GitObject`/`GitObjectType` types, `hashGitObject`, and the `MAX_OBJECT_SIZE` (95KB) upload guard constant.
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent` (caller signs and publishes): `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618, incl. `arweave` sha→txId tags), `buildIssue` (1621), `buildComment` (1622), `buildPatch` (1617, optional real `git format-patch` content), `buildStatus` (1630–1633).
- `repo-reader.ts` — `GitRepoReader`, read-only local-repo access via injection-safe `execFile` git plumbing: `listRefs`, `objectsBetween`(+`WithPaths`), `readObjects`, `statObjects`, `isAncestor`, `formatPatch`, `resolveRef`.
- `remote-state.ts` — `fetchRemoteState`, the "what does the remote have?" reader: kind:30617/30618 relay fetch (NIP-33 latest-wins across a plural relay list) + `resolveMissing` Arweave GraphQL Git-SHA fallback; `queryRelay` (tolerant NIP-01 REQ→EOSE) is exported for other readers.
- `object-fetch.ts` / `read-pipeline.ts` / `materialize.ts` (#278) — the read path: `fetchTxBytes`/`downloadGitObjects` (gateway fallback + concurrency cap + SHA-1 verification-as-type-discovery, `ObjectIntegrityError` on mismatch), `referencedShas`/`walkClosure` (object-graph closure, gitlink-aware), `collectRepoObjects` (the clone/fetch collection engine separating fatal gaps from unreachable ones), and `writeGitObject(s)`/`updateRef`/`setHeadSymref` (git plumbing writers with hostile-refname gating).
- `npub.ts` — dependency-free bech32 `npubToHex`/`hexToNpub`/`ownerToHex` (NIP-19 pubkey addressing for `rig clone`).
- `publisher.ts` — the `Publisher` interface (paid transport seam): `getFeeRates`, `uploadGitObject`, `publishEvent`. Implemented by the daemon (#227) and the standalone embedded client (#228).
- `push.ts` — `planPush` (ref classification, object delta minus known sha→txId hints, oversize hard error, fee estimate) and `executePush` (uploads ref tips last, then ONE cumulative kind:30618 merging the full arweave map, kind:30617 first on first push; crash-resume safe via content-addressed skip).
- `routes.ts` — the JSON wire shapes of the daemon's `/git/*` control routes (bigints as decimal strings, Maps as records) + the matching `serializePushPlan`/`serializePushResult` helpers, shared with `@toon-protocol/client-mcp` and consumed by the CLI's #279 delegated fast path (`cli/daemon-session.ts`).
- `cli/` — the `rig` bin: `init` (#248), `remote` (#249, relays as real git remotes + the shared relay resolution), `push` (#229), the single-event `issue`/`comment`/`pr create`/`pr status` subcommands (#231, nested under `pr` since #250), the git passthrough (#250, `dispatch.ts` + `git-passthrough.ts`), and the #279 daemon-as-accelerator delegation (`daemon-session.ts`), standalone by default with the `identity.ts` resolution chain.

Pure builders promoted from the proven Rig E2E seed pipeline (`packages/rig-web/tests/e2e/seed/lib`). Part of [epic #222](https://github.com/toon-protocol/toon-client/issues/222) and [epic #246](https://github.com/toon-protocol/toon-client/issues/246).
