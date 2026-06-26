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
  return <ViewSpecRenderer spec={spec} bridge={bridge} />;
}

export function ToonApp(): ReactNode {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'toon-views', version: '0.1.0' },
    capabilities: {},
  });
  // Render TOON's own theme (globals.css: jade primary + cool-slate palette +
  // Geist Mono ledger type) regardless of host, so the in-chat app matches the
  // standalone views gallery. We intentionally do NOT adopt the host's style
  // variables/fonts — doing so let Claude Desktop's palette/fonts override the
  // TOON tokens and made the render look like generic chat chrome.
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
