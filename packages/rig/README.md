# @toon-protocol/rig

**Git, with a TOON remote.** `rig` is a drop-in `git` wrapper that publishes your
repository to the TOON network — a decentralized control plane where repo state
lives in NIP-34 Nostr events and the objects live on Arweave.

- **Reads are free** — clone, fetch, and browse issues/PRs need no identity, no
  wallet, nothing configured.
- **Writes are paid** — pushing objects and publishing events spends from a
  payment channel funded by your wallet. Writes are permanent and non-refundable.
- **Standalone by default** — `rig` embeds its own payment client built from your
  seed phrase. No daemon is required (though a running `toon-clientd` makes paid
  commands faster — see [Daemon as accelerator](#daemon-as-accelerator)).

`rig` owns a handful of TOON verbs (`init`, `remote`, `clone`, `fetch`, `push`,
`issue`, `pr`, `comment`, `identity`, `fund`, `balance`, `channel`). **Every other
command passes through to system `git` verbatim** — `rig status`, `rig add -p`,
`rig commit`, `rig rebase -i` all behave exactly like git.

---

## Install

```sh
npm install -g @toon-protocol/rig
rig --version
```

Requires Node.js and a system `git` on your `PATH` (rig shells out to it for all
passthrough commands and object plumbing).

---

## From your code to a published repo

This is the full happy path: an idea on your disk → a repository anyone can clone
from TOON. It uses the shared **devnet** (free faucet money) so you can complete
it end to end without spending anything real.

### 1. Start with your code

Already have a git repo? `cd` into it. Starting fresh? An empty directory is fine —
`rig init` will offer to `git init` for you in the next step.

```sh
mkdir hello-toon && cd hello-toon
echo "# hello-toon" > README.md
```

### 2. Create an identity

Your identity is a BIP-39 seed phrase; its derived Nostr pubkey is who *owns* the
repo, and its wallet is what *pays* for writes. Mint one on the spot — the phrase is
shown **once**, so write it down. It's stored in an encrypted keystore under
`~/.toon-client`.

```sh
rig identity create
rig identity show        # your active pubkey + npub (never the phrase)
```

Already have a phrase? Bring it instead: `export RIG_MNEMONIC="abandon abandon … about"`
(or `rig identity import`, which reads the phrase from stdin). See
[Identity](#identity) for the full resolution order.

### 3. Set up the repo

One free command wires everything together: it writes `toon.repoid` / `toon.owner`
into the repo's **local** git config, and sets the repo-local git commit author to
your Nostr identity so `rig commit` works out of the box.

```sh
rig init                      # repo id defaults to the directory name
# rig init --repo-id hello-toon        # …or name it explicitly
# rig init --git-init --generate-identity   # fully non-interactive fresh setup
```

Not a git repo yet? `rig init` offers to `git init` (or pass `--git-init`). No
identity yet? It offers to generate one (or pass `--generate-identity`).

### 4. Point at a relay

Relays are configured as **real git remotes**. Add the shared devnet relay as
`origin` — this is your default publish target, and it also tells `rig fund` (next
step) which faucet to use.

```sh
rig remote add origin wss://relay-ws.devnet.toonprotocol.dev
rig remote list
```

### 5. Fund your wallet

Pushing is paid, so your wallet needs a balance. On devnet, `rig fund` drips test
funds (native coin **and** USDC) to every supported chain — it's free and needs no
faucet URL because it infers devnet from your `origin` remote.

```sh
rig fund                 # devnet faucet drip (Mina can take ~75s)
rig balance              # confirm the funds landed
```

Prefer a browser? The same faucet has a web UI at
**<https://faucet.devnet.toonprotocol.dev>** — pick a chain, paste an address,
get USDC. (See [Devnet reference](#devnet-reference-public-chains) for the API
routes and every deployed contract address.)

> On any non-devnet network there is no faucet: `rig fund` prints your wallet
> address(es) so you can fund them externally, then `rig push` draws from there.

### 6. Commit your work

This is just git — unowned commands pass straight through, and step 3 already set
your commit author.

```sh
rig add -A
rig commit -m "initial commit"
```

### 7. Push — the paid publish

`rig push` uploads your objects to Arweave and publishes the NIP-34 refs event
(plus the repo announcement on the first push). It prints a **fee table** — refs,
object count, bytes, itemized and total fee — and asks you to confirm before
spending. On this first paid write it **opens a payment channel from your funded
wallet automatically** (recorded and reused on later pushes; no manual
`rig channel open` needed).

```sh
rig push                 # plan + price the current branch, confirm, then publish
# rig push main --yes    # a specific ref, skipping the confirm prompt
```

That's it — your repository is live on TOON. 🎉

### 8. Verify it's live

Clone it back from a clean directory (a free read) to prove the round-trip. Use
your own pubkey as the owner — `rig identity show` prints it as an `npub1…`.

```sh
cd /tmp
rig clone wss://relay-ws.devnet.toonprotocol.dev npub1youriden…/hello-toon
cd hello-toon && rig log --oneline
```

You can also browse the repo (code, commits, issues, PRs) in the **Rig web UI**,
which reads the same relay + Arweave data your CLI just wrote.

> **Propagation note:** freshly pushed objects can take **10–20 minutes** to become
> fetchable from Arweave gateways. A `rig clone` / `rig fetch` right after a push
> reports any not-yet-propagated SHAs honestly — just retry after a few minutes. A
> failed clone never leaves a partial repo behind.

### Keep working

Iterate exactly like git; re-pushing only pays for **new** objects (uploads are
content-addressed, so known objects are skipped for free).

```sh
rig add -p && rig commit -m "add a feature"
rig push
```

### Collaborate

Issues, comments, and patches are paid writes against the same repo config; reading
them is free.

```sh
# reads (free)
rig issue list
rig pr list --state open
rig pr show <event-id> --json | jq -r .pr.content | git am   # apply a patch locally

# writes (paid)
rig issue create --title "Fix the flux" --body "It broke."
rig comment <root-event-id> --body "Nice catch."
rig pr create --title "Add feature" --range main..feature
rig pr status <event-id> applied
```

---

## Command reference

| command | cost | what it does |
| --- | --- | --- |
| `rig identity create` | free | mint a fresh BIP-39 identity into the encrypted keystore — the phrase is shown ONCE |
| `rig identity show` | free | the active identity's source + derived pubkey (never the phrase) |
| `rig identity import` | free | write an existing phrase (read from stdin, never argv) to the keystore |
| `rig init` | free | one-shot repo setup: git repo + identity + `toon.*` config + repo-local git commit-author from your Nostr identity |
| `rig remote add/remove/list` | free | relays as REAL git remotes (`origin` = default publish target) |
| `rig fund [--chain <c>]` | free | devnet faucet drip (native + USDC) to the active identity's wallet; prints addresses to fund externally off-devnet |
| `rig balance` | free | the active wallet's multi-chain balances |
| `rig clone <relay-url> <owner>/<repo-id> [dir]` | free | bootstrap a repo from TOON: relay state + SHA-verified Arweave objects → a real git repo. Shadows `git clone` |
| `rig fetch [remote]` | free | download the missing object delta + update `refs/remotes/<remote>/*`. Shadows `git fetch` |
| `rig push [remote] [refspecs...]` | **paid** | the TOON push: Arweave upload + NIP-34 refs publish. Shadows `git push` |
| `rig issue list` / `rig issue show <id>` | free | the repo's issues + comments from the terminal |
| `rig pr list` / `rig pr show <id>` | free | the repo's patches/PRs; `show` prints the full patch text (pipe to `git am`) |
| `rig issue create` | **paid** | file an issue (kind:1621) |
| `rig comment <root-event-id>` | **paid** | comment (kind:1622) on an issue/patch |
| `rig pr create` | **paid** | publish a patch (kind:1617) from real `git format-patch` |
| `rig pr status <event-id> <state>` | **paid** | set issue/patch status (kind:1630–1633) |
| `rig site publish [ref]` | **paid** | deploy a pushed repo as a permaweb site: build the ar.io path manifest (repo paths → Arweave txids) and upload it as one paid store write; prints the gateway URL |
| `rig site url [ref]` | free | print the last-published site URL for a ref |
| `rig name status <name>` | free | an ArNS name's registry record, ANT process, and current target txId |
| `rig name buy <name>` / `rig name set <name> <txId>` | **paid¹** | buy an ArNS name / point it at an Arweave txId. ¹Paid in mARIO on Solana via the ar.io registry — **not** ILP; needs the optional `@ar.io/sdk` dep |
| `rig channel list/open/close/settle` | free / **paid** | inspect or manage the payment channels paid commands hold |
| `rig help` / `rig --version` | free | usage / version |
| everything else | — | executed as `git <args...>` with rig's stdio and git's exit code |

Every paid command supports `--yes` (skip the confirm prompt; **required** when
stdin is not a TTY) and `--json` (a `--json` run *without* `--yes` is a free
estimate — nothing is executed or paid).

---

## Money: fund, balance, channels

Paid commands spend from a **payment channel** — an on-chain-collateralized channel
between your wallet and a payment peer, from which each write draws an off-chain
claim. You rarely touch this directly:

- **`rig fund`** tops up your wallet (devnet faucet, or prints addresses to fund
  externally). Both the native coin (gas) and USDC (collateral) are needed.
- **`rig balance`** shows what your wallet holds across chains.
- **Channels open lazily.** The first paid write opens a channel from your funded
  wallet and records it under `~/.toon-client` (`rig-channels.json`); later writes
  resume the same channel instead of opening a new one.
- **`rig channel list`** (free) shows current holdings and nonce watermarks.
  **`rig channel open`** pre-opens one (or `--deposit`s more collateral) using the
  exact lazy-open path; **`rig channel close`** starts the settlement challenge
  window; **`rig channel settle`** releases collateral once the window elapses.

The `open`/`close`/`settle` lifecycle commands are on-chain wallet operations (gas +
collateral movement), so they follow the same confirm idiom as `push`: they print
what will happen, then require `--yes` or an interactive confirm.

---

## Permaweb sites & ArNS names (Arweave)

Every `rig push` already stores your repo's file bytes on Arweave. Two more verbs
turn a pushed repo into a permanent, human-named website — *GitHub Pages, but
permanent and named.*

### `rig site` — a pushed repo as a website

`rig site publish [ref]` builds an
[ar.io path manifest](https://specs.ar.io/#/en/manifests/1.0.0) (`index.html`
routing) from the ref's tree joined with the objects already on Arweave, uploads it
as **one paid store write**, and prints a servable URL:

```sh
rig site publish                      # publish the current branch as a site
# rig site publish main --spa         # SPA routing: serve index.html for unknown paths
# rig site publish --force-reupload   # re-pay to re-upload blobs stored without a Content-Type
rig site url                          # (free) print the last-published site URL for a ref
```

```
https://<gateway>/<manifestTxId>/
```

`rig push` now tags each uploaded blob with a `Content-Type` derived from its path,
so files render in a browser instead of downloading as `application/octet-stream`.
Blobs pushed **before** this change serve as octet-stream until re-uploaded with
`--force-reupload` (a fresh paid write). Site assets are bounded by rig's per-object
size cap — fine for typical static sites.

The manifest txId **changes on every push**, so the stable pointer is an ArNS name.

### `rig name` — a human name for a txId (ArNS)

[ArNS](https://ar.io) (the ar.io Name System) is Arweave's naming layer: a registered
name resolves at every ar.io gateway as `https://<name>.<gateway>/`, serving whatever
txId its record points at. Names are owned and paid by **this identity's own Solana
key** — derived from the same mnemonic as everything else, so no new key material:

```sh
rig name status <name>                # (free) registry record, ANT process, current target
rig name buy <name> --years 1         # buy a name (estimate → confirm → execute)
rig name set <name> <manifestTxId>    # point the name at your published site's manifest
```

Put together — one mnemonic, end to end:

```sh
rig push && rig site publish && rig name set my-app <manifestTxId>
# → https://my-app.<gateway>/
```

> **Real funds, a different rail from ILP.** `rig name buy`/`set` spend **mARIO on
> Solana via the ar.io registry program** — *not* through TOON's ILP payment channels
> (the rail behind `rig push` / `rig site publish` fees). `rig name` needs the
> optional [`@ar.io/sdk`](https://docs.ar.io) dependency (>= 4.0.3, the
> Solana-native release); install it if the command reports it missing.
> `rig name status` is a free, signerless read. As with every paid verb, these are estimate → confirm →
> execute, and a `--json` run *without* `--yes` is a free estimate — nothing is spent.

#### Network program ids (`--network` / `RIG_ARIO_NETWORK`)

`--network` selects which cluster's **ar.io registry programs** every `rig name`
verb targets. The ids come from the installed `@ar.io/sdk` (>= 4.0.3) at runtime
(`ARIO_*_PROGRAM_ID` for mainnet, `DEVNET_PROGRAM_IDS` off it) — this table is
the human-readable snapshot (verified live 2026-07-17), useful when auditing
`--process-id` overrides or block-explorer output:

| Program | `--network mainnet` (default) | `--network devnet` |
|---|---|---|
| ario-core | `73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh` | `8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1` |
| ario-gar | `89fNiiwgpFSPHKuqfNUkgYTYjtAJAhyqHjXmgXeppGpf` | `7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz` |
| ario-arns (name registry) | `2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ` | `6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp` |
| ario-ant (ANT state) | `2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5` | `DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX` |

- **There is no `--network testnet`**: ar.io deploys nothing on Solana's testnet
  cluster (#376/#381) — the flag rejects it up front.
- Every spawned ANT is an **MPL Core** asset (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`,
  same id on every cluster); the asset pubkey is the SDK's `processId`.
- Free devnet test loop (#381): ARIO faucet `https://faucet.services.ar-io.dev/` →
  `rig name buy --network devnet` → `rig name set` → resolves at the
  devnet-connected gateway `https://<name>.ar-io.dev/`.
- `--process-id <id>` overrides the arns registry program outright (wins over
  `--network`) — for pointing at a fresh/staging registry deployment.

---

## Devnet reference (public chains)

Since 2026-07-19 the TOON devnet settles on **public networks** — there is no
self-hosted chain infrastructure. The authoritative, machine-readable source for
everything below is the apex's **kind:10032 announce** on the relay; the
authoritative doc is
[toon-meta `docs/deployment.md`](https://github.com/toon-protocol/toon-meta/blob/main/docs/deployment.md).

### Endpoints

| What | URL |
|---|---|
| Faucet (web UI + API) | `https://faucet.devnet.toonprotocol.dev` |
| Relay (free reads, `rig clone`/`fetch`) | `wss://relay-ws.devnet.toonprotocol.dev` |
| Payment proxy (paid writes, BTP) | `wss://proxy.devnet.toonprotocol.dev:443` |
| Store DVM (ArNS buyfor/gas-station jobs, `--via`) | `https://dvm.devnet.toonprotocol.dev` |

### Faucet routes

| `POST` path | Drips |
|---|---|
| `/api/base-sepolia/request` | 1000 USDC (ungated on-chain mint) |
| `/api/solana/request` | 2 SOL + 1000 USDC (airdrop leg subject to the public devnet's per-IP quota) |
| `/api/mina/request` | 5 MINA + USDC (treasury self-mint, rate-limited token) |

Body: `{"address": "<wallet>"}`. `rig fund` hits these same routes for the
identity's derived wallets.

### Settlement contracts

Chain ids below are the **announced spellings** — use them verbatim with
`TOON_CLIENT_CHAIN=<id> rig push` to pin a settlement chain.

| Chain (`TOON_CLIENT_CHAIN`) | Payment-channel contract/program/zkApp | USDC token (6dp) | Explorer |
|---|---|---|---|
| `evm:84532` (Base Sepolia) | TokenNetwork `0x1E95493fEF46707E034b4a1945f25a8C76A1823D` (registry `0xcC9079adE929b168B54145f6d25262b64FAB9D5b`) | `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` | [base-sepolia.blockscout.com](https://base-sepolia.blockscout.com) |
| `solana:devnet` | program `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip` | mint `xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in` | [explorer.solana.com/?cluster=devnet](https://explorer.solana.com/?cluster=devnet) |
| `mina:devnet` | PaymentChannel zkApp `B62qmgPhv2Xo6QVEtwjLja8UZJUtu8yapRFAR6gaoGtbM9zE5hG7Tkf` | token `B62qqN1Pu3kF2KGmqLA8EwpqfWrnFTVZJGDSDHQuQRoVt5BCFjhNz3d`<br>tokenId `9497120696276615621907376728658022802954262638363646162765282600447713419198` | [minascan.io/devnet](https://minascan.io/devnet/home) |

### Config notes (rig ≥ 2.10.2)

Keep `~/.toon-client/config.json` **minimal** — settlement parameters derive
from the announce. Three additions are load-bearing on today's devnet:

```jsonc
{
  "feePerEvent": "1000",             // = the announced route price
  "chainRpcUrls": {                   // per-field overrides only
    "evm:84532":   "https://base-sepolia-rpc.publicnode.com",
    "mina:devnet": "https://api.minascan.io/node/devnet/v1/graphql"
  },
  "minaChannel": {                    // Mina is not announce-derivable yet
    "graphqlUrl": "https://api.minascan.io/node/devnet/v1/graphql",
    "zkAppAddress": "B62qmgPhv2Xo6QVEtwjLja8UZJUtu8yapRFAR6gaoGtbM9zE5hG7Tkf",
    "tokenId": "9497120696276615621907376728658022802954262638363646162765282600447713419198",
    "networkId": "devnet"
  }
}
```

- Do **not** set `supportedChains`/`tokenNetworks`/`preferredTokens` explicitly —
  explicit topology bypasses the announce's route prices and paid writes get
  rejected (F06).
- After config changes, delete `~/.toon-client/rig-topology-cache.json` (cached
  topology can mask edits).
- Base Sepolia's official RPC (`sepolia.base.org`) is a load-balancer that
  serves stale reads — channel opens need a single-backend RPC like
  `base-sepolia-rpc.publicnode.com` (already in the snippet above).

## Strict `--json` stdout (machine consumers)

With `--json`, stdout carries **exactly one JSON document** — everything
human-facing (identity reports, deprecation nudges, progress lines, even stray
`console.log` from dependencies) is routed to stderr, so `rig <command> --json | jq`
always parses. Errors emit one machine envelope (`{"error": "<code>", "detail": …}`)
on stdout with the human detail on stderr and a non-zero exit. `--json` is a
per-subcommand flag on the commands rig owns, **not** a global rig flag.

## Git passthrough

Any subcommand rig does not own is executed as `git <args...>` verbatim: the exact
argv tail is handed to system git with `stdio: 'inherit'` (interactive commands,
pagers, colors, and prompts work), and git's exit code becomes rig's exit code (a
child killed by a signal maps to the shell convention 128+N). rig-owned verbs always
take precedence — in particular `rig push` is the TOON transport and shadows
`git push`; plain-git pushes remain available by calling `git push` directly. If no
system git is installed, passthrough fails with a clear error (exit 127).

The passthrough is exempt from the `--json` contract: `rig status --json` runs
`git status --json` (git rejects the flag), and flags before the subcommand
(`rig --json status`) pass through to git untouched.

## Identity

The CLI is **standalone by default**: it embeds its own payment client built from
your seed phrase (`@toon-protocol/client` is a regular dependency, installed
automatically) — no daemon is ever required.

**No phrase yet? Generate one — `rig identity create`.** It mints a fresh BIP-39
mnemonic, shows it ONCE with a backup warning, and writes it to the encrypted
keystore under `TOON_CLIENT_HOME`. It refuses to overwrite an existing identity
without `--force`. `rig identity show` reports the active source + pubkey (never the
phrase); `rig identity import` writes an existing phrase (read from stdin, never a
CLI argument) to the keystore. `--json` on **`create`** is the ONE sanctioned path
that emits the phrase (in a `mnemonic` field — treat as secret); `show`/`import`
never do.

The mnemonic is resolved along one precedence chain — highest first:

1. `RIG_MNEMONIC` environment variable
2. `TOON_CLIENT_MNEMONIC` environment variable — deprecated alias, warns on stderr;
   rename it to `RIG_MNEMONIC`
3. project-local `.env` — found by walking up from the working directory (through
   the repo root); ONLY the `RIG_MNEMONIC` line is parsed out of it. **Gitignore
   it** — the phrase must never be committed.
4. the shared `~/.toon-client` state dir (`TOON_CLIENT_HOME` override): encrypted
   keystore (`keystorePath` + `TOON_CLIENT_KEYSTORE_PASSWORD`), then the `mnemonic`
   config field

The BIP-44 account index follows the same env-over-config rule: the
`RIG_ACCOUNT_INDEX` environment variable always wins; the shared config's
`mnemonicAccountIndex` applies ONLY when the phrase itself came from the shared
state dir (tier 4); otherwise account 0. An explicit `RIG_MNEMONIC` therefore
derives the same identity no matter which `TOON_CLIENT_HOME` is active — a
per-home config never silently shifts an explicitly provided identity.

Every paid command reports which source is active and the derived pubkey
(`Identity: <pubkey> (from …)`, and an `identity` object in `--json` output) — the
phrase itself is never printed and never written to git config or any repo file.

## Daemon as accelerator

Every standalone paid command pays a fixed bootstrap cost (relay discovery, peer
negotiation, channel resume). Two things remove most of it:

- **Automatic daemon delegation** — when a running `toon-clientd` on the loopback
  control port (`TOON_CLIENT_HTTP_PORT`, default 8787) holds the **same identity**,
  paid write commands (`push`, `issue`, `comment`, `pr create`, `pr status`)
  delegate to its `/git/*` routes instead of bootstrapping an embedded client. The
  daemon already owns the payment channel's cumulative-claim watermark, so one
  process signs all claims. The identity match is confirmed against `GET /status`
  **before** anything is sent; a daemon on a different identity, or none at all,
  runs standalone. The chosen path prints on stderr (`rig: paid path: …`) and lands
  in `--json` as `"path": "daemon" | "standalone"`. Commands the daemon has no route
  for — `rig fund`, `rig balance`, `rig channel open|close|settle` — always run
  standalone (the on-chain channel mutations among them refuse while a same-identity
  daemon runs, so as not to race its live claims: stop the daemon for those).
- **Standalone topology cache** — the resolved network topology (announce discovery,
  payment-peer pick, settlement-chain selection) is cached under `TOON_CLIENT_HOME`
  (`rig-topology-cache.json`), keyed by relay + identity + explicit config, for 15
  minutes (`RIG_TOPOLOGY_TTL_MS` overrides; `0` disables). A cached topology that
  fails to bootstrap is invalidated and re-resolved live. Money state (claim
  watermarks, channel map) is never cached.

The `rig` bin also exits as soon as a command finishes and stdio is flushed, rather
than letting the embedded client's keep-alive socket hold the process open for ~30s.

## Pushing

`rig push [remote] [refspecs...]` uploads the object delta to Arweave (paid,
content-addressed — a re-push never re-pays for known objects) and publishes the
NIP-34 refs event (kind:30618; plus the kind:30617 announcement on first push). It
renders the fee table (refs with classification, objects, bytes, itemized + total
fee) and asks for confirmation before spending — writes are permanent and
non-refundable. `--yes` skips the prompt (and is required when stdin is not a TTY);
`--json` without `--yes` is a pure estimate (nothing executed). `--force` allows
non-fast-forward updates; `--repo-id <id>` overrides the configured repo id.

Repo addressing (`30617:<owner>:<repoId>`) comes from the `toon.repoid` / `toon.owner`
git config keys `rig init` writes — an unconfigured repo is a clear "run `rig init`"
error, and pushing never mutates git config. Objects over 95KB are a hard error in
v1 (large-object support: toon-client#235).

## Relays are origins

Relays are configured as **real git remotes** (`rig remote add` is `git remote add`
underneath — `git remote -v` shows them, and remotes added with plain git work too,
as long as the URL is `ws://`/`wss://`/`http://`/`https://`):

- `rig remote add origin <relay-url>` / `rig remote remove <name>` / `rig remote list`
  (`--json` supported). Junk URLs are rejected at add time.
- `rig push` publishes via `origin`; `rig push <remote> [refspecs...]` via a named
  remote. Git-like resolution: when the first positional matches a configured remote
  name it is the remote, otherwise it is a refspec and the remote defaults to
  `origin`.
- The event commands take `--remote <name>` (default `origin`).
- `--relay <url>` stays as an **ad-hoc override** on every paid command: it bypasses
  the configured remotes entirely.
- One relay URL per remote: a remote with multiple URLs is refused **before**
  anything is uploaded, published, or paid.

The single-event subcommands follow the same paid-write discipline as push — the
per-event fee is quoted and confirmed before publishing; `--yes` skips, `--json`
without `--yes` is a free estimate:

- `rig issue create --title <t> [--body <b> | --body-file <f> | stdin] [--label <l>]…` — kind:1621.
- `rig comment <root-event-id> --body <b> [--parent-author <pubkey>] [--marker root|reply]` — kind:1622.
- `rig pr create --title <t> (--range <A..B> | --patch-file <f>) [--body <b> | --body-file <f>] [--branch <name>]` —
  kind:1617; `--range` runs real `git format-patch --stdout` locally and derives the
  `commit`/`parent-commit` tags. A multi-commit range publishes ONE event carrying
  the whole series. `--body`/`--body-file` attach the PR description in a dedicated
  `description` tag — the event content stays pure format-patch output, so
  `rig pr show`'s patch text still pipes straight into `git am`.
- `rig pr status <target-event-id> <open|applied|closed|draft>` — kind:1630–1633.

`--repo-id` / `--owner` override the git config address (use `--owner` for repos you
don't own).

## Cloning & fetching (free reads)

`rig clone <relay-url> <owner>/<repo-id> [dir]` reconstructs the repository from
public data alone: the kind:30618 `arweave` sha→txId map drives parallel downloads
across the gateway fallback chain (SHAs the map misses resolve via the Arweave
GraphQL `Git-SHA` tag index), **every body is verified against its SHA-1 before it
is written**, and the repository is materialized through git's own plumbing
(`git hash-object -w`, `git update-ref`, HEAD from the 30618 symref, checked-out
worktree). Everything happens in a temp dir moved into place on success, so a failed
clone never leaves a partial repo. `rig fetch [remote]` is the same pipeline as a
delta: only locally-missing objects are downloaded, and `refs/remotes/<remote>/*`
(tags → `refs/tags/*`) move with a `git fetch`-style report.

`rig issue list|show` and `rig pr list|show` are pure relay reads (kind:1621/1617 by
the repo `#a` tag; state from kind:1630-1633, latest wins; kind:1622 comments under
`show`).

## Library

`rig` is also the git-to-TOON write-path core. No signing or payment code lives in
it — that stays behind the `Publisher` seam:

- `objects.ts` — git object construction with SHA-1 envelope hashing: `createGitBlob`,
  `createGitTree`, `createGitCommit`, `createGitTag`, `hashGitObject`, and the
  `MAX_OBJECT_SIZE` (95KB) upload guard.
- `nip34-events.ts` — NIP-34 event builders returning `UnsignedEvent`:
  `buildRepoAnnouncement` (30617), `buildRepoRefs` (30618), `buildIssue` (1621),
  `buildComment` (1622), `buildPatch` (1617), `buildStatus` (1630–1633).
- `repo-reader.ts` — `GitRepoReader`, read-only local-repo access via injection-safe
  `execFile` git plumbing.
- `remote-state.ts` — `fetchRemoteState`, the "what does the remote have?" reader.
- `object-fetch.ts` / `read-pipeline.ts` / `materialize.ts` — the read path
  (gateway fallback + concurrency cap + SHA-1 verification, object-graph closure,
  git plumbing writers with hostile-refname gating).
- `npub.ts` — dependency-free bech32 `npubToHex` / `hexToNpub` / `ownerToHex`.
- `publisher.ts` — the `Publisher` interface (paid transport seam), implemented by
  the daemon and the standalone embedded client.
- `push.ts` — `planPush` (ref classification, object delta, fee estimate) and
  `executePush` (crash-resume safe via content-addressed skip).
- `routes.ts` — the JSON wire shapes of the daemon's `/git/*` control routes.
- `cli/` — the `rig` bin.

Part of [epic #222](https://github.com/toon-protocol/toon-client/issues/222) and
[epic #246](https://github.com/toon-protocol/toon-client/issues/246).
