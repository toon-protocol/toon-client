import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { A2UIRenderer } from './A2UIRenderer.js';
import { type A2uiGateRefuse } from './validate.js';
import { type NostrEvent } from '../types.js';

afterEach(cleanup);

function evt(partial: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'id1',
    pubkey: 'pk1',
    created_at: 42,
    kind: 31337,
    tags: [['title', 'My Title']],
    content: 'bound content',
    sig: 'sig',
    ...partial,
  };
}

/** A `kind:31036` renderer event whose content is the A2UI surfaceUpdate. */
function renderer(surfaceUpdate: unknown, tags: string[][] = []): NostrEvent {
  return evt({ id: 'r1', kind: 31036, content: JSON.stringify(surfaceUpdate), tags });
}

describe('A2UIRenderer — branch 2 (A2UI, medium trust)', () => {
  it('renders a Basic surfaceUpdate bound to the decoded-event dataModel', () => {
    const surface = {
      components: [
        { id: 'root', component: 'Card', children: ['h', 'd', 'b'] },
        { id: 'h', component: 'Heading', text: { path: '/tag/title' } },
        { id: 'd', component: 'Divider' },
        { id: 'b', component: 'Text', text: { path: '/content' } },
      ],
    };
    render(<A2UIRenderer renderer={renderer(surface, [['a2ui', 'v0.8']])} event={evt()} />);
    // Heading bound from the event's `title` tag, body bound from `content`.
    expect(screen.getByText('My Title')).toBeTruthy();
    expect(screen.getByText('bound content')).toBeTruthy();
  });

  it('renders nothing and signals branch-3 fallback for a custom component', () => {
    const surface = {
      components: [
        { id: 'root', component: 'Column', children: ['x'] },
        { id: 'x', component: 'EvilWidget', text: 'pwn' },
      ],
    };
    const onFallback = vi.fn();
    const { container } = render(
      <A2UIRenderer renderer={renderer(surface)} event={evt()} onFallback={onFallback} />
    );
    // The refused surface is NOT rendered at medium trust.
    expect(container.textContent).not.toContain('pwn');
    expect(onFallback).toHaveBeenCalledTimes(1);
    const refusal = onFallback.mock.calls[0]?.[0] as A2uiGateRefuse;
    expect(refusal.fallback).toBe('mcp-ui');
    expect(refusal.reason).toBe('custom-component');
  });

  it('signals native fallback on an unsupported A2UI version', () => {
    const surface = { components: [{ id: 'root', component: 'Text', text: 'hi' }] };
    const onFallback = vi.fn();
    render(
      <A2UIRenderer
        renderer={renderer(surface, [['a2ui', 'v42']])}
        event={evt()}
        onFallback={onFallback}
      />
    );
    expect(onFallback).toHaveBeenCalledTimes(1);
    const refusal = onFallback.mock.calls[0]?.[0] as A2uiGateRefuse;
    expect(refusal.fallback).toBe('native');
    expect(refusal.reason).toBe('unsupported-version');
  });

  it('renders Row/Column/List containers with literal text', () => {
    const surface = {
      components: [
        { id: 'root', component: 'List', children: ['a', 'b'] },
        { id: 'a', component: 'Text', text: 'first' },
        { id: 'b', component: 'Text', text: 'second' },
      ],
    };
    render(<A2UIRenderer renderer={renderer(surface)} event={evt()} />);
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });
});
