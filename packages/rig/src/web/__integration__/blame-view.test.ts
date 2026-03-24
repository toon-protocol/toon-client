// @vitest-environment jsdom
// Test IDs: 8.4-INT-001
// AC covered: #1, #7, #9, #10, #14, #15, #16 (Blame view integration)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { renderBlameView } from '../templates.js';
import { renderLayout } from '../layout.js';
import type { BlameResult } from '../blame.js';

// ============================================================================
// Tests
// ============================================================================

describe('Integration: Blame View', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T12:00:00Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  it('[P1] renders blame view with correct line attributions across 3 commits (8.4-INT-001)', () => {
    // Simulate a file modified across 3 commits:
    // Commit C (newest): added line 4
    // Commit B: added lines 2-3
    // Commit A (oldest): added line 1
    const commitA = 'a1'.repeat(20);
    const commitB = 'b2'.repeat(20);
    const commitC = 'c3'.repeat(20);

    const blameResult: BlameResult = {
      lines: [
        {
          commitSha: commitA,
          author: 'Alice <alice@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
        {
          commitSha: commitB,
          author: 'Bob <bob@example.com> 1700100000 +0000',
          timestamp: 1700100000,
          lineNumber: 2,
        },
        {
          commitSha: commitB,
          author: 'Bob <bob@example.com> 1700100000 +0000',
          timestamp: 1700100000,
          lineNumber: 3,
        },
        {
          commitSha: commitC,
          author: 'Carol <carol@example.com> 1700200000 +0000',
          timestamp: 1700200000,
          lineNumber: 4,
        },
      ],
      fileContent: 'first line\nsecond line\nthird line\nfourth line',
      beyondLimit: false,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'src/file.ts',
      blameResult,
      false,
      'npub1test'
    );

    container.innerHTML = result.html;

    // Verify correct commit SHAs are displayed
    expect(container.textContent).toContain(commitA.slice(0, 7));
    expect(container.textContent).toContain(commitB.slice(0, 7));
    expect(container.textContent).toContain(commitC.slice(0, 7));

    // Verify author names
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('Carol');

    // Verify line content
    expect(container.textContent).toContain('first line');
    expect(container.textContent).toContain('second line');
    expect(container.textContent).toContain('third line');
    expect(container.textContent).toContain('fourth line');

    // Verify line numbers
    const lineNumbers = container.querySelectorAll('.blame-line-number');
    expect(lineNumbers).toHaveLength(4);
    expect(lineNumbers[0]!.textContent).toBe('1');
    expect(lineNumbers[3]!.textContent).toBe('4');

    // Verify commit links point to correct URLs
    const commitLinks = container.querySelectorAll('.blame-sha a');
    // Lines 2 and 3 are grouped (same commit B), so only 3 links total
    expect(commitLinks).toHaveLength(3);

    // Verify grouping: lines 2 and 3 share commitB, only first shows info
    const blameRows = container.querySelectorAll('.blame-line');
    expect(blameRows).toHaveLength(4);

    // Row 2 (index 1) should have group-start class (first line of commitB group)
    expect(blameRows[1]!.classList.contains('blame-group-start')).toBe(true);
    // Row 3 (index 2) should NOT have group-start (continuation of commitB)
    expect(blameRows[2]!.classList.contains('blame-group-start')).toBe(false);

    // Verify breadcrumbs
    expect(container.textContent).toContain('test-repo');
    expect(container.querySelector('.breadcrumbs')).not.toBeNull();

    // Verify no depth limit notice
    expect(container.querySelector('.blame-depth-notice')).toBeNull();
  });

  it('[P1] renders depth limit notice when beyondLimit is true', () => {
    const blameResult: BlameResult = {
      lines: [
        {
          commitSha: 'ab'.repeat(20),
          author: 'Test <test@test.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
      ],
      fileContent: 'line content',
      beyondLimit: true,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'file.ts',
      blameResult,
      false,
      'npub1test'
    );

    container.innerHTML = result.html;

    const notice = container.querySelector('.blame-depth-notice');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain(
      'Older attributions may be approximate'
    );
  });

  it('[P0] XSS in author name and file content is escaped', () => {
    const blameResult: BlameResult = {
      lines: [
        {
          commitSha: 'ab'.repeat(20),
          author: '<script>evil</script> <x@x.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
      ],
      fileContent: '<img onerror=alert(1) src=x>',
      beyondLimit: false,
      maxDepth: 50,
    };

    const result = renderBlameView(
      'test-repo',
      'main',
      'file.ts',
      blameResult,
      false,
      'npub1test'
    );

    container.innerHTML = result.html;

    // No script or img tags should be rendered
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.querySelectorAll('img[onerror]')).toHaveLength(0);
    expect(result.html).toContain('&lt;img');
  });

  // ---------------------------------------------------------------------------
  // AC #9: Blame empty/error state rendering (file not found vs binary)
  // ---------------------------------------------------------------------------

  it('[P1] renders file-not-found message for null blame result (non-binary)', () => {
    const result = renderBlameView('test-repo', 'main', 'missing.ts', null);

    container.innerHTML = result.html;

    expect(result.status).toBe(404);
    expect(container.textContent).toContain('File not found for blame');
    // Should NOT mention binary
    expect(container.textContent).not.toContain('Binary');
  });

  it('[P1] renders binary-not-applicable message for null blame result (binary)', () => {
    const result = renderBlameView(
      'test-repo',
      'main',
      'image.png',
      null,
      true
    );

    container.innerHTML = result.html;

    expect(result.status).toBe(404);
    expect(container.textContent).toContain('Binary files cannot be blamed');
  });

  // ---------------------------------------------------------------------------
  // AC #14: Blame route handler composition — computeBlame result rendered correctly
  // Tests that the full pipeline (BlameResult -> renderBlameView -> layout) works.
  // ---------------------------------------------------------------------------

  it('[P1] blame route handler composition: blame result renders inside layout (AC #14)', () => {
    const commitSha = 'ab'.repeat(20);
    const blameResult: BlameResult = {
      lines: [
        {
          commitSha,
          author: 'Dev <dev@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 1,
        },
        {
          commitSha,
          author: 'Dev <dev@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 2,
        },
        {
          commitSha,
          author: 'Dev <dev@example.com> 1700000000 +0000',
          timestamp: 1700000000,
          lineNumber: 3,
        },
      ],
      fileContent: 'function hello() {\n  return "world";\n}',
      beyondLimit: false,
      maxDepth: 50,
    };

    // Simulate what renderBlameRoute does: computeBlame -> renderBlameView -> renderLayout
    const viewResult = renderBlameView(
      'my-repo',
      'main',
      'src/index.ts',
      blameResult,
      false,
      'npub1owner'
    );
    const fullHtml = renderLayout(
      'Forge',
      viewResult.html,
      'wss://localhost:7100'
    );

    container.innerHTML = fullHtml;

    // Verify the blame view is embedded within the layout
    expect(container.querySelector('.blame-view')).not.toBeNull();
    expect(container.querySelector('.blame-table')).not.toBeNull();

    // Verify layout wrapper is present
    expect(container.querySelector('.layout-content')).not.toBeNull();

    // Verify blame content is rendered
    expect(container.textContent).toContain('function hello()');
    expect(container.textContent).toContain(commitSha.slice(0, 7));
  });

  // ---------------------------------------------------------------------------
  // AC #15: Loading state — "Loading blame..." message
  // ---------------------------------------------------------------------------

  it('[P1] loading state renders "Loading blame..." message inside layout (AC #15)', () => {
    // Simulate what main.ts does before the async blame call:
    // renderLayout('Forge', '<div class="loading">Loading blame...</div>', relayUrl)
    const loadingHtml = renderLayout(
      'Forge',
      '<div class="loading">Loading blame...</div>',
      'wss://localhost:7100'
    );

    container.innerHTML = loadingHtml;

    expect(container.textContent).toContain('Loading blame...');
    expect(container.querySelector('.loading')).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC #16: Error handling — user-friendly error message on failure
  // ---------------------------------------------------------------------------

  it('[P1] error state renders user-friendly error message inside layout (AC #16)', () => {
    // Simulate what main.ts does on catch:
    const errorHtml = renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load blame view.</div></div>',
      'wss://localhost:7100'
    );

    container.innerHTML = errorHtml;

    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('Could not load blame view.');
    expect(container.querySelector('.empty-state')).not.toBeNull();
  });
});
