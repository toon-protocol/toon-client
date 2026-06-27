import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { CopyButton } from './copy-button.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Reset any clipboard stub between tests.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('CopyButton', () => {
  it('copies via the async Clipboard API when available', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyButton value="g.proxy.relay" label="Copy address" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(writeText).toHaveBeenCalledWith('g.proxy.relay');
    // Flips to the copied state.
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy());
  });

  it('falls back to execCommand when the Clipboard API is blocked (host iframe)', async () => {
    // The async API exists but rejects, as in a sandboxed iframe without
    // clipboard-write permission policy.
    const writeText = vi.fn(() => Promise.reject(new Error('NotAllowedError')));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const exec = vi.fn(() => true);
    // jsdom doesn't implement execCommand — define it for the fallback path.
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });

    render(<CopyButton value="0xabc" label="Copy EVM address" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy EVM address' }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy());
  });

  it('uses execCommand directly when there is no Clipboard API at all', async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    render(<CopyButton value="abc" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'));
  });
});
