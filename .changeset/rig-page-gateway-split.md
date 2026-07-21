---
"@toon-protocol/rig": patch
---

Split the printed Rig-page/site URL gateway (now `ar-io.dev`, where the ar.io
testnet store uploads are actually served) from the rig-web bundle asset
gateway (`arweave.net`, which honors the bundle's `Content-Encoding: gzip`
tag — `ar-io.dev` drops it and the browser gets raw gzip). New
`DEFAULT_RIG_WEB_GATEWAY` / `RIG_WEB_GATEWAY` env control the bundle gateway;
`RIG_ARWEAVE_GATEWAY` keeps controlling printed URLs, with the other gateway
printed as an "also:" mirror line.
