# @toon-protocol/rig

Git-to-TOON write path core — build git objects and NIP-34 events for the Rig control plane. Ships the **`rig`** CLI.

## `rig` quickstart

```sh
npm install -g @toon-protocol/rig @toon-protocol/client

# 1. identity — a BIP-39 seed phrase, either in your environment…
export RIG_MNEMONIC="abandon abandon … about"
#    …or in a project-local .env (gitignore it!):
echo 'RIG_MNEMONIC="abandon abandon … about"' >> .env

# 2. one-shot repo setup (free): writes toon.repoid + toon.owner to the
#    repo's local git config and reports which identity source is active
rig init                     # default repo id = directory name
rig init --repo-id my-repo   # or pick one

# 3. push (paid)
rig push                     # plan + price the current branch, confirm, push
rig push main v1.0.0 --yes   # specific refs, skip the confirm prompt
rig push --all --tags --json # machine-readable plan/receipts (agents)

# issues, comments, patches, and statuses use the same rig init config:
rig issue create --title "Fix the flux" --body "It broke."   # kind:1621
echo "longer body" | rig issue create --title t --yes        # body via stdin
rig comment <root-event-id> --body "Nice catch."             # kind:1622
rig pr create --title "Add feature" --range main..feature    # kind:1617 with
                                                             # REAL format-patch text
rig status <event-id> applied                                # kind:1631
```

### Identity

The CLI is **standalone-only**: it embeds its own payment client built from
your seed phrase (install the optional `@toon-protocol/client` peer to use
it). The mnemonic is resolved along one precedence chain — highest first:

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

`rig push` uploads the object delta to Arweave (paid, content-addressed — a re-push never re-pays for known objects) and publishes the NIP-34 refs event (kind:30618; plus the kind:30617 announcement on first push). It renders the fee table (refs with classification, objects, bytes, itemized + total fee) and asks for confirmation before spending — writes are permanent and non-refundable. `--yes` skips the prompt (and is required when stdin is not a TTY); `--json` without `--yes` is a pure estimate (nothing executed). `--force` allows non-fast-forward updates; `--relay <url>` (exactly one) and `--repo-id <id>` override the defaults.

Repo addressing (`30617:<owner>:<repoId>`) comes from the `toon.repoid`/`toon.owner` git config keys `rig init` writes — an unconfigured repo is a clear "run `rig init`" error, and pushing never mutates git config. Relays come from `--relay`, then `git config toon.relay`, then the network default (`rig remote add origin <relay-url>` arrives in toon-client#249). Objects over 95KB are a hard error in v1 (large-object support: toon-client#235).

The single-event subcommands follow the same paid-write discipline as push — the per-event fee is quoted and confirmed before publishing; `--yes` skips, `--json` without `--yes` is a free estimate:

- `rig issue create --title <t> [--body <b> | --body-file <f> | stdin] [--label <l>]…` — kind:1621.
- `rig comment <root-event-id> --body <b> [--parent-author <pubkey>] [--marker root|reply]` — kind:1622.
- `rig pr create --title <t> (--range <A..B> | --patch-file <f>) [--branch <name>]` — kind:1617; `--range` runs real `git format-patch --stdout` locally and derives the `commit`/`parent-commit` tags. A multi-commit range publishes ONE event carrying the whole series (cover-letter threading is out of scope in v1).
- `rig status <target-event-id> <open|applied|closed|draft>` — kind:1630–1633, with the repo `a` tag attached.

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
- `cli/` — the `rig` bin: `init` (#248), `push` (#229), and the single-event `issue`/`comment`/`pr`/`status` subcommands (#231), all standalone-only with the `identity.ts` resolution chain.

Pure builders promoted from the proven Rig E2E seed pipeline (`packages/rig-web/tests/e2e/seed/lib`). Part of [epic #222](https://github.com/toon-protocol/toon-client/issues/222) and [epic #246](https://github.com/toon-protocol/toon-client/issues/246).
