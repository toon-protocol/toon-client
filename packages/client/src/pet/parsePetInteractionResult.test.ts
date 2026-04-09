import { describe, it, expect } from 'vitest';
import { parsePetInteractionResult } from './parsePetInteractionResult.js';

/** Helper to base64-encode a JSON object (browser-compatible btoa simulation) */
function toBase64(obj: unknown): string {
  // In Node test environment, use Buffer; the implementation uses atob()
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

const validResultData = {
  stats: { hunger: 80, happiness: 70, health: 90, hygiene: 60, energy: 50 },
  stage: 1,
  cycle: 5,
  lastInteraction: 1700000000,
  brainHash: 'a'.repeat(64),
  cooldownTimestamps: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

describe('parsePetInteractionResult', () => {
  it('should parse valid base64-encoded result data', () => {
    const data = toBase64(validResultData);
    const result = parsePetInteractionResult(data);

    expect(result).not.toBeNull();
    expect(result!.stats).toEqual(validResultData.stats);
    expect(result!.stage).toBe(1);
    expect(result!.cycle).toBe(5);
    expect(result!.lastInteraction).toBe(1700000000);
    expect(result!.brainHash).toBe('a'.repeat(64));
    expect(result!.cooldownTimestamps).toHaveLength(11);
  });

  it('should return null for non-base64 data', () => {
    const result = parsePetInteractionResult('not-base64!!!');
    expect(result).toBeNull();
  });

  it('should return null for base64 that is not valid JSON', () => {
    const data = Buffer.from('not json').toString('base64');
    const result = parsePetInteractionResult(data);
    expect(result).toBeNull();
  });

  it('should return null when brainHash is not 64-char hex', () => {
    const data = toBase64({ ...validResultData, brainHash: 'short' });
    const result = parsePetInteractionResult(data);
    expect(result).toBeNull();
  });

  it('should return null when stats is missing a field', () => {
    const data = toBase64({
      ...validResultData,
      stats: { hunger: 80, happiness: 70, health: 90, hygiene: 60 }, // missing energy
    });
    const result = parsePetInteractionResult(data);
    expect(result).toBeNull();
  });

  it('should return null when stage is out of range', () => {
    const data = toBase64({ ...validResultData, stage: 3 });
    const result = parsePetInteractionResult(data);
    expect(result).toBeNull();
  });

  it('should return null when cycle is negative', () => {
    const data = toBase64({ ...validResultData, cycle: -1 });
    const result = parsePetInteractionResult(data);
    expect(result).toBeNull();
  });

  it('should return null for empty string input', () => {
    const result = parsePetInteractionResult('');
    expect(result).toBeNull();
  });
});
