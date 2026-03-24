// @vitest-environment jsdom
// Test IDs: 8.2-INT-001
// AC covered: #11, #12 (Tree navigation integration)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { parseGitTree } from '../git-objects.js';
import { renderTreeView } from '../templates.js';

// ============================================================================
// Helpers
// ============================================================================

function buildTreeEntry(mode: string, name: string, shaHex: string): number[] {
  const bytes: number[] = [];
  for (const ch of mode) bytes.push(ch.charCodeAt(0));
  bytes.push(0x20);
  const nameBytes = new TextEncoder().encode(name);
  for (const b of nameBytes) bytes.push(b);
  bytes.push(0x00);
  for (let i = 0; i < 40; i += 2) {
    bytes.push(parseInt(shaHex.slice(i, i + 2), 16));
  }
  return bytes;
}

function buildTreeObject(
  entries: { mode: string; name: string; sha: string }[]
): Uint8Array {
  const allBytes: number[] = [];
  for (const entry of entries) {
    allBytes.push(...buildTreeEntry(entry.mode, entry.name, entry.sha));
  }
  return new Uint8Array(allBytes);
}

// ============================================================================
// Tests
// ============================================================================

describe('Integration: File Tree Navigation', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('[P1] renders directory listing from parsed tree data', () => {
    // Arrange — build tree bytes and parse
    const treeData = buildTreeObject([
      { mode: '40000', name: 'src', sha: 'aa'.repeat(20) },
      { mode: '100644', name: 'README.md', sha: 'bb'.repeat(20) },
      { mode: '100644', name: 'package.json', sha: 'cc'.repeat(20) },
    ]);
    const entries = parseGitTree(treeData);

    // Act — render tree view and inject into DOM
    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );
    container.innerHTML = result.html;

    // Assert — verify DOM contains expected elements
    expect(container.textContent).toContain('src');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('package.json');

    // Verify links exist
    const links = container.querySelectorAll('a');
    expect(links.length).toBeGreaterThanOrEqual(3);

    // Verify directory appears before files (sorted)
    const allText = container.textContent ?? '';
    const srcPos = allText.indexOf('src');
    const readmePos = allText.indexOf('README.md');
    expect(srcPos).toBeLessThan(readmePos);
  });

  it('[P1] subtree rendering shows subdirectory entries', () => {
    // Arrange — simulate subdirectory tree
    const subtreeData = buildTreeObject([
      { mode: '100644', name: 'index.ts', sha: 'dd'.repeat(20) },
      { mode: '100644', name: 'utils.ts', sha: 'ee'.repeat(20) },
    ]);
    const entries = parseGitTree(subtreeData);

    // Act — render subtree at path src/
    const result = renderTreeView(
      'test-repo',
      'main',
      'src',
      entries,
      'npub1test'
    );
    container.innerHTML = result.html;

    // Assert
    expect(container.textContent).toContain('index.ts');
    expect(container.textContent).toContain('utils.ts');
    // Breadcrumbs should show path
    expect(container.textContent).toContain('src');
  });

  it('[P0] XSS in tree entry names is escaped in rendered DOM', () => {
    const treeData = buildTreeObject([
      {
        mode: '100644',
        name: '<script>alert("xss")</script>',
        sha: 'ff'.repeat(20),
      },
    ]);
    const entries = parseGitTree(treeData);

    const result = renderTreeView(
      'test-repo',
      'main',
      '',
      entries,
      'npub1test'
    );
    container.innerHTML = result.html;

    // No script elements should be created
    expect(container.querySelectorAll('script')).toHaveLength(0);
    // The text should be visible as escaped
    expect(container.textContent).toContain('<script>');
  });
});
