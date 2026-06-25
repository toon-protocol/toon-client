/**
 * The render trust gradient wired into the live app render path (toon-meta#58).
 *
 * Exercises `EventAtom` (via `ViewSpecRenderer` + a `kindAuto` feed bind) end to
 * end: known kinds render native (branch 1, no renderer fetch); unknown kinds
 * with a `ui` coordinate fetch a `kind:31036` renderer through the bridge and
 * dispatch to A2UI (branch 2) / sandboxed mcp-ui (branch 3); and unknown kinds
 * with no resolvable renderer fall back to the generative branch (branch 4). The
 * bridge is mocked; renderers are real signed events so the swap-defense guard's
 * signature re-verify passes.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from 'nostr-tools/pure';
import {
  UI_RENDERER_KIND,
  MIME_A2UI,
  MIME_MCP_APP,
  buildUiCoordinate,
} from '@toon-protocol/client/render';

// Mock the mcp-ui AppRenderer (jsdom can't run the sandbox proxy) so the
// branch-3 path renders an inspectable double instead of a real iframe.
vi.mock('@mcp-ui/client', () => ({
  AppRenderer: (props: { html: string; sandbox: { permissions?: string } }) => (
    <div data-testid="mock-app-frame" data-sandbox={props.sandbox.permissions}>
      <span data-testid="widget-html">{props.html}</span>
    </div>
  ),
}));

const { ViewSpecRenderer } = await import('../runtime.js');
const { rendererQueryFilter } = await import('./resolve.js');
const { QUERY_TOOL } = await import('../tool-names.js');

import { type NostrEvent } from '../types.js';
import { type ViewBridge } from '../app-bridge/types.js';

afterEach(cleanup);

const SK = generateSecretKey();
const PK = getPublicKey(SK);
// Each test that resolves a renderer uses a DISTINCT unknown kind so the
// session-scoped anti-swap pin store (module-level in runtime.tsx) cannot leak a
// pin from one test's coordinate into another's.
const UNKNOWN_KIND = 4242;
const A2UI_KIND = 4243;
const MCP_KIND = 4244;
const NO_RENDERER_KIND = 4245;
const SWAP_KIND = 4246;

function sign(template: EventTemplate): NostrEvent {
  return finalizeEvent(template, SK);
}

/**
 * The full `ui` coordinate string `31036:<PK>:<targetKind>`. The swap-defense
 * guard (`guardedRenderDispatch`) requires the full coordinate form, so events
 * routed through branches 2/3 must carry it (the canonical renderer-aware form).
 */
function coord(targetKind: number): string {
  const c = buildUiCoordinate({ pubkey: PK, targetKind });
  if (c === null) throw new Error('buildUiCoordinate returned null for valid inputs');
  return c;
}

/** A signed event of `kind`, optionally carrying a `ui` tag (bare target kind). */
function signEvent(kind: number, ui?: string, content = 'hello'): NostrEvent {
  return sign({
    kind,
    created_at: 1_700_000_000,
    tags: ui !== undefined ? [['ui', ui]] : [],
    content,
  });
}

/** A signed `kind:31036` renderer for `targetKind` with the given mime + content. */
function signRenderer(targetKind: number, mime: string, content: string): NostrEvent {
  return sign({
    kind: UI_RENDERER_KIND,
    created_at: 1_700_000_100,
    tags: [
      ['d', String(targetKind)],
      ['m', mime],
    ],
    content,
  });
}

/**
 * A bridge that answers the resolver's `kind:31036` query with `renderers` and
 * any other `toon_query` (the feed bind) with `feedEvents`. Records calls.
 */
function gradientBridge(
  feedEvents: NostrEvent[],
  renderers: NostrEvent[]
): { bridge: ViewBridge; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const bridge: ViewBridge = {
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === QUERY_TOOL) {
        const filter = (args.filter ?? {}) as { kinds?: number[] };
        // The renderer-resolution query is the one filtering on kind 31036.
        if (filter.kinds?.includes(UI_RENDERER_KIND)) return { ok: true, events: renderers };
        return { ok: true, events: feedEvents };
      }
      return { ok: true };
    },
    notifyModel() {},
    onSpec() {
      return () => {};
    },
  };
  return { bridge, calls };
}

/** Render a single event through the gradient via a kindAuto feed bind. */
function renderFeed(bridge: ViewBridge, kinds: number[]) {
  return render(
    <ViewSpecRenderer
      bridge={bridge}
      spec={{ root: { atom: 'generic-event', bind: { query: { kinds }, kindAuto: true } } }}
    />
  );
}

