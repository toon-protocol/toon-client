// @vitest-environment jsdom
// Tests for shared layout rendering
// AC covered: AC8 (Shared layout with nav header, title "Forge", content area)

import { describe, it, expect } from 'vitest';

import { renderLayout } from './layout.js';

describe('renderLayout', () => {
  it('renders header with the provided title', () => {
    const html = renderLayout('Forge', '<p>Hello</p>');
    expect(html).toContain('Forge');
    expect(html).toContain('layout-header');
  });

  it('renders a navigation header with a link to root', () => {
    const html = renderLayout('Forge', '<p>Content</p>');
    const container = document.createElement('div');
    container.innerHTML = html;

    const titleLink = container.querySelector('a.layout-title');
    expect(titleLink).not.toBeNull();
    expect(titleLink!.getAttribute('href')).toBe('/');
    expect(titleLink!.textContent).toBe('Forge');
  });

  it('renders a content area with the provided content', () => {
    const html = renderLayout('Forge', '<p>My content here</p>');
    expect(html).toContain('layout-content');
    expect(html).toContain('My content here');
  });

  it('renders a footer', () => {
    const html = renderLayout('Forge', '<p>Content</p>');
    expect(html).toContain('layout-footer');
  });

  it('displays relay URL indicator when provided', () => {
    const html = renderLayout(
      'Forge',
      '<p>Content</p>',
      'wss://relay.example.com'
    );
    expect(html).toContain('wss://relay.example.com');
    expect(html).toContain('layout-relay');
  });

  it('does not display relay indicator when relay URL is not provided', () => {
    const html = renderLayout('Forge', '<p>Content</p>');
    expect(html).not.toContain('layout-relay');
  });

  it('escapes XSS in title', () => {
    const html = renderLayout('<script>alert(1)</script>', '<p>Safe</p>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes XSS in relay URL', () => {
    const html = renderLayout(
      'Forge',
      '<p>Safe</p>',
      '"><script>alert(1)</script>'
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
