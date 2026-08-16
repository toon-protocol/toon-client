import { describe, it, expect } from 'vitest';
import { counterpartyMatch, sameSettlementAddress } from './counterparty.js';

/**
 * The comparison behind every "is this recorded channel still held with the
 * node that answers this route today?" check (see counterparty.ts).
 */
describe('sameSettlementAddress', () => {
  it('compares EVM addresses case-insensitively (announces carry checksum case)', () => {
    // The live evidence: the daemon's store recorded the lower-case form while
    // the kind:10032 announce states the EIP-55 checksummed one. Treating those
    // as different counterparties would retire every healthy EVM binding.
    expect(
      sameSettlementAddress(
        '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff',
        '0x6B6C2DAcF7ac1f1273F72Bef2E6084f9EE6d3bFF'
      )
    ).toBe(true);
  });

  it('separates two different EVM addresses', () => {
    expect(
      sameSettlementAddress(
        '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf',
        '0x3F43d923a611bCB2D0Bfb5d6ee2C3AC3EfEaf308'
      )
    ).toBe(false);
  });

  it('compares base58 (Solana/Mina) verbatim — case is SIGNIFICANT there', () => {
    const solana = 'ApexSolanaSettlement111111111111111111111';
    expect(sameSettlementAddress(solana, solana)).toBe(true);
    expect(sameSettlementAddress(solana, solana.toLowerCase())).toBe(false);
  });
});

describe('counterpartyMatch', () => {
  it("says 'match' when the record names the address announced now", () => {
    expect(
      counterpartyMatch(
        { recipient: '0x3F43d923a611bCB2D0Bfb5d6ee2C3AC3EfEaf308' },
        '0x3f43d923a611bcb2d0bfb5d6ee2c3ac3efeaf308'
      )
    ).toBe('match');
  });

  it("says 'mismatch' when the node terminating the route was replaced", () => {
    // g.toon's settlement address on 2026-08-13 vs the node that answers now.
    expect(
      counterpartyMatch(
        { recipient: '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf' },
        '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff'
      )
    ).toBe('mismatch');
  });

  it("says 'unrecorded' for a legacy record with no counterparty — unverified, NOT stale", () => {
    expect(
      counterpartyMatch({}, '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff')
    ).toBe('unrecorded');
    expect(counterpartyMatch(undefined, '0x6b6c2dac')).toBe('unrecorded');
  });

  it("says 'unrecorded' when the peer announces no settlement address", () => {
    expect(
      counterpartyMatch(
        { recipient: '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf' },
        undefined
      )
    ).toBe('unrecorded');
  });
});
