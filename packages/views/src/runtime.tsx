/**
 * ViewSpec composition runtime.
 *
 * Interprets a (model-authored, validated) ViewSpec into a React tree using the
 * atom registry. Data binds resolve via the {@link ViewBridge} (free reads);
 * write actions are wired to the bridge. Unknown atom ids / invalid specs
 * degrade to the generic fallback — never crash, never `eval`.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  extractUiResource,
  GenerativeFallbackRenderer,
  RendererPinStore,
  type GenerativeFallbackResult,
} from '@toon-protocol/client/render';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type NostrEvent } from './types.js';
import { type ViewBridge } from './app-bridge/types.js';
import {
  type ViewBind,
  type ViewNode,
  validateViewSpec,
} from './spec.js';
import {
  ATOMS,
  ATOM_IDS,
  buildKindRegistry,
  fallbackAtomFor,
} from './atoms/registry.js';
import {
  type Atom,
  type ActionOutcome,
  type AtomAction,
  type AtomStatus,
  type AtomChannel,
  type AtomBalance,
  SPENDY_CANCELLED,
} from './atoms/types.js';
import { ConsentProvider, useConsentGate, type ConsentGate } from './spendy-consent.js';
import {
  BudgetProvider,
  useEngagementGate,
  type EngagementGate,
} from './engagement-budget.js';
import { SurfaceProvider, useSurface } from './surface.js';
import { type NostrFilterLike } from './paging.js';
import { useRenderDecision } from './render/resolve.js';
import { A2UIRenderer } from './a2ui/A2UIRenderer.js';
import { SandboxedAppRenderer } from './mcp-ui/SandboxedAppRenderer.js';
import { DEFAULT_MCP_UI_SANDBOX_URL } from './mcp-ui/sandbox.js';
import {
  BALANCES_TOOL,
  CHANNELS_TOOL,
  PUBLISH_TOOL,
  QUERY_TOOL,
  STATUS_TOOL,
  UPLOAD_TOOL,
  WRITE_TOOLS,
} from './tool-names.js';
import { useRefreshTick } from './atoms/use-refresh.js';

/**
 * Session-scoped render-gradient state. Built once per bundle load:
 *   - the branch-1 native {@link KindRegistry} of atoms, and
 *   - the anti-swap {@link RendererPinStore} that pins each coordinate's chosen
 *     renderer for the life of the session (the swap-defense's V4 guard).
 * Both are stable across renders so `guardedRenderDispatch` sees a consistent
 * registry/pin store and the swap-defense pins persist.
 */
const KIND_REGISTRY = buildKindRegistry();
const RENDERER_PINS = new RendererPinStore();
/**
 * The branch-4 generative fallback. Uses the deterministic generator (no model
 * is wired in the app yet — the injected-generator seam stays available) and
 * publish-back stays OFF (no `publish` option). See toon-meta#58.
 */
const GENERATIVE_FALLBACK = new GenerativeFallbackRenderer();

// Re-export so existing importers (and tests) can keep importing from the runtime.
export { QUERY_TOOL, WRITE_TOOLS } from './tool-names.js';
// Exported for unit tests (the `toon_balances` contract guard, see #200).
export { buildReadBalances, parseBalancesPayload };

/**
 * Order events deterministically by `created_at` (ties break on `id`) so render
 * order never depends on relay return order or how buffered + streamed events
 * happen to merge. Default `'desc'` gives reverse-chronological feeds
 * (newest-first); `'asc'` gives oldest-first for threads. The base comparator is
 * ascending and stable; `'desc'` reverses it so the tie-break stays consistent.
 */
function sortEvents(events: readonly NostrEvent[], dir: 'asc' | 'desc' = 'desc'): NostrEvent[] {
  const ascending = [...events].sort((a, b) =>
    a.created_at !== b.created_at
      ? a.created_at - b.created_at
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0
  );
  return dir === 'asc' ? ascending : ascending.reverse();
}

