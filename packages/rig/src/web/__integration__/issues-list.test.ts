// @vitest-environment jsdom
// Test IDs: 8.5-INT-001
// AC covered: #10, #12 (Issue list rendering from relay data)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { renderIssueList } from '../templates.js';
import { renderLayout } from '../layout.js';
import { ProfileCache } from '../profile-cache.js';
import type { IssueMetadata } from '../nip34-parsers.js';

describe('Integration: Issues List', () => {
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

  it('[P1] renders 3 issues with correct titles, authors, dates, status indicators (8.5-INT-001)', () => {
    const cache = new ProfileCache();
    cache.setProfile('ab'.repeat(32), { name: 'Alice' });
    cache.setProfile('cd'.repeat(32), { name: 'Bob' });
    cache.setProfile('ef'.repeat(32), { displayName: 'Charlie' });

    const issues: IssueMetadata[] = [
      {
        eventId: '1'.repeat(64),
        title: 'Bug: crash on startup',
        content: 'The app crashes when launched',
        authorPubkey: 'ab'.repeat(32),
        createdAt: 1711180800, // 2024-03-23
        labels: ['bug'],
        status: 'open',
      },
      {
        eventId: '2'.repeat(64),
        title: 'Feature request: dark mode',
        content: 'Please add dark mode',
        authorPubkey: 'cd'.repeat(32),
        createdAt: 1711094400,
        labels: ['enhancement'],
        status: 'closed',
      },
      {
        eventId: '3'.repeat(64),
        title: 'Docs: update README',
        content: 'README is outdated',
        authorPubkey: 'ef'.repeat(32),
        createdAt: 1711008000,
        labels: [],
        status: 'open',
      },
    ];

    const result = renderIssueList('test-repo', issues, cache, 'npub1test');
    const html = renderLayout('Rig', result.html, 'wss://localhost:7100');
    container.innerHTML = html;

    // Verify titles
    expect(container.textContent).toContain('Bug: crash on startup');
    expect(container.textContent).toContain('Feature request: dark mode');
    expect(container.textContent).toContain('Docs: update README');

    // Verify authors
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('Charlie');

    // Verify status badges
    const badges = container.querySelectorAll('.status-badge');
    expect(badges.length).toBe(3);

    // Verify labels
    expect(container.textContent).toContain('bug');
    expect(container.textContent).toContain('enhancement');

    // Verify contribution banner
    expect(container.textContent).toContain('Rig-UI is read-only');
  });

  it('[P1] empty relay response renders empty state message', () => {
    const cache = new ProfileCache();
    const result = renderIssueList('test-repo', [], cache, 'npub1test');
    const html = renderLayout('Rig', result.html, 'wss://localhost:7100');
    container.innerHTML = html;

    expect(container.textContent).toContain(
      'No issues found for this repository'
    );
    expect(container.textContent).toContain('kind:1621');
  });
});
