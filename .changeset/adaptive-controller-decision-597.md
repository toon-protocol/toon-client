---
'@toon-protocol/client-mcp': patch
---

Stage 2b of [toon-meta#411](https://github.com/toon-protocol/toon-meta/issues/411): decided, on the record, to **drop** the adaptive δ/W controller rather than port it to the rolling swap path.

No behavior changes — `controller`/`packetCount` already stayed on the legacy path (toon-client#585) and continue to until Stage 4 removes it. This documents the decision at the code sites a future reader (and Stage 4's PR) will land on:

- **δ** (packet size) bounded exposure to a stale quote on the legacy protocol, where a FULFILL commits before verification. Rolling re-prices every packet at a fresh `R_i` and verifies it BEFORE leg A reveals (spec R5/R8) — a mispriced packet is withheld, never partially executed, so there is nothing left for δ to bound. Packet size in the end state is bounded by the maker's advertised `maxAmount` (kind:20034) and the hard floor.
- **W** (in-flight window) bounded timing/liveness risk across concurrently-outstanding packets. The rolling fill loop is, and stays, strictly sequential (toon-client#596) — W is fixed at 1 in the end state, so porting a knob that can never move is dead configuration surface.

`createSwapController` and its options are removed in Stage 4 (toon-client#598), not here — this issue is the rationale that PR cites. `docs/rolling-swap.md` §6 needs a corresponding note in toon-meta (tracked separately; this repo has no copy of that file to edit).

Closes toon-client#597.
