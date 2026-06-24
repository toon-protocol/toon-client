/**
 * Kind-keyed render dispatch — the skeleton the four render branches plug into.
 *
 * Implements §"Client dispatch algorithm" of the NIP-on-TOON render-side spec
 * (`skills/nip-on-toon-discovery/SKILL.md` in toon-meta):
 *
 *   1. Is this kind known? → **branch 1** (native registry). Done.
 *   2. Otherwise resolve the event's `ui` tag to a `kind:31036` renderer.
 *   3. If a renderer is found, read its `m` (mimeType) tag:
 *        - `application/a2ui+json`     → **branch 2** (A2UI, medium trust)
 *        - `text/html;profile=mcp-app` → **branch 3** (sandboxed mcp-ui, low)
 *   4. If no renderer is found → **branch 4** (generative fallback, low trust).
 *
 * SCOPE (#88 — skeleton + branch 1 only): branch 1 is wired through the
 * {@link KindRegistry}; branches 2/3/4 are returned as clearly-marked decisions
 * for the sibling tickets to consume (#89 A2UI, #90 mcp-ui + consent, #92
 * generative). This module does NOT render — it returns a {@link RenderDecision}.
 *
 * The `ui`-tag → `kind:31036` *resolution* lives outside this function — see
 * {@link resolveUiRenderer} in `./resolveRenderer.js`, which parses the `ui`
 * coordinate (via core's `getUiCoordinate` / `parseUiCoordinate`), picks the
 * latest addressable `kind:31036` (`selectLatestAddressable`), and re-verifies
 * its signature before trusting it. The dispatch takes the already-resolved
 * renderer event via {@link DispatchInput.renderer}.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { MIME_A2UI, MIME_MCP_APP, UI_RENDERER_KIND } from './constants.js';
import type { KindRegistry } from './KindRegistry.js';
import type { RenderDecision } from './types.js';

/** Read the first value of the named tag, or `undefined`. */
function tagValue(event: NostrEvent, name: string): string | undefined {
  const tag = event.tags.find((t) => t[0] === name);
  return tag?.[1];
}

/**
 * The `m` (mimeType) tag value of a resolved `kind:31036` renderer, or
 * `undefined` if the event is not a renderer or carries no `m` tag.
 *
 * The `m` tag is the format selector that picks the branch + trust tier.
 */
export function resolveRendererMime(renderer: NostrEvent | undefined): string | undefined {
  if (!renderer || renderer.kind !== UI_RENDERER_KIND) return undefined;
  return tagValue(renderer, 'm');
}

/** Input to {@link renderDispatch}. */
export interface DispatchInput {
  /** The decoded event the client wants to render. */
  event: NostrEvent;
  /**
   * The `kind:31036` renderer resolved from the event's `ui` tag, if any.
   *
   * Resolution (parse the `ui` coordinate, fetch + pick the latest addressable
   * `kind:31036`) is performed by the caller — see the toon#36 spike. Only
   * consulted when the event's kind is unknown (branches 2–4).
   */
  renderer?: NostrEvent;
}

/**
 * Route an event to one of the four render branches.
 *
 * @param input    The event + (optionally) its resolved `kind:31036` renderer.
 * @param registry The branch-1 native-component registry to consult first.
 * @returns A {@link RenderDecision} naming the branch, trust tier, and payload.
 */
export function renderDispatch<C>(
  input: DispatchInput,
  registry: KindRegistry<C>
): RenderDecision<C> {
  const { event, renderer } = input;

  // Branch 1 — known kind → native component, full trust.
  const component = registry.lookup(event.kind);
  if (component !== undefined) {
    return { branch: 'native', trust: 'full', event, component };
  }

  // Unknown kind: the `m` tag of the resolved renderer picks the branch.
  const mime = resolveRendererMime(renderer);

  // Branch 2 — A2UI, medium trust. [STUB: renderer in #89]
  if (mime === MIME_A2UI && renderer) {
    return { branch: 'a2ui', trust: 'medium', event, renderer };
  }

  // Branch 3 — sandboxed mcp-ui iframe, low trust. [STUB: renderer + consent in #90]
  if (mime === MIME_MCP_APP && renderer) {
    return { branch: 'mcp-ui', trust: 'low', event, renderer };
  }

  // Branch 4 — no (recognised) renderer → generative fallback, low trust.
  // [STUB: generative fallback + kind:31036 publish-back in #92]
  return { branch: 'generative', trust: 'low', event };
}
