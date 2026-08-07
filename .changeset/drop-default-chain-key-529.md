---
'@toon-protocol/client-mcp': patch
---

Remove the unreachable `defaultChainKey()` fallback from the daemon's PROXY-mode apex negotiation (#529).

`buildProxyApexNegotiation` returns early when no chain-family key is configured (`if (!chainKey) return undefined`), so `chainKey || defaultChainKey(chain, chainId)` could never evaluate its right-hand side. The dead branch nonetheless emitted the 3-part `evm:<network>:<chainId>` form that toon#165 removed in favour of the bare `evm:<chainId>` the live fleet and the x402 greeting use — so relaxing or moving that guard would have silently reintroduced the #165 chain-key mismatch, in a path no test could cover while it was unreachable.

No runtime behaviour changes. The emitted bundle does change: `tsup` inlines this module and kept the statically-referenced function, so `evm:devnet:${chainId}` was shipping to every Claude Desktop and Claude Code user and is now gone from `dist/`.
