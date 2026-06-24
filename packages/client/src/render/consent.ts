/**
 * The consent invariant — the load-bearing security property of branch 3
 * (sandboxed mcp-ui, low trust) of the NIP-on-TOON render trust gradient
 * (toon-meta#58, toon-client#90; spec §"Branch 3 — sandboxed mcp-ui & the
 * consent invariant").
 *
 * ── The invariant (verbatim from the spec) ──────────────────────────────────
 * A sandboxed widget may only *request* an action. The authorization surface is
 * rendered by the trusted client outside the iframe and is non-themeable. The
 * sandboxed widget can never draw, style, or spoof the consent/authorization UI.
 * A widget that can paint the authorization UI collapses the entire trust
 * gradient to its lowest tier.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module is the framework-agnostic half of branch 3. It carries the
 * *decision* and the *policy*, not any React tree — mirroring how `@toon-protocol/client`'s
 * {@link ./dispatch} carries the render decision and `@toon-protocol/views`
 * carries the rendered component. The React side (the sandboxed `AppRenderer`
 * iframe + the host-rendered, non-themeable `ConsentPrompt`) lives in
 * `@toon-protocol/views`; it consumes the types and functions defined here.
 *
 * Why the policy lives here, away from React:
 *   - The classification of "is this a state-changing action that needs explicit
 *     authorization?" is a pure, auditable function with no DOM dependency.
 *   - The widget supplies ZERO inputs to this function that can influence the
 *     *appearance* of the prompt: it supplies only the requested tool name and
 *     arguments. Everything the prompt renders is derived by the trusted client.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { MIME_MCP_APP, UI_RENDERER_KIND } from './constants.js';

/**
 * The widget payload handed to the sandboxed iframe. The `m`-tagged
 * `text/html;profile=mcp-app` renderer ships a raw HTML widget as a UIResource;
 * we pass the HTML through to the iframe untouched, but everything the host
 * renders around it is client-controlled.
 *
 * Deliberately minimal: the host needs only the HTML to feed the iframe and the
 * mimeType to assert the branch. No widget-supplied styling, theme, chrome, or
 * "trusted" hints are carried — by construction the widget cannot pass any.
 */
export interface UiResource {
  /** The raw widget HTML to render inside the sandboxed iframe. */
  html: string;
  /** Always `text/html;profile=mcp-app` for branch 3 (asserted on extract). */
  mimeType: string;
  /** The `ui://…` resource URI, if the renderer declared one (host metadata only). */
  uri?: string;
}

/**
 * Extract the branch-3 {@link UiResource} from a resolved `kind:31036` renderer
 * event whose `m` tag is `text/html;profile=mcp-app`.
 *
 * The renderer's `content` is either the raw widget HTML, or a JSON-encoded
 * MCP `UIResource` embedded-resource block (`{ type: 'resource', resource: {
 * uri, mimeType, text } }`) as produced by mcp-ui servers. Both are accepted;
 * the HTML is returned verbatim for iframe passthrough.
 *
 * Returns `undefined` (never throws) when the event is not a usable branch-3
 * renderer, so the caller can fall through to branch 4 rather than render
 * something unexpected.
 */
export function extractUiResource(renderer: NostrEvent | undefined): UiResource | undefined {
  if (!renderer || renderer.kind !== UI_RENDERER_KIND) return undefined;
  const mime = renderer.tags.find((t) => t[0] === 'm')?.[1];
  if (mime !== MIME_MCP_APP) return undefined;

  const raw = renderer.content;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  // Try the embedded-resource JSON shape first; fall back to raw HTML.
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as {
        type?: string;
        resource?: { uri?: unknown; mimeType?: unknown; text?: unknown };
      };
      const res = parsed.resource;
      if (parsed.type === 'resource' && res && typeof res.text === 'string') {
        return {
          html: res.text,
          mimeType: MIME_MCP_APP,
          ...(typeof res.uri === 'string' ? { uri: res.uri } : {}),
        };
      }
    } catch {
      // Not JSON — treat the whole content as raw HTML below.
    }
  }
  return { html: raw, mimeType: MIME_MCP_APP };
}

