import { describe, it, expect } from 'vitest';
import { filterPetListings } from './filterPetListings.js';

const LIFECYCLE_HASH = 'a'.repeat(64);
const SELLER_A = 'a'.repeat(64);
const SELLER_B = 'b'.repeat(64);
const FUTURE = Math.floor(Date.now() / 1000) + 86400;
const PAST = Math.floor(Date.now() / 1000) - 86400;

function makeListingEvent(
  overrides: {
    id?: string;
    blobbiId?: string;
    price?: string;
    stage?: string;
    totalSpent?: string;
    sellerPubkey?: string;
    expiration?: number | null;
    kind?: number;
  } = {}
) {
  const {
    id = 'evt-001',
    blobbiId = 'pet-001',
    price = '10',
    stage = '2',
    totalSpent = '1000',
    sellerPubkey = SELLER_A,
    expiration = FUTURE,
    kind = 30402,
  } = overrides;

  const tags: string[][] = [
    ['d', blobbiId],
    ['price', price, 'USDC', ''],
    ['lifecycle_hash', LIFECYCLE_HASH],
    ['total_spent', totalSpent],
    ['stage', stage],
    ['p', sellerPubkey],
  ];

  if (expiration !== null) {
    tags.push(['expiration', String(expiration)]);
  }

  return {
    id,
    kind,
    pubkey: sellerPubkey,
    created_at: 1712000000,
    tags,
    content: JSON.stringify({
      hunger: 80,
      happiness: 90,
      health: 85,
      hygiene: 75,
      energy: 70,
    }),
  };
}

describe('filterPetListings', () => {
  it('returns only valid parsed listings — invalid events filtered out', () => {
    const events = [
      makeListingEvent({ id: 'valid-1' }),
      makeListingEvent({ kind: 1, id: 'invalid-kind' }),
      makeListingEvent({ price: 'not-a-number', id: 'invalid-price' }),
    ];
    const result = filterPetListings(events);
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('valid-1');
  });

  it('expired listings excluded', () => {
    const events = [
      makeListingEvent({ id: 'active', expiration: FUTURE }),
      makeListingEvent({ id: 'expired', expiration: PAST }),
    ];
    const result = filterPetListings(events);
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('active');
  });

  it('listings without expiration tag are not excluded', () => {
    const events = [makeListingEvent({ id: 'no-expiry', expiration: null })];
    const result = filterPetListings(events);
    expect(result).toHaveLength(1);
  });

  it('minStage filter excludes listings below threshold', () => {
    const events = [
      makeListingEvent({ id: 'egg', stage: '0' }),
      makeListingEvent({ id: 'baby', stage: '1' }),
      makeListingEvent({ id: 'adult', stage: '2' }),
    ];
    const result = filterPetListings(events, { minStage: 2 });
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('adult');
  });

  it('maxAskPriceUsdc filter excludes expensive listings', () => {
    const events = [
      makeListingEvent({ id: 'cheap', price: '5' }),
      makeListingEvent({ id: 'exactly-max', price: '10' }),
      makeListingEvent({ id: 'expensive', price: '50' }),
    ];
    const result = filterPetListings(events, { maxAskPriceUsdc: 10 });
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.eventId);
    expect(ids).toContain('cheap');
    expect(ids).toContain('exactly-max');
    expect(ids).not.toContain('expensive');
  });

  it('sellerPubkey filter returns only matching seller', () => {
    const events = [
      makeListingEvent({ id: 'seller-a-1', sellerPubkey: SELLER_A }),
      makeListingEvent({ id: 'seller-a-2', sellerPubkey: SELLER_A }),
      makeListingEvent({ id: 'seller-b-1', sellerPubkey: SELLER_B }),
    ];
    const result = filterPetListings(events, { sellerPubkey: SELLER_B });
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('seller-b-1');
  });

  it('result sorted by totalSpent descending', () => {
    const events = [
      makeListingEvent({ id: 'low', totalSpent: '100' }),
      makeListingEvent({ id: 'high', totalSpent: '9000' }),
      makeListingEvent({ id: 'mid', totalSpent: '500' }),
    ];
    const result = filterPetListings(events);
    expect(result[0]?.eventId).toBe('high');
    expect(result[1]?.eventId).toBe('mid');
    expect(result[2]?.eventId).toBe('low');
  });

  it('minTotalSpent filter excludes listings below threshold', () => {
    const events = [
      makeListingEvent({ id: 'low', totalSpent: '100' }),
      makeListingEvent({ id: 'mid', totalSpent: '500' }),
      makeListingEvent({ id: 'high', totalSpent: '9000' }),
    ];
    const result = filterPetListings(events, { minTotalSpent: '500' });
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.eventId);
    expect(ids).toContain('mid');
    expect(ids).toContain('high');
    expect(ids).not.toContain('low');
  });

  it('empty events array returns empty result', () => {
    expect(filterPetListings([])).toEqual([]);
  });

  it('minTotalSpent boundary — equal value is included', () => {
    const events = [
      makeListingEvent({ id: 'exactly', totalSpent: '500' }),
      makeListingEvent({ id: 'below', totalSpent: '499' }),
    ];
    const result = filterPetListings(events, { minTotalSpent: '500' });
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('exactly');
  });

  it('combined filters — stage AND maxPrice', () => {
    const events = [
      makeListingEvent({ id: 'adult-cheap', stage: '2', price: '5' }),
      makeListingEvent({ id: 'adult-expensive', stage: '2', price: '50' }),
      makeListingEvent({ id: 'baby-cheap', stage: '1', price: '5' }),
    ];
    const result = filterPetListings(events, {
      minStage: 2,
      maxAskPriceUsdc: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.eventId).toBe('adult-cheap');
  });
});
