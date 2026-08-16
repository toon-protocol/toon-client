---
'@toon-protocol/client-mcp': patch
---

A rolling swap that delivered nothing now says so — and names `rolling: "off"`.

`rolling: "auto"` falls back to the legacy path when the **RFQ** fails (no response, reject, nonce mismatch, undecodable). It has no answer for the other shape: an RFQ that *succeeds*, a session that *is* established, and then a fill that cannot be delivered. That is exactly what a maker with no return path to the sender produced — every default swap against it returned `F99 "leg B failed; fill not executed"`, `packetsAccepted: 0`, while the same swap with an explicit `rolling: "off"` settled on-chain. The caller was told the fill failed; it was never told the working path was one flag away.

This is **not** fixed with a silent retry, and deliberately so. Re-running a fill on the legacy path after a rolling attempt is precisely the shape that risks double-paying or double-delivering, and the withhold property (spec R5/R8) is what makes a failed rolling attempt free in the first place. So the result is made self-diagnosing instead: when every packet failed and nothing was collected, the `warning` now states that the swap delivered nothing, that it also cost nothing (no leg A revealed, no collectable claim), that this is **not** retried as legacy automatically and why, and that repeating the swap with `rolling: "off"` will settle it.

The underlying delivery defect is maker-side and fixed in `toon-protocol/swap#148`; this is the diagnosis a caller deserves whenever a rolling session is established and then cannot be filled.
