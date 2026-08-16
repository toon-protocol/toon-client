---
'@toon-protocol/client-mcp': patch
---

The silent legacy fallback becomes a loud, named failure: `rolling` defaults to `"require"`.

Since toon-client#585 `toon_swap` probed every maker with a kind:20033 RFQ and, on **any** non-quote outcome, ran the swap on the legacy path instead — silently and totally, by design, because legacy was what worked against the deployed maker. [ADR 0003](https://github.com/toon-protocol/toon-meta/blob/main/docs/adr/0003-the-rolling-swap-is-the-only-swap.md) makes that the wrong end state: the deployed maker is rolling-capable, and a maker that quietly stops answering would degrade every caller to verify-**after**-commit against an unbounded held price with uncoupled legs, with nobody noticing. This is Stage 1 of [toon-meta#411](https://github.com/toon-protocol/toon-meta/issues/411), and it removes nothing — the legacy sender is untouched and the change is one default.

`swapDefaults.rolling` (and the per-request `rolling`) now defaults to `'require'`. A maker that does not establish a session fails the call with `RollingUnavailableError` → HTTP **502 `rolling_unavailable`** (a counterparty fault, not a 400), carrying the maker's pubkey, its ILP address, the reason discriminator (`rejected`, `no-response`, `not-a-quote`, `nonce-mismatch`, `send-failed`, `no-sender-address`, `controller`) and the underlying diagnosis — as structured fields *and* in the message, so a stranded caller meets a diagnosis rather than a downgrade. `toon_swap` surfaces it as JSON with a hint that the legacy remedies are a **paid, weaker retry** to ask the user about, not a free one.

Both escape hatches survive this stage and neither is silent any more. `rolling: 'auto'` still probes and falls back, and `rolling: 'off'` still skips the probe entirely — the move toon-client#592's own diagnosis points at when a rolling fill cannot be *delivered* (swap#148, maker-side, still open). `'off'` previously left **no** `rolling` block on the response at all, so a legacy swap was indistinguishable from a rolling one downstream; it now reports `fallbackReason: 'off'`, and every legacy run — from either hatch — also raises a `warning` naming the path it took and why. Both go away with the legacy sender in Stage 4 (toon-client#598).

The RFQ probe itself is unchanged, and a missing `swapVerifyingContracts` in the maker's announce remains its own hard reject (`MISSING_SWAP_VERIFYING_CONTRACT`), not a fallback trigger.
