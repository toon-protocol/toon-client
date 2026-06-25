/**
 * Branch 3 — sandboxed mcp-ui renderer (LOW trust) for the NIP-on-TOON render
 * trust gradient (toon-meta#58, toon-client#90).
 *
 * Renders an untrusted raw widget inside a hardened sandboxed iframe via
 * `@mcp-ui/client`'s `AppRenderer`, and enforces the consent invariant: every
 * action the widget *requests* is routed to a host-rendered, non-themeable
 * {@link ConsentPrompt} drawn OUTSIDE the iframe — the widget can only request,
 * never perform, and can never paint the authorization UI.
 *
 * The React components are part of the views *app bundle* (React), not the Node
 * barrel, so they are exported from here rather than `src/index.ts` (mirroring
 * the branch-2 A2UI renderer).
 */

export {
  SandboxedAppRenderer,
  type SandboxedAppRendererProps,
  type PerformTool,
} from './SandboxedAppRenderer.js';
export { ConsentPrompt, type ConsentPromptProps } from './ConsentPrompt.js';
export {
  BRANCH3_SANDBOX_PERMISSIONS,
  BRANCH3_SANDBOX_TOKENS,
  FORBIDDEN_SANDBOX_TOKENS,
  DEFAULT_MCP_UI_SANDBOX_URL,
  assertSafeSandbox,
} from './sandbox.js';
