import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ProofStatusBadge } from './proof-status-badge.js';

afterEach(() => {
  cleanup();
});

describe('[P1] ProofStatusBadge', () => {
  it('renders Optimistic text for optimistic status', () => {
    render(<ProofStatusBadge proofStatus="optimistic" />);
    expect(screen.getByText('Optimistic')).toBeInTheDocument();
  });

  it('renders ZK Proven text for proven status', () => {
    render(<ProofStatusBadge proofStatus="proven" />);
    expect(screen.getByText('ZK Proven')).toBeInTheDocument();
  });

  it('applies custom className to optimistic badge', () => {
    const { container } = render(
      <ProofStatusBadge proofStatus="optimistic" className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('applies custom className to proven badge', () => {
    const { container } = render(
      <ProofStatusBadge proofStatus="proven" className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('passes aria-label to optimistic badge', () => {
    render(<ProofStatusBadge proofStatus="optimistic" aria-label="proof status: optimistic" />);
    expect(screen.getByRole('generic', { name: 'proof status: optimistic' })).toBeInTheDocument();
  });

  it('passes aria-label to proven badge', () => {
    render(<ProofStatusBadge proofStatus="proven" aria-label="proof status: proven" />);
    expect(screen.getByRole('generic', { name: 'proof status: proven' })).toBeInTheDocument();
  });

  it('optimistic badge has amber border styling', () => {
    const { container } = render(<ProofStatusBadge proofStatus="optimistic" />);
    expect(container.firstChild).toHaveClass('border-amber-400');
  });

  it('proven badge has green background styling', () => {
    const { container } = render(<ProofStatusBadge proofStatus="proven" />);
    expect(container.firstChild).toHaveClass('bg-green-600');
  });
});
