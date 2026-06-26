---
"@toon-protocol/client-mcp": minor
---

`toon_upload` can now source media bytes from an on-disk `filePath` instead of
inline `dataBase64`. Agent callers previously had to materialize the entire
base64 payload as a tool argument and stream it through the model context
(slow, context-heavy, scaling linearly with file size). The new optional
`filePath` field on `UploadMediaRequest` / the `toon_upload` tool schema lets
the daemon `fs.readFile` the bytes off disk instead.

Supply EXACTLY ONE of `filePath` | `dataBase64`; both-or-neither is rejected
with `InvalidPayloadError` (HTTP 400). `dataBase64` is retained for backward
compatibility. The path is resolved and, when an upload root is configured
(`TOON_CLIENT_UPLOAD_ROOT` env / `uploadAllowedRoot` config), must resolve
inside it — bounding which filesystem locations the daemon reads on an agent's
behalf.
