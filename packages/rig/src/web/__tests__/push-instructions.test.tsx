import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock hooks before importing the component
vi.mock('@/hooks/use-rig-config', () => ({
  useRigConfig: () => ({
    relayUrl: 'wss://relay.devnet.toonprotocol.dev',
    repoFilter: undefined,
    owner: undefined,
  }),
}));

import {
  PushInstructions,
  buildPushSnippet,
} from '@/components/push-instructions';
import type { RepoMetadata } from '../../nip34-parsers.js';

const OWNER = 'a'.repeat(64);

function createRepoMetadata(overrides: Partial<RepoMetadata> = {}): RepoMetadata {
  return {
    repoId: 'test-repo',
    name: 'test-repo',
    description: 'A test repository',
    ownerPubkey: OWNER,
    defaultBranch: 'main',
    eventId: 'evt1',
    cloneUrls: [],
    webUrls: [],
    ...overrides,
  };
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: /push/i }));
}

describe('[P1] PushInstructions', () => {
  const writeText = vi.fn<[string], Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    // No vitest `globals` in this suite, so testing-library's automatic
    // cleanup never registers — unmount explicitly or portaled popover
    // content leaks across tests.
    cleanup();
    // @ts-expect-error test-only cleanup of the clipboard stub
    delete navigator.clipboard;
  });

  it('buildPushSnippet produces the paste-and-run CLI setup', () => {
    expect(buildPushSnippet('my-repo', OWNER, 'ws://localhost:7100')).toBe(
      [
        'npm i -g @toon-protocol/git',
        'git config toon.repoid my-repo',
        `git config toon.owner ${OWNER}`,
        'git config toon.relay ws://localhost:7100',
        'rig push',
      ].join('\n'),
    );
  });

  it('renders the snippet with the repo id, owner pubkey, and active relay', () => {
    render(<PushInstructions metadata={createRepoMetadata({ repoId: 'rig-demo' })} />);
    openPopover();

    const snippet = document.querySelector('pre');
    expect(snippet).not.toBeNull();
    expect(snippet!.textContent).toContain('npm i -g @toon-protocol/git');
    expect(snippet!.textContent).toContain('git config toon.repoid rig-demo');
    expect(snippet!.textContent).toContain(`git config toon.owner ${OWNER}`);
    expect(snippet!.textContent).toContain(
      'git config toon.relay wss://relay.devnet.toonprotocol.dev',
    );
    expect(snippet!.textContent).toContain('rig push');
  });

  it('notes that writes are paid and links the rig CLI docs', () => {
    render(<PushInstructions metadata={createRepoMetadata()} />);
    openPopover();

    expect(screen.getByText(/writes are paid/i)).toBeInTheDocument();
    expect(screen.getByText(/funded TOON identity/i)).toBeInTheDocument();
    const docsLink = screen.getByRole('link', { name: /rig cli docs/i });
    expect(docsLink).toHaveAttribute(
      'href',
      'https://github.com/toon-protocol/toon-client/tree/main/packages/git#readme',
    );
  });

  it('copies the full snippet to the clipboard and flips to copied state', async () => {
    const metadata = createRepoMetadata({ repoId: 'rig-demo' });
    render(<PushInstructions metadata={metadata} />);
    openPopover();

    fireEvent.click(screen.getByRole('button', { name: 'Copy setup commands' }));

    expect(writeText).toHaveBeenCalledWith(
      buildPushSnippet('rig-demo', OWNER, 'wss://relay.devnet.toonprotocol.dev'),
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /copy setup commands — copied/i }),
      ).toBeInTheDocument();
    });
  });

  it('falls back to execCommand when the async Clipboard API is blocked', async () => {
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<PushInstructions metadata={createRepoMetadata()} />);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Copy setup commands' }));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(
        screen.getByRole('button', { name: /copy setup commands — copied/i }),
      ).toBeInTheDocument();
    });

    // @ts-expect-error test-only cleanup of the execCommand stub
    delete document.execCommand;
  });
});
