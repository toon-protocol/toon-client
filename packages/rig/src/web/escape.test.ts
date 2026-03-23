// Tests for HTML escaping utility
// AC covered: AC12 (XSS prevention foundation)

import { describe, it, expect } from 'vitest';

import { escapeHtml } from './escape.js';

describe('escapeHtml', () => {
  it('escapes & to &amp;', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes < to &lt;', () => {
    expect(escapeHtml('a<b')).toBe('a&lt;b');
  });

  it('escapes > to &gt;', () => {
    expect(escapeHtml('a>b')).toBe('a&gt;b');
  });

  it('escapes double quotes to &quot;', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });

  it('escapes single quotes to &#x27;', () => {
    expect(escapeHtml("a'b")).toBe('a&#x27;b');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('returns the same string when no special characters', () => {
    expect(escapeHtml('hello world 123')).toBe('hello world 123');
  });

  it('escapes multiple special characters in one string', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes all five characters together', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#x27;');
  });
});
