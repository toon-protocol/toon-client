# Development

Working on this repository: the toolchain, the build, the test tiers, the wire vectors, and how a
release happens.

## Layout

One package, `packages/client`, published as `@toon-protocol/client` and carrying both the library
and the `toon` CLI.

```text
packages/client/src/
  client/     the ToonClient facade, its config, send(), errors
  connector/  the client edge: self-description, identity, prices, claim state
  ilp/        packet types and the send interface both carriages implement
  http/       ILP-over-HTTP
  btp/        the websocket carriage, its frame codec, transport selection
  wire/       the OER envelope, the gift wrap, the fulfilment, the vectors
  channel/    the channel lifecycle, the store, and the per-chain clients
  signing/    balance-proof signing, per chain
  keys/       mnemonic derivation and the encrypted keystore
  wallet/     chain balances, transfers, the devnet faucet
  cli/        the `toon` command
```

## Toolchain

Node 22 or newer, pnpm 9.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

### Devbox

[Devbox](https://github.com/jetify-com/devbox) pins a reproducible local toolchain — Node 22 and
pnpm — so the standard targets run in a shell without touching your system packages.
[Install devbox](https://www.jetify.com/devbox/docs/installing_devbox/) first.

```bash
devbox shell         # enter the pinned shell; the first run downloads via Nix

node --version       # v22.x
pnpm --version

devbox run build     # pnpm install --no-frozen-lockfile && pnpm build
devbox run lint
devbox run test
```

Devbox's pnpm still trails the repository's `packageManager` pin, which is why `devbox run build`
installs with `--no-frozen-lockfile` to bridge the gap. `.devbox/` is gitignored; `devbox.json`
and `devbox.lock` are committed.

## Test tiers

There are three, and they are separated by what they need to be able to reach.

**Unit** — `pnpm --filter @toon-protocol/client test`. No network, no chain, no processes. Every
transport, signer and chain client is injectable for exactly this reason. This is the tier that
must stay fast and must never be skipped.

**Integration** — `pnpm --filter @toon-protocol/client test:integration`. Binds loopback servers
only: a fake connector over HTTP and over a websocket, asserting the full send path including the
claim header, the accumulated-cost header and the sealed answer. Generous timeouts for slow CI
networking, but no external service.

**Opt-in, against something real** — off by default because they spend testnet money or need a
local validator:

| Suite | How to run it |
| --- | --- |
| `rust-edge-devnet` | `RUST_EDGE_DEVNET=1`, with a funded key. Spends real testnet USDC against the deployed devnet connector. |
| `solana-channel-lifecycle` | Needs `solana-test-validator` on the path. Proves the on-chain lifecycle: initialize, deposit, claim, close, settle. |

## A connector on your machine

The public devnet is the easiest target, but it is someone else's node and it moves. To develop
against a connector you control — or to test a change before a fleet has it — run the published
image against real containerised chains. Everything below is in the
[connector repository](https://github.com/toon-protocol/connector), whose `local/` directory
exists for exactly this.

```bash
cd ../connector
make anvil-up          # anvil, with the settlement contracts deployed into it
docker pull ghcr.io/toon-protocol/connector:rust-main
```

Then run a connector with a priced route and an EVM settlement backend pointed at that anvil. A
minimal `connector.toml`:

```toml
client_edge_addr = "0.0.0.0:3000"
state_dir        = "/app/state"

[signer]
key_file = "/app/data/signer.key"          # 32 raw bytes, or 64 hex characters

[node]
addresses     = ["g.lab.solo"]
http_endpoint = "http://127.0.0.1:3100/ilp"
btp_endpoint  = "ws://127.0.0.1:3100/ilp/btp"

[[routes]]
prefix      = "g.lab.solo"
handler_url = "http://stub-app:3100/"
price       = 1000

[settlement.evm]
rpc_url          = "http://anvil:8545"
contract_address = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"   # the registry, not a token network
token_address    = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
decimals         = 6

[settlement.evm.key]
key_file = "/app/data/settlement.key"
```

Four things that will otherwise cost you an afternoon:

- **`contract_address` is the `TokenNetworkRegistry`, not a `TokenNetwork`.** The connector
  resolves `getTokenNetwork(token_address)` through it and refuses to start if that comes back
  zero. Naming a token network here fails at boot, because it has no `getTokenNetwork`.
- **`[node]` is all-or-nothing.** Setting `http_endpoint` without `btp_endpoint` is a startup
  refusal: a node behind TLS termination cannot learn its own public name, so there is
  deliberately no default rather than a published dead URL.
- **The image runs as uid `10001`**, so every mounted key file has to be readable by it, and
  `/app/state` has to be a named volume rather than a host bind mount.
- **`stub-app` is the image's second binary** and needs `0.0.0.0:3100` as its argument; it
  defaults to loopback, which no other container can reach.

Anvil's default mnemonic funds account 0 with mock USDC, so the client can open and fund a
channel against it:

```bash
export TOON_CONNECTOR=http://127.0.0.1:3100
export TOON_MNEMONIC='test test test test test test test test test test test junk'
export TOON_RPC_URL=http://127.0.0.1:8545

npx toon channel open --deposit 100000
npx toon send g.lab.solo --body 'hello'
```

> [!WARNING]
> That mnemonic is public and every local chain ships with it. It is fine here and nowhere else.

## Wire vectors

The connector's committed vectors are the normative contract for the wire. Prose describing it —
including [how-a-paid-packet-works.md](how-a-paid-packet-works.md) — is not. This client vendors
them under `packages/client/src/wire/vectors/`, SHA-256 pinned, and replays them as its own
conformance suite: reproducing those bytes is what conformance means here.

```bash
# Compare the vendored copy against the connector's main branch.
pnpm --filter @toon-protocol/client vectors:check

# Refresh from the connector's main branch.
pnpm --filter @toon-protocol/client vectors:refresh

# Refresh from a local connector checkout, when you are changing both sides at once.
pnpm --filter @toon-protocol/client vectors:refresh:local
node scripts/refresh-wire-vectors.mjs --from-local /path/to/connector
```

`--from-local` reads the file straight from a checkout and records its provenance from that
checkout's own `git rev-parse HEAD`, marking the result `source: 'local'` and flagging a dirty
tree. The vector test **fails on a dirty refresh**: a vector generated from uncommitted work is a
contract nobody else can reproduce.

A CI job runs `vectors:check` daily and on any pull request touching `src/wire/**`, so drift from
the connector shows up as a failing check rather than as a mystery in production.

## Continuous integration

`.github/workflows/ci.yml` runs install, build, typecheck, lint, the unit tier and the integration
tier, plus a Solana job that installs a validator and runs the on-chain lifecycle suite. A change
to `packages/client` without a changeset fails its own gate.

## Release

Releases go through [changesets](https://github.com/changesets/changesets), published by CI with
the organisation's npm token.

```bash
pnpm changeset          # describe the change and pick a bump
pnpm changeset status   # what would be released
```

Merging a changeset to `main` opens a version pull request; merging **that** publishes.

**Never run `npm publish` by hand.** It ships unresolved `workspace:*` ranges, which installs as a
package that cannot be resolved.

## House rules

- The wire is the connector's. Where this repository disagrees with
  [toon-protocol/connector](https://github.com/toon-protocol/connector) and its vectors, this
  repository is wrong.
- **Payment-claim validation lives only in the connector.** Never re-implement the gate here — a
  second implementation of a rule about money is a second answer waiting to disagree.
- A refusal is returned, not thrown. Anything this client throws happened before the packet went
  out, or on chain.
- Amounts are `bigint` base units everywhere, and are printed base units first with the human
  figure in parentheses.
