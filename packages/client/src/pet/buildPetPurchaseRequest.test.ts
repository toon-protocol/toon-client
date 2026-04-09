import { describe, it, expect } from 'vitest';
import { PET_INTERACTION_REQUEST_KIND } from '@toon-protocol/core';
import { buildPetPurchaseRequest } from './buildPetPurchaseRequest.js';
import type { PetPurchaseRequestParams } from './types.js';

const BUYER_PUBKEY = 'c'.repeat(64);
const SELLER_PUBKEY = 'b'.repeat(64);

const validParams: PetPurchaseRequestParams = {
  blobbiId: 'pet-abc123',
  listingEventId: 'listing-event-id-001',
  buyerPubkey: BUYER_PUBKEY,
  tokenCost: 500,
  sellerPubkey: SELLER_PUBKEY,
};

describe('buildPetPurchaseRequest', () => {
  it('returns a kind:5900 event', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.kind).toBe(PET_INTERACTION_REQUEST_KIND);
    expect(event.kind).toBe(5900);
  });

  it('action tag is "9" (transfer-ownership)', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.tags).toContainEqual(['action', '9']);
  });

  it('i tag equals blobbiId', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.tags).toContainEqual(['i', 'pet-abc123']);
  });

  it('listing tag equals listingEventId', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.tags).toContainEqual(['listing', 'listing-event-id-001']);
  });

  it('buyer tag equals buyerPubkey', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.tags).toContainEqual(['buyer', BUYER_PUBKEY]);
  });

  it('p tag equals sellerPubkey', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.tags).toContainEqual(['p', SELLER_PUBKEY]);
  });

  it('cost tag equals tokenCost as string', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.tags).toContainEqual(['cost', '500']);
  });

  it('content is empty string', () => {
    const event = buildPetPurchaseRequest(validParams);
    expect(event.content).toBe('');
  });

  it('created_at is a recent unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const event = buildPetPurchaseRequest(validParams);
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });

  it('tokenCost of 0 is valid and produces cost tag "0"', () => {
    const event = buildPetPurchaseRequest({ ...validParams, tokenCost: 0 });
    expect(event.tags).toContainEqual(['cost', '0']);
  });
});
