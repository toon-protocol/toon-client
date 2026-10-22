---
'@toon-protocol/client': minor
---

A chain RPC call site can no longer compile without the fetch it should use. The client decides each chain's route once, in its chain-access layer, as a `{ url, fetch }` whose `fetch` is required; no internal layer below it falls back to the global `fetch`. A hidden payer with `proxyRpc: false` still dials directly, now chosen visibly at that one point. With no `socksProxy`, Solana wallet reads and Solana channel RPC both use the client's `config.fetch`.

**Breaking, for callers of `rpcTransport`:** it now takes a route, `rpcTransport({ url, fetch, proxied? }, options)`, where it took `(url, fetchFn | undefined, options)`. Pass `directFetch` (newly exported) for a direct route. `ChainRpcRoute` is exported too.

**Breaking, for direct users of `BatchSettlementPayer`:** `BatchSettlementPayerConfig.fetch`, which reaches the facilitator and the connector's sponsor endpoint, is now required. Pass `directFetch` for the old default.

The other exported helpers (`readWalletBalances`, `sendTransfer`, `settleDeposit`, `requestSponsoredOpen`, `facilitatorExtensions`, …) keep their signatures and still default to the global `fetch` for direct callers; the EVM wallet and transfer configs gain an optional `proxied` flag.
