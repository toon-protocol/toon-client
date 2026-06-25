import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { interactiveAtoms } from './interactive.js';

afterEach(cleanup);

const Composer = interactiveAtoms.find((a) => a.id === 'composer')!.Component;
const PayConfirm = interactiveAtoms.find((a) => a.id === 'pay-confirm')!.Component;

const base = {
  events: [],
  props: {},
  children: null,
  renderEvent: () => null,
};

describe('Composer', () => {
  it('shows a live byte counter that reflects encoded bytes', () => {
    render(<Composer {...base} actions={{ post: vi.fn() }} />);
    expect(screen.getByText('0 bytes')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/what's happening/i), {
      target: { value: 'gm🚀' },
    });
    // "gm" = 2 bytes + rocket = 4 bytes → 6
    expect(screen.getByText('6 bytes')).toBeTruthy();
  });

  it('posts trimmed content via the post action and clears', () => {
    const post = vi.fn();
    render(<Composer {...base} actions={{ post }} />);
    const ta = screen.getByPlaceholderText(/what's happening/i) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByRole('button', { name: /post/i }));
    expect(post).toHaveBeenCalledWith({ content: 'hello' });
    expect(ta.value).toBe('');
  });

  it('disables the action when empty', () => {
    render(<Composer {...base} actions={{ post: vi.fn() }} />);
    expect(screen.getByRole('button', { name: /post/i })).toHaveProperty('disabled', true);
  });
});

describe('PayConfirm', () => {
  it('surfaces a byte counter in the compose phase', () => {
    render(<PayConfirm {...base} actions={{ confirm: vi.fn() }} />);
    fireEvent.change(screen.getByPlaceholderText(/what's happening/i), {
      target: { value: 'pay me' },
    });
    expect(screen.getByText('6 bytes')).toBeTruthy();
    expect(screen.getByRole('button', { name: /pay to post/i })).toBeTruthy();
  });

  it('advances to the confirm phase showing fee + settlement chain', async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValue({ feePerEvent: '1', asset: 'USDC', settlementChain: 'base' });
    render(<PayConfirm {...base} actions={{ confirm: vi.fn() }} readStatus={readStatus} />);
    fireEvent.change(screen.getByPlaceholderText(/what's happening/i), {
      target: { value: 'gm' },
    });
    fireEvent.click(screen.getByRole('button', { name: /pay to post/i }));
    expect(await screen.findByText(/confirm pay-to-write/i)).toBeTruthy();
    expect(await screen.findByText(/1 USDC/)).toBeTruthy();
    expect(screen.getByText('base')).toBeTruthy();
  });
});
