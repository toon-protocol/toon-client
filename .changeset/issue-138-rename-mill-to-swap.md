---
"@toon-protocol/client-mcp": minor
"@toon-protocol/views": minor
"@toon-protocol/client": patch
---

Rename legacy vocabulary: the swap-peer node concept is now consistently called "swap" across all packages (part of #134).

`SwapRequest.millPubkey` → `swapPubkey`, `SwapClaim.millSignerAddress` → `swapSignerAddress`, `TOON_MILL_PUBKEY` env var → `TOON_SWAP_PUBKEY`, ILP address segments updated (e.g. `g.townhouse.swap`), and all prose/doc references updated.
