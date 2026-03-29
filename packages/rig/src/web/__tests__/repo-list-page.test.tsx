import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hooks before importing the component
vi.mock('@/hooks/use-repo-list', () => ({
  useRepoList: vi.fn(),
}));
vi.mock('@/hooks/use-profile-cache', () => ({
  useProfileCache: () => ({
    getDisplayName: (pk: string) => `user-${pk.slice(0, 4)}`,
    requestProfiles: vi.fn(),
    version: 0,
  }),
}));
vi.mock('@/hooks/use-rig-config', () => ({
  useRigConfig: () => ({
    relayUrl: 'ws://localhost:7100',
    repoFilter: undefined,
    owner: undefined,
  }),
}));

import { RepoListPage } from '@/app/pages/repo-list-page';
import { useRepoList } from '@/hooks/use-repo-list';
import type { RepoMetadata } from '../../nip34-parsers.js';

const mockUseRepoList = vi.mocked(useRepoList);

function createRepoMetadata(overrides: Partial<RepoMetadata> = {}): RepoMetadata {
  return {
    repoId: 'test-repo',
    name: 'test-repo',
    description: 'A test repository',
    ownerPubkey: 'a'.repeat(64),
    defaultBranch: 'main',
    eventId: 'evt1',
    cloneUrls: [],
    webUrls: [],
    ...overrides,
  };
}

describe('[P1] RepoListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading skeletons while fetching', () => {
    mockUseRepoList.mockReturnValue({ repos: [], loading: true, error: null });
    render(
      <MemoryRouter>
        <RepoListPage />
      </MemoryRouter>,
    );
    // Skeletons are present
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders empty state when no repos found', () => {
    mockUseRepoList.mockReturnValue({ repos: [], loading: false, error: null });
    render(
      <MemoryRouter>
        <RepoListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('No repositories found.')).toBeInTheDocument();
    expect(screen.getByText(/ws:\/\/localhost:7100/)).toBeInTheDocument();
  });

  it('renders repo cards with name and description', () => {
    mockUseRepoList.mockReturnValue({
      repos: [
        createRepoMetadata({ repoId: 'repo-a', name: 'Alpha Repo', description: 'First repo' }),
        createRepoMetadata({ repoId: 'repo-b', name: 'Beta Repo', description: 'Second repo', ownerPubkey: 'b'.repeat(64) }),
      ],
      loading: false,
      error: null,
    });
    render(
      <MemoryRouter>
        <RepoListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Alpha Repo/)).toBeInTheDocument();
    expect(screen.getByText('First repo')).toBeInTheDocument();
    expect(screen.getByText(/Beta Repo/)).toBeInTheDocument();
  });

  it('renders error state', () => {
    mockUseRepoList.mockReturnValue({
      repos: [],
      loading: false,
      error: new Error('Connection refused'),
    });
    render(
      <MemoryRouter>
        <RepoListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
  });
});
