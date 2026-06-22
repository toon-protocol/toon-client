# @toon-protocol/client-mcp

## 0.2.0

### Minor Changes

- b539273: Add payment-aware HTTP fetch (h402).

  `ToonClient.h402Fetch(url, opts)` is a `fetch()`-like method that makes paying for an HTTP resource transparent: it issues the request, and on `402 Payment Required` parses the x402 `accepts` array, selects the `toon-channel` entry, opens or reuses a payment channel via `ChannelManager`, and sends the raw HTTP request as a transparent HTTP-in-ILP packet to `POST /ilp` via `HttpIlpClient` (claim in the `ILP-Payment-Channel-Claim` header). The FULFILL bytes are reconstructed into a standard Web `Response`, so the caller never sees ILP. When no `toon-channel` entry is offered it surfaces the vanilla x402 challenge unchanged. Transport selection (HTTP vs BTP upgrade) is driven by `selectIlpTransport`; full duplex response streaming is a documented v1 limitation. New `Http402Client` adapter holds the reusable x402-parsing and HTTP-in-ILP framing logic.

  `@toon-protocol/client-mcp` exposes this as the `toon_http_fetch_paid` MCP tool (inputs `{ url, method?, headers?, body?, timeout? }`), routed through the `toon-clientd` control plane (`POST /http-fetch-paid`) to `ToonClient.h402Fetch`, returning `{ status, headers, body }`.
