import { describe, it, expect } from 'vitest';
import { encodePacked, keccak256, getAddress } from 'viem';
import { deriveEvmChannelId, sortParticipants } from './channel-id.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

/**
 * The independent oracle: viem's own `encodePacked` + `keccak256`, which is a
 * different implementation of the same `abi.encodePacked` layout the module
 * builds by hand. Asserting against it — rather than against a frozen hex
 * string — is what makes the preimage layout the thing under test.
 */
function viemChannelId(p1: string, p2: string, epoch: bigint): string {
  const [lo, hi] = sortParticipants(p1, p2);
  return keccak256(
    encodePacked(
      ['address', 'address', 'uint256'],
      [lo as `0x${string}`, hi as `0x${string}`, epoch]
    )
  );
}

describe('deriveEvmChannelId', () => {
  it('is keccak256(abi.encodePacked(p1, p2, epoch)) — checked against viem', () => {
    expect(deriveEvmChannelId(A, B, 0n)).toBe(viemChannelId(A, B, 0n));
    expect(deriveEvmChannelId(A, B, 7n)).toBe(viemChannelId(A, B, 7n));
    expect(deriveEvmChannelId(A, C, 31n)).toBe(viemChannelId(A, C, 31n));
  });

  it('agrees with the Rust mirror on the 72-byte preimage: 20 + 20 + 32, unpadded', () => {
    // `connector/crates/connector-settlement-evm/src/channel_id.rs`'s own
    // `the_preimage_is_abi_encode_packed_of_the_sorted_pair_and_the_epoch`:
    // the pair 0x22…/0x11… at epoch 7 hashes the sorted pair and a
    // big-endian epoch whose last byte is 7.
    const preimage = new Uint8Array(72);
    preimage.fill(0x11, 0, 20);
    preimage.fill(0x22, 20, 40);
    preimage[71] = 7;
    expect(deriveEvmChannelId(B, A, 7n)).toBe(keccak256(preimage));
  });

  it('derives the same id from either side of the pair', () => {
    expect(deriveEvmChannelId(A, B, 3n)).toBe(deriveEvmChannelId(B, A, 3n));
  });

  it('is unaffected by EIP-55 checksum casing, which is not part of the address', () => {
    expect(deriveEvmChannelId(getAddress(A), getAddress(B), 1n)).toBe(
      deriveEvmChannelId(A.toLowerCase(), B.toUpperCase().replace('0X', '0x'), 1n)
    );
  });

  it('gives a different counterparty a different channel', () => {
    expect(deriveEvmChannelId(A, B, 0n)).not.toBe(deriveEvmChannelId(A, C, 0n));
  });

  it('gives a later epoch a different channel for the same pair — how a pair reopens', () => {
    expect(deriveEvmChannelId(A, B, 0n)).not.toBe(deriveEvmChannelId(A, B, 1n));
  });

  it('returns the canonical spelling: 0x + 64 lower-case hex', () => {
    expect(deriveEvmChannelId(A, B, 0n)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('handles a large epoch without truncating it', () => {
    const big = (1n << 200n) + 5n;
    expect(deriveEvmChannelId(A, B, big)).toBe(viemChannelId(A, B, big));
  });

  it('refuses anything that is not an address, rather than hashing garbage', () => {
    expect(() => deriveEvmChannelId('0x1234', B, 0n)).toThrow(TypeError);
    expect(() => deriveEvmChannelId(A, 'not-an-address', 0n)).toThrow(TypeError);
  });

  it('refuses a negative epoch', () => {
    expect(() => deriveEvmChannelId(A, B, -1n)).toThrow(RangeError);
  });
});

describe('sortParticipants', () => {
  it('orders by address bytes, ascending, as TokenNetwork.openChannel does', () => {
    expect(sortParticipants(B, A)).toEqual([A, B]);
    expect(sortParticipants(A, B)).toEqual([A, B]);
  });

  it('sorts on the lower-cased bytes, not on checksummed text', () => {
    // '0xA…' sorts BEFORE '0xb…' as ASCII text but AFTER it as bytes, so a
    // pair sorted as checksummed strings lands in the opposite order.
    const upper = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const lower = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(sortParticipants(lower, upper)).toEqual([upper.toLowerCase(), lower]);
  });
});
