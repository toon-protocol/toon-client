/**
 * `ui`-tag → `kind:31036` renderer resolution (toon#36).
 *
 * This is the resolution seam the {@link renderDispatch} skeleton (#88)
 * deliberately left out: dispatch consumes an *already-resolved* renderer, and
 * this module produces it. It is split out from dispatch so the relay query +
 * cache (which is IO, and lives in the daemon / {@link import('../ToonClient.js')})
 * stays separate from the pure selection logic — mirroring core's own
 * "helpers are pure, resolution is client-local" split.
 *
 * Algorithm, per the toon#36 decisions:
 *
 *   1. Read the rendered event's `ui` tag and parse it into a target coordinate.
 *      The coordinate convention is `31036:<renderer-author-pubkey>:<targetKind>`.
 *      Per toon#36 the **renderer-author pubkey is the EVENT AUTHOR**, so the
 *      `ui` tag MAY carry just the bare target kind (e.g. `42`); the author is
 *      taken from `event.pubkey`. A full `31036:<pubkey>:<kind>` coordinate is
 *      also accepted (via core's `getUiCoordinate`), but its pubkey MUST equal
 *      the event author — a coordinate naming a different author is rejected, so
 *      an event cannot point at a third party's renderer.
 *   2. Filter the caller-supplied `kind:31036` candidates to that coordinate
 *      (author === event author, `d` tag === target kind) and pick the latest
 *      addressable one (NIP-33 latest-wins) via `selectLatestAddressable`.
 *   3. **Re-verify the signature** of the chosen renderer with `verifyEvent`
 *      before trusting it. A renderer that fails verification is dropped (the
 *      resolution returns `undefined`) — the client never feeds an unverified
 *      renderer to the dispatch.
 *
 * The relay query that produces `candidates` is the caller's responsibility:
 * query `kind:31036`, `authors: [event.pubkey]`, `#d: [String(targetKind)]`.
 */

import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  UI_RENDERER_KIND,
  getUiCoordinate,
  parseUiCoordinate,
  selectLatestAddressable,
} from '@toon-protocol/core';

/** Read the first value of the named tag, or `undefined`. */
function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * The renderer coordinate a rendered event points at: a `kind:31036` event
 * authored by the rendered event's author, targeting `targetKind`.
 */
export interface ResolvedCoordinate {
  /** Always {@link UI_RENDERER_KIND} (31036). */
  kind: typeof UI_RENDERER_KIND;
  /** The renderer author pubkey — per toon#36, the EVENT AUTHOR's pubkey. */
  pubkey: string;
  /** The kind of event the renderer targets (the renderer's `d` value). */
  targetKind: number;
}

/**
 * Compute the renderer coordinate a rendered event points at, anchoring the
 * renderer-author pubkey to the **event author** per toon#36.
 *
 * Accepts two `ui` tag shapes:
 *   - a bare target kind, e.g. `["ui", "42"]` → author = `event.pubkey`;
 *   - a full coordinate, e.g. `["ui", "31036:<pubkey>:42"]` → accepted only if
 *     `<pubkey>` equals `event.pubkey` (else `null`).
 *
 * Pure: no IO.
 *
 * @param event - The rendered event that may carry a `ui` tag.
 * @returns The resolved coordinate, or `null` if there is no usable `ui` tag.
 */
export function resolveUiCoordinate(event: NostrEvent): ResolvedCoordinate | null {
  const raw = tagValue(event, 'ui');
  if (raw === undefined) return null;

  // Full `31036:<pubkey>:<kind>` coordinate form.
  const full = getUiCoordinate(event) ?? parseUiCoordinate(raw);
  if (full) {
    // The coordinate must name the event author — no third-party renderers.
    if (full.pubkey !== event.pubkey) return null;
    return { kind: UI_RENDERER_KIND, pubkey: event.pubkey, targetKind: full.targetKind };
  }

  // Bare target-kind form: the author is the event author.
  const targetKind = Number(raw);
  if (!Number.isInteger(targetKind) || targetKind < 0) return null;
  return { kind: UI_RENDERER_KIND, pubkey: event.pubkey, targetKind };
}

/**
 * Resolve a rendered event's `ui` tag to a verified `kind:31036` renderer.
 *
 * Filters `candidates` to the coordinate computed by {@link resolveUiCoordinate},
 * picks the latest addressable match, and **re-verifies its signature** before
 * returning it. The result feeds {@link renderDispatch} as `DispatchInput.renderer`.
 *
 * @param event      - The rendered event carrying the `ui` tag.
 * @param candidates - `kind:31036` events the caller fetched for this coordinate
 *                     (the relay query is the caller's responsibility).
 * @returns The latest verified renderer, or `undefined` if none resolves /
 *          verifies.
 */
export function resolveUiRenderer(
  event: NostrEvent,
  candidates: readonly NostrEvent[]
): NostrEvent | undefined {
  const coord = resolveUiCoordinate(event);
  if (!coord) return undefined;

  const matches = candidates.filter(
    (c) =>
      c.kind === UI_RENDERER_KIND &&
      c.pubkey === coord.pubkey &&
      tagValue(c, 'd') === String(coord.targetKind)
  );

  const latest = selectLatestAddressable(matches);
  if (!latest) return undefined;

  // Re-verify the resolved renderer's signature before trusting it (toon#36).
  if (!verifyEvent(latest)) return undefined;

  return latest;
}
