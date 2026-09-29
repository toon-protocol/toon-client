---
'@toon-protocol/client': minor
---

Base deposits work with any ERC-20, and a wallet holding its own ETH can pay its own gas (#695).

- **Any ERC-20.** The client reads x402's `assetTransferMethod` from the connector's offer (`eip3009` or `permit2`); `depositMethod` overrides it. A Permit2 deposit needs Permit2 approved for the token first, and the client arranges that the cheapest way available:
  - **Permit token:** when the facilitator offers `eip2612GasSponsoring`, the payer's EIP-2612 permit rides inside the deposit.
  - **Plain ERC-20:** when the facilitator offers `erc20ApprovalGasSponsoring`, the payer signs `approve(Permit2, …)` without sending it, and the facilitator funds and broadcasts it.
  - **Otherwise:** the payer sends the approval once, from its own ETH.
- **Who pays: `depositGas` (`--deposit-gas`).**
  - `auto` (the default) uses the facilitator when there is one and it will relay the deposit. Otherwise the payer deposits directly from its own ETH: when there is no facilitator, when it is down, or when it refuses. This is safe because the same signed authorization is single-use on chain, so a deposit can never land twice.
  - `facilitator` never spends the payer's ETH.
  - `self` never contacts a facilitator.
- **Which facilitator.** Your `facilitatorUrl` comes first, then the one the connector names in its terms (`facilitator`), then the devnet default. `facilitatorUrl: ''` means none.
- **CLI.** `--deposit-gas` / `TOON_DEPOSIT_GAS` and `--deposit-method` / `TOON_DEPOSIT_METHOD`.
- **New exports** in `deposit-gas.ts`:
  - `evmWalletAccess`, `depositDirectly`, `approvePermit2`;
  - the collector-data encoders;
  - the two gas-sponsoring payload signers.
