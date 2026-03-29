/**
 * Markdown-safe content renderer for Rig-UI.
 *
 * Provides a safe subset of markdown rendering that prevents XSS while
 * offering basic readability. This is NOT a full markdown renderer.
 *
 * Order of operations:
 * 1. HTML-escape all input
 * 2. Extract and protect fenced code blocks (placeholders)
 * 3. Extract and protect inline backtick code (placeholders)
 * 4. Auto-link URLs (not inside any code)
 * 5. Paragraph breaks (double newlines)
 * 6. Restore fenced code blocks and inline code from placeholders
 */

import { escapeHtml } from './escape.js';

/**
 * Render content with a safe subset of markdown transformations.
 *
 * All input is HTML-escaped first, then safe transformations are applied.
 * Content inside code blocks is NOT further transformed.
 *
 * @param content - Raw content string (may contain markdown-like formatting)
 * @returns HTML string safe for rendering
 */
export function renderMarkdownSafe(content: string): string {
  // Step 1: HTML-escape everything, and strip null bytes to prevent
  // placeholder collision (user content containing \x00CODEBLOCK...\x00
  // would otherwise be consumed by the restore step).
  // eslint-disable-next-line no-control-regex -- intentional: strip null bytes to prevent placeholder collision
  let html = escapeHtml(content).replace(/\x00/g, '');

  // Step 2: Extract fenced code blocks (triple backtick) and replace with placeholders
  const codeBlocks: string[] = [];
  html = html.replace(
    /```(?:[^\n]*)\n([\s\S]*?)```/g,
    (_match, code: string) => {
      const index = codeBlocks.length;
      // Code block content is already escaped, do not apply further transforms
      codeBlocks.push(`<pre class="code-block"><code>${code}</code></pre>`);
      return `\x00CODEBLOCK${index}\x00`;
    }
  );

  // Step 3: Inline backtick code — extract to placeholders (like fenced code blocks)
  // to prevent URL auto-linking inside inline code spans
  const inlineCodeBlocks: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlineCodeBlocks.length;
    inlineCodeBlocks.push(`<code class="inline-code">${code}</code>`);
    return `\x00INLINECODE${index}\x00`;
  });

  // Step 4: Auto-link URLs (http:// and https:// only)
  // After HTML escaping, URLs still contain their original characters except
  // & -> &amp;, so we match non-whitespace runs that start with http(s)://
  // and stop at whitespace or HTML entity boundaries like &lt; &gt;
  // Strip trailing punctuation (.,;:!?) that is likely sentence-level, not part of URL
  html = html.replace(/https?:\/\/[^\s<>]+/g, (url) => {
    // Strip trailing punctuation that is likely not part of the URL
    let cleanUrl = url;
    let trailing = '';
    const trailingMatch = cleanUrl.match(/([.,;:!?)]+)$/);
    if (trailingMatch) {
      trailing = trailingMatch[1] as string;
      cleanUrl = cleanUrl.slice(0, -trailing.length);
    }
    // Decode HTML entities back for the href value
    const decodedUrl = cleanUrl
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'");
    const safeHref = encodeURI(decodedUrl);
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
  });

  // Step 5: Paragraph breaks (double newlines)
  html = html.replace(/\n\n/g, '<br><br>');

  // Step 6: Restore inline code and fenced code blocks from placeholders
  // eslint-disable-next-line no-control-regex -- intentional: restore placeholders using null-byte delimiters
  html = html.replace(/\x00INLINECODE(\d+)\x00/g, (_match, index: string) => {
    return inlineCodeBlocks[parseInt(index, 10)] ?? '';
  });
  // eslint-disable-next-line no-control-regex -- intentional: restore placeholders using null-byte delimiters
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, index: string) => {
    return codeBlocks[parseInt(index, 10)] ?? '';
  });

  return html;
}
