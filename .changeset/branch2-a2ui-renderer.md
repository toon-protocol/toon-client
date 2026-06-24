---
'@toon-protocol/views': minor
---

Add branch 2 of the NIP-on-TOON render trust gradient: the A2UI declarative renderer (toon-meta#58).

`A2UIRenderer` renders an unknown Nostr kind at **medium trust** through the client's own audited A2UI "Basic" catalog — never provider code. Per the branch-2 binding convention, the resolved `kind:31036` renderer's `content` is the A2UI `surfaceUpdate` (the durable template) and the decoded TOON event is fed in as the `dataModelUpdate` (the bound data); component props bind via `{ path: "/…" }` JSON Pointers into the event-derived data model.

**Standard-catalog-only invariant:** `validateA2uiRenderer` is the medium-trust gate. Only the curated Basic catalog (`Text`, `Heading`, `Image`, `Icon`, `Row`, `Column`, `List`, `Card`, `Divider`) is rendered; any custom component **or** any client-defined behavior (`onClick`/`action`/validators/etc.) REFUSES and signals a drop to branch 3 (sandboxed mcp-ui) via the `A2uiGateRefuse.fallback` result — the renderer never renders a refused surface. The `["a2ui", "<version>"]` tag is checked; an unsupported version falls through gracefully (branch 1/4).

Consumes the branch-2 `A2uiDecision` from `@toon-protocol/client`'s `renderDispatch` (#88); does not change the dispatch contract. Branches 3/4 + renderer-swap defense remain #90/#91/#92.
