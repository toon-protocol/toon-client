---
"@toon-protocol/client": minor
"@toon-protocol/client-mcp": minor
---

BREAKING: removed the legacy hidden-service / Anyone-protocol (`.anyone` / SOCKS5h) transport overlay.

The canonical client payment path is now connector-as-proxy over ILP-over-HTTP (`ToonClient.h402Fetch`) with BTP/WebSocket as the duplex session transport. The `.anyone` SOCKS5h overlay is gone.

`@toon-protocol/client` (minor — pre-1.0 breaking):

- Removed exports: `startManagedAnonProxy`, `selectAnonAsset`, `ANON_VERSION`, `ANON_ASSETS`, `ManagedAnonProxy`, `StartManagedAnonProxyOptions`, `AnonAsset`, `isRoutableHsHostname`, `assertRoutableHsHostname`, `HS_HOSTNAME_REGEX`, `HS_HOSTNAME_MAX_LENGTH`, and the `ClientTransportConfig` type.
- Removed `ToonClientConfig` fields: `transport`, `managedAnonProxy`, `managedAnonSocksPort`.
- Removed modules: `transport/anon-proxy`, `transport/socks5`, `transport/hs-hostname`, `transport/gateway`, `transport/index` (transport resolution).
- Dropped the optional `socks-proxy-agent` dependency.

KEPT (unchanged): BTP/WebSocket transport, `h402Fetch` / ILP-over-HTTP, payment channels, balance-proof claim signing, and free relay reads.

`@toon-protocol/client-mcp` (minor): removed the `managedAnonProxy` / `socksProxy` config knobs, the `TOON_CLIENT_SOCKS` env override, the daemon-managed `.anyone` read proxy, and the `.anyone`-relay auto-detection. The daemon dials `btpUrl` / `relayUrl` directly. Dropped the optional `socks-proxy-agent` dependency.
