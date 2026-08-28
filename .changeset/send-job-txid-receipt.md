---
'@toon-protocol/client': patch
---

Fix `sendJob` reporting a successful `kind:5094` upload as "accepted but carried no receipt". The store picks between two response fields by whether its base64 `data` parses as a JSON object — a receipt goes to `result`, anything else goes to `txId` — and `kind:5094`'s whole answer is one bare Arweave transaction id, so it takes the second branch. `decodeReceipt` knew only the `data`-as-JSON and `result` branches, so it returned `undefined` and the caller was told a completed upload had failed. It now reads `txId` as a third branch, wrapped as `{ txId }` so callers read `receipt.txId` the way every other job's fields are read. `result` still wins when an app sends both, so the JSON-receipt jobs (`kind:5095`, `kind:5096`) are unaffected, and an empty `txId` is still no receipt.
