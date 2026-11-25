---
'@toon-protocol/client': major
---

Every chain RPC path goes through the settlement network. `client.wallet.balances()` and `transfer()` reach each chain through that chain's network, over the same route the client pays on, and behave as before. A network now hands out its RPC client: `EvmSettlementNetwork.rpc` (`EvmRpc`, built by `evmSettlementNetwork`) and `SolanaSettlementNetwork.rpc` (`SolanaRpcClient`).

Breaking:

- `readWalletBalances`, `readEvmNativeBalance`, `readEvmTokenBalance`, `readSolanaNativeBalance`, `readSolanaTokenBalance` and `sendTransfer` take a network's RPC client (`rpc`, or `client` for the two EVM reads) in place of `rpcUrl` and a fetch (`evmRpcFetch`, `fetchImpl`, `rpcFetch`, `solanaProxied`). `EvmTransferConfig` takes `rpc` in place of `rpcUrl` and `signer`.
- The per-chain helpers only the adapters need are no longer exported from the package root: channel config and id (`buildBatchChannelConfig`, `batchChannelId`, …), deposits (`buildEip3009Deposit`, `buildPermit2Deposit`, `settleDeposit`, `approvePermit2`, `depositDirectly`, `evmWalletAccess`, the gas-sponsoring helpers), vouchers, claims and challenges (`signBatchVoucher`, `signSvmVoucher`, `evmVoucherClaim`, `solanaVoucherClaim`, `signEvmChallenge`, `signSolanaChallenge`, …), chain reads (`readEvmBatchChannel`, `getSvmBatchChannel`, `decodeSvmBatchChannel`), the sponsored open (`buildSponsoredOpen`, `requestSponsoredOpen`) and the exit helpers (`initiateEvmBatchWithdraw`, `finalizeEvmBatchWithdraw`, `requestSvmBatchClose`, `withdrawSvmBatchChannel`, the Solana instruction builders). Open, pay, close and settle through a settlement network instead.

Vouchers, claims, deposits, exits, the stored channel record and CLI output are unchanged.
