/**
 * Renderer-swap defense — the security guard layer around render dispatch
 * (toon-protocol/toon-client#91, part of toon-protocol/toon-meta#58).
 *
 * ── THREAT: "renderer swap" ───────────────────────────────────────────────────
 * A `kind:31036` renderer is an *addressable* event: the coordinate
 * `31036:<author-pubkey>:<targetKind>` can later resolve to a *different* event
 * (different `id`, different content) by publishing a newer-`created_at`
 * revision. Because resolving the `ui` tag yields a renderer that selects the
 * render strategy *and* the trust tier, an attacker who gets a malicious 31036
 * selected can attack the user:
 *
 *   V1. Cross-author substitution — serve a 31036 authored by someone *other*
 *       than the authoritative renderer author, hoping the client renders it.
 *   V2. Forged / tampered renderer — serve a 31036 whose signature does not
 *       verify (mutated tags/content, or no signature at all).
 *   V3. Resolution race / nondeterminism — feed candidate revisions in an order
 *       that makes some clients pick the attacker's revision.
 *   V4. Silent mid-session swap — after a renderer has been pinned for an event,
 *       publish a newer revision (new `id`) to swap the active renderer out from
 *       under an already-decided render, especially to *downgrade trust* (e.g.
 *       push a benign event into a hostile low-trust widget).
 *
 * Per toon#36 decisions: the renderer-author pubkey is the **event author** (the
 * `pubkey` of the event being rendered), and clients MUST re-verify the 31036
 * signature before it can select a render strategy.
 *
 * ── DEFENSE (this module) ─────────────────────────────────────────────────────
 * {@link verifyRendererTrust} is a guard placed *between* renderer resolution and
 * {@link renderDispatch}. It **fails closed**: on any violation it returns a
 * rejection and the caller drops to the safe branch (native for known kinds,
 * generative for unknown kinds) — it never renders the suspect renderer.
 *
 *   - **Author binding (closes V1):** the resolved 31036's `pubkey` MUST equal
 *     the authoritative renderer author (the rendered event's `pubkey`). The
 *     coordinate's `pubkey` segment is also checked, so a coordinate pointing at
 *     a third-party author is refused before any fetch is trusted.
 *   - **Signature verification (closes V2):** the 31036 event signature is
 *     re-verified with {@link verifyEvent}; a tampered/unsigned renderer is
 *     refused.
 *   - **Deterministic selection (closes V3):** candidates are collapsed with
 *     {@link selectLatestAddressable} (latest `created_at`, lowest-`id`
 *     tiebreak), so selection is not attacker-race-controllable.
 *   - **Anti-swap pinning + downgrade detection (closes V4):** the chosen
 *     renderer `id` and its trust tier are pinned per coordinate in a
 *     {@link RendererPinStore}. A later revision with a *different* `id` is a
 *     detected swap; if it would *lower* the trust tier the swap is refused
 *     (fail closed). High-trust kinds use the issue's stricter rule: any `id`
 *     change at all → refuse and fall back to the native component.
 *
 * ── RELATION TO {@link import('./resolveRenderer.js').resolveUiRenderer} ───────
 * `resolveRenderer.ts` (#97) is the plain, stateless `ui`→`kind:31036` resolver:
 * author-bound coordinate, latest-addressable selection, signature re-verify,
 * returning the renderer or `undefined`. This guard shares the SAME core
 * primitives it builds on — `getUiCoordinate` / `selectLatestAddressable` (now
 * from `@toon-protocol/core`) and `verifyEvent` — so the two agree bit-for-bit
 * on which revision a coordinate selects and on signature acceptance. The guard
 * adds what the plain resolver deliberately omits: a stateful anti-swap pin
 * store, trust-downgrade / high-trust id-change detection, and *granular*
 * fail-closed {@link SwapRejectionReason}s (the resolver collapses every failure
 * to `undefined`). It is therefore a strict superset, not a parallel copy.
 */

