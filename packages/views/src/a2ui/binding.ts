/**
 * A2UI data binding — resolve component-node prop values against the
 * `dataModelUpdate` root, and build that root from a decoded TOON event.
 *
 * A prop value is either a literal (string / number / boolean, or the v0.8
 * `{ literalString }` form) or a `{ path }` JSON-Pointer binding into the data
 * model. Branch 2 binds the *decoded event* as the data-model root, so e.g.
 * `{ "path": "/content" }` resolves to the event's content.
 *
 * Resolution is pure data lookup — no `eval`, no function execution (that would
 * be client-defined behavior, which the gate already refuses).
 */

import { type NostrEvent, getTagValue } from '../types.js';
import { type A2uiBoundValue, type A2uiDataModel } from './types.js';

/**
 * Build the A2UI `dataModelUpdate` root object from a decoded TOON event.
 *
 * The event's first-class fields are exposed at the root so templates can bind
 * `{ path: "/content" }`, `{ path: "/pubkey" }`, `{ path: "/kind" }`, etc.; tags
 * are exposed both raw (`/tags`) and indexed by name (`/tag/<name>` → first
 * value) for ergonomic `{ path: "/tag/title" }`-style binds.
 *
 * NOTE: in production the dispatch hands branch 2 an already-decoded event
 * (`core.decodeEventFromToon(event)`); this helper just projects that
 * `NostrEvent` into the data-model shape. It deliberately does not import
 * `@toon-protocol/core` — the views package stays browser-bundle-safe and the
 * decode happens upstream (see #88 / the toon#36 resolution spike).
 */
export function dataModelFromEvent(event: NostrEvent): A2uiDataModel {
  const tag: Record<string, string> = {};
  for (const t of event.tags) {
    if (t[0] !== undefined && t[1] !== undefined && !(t[0] in tag)) tag[t[0]] = t[1];
  }
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    content: event.content,
    tags: event.tags,
    tag,
  };
}

/** Type guard: a `{ path }` JSON-Pointer binding. */
function isPathBinding(v: unknown): v is { path: string } {
  return typeof v === 'object' && v !== null && typeof (v as { path?: unknown }).path === 'string';
}

/**
 * Resolve a JSON Pointer (RFC 6901, e.g. `/content` or `/tag/title`) against the
 * data model. Returns `undefined` for any segment that is missing.
 */
export function resolvePath(model: A2uiDataModel, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return model;
  const segments = pointer
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = model;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Resolve a bound prop value to a concrete primitive. Literals pass through
 * (including the v0.8 `{ literalString }` form); `{ path }` bindings resolve
 * against the model.
 */
export function resolveValue(value: A2uiBoundValue | unknown, model: A2uiDataModel): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (isPathBinding(value)) return resolvePath(model, value.path);
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if ('literalString' in obj) return obj['literalString'];
    if ('literalNumber' in obj) return obj['literalNumber'];
    if ('literalBoolean' in obj) return obj['literalBoolean'];
  }
  return value;
}

/** Resolve a bound value and coerce it to a display string (never throws). */
export function resolveText(value: unknown, model: A2uiDataModel): string {
  const resolved = resolveValue(value, model);
  if (resolved == null) return '';
  if (typeof resolved === 'string') return resolved;
  if (typeof resolved === 'number' || typeof resolved === 'boolean') return String(resolved);
  return JSON.stringify(resolved);
}

/** Read a string prop from a node by name (literal or binding), or `undefined`. */
export function stringProp(
  node: Record<string, unknown>,
  name: string,
  model: A2uiDataModel
): string | undefined {
  if (!(name in node) || node[name] === undefined) return undefined;
  const resolved = resolveValue(node[name], model);
  return typeof resolved === 'string' ? resolved : resolved == null ? undefined : String(resolved);
}

export { getTagValue };
