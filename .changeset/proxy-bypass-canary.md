---
'@toon-protocol/client': minor
---

A hidden payer (`socksProxy` set) now proves its proxy before it starts. `ToonClient.create` sends a loopback canary down the client edge, EVM RPC, Solana RPC and BTP paths, and throws the new `ProxyBypassError` (`code: 'PROXY_BYPASS'`, `path`) if any path ignores its proxy hook. EVM RPC now goes through viem's `fetchFn`, so the viem dependency floor rises to `^2.37.2`.
