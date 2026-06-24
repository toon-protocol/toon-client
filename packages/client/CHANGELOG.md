# @toon-protocol/client

## 0.12.0

### Minor Changes

- 703dcd7: Route paid writes through the connector proxy (ILP-over-HTTP) and add devnet config + faucet helper.

  `@toon-protocol/client`:

  - **Transport-agnostic paid-write path.** `publishEvent`, `sendSwapPacket`, and `sendPayment` now route the ILP PREPARE + signed payment-channel claim through the ACTIVE ILP transport instead of hard-requiring a BTP socket. Selection mirrors `modes/http.ts`: the `runtimeClient` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured, else the BTP socket) is used when it implements `sendIlpPacketWithClaim`, with the BTP client as fallback. The old `NO_BTP_CLIENT` throw is replaced by a clearer `NO_ILP_TRANSPORT` error when no claim-capable transport is configured. BTP remains fully supported when it is the configured transport. All claim signing/construction is unchanged (claim validation stays connector-only).
  - **New config fields** `proxyUrl` and `faucetUrl` on `ToonClientConfig`. Setting `proxyUrl` (e.g. `https://proxy.devnet.toonprotocol.dev`) derives `connectorHttpEndpoint` (`…/ilp`) so writes route over ILP-over-HTTP, satisfies the `connectorUrl` requirement, and suppresses BTP-url auto-derivation (the proxy edge serves ILP-over-HTTP, not necessarily BTP). New `proxyIlpEndpoint()` helper.
  - **New `fundWallet(faucetUrl, address, chain)` faucet helper** (`faucet.ts`). EVM is implemented (`POST /api/request`, drips ETH + USDC); Solana/Mina throw a clear "deferred (WS3)" error.

  `@toon-protocol/client-mcp`:

  - Daemon config accepts `proxyUrl`/`faucetUrl` (env `TOON_CLIENT_PROXY_URL` / `TOON_CLIENT_FAUCET_URL`) and `TOON_CLIENT_DESTINATION`. A `proxyUrl` now satisfies the uplink requirement (`btpUrl` becomes optional) so the daemon can write through the proxy with no BTP socket. The destination stays configurable (e.g. `g.proxy` for devnet) and is NOT hardcoded as a global default.
  - Added `e2e/devnet.ts`: deployed-devnet endpoint constants + a `TOON_DEVNET_E2E`-gated `fundDevnetWallet()` step that funds the client wallet via the faucet helper before publishing. The normal unit suite never touches the network.

  The eventual home for the devnet endpoints is a `@toon-protocol/core` devnet preset (upstream npm release); they live here as explicit config until that ships.

- 4fa8019: Proxy-mode apex negotiation + per-chain payment-channel creation, enabling paid writes over the connector proxy `POST /ilp` without a BTP socket (issue #69).

  `@toon-protocol/client-mcp`:

  - **Proxy-mode apex negotiation (no BTP).** The daemon now populates the apex's `peerNegotiations` in proxy-only mode (`proxyUrl` set, no `btpUrl`) so `toon_publish` / `toon_open_channel` no longer fail with `Cannot resolve peer for destination: g.proxy`. The negotiation is sourced, in precedence order, from an explicit `apexChains[chain]` / `apex` block, then a negotiation synthesized from the flat settlement config (`settlementAddresses` / `tokenNetworks` / `preferredTokens`), then live `kind:10032` discovery off the relay. The connector's on-chain settlement (counterparty) address is REQUIRED to open a channel and is never fabricated — when it cannot be determined, the runner defers to relay discovery and surfaces the exact missing value via the apex `lastError`.
  - **Lazy, persisted channel open in proxy mode.** Bootstrap injects the negotiation and becomes ready WITHOUT opening the channel, so the wallet can be funded after the daemon starts (the fund → open → publish flow). The on-chain EVM channel is opened idempotently on the first `POST /channels` / paid write, then persisted for restart-resume. BTP mode keeps its historical eager open.
  - **Read-only daemon (no uplink).** `resolveConfig` no longer throws `No uplink configured`; a relay-only daemon starts and serves FREE reads. A write attempt without a proxy/BTP uplink is rejected at the control plane with an actionable "configure an uplink" error (`hasUplink`).

  `@toon-protocol/client`:

  - Paid writes route through the ACTIVE ILP transport selected in `modes/http.ts` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured) — no change to claim signing/construction. Payment-claim validation stays connector-only.

  Validated live against the deployed devnet (Anvil chain 31337): the daemon negotiates in proxy mode, funds via the faucet, opens + deposits into an on-chain payment channel against the connector's settlement address, signs a balance-proof claim, and sends it over `POST /ilp`. The connector accepts the HTTP transport and returns a structured ILP response.

