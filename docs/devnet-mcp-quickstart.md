# Devnet quickstart — paid post to the relay from Claude

Connect **Claude Desktop** or **Claude Code** to the `toon-mcp` MCP server and publish a **paid**
`kind:1` note that round-trips through the public devnet: the connector pays-to-write over
ILP-over-HTTP, returns a FULFILL, and you read the note back for free over the Nostr relay.

This is the **proxy-mode devnet** path. The package [README](../packages/client-mcp/README.md)
covers generic install, the daemon, and BTP-mode config; this doc adds only what the public devnet
needs — the explicit settlement maps (the `@toon-protocol/core` devnet preset is still stale), the
endpoints, funding, and the Windows/WSL bridge.

> **Verified end-to-end on 2026-06-23** against the deployed Linode devnet: a paid `kind:1` publish
> FULFILLed (connector `HTTP/1.1 200 OK` store receipt) and was read back through `toon_read`. See
> [§6 Proof](#6-proof).

---

## 1. Install the MCP server

`@toon-protocol/client-mcp@0.3.0` (or newer) is on npm and is the first version whose paid-publish
path FULFILLs on the devnet (it includes proxy-mode apex negotiation and the `POST /write` envelope
fix). A global install is the simplest path:

```bash
pnpm add -g @toon-protocol/client-mcp     # installs the toon-mcp + toon-clientd bins
toon-mcp --version                        # sanity check the bin resolves
```

<details>
<summary>Build from source instead (for local development)</summary>

```bash
cd <path-to>/toon-client
git checkout main && git pull --ff-only origin main
pnpm install --no-frozen-lockfile
pnpm -r build
ls -l packages/client-mcp/dist/mcp.js     # the MCP server entry
```

A source build's server entry is `<path-to>/toon-client/packages/client-mcp/dist/mcp.js`; use
`node <that-path>` anywhere this doc uses the `toon-mcp` bin.
</details>

---

## 2. The known-good devnet config (`~/.toon-client/config.json`)

The daemon reads `~/.toon-client/config.json` automatically (override the dir with
`TOON_CLIENT_HOME`). This is the **minimal config that makes channel-open succeed** against the
stale-preset devnet — with this file present you need **no env vars at all**, which is what keeps the
Windows/WSL bridge in §3 trivial.

```json
{
  "network": "devnet",
  "proxyUrl": "https://proxy.devnet.toonprotocol.dev",
  "faucetUrl": "https://faucet.devnet.toonprotocol.dev",
  "relayUrl": "wss://relay-ws.devnet.toonprotocol.dev",
  "destination": "g.proxy.relay.store",
  "chain": "evm",
  "feePerEvent": "1000",
  "httpPort": 8787,
  "supportedChains": ["evm:anvil:31337"],
  "settlementAddresses": { "evm:anvil:31337": "0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab" },
  "tokenNetworks":       { "evm:anvil:31337": "0xcafac3dd18ac6c6e92c921884f9e4176737c052c" },
  "preferredTokens":     { "evm:anvil:31337": "0x5FbDB2315678afecb367f032d93F642f64180aa3" },
  "chainRpcUrls":        { "evm:anvil:31337": "https://evm-rpc.devnet.toonprotocol.dev" }
}
```

You supply the **identity** separately (§4) — either let the daemon auto-generate an encrypted
keystore on first run, or add a `"mnemonic"` field / set `TOON_CLIENT_MNEMONIC`.

### Why each field matters (so you can debug)

- `proxyUrl` → routes paid writes through the connector's `POST /ilp` (ILP-over-HTTP); **no BTP
  socket needed**. Omit it and tools report *"read-only — no write uplink configured."*
- `destination: g.proxy.relay.store` → the ILP destination. Its last segment (`store`) becomes the
  apex `peerId` the negotiation keys under; a good boot logs `injected apex negotiation for peer
  "store"`.
- The four `evm:anvil:31337` maps are the part the stale core preset gets wrong. They synthesize the
  apex negotiation deterministically (see `buildProxyApexNegotiation` in `daemon/config.ts`) instead
  of trusting the relay's `kind:10032` announcement:
  - `settlementAddresses` — the connector's EVM receive address (the on-chain channel counterparty).
  - `tokenNetworks` — the USDC `TokenNetwork` contract (channels open here).
  - `preferredTokens` — the USDC token contract (6 decimals).
  - `chainRpcUrls` — the Anvil RPC, keyed by the **exact** chainKey `evm:anvil:31337`
    (`evm:{network}:{chainId}`; the network label is cosmetic — only chainId `31337` + the RPC
    matter). Drop this and channel-open fails with *"No RPC URL configured for chain evm:…"*.
- `feePerEvent: "1000"` — base units paid per write (1000 = 0.001 USDC at 6 dp); `"1"` also works.

Everything except the four settlement maps also has an env override (`TOON_CLIENT_PROXY_URL`,
`TOON_CLIENT_RELAY_URL`, `TOON_CLIENT_FAUCET_URL`, `TOON_CLIENT_DESTINATION`, `TOON_CLIENT_HOME`, …).
The settlement maps are config-file-only, so the devnet needs this file regardless.

---

## 3. Register with Claude

### Claude Code (running inside Linux/WSL — simplest)

```bash
claude mcp add toon -- toon-mcp
```

…or commit a project `.mcp.json`:

```json
{ "mcpServers": { "toon": { "command": "toon-mcp" } } }
```

Reload Claude Code and run `/mcp` — the `toon_*` tools should appear.

### Claude Desktop (native)

Add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "toon": { "command": "toon-mcp" } } }
```

### Claude Desktop on Windows, server in WSL (bridge)

Claude Desktop is the **Windows** app while your install lives in **WSL**. Bridge through `wsl`, and
wrap in a **login shell** — if Node is installed via `nvm`, a bare `wsl toon-mcp` runs a non-login
shell with no Node on PATH (`command not found`). `bash -lic` sources nvm:

```json
{
  "mcpServers": {
    "toon": {
      "command": "wsl",
      "args": ["bash", "-lic", "exec toon-mcp"]
    }
  }
}
```

For a **source build**, swap the last arg for the dist path:
`"exec node /home/<you>/Documents/toon-client/packages/client-mcp/dist/mcp.js"`.

Notes:
- No `env` block is needed — the daemon reads `~/.toon-client/config.json` (WSL `$HOME`), which holds
  endpoints + identity. Env vars set in `claude_desktop_config.json` are Windows-side and are **not**
  forwarded into WSL unless you configure `WSLENV`; putting everything in `config.json` sidesteps it.
- `exec` makes the bin replace the shell so Claude's stdio talks straight to the MCP server.
- The MCP server auto-spawns the `toon-clientd` daemon on the first tool call.

---

## 4. Get a funded devnet identity

1. **Create an identity.** Easiest: start with no mnemonic and let the daemon auto-generate an
   encrypted keystore on first run (it prints the seed + addresses once — back it up). Or generate
   one yourself and put it in `config.json` as `"mnemonic"` / `TOON_CLIENT_MNEMONIC`:
   ```bash
   node --input-type=module -e "import {generateMnemonic} from '@scure/bip39'; import {wordlist} from '@scure/bip39/wordlists/english'; console.log(generateMnemonic(wordlist,128))"
   ```
   > Use a **throwaway** seed for devnet — never a mainnet key.
2. **Read your address.** Ask Claude to call `toon_identity`. The daemon derives the EVM address from
   the **same** secp256k1 key as Nostr (path `m/44'/1237'/0'/0/0`, *not* the standard `m/44'/60'`),
   so always read it from `toon_identity` rather than a generic wallet tool.
