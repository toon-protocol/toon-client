---
"@toon-protocol/client-mcp": patch
---

Republish client-mcp so it re-bakes the current `@toon-protocol/views` MCP-app
bundle into `dist/app/index.html`. views is a bundled **devDependency** (its
prebuilt `app/index.html` is copied in at build time via tsup `onSuccess`), so
a views-only release — like the jade/Geist-Mono theme refresh in views@0.8.1
(#159) — never propagates to the published client-mcp. The last published
client-mcp (0.8.0) therefore still serves the pre-theme bundle, so Claude
Desktop shows the old UI even though views@0.8.1 is on npm. This forces a fresh
client-mcp release that picks up the new bundle.

To stop this from recurring, `views` and `client-mcp` are now a `fixed` group
in `.changeset/config.json`, so any `views` release co-releases `client-mcp`
and re-bakes the bundle. (`updateInternalDependencies` cannot do this — it only
propagates through `dependencies`/`peerDependencies`, and `views` is a
`devDependency` here by design so it stays out of the published runtime deps.)
