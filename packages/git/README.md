# @toon-protocol/git

Git-to-TOON write path core — build git objects and NIP-34 events for the Rig control plane. Ships the **`rig`** CLI.

## `rig` quickstart

```sh
# inside any git repository
rig push                     # plan + price the current branch, confirm, push
rig push main v1.0.0 --yes   # specific refs, skip the confirm prompt
rig push --all --tags --json # machine-readable plan/receipts (agents)

# after the first push, the repo address (30617:<owner>:<repoId>) lives in
# git config — issues, comments, patches, and statuses work with no flags:
rig issue create --title "Fix the flux" --body "It broke."   # kind:1621
echo "longer body" | rig issue create --title t --yes        # body via stdin
rig comment <root-event-id> --body "Nice catch."             # kind:1622
rig pr create --title "Add feature" --range main..feature    # kind:1617 with
                                                             # REAL format-patch text
rig status <event-id> applied                                # kind:1631
```

`rig push` uploads the object delta to Arweave (paid, content-addressed — a re-push never re-pays for known objects) and publishes the NIP-34 refs event (kind:30618; plus the kind:30617 announcement on first push). It renders the fee table (refs with classification, objects, bytes, itemized + total fee) and asks for confirmation before spending — writes are permanent and non-refundable. `--yes` skips the prompt (and is required when stdin is not a TTY); `--json` without `--yes` is a pure estimate (nothing executed). `--force` allows non-fast-forward updates; `--relay <url>` (repeatable) and `--repo-id <id>` override the defaults.

Two ways to pay, picked automatically (`--daemon` / `--standalone` force one):

- **daemon** — a running `toon-clientd` (from `@toon-protocol/client-mcp`) on loopback; its identity is the repo owner. Selected when `GET /status` answers with an identity.
- **standalone** — an embedded client built from your own `TOON_CLIENT_MNEMONIC` (or `~/.toon-client/config.json`), guarded against racing a daemon on the same identity (cumulative-claim watermark protection).

After the first successful push, `rig` persists `toon.repoid`, `toon.owner`, and `toon.relay` into the repo's git config — the `a`-tag addressing (`30617:<owner>:<repoId>`) the single-event subcommands read (`--repo-id`/`--owner` override it; use `--owner` for repos you don't own). Objects over 95KB are a hard error in v1 (large-object support: toon-client#235).

The single-event subcommands follow the same paid-write discipline as push — the per-event fee is quoted (daemon `/status` `feePerEvent`, or the standalone fee rates) and confirmed before publishing; `--yes` skips, `--json` without `--yes` is a free estimate:

- `rig issue create --title <t> [--body <b> | --body-file <f> | stdin] [--label <l>]…` — kind:1621 via `POST /git/issue` (or standalone).
- `rig comment <root-event-id> --body <b> [--parent-author <pubkey>] [--marker root|reply]` — kind:1622 via `POST /git/comment`.
- `rig pr create --title <t> (--range <A..B> | --patch-file <f>) [--branch <name>]` — kind:1617 via `POST /git/patch`; `--range` runs real `git format-patch --stdout` locally and derives the `commit`/`parent-commit` tags. A multi-commit range publishes ONE event carrying the whole series (cover-letter threading is out of scope in v1).
- `rig status <target-event-id> <open|applied|closed|draft>` — kind:1630–1633 via `POST /git/status`, with the repo `a` tag attached.

## Library

No signing or payment code lives in the core — that stays behind the `Publisher` seam:

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`, `createGitTree`, `createGitCommit`, `createGitTag` (annotated tags), the `GitObject`/`GitObjectType` types, `hashGitObject`, and the `MAX_OBJECT_SIZE` (95KB) upload guard constant.
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent` (caller signs and publishes): `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618, incl. `arweave` sha→txId tags), `buildIssue` (1621), `buildComment` (1622), `buildPatch` (1617, optional real `git format-patch` content), `buildStatus` (1630–1633).
- `repo-reader.ts` — `GitRepoReader`, read-only local-repo access via injection-safe `execFile` git plumbing: `listRefs`, `objectsBetween`(+`WithPaths`), `readObjects`, `statObjects`, `isAncestor`, `formatPatch`, `resolveRef`.
- `remote-state.ts` — `fetchRemoteState`, the "what does the remote have?" reader: kind:30617/30618 relay fetch (NIP-33 latest-wins across a plural relay list) + `resolveMissing` Arweave GraphQL Git-SHA fallback.
- `publisher.ts` — the `Publisher` interface (paid transport seam): `getFeeRates`, `uploadGitObject`, `publishEvent`. Implemented by the daemon (#227) and the standalone embedded client (#228).
- `push.ts` — `planPush` (ref classification, object delta minus known sha→txId hints, oversize hard error, fee estimate) and `executePush` (uploads ref tips last, then ONE cumulative kind:30618 merging the full arweave map, kind:30617 first on first push; crash-resume safe via content-addressed skip).
- `routes.ts` — the JSON wire shapes of the daemon's `/git/*` control routes (bigints as decimal strings, Maps as records) + the matching `serializePushPlan`/`serializePushResult` helpers, shared by the CLI and adoptable by `@toon-protocol/client-mcp`.
- `cli/` — the `rig` bin: `push` (#229) and the single-event `issue`/`comment`/`pr`/`status` subcommands (#231).

Pure builders promoted from the proven Rig E2E seed pipeline (`packages/rig/tests/e2e/seed/lib`). Part of [epic #222](https://github.com/toon-protocol/toon-client/issues/222).
