---
'@toon-protocol/views': patch
---

Sort bound events by `created_at` before rendering so feeds are deterministically newest-first regardless of relay return order or how buffered + streamed events merge. Ties break on `id` for a stable order. Adds a per-bind `sort` option (`'desc'` default, `'asc'` opt-in) so threads can render replies oldest-first.
