// @vitest-environment jsdom
// Test IDs: 8.2-INT-002
// AC covered: #14, #16 (Blob view integration, XSS prevention)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { isBinaryBlob } from '../git-objects.js';
import { renderBlobView } from '../templates.js';

describe('Integration: Blob View Rendering', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('[P1] renders file content with line numbers in DOM', () => {
    // Arrange
    const content = 'function hello() {\n  return "world";\n}\n';
    const data = new TextEncoder().encode(content);
    const binary = isBinaryBlob(data);

    // Act
    const result = renderBlobView(
      'test-repo',
      'main',
      'src/hello.ts',
      content,
      binary,
      data.length,
      'npub1test'
    );
    container.innerHTML = result.html;

    // Assert
    expect(result.status).toBe(200);
    expect(container.textContent).toContain('function hello()');
    expect(container.textContent).toContain('return');
    // Line numbers should be present
    expect(container.querySelectorAll('.line-number').length).toBeGreaterThan(
      0
    );
  });

  it('[P0] XSS in file content is escaped in DOM — script tags not executed', () => {
    // Arrange — an HTML file containing script tags
    const content =
      '<html><head><script>alert("xss")</script></head><body>Hello</body></html>';

    // Act
    const result = renderBlobView(
      'test-repo',
      'main',
      'index.html',
      content,
      false,
      content.length,
      'npub1test'
    );
    container.innerHTML = result.html;

    // Assert — no script elements should be created in the DOM
    expect(container.querySelectorAll('script')).toHaveLength(0);
    // The literal text should be visible
    expect(container.textContent).toContain('<script>');
    expect(container.textContent).toContain('alert("xss")');
  });

  it('[P1] binary blob shows "Binary file" message, not garbled content', () => {
    // Arrange
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    const binary = isBinaryBlob(data);
    expect(binary).toBe(true);

    // Act
    const result = renderBlobView(
      'test-repo',
      'main',
      'image.png',
      null,
      true,
      data.length,
      'npub1test'
    );
    container.innerHTML = result.html;

    // Assert
    expect(result.status).toBe(200);
    expect(container.textContent).toContain('Binary file');
    expect(container.textContent).toContain('not displayed');
  });
});
