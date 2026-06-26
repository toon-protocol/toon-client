---
"@toon-protocol/views": patch
---

Fix the media uploader auto-rejecting every upload with `Upload failed:
cancelled` (toon-client#170).

A spendy write (`media-uploader`'s `toon_upload`) was gated by the runtime
through `window.confirm`. But the TOON app runs inside a host-controlled iframe
sandboxed WITHOUT `allow-modals`, so `window.confirm()` is suppressed by the
browser and returns `false` immediately — the consent prompt never rendered and
the spend was silently auto-rejected *upstream* of the daemon, before any bytes
reached `uploadMedia`. The bare `cancelled` was then flattened into `Upload
failed: cancelled`. (Adjacent non-spendy writes — the kind:1 composer,
`pay-confirm` — were unaffected because they confirm via rendered in-iframe UI,
not `window.confirm`.)

- **Wiring:** spendy consent is now a RENDERED React prompt (`spendy-consent.tsx`
  `ConsentProvider`), mounted by `ViewSpecRenderer` and awaited by the action
  runtime — so it works inside the no-`allow-modals` host iframe and never
  silently auto-rejects. (The ext-apps host exposes no native consent/elicit
  primitive to wire instead.) This also fixes the same latent bug in the spendy
  `swap-form`.
- **UX:** a declined consent (`SPENDY_CANCELLED`) is now surfaced as a benign
  "Upload cancelled — nothing was published or paid." note rather than a scary
  "Upload failed", distinguishing a user/host cancel from a real Arweave/publish
  leg failure.

(Co-releases `@toon-protocol/client-mcp` via the fixed group so the baked app
bundle is republished — a views-only release would not reach Claude Desktop.)
