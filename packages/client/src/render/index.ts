/**
 * NIP-on-TOON render dispatch (toon-protocol/toon-meta#58).
 *
 * The kind-keyed dispatch skeleton + branch-1 native-component registry. Branches
 * 2/3/4 are routed to as clearly-marked decisions for the sibling tickets to
 * implement (#89 A2UI, #90 sandboxed mcp-ui + consent, #92 generative fallback).
 */

export { renderDispatch, resolveRendererMime } from './dispatch.js';
export type { DispatchInput } from './dispatch.js';
export { KindRegistry } from './KindRegistry.js';
export {
  UI_RENDERER_KIND,
  UI_TAG,
  MIME_A2UI,
  MIME_MCP_APP,
} from './constants.js';
export type {
  RenderBranch,
  RenderTrust,
  RenderDecision,
  NativeDecision,
  A2uiDecision,
  McpUiDecision,
  GenerativeDecision,
} from './types.js';
