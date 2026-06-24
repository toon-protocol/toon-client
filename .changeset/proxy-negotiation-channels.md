---
"@toon-protocol/client-mcp": minor
"@toon-protocol/client": minor
---

Proxy-mode apex negotiation + per-chain payment-channel creation, enabling paid writes over the connector proxy `POST /ilp` without a BTP socket (issue #69).

`@toon-protocol/client-mcp`:

- **Proxy-mode apex negotiation (no BTP).** The daemon now populates the apex's `peerNegotiations` in proxy-only mode (`proxyUrl` set, no `btpUrl`) so `toon_publish` / `toon_open_channel` no longer fail with `Cannot resolve peer for destination: g.proxy`. The negotiation is sourced, in precedence order, from an explicit `apexChains[chain]` / `apex` block, then a negotiation synthesized from the flat settlement config (`settlementAddresses` / `tokenNetworks` / `preferredTokens`), then live `kind:10032` discovery off the relay. The connector's on-chain settlement (counterparty) address is REQUIRED to open a channel and is never fabricated — when it cannot be determined, the runner defers to relay discovery and surfaces the exact missing value via the apex `lastError`.
- **Lazy, persisted channel open in proxy mode.** Bootstrap injects the negotiation and becomes ready WITHOUT opening the channel, so the wallet can be funded after the daemon starts (the fund → open → publish flow). The on-chain EVM channel is opened idempotently on the first `POST /channels` / paid write, then persisted for restart-resume. BTP mode keeps its historical eager open.
- **Read-only daemon (no uplink).** `resolveConfig` no longer throws `No uplink configured`; a relay-only daemon starts and serves FREE reads. A write attempt without a proxy/BTP uplink is rejected at the control plane with an actionable "configure an uplink" error (`hasUplink`).

`@toon-protocol/client`:

- Paid writes route through the ACTIVE ILP transport selected in `modes/http.ts` (the `HttpIlpClient` `POST /ilp` proxy transport when a `proxyUrl`/`connectorHttpEndpoint` is configured) — no change to claim signing/construction. Payment-claim validation stays connector-only.

Validated live against the deployed devnet (Anvil chain 31337): the daemon negotiates in proxy mode, funds via the faucet, opens + deposits into an on-chain payment channel against the connector's settlement address, signs a balance-proof claim, and sends it over `POST /ilp`. The connector accepts the HTTP transport and returns a structured ILP response.
