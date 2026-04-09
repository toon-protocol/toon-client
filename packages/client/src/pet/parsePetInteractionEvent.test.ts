import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parsePetInteractionEvent } from './parsePetInteractionEvent.js';

/** Helper to create a minimal Kind 14919 event */
function makeInteractionEvent(overrides?: {
  tags?: string[][];
  content?: string;
  addProof?: boolean;
}): {
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  id: string;
  sig: string;
  created_at: number;
} {
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
    priorStats: {
      hunger: 50,
      happiness: 50,
      health: 50,
      hygiene: 50,
      energy: 50,
    },
    decayedStats: {
      hunger: 45,
      happiness: 45,
      health: 45,
      hygiene: 45,
      energy: 45,
    },
    finalStats: {
      hunger: 80,
      happiness: 70,
      health: 90,
      hygiene: 60,
      energy: 50,
    },
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

  it('should return null content when stats objects have wrong types', () => {
    const event = makeInteractionEvent({
      content: JSON.stringify({
        priorStats: {
          hunger: 'not-a-number',
          happiness: 50,
          health: 50,
          hygiene: 50,
          energy: 50,
        },
        decayedStats: {
          hunger: 45,
          happiness: 45,
          health: 45,
          hygiene: 45,
          energy: 45,
        },
        finalStats: {
          hunger: 80,
          happiness: 70,
          health: 90,
          hygiene: 60,
          energy: 50,
        },
        cycle: 5,
        stage: 1,
        tokenCost: 100,
      }),
    });
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
  });

  it('should return null content when cycle/stage are missing from content', () => {
    const event = makeInteractionEvent({
      content: JSON.stringify({
        priorStats: {
          hunger: 50,
          happiness: 50,
          health: 50,
          hygiene: 50,
          energy: 50,
        },
        decayedStats: {
          hunger: 45,
          happiness: 45,
          health: 45,
          hygiene: 45,
          energy: 45,
        },
        finalStats: {
          hunger: 80,
          happiness: 70,
          health: 90,
          hygiene: 60,
          energy: 50,
        },
        tokenCost: 100,
      }),
    });
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
  });

  it('should return null when action tag is missing', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        // missing 'action'
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

  it('should return null when cost tag is missing', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        ['action', '0'],
        ['item', '1'],
        // missing 'cost'
        ['cycle', '5'],
        ['stage', '1'],
        ['brain_hash', 'b'.repeat(64)],
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).toBeNull();
  });

  it('should return null when cycle tag is missing', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        ['action', '0'],
        ['item', '1'],
        ['cost', '100'],
        // missing 'cycle'
        ['stage', '1'],
        ['brain_hash', 'b'.repeat(64)],
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).toBeNull();
  });

  it('should return null when stage tag is missing', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        ['action', '0'],
        ['item', '1'],
        ['cost', '100'],
        ['cycle', '5'],
        // missing 'stage'
        ['brain_hash', 'b'.repeat(64)],
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).toBeNull();
  });

  it('should return null when item tag is missing', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        ['action', '0'],
        // missing 'item'
        ['cost', '100'],
        ['cycle', '5'],
        ['stage', '1'],
        ['brain_hash', 'b'.repeat(64)],
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).toBeNull();
  });

  it('should return null content when tokenCost is missing from content', () => {
    const event = makeInteractionEvent({
      content: JSON.stringify({
        priorStats: {
          hunger: 50,
          happiness: 50,
          health: 50,
          hygiene: 50,
          energy: 50,
        },
        decayedStats: {
          hunger: 45,
          happiness: 45,
          health: 45,
          hygiene: 45,
          energy: 45,
        },
        finalStats: {
          hunger: 80,
          happiness: 70,
          health: 90,
          hygiene: 60,
          energy: 50,
        },
        cycle: 5,
        stage: 1,
        // missing tokenCost
      }),
    });
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
  });

  it('should return null content when tokenCost is not a number', () => {
    const event = makeInteractionEvent({
      content: JSON.stringify({
        priorStats: {
          hunger: 50,
          happiness: 50,
          health: 50,
          hygiene: 50,
          energy: 50,
        },
        decayedStats: {
          hunger: 45,
          happiness: 45,
          health: 45,
          hygiene: 45,
          energy: 45,
        },
        finalStats: {
          hunger: 80,
          happiness: 70,
          health: 90,
          hygiene: 60,
          energy: 50,
        },
        cycle: 5,
        stage: 1,
        tokenCost: 'free',
      }),
    });
    const result = parsePetInteractionEvent(event);

    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
  });

  it('should treat proof-only (no mina_tx) as optimistic', () => {
    const event = makeInteractionEvent({
      tags: [
        ['d', 'blobbi-xyz'],
        ['action', '0'],
        ['item', '1'],
        ['cost', '100'],
        ['cycle', '5'],
        ['stage', '1'],
        ['brain_hash', 'b'.repeat(64)],
        ['proof', 'base64proofdata=='],
        // no mina_tx
      ],
    });
    const result = parsePetInteractionEvent(event);
    expect(result).not.toBeNull();
    expect(result!.proofStatus).toBe('optimistic');
    expect(result!.proof).toBe('base64proofdata==');
    expect(result!.minaTx).toBeUndefined();
  });
});

describe('R-016 regression: pet module does not import forbidden packages', () => {
  it('should not import from pet-dvm, pet-circuit, or memvid-node', () => {
    const petDir = join(dirname(fileURLToPath(import.meta.url)));
    const sourceFiles = readdirSync(petDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    );

    const forbiddenImports = [
      '@toon-protocol/pet-dvm',
      '@toon-protocol/pet-circuit',
      '@toon-protocol/memvid-node',
      'o1js',
    ];

    // Match actual import/require statements, not comments
    const importPattern = (pkg: string) =>
      new RegExp(
        `(?:import|require)\\s*[({]?.*['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'm'
      );

    for (const file of sourceFiles) {
      const content = readFileSync(join(petDir, file), 'utf-8');
      for (const forbidden of forbiddenImports) {
        expect(
          importPattern(forbidden).test(content),
          `${file} must not import from ${forbidden}`
        ).toBe(false);
      }
    }
  });
});
