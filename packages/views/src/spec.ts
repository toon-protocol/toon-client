/**
 * ViewSpec — the declarative composition language the client-side agent authors
 * to assemble atoms into a user journey. A ViewSpec rides as the *result* of the
 * `toon_render` tool (MCP Apps delivers dynamic data via tool results, not a
 * side-channel); the iframe runtime interprets it.
 *
 * ViewSpecs are MODEL-AUTHORED → UNTRUSTED. `validateViewSpec` is the security
 * boundary: it allowlists atom ids, caps depth/breadth, and rejects anything
 * non-serializable. Invalid specs must degrade to a fallback, never `eval`.
 */

import { type NostrFilter } from './types.js';

/** Data binding for a node; resolved client-side via free reads (`toon_read`). */
export interface ViewBind {
  /** A NIP-01 filter to query and feed into the atom. */
  query?: NostrFilter;
  /** Fetch a single event by id. */
  eventId?: string;
  /** Render the bound event(s) via their kind's default atom. */
  kindAuto?: boolean;
}

/** Binds a UI affordance to a write tool call (always `toon_publish_unsigned` / `toon_upload_media`). */
export interface WriteActionRef {
  /** Tool name to invoke. */
  tool: string;
  /** Static argument template merged with runtime values supplied by the atom. */
  args?: Record<string, unknown>;
  /** Spendy actions require host confirmation (elicitation) before firing. */
  spendy?: boolean;
  /** Human-readable confirmation label for spendy actions. */
  confirmLabel?: string;
}

/** One node in the composition tree. */
export interface ViewNode {
  atom: string;
  props?: Record<string, unknown>;
  bind?: ViewBind;
  actions?: Record<string, WriteActionRef>;
  children?: ViewNode[];
}

/** A complete view the agent asked the host to render. */
export interface ViewSpec {
  title?: string;
  root: ViewNode;
}

/** Limits applied during validation (defense against malicious/huge specs). */
export interface ValidateOptions {
  /** Atom ids the runtime knows how to render. */
  allowedAtoms: ReadonlySet<string> | readonly string[];
  /** Write tool names the runtime is allowed to invoke. */
  allowedTools?: ReadonlySet<string> | readonly string[];
  maxDepth?: number;
  maxNodes?: number;
}

export type ValidationResult =
  | { ok: true; spec: ViewSpec }
  | { ok: false; errors: string[] };

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 500;

const FILTER_ARRAY_KEYS = new Set([
  'kinds',
  'authors',
  'ids',
  '#d',
  '#e',
  '#a',
  '#p',
  '#t',
]);
const FILTER_NUM_KEYS = new Set(['since', 'until', 'limit']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toSet(v: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return v instanceof Set ? v : new Set(v as readonly string[]);
}

function validateFilter(filter: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(filter)) {
    errors.push(`${path}: filter must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(filter)) {
    if (FILTER_ARRAY_KEYS.has(key)) {
      if (
        !Array.isArray(value) ||
        !value.every((x) => typeof x === 'string' || typeof x === 'number')
      ) {
        errors.push(`${path}.${key}: must be an array of string/number`);
      }
    } else if (FILTER_NUM_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}.${key}: must be a finite number`);
      }
    } else {
      errors.push(`${path}.${key}: unsupported filter key`);
    }
  }
}

/** True if a value is safely JSON-serializable (no functions, no cycles, finite). */
function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      if (Array.isArray(value)) return value.every((v) => isJsonSafe(v, depth + 1));
      if (isPlainObject(value))
        return Object.values(value).every((v) => isJsonSafe(v, depth + 1));
      return false;
    default:
      return false;
  }
}

/**
 * Validate a model-authored ViewSpec against the atom/tool allowlists and the
 * depth/breadth caps. Returns the (structurally identical) spec on success or a
 * list of human-readable errors on failure.
 */
