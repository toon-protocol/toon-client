/**
 * Tests for npub bech32 decode/validate paths (#428). `hexToNpub`'s encode
 * path already round-trips through every test here; this file locks down
 * `npubToHex`/`ownerToHex`, which had no dedicated coverage anywhere in the
 * repo (rig-web's sibling test only covers encoding).
 */

import { describe, it, expect } from 'vitest';

import { hexToNpub, npubToHex, ownerToHex } from './npub.js';

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Local reimplementation of the module's bech32 checksum machinery, used
// only to forge a checksum-valid-but-semantically-invalid npub (non-zero
// padding bits) that can't be produced via the public hexToNpub encoder.
function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      chk ^= (b >> i) & 1 ? (GEN[i] as number) : 0;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
  return ret;
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

function hexToBytesLocal(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** Forge a valid-checksum npub whose padding word has a non-zero low bit. */
function forgeNonZeroPaddingNpub(hex: string): string {
  const words = convertBits(hexToBytesLocal(hex), 8, 5, true);
  words[words.length - 1] = (words[words.length - 1] as number) | 1;
  const checksum = bech32CreateChecksum('npub', words);
  const combined = words.concat(checksum);
  return 'npub1' + combined.map((d) => BECH32_CHARSET[d]).join('');
}

const HEX = 'ab'.repeat(32);

describe('hexToNpub -> npubToHex round trip', () => {
  it('decodes back to the original hex for several pubkeys', () => {
    for (const hex of [HEX, 'cd'.repeat(32), '00'.repeat(32), 'ff'.repeat(32), '0123456789abcdef'.repeat(4)]) {
      expect(npubToHex(hexToNpub(hex))).toBe(hex);
    }
  });
});

describe('npubToHex throw branches', () => {
  const npub = hexToNpub(HEX);

  it('throws on mixed case', () => {
    const mixed = npub.slice(0, 6) + (npub[6] as string).toUpperCase() + npub.slice(7);
    expect(() => npubToHex(mixed)).toThrow('npub: mixed case');
  });

  it('throws on invalid prefix', () => {
    const bad = 'xxxx1' + npub.slice(5);
    expect(() => npubToHex(bad)).toThrow('npub: invalid prefix');
  });

  it('throws on invalid length (too short)', () => {
    expect(() => npubToHex(npub.slice(0, -1))).toThrow('npub: invalid length');
  });

  it('throws on invalid length (too long)', () => {
    expect(() => npubToHex(npub + 'q')).toThrow('npub: invalid length');
  });

  it('throws on invalid character', () => {
    // 'b' is not in the bech32 charset (excluded along with 1, i, o).
    const bad = npub.slice(0, 5) + 'b' + npub.slice(6);
    expect(() => npubToHex(bad)).toThrow('npub: invalid character');
  });

  it('throws on invalid checksum', () => {
    const lastChar = npub[npub.length - 1] as string;
    const replacement = BECH32_CHARSET[(BECH32_CHARSET.indexOf(lastChar) + 1) % 32];
    const bad = npub.slice(0, -1) + replacement;
    expect(() => npubToHex(bad)).toThrow('npub: invalid checksum');
  });

  it('throws on non-zero padding bits', () => {
    // hexToNpub always produces zero padding, so a checksum-valid npub with
    // non-zero trailing bits can only be forged, not observed from the
    // public encoder.
    const forged = forgeNonZeroPaddingNpub(HEX);
    expect(forged).toHaveLength(63);
    expect(() => npubToHex(forged)).toThrow('npub: non-zero padding bits');
  });

  // "npub: invalid data length" (bytes.length !== 32) is unreachable through
  // this public API: the length check above already fixes the input at 63
  // chars, which fixes the payload at exactly 52 five-bit words (58 data
  // chars minus 6 checksum words) = 260 bits = exactly 32 bytes every time.
  // No malformed-but-length-63 input can produce a different byte count, so
  // that branch is purely defensive and cannot be exercised here.
});

describe('ownerToHex', () => {
  it('passes through a 64-char lowercase hex owner unchanged', () => {
    expect(ownerToHex(HEX)).toBe(HEX);
  });

  it('decodes an npub1… owner to hex', () => {
    expect(ownerToHex(hexToNpub(HEX))).toBe(HEX);
  });

  it('rejects an owner that is neither hex nor npub1…', () => {
    expect(() => ownerToHex('not-a-valid-owner')).toThrow(
      /invalid owner "not-a-valid-owner": expected a 64-char lowercase hex pubkey or an npub1… string/
    );
  });

  it('rejects uppercase hex (not lowercase-normalized)', () => {
    expect(() => ownerToHex(HEX.toUpperCase())).toThrow(/invalid owner/);
  });

  it('rejects a malformed npub1… owner and wraps the underlying decode error', () => {
    const npub = hexToNpub(HEX);
    const badChecksum = npub.slice(0, -1) + (npub[npub.length - 1] === 'q' ? 'p' : 'q');
    expect(() => ownerToHex(badChecksum)).toThrow(/invalid owner ".*": npub: invalid checksum/);
  });
});
