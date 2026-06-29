---
'@toon-protocol/client-mcp': patch
'@toon-protocol/views': patch
---

Make pay-to-write consent truthful and specific, and survive non-rendering hosts.

- **Truthful fee:** `PublishResponse`/`UploadMediaResponse` now carry `feePaid` (the amount actually charged — uploads sum both the blob and reference-event legs) and `channelBalanceAfter`. The `pay-confirm` receipt shows the real fee + remaining balance instead of re-reading the per-event estimate, and the confirm step warns the write is permanent.
- **Specific spendy consent:** the in-iframe consent modal (used by upload/swap/channel ops) reads `toon_status` and surfaces the settlement chain, the pay-to-write fee (for per-event writes), and an explicit non-refundable / irreversible warning — no more bare label.
- **Cross-surface consent:** server `instructions` and the paid-write tool descriptions now direct a text-only host to quote the exact fee via `toon_status` and confirm the irreversible write before calling.
