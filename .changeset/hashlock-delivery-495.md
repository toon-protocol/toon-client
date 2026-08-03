---
'@toon-protocol/client': minor
---

Add hashlock delivery helpers (issue #495, toon-meta#262 decision 5): `encryptArtifact`, `fulfillIncrement`, `decryptArtifact`, and `buildIncrementPrepare`, symmetric between the provider and buyer sides of a factory-job increment (`docs/factory-job-protocol.md` §4 in toon-meta).

The provider encrypts an increment's artifact under a freshly minted 32-byte key and sets the ILP `executionCondition` to `sha256(key)`; the only way to claim the increment's payment is to reveal `key` as the fulfillment, which is the same instant the buyer can decrypt. `encryptArtifact` takes only the artifact bytes — no caller-supplied key or condition — so the condition can never be derived from anything other than the key that actually decrypts the artifact. `decryptArtifact` verifies `sha256(key)` against the condition the buyer paid before decrypting, throwing `HashlockConditionMismatchError` on a mismatch or `HashlockDecryptError` on a tampered ciphertext; neither error ever carries the key.
