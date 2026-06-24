/**
 * Render-side protocol constants for NIP-on-TOON.
 *
 * The canonical homes for the renderer kind, the `ui` tag, and the
 * `UiCoordinate` helpers are `@toon-protocol/core` (published in `1.6.0`):
 * {@link UI_RENDERER_KIND} (31036), {@link UI_TAG}, and `parseUiCoordinate` /
 * `buildUiCoordinate` / `getUiCoordinate` / `selectLatestAddressable`. They are
 * re-exported here so the render module has a single import surface; only the
 * mime-type selectors below are owned locally (core does not export them).
 */

// `UI_RENDERER_KIND`, `UI_TAG`, and the `UiCoordinate` helpers now come from
// core — re-exported, not mirrored.
export {
  UI_RENDERER_KIND,
  UI_TAG,
  buildUiCoordinate,
  parseUiCoordinate,
  getUiCoordinate,
  selectLatestAddressable,
  type UiCoordinate,
} from '@toon-protocol/core';

/**
 * The `m` (mimeType) tag value selecting **branch 2** — A2UI, medium trust.
 *
 * Owned locally: core does not export the render-branch mime selectors.
 */
export const MIME_A2UI = 'application/a2ui+json';

/**
 * The `m` (mimeType) tag value selecting **branch 3** — sandboxed mcp-ui iframe,
 * low trust.
 *
 * Owned locally: core does not export the render-branch mime selectors.
 */
export const MIME_MCP_APP = 'text/html;profile=mcp-app';