function useBind(
  bind: ViewBind | undefined,
  bridge: ViewBridge,
  refreshNonce?: number
): NostrEvent[] {
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const bindKey = bind ? JSON.stringify(bind) : '';
  const sortDir = bind?.sort ?? 'desc';
  // Re-query the feed after a successful write (post/react/follow): immediate +
  // a short settlement delay so relay-propagated events that land a beat later
  // still appear without the agent re-rendering.
  const refreshTick = useRefreshTick(refreshNonce);

  useEffect(() => {
    const filter = bind?.query ?? (bind?.eventId ? { ids: [bind.eventId] } : undefined);
    if (!filter) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void bridge.callTool(QUERY_TOOL, { filter }).then((res) => {
      if (!cancelled && res.events) setEvents(sortEvents(res.events, sortDir));
    });
    return () => {
      cancelled = true;
    };
    // bindKey captures the (serialized) bind; bridge is stable for a session;
    // refreshTick re-runs the query after a successful mutation.
  }, [bindKey, bridge, refreshTick]);

  return events;
}

/**
 * Lazy, session-cached author-profile resolver.
 *
 * A feed bind queries `kinds:[1]` only, so the note atoms never receive the
 * authors' kind:0 metadata in their own `events`. This seam lets an atom pull an
 * author's kind:0 on demand (a free read), keeping atoms off the bridge. The
 * per-pubkey promise is memoized so a feed of N notes by the same author issues
 * one query, and a missing profile resolves to `null` (the placeholder path).
 */
function makeProfileResolver(
  bridge: ViewBridge
): (pubkey: string) => Promise<NostrEvent | null> {
  const cache = new Map<string, Promise<NostrEvent | null>>();
  return (pubkey) => {
    const hit = cache.get(pubkey);
    if (hit) return hit;
    const pending = bridge
      .callTool(QUERY_TOOL, { filter: { kinds: [0], authors: [pubkey] } })
      .then((res) => {
        let latest: NostrEvent | null = null;
        for (const e of res.events ?? []) {
          if (e.kind === 0 && (latest === null || e.created_at > latest.created_at)) {
            latest = e;
          }
        }
        return latest;
      })
      .catch(() => null);
    cache.set(pubkey, pending);
    return pending;
  };
}

/**
 * One resolver (and thus one profile cache) per bridge/session, shared across
 * every atom and every per-event `kindAuto` render so the cache actually hits.
 */
const PROFILE_RESOLVERS = new WeakMap<
  ViewBridge,
  (pubkey: string) => Promise<NostrEvent | null>
>();
function getProfileResolver(
  bridge: ViewBridge
): (pubkey: string) => Promise<NostrEvent | null> {
  let resolver = PROFILE_RESOLVERS.get(bridge);
  if (!resolver) {
    resolver = makeProfileResolver(bridge);
    PROFILE_RESOLVERS.set(bridge, resolver);
  }
  return resolver;
}

/**
 * Event kinds that count as cheap ENGAGEMENT micro-writes: NIP-02 follow
 * (kind:3), NIP-18 repost (kind:6) and NIP-25 reaction/like (kind:7). These all
 * publish via `toon_publish_unsigned` — the same tool as compose (kind:1) and
 * profile-edit (kind:0) — so engagement can't be told apart by TOOL NAME. It's
 * the action SEMANTICS (the event kind) that mark it, so the budget is scoped by
 * the published kind rather than the tool: compose/profile-edit stay per-action
 * consent, while like/follow/repost flow through the session budget gate.
 */
const ENGAGEMENT_KINDS: ReadonlySet<number> = new Set([3, 6, 7]);

/** True if a spendy publish is a cheap engagement micro-write (like/follow/repost). */
function isEngagementWrite(tool: string, args: Record<string, unknown>): boolean {
  return tool === PUBLISH_TOOL && typeof args['kind'] === 'number' && ENGAGEMENT_KINDS.has(args['kind']);
}

