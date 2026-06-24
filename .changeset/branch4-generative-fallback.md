---
'@toon-protocol/client': minor
---

Add branch 4 of the NIP-on-TOON render trust gradient — the generative fallback + optional `kind:31036` publish-back (toon-meta#58, closes #92).

When a kind is unknown *and* no resolvable `kind:31036` renderer exists, `GenerativeFallbackRenderer` produces a best-effort, low-trust rendering of the event's shape. The model call is abstracted behind an injectable `RendererGenerator` seam — the host wires its own provider/keys/prompt; this package imports no LLM SDK. A dependency-free `deterministicGenerator` is the default and falls in automatically if an injected model generator throws, so branch 4 always renders *something*.

Optional **publish-back** republishes the generated renderer as a `kind:31036` addressable event (`d` = target kind, `m` = renderer mimeType, coordinate `31036:<author-pubkey>:<targetKind>`) so the next client has a "known" renderer — branch 4 slowly feeds branch 1. Publish-back is **off by default** and a guarded capability: it only fires when the host passes `publish: { enabled: true, signer, publisher }`. The published renderer is marked curation-pending (`t=generative-fallback`); the namespacing/curation policy is an open epic question and is intentionally not built here.

Note: `buildUiCoordinate` (and the renderer kind / `ui` tag / coordinate helpers) are imported from `@toon-protocol/core@^1.6.0`, re-exported through `render/constants.ts`. No local mirror.
