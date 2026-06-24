import { describe, it, expect } from 'vitest';
import { validateA2uiRenderer, readA2uiVersion } from './validate.js';

/** Build a surfaceUpdate JSON string for a list of component nodes. */
function surface(components: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ components, ...extra });
}

describe('validateA2uiRenderer — standard-catalog-only gate', () => {
  it('passes a Basic-catalog surface and resolves the conventional root', () => {
    const content = surface([
      { id: 'root', component: 'Column', children: ['t'] },
      { id: 't', component: 'Text', text: { path: '/content' } },
    ]);
    const res = validateA2uiRenderer(content, []);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.root).toBe('root');
      expect(res.surface.components).toHaveLength(2);
    }
  });

  it('REFUSES a custom (non-Basic) component and drops to branch 3 (mcp-ui)', () => {
    const content = surface([
      { id: 'root', component: 'Column', children: ['x'] },
      { id: 'x', component: 'FancyCustomWidget', text: 'hi' },
    ]);
    const res = validateA2uiRenderer(content, []);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fallback).toBe('mcp-ui');
      expect(res.reason).toBe('custom-component');
      expect(res.detail).toContain('FancyCustomWidget');
    }
  });

  it('REFUSES a Basic component carrying client-defined behavior → branch 3', () => {
    const content = surface([
      { id: 'root', component: 'Card', children: ['t'] },
      // `Text` is Basic, but an `onClick` handler is custom behavior.
      { id: 't', component: 'Text', text: 'click me', onClick: 'doThing()' },
    ]);
    const res = validateA2uiRenderer(content, []);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fallback).toBe('mcp-ui');
      expect(res.reason).toBe('custom-behavior');
    }
  });

  it('falls through (native) on an unsupported A2UI version', () => {
    const content = surface([{ id: 'root', component: 'Text', text: 'hi' }]);
    const res = validateA2uiRenderer(content, [['a2ui', 'v99.0']]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fallback).toBe('native');
      expect(res.reason).toBe('unsupported-version');
    }
  });

  it('accepts the supported version tag and a missing version tag', () => {
    const content = surface([{ id: 'root', component: 'Text', text: 'hi' }]);
    expect(validateA2uiRenderer(content, [['a2ui', 'v0.8']]).ok).toBe(true);
    expect(validateA2uiRenderer(content, []).ok).toBe(true);
  });

  it('falls through (native) on unparseable / empty surfaces', () => {
    expect(validateA2uiRenderer('not json', []).ok).toBe(false);
    const empty = validateA2uiRenderer(surface([]), []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('empty-surface');
  });

  it('accepts a surfaceUpdate-wrapped body', () => {
    const content = JSON.stringify({
      surfaceUpdate: { components: [{ id: 'root', component: 'Text', text: 'hi' }] },
    });
    expect(validateA2uiRenderer(content, []).ok).toBe(true);
  });

  it('readA2uiVersion reads the a2ui tag', () => {
    expect(readA2uiVersion([['a2ui', 'v0.8']])).toBe('v0.8');
    expect(readA2uiVersion([])).toBeUndefined();
  });
});
