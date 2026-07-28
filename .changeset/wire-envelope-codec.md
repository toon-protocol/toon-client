---
'@toon-protocol/client': minor
---

A structured OER envelope codec, replaying the committed cross-repo vectors
(toon-client#448).

Adds `src/wire/` — canonical OER length primitives and the request/response
envelope codec, a faithful port of `connector_domain::envelope`. Header order
and duplicate header names survive a round trip; non-canonical, zero-length-alias
and over-wide length determinants are each refused with their own reason (ADR
0023); arbitrary bytes never throw anything but an `EnvelopeError`.

The connector's `vectors/wire-vectors.json` is vendored under
`src/wire/vectors/` with its provenance and a SHA-256 integrity check, refreshed
by `pnpm --filter @toon-protocol/client vectors:refresh` and watched for drift
daily by `.github/workflows/wire-vectors-drift.yml`.

Additive: the existing `utils/store-envelope.ts` / `utils/fulfill-http.ts` HTTP
framing is untouched and still what the send path uses.
