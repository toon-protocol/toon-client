/**
 * ViewSpec composition runtime.
 *
 * Interprets a (model-authored, validated) ViewSpec into a React tree using the
 * atom registry. Data binds resolve via the {@link ViewBridge} (free reads);
 * write actions are wired to the bridge. Unknown atom ids / invalid specs
 * degrade to the generic fallback — never crash, never `eval`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { type Atom, type ActionOutcome, type AtomAction, type AtomStatus } from './atoms/types.js';
import { useRenderDecision } from './render/resolve.js';
import { A2UIRenderer } from './a2ui/A2UIRenderer.js';
import { SandboxedAppRenderer } from './mcp-ui/SandboxedAppRenderer.js';
import { DEFAULT_MCP_UI_SANDBOX_URL } from './mcp-ui/sandbox.js';
import { QUERY_TOOL, STATUS_TOOL, WRITE_TOOLS } from './tool-names.js';

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

function useBind(bind: ViewBind | undefined, bridge: ViewBridge): NostrEvent[] {
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const bindKey = bind ? JSON.stringify(bind) : '';

  useEffect(() => {
    const filter = bind?.query ?? (bind?.eventId ? { ids: [bind.eventId] } : undefined);
    if (!filter) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void bridge.callTool(QUERY_TOOL, { filter }).then((res) => {
      if (!cancelled && res.events) setEvents(res.events);
    });
    return () => {
      cancelled = true;
    };
    // bindKey captures the (serialized) bind; bridge is stable for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindKey, bridge]);

  return events;
}

function buildActions(node: ViewNode, bridge: ViewBridge): Record<string, AtomAction> {
  const actions: Record<string, AtomAction> = {};
  for (const [name, ref] of Object.entries(node.actions ?? {})) {
    actions[name] = async (runtimeArgs): Promise<ActionOutcome> => {
      const args: Record<string, unknown> = { ...(ref.args ?? {}), ...(runtimeArgs ?? {}) };
      if (ref.spendy) {
        const label = ref.confirmLabel ?? 'This action spends to publish. Continue?';
        // Fallback is browser-only; auto-approves in Worker/SSR environments where window is absent.
        const confirmFn =
          bridge.confirm ??
          ((msg: string) =>
            Promise.resolve(typeof window !== 'undefined' ? !!window.confirm(msg) : true));
        const ok = await confirmFn(label);
        if (!ok) {
          bridge.notifyModel(`Action "${name}" cancelled.`);
          return { ok: false, error: 'cancelled' };
        }
        args['spendy'] = true;
      }
      const res = await bridge.callTool(ref.tool, args);
      bridge.notifyModel(
        res.ok ? `Action "${name}" completed.` : `Action "${name}" failed: ${res.error ?? 'unknown'}`
      );
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
function NativeEvent({ atom, event, bridge }: { atom: Atom; event: NostrEvent; bridge: ViewBridge }): ReactNode {
  const Component = atom.Component;
  return (
    <Component
      events={[event]}
      props={{}}
      actions={{}}
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
function EventAtom({ event, bridge }: { event: NostrEvent; bridge: ViewBridge }): ReactNode {
  const { decision, loading } = useRenderDecision(event, bridge, KIND_REGISTRY, RENDERER_PINS);
  const performTool = useMemo(() => bridgePerformTool(bridge), [bridge]);

  if (loading || decision === null) {
    return <div className="p-2 text-xs text-muted-foreground">Resolving renderer…</div>;
  }

  switch (decision.branch) {
    case 'native':
      return <NativeEvent atom={decision.component} event={event} bridge={bridge} />;
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

function NodeView({ node, bridge }: { node: ViewNode; bridge: ViewBridge }): ReactNode {
  const atom = ATOMS.get(node.atom) ?? fallbackAtomFor();
  const events = useBind(node.bind, bridge);
  const actions = useMemo(() => buildActions(node, bridge), [node, bridge]);
  const readStatus = useMemo(() => buildReadStatus(bridge), [bridge]);

  if (node.bind?.kindAuto) {
    return <>{events.map((e) => <EventAtom key={e.id} event={e} bridge={bridge} />)}</>;
  }

  const Component = atom.Component;
  return (
    <Component
      events={events}
      props={node.props ?? {}}
      actions={actions}
      readStatus={readStatus}
      renderEvent={(e) => <EventAtom key={e.id} event={e} bridge={bridge} />}
    >
      {node.children?.map((child, i) => <NodeView key={i} node={child} bridge={bridge} />)}
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
  if (!result.ok) return <InvalidSpec errors={result.errors} />;
  return <NodeView node={result.spec.root} bridge={bridge} />;
}
