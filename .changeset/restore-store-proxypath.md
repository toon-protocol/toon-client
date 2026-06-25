---
'@toon-protocol/client': patch
---

Restore the `POST /store` request-target for blob uploads. `buildStoreWriteEnvelope` again accepts a `requestTarget` (default `/write`), `publishEvent` threads a `proxyPath` option through to it, and `requestBlobStorage` passes `/store`. Without this, kind:5094 blob uploads emitted `POST /write` and the Arweave store backend (which serves `/store` + `/health` only) returned 404. Adds a `store-envelope` regression test covering both targets.
