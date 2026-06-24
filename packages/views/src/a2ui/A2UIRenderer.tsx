/**
 * A2UIRenderer — branch 2 of the NIP-on-TOON render trust gradient (medium
 * trust). Renders an A2UI `surfaceUpdate` template, bound to a decoded TOON
 * event as the `dataModelUpdate`, using the client's OWN audited component
 * primitives — never provider code. See toon-meta#58, toon-client#89.
 *
 * Binding convention (spec §"Branch 2"):
 *   - the `kind:31036` renderer `content` = the A2UI `surfaceUpdate` (template),
 *   - the decoded event = the `dataModelUpdate` (data), and
 *   - the `["a2ui", "<version>"]` tag selects the renderer version.
 *
 * Standard-catalog-only invariant: only the A2UI "Basic" catalog is rendered
 * here. {@link validateA2uiRenderer} is the gate; a custom component or custom
 * behavior REFUSES and signals a drop to branch 3 (sandboxed mcp-ui) — this
 * component never renders a refused surface, it renders nothing and reports the
 * fallback via {@link A2UIRendererProps.onFallback}.
 */

import { useMemo, type FC, type ReactNode } from 'react';
import { Separator } from '@/components/ui/separator.js';
import { cn } from '@/lib/utils.js';
import { type NostrEvent } from '../types.js';
import {
  type A2uiComponentNode,
  type A2uiDataModel,
  type A2uiSurfaceUpdate,
} from './types.js';
import { validateA2uiRenderer, type A2uiGateRefuse } from './validate.js';
import { dataModelFromEvent, resolveText, stringProp } from './binding.js';

/** Inputs to {@link A2UIRenderer}, mirroring the branch-2 dispatch decision. */
export interface A2UIRendererProps {
  /**
   * The resolved `kind:31036` renderer event — its `content` is the A2UI
   * `surfaceUpdate` template and its `tags` carry the `["a2ui", …]` version.
   * (The `A2uiDecision.renderer` from `@toon-protocol/client`'s `renderDispatch`.)
   */
  renderer: NostrEvent;
  /**
   * The decoded TOON event fed in as the `dataModelUpdate` root. (The
   * `A2uiDecision.event` — already decoded via `core.decodeEventFromToon`.)
   */
  event: NostrEvent;
  /**
   * Called when the standard-catalog-only gate REFUSES the surface, signalling
   * the host to drop to another branch (`'mcp-ui'` = branch 3, `'native'` =
   * fall through to branch 1/4). The renderer itself renders nothing in this
   * case — the host owns the fallback render.
   */
  onFallback?: (refusal: A2uiGateRefuse) => void;
}

/** Resolve a node's children to component nodes, preserving order. */
function childNodes(
  node: A2uiComponentNode,
  byId: Map<string, A2uiComponentNode>
): A2uiComponentNode[] {
  if (!Array.isArray(node.children)) return [];
  return node.children
    .map((id) => byId.get(id))
    .filter((n): n is A2uiComponentNode => n !== undefined);
}

/** Render one Basic-catalog node and its subtree. Pure — no behavior executed. */
function renderNode(
  node: A2uiComponentNode,
  byId: Map<string, A2uiComponentNode>,
  model: A2uiDataModel,
  seen: Set<string>
): ReactNode {
  // Cycle guard — a malformed template must never recurse forever.
  if (seen.has(node.id)) return null;
  seen.add(node.id);

  const kids = childNodes(node, byId).map((child) => (
    <RenderChild key={child.id} node={child} byId={byId} model={model} seen={seen} />
  ));

  switch (node.component) {
    case 'Text': {
      const text = resolveText(node['text'], model);
      return <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</p>;
    }
    case 'Heading': {
      const text = resolveText(node['text'] ?? node['title'], model);
      return <h3 className="text-base font-semibold leading-tight">{text}</h3>;
    }
    case 'Image': {
      const src = stringProp(node, 'src', model) ?? stringProp(node, 'url', model);
      const alt = stringProp(node, 'alt', model) ?? '';
      if (!src) return null;
      return <img src={src} alt={alt} className="max-w-full rounded-md" />;
    }
    case 'Icon': {
      // Render the icon name as a label; we do not load arbitrary icon code.
      const name = stringProp(node, 'name', model) ?? stringProp(node, 'icon', model) ?? '';
      return <span aria-hidden className="text-muted-foreground text-xs">{name}</span>;
    }
    case 'Divider':
      return <Separator className="my-2" />;
    case 'Row':
      return <div className="flex flex-row flex-wrap items-start gap-3">{kids}</div>;
    case 'Column':
      return <div className="flex flex-col gap-2">{kids}</div>;
    case 'List':
      return <div className="flex flex-col divide-y divide-border">{kids}</div>;
    case 'Card':
      return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm">
          {kids}
        </div>
      );
    default:
      // Unreachable: the gate already refused any non-Basic component.
      return null;
  }
}

const RenderChild: FC<{
  node: A2uiComponentNode;
  byId: Map<string, A2uiComponentNode>;
  model: A2uiDataModel;
  seen: Set<string>;
}> = ({ node, byId, model, seen }) => <>{renderNode(node, byId, model, new Set(seen))}</>;

/** Render an already-validated surface against a data model. */
function A2UISurface({
  surface,
  root,
  model,
}: {
  surface: A2uiSurfaceUpdate;
  root: string;
  model: A2uiDataModel;
}): ReactNode {
  const byId = useMemo(() => {
    const m = new Map<string, A2uiComponentNode>();
    for (const c of surface.components) m.set(c.id, c);
    return m;
  }, [surface]);
  const rootNode = byId.get(root);
  if (!rootNode) return null;
  return (
    <div
      data-a2ui-surface={surface.surfaceId ?? 'main'}
      data-trust="medium"
      className={cn('flex flex-col gap-2')}
    >
      {renderNode(rootNode, byId, model, new Set())}
    </div>
  );
}

/**
 * Branch 2 entry point. Runs the standard-catalog-only gate, then renders the
 * surface at medium trust — or signals a fallback and renders nothing.
 */
export const A2UIRenderer: FC<A2UIRendererProps> = ({ renderer, event, onFallback }) => {
  const gate = useMemo(
    () => validateA2uiRenderer(renderer.content, renderer.tags),
    [renderer.content, renderer.tags]
  );
  const model = useMemo(() => dataModelFromEvent(event), [event]);

  if (!gate.ok) {
    // The host owns the fallback render (branch 3 iframe / branch 1-4). We only
    // signal; we never render a refused surface at medium trust.
    onFallback?.(gate);
    return null;
  }
  return <A2UISurface surface={gate.surface} root={gate.root} model={model} />;
};
