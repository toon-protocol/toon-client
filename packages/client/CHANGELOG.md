# @toon-protocol/client

## 0.10.0

### Minor Changes

- 7c4a34d: Add an ILP-over-HTTP (RFC-0035) client transport. `HttpIlpClient` sends one-shot writes via `POST /ilp` (OER PREPARE body, `ILP-Payment-Channel-Claim` header carrying the same claim bytes as the BTP path) and parses the FULFILL/REJECT from the 200 response, with an `upgradeToBtp()` path that opens a `btp`-subprotocol WebSocket carrying HTTP-proven identity. `initializeHttpMode` now selects `HttpIlpClient` when a connector advertises an HTTP endpoint (via the new `connectorHttpEndpoint` / `connectorSupportsUpgrade` config) and falls back to BTP otherwise. Backward compatible: with no HTTP endpoint configured, behavior is unchanged.
