---
'@toon-protocol/client': patch
'@toon-protocol/client-mcp': patch
---

Parse the HTTP-over-ILP response carried in an ILP FULFILL packet's `data` on the paid-write and blob-upload paths.

The deployed connector is a payment-proxy: an accepted ILP FULFILL only means the payment cleared — the FULFILL `data` carries the relay/DVM's verbatim HTTP/1.1 response, so a write can fail inside a successful FULFILL.

- **Publish (`ToonClient.publishEvent`):** previously reported `success` with a real `eventId` for ANY accepted FULFILL, even when the embedded HTTP status was `404 Not Found` and the event never persisted. It now parses the FULFILL envelope and fails the publish on a non-2xx status (no fake `eventId`).
- **Blob upload (`ToonClient.uploadBlob` / `requestBlobStorage`):** previously base64-decoded the WHOLE FULFILL data as a bare Arweave tx id, erroring on the real `HTTP/1.1 200 OK ... {"accept":true,"txId":"…"}` body. It now parses the HTTP envelope, JSON-decodes the body, and reads `txId` (falling back to base64-decoding `data`), failing on non-2xx or `accept:false`.

A shared `parseFulfillHttp` helper backs both paths and falls back to prior behavior for non-HTTP-enveloped FULFILLs (no regression for legacy/non-proxy relays). The MCP daemon's `upload-media` path now surfaces these upload failures instead of returning a fake tx id.
