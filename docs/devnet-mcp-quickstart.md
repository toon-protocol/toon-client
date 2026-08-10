# Devnet quickstart — paid post to the relay from Claude

Connect **Claude Desktop** or **Claude Code** to the `toon-mcp` MCP server and publish a **paid**
`kind:1` note that round-trips through the public devnet: the connector pays-to-write over
ILP-over-HTTP, returns a FULFILL, and you read the note back for free over the Nostr relay.

This is the **proxy-mode devnet** path. The package [README](../packages/client-mcp/README.md)
covers generic install, the daemon, and BTP-mode config; this doc adds only what the public devnet
needs — the endpoints, funding, and the Windows/WSL bridge.

> **Verified end-to-end on 2026-06-23** against the deployed Linode devnet: a paid `kind:1` publish
> FULFILLed (connector `HTTP/1.1 200 OK` store receipt) and was read back through `toon_read`. See
> [§6 Proof](#6-proof).

---

## 1. Install the MCP server

Install `@toon-protocol/client-mcp@latest`. Anything older than `0.21.0` predates the sealed wire
(#450) and sends an all-zero execution condition that today's connector rejects outright, so it
cannot complete a paid write at all — always take `@latest` rather than pinning.

> Note: npm also carries `0.26.2`–`0.34.3`. Despite the higher numbers those are **older and
> non-functional** — an orphaned line from the pre-extraction `toon-protocol/town` monorepo, since
> deprecated. The live line runs `0.1.0` → `0.21.3` → `0.35.0` and up. See #477.

A global install is the simplest path:

```bash
pnpm add -g @toon-protocol/client-mcp     # installs the toon-mcp + toon-clientd bins
toon-mcp --version                        # sanity check the bin resolves
```

<details>
<summary>Build from source instead (for local development)</summary>

```bash
cd <path-to>/toon-client
git checkout main && git pull --ff-only origin main
pnpm install
pnpm -r build
ls -l packages/client-mcp/dist/mcp.js     # the MCP server entry
```

A source build's server entry is `<path-to>/toon-client/packages/client-mcp/dist/mcp.js`; use
`node <that-path>` anywhere this doc uses the `toon-mcp` bin.
</details>

---

## 2. The known-good devnet config (`~/.toon-client/config.json`)

The daemon reads `~/.toon-client/config.json` automatically (override the dir with
`TOON_CLIENT_HOME`). With this file present you need **no env vars at all**, which is what keeps the
Windows/WSL bridge in §3 trivial.

> Updated 2026-08-10 (issue #536): the relay (`g.toon.relay`) and the store (`g.toon.ario`) are now
> two INDEPENDENT connectors that do not forward for each other, and the devnet's old
> `g.proxy.*` addressing is gone. The `destination: g.proxy.relay.store` pin this doc used to show
> routes to neither box on the current deployment (confirmed live: all three devnet connectors
> 404 it).
> Leave `destination` **unset** instead — `@toon-protocol/core`'s genesis peer seed supplies both
> addresses, and the daemon auto-registers a SECOND uplink for the store from the seed's own
> `btpEndpoint` so writes and uploads route correctly without any settlement maps to hand-maintain:

```json
{
  "network": "devnet",
  "proxyUrl": "https://proxy.devnet.toonprotocol.dev",
  "faucetUrl": "https://faucet.devnet.toonprotocol.dev",
  "relayUrl": "wss://relay-ws.devnet.toonprotocol.dev",
  "chain": "evm",
  "feePerEvent": "1000",
  "httpPort": 8787,
  "chainRpcUrls": { "evm:84532": "https://sepolia.base.org" }
}
```

You supply the **identity** separately (§4) — either let the daemon auto-generate an encrypted
keystore on first run, or add a `"mnemonic"` field / set `TOON_CLIENT_MNEMONIC`.

### Why each field matters (so you can debug)

- `proxyUrl` → routes paid writes through the connector's `POST /ilp` (ILP-over-HTTP); **no BTP
  socket needed**. Omit it and tools report *"read-only — no write uplink configured."*
- No `destination` → the daemon defaults it (and `publishDestination`/`storeDestination`/
  `storeBtpUrl`) from `@toon-protocol/core`'s genesis peer list: relay writes go to `g.toon.relay`
  over the config-seeded default uplink, and store uploads go to `g.toon.ario` over a SECOND
  uplink the daemon opens automatically to the store's own `btpEndpoint`. A good boot logs BOTH:
  `injected apex negotiation for peer "relay"` and `injected apex negotiation for peer "ario"`, and
  `GET /targets` lists two `apexes` entries. Settlement params for each are read live off the
  relay's `kind:10032` announcements — no settlement maps to synthesize by hand anymore (the old
  `evm:anvil:31337` maps this doc used to show were the stale-preset workaround for that; the live
  devnet now negotiates chain `evm:84532`, Base Sepolia, directly).
- `chainRpcUrls` — still required for on-chain balance reads / channel funding math (chain
  `evm:84532`, keyed by the **exact** chainKey — the network label is cosmetic, only the chainId +
  RPC matter). The devnet's own `evm-rpc.devnet.toonprotocol.dev` no longer answers (TLS handshake
  failure, confirmed live 2026-08-10); use the public Base Sepolia RPC above instead. Drop this and
  balance reads fail with *"the on-chain provider stalled"*.
- `feePerEvent: "1000"` — base units paid per write (1000 = 0.001 USDC at 6 dp); `"1"` also works.

Everything above also has an env override (`TOON_CLIENT_PROXY_URL`, `TOON_CLIENT_RELAY_URL`,
`TOON_CLIENT_FAUCET_URL`, `TOON_CLIENT_HOME`, …) except `chainRpcUrls`, which is config-file-only —
the devnet needs this file regardless.

> The rest of this doc (§4 funding, §6 proof) predates issue #536 and was **not** re-verified in
> this pass beyond what's noted above. In particular, §4's faucet request shape has since changed —
> confirmed live 2026-08-10: `POST /api/base-sepolia/request` now drips 1000 USDC only; the ETH leg
> is `"skipped": true, "reason": "ETH drip disabled (amount 0)"`, so a brand-new wallet has no gas
> for its first on-chain channel-open. §4/§6 need their own follow-up pass — treat them as
> historical until then.

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
| Proxy ILP ingress | `https://proxy.devnet.toonprotocol.dev` (`POST /ilp`), relay dest `g.toon.relay` |
| Store (Arweave uploads, separate box, #536) | dest `g.toon.ario`, btp `wss://proxy.ario.devnet.toonprotocol.dev/ilp/btp` — auto-registered, no config needed |
| Relay (free reads) | `wss://relay-ws.devnet.toonprotocol.dev` |
| Faucet | `https://faucet.devnet.toonprotocol.dev` (`POST /api/base-sepolia/request {address}`, USDC only — see §2 note) |
| EVM RPC (Base Sepolia, chainId 84532) | `https://sepolia.base.org` |
| USDC token (6 dp) | `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` |

> Settlement addresses (per-connector on-chain receive addr, TokenNetwork, …) are no longer listed
> here — since #536 they're negotiated LIVE off each connector's own `kind:10032` announcement
> (§2), so a config file never needs to hardcode them. Devnet addresses are redeployed when boxes
> are reset — if channel-open starts failing, re-check the live announcements before debugging your
> config.

---

## 8. Troubleshooting

- **"read-only / no write uplink configured"** → `proxyUrl` missing from config.
- **Balance reads fail with "the on-chain provider stalled"** → `chainRpcUrls` is missing or points
  at a dead RPC (the old `evm-rpc.devnet.toonprotocol.dev` no longer answers — use
  `https://sepolia.base.org` for `evm:84532`, per §2).
- **"The connector terminates no store route for …"** → you set an explicit `destination` (old
  single-apex convention); remove it and let the genesis defaults populate `storeBtpUrl`
  automatically (§2), or set `storeBtpUrl` yourself to the store's own `btpEndpoint`.
- **"Apex is still bootstrapping … retry"** → first call after start; retry in a few seconds.
- **`command not found` from Claude Desktop on Windows** → you bridged with bare `wsl toon-mcp`;
  switch to the `wsl bash -lic "exec toon-mcp"` form (sources nvm).
- **Publish paid but read times out** → confirm the daemon log shows `injected apex negotiation for
  peer "relay"` (and, once you touch uploads, `peer "ario"` too). On anything older than `0.21.0`
  the paid path will not FULFILL (pre-sealed-wire) — upgrade to `@latest`.
- The daemon log lives at `~/.toon-client/daemon.log` (or `$TOON_CLIENT_HOME/daemon.log`).
