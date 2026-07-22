---
"@toon-protocol/client": patch
---

Fix `packages/client` typecheck debt (#431): `BTPErrorData` now has a `message`
field (the trailing wire `data` octet string decoded as UTF-8) and the
`triggeredBy` property-name typo in `IsomorphicBtpClient` is corrected to the
real wire field `triggeredAt`. `KeyVault`'s `fromBase64`/`deriveKekFromPassword`
now use `Uint8Array<ArrayBuffer>` so they satisfy `BufferSource` under
TS 5.9's stricter lib-DOM typing (no runtime behavior change).