/**
 * An action a sandboxed widget *requested* (never performed). This is the only
 * thing that crosses the iframe → host boundary, and it carries no presentation
 * data — only the tool name and arguments the widget wants to invoke.
 */
export interface WidgetIntent {
  /** The tool/action name the widget asked the host to invoke. */
  toolName: string;
  /** The arguments the widget supplied for that tool. */
  arguments: Record<string, unknown>;
}

/**
 * The classification of a {@link WidgetIntent}: does it need an explicit, host-
 * rendered authorization decision before the host may act on it?
 *
 * - `requires-consent` — a state-changing / spendy / outbound action. The host
 *   MUST render the {@link ConsentRequest} prompt (outside the iframe,
 *   non-themeable) and only proceed on an explicit user grant.
 * - `auto` — a read-only / inert request the host may forward without a prompt.
 *
 * Default-deny: anything not provably inert is treated as `requires-consent`.
 */
export type IntentClassification = 'requires-consent' | 'auto';

/**
 * Tool-name prefixes / names that are read-only on the TOON client and therefore
 * safe to forward without an authorization prompt. Everything else (publishing,
 * paying, swapping, channel ops, media upload, link opening, anything unknown)
 * requires explicit, host-rendered consent.
 *
 * This allowlist is intentionally tiny and lives in trusted client code; a
 * widget cannot extend it.
 */
const AUTO_FORWARD_TOOLS: ReadonlySet<string> = new Set([
  'toon_read',
  'toon_query',
  'toon_status',
  'toon_identity',
  'toon_channels',
  'toon_targets',
  'toon_atoms',
]);

/**
 * Classify a widget intent. Pure and default-deny: only an exact match against
 * the trusted read-only allowlist is auto-forwarded; everything else requires a
 * host-rendered consent prompt.
 */
export function classifyIntent(intent: WidgetIntent): IntentClassification {
  return AUTO_FORWARD_TOOLS.has(intent.toolName) ? 'auto' : 'requires-consent';
}

/**
 * The data the trusted host needs to render an authorization prompt for a
 * widget-requested action. EVERY field here is either a fixed, client-owned
 * constant or a plain machine value copied out of the intent — there is NO
 * styling, theme, color, label-override, HTML, or markup field the widget could
 * supply. This is what makes the prompt non-themeable by construction: the type
 * simply has nowhere to put presentation input.
 */
export interface ConsentRequest {
  /** Stable id for correlating the prompt with its resolution. */
  readonly id: string;
  /** The tool the widget asked to invoke (rendered as plain text by the host). */
  readonly toolName: string;
  /** The arguments the widget supplied (rendered as inspectable data, not HTML). */
  readonly arguments: Record<string, unknown>;
  /**
   * The trust tier of the requesting surface — always `'low'` for a branch-3
   * sandboxed widget. Carried so the host can render the appropriate warning
   * chrome; the widget cannot change it.
   */
  readonly trust: 'low';
}

/** The user's decision on a {@link ConsentRequest}. */
export type ConsentDecision = 'grant' | 'deny';

/** Monotonic counter so generated consent ids are unique within a session. */
let consentSeq = 0;

/**
 * Build a {@link ConsentRequest} from a widget intent. The host calls this when
 * {@link classifyIntent} returns `requires-consent`. It copies ONLY the tool
 * name and arguments out of the widget's request; it fixes `trust: 'low'` and
 * generates the id itself. The widget contributes nothing to how the prompt
 * looks.
 */
export function buildConsentRequest(intent: WidgetIntent): ConsentRequest {
  consentSeq += 1;
  return {
    id: `consent-${consentSeq}`,
    toolName: intent.toolName,
    arguments: intent.arguments,
    trust: 'low',
  };
}