import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
// The `ui` coordinate primitives now live in `@toon-protocol/core@1.6.0` (#97
// dropped the local `constants.ts` mirror). The pure resolution/selection
// helpers (`getUiCoordinate` / `selectLatestAddressable`) are shared verbatim
// with `./resolveRenderer.js`, so the swap-defense guard and the plain resolver
// agree bit-for-bit on which `kind:31036` revision a coordinate selects — the
// guard layers anti-swap pinning + fail-closed *granular* rejection reasons on
// top of that same selection, rather than re-deriving it.
import {
  UI_RENDERER_KIND,
  getUiCoordinate,
  selectLatestAddressable,
  type UiCoordinate,
} from '@toon-protocol/core';
import type { KindRegistry } from './KindRegistry.js';
import type { RenderTrust } from './types.js';

/** Ordering of the trust tiers; higher number = more trusted. */
const TRUST_RANK: Record<RenderTrust, number> = { low: 0, medium: 1, full: 2 };

/** Whether trust tier `next` is strictly lower than `prev` (a downgrade). */
export function isTrustDowngrade(
  prev: RenderTrust,
  next: RenderTrust
): boolean {
  return TRUST_RANK[next] < TRUST_RANK[prev];
}

/** Why a renderer was refused. Stable string values, safe to log. */
export type SwapRejectionReason =
  /** No `ui` coordinate on the event, or it was malformed. */
  | 'no-coordinate'
  /** The coordinate's author segment is not the rendered event's author. */
  | 'coordinate-author-mismatch'
  /** No candidate `kind:31036` renderer resolved for the coordinate. */
  | 'no-renderer'
  /** The resolved event is not a `kind:31036` renderer. */
  | 'not-a-renderer'
  /** The resolved renderer's `pubkey` is not the authoritative author. */
  | 'author-mismatch'
  /** The renderer's `d` tag does not match the coordinate's target kind. */
  | 'target-kind-mismatch'
  /** The renderer signature did not verify (tampered / unsigned). */
  | 'bad-signature'
  /** A high-trust kind's pinned renderer `id` changed (issue rule: refuse). */
  | 'high-trust-id-changed'
  /** The swap would lower the trust tier from the pinned tier. */
  | 'trust-downgrade';

/** A renderer refused by the guard. The caller must fall back, not render. */
export interface SwapRejection {
  ok: false;
  reason: SwapRejectionReason;
  /** Human-readable detail for logging. */
  detail: string;
  /** The coordinate involved, when one was resolvable. */
  coordinate?: UiCoordinate;
}

/** A renderer the guard approved for dispatch. */
export interface SwapApproval {
  ok: true;
  /** The verified, author-bound, deterministically-selected renderer. */
  renderer: NostrEvent;
  /** The coordinate the renderer was selected for. */
  coordinate: UiCoordinate;
  /** Whether this approval newly pinned the coordinate (first sighting). */
  pinned: boolean;
  /** Set when an `id` swap was observed but allowed (non-downgrading). */
  swapObserved?: boolean;
}

export type SwapDecision = SwapApproval | SwapRejection;

/**
 * A pinned renderer decision for one coordinate: the `id` we committed to and
 * the trust tier it implied. Used to detect swaps and downgrades.
 */
export interface RendererPin {
  /** The pinned `kind:31036` event id. */
  id: string;
  /** The trust tier the pinned renderer selected. */
  trust: RenderTrust;
}

/**
 * Pins the chosen renderer per coordinate so a later replaceable `kind:31036`
 * cannot silently swap the active renderer mid-session. Keyed by the canonical
 * coordinate string `31036:<pubkey>:<targetKind>`.
 *
 * In-memory by default; a host may seed pins from config (the issue's
 * "allowlist high-trust renderers by event id" — pre-populate the expected `id`
 * for a known kind) via {@link pin}.
 */
export class RendererPinStore {
  private readonly byCoord = new Map<string, RendererPin>();

  private static key(coord: UiCoordinate): string {
    return `${coord.kind}:${coord.pubkey}:${coord.targetKind}`;
  }

  /** The pin for `coord`, or `undefined` if not yet pinned. */
  get(coord: UiCoordinate): RendererPin | undefined {
    return this.byCoord.get(RendererPinStore.key(coord));
  }

