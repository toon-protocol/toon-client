import { describe, it, expect } from 'vitest';
import { buildPetListingEvent } from './buildPetListingEvent.js';
import type { PetListingParams } from './types.js';

const LIFECYCLE_HASH = 'a'.repeat(64);
const SELLER_PUBKEY = 'b'.repeat(64);
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 86400;

const validParams: PetListingParams = {
  blobbiId: 'pet-abc123',
  askPriceUsdc: 10.0,
  lifecycleHash: LIFECYCLE_HASH,
  totalSpent: '42000',
  stage: 2,
  stats: { hunger: 80, happiness: 90, health: 85, hygiene: 75, energy: 70 },
  sellerPubkey: SELLER_PUBKEY,
  relayUrl: 'wss://relay.example.com',
  expiresAt: EXPIRES_AT,
};

describe('buildPetListingEvent', () => {
  it('returns a kind:30402 event', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.kind).toBe(30402);
  });

  it('d tag equals blobbiId', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['d', 'pet-abc123']);
  });

  it('price tag contains askPriceUsdc, USDC, empty string', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['price', '10', 'USDC', '']);
  });

  it('lifecycle_hash tag equals provided lifecycleHash', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['lifecycle_hash', LIFECYCLE_HASH]);
  });

  it('total_spent tag equals provided totalSpent', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['total_spent', '42000']);
  });

  it('stage tag equals stage.toString()', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['stage', '2']);
  });

  it('expiration tag equals expiresAt.toString()', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['expiration', String(EXPIRES_AT)]);
  });

  it('content is valid JSON parseable as StatValues', () => {
    const event = buildPetListingEvent(validParams);
    const parsed = JSON.parse(event.content) as unknown;
    expect(parsed).toMatchObject({
      hunger: 80,
      happiness: 90,
      health: 85,
      hygiene: 75,
      energy: 70,
    });
  });

  it('relay tag equals relayUrl', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['relay', 'wss://relay.example.com']);
  });

  it('p tag equals sellerPubkey', () => {
    const event = buildPetListingEvent(validParams);
    expect(event.tags).toContainEqual(['p', SELLER_PUBKEY]);
  });

  it('title tag contains blobbiId', () => {
    const event = buildPetListingEvent(validParams);
    const titleTag = event.tags.find((t) => t[0] === 'title');
    expect(titleTag?.[1]).toContain('pet-abc123');
  });

  it('t tags include pet and toon-pet', () => {
    const event = buildPetListingEvent(validParams);
    const tTags = event.tags.filter((t) => t[0] === 't').map((t) => t[1]);
    expect(tTags).toContain('pet');
    expect(tTags).toContain('toon-pet');
  });

  it('created_at is a recent unix timestamp', () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const event = buildPetListingEvent(validParams);
    const after = Math.floor(Date.now() / 1000) + 1;
    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThanOrEqual(after);
  });

  it('stage 0 produces Egg in summary', () => {
    const event = buildPetListingEvent({ ...validParams, stage: 0 });
    const summaryTag = event.tags.find((t) => t[0] === 'summary');
    expect(summaryTag?.[1]).toContain('Egg');
  });

  it('stage 1 produces Baby in summary', () => {
    const event = buildPetListingEvent({ ...validParams, stage: 1 });
    const summaryTag = event.tags.find((t) => t[0] === 'summary');
    expect(summaryTag?.[1]).toContain('Baby');
  });

  it('verified biography — both lifecycle_hash and total_spent present together', () => {
    // AC-1 verified biography: every listing must carry both hash fields
    // so buyers can cross-reference against on-chain PetZkApp state
    const event = buildPetListingEvent(validParams);
    const tagNames = event.tags.map((t) => t[0]);
    expect(tagNames).toContain('lifecycle_hash');
    expect(tagNames).toContain('total_spent');
    // Both values non-empty
    const lhTag = event.tags.find((t) => t[0] === 'lifecycle_hash');
    const tsTag = event.tags.find((t) => t[0] === 'total_spent');
    expect(lhTag?.[1]).toBeTruthy();
    expect(tsTag?.[1]).toBeTruthy();
  });
});
