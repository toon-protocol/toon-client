/**
 * HTML escaping utilities for XSS prevention.
 *
 * All user-supplied content from Nostr events MUST be escaped before
 * rendering into HTML. This is the primary security surface for Forge-UI.
 */

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/**
 * Escapes HTML special characters to prevent XSS.
 *
 * Replaces &, <, >, ", and ' with their HTML entity equivalents.
 */
export function escapeHtml(str: string): string {
  return str.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}
