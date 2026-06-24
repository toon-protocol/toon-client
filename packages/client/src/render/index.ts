/**
 * NIP-on-TOON render dispatch (toon-protocol/toon-meta#58).
 *
 * The kind-keyed dispatch skeleton + branch-1 native-component registry. Branches
 * 2/3/4 are routed to as clearly-marked decisions for the sibling tickets to
 * implement (#89 A2UI, #90 sandboxed mcp-ui + consent, #92 generative fallback).
 */

export {
  renderDispatch,
  resolveRendererMime,
  guardedRenderDispatch,
} from './dispatch.js';
export type {
  DispatchInput,
  GuardedDispatchInput,
  DispatchGuardInfo,
} from './dispatch.js';
export { KindRegistry } from './KindRegistry.js';
export { resolveUiCoordinate, resolveUiRenderer } from './resolveRenderer.js';
export type { ResolvedCoordinate } from './resolveRenderer.js';
export { UI_RENDERER_KIND, UI_TAG, MIME_A2UI, MIME_MCP_APP } from './constants.js';
// The `ui` coordinate helpers + type now live in `@toon-protocol/core@1.6.0`
// (#97 dropped the local mirror); re-exported here so the render module keeps a
// single import surface for them.
export {
  parseUiCoordinate,
  getUiCoordinate,
  selectLatestAddressable,
} from '@toon-protocol/core';
export type { UiCoordinate } from '@toon-protocol/core';
export {
  verifyRendererTrust,
  isTrustDowngrade,
  RendererPinStore,
} from './swap-defense.js';
export type {
  SwapDecision,
  SwapApproval,
  SwapRejection,
  SwapRejectionReason,
  RendererPin,
  VerifyRendererInput,
} from './swap-defense.js';
export type {
  RenderBranch,
  RenderTrust,
  RenderDecision,
  NativeDecision,
  A2uiDecision,
  McpUiDecision,
  GenerativeDecision,
} from './types.js';
