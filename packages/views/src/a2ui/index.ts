/**
 * Branch 2 — A2UI declarative renderer (medium trust) for the NIP-on-TOON render
 * trust gradient (toon-meta#58, toon-client#89).
 *
 * Renders an A2UI `surfaceUpdate` template bound to a decoded TOON event
 * (`dataModelUpdate`) using the client's own audited "Basic" catalog — never
 * provider code. The standard-catalog-only gate ({@link validateA2uiRenderer})
 * refuses custom components / behavior and signals a drop to branch 3.
 *
 * The React renderer (`A2UIRenderer`) is part of the views *app bundle* (React),
 * not the Node barrel, so it is exported from here rather than `src/index.ts`.
 */

export { A2UIRenderer, type A2UIRendererProps } from './A2UIRenderer.js';
export {
  validateA2uiRenderer,
  readA2uiVersion,
  type A2uiGateResult,
  type A2uiGatePass,
  type A2uiGateRefuse,
  type A2uiFallbackBranch,
} from './validate.js';
export { dataModelFromEvent, resolvePath, resolveValue } from './binding.js';
export {
  A2UI_BASIC_CATALOG,
  A2UI_BASIC_CATALOG_SET,
  SUPPORTED_A2UI_VERSION,
  SUPPORTED_A2UI_VERSIONS,
  type A2uiBasicComponent,
  type A2uiComponentNode,
  type A2uiSurfaceUpdate,
  type A2uiDataModel,
} from './types.js';
