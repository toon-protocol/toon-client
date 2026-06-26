# @toon-protocol/client-mcp

Let a Claude agent — **Claude Desktop or Claude Code** — act as a full TOON
Protocol client: **pay-to-write** publishing, **free** reads/subscriptions,
payment-channel/balance management, and swaps.

The agent surface is an **MCP server** — bin **`toon-mcp`**, which registers
with the host under the server name **`toon-client`** (this is the name that
appears in Claude's MCP server list and in the `initialize` handshake;
`mcpServers.toon` in config is just your local alias). The two long-lived
connections that can't live in an ephemeral agent session — a **BTP** session
(paid writes via the connector/apex) and a **town-relay Nostr-WS** subscription
(free reads) — live in
an **always-on detached daemon** (`toon-clientd`). The MCP server is a thin
stdio proxy that auto-spawns the daemon and never holds chain keys.

| | Name |
|---|---|
| npm package | `@toon-protocol/client-mcp` |
| MCP server name (handshake) | `toon-client` |
| MCP server bin | `toon-mcp` |
| Daemon bin | `toon-clientd` |

```
Claude (Desktop / Code)
        │  stdio (MCP)
        ▼
   toon-mcp  ──HTTP──▶  toon-clientd (detached, always-on)
                          ├─ ToonClient: BTP session + payment channels + signer
                          └─ RelaySubscription: persistent town-relay Nostr-WS
```

## Architecture

| Layer | Bin / module | Responsibility |
|---|---|---|
| **Daemon** | `toon-clientd` | Owns one `ToonClient` (BTP + channels + mnemonic keystore + network targeting) **plus** a persistent town-relay subscription. Loopback HTTP control API, single-instance PID lock, channel nonce-watermark persistence, graceful shutdown. |
| **MCP server** | `toon-mcp` | `@modelcontextprotocol/sdk` stdio server. Maps tools → daemon HTTP; auto-spawns the daemon detached if down; reports "bootstrapping — retry" while the BTP session comes up; holds no keys. |
| **Skill** | `.claude/skills/toon-client/` | Teaches the agent pay-to-write / free-read / settlement semantics. |

## Tools

The `toon-client` MCP server exposes **8 tools**:

| MCP tool | Daemon endpoint | Backing |
|---|---|---|
| `toon_status` | `GET /status` | ready/bootstrapping, transport, relay health, per-chain settlement, active chain |
| `toon_identity` | `GET /status` | Nostr pubkey + EVM/Solana/Mina addresses (no keys) |
| `toon_publish(event,{destination?,fee?})` | `POST /publish` | `signBalanceProof` + `publishEvent` (paid write) |
| `toon_subscribe(filters,{subId?})` | `POST /subscribe` | register a persistent free-read subscription |
| `toon_read({subId?,cursor?,limit?})` | `GET /events` | drain buffered events by cursor (free) |
| `toon_open_channel({destination?})` | `POST /channels` | `openChannel` (pre-open / fetch a channel) |
| `toon_channels` | `GET /channels` | `getTrackedChannels` + nonce watermark + cumulative spend |
| `toon_swap(destination,amount,{toonData?})` | `POST /swap` | `sendSwapPacket` (mill swap) |

## Install

```bash
pnpm add -g @toon-protocol/client-mcp     # installs both bins
```

This installs two bins: `toon-clientd` and `toon-mcp`. To run a bin straight
from npm without a global install, name it explicitly (the package name is not a
bin, so plain `npx @toon-protocol/client-mcp` fails):

```bash
npx -y -p @toon-protocol/client-mcp toon-mcp       # MCP stdio server
npx -y -p @toon-protocol/client-mcp toon-clientd   # daemon
```

> **Trying the public devnet?** See [docs/devnet-mcp-quickstart.md](../../docs/devnet-mcp-quickstart.md)
> for a known-good, end-to-end-verified proxy-mode config (the explicit settlement maps the core
> devnet preset still omits), faucet funding, and the Windows/WSL bridge.

## First run (zero-config onboarding)

On the **first** `toon-clientd run`/`start` (including the auto-spawn from
`toon-mcp`), the daemon onboards a brand-new user with no manual setup:

- **Identity** — if no mnemonic is configured, it generates a fresh BIP-39
  mnemonic, encrypts it to `~/.toon-client/keystore.json`, records
  `keystorePath` in `config.json`, and prints the seed phrase + derived
  addresses **once** (back it up). The keystore is encrypted with
  `TOON_CLIENT_KEYSTORE_PASSWORD` when set, otherwise a default password so the
  identity reloads on every restart with **no env var required**.
- **Transport scaffolding** — it writes a starter `~/.toon-client/config.json`
  carrying the `btpUrl`/`relayUrl` knobs plus a `_help` block documenting them.

The one thing you must supply is the apex you pay: set **`btpUrl`** (and usually
`relayUrl`) in the scaffolded config, then publish. Everything below is for
overriding those auto-provisioned defaults.

## Configure the daemon

The daemon reads `~/.toon-client/config.json` (override with `TOON_CLIENT_CONFIG`).
The **mnemonic is never stored in plaintext by default** — it is auto-generated
into an encrypted keystore (scrypt + AES-256-GCM, mode 0600) on first run, or you
can supply your own via env or an imported keystore.

```jsonc
// ~/.toon-client/config.json
{
  "network": "testnet",                       // settlement presets (#209)
  "keystorePath": "~/.toon-client/keystore.json",
  "btpUrl": "ws://<apex-host>:3000/btp",
  "relayUrl": "ws://<relay-host>:7100",       // free reads
  "destination": "g.proxy",
  "feePerEvent": "1",
  "httpPort": 8787,
  // Direct-apex mode: bootstrap finds 0 peers, so name the apex's
  // settlement address directly (mirrors the docker entrypoint):
  "apex": {
    "destination": "g.proxy",
    "peerId": "town",
    "chain": "evm",
    "chainKey": "evm:base:84532",
    "chainId": 84532,
    "settlementAddress": "0x<apex-receive-addr>",
    "tokenAddress": "0x<usdc>",
    "tokenNetwork": "0x<token-network>"
  }
}
```

Environment overrides: `TOON_CLIENT_MNEMONIC`, `TOON_CLIENT_KEYSTORE_PASSWORD`,
`TOON_CLIENT_BTP_URL`, `TOON_CLIENT_RELAY_URL`,
`TOON_CLIENT_HTTP_PORT`, `TOON_CLIENT_NETWORK`, `TOON_CLIENT_HOME`.

`btpUrl` (paid writes over BTP) and `relayUrl` (free reads over Nostr-WS) are
dialed directly as-is. The first bootstrap brings up the BTP session **once** —
the detached daemon then stays up.

### Create an encrypted keystore

```bash
TOON_CLIENT_MNEMONIC="word word ..." \
TOON_CLIENT_KEYSTORE_PASSWORD="…" \
node -e "import('@toon-protocol/client').then(m => m.importKeystore(process.env.HOME+'/.toon-client/keystore.json', process.env.TOON_CLIENT_MNEMONIC, process.env.TOON_CLIENT_KEYSTORE_PASSWORD))"
```

## Daemon lifecycle (Claude Code only — it has a shell)

```bash
toon-clientd start     # spawn detached, wait until reachable
toon-clientd status    # print status JSON
toon-clientd stop      # SIGTERM the locked PID
toon-clientd run       # run in the foreground (what the detached spawn runs)
```

The MCP server auto-spawns the daemon, so `start` is optional.

## Register with Claude

### Claude Code

```bash
claude mcp add toon -- toon-mcp
```