export function validateViewSpec(
  input: unknown,
  opts: ValidateOptions
): ValidationResult {
  const errors: string[] = [];
  const allowedAtoms = toSet(opts.allowedAtoms);
  const allowedTools = opts.allowedTools ? toSet(opts.allowedTools) : undefined;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['spec must be an object'] };
  }
  if (input['title'] !== undefined && typeof input['title'] !== 'string') {
    errors.push('spec.title: must be a string');
  }
  if (!isPlainObject(input['root'])) {
    return { ok: false, errors: ['spec.root: required object'] };
  }

  let nodeCount = 0;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) {
      errors.push(`${path}: exceeds max depth ${maxDepth}`);
      return;
    }
    if (++nodeCount > maxNodes) {
      errors.push(`spec: exceeds max node count ${maxNodes}`);
      return;
    }
    if (!isPlainObject(node)) {
      errors.push(`${path}: node must be an object`);
      return;
    }
    if (typeof node['atom'] !== 'string') {
      errors.push(`${path}.atom: must be a string`);
    } else if (!allowedAtoms.has(node['atom'])) {
      errors.push(`${path}.atom: unknown atom "${node['atom']}"`);
    }

    if (node['props'] !== undefined) {
      if (!isPlainObject(node['props']) || !isJsonSafe(node['props'])) {
        errors.push(`${path}.props: must be a JSON-serializable object`);
      }
    }

    if (node['bind'] !== undefined) {
      const bind = node['bind'];
      if (!isPlainObject(bind)) {
        errors.push(`${path}.bind: must be an object`);
      } else {
        const KNOWN_BIND_KEYS = new Set(['query', 'eventId', 'kindAuto']);
        for (const key of Object.keys(bind)) {
          if (!KNOWN_BIND_KEYS.has(key)) {
            errors.push(`${path}.bind.${key}: unknown bind key (use "query" for a NIP-01 filter)`);
          }
        }
        if (bind['query'] !== undefined) validateFilter(bind['query'], `${path}.bind.query`, errors);
        if (bind['eventId'] !== undefined && typeof bind['eventId'] !== 'string') {
          errors.push(`${path}.bind.eventId: must be a string`);
        }
        if (bind['kindAuto'] !== undefined && typeof bind['kindAuto'] !== 'boolean') {
          errors.push(`${path}.bind.kindAuto: must be a boolean`);
        }
      }
    }

    if (node['actions'] !== undefined) {
      const actions = node['actions'];
      if (!isPlainObject(actions)) {
        errors.push(`${path}.actions: must be an object`);
      } else {
        for (const [name, ref] of Object.entries(actions)) {
          const p = `${path}.actions.${name}`;
          if (!isPlainObject(ref)) {
            errors.push(`${p}: must be an object`);
            continue;
          }
          if (typeof ref['tool'] !== 'string') {
            errors.push(`${p}.tool: must be a string`);
          } else if (allowedTools && !allowedTools.has(ref['tool'])) {
            errors.push(`${p}.tool: tool "${ref['tool']}" not allowed`);
          }
          if (ref['args'] !== undefined && (!isPlainObject(ref['args']) || !isJsonSafe(ref['args']))) {
            errors.push(`${p}.args: must be a JSON-serializable object`);
          }
          if (ref['spendy'] !== undefined && typeof ref['spendy'] !== 'boolean') {
            errors.push(`${p}.spendy: must be a boolean`);
          }
          if (ref['confirmLabel'] !== undefined && typeof ref['confirmLabel'] !== 'string') {
            errors.push(`${p}.confirmLabel: must be a string`);
          }
        }
      }
    }

    if (node['children'] !== undefined) {
      if (!Array.isArray(node['children'])) {
        errors.push(`${path}.children: must be an array`);
      } else {
        node['children'].forEach((child, i) => walk(child, `${path}.children[${i}]`, depth + 1));
      }
    }
  };

  walk(input['root'], 'spec.root', 0);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: input as unknown as ViewSpec };
}
