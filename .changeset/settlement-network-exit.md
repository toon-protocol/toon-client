---
'@toon-protocol/client': major
---

Closing, settling and storing a channel go through its settlement network. `SettlementNetwork` gains `close(channel, now)`, `settle(channel, { due, now })`, `toStored` and `fromStored`, so a custom network must implement them. `client.channel.close()` and `settle()` ask each channel's network and return one result per channel as before, archived channels included; a channel on a network this client holds no key for is reported as that channel's error. `BatchChannelManager` now takes every network's stored form first: `new BatchChannelManager([evmStoredForm, solanaStoredForm], store)`. `ClientChannelFacade` takes `networks` in place of `evm` and `solana`. The exit helpers (`initiateEvmBatchWithdraw`, `requestSvmBatchClose`, the Solana instruction builders, …) moved into the adapters and are still exported; `requestSvmBatchClose` takes an optional `now`. The stored channel record, vouchers, exits and CLI output are unchanged.
