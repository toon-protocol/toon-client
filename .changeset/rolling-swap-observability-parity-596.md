---
'@toon-protocol/client-mcp': patch
---

The rolling swap path now carries the same observable surface as the legacy path: `timeoutMs`, `packets[]`, `errors[]` / `abortReason` / `LOCAL_SEND_FAILED`.

This is Stage 2a of [toon-meta#411](https://github.com/toon-protocol/toon-meta/issues/411): under [ADR 0003](https://github.com/toon-protocol/toon-meta/blob/main/docs/adr/0003-the-rolling-swap-is-the-only-swap.md) the legacy path goes away, so anything on it that a rolling `SwapResponse` did not already report would be silently **lost** the day Stage 4 lands — and lost from the diagnostics surface.

- **`timeoutMs`** now bounds the rolling fill loop: checked before every send and passed to `sendSwapPacket` as the remaining per-call budget. A deadline that elapses stops further packets from going out; the partial fill is reported exactly (`claims`, `cumulativeSource`/`cumulativeTarget`), with `abortReason: 'aborted'` and `state: 'stopped'`.
- **`packets[]`** carries one entry per accepted fill (`effectiveRate`, `rateDeviation`, and `rate`/`rateTimestamp` echoing that fill's own advance — not just the session quote), capped and truncation-flagged the same way as the legacy response.
- **`errors[]`** carries packets that threw before the maker ever answered (a transport/peer-resolution failure) — previously folded into `rejections[]` under a synthetic `T00` code, indistinguishable from a real maker "no". `code: 'LOCAL_SEND_FAILED'` is now reported when every failure was local, mirroring the legacy path.
- **`abortReason`** is now always set on a rolling response, mirroring the sdk's own `finalizeResult` rewrite rule: `'complete'` unless there were rejections and no local errors (`'all-rejected'`), or the loop was cut short by `timeoutMs` (`'aborted'`, which wins outright). A fully-local failure therefore carries the same diagnostic signature as the legacy path: `state: 'failed'` + `abortReason: 'complete'` + `packetsAccepted: 0` — read `errors[]` for why.

`SwapRequest.timeoutMs`'s doc comment now describes both paths (it previously described only `streamSwap`'s `AbortSignal`).

`toon_swap_claims` and `toon_swap_settle` are untouched — both were already path-agnostic. Nothing is removed; this is additive to the rolling path.

Field-by-field parity with the legacy `SwapResponse`: `accepted`, `packetsAccepted`, `claims`, `cumulativeSource`, `cumulativeTarget`, `state`, `code`/`message`, `warning`, `abortReason`, `packets`/`packetsTruncated`, `rejections`, `errors`, `realizedRate`, `minExchangeRate`, `claimsVerified`/`claimsRejected`/`valueReceived`, and `rolling` are all now populated on the rolling path exactly as on the legacy one.

Closes toon-client#596.
