---
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': minor
---

Atomic verify/reveal composition + per-packet preimage retention (rolling-swap leg-B, toon-client#360, part of toon-meta#145)

Two coupled rolling-swap seams that leg-B reveal (spec §3.2) needs:

- **Preimage retention.** `withSenderConditions` minted a fresh per-packet
  preimage `P_i`, set `C_i = sha256(P_i)` on the leg-A PREPARE, and then
  discarded `P_i`. It now retains each `P_i` in a session-scoped
  `InMemoryPreimageRetentionStore`, keyed by `packetIndex` — the identifier
  shared with `AccumulatedClaim.packetIndex` — so the receive-side reveal can
  correlate and consume the secret for the claim it commits.
- **Atomic verify → persist → reveal.** New `ingestAndReveal` composes the
  `ingestReceivedClaims` verification/persist step with the leg-B reveal as one
  unit: a verified claim's watermark advance survives iff its reveal commits,
  and is rolled back (compensating restore of the prior watermark) on
  withhold/failure. This makes the persisted watermark track only
  accepted/revealed packets, so engine R8's reused nonce — the maker reuses a
  rolled-back nonce for the next fill — is accepted, not falsely rejected as
  non-monotonic. The daemon's swap path routes claim ingestion through it.

Legacy zero-condition swaps and hard verification rejects are unchanged (never
reach a reveal, never touch a watermark).