…or add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "toon": { "command": "toon-mcp" }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toon": {
      "command": "toon-mcp",
      "env": {
        "TOON_CLIENT_KEYSTORE_PASSWORD": "…"
      }
    }
  }
}
```

Then restart Claude Desktop. The TOON tools appear in the tool list; the first
`toon_publish` after a cold start may report "bootstrapping — retry" while the
BTP session comes up.

## Usage example

You don't call these tools by hand — the agent does, in response to plain
requests. A typical "post a note, then read it back" flow:

> **You:** Post a note to TOON saying "gm from my agent", then show me when it lands.

The agent runs:

1. **`toon_status`** → confirm the client is up.
   ```json
   { "ready": true, "bootstrapping": false, "settlementChain": "evm",
     "relay": { "connected": true }, "identity": { "evmAddress": "0x99ed…" } }
   ```
   (If it returns `bootstrapping: true` or a "retry shortly" message, wait a few
   seconds for the BTP session, then retry.)

2. **`toon_subscribe`** for its own author so it can read the note back:
   ```json
   { "filters": { "authors": ["<my-hex-pubkey>"], "kinds": [1] } }
   → { "subId": "sub-1" }
   ```

3. **`toon_publish`** the signed kind:1 event (the daemon signs the payment-channel
   claim and forwards it over BTP):
   ```json
   { "event": { "kind": 1, "content": "gm from my agent", "id": "…", "sig": "…", … } }
   → { "eventId": "0d0c1f98…", "channelId": "0xc73a77…", "nonce": 7 }
   ```

4. **`toon_read`** until the event appears (free; cursor long-poll):
   ```json
   { "subId": "sub-1" }
   → { "events": [ { "id": "0d0c1f98…", "content": "gm from my agent", … } ],
       "cursor": 12, "hasMore": false }
   ```

5. **`toon_channels`** to show what it cost:
   ```json
   → { "channels": [ { "channelId": "0xc73a77…", "nonce": 7, "cumulativeAmount": "7" } ] }
   ```

Other common calls: **`toon_open_channel`** to pre-open a channel before a burst
of publishes, and **`toon_swap({ destination, amount })`** to pay a mill peer and
receive a target-chain claim.

> **CLI equivalent** (handy for scripting/debugging — the MCP tools map 1:1 to
> these daemon endpoints):
> ```bash
> toon-clientd start                                   # boot the daemon
> curl -s localhost:8787/status | jq                   # toon_status
> curl -s -XPOST localhost:8787/subscribe \
>   -H content-type:application/json \
>   -d '{"filters":{"authors":["<hex>"],"kinds":[1]}}' # toon_subscribe
> curl -s -XPOST localhost:8787/publish \
>   -H content-type:application/json \
>   -d '{"event":{…signed kind:1…}}'                   # toon_publish
> curl -s 'localhost:8787/events?subId=sub-1' | jq     # toon_read
> curl -s localhost:8787/channels | jq                 # toon_channels
> ```

## Security

- The daemon holds the mnemonic/keystore; the agent sees **only addresses and
  results**, never private keys.
- A single-instance PID lock prevents two daemons from racing the channel nonce
  watermark (which would corrupt the payment proof).
- The control plane binds `127.0.0.1` only (no auth layer — it never leaves
  loopback).

## Tests

```bash
pnpm --filter @toon-protocol/client-mcp test              # unit
pnpm --filter @toon-protocol/client-mcp test:integration  # gated integration suite
```

The integration suite lives in `src/__integration__/`.

## Publishing

This package is **published to npm automatically by CI/CD**, in lockstep with the
repo's release tag (the same `vX.Y.Z` semantic-release cuts for
`@toon-protocol/relay`). On a release, `publish-relay-images.yml` builds
this package, sets its version to the tag, and runs
`pnpm --filter @toon-protocol/client-mcp publish --access public`.

It is **self-contained**: its `@toon-protocol/*` workspace deps (`client`, `core`)
are **bundled into `dist`** at build time (tsup `noExternal`), so the published
`package.json` carries **zero `@toon-protocol/*` runtime deps** — only npm
packages (`fastify`, `@modelcontextprotocol/sdk`, `nostr-tools`, `viem`, `ws`,
`@toon-format/toon`) plus optional chain libs (`o1js`, `mina-signer`,
`@solana/web3.js`) installed only when you use those chains.
A guard test (`src/package-structure.test.ts`) fails the build if a
`@toon-protocol/*` runtime dep ever leaks in.

To publish manually: `pnpm --filter @toon-protocol/client-mcp build && pnpm --filter @toon-protocol/client-mcp publish --access public`.
