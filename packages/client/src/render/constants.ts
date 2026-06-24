/**
 * Render-side protocol constants for NIP-on-TOON.
 *
 * ── BLOCKER (toon#36) ─────────────────────────────────────────────────────────
 * The canonical homes for these are `@toon-protocol/core` — `UI_RENDERER_KIND`
 * (31036), `UI_TAG`, and the `UiCoordinate` helpers (`parseUiCoordinate`,
 * `buildUiCoordinate`, `getUiCoordinate`, `selectLatestAddressable`). Those land
 * on core `main` but are NOT in the published `@toon-protocol/core@1.4.x` this
 * package depends on. They are mirrored here so the dispatch skeleton builds and
 * ships now; once core publishes them, replace these locals with the core
 * imports (see `resolveRendererMime` / the `ui`-tag resolution spike in toon#36).
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * The addressable renderer event kind. A `kind:31036` event carries a renderer
 * for the kind named in its `d` tag; its `m` (mimeType) tag selects the branch.
 *
 * Mirror of `@toon-protocol/core` `UI_RENDERER_KIND` (unpublished — see header).
 */
export const UI_RENDERER_KIND = 31036;

/**
 * The tag on a *rendered* event that points at its `kind:31036` renderer (a
 * `UiCoordinate`). Resolution of this tag to a renderer event is an open spike
 * (toon#36) and lives outside the dispatch — the dispatch consumes an
 * already-resolved renderer.
 *
 * Mirror of `@toon-protocol/core` `UI_TAG` (unpublished — see header).
 */
export const UI_TAG = 'ui';

/**
 * The `m` (mimeType) tag value selecting **branch 2** — A2UI, medium trust.
 */
export const MIME_A2UI = 'application/a2ui+json';

/**
 * The `m` (mimeType) tag value selecting **branch 3** — sandboxed mcp-ui iframe,
 * low trust.
 */
export const MIME_MCP_APP = 'text/html;profile=mcp-app';
