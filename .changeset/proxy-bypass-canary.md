---
'@toon-protocol/client': minor
---

A hidden payer (`socksProxy` set) now proves its proxy before it starts. `ToonClient.create` sends a loopback canary down the client edge, EVM RPC, Solana RPC and BTP paths, and throws the new `ProxyBypassError` (`code: 'PROXY_BYPASS'`, `path`) if any path ignores its proxy hook. EVM RPC now goes through viem's `fetchFn`, so the viem dependency floor rises to `^2.37.2`.

**Breaking, for callers of the chain-RPC helpers:**
- `rpcTransport(url, fetchFn)` takes a proxied `fetch` where it took a dispatcher.
- `readEvmNativeBalance`, `readEvmTokenBalance`, `readWalletBalances` and `EvmTransferConfig` take `evmRpcFetch` (a proxied `fetch`) where they took `rpcDispatcher`. An `rpcDispatcher` still passed is ignored, and that RPC dials clearnet: rename it.
- `ProxiedChainRpc` no longer carries `dispatcher`, and `HiddenServiceTransport` gains `canaryHits()`.
