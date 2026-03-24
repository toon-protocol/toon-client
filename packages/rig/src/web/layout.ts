/**
 * Shared layout for Forge-UI.
 *
 * Provides the page shell: navigation header, content area, and footer.
 */

import { escapeHtml } from './escape.js';

/**
 * Render the shared layout wrapping page content.
 *
 * @param title - Page title (displayed in the header)
 * @param content - Inner HTML content for the page body
 * @param relayUrl - Optional relay URL to display in the header
 * @returns Complete HTML string for the page content area
 */
export function renderLayout(
  title: string,
  content: string,
  relayUrl?: string
): string {
  const relayIndicator = relayUrl
    ? `<span class="layout-relay">${escapeHtml(relayUrl)}</span>`
    : '';

  return `<header class="layout-header">
  <div class="layout-header-inner">
    <a href="/" class="layout-title">&#x2692; ${escapeHtml(title)}</a>
    ${relayIndicator}
  </div>
</header>
<main class="layout-content">
  ${content}
</main>
<footer class="layout-footer">
  Forge &mdash; Decentralized Git on Nostr &amp; TOON Protocol
</footer>`;
}
