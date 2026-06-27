---
"@toon-protocol/client-mcp": patch
---

Fix Arweave media still not rendering despite the CSP allowlist (toon-client#127):
ar.io / arweave.net gateways 302-redirect the apex URL to a per-tx **sandbox
subdomain** (`https://<base32>.arweave.net/<txId>`), and CSP `img-src` is checked
against the redirect target — so an apex-only allowlist still blocks the image.
Advertise a wildcard subdomain (`https://*.arweave.net`, `https://*.ar-io.dev`, …)
alongside the apex in the app resource's `_meta.ui.csp`.