  /** Pin (or overwrite) the renderer decision for `coord`. */
  pin(coord: UiCoordinate, decision: RendererPin): this {
    this.byCoord.set(RendererPinStore.key(coord), { ...decision });
    return this;
  }

  /** Whether `coord` is pinned. */
  has(coord: UiCoordinate): boolean {
    return this.byCoord.has(RendererPinStore.key(coord));
  }

  /** Number of pinned coordinates. */
  get size(): number {
    return this.byCoord.size;
  }
}

/** The trust tier a renderer's `m` (mimeType) tag selects, or `undefined`. */
function rendererTrust(renderer: NostrEvent): RenderTrust | undefined {
  const mime = renderer.tags.find((t) => t[0] === 'm')?.[1];
  if (mime === 'application/a2ui+json') return 'medium';
  if (mime === 'text/html;profile=mcp-app') return 'low';
  return undefined;
}

/** The renderer's `d` (target kind) tag, parsed, or `undefined`. */
function rendererTargetKind(renderer: NostrEvent): number | undefined {
  const d = renderer.tags.find((t) => t[0] === 'd')?.[1];
  if (d === undefined || !/^\d+$/.test(d)) return undefined;
  return Number(d);
}

/** Input to {@link verifyRendererTrust}. */
export interface VerifyRendererInput<C> {
  /** The event whose renderer is being resolved. Its `pubkey` is authoritative. */
  event: NostrEvent;
  /**
   * The candidate `kind:31036` renderer(s) fetched for the event's `ui`
   * coordinate. May contain multiple revisions; the guard picks the winner
   * deterministically. The caller does not pre-select.
   */
  candidates: readonly NostrEvent[];
  /** The branch-1 native registry; used to decide which kinds are "high trust". */
  registry: KindRegistry<C>;
  /** The pin store enforcing stable, anti-swap selection across resolutions. */
  pins: RendererPinStore;
  /**
   * Signature verifier (defaults to nostr-tools `verifyEvent`). Injectable so
   * tests can exercise the fail-closed path deterministically.
   */
  verify?: (event: NostrEvent) => boolean;
  /**
   * Treat the event's kind as a "high-trust" kind subject to the issue's strict
   * id-allowlist rule (any `id` change → refuse, fall back to native). Defaults
   * to "the registry has a native component for this kind", matching the spec:
   * branch-1 known kinds are the high-trust set. A host may override.
   */
  isHighTrustKind?: (kind: number) => boolean;
}

/**
 * Guard a renderer before it can select a render strategy. Runs author binding,
 * signature verification, deterministic selection, and anti-swap / downgrade
 * detection. **Fails closed**: any violation returns a {@link SwapRejection} and
 * the caller must drop to the safe branch rather than render.
 *
 * On approval, the chosen renderer is pinned for its coordinate so a subsequent
 * resolution that yields a different `id` is detected (and, if it would downgrade
 * trust, refused).
 */
