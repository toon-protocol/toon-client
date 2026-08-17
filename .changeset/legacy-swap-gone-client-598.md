---
'@toon-protocol/client': minor
---

**The legacy swap path is gone: TOON speaks the rolling swap protocol only** (Stage 4 of [toon-meta#411](https://github.com/toon-protocol/toon-meta/issues/411), ADR 0003, toon-client#598).

This package's own API is **unchanged** — the swap primitives here (`sendSwapPacket`, `sendRollingRfq`, `handleRollingAdvance`, `ingestAndReveal`, `buildSwapSettlements`) are shared by the RFQ probe and every rolling fill, and none of them was legacy-only. The minor bump marks the protocol boundary the surrounding client now enforces, so a consumer pinning this package can tell which side of it they are on.

**What changes for a caller.** The TOON client no longer *sends* a legacy zero-condition swap under any circumstances:

- Every swap is preceded by a kind:20033 RFQ probe, and only a maker that answers kind:20034 (thereby registering the session) is swapped with. Coupled legs, verify-before-reveal, and a per-fill rate floor are no longer opt-in — they are the protocol.
- A maker that does not establish a session now **fails the call** with `RollingUnavailableError` (HTTP 502 `rolling_unavailable`), naming the maker pubkey, its ILP address and the reason discriminator. There is no downgrade left: the previous escape hatches (`rolling: 'auto'` / `rolling: 'off'`) are removed, not merely defaulted off, and so is the legacy-only adaptive δ/W controller (`controller`, per the drop decision recorded on toon-client#597). `packetCount` — the static split — is unaffected.
- A caller that drove the legacy stream directly through the sdk's `streamSwap` has no supported equivalent here. The migration is to the rolling path: probe with `sendRollingRfq`, fill against the returned session, and verify each leg-B advance with `handleRollingAdvance` before revealing leg A.
- A claim that fails verification no longer comes back as an accepted-but-unverified claim; it is withheld before leg A commits, so it costs nothing and is reported as a rejection.

Makers still accept legacy while this ships — the sender stops emitting it strictly before the maker stops accepting it (ADR 0003's ordering), so reverting is a no-coordination rollback.
