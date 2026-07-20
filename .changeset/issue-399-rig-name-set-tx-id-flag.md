---
"@toon-protocol/rig": patch
---

Add `rig name set --tx-id <id>` as an explicit alternative to the positional `<txId>`, so an Arweave txId that leads with `-` or `_` (both valid in base64url) is never misread as an unknown flag by the arg parser.