export function verifyRendererTrust<C>(
  input: VerifyRendererInput<C>
): SwapDecision {
  const { event, candidates, registry, pins } = input;
  const verify = input.verify ?? verifyEvent;
  const isHighTrustKind =
    input.isHighTrustKind ?? ((kind: number) => registry.has(kind));

  // The authoritative renderer author is the rendered EVENT's author (toon#36).
  const authorPubkey = event.pubkey;

  // 0. The event must carry a well-formed `ui` coordinate.
  const coordinate = getUiCoordinate(event);
  if (coordinate === null) {
    return {
      ok: false,
      reason: 'no-coordinate',
      detail: 'event has no parseable ui tag',
    };
  }

  // Author binding (V1), checked at the coordinate level first: a coordinate
  // pointing at a third party is refused before we trust any fetched event.
  if (coordinate.pubkey !== authorPubkey) {
    return {
      ok: false,
      reason: 'coordinate-author-mismatch',
      detail: `ui coordinate author ${coordinate.pubkey} != event author ${authorPubkey}`,
      coordinate,
    };
  }

  // 1. Deterministic selection (V3): collapse all candidates to the single
  //    winning revision — latest created_at, lowest-id tiebreak — but only among
  //    candidates that actually match this coordinate (right kind + author +
  //    target kind), so a foreign revision cannot influence the pick.
  const matching = candidates.filter(
    (c) =>
      c.kind === UI_RENDERER_KIND &&
      c.pubkey === authorPubkey &&
      rendererTargetKind(c) === coordinate.targetKind
  );
  const renderer = selectLatestAddressable([...matching]);
  if (renderer === undefined) {
    return {
      ok: false,
      reason: 'no-renderer',
      detail: 'no candidate matched the coordinate',
      coordinate,
    };
  }

  // 2. Structural checks on the selected renderer (defence in depth — the filter
  //    above already enforces these, but assert them explicitly so a future
  //    refactor cannot quietly weaken the guarantee).
  if (renderer.kind !== UI_RENDERER_KIND) {
    return {
      ok: false,
      reason: 'not-a-renderer',
      detail: `kind ${renderer.kind} != ${UI_RENDERER_KIND}`,
      coordinate,
    };
  }
  if (renderer.pubkey !== authorPubkey) {
    return {
      ok: false,
      reason: 'author-mismatch',
      detail: `renderer author ${renderer.pubkey} != event author ${authorPubkey}`,
      coordinate,
    };
  }
  if (rendererTargetKind(renderer) !== coordinate.targetKind) {
    return {
      ok: false,
      reason: 'target-kind-mismatch',
      detail: `renderer d != coordinate target kind ${coordinate.targetKind}`,
      coordinate,
    };
  }

  // 3. Signature verification (V2): re-verify before the renderer can select a
  //    strategy. A tampered or unsigned renderer fails closed.
  let signatureOk: boolean;
  try {
    signatureOk = verify(renderer);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return {
      ok: false,
      reason: 'bad-signature',
      detail: `renderer ${renderer.id} signature did not verify`,
      coordinate,
    };
  }

  // 4. Anti-swap pinning + downgrade detection (V4).
  const trust = rendererTrust(renderer);
  // Renderers with an unrecognised `m` tag select no branch; treat as low trust
  // for downgrade math so they can never be used to *raise* a later pin's floor.
  const effectiveTrust: RenderTrust = trust ?? 'low';
  const existing = pins.get(coordinate);
  const highTrust = isHighTrustKind(event.kind);

  if (existing === undefined) {
    // First sighting for this coordinate — establish the pin.
    pins.pin(coordinate, { id: renderer.id, trust: effectiveTrust });
    return { ok: true, renderer, coordinate, pinned: true };
  }

  if (existing.id === renderer.id) {
    // Same revision as pinned — stable, no swap.
    return { ok: true, renderer, coordinate, pinned: false };
  }

  // The `id` changed under a stable coordinate: this is a swap.
  if (highTrust) {
    // Issue rule for high-trust (branch-1 known) kinds: never silently render a
    // new id. Refuse so the caller falls back to the native component.
    return {
      ok: false,
      reason: 'high-trust-id-changed',
      detail: `high-trust kind ${event.kind}: pinned renderer ${existing.id} swapped to ${renderer.id}`,
      coordinate,
    };
  }

  if (isTrustDowngrade(existing.trust, effectiveTrust)) {
    // A trust-lowering swap (e.g. medium A2UI → low sandboxed/unknown). Refuse:
    // the user already saw content at the higher tier; do not silently demote.
    return {
      ok: false,
      reason: 'trust-downgrade',
      detail: `swap would downgrade trust ${existing.trust} → ${effectiveTrust} for coordinate ${coordinate.pubkey}:${coordinate.targetKind}`,
      coordinate,
    };
  }

  // A non-downgrading swap of a low-trust kind: allowed, but re-pin and flag so
  // the host can surface "renderer updated" through the trust gradient again.
  pins.pin(coordinate, { id: renderer.id, trust: effectiveTrust });
  return { ok: true, renderer, coordinate, pinned: false, swapObserved: true };
}
