---
'@toon-protocol/client': minor
---

Adopt `@toon-protocol/core@^1.6.0` and wire `ui` → `kind:31036` renderer resolution (toon-meta#58).

The `UI_RENDERER_KIND` (31036) and `UI_TAG` (`ui`) constants mirrored locally in `src/render/constants.ts` for the dispatch skeleton (#88) are now re-exported from the published `@toon-protocol/core` instead; only the render-branch mime selectors (`MIME_A2UI`, `MIME_MCP_APP`), which core does not own, remain local.

New resolution seam (`src/render/resolveRenderer.ts`) — the piece `renderDispatch` deliberately left out — built on core's pure helpers (`getUiCoordinate` / `parseUiCoordinate` / `selectLatestAddressable`):

- `resolveUiCoordinate(event)` computes the renderer coordinate. Per the toon#36 decisions the renderer-author pubkey is the **event author**, so the `ui` tag may carry just the bare target kind; a full `31036:<pubkey>:<kind>` coordinate is also accepted but only when its pubkey equals the event author (no third-party renderers).
- `resolveUiRenderer(event, candidates)` filters the caller-supplied `kind:31036` candidates to that coordinate, picks the latest addressable one (NIP-33 latest-wins), and **re-verifies its signature** with `verifyEvent` before returning it — an unverified renderer is dropped and never reaches the dispatch.

The relay query that produces `candidates` stays the caller's responsibility, and `renderDispatch`'s contract is unchanged — resolution feeds it.
