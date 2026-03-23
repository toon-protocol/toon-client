// Test IDs: 8.1-INT-001
// AC covered: AC5 (Repository list rendering with real DOM)
// Environment: jsdom (Vitest)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { renderRepoList } from '../templates.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory for creating a RepoMetadata object matching the Story 8.1 interface.
 */
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
    name: overrides.name ?? 'integration-repo',
    description: overrides.description ?? 'Integration test repository',
    ownerPubkey: overrides.ownerPubkey ?? 'ab'.repeat(32),
    defaultBranch: overrides.defaultBranch ?? 'main',
    eventId: overrides.eventId ?? 'a'.repeat(64),
    cloneUrls: overrides.cloneUrls ?? [],
    webUrls: overrides.webUrls ?? [],
  };
}

describe('Integration: Repo List DOM Rendering', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    // jsdom provides document and DOM APIs
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  // ---------------------------------------------------------------------------
  // 8.1-INT-001: Mock kind:30617 data rendered in DOM shows repo entries
  // AC: #5
  // ---------------------------------------------------------------------------

  it('[P1] renders mock kind:30617 data into DOM with expected repo entries', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'alpha-project',
        description: 'First project for testing',
        ownerPubkey: 'cd'.repeat(32),
        defaultBranch: 'main',
      }),
      createRepoMetadata({
        name: 'beta-project',
        description: 'Second project for testing',
        ownerPubkey: 'ef'.repeat(32),
        defaultBranch: 'develop',
      }),
    ];

    // Act -- render HTML and inject into DOM
    const html = renderRepoList(repos);
    container.innerHTML = html;

    // Assert -- verify DOM contains expected elements
    expect(container.textContent).toContain('alpha-project');
    expect(container.textContent).toContain('beta-project');
    expect(container.textContent).toContain('First project for testing');
    expect(container.textContent).toContain('Second project for testing');
  });

  it('[P1] rendered repo entries contain navigation links', () => {
    // Arrange
    const repos = [
      createRepoMetadata({
        name: 'linked-repo',
        ownerPubkey: 'ab'.repeat(32),
      }),
    ];

    // Act
    const html = renderRepoList(repos);
    container.innerHTML = html;

    // Assert -- verify anchor elements exist with correct href pattern
    const links = container.querySelectorAll('a');
    const repoLink = Array.from(links).find((a) =>
      a.getAttribute('href')?.includes('linked-repo')
    );
    expect(repoLink).toBeDefined();
  });

  it('[P2] rendered empty state shows message when no repos', () => {
    // Arrange
    const repos: ReturnType<typeof createRepoMetadata>[] = [];

    // Act
    const html = renderRepoList(repos);
    container.innerHTML = html;

    // Assert
    expect(container.textContent).toContain('No repositories');
    expect(
      container.querySelectorAll('a[href*="/"]').length
    ).toBeLessThanOrEqual(1);
  });

  it('[P0] XSS payloads in repo data are escaped in rendered DOM', () => {
    // Arrange -- inject XSS payloads in repo metadata
    const repos = [
      createRepoMetadata({
        name: '<script>alert("xss")</script>',
        description: '<img src=x onerror=alert(1)>',
      }),
    ];

    // Act
    const html = renderRepoList(repos);
    container.innerHTML = html;

    // Assert -- no script elements should have been created
    expect(container.querySelectorAll('script')).toHaveLength(0);
    // No img elements with onerror should exist
    const imgs = container.querySelectorAll('img[onerror]');
    expect(imgs).toHaveLength(0);
    // The text content should contain the escaped version
    expect(container.textContent).toContain('<script>');
  });
});