3. **Fund it from the devnet faucet** (100 ETH + 10,000 USDC):
   ```bash
   curl -sk -X POST https://faucet.devnet.toonprotocol.dev/api/request \
     -H 'content-type: application/json' \
     -d '{"address":"0xYOUR_EVM_ADDRESS"}'
   # → {"success":true,"transactions":{"eth":{…,"amount":"100"},"token":{…,"amount":"10000","symbol":"USDC"}}}
   ```

---

## 5. Send your first paid post (what to ask Claude)

With the server connected and the address funded:

1. **Health** — *"Call `toon_status`."* → expect `ready: true` and relay `connected: true`.
2. **(optional) Subscribe** so you can read it back — *"Call `toon_subscribe` with filters
   `{ "kinds": [1], "authors": ["<your-nostr-pubkey>"] }`."*
3. **Publish a paid note** — *"Call `toon_publish_unsigned` with kind 1 and content
   \"hello from TOON via Claude\"."* The daemon signs + pays; you hold no keys in the chat. Success
   returns `{ eventId, channelId, nonce, data }`; `data` base64-decodes to the connector's store
   receipt — your FULFILL: `{"eventId":"…","storedAt":…,"payer":"0x…","amount":"1000","chain":"proxy"}`.
   (If you already have a signed event, use `toon_publish` with `{ event: <signed event> }`.)