function buildActions(
  node: ViewNode,
  bridge: ViewBridge,
  consentGate: ConsentGate,
  engagementGate: EngagementGate,
  onMutated?: () => void
): Record<string, AtomAction> {
  const actions: Record<string, AtomAction> = {};
  for (const [name, ref] of Object.entries(node.actions ?? {})) {
    actions[name] = async (runtimeArgs): Promise<ActionOutcome> => {
      const args: Record<string, unknown> = { ...(ref.args ?? {}), ...(runtimeArgs ?? {}) };
      if (ref.spendy) {
        const label = ref.confirmLabel ?? 'This action spends to publish. Continue?';
        // Consent for a spend is a RENDERED prompt, not `window.confirm`: the app
        // runs in a host iframe sandboxed without `allow-modals`, where
        // `window.confirm` is suppressed (returns false) and silently
        // auto-rejects every spend (toon-client#170). Prefer the bridge's
        // injected confirm (tests/host), else the in-iframe consent modal.
        const confirmFn = bridge.confirm ?? consentGate;
        // Cheap engagement micro-writes (like/follow/repost) go through the
        // pre-authorized SESSION BUDGET instead of a per-action prompt: the user
        // approves a small allowance once, then these debit silently until it's
        // spent. Bigger writes (compose/upload/swap/channel ops) keep per-action
        // consent. A host-injected `confirm` is the host's own gate and always
        // wins; the budget is an in-iframe concept, so it only applies when there
        // is no injected confirm.
        const gate = !bridge.confirm && isEngagementWrite(ref.tool, args) ? engagementGate : confirmFn;
        // Per-event writes (publish/upload) show the live pay-to-write fee in the
        // prompt; swaps/channel ops carry their own amount in the label instead.
        const showWriteFee = ref.tool === PUBLISH_TOOL || ref.tool === UPLOAD_TOOL;
        const ok = await gate(label, { showWriteFee });
        if (!ok) {
          bridge.notifyModel(`Action "${name}" cancelled.`);
          return { ok: false, error: SPENDY_CANCELLED };
        }
        args['spendy'] = true;
      }
      const res = await bridge.callTool(ref.tool, args);
      bridge.notifyModel(
        res.ok ? `Action "${name}" completed.` : `Action "${name}" failed: ${res.error ?? 'unknown'}`
      );
      // On a SUCCESSFUL write, bump the view's refresh signal so read-bearing
      // atoms (balances/channels/status/feed) re-fetch in place. A declined
      // spendy confirm returns early above (no refresh); a tool FAILURE has
      // `res.ok === false`, so stale data is never re-read on a no-op. Funding
      // returns `status:'pending'` with `ok===true` — still a valid refresh;
      // the settlement-delayed re-poll (useRefreshTick) catches the late drip.
      if (res.ok) onMutated?.();
      // Surface the real published id so atoms can render an accurate receipt.
      // The publish/upload tools return `{ eventId, … }` as `structuredContent`,
      // which the bridge carries on `ToolOutcome.data`.
      const eventId =
        res.data && typeof res.data === 'object' && 'eventId' in res.data
          ? String((res.data as { eventId: unknown }).eventId)
          : undefined;
      return {
        ok: res.ok,
        ...(eventId ? { eventId } : {}),
        ...(res.data !== undefined ? { data: res.data } : {}),
        ...(res.error ? { error: res.error } : {}),
      };
    };
  }
  return actions;
}

/** Render an event with a resolved branch-1 native atom (full trust). */
function NativeEvent({
  atom,
  event,
  bridge,
  actions = {},
}: {
  atom: Atom;
  event: NostrEvent;
  bridge: ViewBridge;
  actions?: Record<string, AtomAction>;
}): ReactNode {
  const Component = atom.Component;
  return (
    <Component
      events={[event]}
      props={{}}
      actions={actions}
      resolveProfile={getProfileResolver(bridge)}
      renderEvent={(e) => <EventAtom key={e.id} event={e} bridge={bridge} />}
    >
      {null}
    </Component>
  );
}

/** Branch 4 — generative fallback (low trust). Renders the deterministic HTML. */
function GenerativeEvent({ event }: { event: NostrEvent }): ReactNode {
  const [result, setResult] = useState<GenerativeFallbackResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    void GENERATIVE_FALLBACK.render(event).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [event]);

  if (!result) {
    return <div className="p-2 text-xs text-muted-foreground">Rendering…</div>;
  }
  // The deterministic generator emits trusted, host-built HTML (no widget code);
  // it is safe to render directly. (A model-backed generator would route through
  // the sandbox like branch 3 — not wired in the app yet.)
  return (
    <div
      data-branch="generative"
      data-trust={result.trust}
      dangerouslySetInnerHTML={{ __html: result.rendered.html }}
    />
  );
}

