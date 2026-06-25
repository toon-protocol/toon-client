/**
 * Live render-trust-gradient resolution for incoming events.
 *
 * This is the host-wiring half of the NIP-on-TOON render gradient (toon-meta#58):
 * `@toon-protocol/client` owns the pure dispatch + swap-defense; this module
 * fetches the renderer over the app's {@link ViewBridge} (the app has no direct
 * relay access) and drives {@link guardedRenderDispatch} so every incoming event
 * is routed through the gradient instead of unconditionally rendered native.
 *
 * Flow per event:
 *   1. {@link resolveUiCoordinate} parses the event's `ui` tag → a renderer
 *      coordinate `31036:<event-author>:<targetKind>` (or `null` if no `ui` tag).
 *   2. If a coordinate exists, fetch candidate `kind:31036` renderers via the
 *      bridge: `toon_query { kinds: [31036], '#d': [targetKind], authors: [author] }`.
 *      The query is a relay round-trip, so resolution is async (loading state).
 *   3. {@link guardedRenderDispatch} runs the swap-defense guard over the raw
 *      candidates (author-binding + signature re-verify + anti-swap pinning) and
 *      returns the {@link RenderDecision} — native / a2ui / mcp-ui / generative.
 *
 * Known kinds short-circuit to branch 1 (native) without any bridge round-trip,
 * keeping the common feed path fast: a kind with a registered atom never needs a
 * renderer fetch.
 *
 * NOTE on coordinate forms: the query filter is built from
 * {@link resolveUiCoordinate}, which accepts BOTH the bare target-kind `ui` tag
 * (`["ui","42"]`) and the full `31036:<pubkey>:<kind>` coordinate. The
 * swap-defense guard inside {@link guardedRenderDispatch}, however, is authored
 * against the FULL coordinate (core's `getUiCoordinate`) and fails closed
 * (→ generative) on a bare-only `ui` tag. So branches 2/3 light up for events
 * carrying the full coordinate (the canonical renderer-aware form); a bare-only
 * `ui` tag still resolves a query but the guard routes it to the safe generative
 * branch. This mirrors the guard being the security-authoritative gate.
 */

import { useEffect, useState } from 'react';
import {
  guardedRenderDispatch,
  resolveUiCoordinate,
  type DispatchGuardInfo,
  type KindRegistry,
  type RenderDecision,
  type RendererPinStore,
  UI_RENDERER_KIND,
} from '@toon-protocol/client/render';
import { type NostrEvent } from '../types.js';
import { type ViewBridge } from '../app-bridge/types.js';
import { type Atom } from '../atoms/types.js';
import { QUERY_TOOL } from '../tool-names.js';

/**
 * Build the `toon_query` filter that fetches the candidate `kind:31036`
 * renderers for an event's `ui` coordinate. Returns `undefined` when the event
 * carries no usable `ui` tag (nothing to resolve — branch 4 territory).
 *
 * The filter is author-bound to the event author (the authoritative renderer
 * author, per toon#36) and pinned to the target kind via the `#d` tag, mirroring
 * the coordinate the swap-defense guard re-derives — so the relay returns only
 * the revisions that can legitimately win.
 */
export function rendererQueryFilter(
  event: NostrEvent
): { kinds: number[]; authors: string[]; '#d': string[] } | undefined {
  const coord = resolveUiCoordinate(event);
  if (!coord) return undefined;
  return {
    kinds: [UI_RENDERER_KIND],
    authors: [coord.pubkey],
    '#d': [String(coord.targetKind)],
  };
}

/** The outcome of {@link useRenderDecision}. */
export interface RenderResolution {
  /** The dispatch decision, or `null` while a renderer fetch is in flight. */
  decision: RenderDecision<Atom> | null;
  /** Set when the swap-defense guard refused a renderer (the gradient fell back). */
  guard?: DispatchGuardInfo;
  /** `true` while the renderer query round-trip is in flight. */
  loading: boolean;
}

/**
 * Resolve an event to a {@link RenderDecision} through the render trust gradient.
 *
 * Known kinds resolve synchronously to branch 1 (native) — no bridge call. For
 * an unknown kind with a `ui` coordinate, the candidate renderers are fetched
 * over the bridge and the guarded dispatch picks the branch once they arrive;
 * until then `loading` is `true` and `decision` is `null`. Unknown kinds with no
 * `ui` tag resolve immediately to branch 4 (generative).
 */
export function useRenderDecision(
  event: NostrEvent,
  bridge: ViewBridge,
  registry: KindRegistry<Atom>,
  pins: RendererPinStore
): RenderResolution {
  const [resolution, setResolution] = useState<RenderResolution>(() => {
    // Known kind, or no `ui` tag → no fetch needed; decide synchronously so the
    // common path renders on the first frame with no loading flash.
    if (registry.has(event.kind) || rendererQueryFilter(event) === undefined) {
      const { decision, guard } = guardedRenderDispatch({ event }, registry, pins);
      return { decision, ...(guard ? { guard } : {}), loading: false };
    }
    return { decision: null, loading: true };
  });

  useEffect(() => {
    const filter = rendererQueryFilter(event);
    // Known kind or no coordinate: already decided synchronously above; nothing
    // to fetch. (Re-assert in case the event prop changed between renders.)
    if (registry.has(event.kind) || filter === undefined) {
      const { decision, guard } = guardedRenderDispatch({ event }, registry, pins);
      setResolution({ decision, ...(guard ? { guard } : {}), loading: false });
      return;
    }

    let cancelled = false;
    setResolution({ decision: null, loading: true });
    void bridge
      .callTool(QUERY_TOOL, { filter })
      .then((res) => {
        if (cancelled) return;
        const candidates = res.events ?? [];
        const { decision, guard } = guardedRenderDispatch(
          { event, candidates },
          registry,
          pins
        );
        setResolution({ decision, ...(guard ? { guard } : {}), loading: false });
      })
      .catch(() => {
        if (cancelled) return;
        // A failed renderer fetch must never render nothing — fall back to the
        // gradient's safe branch (generative for the unknown kind) with no
        // candidates, exactly as if the relay returned an empty set.
        const { decision, guard } = guardedRenderDispatch({ event }, registry, pins);
        setResolution({ decision, ...(guard ? { guard } : {}), loading: false });
      });
    return () => {
      cancelled = true;
    };
    // `event.id` keys the event; bridge/registry/pins are stable for a session.
  }, [event.id, bridge, registry, pins]);

  return resolution;
}
