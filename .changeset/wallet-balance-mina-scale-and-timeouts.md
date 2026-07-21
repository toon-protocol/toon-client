---
'@toon-protocol/client': patch
---

Two wallet-balance reader fixes.

**Mina settlement USDC is 6-decimal, not native MINA's 9.** `readMinaTokenBalance`
reported the custom settlement-token balance at `assetScale` 9 — nanomina's scale —
so a 50 USDC balance (`50_000000`) misdisplayed as `0.05`. TOON's settlement USDC is
6-decimal on every chain; the Mina custom-token amount is a raw u64, so it is now
scaled at 6 to match EVM and Solana. Native MINA is untouched and still reads at 9.

**Bound each wallet-balance request independently.** The multi-chain read wraps all
three chains in one `Promise.all` under a single outer bound, and the individual
reads had no per-request timeout — Node's global `fetch` (Solana/Mina) has none by
default — so one stalled socket hung the whole read and surfaced as "wallet balances
unavailable" with *no* chains at all. Each request is now bounded on its own (viem's
`timeout` + `retryCount` for EVM, an `AbortSignal` for the Solana/Mina `fetch`), so a
slow endpoint degrades only its own chain to `unreadable` and the others still
render. Env override `TOON_WALLET_RPC_TIMEOUT_MS` (default 8000; `0` disables).
