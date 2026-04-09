import { describe, it, expect } from 'vitest';
import { parsePetListing } from './parsePetListing.js';

const LIFECYCLE_HASH = 'a'.repeat(64);
const SELLER_PUBKEY = 'b'.repeat(64);
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 86400;

function makeListingEvent(
  overrides: Partial<{
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  }> = {}
) {
  return {
    id: 'event-id-001',
    kind: 30402,
    pubkey: SELLER_PUBKEY,
    created_at: 1712000000,
    tags: [
      ['d', 'pet-abc123'],
      ['price', '10', 'USDC', ''],
      ['lifecycle_hash', LIFECYCLE_HASH],
      ['total_spent', '42000'],
      ['stage', '2'],
      ['expiration', String(EXPIRES_AT)],
      ['relay', 'wss://relay.example.com'],
      ['p', SELLER_PUBKEY],
    ],
    content: JSON.stringify({
      hunger: 80,
      happiness: 90,
      health: 85,
      hygiene: 75,
      energy: 70,
    }),
    ...overrides,
  };
}

describe('parsePetListing', () => {
  it('happy path — valid kind:30402 event returns populated PetListing', () => {
    const result = parsePetListing(makeListingEvent());
    expect(result).not.toBeNull();
    expect(result?.blobbiId).toBe('pet-abc123');
    expect(result?.askPriceUsdc).toBe(10);
    expect(result?.lifecycleHash).toBe(LIFECYCLE_HASH);
    expect(result?.totalSpent).toBe('42000');
    expect(result?.stage).toBe(2);
    expect(result?.stats.hunger).toBe(80);
  });

  it('eventId populated from event id', () => {
    const result = parsePetListing(makeListingEvent({ id: 'custom-event-id' }));
    expect(result?.eventId).toBe('custom-event-id');
  });

  it('createdAt populated from event created_at', () => {
    const result = parsePetListing(
      makeListingEvent({ created_at: 1700000000 })
    );
    expect(result?.createdAt).toBe(1700000000);
  });

  it('wrong kind (1) returns null', () => {
    const result = parsePetListing(makeListingEvent({ kind: 1 }));
    expect(result).toBeNull();
  });

  it('wrong kind (5900) returns null', () => {
    const result = parsePetListing(makeListingEvent({ kind: 5900 }));
    expect(result).toBeNull();
  });

  it('missing d tag returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.filter((t) => t[0] !== 'd');
    expect(parsePetListing(event)).toBeNull();
  });

  it('empty d tag value returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) => (t[0] === 'd' ? ['d', ''] : t));
    expect(parsePetListing(event)).toBeNull();
  });

  it('missing price tag returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.filter((t) => t[0] !== 'price');
    expect(parsePetListing(event)).toBeNull();
  });

  it('invalid price (non-numeric) returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) =>
      t[0] === 'price' ? ['price', 'not-a-number', 'USDC', ''] : t
    );
    expect(parsePetListing(event)).toBeNull();
  });

  it('zero price returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) =>
      t[0] === 'price' ? ['price', '0', 'USDC', ''] : t
    );
    expect(parsePetListing(event)).toBeNull();
  });

  it('negative price returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) =>
      t[0] === 'price' ? ['price', '-5', 'USDC', ''] : t
    );
    expect(parsePetListing(event)).toBeNull();
  });

  it('missing lifecycle_hash tag returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.filter((t) => t[0] !== 'lifecycle_hash');
    expect(parsePetListing(event)).toBeNull();
  });

  it('invalid lifecycle_hash (not 64-char hex) returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) =>
      t[0] === 'lifecycle_hash' ? ['lifecycle_hash', 'tooshort'] : t
    );
    expect(parsePetListing(event)).toBeNull();
  });

  it('invalid lifecycle_hash (63 chars) returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) =>
      t[0] === 'lifecycle_hash' ? ['lifecycle_hash', 'a'.repeat(63)] : t
    );
    expect(parsePetListing(event)).toBeNull();
  });

  it('missing total_spent tag returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.filter((t) => t[0] !== 'total_spent');
    expect(parsePetListing(event)).toBeNull();
  });

  it('negative total_spent returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.map((t) =>
      t[0] === 'total_spent' ? ['total_spent', '-1'] : t
    );
    expect(parsePetListing(event)).toBeNull();
  });

  it('missing stage tag returns null', () => {
    const event = makeListingEvent();
    event.tags = event.tags.filter((t) => t[0] !== 'stage');
    expect(parsePetListing(event)).toBeNull();
  });

  it('unparseable content falls back to zero stats (no throw)', () => {
    const result = parsePetListing(makeListingEvent({ content: 'not-json' }));
    expect(result).not.toBeNull();
    expect(result?.stats.hunger).toBe(0);
  });

  it('missing content stats fields falls back to zero stats', () => {
    const result = parsePetListing(makeListingEvent({ content: '{"foo": 1}' }));
    expect(result).not.toBeNull();
    expect(result?.stats).toEqual({
      hunger: 0,
      happiness: 0,
      health: 0,
      hygiene: 0,
      energy: 0,
    });
  });

  it('sellerPubkey populated from p tag', () => {
    const result = parsePetListing(makeListingEvent());
    expect(result?.sellerPubkey).toBe(SELLER_PUBKEY);
  });

  it('relayUrl populated from relay tag', () => {
    const result = parsePetListing(makeListingEvent());
    expect(result?.relayUrl).toBe('wss://relay.example.com');
  });

  it('expiresAt populated from expiration tag', () => {
    const result = parsePetListing(makeListingEvent());
    expect(result?.expiresAt).toBe(EXPIRES_AT);
  });

  it('verified biography — lifecycleHash and totalSpent round-trip correctly', () => {
    // AC-3: biography attachment survives parse; buyer can read both fields
    const result = parsePetListing(makeListingEvent());
    expect(result?.lifecycleHash).toBe(LIFECYCLE_HASH);
    expect(result?.totalSpent).toBe('42000');
  });
});
