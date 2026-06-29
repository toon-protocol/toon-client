/**
 * The ViewBridge seam.
 *
 * The composition runtime depends ONLY on this interface, never on the MCP SDK
 * directly. The real implementation ({@link ./ext-apps-bridge}) wraps the
 * official `@modelcontextprotocol/ext-apps` `App`; tests inject a mock. Swapping
 * to a different transport (or mcp-ui) is a one-file change here.
 */

import { type NostrEvent } from '../types.js';

/**
 * Host surface modes (mirrors the MCP-Apps `McpUiDisplayMode`). `inline` is the
 * default scannable card; `fullscreen` hosts a real scrolling timeline/thread;
 * `pip` runs a live ticker alongside the conversation.
 */
export type DisplayMode = 'inline' | 'fullscreen' | 'pip';

/** Normalized outcome of a server tool call. */
export interface ToolOutcome {
  ok: boolean;
  /** Events returned by a read tool (`toon_read`), if any. */
  events?: NostrEvent[];
  /** Arbitrary structured payload (e.g. a publish response). */
  data?: unknown;
  /** Error text when `ok` is false. */
  error?: string;
}

export interface ViewBridge {
  /**
   * Invoke a server tool over the host bridge. Reads (`toon_read`) are free;
   * writes (`toon_publish_unsigned`, `toon_upload`) are gated host-side
   * (server-raised elicitation for spendy actions).
   */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** Feed a short note about what the user did back into the model's context. */
  notifyModel(text: string): void;
  /**
   * Subscribe to incoming ViewSpecs (delivered as the `toon_render` tool
   * result). Returns an unsubscribe fn.
   */
  onSpec(cb: (spec: unknown) => void): () => void;
  /**
   * Optional async confirmation gate for spendy actions. Return `true` to
   * proceed, `false` to abort. Defaults to `window.confirm` in browser runtimes.
   * Inject a custom function in tests to avoid real modal dialogs.
   */
  confirm?: (message: string) => Promise<boolean>;

  // ── Surface modes (optional; feature-detected) ────────────────────────────
  // Hosts without the display-mode capability (and the test/mock bridge) simply
  // omit these, so atoms must treat them as "inline only". A view never assumes
  // fullscreen/pip exists — it checks {@link availableDisplayModes} first.

  /**
   * The surface modes this host offers. Empty/omitted ⇒ assume inline-only
   * (the safe default). Atoms gate "Open timeline" (fullscreen) / live tickers
   * (pip) on the presence of the mode here.
   */
  availableDisplayModes?(): DisplayMode[];
  /** The current display mode (defaults to `'inline'`). */
  displayMode?(): DisplayMode;
  /**
   * Ask the host to switch surface mode; resolves with the mode actually set
   * (which may differ from the request if the host declines).
   */
  requestDisplayMode?(mode: DisplayMode): Promise<DisplayMode>;
  /**
   * Subscribe to host-context changes (display mode, sizing, theme) so a view
   * re-reads {@link displayMode}/{@link availableDisplayModes}. Returns an
   * unsubscribe fn. Chains over any existing handler (it never clobbers theme).
   */
  onHostContextChanged?(cb: () => void): () => void;
}