/** Adapt the app bridge into the branch-3 `onPerform` (authorized tool runner). */
function bridgePerformTool(
  bridge: ViewBridge
): (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (toolName, args) => {
    const res = await bridge.callTool(toolName, args);
    return {
      ...(res.error ? { isError: true } : {}),
      content: [{ type: 'text', text: res.error ?? 'ok' }],
      ...(res.data !== undefined ? { structuredContent: res.data as Record<string, unknown> } : {}),
    };
  };
}

/**
 * Render a single incoming event through the NIP-on-TOON render trust gradient
 * (feeds / kindAuto). Branch 1 (known kind) renders the native atom; branches
 * 2/3/4 render through the resolved `kind:31036` renderer (A2UI / sandboxed
 * mcp-ui) or the generative fallback — guarded by the swap-defense + consent.
 */
function EventAtom({
  event,
  bridge,
  actions,
}: {
  event: NostrEvent;
  bridge: ViewBridge;
  actions?: Record<string, AtomAction>;
}): ReactNode {
  const { decision, loading } = useRenderDecision(event, bridge, KIND_REGISTRY, RENDERER_PINS);
  const performTool = useMemo(() => bridgePerformTool(bridge), [bridge]);

  if (loading || decision === null) {
    return <div className="p-2 text-xs text-muted-foreground">Resolving renderer…</div>;
  }

  switch (decision.branch) {
    case 'native':
      return (
        <NativeEvent atom={decision.component} event={event} bridge={bridge} actions={actions} />
      );
    case 'a2ui':
      // Branch 2: medium trust. On a gate refusal the renderer signals fallback;
      // drop to the generative branch (per the gate's signal) so a refused A2UI
      // surface still renders something safe rather than nothing.
      return (
        <A2UIBranch renderer={decision.renderer} event={event} />
      );
    case 'mcp-ui':
      // Branch 3: low trust, sandboxed iframe + host-rendered consent prompt.
      return <McpUiBranch renderer={decision.renderer} event={event} performTool={performTool} />;
    case 'generative':
      // Branch 4: low trust, generative fallback (deterministic; no model wired).
      return <GenerativeEvent event={event} />;
    default:
      return <GenerativeEvent event={event} />;
  }
}

/** Branch 2 wrapper: render A2UI, falling back to generative on a gate refusal. */
function A2UIBranch({ renderer, event }: { renderer: NostrEvent; event: NostrEvent }): ReactNode {
  const [refused, setRefused] = useState(false);
  if (refused) return <GenerativeEvent event={event} />;
  return <A2UIRenderer renderer={renderer} event={event} onFallback={() => setRefused(true)} />;
}

