/**
 * The standard-catalog-only validation gate for branch 2 (A2UI, medium trust).
 *
 * This is the security boundary of the A2UI branch. Medium trust is reserved for
 * renderers that stay ENTIRELY within the A2UI "Basic" standard catalog and
 * carry no client-defined behavior. Anything else must be REFUSED here and
 * dropped to branch 3 (the sandboxed mcp-ui path) — never rendered at medium
 * trust against the client's own primitives.
 *
 * The gate returns a discriminated {@link A2uiGateResult}:
 *   - `{ ok: true, surface, root }`            → render at medium trust, or
 *   - `{ ok: false, fallback: 'mcp-ui', … }`   → drop to branch 3 (custom comp /
 *                                                 behavior), or
 *   - `{ ok: false, fallback: 'native', … }`   → unsupported A2UI version /
 *                                                 unparseable; let the dispatch
 *                                                 fall through (branch 1/4).
 *
 * The renderer NEVER renders a surface the gate refused.
 */

import {
  A2UI_BASIC_CATALOG_SET,
  SUPPORTED_A2UI_VERSIONS,
  type A2uiSurfaceUpdate,
} from './types.js';

/** Where a refusal sends the event next. */
export type A2uiFallbackBranch = 'mcp-ui' | 'native';

/** A passed gate: the parsed surface + resolved root id, safe to render. */
export interface A2uiGatePass {
  ok: true;
  surface: A2uiSurfaceUpdate;
  /** Resolved root node id (`"root"` by convention, else explicit/first). */
  root: string;
}

/**
 * A refused gate. `fallback` names the branch the dispatch should drop to:
 * `'mcp-ui'` for the standard-catalog-only invariant (custom component or custom
 * behavior present), `'native'` for an unsupported/unparseable renderer that
 * should fall through to branch 1/4.
 */
export interface A2uiGateRefuse {
  ok: false;
  fallback: A2uiFallbackBranch;
  /** Stable machine reason, safe to log. */
  reason:
    | 'unsupported-version'
    | 'unparseable-surface'
    | 'empty-surface'
    | 'custom-component'
    | 'custom-behavior'
    | 'missing-root';
  /** Human-readable detail (e.g. the offending component name). */
  detail: string;
}

export type A2uiGateResult = A2uiGatePass | A2uiGateRefuse;

/**
 * Keys on a component node that indicate client-defined *behavior* (actions,
 * handlers, validators). Their presence drops the surface to branch 3 even if
 * every component name is in the Basic catalog — medium trust never executes
 * renderer-supplied behavior.
 */
const BEHAVIOR_KEYS = ['action', 'actions', 'onClick', 'onTap', 'onChange', 'handler', 'fn', 'function', 'validate', 'validator', 'script'];

/** Read the `["a2ui", "<version>"]` tag value, or `undefined`. */
export function readA2uiVersion(tags: string[][]): string | undefined {
  const tag = tags.find((t) => t[0] === 'a2ui');
  return tag?.[1];
}

/**
 * Validate the A2UI renderer for branch 2.
 *
 * @param content   the `kind:31036` renderer `content` (the JSON `surfaceUpdate`)
 * @param tags      the renderer event tags (read for the `a2ui` version tag)
 * @returns a {@link A2uiGateResult} — pass (render) or refuse (fall back).
 */
export function validateA2uiRenderer(content: string, tags: string[][]): A2uiGateResult {
  // 1. Version negotiation — read `["a2ui", "<version>"]`. A missing tag is the
  //    supported default (the `m` tag already selected A2UI). An *unsupported*
  //    version falls through (branch 1/4) rather than dropping to mcp-ui.
  const version = readA2uiVersion(tags);
  if (version !== undefined && !SUPPORTED_A2UI_VERSIONS.has(version)) {
    return {
      ok: false,
      fallback: 'native',
      reason: 'unsupported-version',
      detail: `unsupported A2UI version "${version}"`,
    };
  }

  // 2. Parse the surfaceUpdate. Unparseable → fall through (branch 1/4).
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, fallback: 'native', reason: 'unparseable-surface', detail: 'content is not valid JSON' };
  }

  // The surfaceUpdate may be the bare body or wrapped under `surfaceUpdate`.
  const surface = unwrapSurface(parsed);
  if (!surface || !Array.isArray(surface.components)) {
    return { ok: false, fallback: 'native', reason: 'unparseable-surface', detail: 'no surfaceUpdate.components array' };
  }
  if (surface.components.length === 0) {
    return { ok: false, fallback: 'native', reason: 'empty-surface', detail: 'surfaceUpdate has no components' };
  }

  // 3. Standard-catalog-only invariant. Any custom component name, or any node
  //    carrying client-defined behavior, REFUSES → branch 3.
  for (const node of surface.components) {
    if (!node || typeof node !== 'object' || typeof node.component !== 'string') {
      return { ok: false, fallback: 'native', reason: 'unparseable-surface', detail: 'malformed component node' };
    }
    if (!A2UI_BASIC_CATALOG_SET.has(node.component)) {
      return {
        ok: false,
        fallback: 'mcp-ui',
        reason: 'custom-component',
        detail: `component "${node.component}" is not in the A2UI Basic catalog`,
      };
    }
    for (const key of BEHAVIOR_KEYS) {
      if (key in node && (node as Record<string, unknown>)[key] !== undefined) {
        return {
          ok: false,
          fallback: 'mcp-ui',
          reason: 'custom-behavior',
          detail: `component "${node.id}" carries client-defined behavior "${key}"`,
        };
      }
    }
  }

  // 4. Resolve the root: explicit `root`, else the conventional `id: "root"`,
  //    else the first component.
  const explicit = typeof surface.root === 'string' ? surface.root : undefined;
  const rootId =
    explicit ??
    (surface.components.find((c) => c.id === 'root')?.id) ??
    surface.components[0]?.id;
  if (!rootId || !surface.components.some((c) => c.id === rootId)) {
    return { ok: false, fallback: 'native', reason: 'missing-root', detail: 'no resolvable root component' };
  }

  return { ok: true, surface, root: rootId };
}

/** Accept either a bare surface body or one wrapped under `surfaceUpdate`. */
function unwrapSurface(parsed: unknown): A2uiSurfaceUpdate | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const inner = obj['surfaceUpdate'];
  if (inner && typeof inner === 'object') return inner as A2uiSurfaceUpdate;
  if (Array.isArray(obj['components'])) return obj as unknown as A2uiSurfaceUpdate;
  return undefined;
}
