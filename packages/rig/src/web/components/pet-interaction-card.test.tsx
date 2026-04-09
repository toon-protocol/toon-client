import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { PetInteractionCard } from './pet-interaction-card.js';
import type { PetInteractionEventData, InteractionResultContent, StatValues } from '@toon-protocol/client';

afterEach(() => {
  cleanup();
});

const BRAIN_HASH = 'abcdef1234567890'.repeat(4); // 64 chars

function makeStats(base = 80): StatValues {
  return { hunger: base, happiness: base, health: base, hygiene: base, energy: base };
}

function makeContent(overrides: Partial<InteractionResultContent> = {}): InteractionResultContent {
  return {
    priorStats: makeStats(60),
    decayedStats: makeStats(55),
    finalStats: makeStats(75),
    cycle: 1,
    stage: 1,
    tokenCost: 10,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<PetInteractionEventData> = {}): PetInteractionEventData {
  return {
    blobbiId: 'blobbi-001',
    actionType: 0, // Feed
    itemId: 1,
    tokenCost: 10,
    cycle: 3,
    stage: 1, // Baby
    brainHash: BRAIN_HASH,
    proofStatus: 'optimistic',
    content: makeContent(),
    ...overrides,
  };
}

describe('[P1] PetInteractionCard', () => {
  it('renders the action name for actionType 0 (Feed)', () => {
    const { getByText } = render(<PetInteractionCard event={makeEvent({ actionType: 0 })} />);
    expect(getByText('Feed')).toBeInTheDocument();
  });

  it('renders the action name for actionType 10 (PlayMusic)', () => {
    const { getByText } = render(<PetInteractionCard event={makeEvent({ actionType: 10 })} />);
    expect(getByText('PlayMusic')).toBeInTheDocument();
  });

  it('renders stage name Baby for stage 1 in cycle/stage label', () => {
    const { getAllByText } = render(<PetInteractionCard event={makeEvent({ stage: 1 })} />);
    // Stage name appears in the cycle·stage span
    const matches = getAllByText(/Baby/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders stage name Adult for stage 2', () => {
    const { getAllByText } = render(<PetInteractionCard event={makeEvent({ stage: 2 })} />);
    const matches = getAllByText(/Adult/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders cycle number', () => {
    const { getAllByText } = render(<PetInteractionCard event={makeEvent({ cycle: 7 })} />);
    const matches = getAllByText(/Cycle 7/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders optimistic proof status badge', () => {
    const { getAllByText } = render(<PetInteractionCard event={makeEvent({ proofStatus: 'optimistic' })} />);
    const matches = getAllByText('Optimistic');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders proven proof status badge', () => {
    const { getByText } = render(<PetInteractionCard event={makeEvent({ proofStatus: 'proven' })} />);
    expect(getByText('ZK Proven')).toBeInTheDocument();
  });

  it('renders truncated brain hash', () => {
    const { getAllByText } = render(<PetInteractionCard event={makeEvent()} />);
    // BRAIN_HASH = 'abcdef1234567890' * 4 → first 8 = 'abcdef12', last 4 = '7890'
    const matches = getAllByText(/abcdef12\.\.\.7890/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders final stat values when content is present', () => {
    const content = makeContent({ finalStats: makeStats(72) });
    const { getAllByText } = render(<PetInteractionCard event={makeEvent({ content })} />);
    // All 5 stat values should be 72
    const statValues = getAllByText('72');
    expect(statValues.length).toBe(5); // hunger, happiness, health, hygiene, energy
  });

  it('does not crash when content is null', () => {
    expect(() => {
      render(<PetInteractionCard event={makeEvent({ content: null })} />);
    }).not.toThrow();
  });

  it('does not render stat labels when content is null', () => {
    const { queryByText } = render(<PetInteractionCard event={makeEvent({ content: null })} />);
    expect(queryByText('Hunger')).not.toBeInTheDocument();
  });

  it('renders Mina TX when minaTx is present', () => {
    const { getAllByText } = render(
      <PetInteractionCard event={makeEvent({ proofStatus: 'proven', minaTx: 'Cx5abc123' })} />,
    );
    const matches = getAllByText(/Mina: Cx5abc123/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('does not render Mina section when minaTx is absent', () => {
    const { queryByText } = render(<PetInteractionCard event={makeEvent({ proofStatus: 'optimistic' })} />);
    expect(queryByText(/Mina:/)).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <PetInteractionCard event={makeEvent()} className="my-custom-class" />,
    );
    expect(container.firstChild).toHaveClass('my-custom-class');
  });
});
