/**
 * The ViewBridge seam.
 *
 * The composition runtime depends ONLY on this interface, never on the MCP SDK
 * directly. The real implementation ({@link ./ext-apps-bridge}) wraps the
 * official `@modelcontextprotocol/ext-apps` `App`; tests inject a mock. Swapping
 * to a different transport (or mcp-ui) is a one-file change here.
 */

import { type NostrEvent } from '../types.js';

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
}
