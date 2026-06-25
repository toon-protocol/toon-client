---
'@toon-protocol/views': minor
'@toon-protocol/client': minor
'@toon-protocol/client-mcp': patch
---

Wire the NIP-on-TOON render trust gradient into the live app render path (toon-meta#58). The gradient was previously dead code; it is now the real render path for every incoming event.

**`@toon-protocol/views` — the gradient is now the live event render path.**

- `buildKindRegistry()` (in `atoms/registry.ts`) builds the branch-1 `KindRegistry<Atom>` from the catalog's atom→kind metadata — the registry `guardedRenderDispatch` consults first. The generic fallback atom is deliberately not registered, so an unknown kind misses and falls through to the unknown-kind branches.
- A new renderer resolver (`render/resolve.tsx`): `useRenderDecision(event, bridge, registry, pins)` runs the gradient per event. Known kinds short-circuit to branch 1 (native) with no relay round-trip; for an unknown kind with a `ui` coordinate it fetches candidate `kind:31036` renderers over the bridge — `toon_query { kinds: [31036], '#d': [targetKind], authors: [eventAuthor] }` — and drives `guardedRenderDispatch` once they arrive (async loading state). `rendererQueryFilter(event)` is exported.
- `runtime.tsx`'s `EventAtom` (the kindAuto / feed render seam) now switches on the `RenderDecision`: `native` → the atom component (full trust, today's behaviour); `a2ui` → `A2UIRenderer` (medium, with generative fall-through on a gate refusal); `mcp-ui` → `SandboxedAppRenderer` with the host-rendered consent prompt (low); `generative` → `GenerativeFallbackRenderer` (low, deterministic generator; no model is wired in the app and publish-back stays off). Dispatch goes through `guardedRenderDispatch` (not bare `renderDispatch`), so author-binding + signature + anti-swap pinning apply; a session-scoped `RendererPinStore` is seeded at app scope. The explicit atom-by-id ViewSpec path (`NodeView`) is unchanged.

**`@toon-protocol/client` — browser-safe `./render` subpath.**

- Adds a `@toon-protocol/client/render` export (and a second tsup entry) exposing just the render trust gradient — pure dispatch + swap-defense + branch helpers that depend only on `@toon-protocol/core`'s `ui` helpers and `nostr-tools`. The views app bundle imports this subpath instead of the package root so the client's Node-only channel/transport code never enters the iframe bundle. No behaviour change to existing `@toon-protocol/client` consumers.

**`@toon-protocol/client-mcp` — reship the rebuilt bundle.**

- client-mcp copies `@toon-protocol/views`' prebuilt `dist/app/index.html` into its own `dist/app` at build time and serves it at `ui://toon/app`. A patch bump so a published client-mcp reships the rebuilt, gradient-wired app bundle.
