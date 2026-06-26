import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { loadingAtoms } from './loading.js';
import { type AtomRenderProps } from './types.js';

afterEach(cleanup);

const byId = (id: string) => loadingAtoms.find((a) => a.id === id)!.Component;
const base: Omit<AtomRenderProps, 'props'> = {
  events: [],
  actions: {},
  children: null,
  renderEvent: () => null,
};

describe('loading atoms', () => {
  it('skeleton (lines) renders the requested number of bars, marked busy', () => {
    const Skeleton = byId('skeleton');
    const { container } = render(<Skeleton {...base} props={{ variant: 'lines', lines: 4 }} />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
  });

  it('skeleton (avatar) renders a circle + two text bars', () => {
    const Skeleton = byId('skeleton');
    const { container } = render(<Skeleton {...base} props={{ variant: 'avatar' }} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  it('skeleton clamps an absurd line count', () => {
    const Skeleton = byId('skeleton');
    const { container } = render(<Skeleton {...base} props={{ variant: 'lines', lines: 9999 }} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(12);
  });

  it('loading shows the agent-set message and is a polite live region', () => {
    const Loading = byId('loading');
    render(<Loading {...base} props={{ message: 'Resolving balances…' }} />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('Resolving balances…')).toBeTruthy();
  });

  it('loading falls back to a default message', () => {
    const Loading = byId('loading');
    render(<Loading {...base} props={{}} />);
    expect(screen.getByText('Working…')).toBeTruthy();
  });

  it('progress-steps marks the active step current and renders all labels', () => {
    const Progress = byId('progress-steps');
    render(
      <Progress {...base} props={{ steps: ['Close channel', 'Wait for timeout', 'Settle'], active: 1 }} />
    );
    expect(screen.getByText('Close channel')).toBeTruthy();
    expect(screen.getByText('Settle')).toBeTruthy();
    const current = screen.getByText('Wait for timeout').closest('li');
    expect(current?.getAttribute('aria-current')).toBe('step');
  });

  it('progress-steps marks an error step', () => {
    const Progress = byId('progress-steps');
    const { container } = render(
      <Progress {...base} props={{ steps: ['A', 'B'], active: 1, error: 1 }} />
    );
    // The error marker uses the destructive token.
    expect(container.querySelector('.bg-destructive')).toBeTruthy();
  });

  it('progress-steps renders nothing for empty steps', () => {
    const Progress = byId('progress-steps');
    const { container } = render(<Progress {...base} props={{ steps: [] }} />);
    expect(container.firstChild).toBeNull();
  });

  it('loading atoms carry no event kinds', () => {
    for (const atom of loadingAtoms) {
      expect(atom.kinds).toBeUndefined();
    }
  });
});
