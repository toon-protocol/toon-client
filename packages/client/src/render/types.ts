/**
 * Render-dispatch types for the NIP-on-TOON render trust gradient.
 *
 * The client forks on one question — *do I know this kind?* — and the answer
 * selects both a render strategy and a trust level. Trust runs *opposite* to
 * flexibility: the more open-ended the render path, the less it is trusted.
 *
 * | Branch | Condition                | Strategy                  | Trust  |
 * |--------|--------------------------|---------------------------|--------|
 * | 1      | known kind               | native component          | full   |
 * | 2      | unknown + A2UI spec      | client A2UI catalog       | medium |
 * | 3      | unknown + raw widget     | sandboxed mcp-ui iframe   | low    |
 * | 4      | unknown + nothing        | generative fallback       | low    |
 *
 * This module is render-framework-agnostic: it carries the *decision*, not the
 * React tree. The `views` package binds branch 1's resolved native component to
 * an actual component, and the sibling tickets (#89/#90/#92) fill in branches
 * 2/3/4. See `skills/nip-on-toon-discovery/SKILL.md` in toon-meta for the spec.
 */

import type { NostrEvent } from 'nostr-tools/pure';

/**
 * The four render branches of the trust gradient. The string values are stable
 * and safe to persist / log.
 */
export type RenderBranch = 'native' | 'a2ui' | 'mcp-ui' | 'generative';

/** Trust tier associated with a branch. Full > medium > low. */
export type RenderTrust = 'full' | 'medium' | 'low';

/**
 * Branch 1 — a known kind renders with a fully-trusted native component from the
 * client's own registry. The component type `C` is left generic so the rendering
 * package (`@toon-protocol/views`) can specialise it with its own component
 * contract (e.g. an `Atom`) without this package depending on React.
 */
export interface NativeDecision<C> {
  branch: 'native';
  trust: 'full';
  /** The event to render. */
  event: NostrEvent;
  /** The resolved native component for this kind, from the {@link KindRegistry}. */
  component: C;
}

/**
 * Branch 2 — unknown kind, an `application/a2ui+json` renderer is available. The
 * renderer's `surfaceUpdate` is the template; `core.decodeEventFromToon(event)`
 * is fed in as the `dataModelUpdate` (medium trust, standard catalog only).
 *
 * STUB for #88: the dispatch routes here; the A2UI renderer is implemented in
 * toon-protocol/toon-client#89.
 */
export interface A2uiDecision {
  branch: 'a2ui';
  trust: 'medium';
  /** The event to render. */
  event: NostrEvent;
  /** The resolved `kind:31036` renderer event carrying the A2UI `surfaceUpdate`. */
  renderer: NostrEvent;
}

/**
 * Branch 3 — unknown kind, a `text/html;profile=mcp-app` raw widget renderer is
 * available. Rendered inside a sandboxed mcp-ui iframe at low trust; the consent
 * invariant (authorization surface drawn by the client outside the iframe,
 * non-themeable) is enforced by the host.
 *
 * STUB for #88: the dispatch routes here; the sandboxed AppRenderer + consent
 * invariant are implemented in toon-protocol/toon-client#90.
 */
export interface McpUiDecision {
  branch: 'mcp-ui';
  trust: 'low';
  /** The event to render. */
  event: NostrEvent;
  /** The resolved `kind:31036` renderer event carrying the raw widget. */
  renderer: NostrEvent;
}

/**
 * Branch 4 — unknown kind, no renderer available. The client falls back to a
 * generative rendering at low trust (optionally publishing back a `kind:31036`).
 *
 * STUB for #88: the dispatch routes here; the generative fallback is implemented
 * in toon-protocol/toon-client#92.
 */
export interface GenerativeDecision {
  branch: 'generative';
  trust: 'low';
  /** The event to render. */
  event: NostrEvent;
}

/**
 * The outcome of {@link renderDispatch}: a discriminated union over
 * {@link RenderBranch}. Consumers switch on `.branch` to pick a renderer.
 */
export type RenderDecision<C> =
  | NativeDecision<C>
  | A2uiDecision
  | McpUiDecision
  | GenerativeDecision;
