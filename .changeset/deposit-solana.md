---
"@toon-protocol/client": patch
"@toon-protocol/client-mcp": patch
---

Solana channel deposit (PR B.1).

Extract `depositSolanaChannel` from the open flow's post-init `deposit`
instruction and wire it into `OnChainChannelClient.depositToChannel` so
`toon_channel_deposit` now works on Solana (incremental: the new total is the
tracked current plus the delta). EVM was added in PR B; Mina deposit (o1js)
remains a follow-up. No daemon/views changes — that layer is chain-agnostic.
