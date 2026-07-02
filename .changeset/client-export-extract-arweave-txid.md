---
'@toon-protocol/client': minor
---

Export `extractArweaveTxId` from the blob-storage helper. Callers that drive
`publishEvent` directly with a hand-built kind:5094 event (e.g. git-object
uploads carrying Git-SHA/Git-Type/Repo tags, toon-client#227) can now reuse
the exact FULFILL→Arweave-txId decode `requestBlobStorage` applies (HTTP
envelope parse, `accept:false` handling, legacy bare-base64 fallback).
