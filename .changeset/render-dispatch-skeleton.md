---
'@toon-protocol/client': minor
---

Add the kind-keyed render dispatch skeleton + branch-1 native-component registry for the NIP-on-TOON render trust gradient (toon-meta#58).

`renderDispatch(input, registry)` forks on one question — *do I know this kind?* — and returns a `RenderDecision` naming the branch and trust tier: branch 1 (known kind → native component, full trust) is wired through the new generic `KindRegistry<C>` (`register`/`lookup`/`has`); branches 2 (A2UI), 3 (sandboxed mcp-ui) and 4 (generative fallback) are routed to clearly-marked decisions for the sibling tickets (#89/#90/#92) to implement. The `m` (mimeType) tag of a resolved `kind:31036` renderer selects the unknown-kind branch (`application/a2ui+json` → branch 2, `text/html;profile=mcp-app` → branch 3).

Note: the `UI_RENDERER_KIND`/`UI_TAG`/`UiCoordinate` helpers are mirrored locally until they ship in a published `@toon-protocol/core` (blocked on toon#36); the `ui`-tag → `kind:31036` resolution lives outside the dispatch, which consumes an already-resolved renderer.
