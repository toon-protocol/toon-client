---
'@toon-protocol/client': major
---

The payer pays through a settlement network: one adapter per network, which opens, covers and reads its channels and holds its voucher scheme (the voucher signature, the claim and the claim-state challenge). `BatchSettlementPayerConfig` loses `evm`, `solana` and `fetch`, and takes `networks: SettlementNetwork[]` instead. Build them with `evmSettlementNetwork({ account, rpc, fetch, … })` or `new EvmSettlementNetwork({ account, reader, wallet, fetch, … })` for Base, and `new SolanaSettlementNetwork({ signer, rpc, fetch, connector })` for Solana; the options that were under `evm` and `solana` move onto them unchanged. Vouchers, claims, challenges, deposits and CLI output are unchanged.
