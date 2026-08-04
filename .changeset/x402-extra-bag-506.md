---
"@toon-protocol/client": minor
---

Surface the x402 `accepts[0].extra` bag — starting with `session_lease_ttl_ms` (connector#722) — on `ToonChannelAccept`/`ParsedX402Challenge`, so a caller can read it via `parseX402Body`/`parseX402Challenge` or, after a call to `ToonClient.h402Fetch`, via the new `ToonClient.getLastX402Terms()`. `extra` is an open bag: unknown keys survive, and it is `undefined` — not a default — when the peer sends none.
