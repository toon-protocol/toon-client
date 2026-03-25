// @vitest-environment jsdom
// Test IDs: 8.5-INT-002
// AC covered: #13, #15 (PR list rendering from relay data)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { renderPRList } from '../templates.js';
import { renderLayout } from '../layout.js';
import { ProfileCache } from '../profile-cache.js';
import type { PRMetadata } from '../nip34-parsers.js';

describe('Integration: Pulls List', () => {
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

  it('[P1] renders 2 PRs with correct status badges (one open, one applied) (8.5-INT-002)', () => {
    const cache = new ProfileCache();
    cache.setProfile('ab'.repeat(32), { name: 'Alice' });
    cache.setProfile('cd'.repeat(32), { name: 'Bob' });

    const prs: PRMetadata[] = [
      {
        eventId: '1'.repeat(64),
        title: 'Add new parser',
        content: 'Patch adding a new parser',
        authorPubkey: 'ab'.repeat(32),
        createdAt: 1711180800,
        commitShas: ['abc123'],
        baseBranch: 'main',
        status: 'open',
      },
      {
        eventId: '2'.repeat(64),
        title: 'Fix rendering bug',
        content: 'Patch fixing rendering',
        authorPubkey: 'cd'.repeat(32),
        createdAt: 1711094400,
        commitShas: ['def456', 'ghi789'],
        baseBranch: 'develop',
        status: 'applied',
      },
    ];

    const result = renderPRList('test-repo', prs, cache, 'npub1test');
    const html = renderLayout('Rig', result.html, 'wss://localhost:7100');
    container.innerHTML = html;

    // Verify titles
    expect(container.textContent).toContain('Add new parser');
    expect(container.textContent).toContain('Fix rendering bug');

    // Verify authors
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Bob');

    // Verify status badges
    const openBadge = container.querySelector('.status-open');
    const appliedBadge = container.querySelector('.status-applied');
    expect(openBadge).not.toBeNull();
    expect(appliedBadge).not.toBeNull();

    // Verify base branches
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('develop');

    // Verify contribution banner
    expect(container.textContent).toContain('Rig-UI is read-only');
  });

  it('[P1] empty relay response renders empty state message', () => {
    const cache = new ProfileCache();
    const result = renderPRList('test-repo', [], cache, 'npub1test');
    const html = renderLayout('Rig', result.html, 'wss://localhost:7100');
    container.innerHTML = html;

    expect(container.textContent).toContain(
      'No pull requests found for this repository'
    );
    expect(container.textContent).toContain('kind:1617');
  });
});
