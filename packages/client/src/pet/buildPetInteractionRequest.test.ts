import { describe, it, expect } from 'vitest';
import { buildPetInteractionRequest } from './buildPetInteractionRequest.js';
import { ValidationError } from '../errors.js';
import { PET_INTERACTION_REQUEST_KIND } from '@toon-protocol/core';

describe('buildPetInteractionRequest', () => {
  const validParams = {
    blobbiId: 'blobbi-abc-123',
    actionType: 0, // Feed
    itemId: 1,
    tokenCost: 100,
    isSleeping: false,
  };

  it('should build a valid Kind 5900 unsigned event', () => {
    const event = buildPetInteractionRequest(validParams);

    expect(event.kind).toBe(PET_INTERACTION_REQUEST_KIND);
    expect(event.kind).toBe(5900);
    expect(event.content).toBe('');
    expect(typeof event.created_at).toBe('number');
    expect(event.created_at).toBeGreaterThan(0);

    // Verify all required tags
    expect(event.tags).toContainEqual(['d', 'blobbi-abc-123']);
    expect(event.tags).toContainEqual(['action', '0']);
    expect(event.tags).toContainEqual(['item', '1']);
    expect(event.tags).toContainEqual(['cost', '100']);
    expect(event.tags).toContainEqual(['sleeping', 'false']);
  });

  it('should stringify all tag values per Nostr protocol', () => {
    const event = buildPetInteractionRequest({
      ...validParams,
      actionType: 10,
      itemId: 42,
      tokenCost: 999,
      isSleeping: true,
    });

    expect(event.tags).toContainEqual(['action', '10']);
    expect(event.tags).toContainEqual(['item', '42']);
    expect(event.tags).toContainEqual(['cost', '999']);
    expect(event.tags).toContainEqual(['sleeping', 'true']);
  });

  it('should throw ValidationError for empty blobbiId', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, blobbiId: '' })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for actionType out of range (> 10)', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, actionType: 11 })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for negative actionType', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, actionType: -1 })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for negative itemId', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, itemId: -1 })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for negative tokenCost', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, tokenCost: -1 })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for non-integer actionType', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, actionType: 1.5 })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for NaN tokenCost', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, tokenCost: NaN })
    ).toThrow(ValidationError);
  });

  it('should throw ValidationError for non-integer itemId', () => {
    expect(() =>
      buildPetInteractionRequest({ ...validParams, itemId: 2.7 })
    ).toThrow(ValidationError);
  });

  it('should accept all valid action types (0-10)', () => {
    for (let actionType = 0; actionType <= 10; actionType++) {
      const event = buildPetInteractionRequest({ ...validParams, actionType });
      expect(event.kind).toBe(PET_INTERACTION_REQUEST_KIND);
      expect(event.tags).toContainEqual(['action', String(actionType)]);
    }
  });
});
