---
'@toon-protocol/client': patch
---

Implement sealing at a BTP client destination (issue #537, toon-meta#266 §7): under mesh-compute's epic decision 6, a seller is a BTP client that is itself the destination and holds the preimage — not a connector. `sealExchange`'s connector-derived fulfilment (ADR 0019) never applied here; nothing let a client unseal a job addressed to itself, or advertise a key for a buyer to seal to.

- `ToonClient.getSealingPublicKey()` / `getSealingPublicKeyHex()` expose a stable ADR 0018 sealing identity (derived from the same `secretKey` as the Nostr identity) suitable for a `kind:31990` advertisement's `seal_pubkey` tag.
- `wire/giftwrap.ts` gains `giftWrapPublicKey(secretKey)`, the counterpart derivation the two new `ToonClient` getters and any other caller can share.
- `createJobMessageHandler(handler, identity?)` takes an optional second argument — this client's own ADR 0018 secret key (or a `GiftWrapEcdh`). When supplied, an inbound job PREPARE's `data` is opened as a gift wrap addressed to `identity` before the handler runs (`job.data` becomes the opened plaintext), and the handler's answer is sealed back with the same shared secret before it goes on the FULFILL. A wrap that will not open is refused (F00) before the handler ever sees it, distinct from a mismatched-fulfilment refusal (F99).
- Additive throughout: omitting `identity` (the default) reproduces the exact pre-#537 behaviour — `data` passes through unsealed in both directions. The new `ToonClientConfig.jobHandlerSealed` flag (default `false`) opts an existing `jobHandler` into the sealed wire; devnet's current factory-job dialect, which does not seal to this client, is unaffected.

`hashlock-delivery.ts`'s `encryptArtifact`/`fulfillIncrement`/`decryptArtifact` are unchanged and reused as-is for the fulfilment the handler supplies — this change only closes the sealing/unsealing seam around them.
