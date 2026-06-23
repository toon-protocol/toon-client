/**
 * ViewSpec composition runtime.
 *
 * Interprets a (model-authored, validated) ViewSpec into a React tree using the
 * atom registry. Data binds resolve via the {@link ViewBridge} (free reads);
 * write actions are wired to the bridge. Unknown atom ids / invalid specs
 * degrade to the generic fallback — never crash, never `eval`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  defaultAtomForKind,
  fallbackAtomFor,
} from './atoms/registry.js';
import { type ActionOutcome, type AtomAction, type AtomStatus } from './atoms/types.js';
import { QUERY_TOOL, STATUS_TOOL, WRITE_TOOLS } from './tool-names.js';

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

/** Render a single event through its kind's default atom (feeds / kindAuto). */
function EventAtom({ event }: { event: NostrEvent }): ReactNode {
  const Component = defaultAtomForKind(event.kind).Component;
  return (
    <Component
      events={[event]}
      props={{}}
      actions={{}}
      renderEvent={(e) => <EventAtom key={e.id} event={e} />}
    >
      {null}
    </Component>
  );
}

/** Read the live pay-to-write status (`toon_status`) for the fee-confirm UX. */
function buildReadStatus(bridge: ViewBridge): () => Promise<AtomStatus> {
  return async () => {
    const res = await bridge.callTool(STATUS_TOOL, {});
    const data = (res.data ?? {}) as Partial<AtomStatus>;
    return {
      feePerEvent: typeof data.feePerEvent === 'string' ? data.feePerEvent : '0',
      settlementChain:
        typeof data.settlementChain === 'string' ? data.settlementChain : 'unknown',
      ...(typeof data.asset === 'string' ? { asset: data.asset } : {}),
    };
  };
}

function NodeView({ node, bridge }: { node: ViewNode; bridge: ViewBridge }): ReactNode {
  const atom = ATOMS.get(node.atom) ?? fallbackAtomFor();
  const events = useBind(node.bind, bridge);
  const actions = useMemo(() => buildActions(node, bridge), [node, bridge]);
  const readStatus = useMemo(() => buildReadStatus(bridge), [bridge]);

  if (node.bind?.kindAuto) {
    return <>{events.map((e) => <EventAtom key={e.id} event={e} />)}</>;
  }

  const Component = atom.Component;
  return (
    <Component
      events={events}
      props={node.props ?? {}}
      actions={actions}
      readStatus={readStatus}
      renderEvent={(e) => <EventAtom key={e.id} event={e} />}
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
