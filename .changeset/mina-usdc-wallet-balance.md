---
"@toon-protocol/client": patch
---

`getWalletBalances` (→ `rig balance`) now reads the Mina settlement **token**
balance (USDC), not just native MINA.

The Mina channels are denominated in a custom token, so a token balance needs
the `tokenId`. `getWalletBalances` now threads `config.minaChannel.tokenId`
(derived from the announce/core preset by the rig, or set explicitly) into the
balance read, and `WalletBalanceReader` reads it via the GraphQL
`account(publicKey, token)` query. Because that query's `TokenId` scalar rejects
the decimal Field form, a small self-contained encoder converts it to the base58
`TokenId` (matching o1js `TokenId.toBase58`, without pulling in o1js). A fresh
client with no explicit `config.minaChannel` therefore shows its Mina USDC
balance once the derived channel carries a tokenId. Native MINA is still
reported; both reads are independent and best-effort.
