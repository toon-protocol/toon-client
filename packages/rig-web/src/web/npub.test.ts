// Tests for npub bech32 encoding
// AC covered: AC6 (Profile enrichment - npub encoding for display)

import { describe, it, expect } from 'vitest';

import { hexToNpub, truncateNpubFromHex } from './npub.js';

describe('hexToNpub', () => {
  it('produces a string starting with npub1', () => {
    const hex = 'ab'.repeat(32);
    const npub = hexToNpub(hex);
    expect(npub).toMatch(/^npub1/);
  });

  it('produces a consistent result for the same input', () => {
    const hex = 'cd'.repeat(32);
    const npub1 = hexToNpub(hex);
    const npub2 = hexToNpub(hex);
    expect(npub1).toBe(npub2);
  });

  it('produces different npubs for different hex pubkeys', () => {
    const npub1 = hexToNpub('ab'.repeat(32));
    const npub2 = hexToNpub('cd'.repeat(32));
    expect(npub1).not.toBe(npub2);
  });

  it('produces an npub with only lowercase alphanumeric chars after prefix', () => {
    const hex = 'ef'.repeat(32);
    const npub = hexToNpub(hex);
    // bech32 charset is lowercase alphanumeric (no b, i, o, 1 after separator)
    expect(npub).toMatch(/^npub1[a-z0-9]+$/);
  });
});

describe('truncateNpubFromHex', () => {
  it('returns npub1 prefix + 8 chars + ... + 4 chars', () => {
    const hex = 'ab'.repeat(32);
    const truncated = truncateNpubFromHex(hex);
    expect(truncated).toMatch(/^npub1[a-z0-9]{8}\.\.\.[a-z0-9]{4}$/);
  });

  it('is shorter than full npub', () => {
    const hex = 'ab'.repeat(32);
    const full = hexToNpub(hex);
    const truncated = truncateNpubFromHex(hex);
    expect(truncated.length).toBeLessThan(full.length);
  });
});
