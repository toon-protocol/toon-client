// @vitest-environment jsdom
// Test IDs: 8.1-INT-002
// AC covered: AC9 (Repo navigation -- click repo name navigates to file tree)
// Environment: jsdom (Vitest)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { renderRepoList } from '../templates.js';

// ============================================================================
// Factories
// ============================================================================

function createRepoMetadata(
  overrides: {
    name?: string;
    description?: string;
    ownerPubkey?: string;
    defaultBranch?: string;
    eventId?: string;
    cloneUrls?: string[];
    webUrls?: string[];
  } = {}
) {
  return {
    name: overrides.name ?? 'nav-test-repo',
    description: overrides.description ?? 'Navigation test repo',
    ownerPubkey: overrides.ownerPubkey ?? 'ab'.repeat(32),
    defaultBranch: overrides.defaultBranch ?? 'main',
    eventId: overrides.eventId ?? 'a'.repeat(64),
    cloneUrls: overrides.cloneUrls ?? [],
    webUrls: overrides.webUrls ?? [],
  };
}

describe('Integration: Repo List Navigation', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'app';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  // ---------------------------------------------------------------------------
  // 8.1-INT-002: Click repo name triggers navigation to file tree route
  // AC: #9
  // ---------------------------------------------------------------------------

  it('[P2] clicking repo name link has href to /<npub>/<repo>/ route', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'clickable-repo',
        ownerPubkey: 'cd'.repeat(32),
      }),
    ];

    const html = renderRepoList(repos);
    container.innerHTML = html;

    // Act -- find the repo link
    const repoLink = container.querySelector('a[href*="clickable-repo"]');
    expect(repoLink).not.toBeNull();

    // Assert -- should navigate to file tree route
    // The href should follow the pattern /<owner-npub>/<repo-name>/
    const href = repoLink!.getAttribute('href');
    expect(href).toContain('clickable-repo');
    expect(href).toMatch(/\/npub1[a-z0-9]+\/clickable-repo\//);
  });

  it('[P2] repo link href contains owner npub and repo name', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'my-project',
        ownerPubkey: 'ef'.repeat(32),
      }),
    ];

    const html = renderRepoList(repos);
    container.innerHTML = html;

    // Act
    const links = container.querySelectorAll('a');
    const repoLink = Array.from(links).find((a) =>
      a.getAttribute('href')?.includes('my-project')
    );

    // Assert -- href should contain npub-encoded owner and repo name
    expect(repoLink).toBeDefined();
    const href = repoLink!.getAttribute('href')!;
    expect(href).toMatch(/^\/npub1[a-z0-9]+\/my-project\//);
  });
});
