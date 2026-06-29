---
'@toon-protocol/client-mcp': patch
'@toon-protocol/views': patch
---

Polish the paid-write loop and harden cross-host rendering (Phase 2.4–2.6).

- **Optimistic pending → confirmed.** After a successful paid publish, the receipt shows the note as "pending" and flips to "confirmed" once a relay serves the event back, polled via the free `toon_query` read seam (`usePublishConfirmation`/`RelayConfirmation`). A slow/absent read stays "pending (unconfirmed)" — never a false "failed" (the message was paid and broadcast). This deliberately relies on the read seam rather than a hand-rolled WS reader, which would false-negative on the devnet relay's double-JSON-encoded EVENT payloads.
- **Media via Arweave gateway for CSP.** The MCP-app iframe CSP only allows the declared Arweave/ar.io gateway origins, so `gatewayMediaSrc` re-points Arweave-addressable media/avatar URLs onto a CSP-allowlisted gateway origin; arbitrary non-Arweave origins are left unchanged (they degrade rather than breaking the CSP).
- **Text fallback for non-rendering hosts.** `toon_query`/`toon_read` now carry a decision-sufficient text summary (author · time · excerpt · counts) alongside `structuredContent`, and the render path names the view in text — so a text-only host that can't render the `ui://` card still gets readable, actionable content.
