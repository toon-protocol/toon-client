import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Mock `@mcp-ui/client`'s `AppRenderer` with a test double that:
 *   - records the `sandbox` prop (so we can assert the hardened attribute), and
 *   - exposes a button that fires `onCallTool` — standing in for a widget that
 *     *requests* an action from inside the iframe.
 * The double renders NO real iframe (jsdom can't run the sandbox proxy), but it
 * exercises the exact host code path a widget request travels through.
 */
const lastSandbox: { value?: { url: URL; permissions?: string } } = {};

vi.mock('@mcp-ui/client', () => ({
  AppRenderer: (props: {
    sandbox: { url: URL; permissions?: string };
    html: string;
    onCallTool: (params: CallToolRequest['params']) => Promise<CallToolResult>;
  }) => {
    lastSandbox.value = props.sandbox;
    return (
      <div data-testid="mock-app-frame" data-sandbox={props.sandbox.permissions}>
        <span data-testid="widget-html">{props.html}</span>
        {/* Simulate the widget requesting a spendy action over the bridge. */}
        <button
          data-testid="widget-requests-publish"
          onClick={() =>
            void props.onCallTool({ name: 'toon_publish', arguments: { text: 'gm' } })
          }
        >
          widget: request publish
        </button>
        {/* Simulate the widget requesting a read-only (auto) action. */}
        <button
          data-testid="widget-requests-read"
          onClick={() => void props.onCallTool({ name: 'toon_read', arguments: { kind: 1 } })}
        >
          widget: request read
        </button>
      </div>
    );
  },
}));

const { SandboxedAppRenderer } = await import('./SandboxedAppRenderer.js');

afterEach(() => {
  cleanup();
  lastSandbox.value = undefined;
  vi.restoreAllMocks();
});

const resource = { html: '<button>buy now</button>', mimeType: 'text/html;profile=mcp-app' };
const sandboxUrl = new URL('https://sandbox.example/proxy.html');

describe('SandboxedAppRenderer — branch 3 (sandboxed mcp-ui, low trust)', () => {
  it('renders the UIResource HTML inside the mcp-ui AppRenderer', () => {
    render(
      <SandboxedAppRenderer
        resource={resource}
        sandboxUrl={sandboxUrl}
        onPerform={vi.fn(async () => ({ content: [] }))}
      />
    );
    expect(screen.getByTestId('widget-html').textContent).toBe('<button>buy now</button>');
  });

  it('passes the hardened sandbox (allow-scripts only, no allow-same-origin)', () => {
    render(
      <SandboxedAppRenderer
        resource={resource}
        sandboxUrl={sandboxUrl}
        onPerform={vi.fn(async () => ({ content: [] }))}
      />
    );
    expect(lastSandbox.value?.permissions).toBe('allow-scripts');
    expect(lastSandbox.value?.permissions).not.toContain('allow-same-origin');
  });

  it('a widget-requested spendy action surfaces a HOST consent prompt (outside the iframe)', async () => {
    const onPerform = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }));
    render(
      <SandboxedAppRenderer resource={resource} sandboxUrl={sandboxUrl} onPerform={onPerform} />
    );

    // No prompt until the widget asks.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('widget-requests-publish'));
    });

    // The host-rendered prompt appears; the action has NOT been performed yet.
    const prompt = screen.getByRole('alertdialog');
    expect(prompt).toBeTruthy();
    expect(screen.getByText('toon_publish')).toBeTruthy();
    expect(onPerform).not.toHaveBeenCalled();

    // The prompt is a SIBLING of the iframe mock, never a descendant of it —
    // the widget cannot reach or restyle it.
    const frame = screen.getByTestId('mock-app-frame');
    expect(frame.contains(prompt)).toBe(false);
  });

  it('performs the action only after an explicit user GRANT', async () => {
    const onPerform = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }));
    render(
      <SandboxedAppRenderer resource={resource} sandboxUrl={sandboxUrl} onPerform={onPerform} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('widget-requests-publish'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Authorize'));
    });
    expect(onPerform).toHaveBeenCalledWith('toon_publish', { text: 'gm' });
    // Prompt dismissed after resolution.
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does NOT perform the action on DENY (widget never acts)', async () => {
    const onPerform = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }));
    render(
      <SandboxedAppRenderer resource={resource} sandboxUrl={sandboxUrl} onPerform={onPerform} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('widget-requests-publish'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Deny'));
    });
    expect(onPerform).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the widget cannot suppress or auto-approve the prompt — a request never self-resolves', async () => {
    const onPerform = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }));
    render(
      <SandboxedAppRenderer resource={resource} sandboxUrl={sandboxUrl} onPerform={onPerform} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('widget-requests-publish'));
    });
    // Even after the microtask queue drains, the action stays pending on the
    // user — the widget has no path to resolve its own consent.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onPerform).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('auto-forwards a read-only request WITHOUT a consent prompt', async () => {
    const onPerform = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }));
    render(
      <SandboxedAppRenderer resource={resource} sandboxUrl={sandboxUrl} onPerform={onPerform} />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('widget-requests-read'));
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onPerform).toHaveBeenCalledWith('toon_read', { kind: 1 });
  });
});
