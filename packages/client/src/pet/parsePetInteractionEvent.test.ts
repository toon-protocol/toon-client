import { describe, it, expect } from 'vitest';
import { parsePetInteractionEvent } from './parsePetInteractionEvent.js';
import type { PetInteractionEventData } from './types.js';

/** Helper to create a minimal Kind 14919 event */
function makeInteractionEvent(overrides?: {
  tags?: string[][];
  content?: string;
  addProof?: boolean;
}): { kind: number; pubkey: string; content: string; tags: string[][]; id: string; sig: string; created_at: number } {
  const baseTags: string[][] = [
    ['d', 'blobbi-xyz'],
    ['action', '0'],
    ['item', '1'],
    ['cost', '100'],
    ['cycle', '5'],
    ['stage', '1'],
    ['brain_hash', 'b'.repeat(64)],
  ];

  const contentObj = {
    priorStats: { hunger: 50, happiness: 50, health: 50, hygiene: 50, energy: 50 },
    decayedStats: { hunger: 45, happiness: 45, health: 45, hygiene: 45, energy: 45 },
    finalStats: { hunger: 80, happiness: 70, health: 90, hygiene: 60, energy: 50 },
    cycle: 5,
    stage: 1,
    tokenCost: 100,
  };

  let tags = overrides?.tags ?? baseTags;
  if (overrides?.addProof) {
    tags = [
      ...tags,
      ['proof', 'base64proofdata=='],
      ['mina_tx', '5JuVMR8abc123txhash'],
    ];
  }

  return {
    kind: 14919,
    pubkey: 'event-pubkey',
    content: overrides?.content ?? JSON.stringify(contentObj),
    tags,
    id: 'event-id',
    sig: 'event-sig',
    created_at: Math.floor(Date.now() / 1000),
  };
}

describe('parsePetInteractionEvent', () => {
  it('should parse an optimistic event (no proof tag)', () => {
    const event = makeInteractionEvent();
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.blobbiId).toBe('blobbi-xyz');
    expect(result!.actionType).toBe(0);
    expect(result!.itemId).toBe(1);
    expect(result!.tokenCost).toBe(100);
    expect(result!.cycle).toBe(5);
    expect(result!.stage).toBe(1);
    expect(result!.brainHash).toBe('b'.repeat(64));
    expect(result!.proofStatus).toBe('optimistic');
    expect(result!.proof).toBeUndefined();
    expect(result!.minaTx).toBeUndefined();
  });

  it('should parse a proven event (has proof + mina_tx tags)', () => {
    const event = makeInteractionEvent({ addProof: true });
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.proofStatus).toBe('proven');
    expect(result!.proof).toBe('base64proofdata==');
    expect(result!.minaTx).toBe('5JuVMR8abc123txhash');
  });

  it('should parse content JSON into InteractionResultContent', () => {
    const event = makeInteractionEvent();
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.content).not.toBeNull();
    expect(result!.content!.priorStats.hunger).toBe(50);
    expect(result!.content!.finalStats.hunger).toBe(80);
    expect(result!.content!.cycle).toBe(5);
    expect(result!.content!.stage).toBe(1);
    expect(result!.content!.tokenCost).toBe(100);
  });

  it('should return null when required tag is missing (d tag)', () => {
    const event = makeInteractionEvent({
      tags: [
        // missing 'd' tag
        ['action', '0'],
        ['item', '1'],
        ['cost', '100'],
        ['cycle', '5'],
        ['stage', '1'],
        ['brain_hash', 'b'.repeat(64)],
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).toBeNull();
  });

  it('should return null when required tag is missing (brain_hash)', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        ['action', '0'],
        ['item', '1'],
        ['cost', '100'],
        ['cycle', '5'],
        ['stage', '1'],
        // missing brain_hash
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).toBeNull();
  });

  it('should handle malformed content gracefully (content null)', () => {
    const event = makeInteractionEvent({ content: 'not-valid-json' });
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
  });
});
