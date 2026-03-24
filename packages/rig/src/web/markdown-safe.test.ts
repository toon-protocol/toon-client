// Test IDs: 8.5-UNIT-007
// AC covered: AC #16, #24 (Markdown-safe renderer, XSS prevention)

import { describe, it, expect } from 'vitest';

import { renderMarkdownSafe } from './markdown-safe.js';

describe('Markdown-Safe Renderer', () => {
  // ---------------------------------------------------------------------------
  // 8.5-UNIT-007: Markdown-safe content rendering
  // ---------------------------------------------------------------------------

  it('[P1] converts double newlines to <br><br>', () => {
    const result = renderMarkdownSafe('Hello\n\nWorld');
    expect(result).toContain('Hello<br><br>World');
  });

  it('[P1] renders fenced code blocks as <pre><code>', () => {
    const input = '```\nconst x = 1;\n```';
    const result = renderMarkdownSafe(input);
    expect(result).toContain('<pre class="code-block"><code>');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('</code></pre>');
  });

  it('[P1] renders inline backtick code as <code>', () => {
    const result = renderMarkdownSafe('Use `npm install` to setup');
    expect(result).toContain('<code class="inline-code">npm install</code>');
  });

  it('[P1] auto-links http URLs', () => {
    const result = renderMarkdownSafe('Visit http://example.com for more');
    expect(result).toContain('<a href="http://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('[P1] auto-links https URLs', () => {
    const result = renderMarkdownSafe('Visit https://example.com/path');
    expect(result).toContain('<a href="https://example.com/path"');
  });

  it('[P0] does NOT link javascript: URLs (XSS prevention)', () => {
    const result = renderMarkdownSafe('javascript:alert(1)');
    expect(result).not.toContain('<a href="javascript:');
    // The text is present but NOT wrapped in an anchor tag
    expect(result).not.toContain('<a href=');
  });

  it('[P0] HTML in content is escaped (script tags)', () => {
    const result = renderMarkdownSafe('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('[P0] HTML event handlers are escaped', () => {
    const result = renderMarkdownSafe('<img onerror="alert(1)" src=x>');
    // The entire tag is escaped as text, so no actual img element is created
    expect(result).toContain('&lt;img');
    expect(result).toContain('onerror=&quot;alert(1)&quot;');
    // Critically: no actual HTML img tag with onerror handler
    expect(result).not.toContain('<img');
  });

  it('[P1] content inside code blocks is NOT auto-linked', () => {
    const input = '```\nhttps://example.com\n```';
    const result = renderMarkdownSafe(input);
    // The URL inside a code block should not be wrapped in <a> tags
    expect(result).not.toContain('<a href="https://example.com"');
    // But the URL text should still be present
    expect(result).toContain('https://example.com');
  });

  it('[P1] content inside inline code is NOT auto-linked', () => {
    const input = 'Use `https://example.com/api` as the endpoint';
    const result = renderMarkdownSafe(input);
    // The URL inside inline code should not be wrapped in <a> tags
    expect(result).not.toContain('<a href="https://example.com/api"');
    // But the URL text should still be present inside <code>
    expect(result).toContain(
      '<code class="inline-code">https://example.com/api</code>'
    );
  });

  it('[P2] handles empty string', () => {
    const result = renderMarkdownSafe('');
    expect(result).toBe('');
  });

  it('[P2] handles plain text without any markdown', () => {
    const result = renderMarkdownSafe('Just a simple text message');
    expect(result).toBe('Just a simple text message');
  });

  it('[P1] single newlines are preserved as-is (not converted to br)', () => {
    const result = renderMarkdownSafe('Line 1\nLine 2');
    expect(result).not.toContain('<br>');
    expect(result).toContain('Line 1\nLine 2');
  });

  // ---------------------------------------------------------------------------
  // NFR: Additional security and edge case tests
  // ---------------------------------------------------------------------------

  it('[P0] null bytes in content are stripped to prevent placeholder collision', () => {
    // If content contains the internal placeholder pattern, it must not
    // be interpreted as a code block replacement marker.
    const result = renderMarkdownSafe('\x00CODEBLOCK0\x00');
    // The null bytes are stripped, leaving the literal text
    expect(result).toContain('CODEBLOCK0');
    // Must not produce empty output (which would happen without null byte stripping)
    expect(result).not.toBe('');
  });

  it('[P1] URLs with query parameters containing & are auto-linked correctly', () => {
    const result = renderMarkdownSafe(
      'See https://example.com/search?q=foo&bar=baz for details'
    );
    // The & in query params is HTML-escaped to &amp; in the display text
    expect(result).toContain('<a href=');
    expect(result).toContain('example.com/search');
    // The href should contain the decoded URL with proper encoding
    expect(result).toContain('q=foo');
  });

  it('[P0] URL with encoded quote in path does not break href attribute', () => {
    // After HTML escaping, " becomes &quot; which the regex matches.
    // The decodedUrl would contain ", but encodeURI must encode it to %22.
    const result = renderMarkdownSafe(
      'https://example.com/path"onclick="alert(1)'
    );
    // The URL should be safely encoded with %22 for quotes
    expect(result).toContain('<a href=');
    expect(result).toContain('%22');
    // Verify the href value does not contain a raw unencoded double quote
    // Extract href value and verify it's properly encoded
    const hrefMatch = result.match(/href="([^"]*)"/);
    expect(hrefMatch).not.toBeNull();
    expect(hrefMatch![1]).not.toContain('"');
    expect(hrefMatch![1]).toContain('%22');
  });

  it('[P1] fenced code block with language specifier is handled', () => {
    const input = '```typescript\nconst x: number = 1;\n```';
    const result = renderMarkdownSafe(input);
    expect(result).toContain('<pre class="code-block"><code>');
    expect(result).toContain('const x: number = 1;');
    // Language name should not appear in output (stripped by regex)
    expect(result).not.toContain('typescript');
  });

  it('[P1] multiple code blocks are all extracted and restored correctly', () => {
    const input = '```\nblock one\n```\nMiddle text\n```\nblock two\n```';
    const result = renderMarkdownSafe(input);
    expect(result).toContain('block one');
    expect(result).toContain('block two');
    expect(result).toContain('Middle text');
    // Both should be in code blocks
    const codeBlockCount = (result.match(/<pre class="code-block">/g) ?? [])
      .length;
    expect(codeBlockCount).toBe(2);
  });

  it('[P1] inline code inside code blocks is not double-processed', () => {
    const input = '```\n`inline` inside block\n```';
    const result = renderMarkdownSafe(input);
    // The backticks inside the code block should remain as escaped text,
    // not be transformed to <code> elements
    expect(result).not.toContain('<code class="inline-code">');
  });

  it('[P0] data: URI scheme is not linked', () => {
    const result = renderMarkdownSafe(
      'data:text/html,<script>alert(1)</script>'
    );
    expect(result).not.toContain('<a href="data:');
  });

  // ---------------------------------------------------------------------------
  // AC #24 gap-fill: encodeURI() applied to auto-linked URLs
  // ---------------------------------------------------------------------------

  it('[P1] auto-linked URL href uses encodeURI (AC #24)', () => {
    const result = renderMarkdownSafe(
      'See https://example.com/path with spaces'
    );
    const hrefMatch = result.match(/href="([^"]*)"/);
    expect(hrefMatch).not.toBeNull();
    // encodeURI should not produce raw spaces in href
    expect(hrefMatch![1]).not.toContain(' ');
  });

  it('[P0] ftp: URI scheme is not auto-linked (only http/https allowed) (AC #24)', () => {
    const result = renderMarkdownSafe('ftp://files.example.com/pub');
    expect(result).not.toContain('<a href="ftp:');
  });
});
