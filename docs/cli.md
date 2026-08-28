# CLI reference

The `toon` command ships in `@toon-protocol/client`. `npx toon` runs it without a global install.

```bash
npx toon help
npx toon help send
```

## Settings, and where each comes from

Every setting resolves the same way — **flag, then environment variable, then default**. A default
that is a guess rather than a fact is announced on stderr, because falling back to a connector
nobody named should not be silent.

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Connector | `--connector URL` | `TOON_CONNECTOR` | The devnet store node, with a warning |
| Keys | — | `TOON_MNEMONIC` | The keystore, below |
| Keystore | `--keystore PATH` | `TOON_KEYSTORE` | `~/.toon/keystore.json` |
| Keystore password | `--password-file PATH` | `TOON_KEYSTORE_PASSWORD` | A hidden prompt, when stdin is a TTY |
| Chain | `--chain evm\|solana` | `TOON_CHAIN` | The first chain the node settles on that you hold a key for |
| RPC | `--rpc URL` | `TOON_RPC_URL` | The package's preset for the chosen chain |
| Channel store | `--store PATH` | `TOON_CHANNEL_STORE` | `~/.toon/channels.json` |
| Carriage | `--transport auto\|http\|btp` | — | `auto` |

Keys resolve in that order for a reason: `TOON_MNEMONIC` first, then the keystore, then a message
telling you to run `toon init`. **There is no `--mnemonic` flag and there will not be one** — a
flag value is written to shell history and is readable in `ps` by every other user on the machine
for as long as the process runs.

The password resolution is ordered for non-interactive runs: `--password-file`, then
`TOON_KEYSTORE_PASSWORD`, then a hidden prompt, then a clear error naming both non-interactive
options. A CLI that hangs forever on a pipe waiting for a password nobody can type is worse than
one that says so.

## Global flags

| Flag | Effect |
| --- | --- |
| `--json` | Print exactly one JSON document on stdout and nothing else |
| `--quiet` | Suppress progress and warnings on stderr |
| `-h`, `--help` | Show help for the command |
| `--version` | Print the client version |

## Commands

### `toon init [--import] [--legacy-derivation]`

Create or import a keystore. Writes an encrypted BIP-39 keystore to `~/.toon/keystore.json`, mode
`0600`, and prints the phrase once for you to write down.

`--import` reads an existing phrase from **stdin**, never from an argument.
`--legacy-derivation` records that this phrase's EVM key belongs at the pre-1.0 path — use it when
importing a phrase whose channels were opened before 1.0.

### `toon identity [--all-derivations]`

Show the addresses this keystore holds. Touches no network and no chain.

`--all-derivations` also shows where a pre-1.0 keystore put the EVM key, which is the address to
look at when a channel opened before 1.0 seems to have vanished.

### `toon describe [URL]`

Read a connector's self-description: its addresses, its endpoints, the key payloads are sealed to,
what it settles in, and what each route costs. Free, unauthenticated, and needs no keys.

### `toon price <destination> [URL]`

What one route costs. Free, needs no keys. A connector that serves no route matching the
destination says so — an answer, not a failure.

### `toon probe <destination>`

Learn a path's cost without buying the work. Needs an open channel: a probe carries a claim, it
just does not spend it, and probing is rate-limited per channel.

### `toon send <destination> [options]`

Pay for one HTTP request and print the answer.

| Option | Meaning |
| --- | --- |
| `--method VERB` | HTTP method. Default `POST`. |
| `--target PATH` | Path beneath the route's handler. Default `''`, which is the handler itself. |
| `-H NAME:VALUE` | A request header. Repeat for more; order and duplicates are preserved. |
| `--body TEXT` | Request body. `-` reads stdin to EOF. |
| `--body-file PATH` | Read the request body from a file. |
| `--json-body` | Check the body parses as JSON and send it as `application/json`. |
| `--amount BASE_UNITS` | Override the route's price. |

The status printed is the **app's own**. A `404` from the app is a real answer: it rides home
fulfilled and costs exactly what a `200` costs. Only a refusal short of the app exits `3`.

```bash
npx toon send g.toon.store --body 'hello'
npx toon send g.toon.store --json-body --body '{"key":"value"}'
cat payload.bin | npx toon send g.toon.store --body -
npx toon send g.toon.relay --transport btp --body 'hello'
```

### `toon channel open|deposit <amount>|status|close|settle`

| Subcommand | What it does |
| --- | --- |
| `open` | Open a channel, or adopt the one already open with this connector |
| `deposit <base units>` | Add collateral. Monotonic — a deposit can never decrease |
| `status` | The channel as this client and the chain jointly see it |
| `close` | Start the challenge period |
| `settle` | Pay out and finish, once the challenge period has elapsed |

| Option | Meaning |
| --- | --- |
| `--deposit BASE_UNITS` | Collateral to lock, in the settlement token's base units |
| `--settlement-timeout SECONDS` | Challenge period. Default 86400; EVM floors it at 3600 |
| `--connector-view` | On `status`, also ask the connector for its own watermark and show both |

Every one of these is your transaction, on your gas.

```bash
npx toon channel open --deposit 100000     # 100000 base units (0.10 USDC)
npx toon channel status --connector-view
```

### `toon claim-state`

The connector's own watermark for the channels you control — deposit total, cumulative claimed,
available, nonce, last-claim time. One signature per channel, over a challenge distinct from a
claim. It works when the channel has run dry.

### `toon balances`

Chain balances for this identity: the native coin and the settlement token, per chain. A free
read.

### `toon transfer --to <address> --amount <base units> [--asset native|token]`

Move funds out of this wallet, straight to an address. Default asset is `token`. Delivery is
confirmed by an observed balance change at the destination, not by the transaction returning.

### `toon faucet`

Ask the devnet faucet for test funds. Devnet only. The Solana leg drips USDC and no SOL — see
[devnet.md](devnet.md#faucet).

## `--json` output

The contract is absolute: **stdout carries exactly one JSON document and nothing else.** Every
warning, prompt and progress note goes to stderr, so `toon send … --json | jq` never chokes on a
line of prose.

Inside that document:

- **A `bigint` becomes a decimal string**, never a JSON number. Every amount here is base units,
  and a number past 2^53 would round.
- **Bytes become base64.**
- Functions disappear, so a result's `text()`/`json()` helpers are not in the JSON — the body is,
  as base64.

Without `--json`, amounts are printed base units first with the human figure in parentheses:
`1000 (0.001 USDC)`. Both, because a channel deals in the integers the chain and the connector
actually agree on, and every error message is denominated in them. The decimals come from the
connector's own settlement entry; a node that publishes none gets the integer and no parenthetical
rather than a decimal point in a guessed place.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. For `send`, the packet fulfilled |
| `1` | An unexpected error |
| `2` | A usage mistake, or a setting that could not be resolved |
| `3` | The packet was refused (`fulfilled: false`) |
| `4` | A funding or channel problem — no gas, no channel, a missing watermark |
| `5` | A network or connector failure |
| `6` | Payment or a different carriage is required |

`3` is the interesting one: the network answered and the answer was no. `answer.code` in the JSON
says which no. See [errors.md](errors.md).

## The CLI never opens a channel by itself

The library defaults `autoOpenChannel` to `true`, which is right for a long-lived process
configured once. It is wrong for a command: `toon send` would submit chain transactions, spend gas
and lock collateral as a side effect of asking for one HTTP request. So the CLI turns it off, and
lets the refusal explain itself — "no channel yet, run `toon channel open`" — which is a sentence
you can act on, and reversible.
