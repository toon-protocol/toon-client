---
'@toon-protocol/client': minor
---

The gift wrap and the fulfilment a shared secret derives (toon-client#449).

Adds `src/wire/giftwrap.ts` — a faithful port of `connector_signer::giftwrap`:
`sealRequest`/`openRequest` (ECDH to the terminating connector's identity key
over the raw X-coordinate, `0x01 ‖ ephemeral_public(65) ‖ nonce(12) ‖
ciphertext` around `shared_secret ‖ encoded_envelope`),
`sealResponse`/`openResponse` (`0x02 ‖ nonce ‖ ciphertext`, sealed with the
request's own secret — no second key exchange), `looksLikeSealedResponse`,
`deriveFulfillment` (HKDF-SHA256, no salt, info `toon-giftwrap-fulfillment`)
and `deriveCondition` (`sha256`). AEAD is ChaCha20-Poly1305.

The vendored vector file's `giftwrap` and `fulfilment` sections are now
replayed: every pinned `request_wrap_hex`, `response_wrap_hex`, fulfilment and
condition is reproduced byte-for-byte, so all four sections the connector
publishes are replayed and none is carried unreplayed.

Failure modes stay separable by type: a wrap that cannot be opened is a
`GiftWrapError`; a wrap that opens cleanly but decodes to a malformed envelope
is an `EnvelopeError`.

New dependency: `@noble/ciphers` (ChaCha20-Poly1305). `@noble/curves` and
`@noble/hashes` already covered secp256k1 and HKDF-SHA256.

Additive: nothing in the send path calls this yet — `publishEvent` still uses
the latin1 HTTP framing in `utils/store-envelope.ts`.