4. **Read it back (free)** — *"Call `toon_read`."* → find the event whose `id` equals the `eventId`.
5. **Inspect the channel** — *"Call `toon_channels`."* → your open channel with `nonce` +
   `cumulativeAmount`.

The first publish opens the on-chain channel lazily (a few seconds); later publishes are instant.

---

## 6. Proof

Driven over the real MCP stdio protocol (spawned the server, spoke MCP, called the tools) against the
deployed devnet on **2026-06-23**:

| Step | Result |
|------|--------|
| MCP connect | `serverInfo {name:"toon-client"}`; full `toon_*` tool list |
| `toon_identity` | EVM `0x2FDE64641a2c0F6CA08DF5dC2b342cBf2F479850`, `ready:true` |
| Faucet | HTTP 200 — 100 ETH + 10k USDC |
| `toon_publish_unsigned` (paid kind:1) | **FULFILL** — connector `HTTP/1.1 200 OK`, receipt `{"eventId":"b5d5702d…","amount":"1000","chain":"proxy"}` |
| event id | `b5d5702d7e441005c9ca3baabeb4eaad40c221164f35ffeb9fd76964ac20273b` |
| channelId | `0x00667aee…` (nonce 1, cumulativeAmount 1000) |
| `toon_read` | note read back, `id` matches ✅ |

Daemon log on a good boot:

```
[toon-clientd] listening on http://127.0.0.1:8787
[relay] connected to wss://relay-ws.devnet.toonprotocol.dev
[runner] injected apex negotiation for peer "store"
[runner] apex g.proxy.relay.store ready; channel (deferred — open on first write)
```

---

## 7. Devnet reference (explicit — the core preset is stale)

| What | Value |
|------|-------|
| Proxy ILP ingress | `https://proxy.devnet.toonprotocol.dev` (`POST /ilp`), dest `g.proxy.relay.store` |
| Relay (free reads) | `wss://relay-ws.devnet.toonprotocol.dev` |
| Faucet | `https://faucet.devnet.toonprotocol.dev` (`POST /api/request {address}`) |
| EVM RPC (Anvil, chainId 31337) | `https://evm-rpc.devnet.toonprotocol.dev` |
| USDC token (6 dp) | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| USDC TokenNetwork | `0xcafac3dd18ac6c6e92c921884f9e4176737c052c` |
| Connector EVM settlement (receive) addr | `0xC0E55cD2E967a4F625627DaE5d4946f54267C7ab` |

> Devnet addresses are redeployed when boxes are reset — if channel-open starts failing, re-check
> these against the current deployment before debugging your config.

---

## 8. Troubleshooting

- **"read-only / no write uplink configured"** → `proxyUrl` missing from config.
- **Channel never opens / "No RPC URL configured for chain evm:…"** → a settlement map key doesn't
  match `evm:anvil:31337` exactly, or `chainRpcUrls` is missing.
- **"Apex is still bootstrapping … retry"** → first call after start; retry in a few seconds.
- **`command not found` from Claude Desktop on Windows** → you bridged with bare `wsl toon-mcp`;
  switch to the `wsl bash -lic "exec toon-mcp"` form (sources nvm).
- **Publish paid but read times out** → confirm the daemon log shows `injected apex negotiation for
  peer "store"`; on `< 0.3.0` the paid path will not FULFILL — upgrade.
- The daemon log lives at `~/.toon-client/daemon.log` (or `$TOON_CLIENT_HOME/daemon.log`).
