/**
 * Iframe entry for the MCP-app bundle.
 *
 * Connects the official ext-apps `App` (via the `useApp` hook), wraps it as a
 * {@link ViewBridge}, and renders whatever ViewSpec the agent delivers through
 * the `toon_render` tool result. This is the runtime root the `ui://toon/app`
 * resource boots; it is compiled into the bundle, not unit-tested here.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { createExtAppsBridge } from './app-bridge/ext-apps-bridge.js';
import { type ViewBridge } from './app-bridge/types.js';
import { ViewSpecRenderer } from './runtime.js';

function ViewHost({ bridge }: { bridge: ViewBridge }): ReactNode {
  const [spec, setSpec] = useState<unknown>(null);
  useEffect(() => bridge.onSpec(setSpec), [bridge]);

  if (spec == null) {
    return <div className="p-4 text-sm text-muted-foreground">Waiting for a view…</div>;
  }
  // Present the view as the gallery does: a rounded, bordered panel on a faintly
  // tinted page, capped to a comfortable reading width and centered. Without this
  // the app just fills the iframe edge-to-edge as a square slab and the
  // self-framing atom cards bleed into the corners.
  return (
    <div className="bg-muted/30 p-3 sm:p-4">
      <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-border bg-background p-4 shadow-sm">
        <ViewSpecRenderer spec={spec} bridge={bridge} />
      </div>
    </div>
  );
}

export function ToonApp(): ReactNode {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'toon-views', version: '0.1.0' },
    capabilities: {},
  });
  // Keep TOON's own theme (globals.css: jade primary + cool-slate palette +
  // Geist Mono ledger type) and only FOLLOW the host's light/dark preference.
  // We deliberately do NOT adopt the host's style variables or fonts — that let
  // Claude Desktop's palette/fonts override the TOON tokens and made the render
  // look like generic chat chrome. Instead we mirror the host theme onto our
  // own `.dark` class so the views dark palette engages inside (dark) Claude,
  // matching the gallery's dark mode. Falls back to the OS preference when the
  // host doesn't report a theme (e.g. standalone).
  useEffect(() => {
    if (!app) return;
    const apply = (theme?: 'light' | 'dark'): void => {
      const resolved =
        theme ??
        (window.matchMedia?.('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light');
      const root = document.documentElement;
      root.classList.toggle('dark', resolved === 'dark');
      root.style.colorScheme = resolved;
    };
    apply(app.getHostContext()?.theme);
    const prev = app.onhostcontextchanged;
    app.onhostcontextchanged = (ctx) => {
      apply(app.getHostContext()?.theme);
      prev?.(ctx);
    };
    return () => {
      app.onhostcontextchanged = prev;
    };
  }, [app]);
  const bridge = useMemo(() => (app ? createExtAppsBridge(app) : null), [app]);

  if (error) return <div className="p-4 text-sm">Failed to connect: {error.message}</div>;
  if (!isConnected || !bridge) {
    return <div className="p-4 text-sm text-muted-foreground">Connecting…</div>;
  }
  return <ViewHost bridge={bridge} />;
}

/** Mount the app into a host element (called by the bundle's HTML shell). */
export function mount(el: HTMLElement): void {
  createRoot(el).render(<ToonApp />);
}