/** Branch 3 wrapper: extract the widget resource and render it sandboxed. */
function McpUiBranch({
  renderer,
  event,
  performTool,
}: {
  renderer: NostrEvent;
  event: NostrEvent;
  performTool: (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}): ReactNode {
  const resource = useMemo(() => extractUiResource(renderer), [renderer]);
  // A renderer that doesn't yield a usable widget resource falls back to branch 4.
  if (!resource) return <GenerativeEvent event={event} />;
  return (
    <SandboxedAppRenderer
      resource={resource}
      sandboxUrl={new URL(DEFAULT_MCP_UI_SANDBOX_URL)}
      onPerform={performTool}
    />
  );
}

/** A free paginated read seam (`toon_query`) for feed "load more". */
function buildQuery(bridge: ViewBridge): (filter: NostrFilterLike) => Promise<NostrEvent[]> {
  return async (filter) => {
    const res = await bridge.callTool(QUERY_TOOL, { filter });
    // A load-more failure is non-fatal: return [] so the feed keeps its pages.
    return res.ok ? (res.events ?? []) : [];
  };
}

/** Read the live pay-to-write status (`toon_status`) for the fee-confirm UX. */
function buildReadStatus(bridge: ViewBridge): () => Promise<AtomStatus> {
  return async () => {
    const res = await bridge.callTool(STATUS_TOOL, {});
    const data = (res.data ?? {}) as Partial<AtomStatus>;
    // Throw so the atom catches it as statusError=true and disables Confirm — never
    // silently show '0' for a non-zero charge.
    if (typeof data.feePerEvent !== 'string' || !data.feePerEvent) {
      throw new Error('fee unavailable');
    }
    // Pass the richer daemon-health fields through verbatim (additive over the
    // fee/chain the pay-confirm receipt needs) so the client-status dashboard can
    // render uptime / relay / transport / per-chain readiness / identity from
    // this same single read seam — atoms never call the bridge directly.
    return {
      feePerEvent: data.feePerEvent,
      settlementChain:
        typeof data.settlementChain === 'string' ? data.settlementChain : 'unknown',
      ...(typeof data.asset === 'string' ? { asset: data.asset } : {}),
      ...(typeof data.uptimeMs === 'number' ? { uptimeMs: data.uptimeMs } : {}),
      ...(typeof data.ready === 'boolean' ? { ready: data.ready } : {}),
      ...(typeof data.bootstrapping === 'boolean' ? { bootstrapping: data.bootstrapping } : {}),
      ...(data.identity && typeof data.identity === 'object' ? { identity: data.identity } : {}),
      ...(data.transport && typeof data.transport === 'object' ? { transport: data.transport } : {}),
      ...(data.relay && typeof data.relay === 'object' ? { relay: data.relay } : {}),
      ...(Array.isArray(data.network) ? { network: data.network } : {}),
      ...(typeof data.lastError === 'string' ? { lastError: data.lastError } : {}),
    };
  };
}

/** Read the tracked payment channels (`toon_channels`) for the wallet atoms. */
function buildReadChannels(bridge: ViewBridge): () => Promise<AtomChannel[]> {
  return async () => {
    const res = await bridge.callTool(CHANNELS_TOOL, {});
    const data = (res.data ?? {}) as { channels?: AtomChannel[] };
    return Array.isArray(data.channels) ? data.channels : [];
  };
}

/**
 * Validate the `toon_balances` wire contract and project it to the atom's
 * `AtomBalance[]`.
 *
 * The contract (shared with the daemon) is a plain OBJECT
 * `{ balances: AtomBalance[] }` carried via the MCP `structuredContent` →
 * `ToolOutcome.data`. A missing payload (no `structuredContent`), a non-object,
 * a bare array, or a missing / non-array `balances` key is a CONTRACT VIOLATION
 * — a daemon↔views version skew or a transport that dropped the structured
 * content — and must `throw` so it drives the wallet atom's error/retry path.
 *
 * The bug (#200): collapsing any of those violations into the same `[]` as a
 * legitimate empty balance list renders a silent blank card that's
 * indistinguishable from a real zero balance, with no retry. Only a genuine
 * `{ balances: [] }` (an empty wallet) is a valid success that returns `[]`.
 */
function parseBalancesPayload(data: unknown): AtomBalance[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    // Missing structuredContent (`undefined`), a bare array, or a primitive.
    throw new Error('Balances response had an unexpected shape.');
  }
  const balances = (data as { balances?: unknown }).balances;
  if (!Array.isArray(balances)) {
    throw new Error('Balances response was missing the "balances" list.');
  }
  return balances as AtomBalance[];
}

/** Read on-chain wallet balances (`toon_balances`) for the wallet atom. */
function buildReadBalances(bridge: ViewBridge): () => Promise<AtomBalance[]> {
  return async () => {
    // The local HTTP control plane behind `toon_balances` can transiently refuse
    // on :8787 while the websocket transport is healthy — it succeeds on
    // immediate retry (toon-client#186). Retry a couple of times before giving
    // up, and THROW on persistent failure so the wallet atom can show an
    // error/retry state instead of a blank card (which is indistinguishable from
    // a real zero balance). `callTool` never throws — it reports `{ ok:false }`.
    let lastError = 'Balances are unavailable.';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await bridge.callTool(BALANCES_TOOL, {});
      if (res.ok) {
        // A SUCCESSFUL call must satisfy the `{ balances: [...] }` contract.
        // This is a SHAPE failure, not a transient transport refuse, so fail
        // fast (no inter-attempt retry) — a version skew won't fix itself, and
        // failing fast avoids amplifying a slow (35s) timeout that resolved
        // `ok` with no structuredContent into 3×35s of spinner (#199).
        return parseBalancesPayload(res.data);
      }
      lastError = res.error ?? lastError;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(lastError);
  };
}

