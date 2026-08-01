---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Fix #485: `ToonClient.getDefaultChainContext()` always picked
`supportedChains[0]`, ignoring any explicitly configured settlement chain. On
a multi-chain devnet announce this silently pinned a daemon configured for
`evm` (`TOON_CLIENT_CHAIN=evm`) to Solana whenever Solana happened to sort
first (buzz#47), leaving self-serve onboarding on a chain the user didn't
choose and may have no gas on.

`ToonClientConfig` gains an optional `preferredChain` field (`'evm' |
'solana' | 'mina'`). When set, `getDefaultChainContext()` and the lightweight
bootstrap-fallback chain negotiation (`ToonClient.matchNegotiatedChain`, the
same one-line `X.find(...) ?? X[0]` pattern) now honor it — matching by chain
family regardless of `supportedChains` array order — and throw a clear
`CHAIN_NOT_SUPPORTED` error naming both the configured chain and the
available chains when no match exists, instead of silently substituting a
different one. Leaving `preferredChain` unset keeps the previous
`supportedChains[0]` fallback unchanged.

`@toon-protocol/client-mcp`'s daemon config now threads the resolved
`TOON_CLIENT_CHAIN` env var / `chain` config file field into
`toonClientConfig.preferredChain` — but only when it was actually set
explicitly, distinct from the `chain` variable's own silent `'evm'` default
used for apex-negotiation selection — so an unconfigured daemon keeps the
legacy fallback behavior.
