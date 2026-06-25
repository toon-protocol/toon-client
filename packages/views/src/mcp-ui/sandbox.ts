/**
 * Hardened sandbox configuration for branch 3 (sandboxed mcp-ui, low trust) of
 * the NIP-on-TOON render trust gradient (toon-meta#58, toon-client#90).
 *
 * The branch-3 widget is UNTRUSTED renderer code shipped as raw HTML by a
 * `kind:31036` event with `m: text/html;profile=mcp-app`. It is confined to an
 * iframe whose `sandbox` attribute is locked down here. The single most
 * important hardening is dropping `allow-same-origin`: without it the iframe
 * runs in an opaque origin, so the widget cannot reach the host's cookies,
 * `localStorage`, `IndexedDB`, or same-origin DOM — and therefore cannot read or
 * repaint the host-rendered consent surface.
 *
 * `@mcp-ui/client`'s default sandbox permission string is
 * `"allow-scripts allow-same-origin allow-forms"`. We deliberately OVERRIDE it
 * to a stricter allowlist with NO `allow-same-origin` and NO top-navigation /
 * popup escapes.
 */

/**
 * The locked-down iframe `sandbox` attribute for an untrusted branch-3 widget.
 *
 * Granted:
 *   - `allow-scripts` — the widget needs JS to render and to *request* actions
 *     over the postMessage bridge. (With `allow-scripts` but WITHOUT
 *     `allow-same-origin`, the iframe is a hostile, isolated origin — exactly
 *     what we want.)
 *
 * Withheld (each one is a consent-invariant escape if granted):
 *   - `allow-same-origin`        — would give the widget the host's origin and
 *                                  thus access to the host DOM / storage; it
 *                                  could then read or overdraw the consent UI.
 *   - `allow-top-navigation`*    — would let the widget navigate the top frame
 *                                  away (phishing / consent bypass).
 *   - `allow-popups`*            — would let the widget open windows it controls.
 *   - `allow-modals`             — would let the widget raise `alert/confirm`
 *                                  dialogs that could be mistaken for host chrome.
 *   - `allow-forms`             — not needed; widget requests ride the bridge.
 *   - `allow-pointer-lock` / `allow-presentation` — UI-capture vectors.
 */
export const BRANCH3_SANDBOX_PERMISSIONS = 'allow-scripts' as const;

/**
 * The default cross-origin mcp-ui sandbox proxy URL. `@mcp-ui/client`'s
 * `AppRenderer` loads this opaque-origin proxy HTML to host the widget iframe, so
 * the widget runs in a foreign origin it cannot escape (no `allow-same-origin`).
 *
 * This is the canonical mcp-ui hosted proxy; a host that self-hosts the proxy can
 * pass its own `URL` to {@link import('./SandboxedAppRenderer.js').SandboxedAppRenderer}.
 */
export const DEFAULT_MCP_UI_SANDBOX_URL = 'https://sandbox.mcpui.dev' as const;

/**
 * The iframe `sandbox` tokens, as a frozen array, for assertion in tests and
 * for callers that prefer a list over the space-joined string.
 */
export const BRANCH3_SANDBOX_TOKENS: readonly string[] = Object.freeze(
  BRANCH3_SANDBOX_PERMISSIONS.split(' ')
);

/** Tokens that MUST NEVER appear in a branch-3 sandbox (each breaks the invariant). */
export const FORBIDDEN_SANDBOX_TOKENS: readonly string[] = Object.freeze([
  'allow-same-origin',
  'allow-top-navigation',
  'allow-top-navigation-by-user-activation',
  'allow-popups',
  'allow-modals',
  'allow-forms',
  'allow-pointer-lock',
  'allow-presentation',
]);

/**
 * Assert that a sandbox permission string is safe for branch 3. Throws if any
 * forbidden token is present. Defensive belt-and-braces so a future edit can't
 * silently re-enable `allow-same-origin`.
 */
export function assertSafeSandbox(permissions: string): void {
  const tokens = new Set(permissions.split(/\s+/).filter(Boolean));
  for (const forbidden of FORBIDDEN_SANDBOX_TOKENS) {
    if (tokens.has(forbidden)) {
      throw new Error(
        `branch-3 sandbox must not grant "${forbidden}" — it breaks the consent invariant`
      );
    }
  }
}