function NodeView({
  node,
  bridge,
  refreshNonce,
  onMutated,
}: {
  node: ViewNode;
  bridge: ViewBridge;
  /** View-wide refresh signal (bumped after a successful write). */
  refreshNonce?: number;
  /** Bump the view-wide refresh signal. Stable for the session. */
  onMutated?: () => void;
}): ReactNode {
  const atom = ATOMS.get(node.atom) ?? fallbackAtomFor();
  const events = useBind(node.bind, bridge, refreshNonce);
  const consentGate = useConsentGate();
  const engagementGate = useEngagementGate();
  const actions = useMemo(
    () => buildActions(node, bridge, consentGate, engagementGate, onMutated),
    [node, bridge, consentGate, engagementGate, onMutated]
  );
  const readStatus = useMemo(() => buildReadStatus(bridge), [bridge]);
  const readChannels = useMemo(() => buildReadChannels(bridge), [bridge]);
  const readBalances = useMemo(() => buildReadBalances(bridge), [bridge]);
  const loadMore = useMemo(() => buildQuery(bridge), [bridge]);
  const surface = useSurface();

  if (node.bind?.kindAuto) {
    // Thread the feed node's actions (reply/react/follow) to each natively
    // rendered event so per-note engagement surfaces in kindAuto feeds. A
    // per-note action bumps this view's refreshNonce → useBind re-queries the
    // feed above, so the engagement shows in place.
    return (
      <>
        {events.map((e) => (
          <EventAtom key={e.id} event={e} bridge={bridge} actions={actions} />
        ))}
      </>
    );
  }

  const Component = atom.Component;
  return (
    <Component
      events={events}
      props={node.props ?? {}}
      actions={actions}
      readStatus={readStatus}
      readChannels={readChannels}
      readBalances={readBalances}
      refreshNonce={refreshNonce}
      resolveProfile={getProfileResolver(bridge)}
      renderEvent={(e) => <EventAtom key={e.id} event={e} bridge={bridge} />}
      bind={node.bind}
      loadMore={loadMore}
      surface={surface}
    >
      {node.children?.map((child, i) => (
        <NodeView key={i} node={child} bridge={bridge} refreshNonce={refreshNonce} onMutated={onMutated} />
      ))}
    </Component>
  );
}

/** Renders an invalid spec's errors without leaking internals to the user. */
function InvalidSpec({ errors }: { errors: string[] }): ReactNode {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <div className="font-medium">This view could not be rendered.</div>
      <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
        {errors.slice(0, 5).map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

/** Top-level: validate an untrusted ViewSpec then render it, or show the error. */
export function ViewSpecRenderer({
  spec,
  bridge,
}: {
  spec: unknown;
  bridge: ViewBridge;
}): ReactNode {
  const result = useMemo(
    () => validateViewSpec(spec, { allowedAtoms: ATOM_IDS, allowedTools: WRITE_TOOLS }),
    [spec]
  );
  // View-wide refresh signal: bumped after every successful write action so
  // read-bearing atoms (balances/channels/status) and feeds re-fetch in place,
  // with no re-render from the agent. `onMutated` is stable (the integer nonce
  // drives re-fetch, not this callback), so it never re-runs reads on render.
  const [refreshNonce, setRefreshNonce] = useState(0);
  const onMutated = useCallback(() => setRefreshNonce((n) => n + 1), []);
  // The consent modal reads the live fee/chain so spendy prompts are specific.
  const readStatus = useMemo(() => buildReadStatus(bridge), [bridge]);
  // useMemo above guarantees `result` is referentially stable across renders, so
  // an early return is safe to place after these hooks.
  if (!result.ok) return <InvalidSpec errors={result.errors} />;
  // Wrap in the consent provider so spendy actions await a rendered prompt
  // (the host iframe blocks `window.confirm`; see consent-prompt.tsx).
  return (
    <SurfaceProvider bridge={bridge}>
      <ConsentProvider readStatus={readStatus}>
        {/* Engagement micro-writes (like/follow/repost) debit a session budget
            instead of prompting per-action; BudgetProvider sits inside the
            consent provider so it can fall back to per-action consent and reuses
            the same status read seam. */}
        <BudgetProvider readStatus={readStatus}>
          <NodeView node={result.spec.root} bridge={bridge} refreshNonce={refreshNonce} onMutated={onMutated} />
        </BudgetProvider>
      </ConsentProvider>
    </SurfaceProvider>
  );
}
