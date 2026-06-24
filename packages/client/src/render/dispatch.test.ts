import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { renderDispatch, resolveRendererMime } from './dispatch.js';
import { KindRegistry } from './KindRegistry.js';
import { MIME_A2UI, MIME_MCP_APP, UI_RENDERER_KIND } from './constants.js';

/** Minimal signed-event shape; only kind/tags matter for dispatch. */
function makeEvent(kind: number, tags: string[][] = []): NostrEvent {
  return {
    id: 'id'.padEnd(64, '0'),
    pubkey: 'pk'.padEnd(64, '0'),
    created_at: 1_700_000_000,
    kind,
    tags,
    content: '',
    sig: 'sig'.padEnd(128, '0'),
  };
}

/** A `kind:31036` renderer with the given `m` (mimeType) tag. */
function makeRenderer(mime: string, dKind = '1'): NostrEvent {
  return makeEvent(UI_RENDERER_KIND, [
    ['d', dKind],
    ['m', mime],
  ]);
}

// A stand-in native component type — the registry is generic over it.
interface FakeComponent {
  name: string;
}

describe('KindRegistry (branch 1)', () => {
  it('registers and looks up a native component by kind', () => {
    const reg = new KindRegistry<FakeComponent>();
    const comp = { name: 'NoteCard' };
    reg.register(1, comp);
    expect(reg.lookup(1)).toBe(comp);
    expect(reg.has(1)).toBe(true);
    expect(reg.size).toBe(1);
  });

  it('registers one component for multiple kinds', () => {
    const reg = new KindRegistry<FakeComponent>();
    const comp = { name: 'Generic' };
    reg.register([1, 30023], comp);
    expect(reg.lookup(1)).toBe(comp);
    expect(reg.lookup(30023)).toBe(comp);
    expect(reg.kinds().sort((a, b) => a - b)).toEqual([1, 30023]);
  });

  it('returns undefined / false on a miss', () => {
    const reg = new KindRegistry<FakeComponent>();
    reg.register(1, { name: 'NoteCard' });
    expect(reg.lookup(9999)).toBeUndefined();
    expect(reg.has(9999)).toBe(false);
  });

  it('last write wins when re-registering a kind', () => {
    const reg = new KindRegistry<FakeComponent>();
    const a = { name: 'A' };
    const b = { name: 'B' };
    reg.register(1, a);
    reg.register(1, b);
    expect(reg.lookup(1)).toBe(b);
    expect(reg.size).toBe(1);
  });

  it('supports a fluent (chained) register', () => {
    const reg = new KindRegistry<FakeComponent>()
      .register(1, { name: 'A' })
      .register(2, { name: 'B' });
    expect(reg.size).toBe(2);
  });
});

describe('resolveRendererMime', () => {
  it('reads the m tag of a kind:31036 renderer', () => {
    expect(resolveRendererMime(makeRenderer(MIME_A2UI))).toBe(MIME_A2UI);
  });

  it('returns undefined for a non-renderer event', () => {
    expect(resolveRendererMime(makeEvent(1, [['m', MIME_A2UI]]))).toBeUndefined();
  });

  it('returns undefined for a renderer with no m tag', () => {
    expect(resolveRendererMime(makeEvent(UI_RENDERER_KIND, [['d', '1']]))).toBeUndefined();
  });

  it('returns undefined for no renderer', () => {
    expect(resolveRendererMime(undefined)).toBeUndefined();
  });
});

describe('renderDispatch', () => {
  const registry = new KindRegistry<FakeComponent>().register(1, { name: 'NoteCard' });

  it('branch 1: known kind → native component (full trust)', () => {
    const event = makeEvent(1);
    const decision = renderDispatch({ event }, registry);
    expect(decision.branch).toBe('native');
    expect(decision.trust).toBe('full');
    if (decision.branch === 'native') {
      expect(decision.component).toEqual({ name: 'NoteCard' });
      expect(decision.event).toBe(event);
    }
  });

  it('branch 1 takes precedence over a present renderer for a known kind', () => {
    const event = makeEvent(1);
    const renderer = makeRenderer(MIME_A2UI);
    const decision = renderDispatch({ event, renderer }, registry);
    expect(decision.branch).toBe('native');
  });

  it('branch 2: unknown kind + application/a2ui+json → a2ui (medium trust)', () => {
    const event = makeEvent(42);
    const renderer = makeRenderer(MIME_A2UI);
    const decision = renderDispatch({ event, renderer }, registry);
    expect(decision.branch).toBe('a2ui');
    expect(decision.trust).toBe('medium');
    if (decision.branch === 'a2ui') {
      expect(decision.renderer).toBe(renderer);
    }
  });

  it('branch 3: unknown kind + text/html;profile=mcp-app → mcp-ui (low trust)', () => {
    const event = makeEvent(42);
    const renderer = makeRenderer(MIME_MCP_APP);
    const decision = renderDispatch({ event, renderer }, registry);
    expect(decision.branch).toBe('mcp-ui');
    expect(decision.trust).toBe('low');
    if (decision.branch === 'mcp-ui') {
      expect(decision.renderer).toBe(renderer);
    }
  });

  it('branch 4: unknown kind + no renderer → generative (low trust)', () => {
    const decision = renderDispatch({ event: makeEvent(42) }, registry);
    expect(decision.branch).toBe('generative');
    expect(decision.trust).toBe('low');
  });

  it('branch 4: unknown kind + renderer with an unrecognised m tag → generative', () => {
    const renderer = makeRenderer('application/unknown+json');
    const decision = renderDispatch({ event: makeEvent(42), renderer }, registry);
    expect(decision.branch).toBe('generative');
  });

  it('branch 4: unknown kind + renderer with no m tag → generative', () => {
    const renderer = makeEvent(UI_RENDERER_KIND, [['d', '42']]);
    const decision = renderDispatch({ event: makeEvent(42), renderer }, registry);
    expect(decision.branch).toBe('generative');
  });
});
