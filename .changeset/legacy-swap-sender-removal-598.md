---
'@toon-protocol/client-mcp': minor
---

Stage 4 of [toon-meta#411](https://github.com/toon-protocol/toon-meta/issues/411) (ADR 0003): **the client stops sending legacy swaps.** `ClientRunner.swap` now has one body — the rolling path. A maker that does not establish a rolling session fails the call with `RollingUnavailableError` / HTTP 502 `rolling_unavailable`; there is no downgrade left to fall back to.

**Breaking `SwapRequest` changes:**

- `rolling` (`'auto' | 'off' | 'require'`) is **removed**. Rolling was the only reachable behavior since toon-client#595 (`'require'` was already the default); `'auto'`/`'off'` had nothing left to select once the legacy sender was deleted, so the knob is gone rather than reduced to a single value. A caller that was passing `rolling: 'require'` needs no change (drop the field); a caller passing `'auto'`/`'off'` was already opting into legacy — that path no longer exists and the call now runs rolling unconditionally, or throws `RollingUnavailableError` naming the maker and the reason.
- `controller` (`SwapControllerParams`, the adaptive δ/W controller) is **removed**, per the drop decision recorded on toon-client#597: rolling's per-packet re-quote + verify-before-reveal already bounds the risk δ existed to bound, and the strictly sequential fill loop pins W at 1. `createSwapController`, `AdaptiveDeltaController`/`JsonFileSwapControllerStateStore` wiring, and `SwapDefaultsConfig.controller` / `ResolvedDaemonConfig.swapControllerStatePath` are all removed with it. `packetCount` (the static split) is unaffected — it is unchanged on the rolling path.
- `SwapResponse.rolling` (`SwapRollingInfo`) drops `fallbackReason`/`fallbackMessage` — they were only ever populated on the deleted fallback path. `used` is now always `true` on any successful response (a failed negotiation throws instead of reporting `used: false`).
- `SwapDefaultsConfig.rolling` is **removed** for the same reason as the per-request field.
- `streamSwap` (from `@toon-protocol/sdk/swap`) is no longer imported anywhere in this package.

`toon_swap`'s MCP tool schema drops the `rolling` input property to match. `toon_swap_claims` / `toon_swap_settle` are untouched.

`swap-wire-compat.test.ts` and the legacy-path runner suites are removed with the code they covered; the receive-side claim-ingestion, floor and observability cases they reached through the legacy sender are ported onto the rolling wire rather than dropped. Still outstanding, and NOT part of this change: a live devnet swap settling on chain from the built client, needed as evidence on toon-client#598 before that issue can close.