- fed33cb: BREAKING: removed the legacy hidden-service / Anyone-protocol (`.anyone` / SOCKS5h) transport overlay.

  The canonical client payment path is now connector-as-proxy over ILP-over-HTTP (`ToonClient.h402Fetch`) with BTP/WebSocket as the duplex session transport. The `.anyone` SOCKS5h overlay is gone.

  `@toon-protocol/client` (minor — pre-1.0 breaking):

  - Removed exports: `startManagedAnonProxy`, `selectAnonAsset`, `ANON_VERSION`, `ANON_ASSETS`, `ManagedAnonProxy`, `StartManagedAnonProxyOptions`, `AnonAsset`, `isRoutableHsHostname`, `assertRoutableHsHostname`, `HS_HOSTNAME_REGEX`, `HS_HOSTNAME_MAX_LENGTH`, and the `ClientTransportConfig` type.
  - Removed `ToonClientConfig` fields: `transport`, `managedAnonProxy`, `managedAnonSocksPort`.
  - Removed modules: `transport/anon-proxy`, `transport/socks5`, `transport/hs-hostname`, `transport/gateway`, `transport/index` (transport resolution).
  - Dropped the optional `socks-proxy-agent` dependency.

  KEPT (unchanged): BTP/WebSocket transport, `h402Fetch` / ILP-over-HTTP, payment channels, balance-proof claim signing, and free relay reads.

  `@toon-protocol/client-mcp` (minor): removed the `managedAnonProxy` / `socksProxy` config knobs, the `TOON_CLIENT_SOCKS` env override, the daemon-managed `.anyone` read proxy, and the `.anyone`-relay auto-detection. The daemon dials `btpUrl` / `relayUrl` directly. Dropped the optional `socks-proxy-agent` dependency.

### Patch Changes

- 94b83dd: Fix `ToonClient.publishEvent` to send the HTTP `POST /write` store envelope on the payment-proxy path.

  The deployed connector is a payment-proxy that terminates paid writes as HTTP-in-ILP: it decodes the ILP PREPARE `data` as a literal HTTP/1.1 request and reverse-proxies it to the relay store's `POST /write`. `publishEvent` previously sent the bare TOON-encoded event as `data`, which has no request-line, so the proxy rejected every paid write with `F01 - Invalid HTTP envelope: malformed request-line`. The high-level `publishEvent` / daemon `/publish` / `uploadMedia` / blob-storage paths (which all funnel through `publishEvent`) were therefore broken against the live store.

  `publishEvent` now wraps the signed event in a `POST /write HTTP/1.1` envelope carrying `{"event": <signed event object>}` as the JSON body (the shape the store's `/write` handler verifies and stores). A shared `buildStoreWriteEnvelope` helper is exported from `@toon-protocol/client`. The TOON encoding is still used to price the write; `sendSwapPacket` (Mill swaps, a raw-TOON contract) is intentionally left unwrapped.

  Also fixes the `client-mcp` `e2e/devnet.ts` apex destination: `g.proxy` F02s ("No route"); the routable store address is `g.proxy.relay.store`.

## 0.11.0

### Minor Changes

- b539273: Add payment-aware HTTP fetch (h402).

  `ToonClient.h402Fetch(url, opts)` is a `fetch()`-like method that makes paying for an HTTP resource transparent: it issues the request, and on `402 Payment Required` parses the x402 `accepts` array, selects the `toon-channel` entry, opens or reuses a payment channel via `ChannelManager`, and sends the raw HTTP request as a transparent HTTP-in-ILP packet to `POST /ilp` via `HttpIlpClient` (claim in the `ILP-Payment-Channel-Claim` header). The FULFILL bytes are reconstructed into a standard Web `Response`, so the caller never sees ILP. When no `toon-channel` entry is offered it surfaces the vanilla x402 challenge unchanged. Transport selection (HTTP vs BTP upgrade) is driven by `selectIlpTransport`; full duplex response streaming is a documented v1 limitation. New `Http402Client` adapter holds the reusable x402-parsing and HTTP-in-ILP framing logic.

  `@toon-protocol/client-mcp` exposes this as the `toon_http_fetch_paid` MCP tool (inputs `{ url, method?, headers?, body?, timeout? }`), routed through the `toon-clientd` control plane (`POST /http-fetch-paid`) to `ToonClient.h402Fetch`, returning `{ status, headers, body }`.

## 0.10.0

### Minor Changes

- 7c4a34d: Add an ILP-over-HTTP (RFC-0035) client transport. `HttpIlpClient` sends one-shot writes via `POST /ilp` (OER PREPARE body, `ILP-Payment-Channel-Claim` header carrying the same claim bytes as the BTP path) and parses the FULFILL/REJECT from the 200 response, with an `upgradeToBtp()` path that opens a `btp`-subprotocol WebSocket carrying HTTP-proven identity. `initializeHttpMode` now selects `HttpIlpClient` when a connector advertises an HTTP endpoint (via the new `connectorHttpEndpoint` / `connectorSupportsUpgrade` config) and falls back to BTP otherwise. Backward compatible: with no HTTP endpoint configured, behavior is unchanged.
