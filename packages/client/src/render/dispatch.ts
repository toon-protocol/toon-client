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
import {
  verifyRendererTrust,
  type RendererPinStore,
  type SwapRejection,
} from './swap-defense.js';

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
export function resolveRendererMime(
  renderer: NostrEvent | undefined
): string | undefined {
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

/** Input to {@link guardedRenderDispatch}. */
export interface GuardedDispatchInput {
  /** The decoded event the client wants to render. */
  event: NostrEvent;
  /**
   * The candidate `kind:31036` renderer(s) fetched for the event's `ui`
   * coordinate, *unfiltered*. The swap-defense guard selects the winner
   * deterministically and verifies it; the caller does NOT pre-select. Pass an
   * empty array (or omit) when no renderer was resolved.
   */
  candidates?: readonly NostrEvent[];
}

/** Why {@link guardedRenderDispatch} fell back to a safe branch. */
export interface DispatchGuardInfo {
  /** A renderer was refused by the swap-defense guard. */
  rejected: SwapRejection;
}

/**
 * Dispatch with the **renderer-swap defense** (toon-client#91) interposed.
 *
 * This is the secure entry point: it runs {@link verifyRendererTrust} over the
 * raw candidate renderers *before* {@link renderDispatch} can pick a strategy,
 * and **fails closed** on any violation (wrong-author, bad signature,
 * trust-downgrading swap, high-trust id change):
 *
 *   - Known kind → branch 1 (native) regardless of renderers. The guard still
 *     runs so a *high-trust* renderer swap is detected, but a known kind always
 *     has the native component to fall back to, so the result is branch 1.
 *   - Unknown kind, renderer **approved** → normal {@link renderDispatch} with the
 *     single verified renderer (branches 2/3).
 *   - Unknown kind, renderer **refused** or none → branch 4 (generative). We do
 *     NOT pass the suspect renderer through; the user gets the safe fallback.
 *
 * @returns the {@link RenderDecision} plus, when a renderer was refused, the
 * {@link DispatchGuardInfo} describing why (for logging / UX "renderer refused").
 */
export function guardedRenderDispatch<C>(
  input: GuardedDispatchInput,
  registry: KindRegistry<C>,
  pins: RendererPinStore
): { decision: RenderDecision<C>; guard?: DispatchGuardInfo } {
  const { event } = input;
  const candidates = input.candidates ?? [];

  // Known kind: branch 1 wins. Still run the guard so a high-trust swap is
  // observed/pinned, but the safe fall-back for a known kind is its native
  // component, so the decision is branch 1 either way.
  if (registry.has(event.kind)) {
    const guarded = verifyRendererTrust({ event, candidates, registry, pins });
    const decision = renderDispatch({ event }, registry);
    return guarded.ok
      ? { decision }
      : { decision, guard: { rejected: guarded } };
  }

  // Unknown kind with no candidates: nothing to guard → generative fallback.
  if (candidates.length === 0) {
    return { decision: renderDispatch({ event }, registry) };
  }

  // Unknown kind with candidates: the guard must approve a renderer before it
  // can select a strategy. Fail closed to generative on refusal.
  const guarded = verifyRendererTrust({ event, candidates, registry, pins });
  if (!guarded.ok) {
    return {
      decision: renderDispatch({ event }, registry),
      guard: { rejected: guarded },
    };
  }

  // Approved: dispatch with ONLY the verified, author-bound renderer.
  return {
    decision: renderDispatch({ event, renderer: guarded.renderer }, registry),
  };
}