describe('render trust gradient — live EventAtom path', () => {
  it('rendererQueryFilter builds an author+target-kind-bound kind:31036 filter', () => {
    const event = signEvent(UNKNOWN_KIND, String(UNKNOWN_KIND));
    expect(rendererQueryFilter(event)).toEqual({
      kinds: [UI_RENDERER_KIND],
      authors: [PK],
      '#d': [String(UNKNOWN_KIND)],
    });
  });

  it('rendererQueryFilter returns undefined for an event with no ui tag', () => {
    expect(rendererQueryFilter(signEvent(UNKNOWN_KIND))).toBeUndefined();
  });

  it('branch 1 (native): a known kind renders its atom with NO renderer fetch', async () => {
    const note = signEvent(1, undefined, 'a native note');
    const { bridge, calls } = gradientBridge([note], []);
    renderFeed(bridge, [1]);

    expect(await screen.findByText('a native note')).toBeTruthy();
    // Only the feed query ran — no kind:31036 resolution round-trip for a known kind.
    const rendererQueries = calls.filter(
      (c) =>
        c.name === QUERY_TOOL &&
        ((c.args.filter ?? {}) as { kinds?: number[] }).kinds?.includes(UI_RENDERER_KIND)
    );
    expect(rendererQueries).toHaveLength(0);
  });

  it('branch 2 (a2ui): an unknown kind + a2ui renderer renders the A2UI surface', async () => {
    const surface = {
      components: [
        { id: 'root', component: 'Card', children: ['b'] },
        { id: 'b', component: 'Text', text: { path: '/content' } },
      ],
    };
    const event = signEvent(A2UI_KIND, coord(A2UI_KIND), 'a2ui-only-marker');
    const renderer = signRenderer(A2UI_KIND, MIME_A2UI, JSON.stringify(surface));
    const { bridge } = gradientBridge([event], [renderer]);
    const { container } = renderFeed(bridge, [A2UI_KIND]);

    // The A2UI surface (medium trust) binds the event content into a Basic
    // Text node — and the medium-trust surface marker proves it's branch 2, not
    // the generative fallback (which would also echo the content).
    expect(await screen.findByText('a2ui-only-marker')).toBeTruthy();
    expect(container.querySelector('[data-trust="medium"]')).not.toBeNull();
    expect(container.querySelector('[data-branch="generative"]')).toBeNull();
  });

  it('branch 3 (mcp-ui): an unknown kind + mcp-app renderer renders the sandboxed widget', async () => {
    const event = signEvent(MCP_KIND, coord(MCP_KIND));
    const renderer = signRenderer(MCP_KIND, MIME_MCP_APP, '<button>buy</button>');
    const { bridge } = gradientBridge([event], [renderer]);
    renderFeed(bridge, [MCP_KIND]);

    // Rendered inside the (mocked) sandboxed AppRenderer with the hardened sandbox.
    const widget = await screen.findByTestId('widget-html');
    expect(widget.textContent).toBe('<button>buy</button>');
    expect(screen.getByTestId('mock-app-frame').getAttribute('data-sandbox')).toBe('allow-scripts');
  });

  it('branch 4 (generative): an unknown kind with no renderer falls back to generative', async () => {
    const event = signEvent(UNKNOWN_KIND); // no ui tag → no renderer to resolve
    const { bridge } = gradientBridge([event], []);
    const { container } = renderFeed(bridge, [UNKNOWN_KIND]);

    await waitFor(() =>
      expect(container.querySelector('[data-branch="generative"]')).not.toBeNull()
    );
    // The deterministic fallback names the unknown kind at low trust.
    expect(container.textContent).toContain('Unknown event');
    expect(container.querySelector('[data-trust="low"]')).not.toBeNull();
  });

  it('falls back to generative when a ui coordinate resolves to NO renderer', async () => {
    const event = signEvent(NO_RENDERER_KIND, coord(NO_RENDERER_KIND));
    // The resolver queries kind:31036 but the relay returns nothing.
    const { bridge, calls } = gradientBridge([event], []);
    const { container } = renderFeed(bridge, [NO_RENDERER_KIND]);

    await waitFor(() =>
      expect(container.querySelector('[data-branch="generative"]')).not.toBeNull()
    );
    // The resolver DID attempt the renderer fetch (unlike the known-kind path).
    const rendererQueries = calls.filter(
      (c) =>
        c.name === QUERY_TOOL &&
        ((c.args.filter ?? {}) as { kinds?: number[] }).kinds?.includes(UI_RENDERER_KIND)
    );
    expect(rendererQueries.length).toBeGreaterThan(0);
  });

  it('falls back to generative when the renderer is authored by someone else (swap defense)', async () => {
    const event = signEvent(SWAP_KIND, coord(SWAP_KIND));
    // A renderer signed by a DIFFERENT key — author binding must reject it.
    const otherSk = generateSecretKey();
    const foreign = finalizeEvent(
      {
        kind: UI_RENDERER_KIND,
        created_at: 1_700_000_100,
        tags: [
          ['d', String(SWAP_KIND)],
          ['m', MIME_MCP_APP],
        ],
        content: '<button>evil</button>',
      },
      otherSk
    );
    const { bridge } = gradientBridge([event], [foreign]);
    const { container } = renderFeed(bridge, [SWAP_KIND]);

    await waitFor(() =>
      expect(container.querySelector('[data-branch="generative"]')).not.toBeNull()
    );
    // The foreign renderer is never rendered — the widget HTML must not appear.
    expect(screen.queryByTestId('widget-html')).toBeNull();
    expect(container.textContent).not.toContain('evil');
  });
});
