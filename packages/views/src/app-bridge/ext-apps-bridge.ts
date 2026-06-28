/**
 * The real {@link ViewBridge} implementation, wrapping the official
 * `@modelcontextprotocol/ext-apps` `App`. This is the ONLY module that imports
 * the MCP SDK — the runtime and atoms depend solely on the {@link ViewBridge}
 * interface, so swapping transports (or moving to mcp-ui) stays a one-file change.
 *
 * Data-flow grain (per the MCP Apps spec): dynamic data rides tool *results*.
 * The agent-authored ViewSpec arrives as the `toon_render` tool result via the
 * `ui/notifications/tool-result` notification (`App.ontoolresult`); free reads
 * and writes go out via `App.callServerTool`.
 */

import { type App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type NostrEvent } from '../types.js';
import { type DisplayMode, type ToolOutcome, type ViewBridge } from './types.js';

function extractEvents(structured: unknown): NostrEvent[] | undefined {
  if (
    typeof structured === 'object' &&
    structured !== null &&
    Array.isArray((structured as { events?: unknown }).events)
  ) {
    return (structured as { events: NostrEvent[] }).events;
  }
  return undefined;
}

function firstText(result: CallToolResult): string | undefined {
  for (const block of result.content ?? []) {
    if (block.type === 'text') return block.text;
  }
  return undefined;
}

/** Wrap a connected ext-apps `App` as a {@link ViewBridge}. */
export function createExtAppsBridge(app: App): ViewBridge {
  return {
    async callTool(name, args): Promise<ToolOutcome> {
      try {
        const result = await app.callServerTool({ name, arguments: args });
        const structured = result.structuredContent;
        const outcome: ToolOutcome = { ok: result.isError !== true };
        const events = extractEvents(structured);
        if (events) outcome.events = events;
        // `data` is populated ONLY from `structuredContent`. A tool call that
        // resolved without `isError` but carried no `structuredContent` is
        // suspicious (a daemon↔views skew or a transport that dropped the
        // structured payload), but the bridge is tool-agnostic — it can't know
        // which tools are required to return structured data (`toon_read`
        // carries `events`, not `structuredContent`). So we deliberately leave
        // `data` as `undefined` rather than fabricate `{}`, keeping the
        // missing-structuredContent case DISTINGUISHABLE downstream: each read
        // seam validates its own wire contract (e.g. `parseBalancesPayload` in
        // the runtime treats `undefined` as a contract violation → error/retry,
        // not a silent empty list). See toon-client#200.
        if (structured !== undefined) outcome.data = structured;
        if (result.isError === true) outcome.error = firstText(result) ?? 'tool error';
        return outcome;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    notifyModel(text): void {
      void app.updateModelContext({ content: [{ type: 'text', text }] });
    },

    onSpec(cb): () => void {
      app.ontoolresult = (params: CallToolResult) => {
        const spec = (params.structuredContent as { viewSpec?: unknown } | undefined)?.viewSpec;
        if (spec !== undefined) cb(spec);
      };
      return () => {
        app.ontoolresult = undefined;
      };
    },

    availableDisplayModes(): DisplayMode[] {
      return app.getHostContext()?.availableDisplayModes ?? [];
    },

    displayMode(): DisplayMode {
      return app.getHostContext()?.displayMode ?? 'inline';
    },

    async requestDisplayMode(mode): Promise<DisplayMode> {
      const result = await app.requestDisplayMode({ mode });
      return result.mode;
    },

    onHostContextChanged(cb): () => void {
      // `onhostcontextchanged` is a single settable callback, so CHAIN over any
      // existing handler (e.g. app-entry's theme follower) rather than clobber
      // it, and restore the prior handler on unsubscribe — matching app-entry.
      const prev = app.onhostcontextchanged;
      app.onhostcontextchanged = (ctx) => {
        cb();
        prev?.(ctx);
      };
      return () => {
        app.onhostcontextchanged = prev;
      };
    },
  };
}
