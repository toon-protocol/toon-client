import { describe, it, expect } from 'vitest';
import {
  isRoutableHsHostname,
  assertRoutableHsHostname,
  HS_HOSTNAME_REGEX,
} from './hs-hostname.js';

describe('isRoutableHsHostname', () => {
  it('accepts a base32 .anyone hostname', () => {
    expect(isRoutableHsHostname('abc234.anyone')).toBe(true);
  });

  it('rejects a .anon hostname', () => {
    expect(isRoutableHsHostname('abc234.anon')).toBe(false);
  });

  it('rejects a bare clearnet hostname', () => {
    expect(isRoutableHsHostname('example.com')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isRoutableHsHostname(undefined)).toBe(false);
    expect(isRoutableHsHostname(null)).toBe(false);
    expect(isRoutableHsHostname(123)).toBe(false);
  });

  it('rejects uppercase / non-base32 labels', () => {
    expect(isRoutableHsHostname('ABC.anyone')).toBe(false);
    expect(isRoutableHsHostname('abc1.anyone')).toBe(false); // 0,1,8,9 not in base32
  });

  it('rejects an over-length hostname', () => {
    const longLabel = 'a'.repeat(80);
    expect(isRoutableHsHostname(`${longLabel}.anyone`)).toBe(false);
  });

  it('HS_HOSTNAME_REGEX matches .anyone only', () => {
    expect(HS_HOSTNAME_REGEX.test('abc234.anyone')).toBe(true);
    expect(HS_HOSTNAME_REGEX.test('abc234.anon')).toBe(false);
  });
});

describe('assertRoutableHsHostname', () => {
  it('returns a valid .anyone hostname unchanged', () => {
    expect(assertRoutableHsHostname('abc234.anyone')).toBe('abc234.anyone');
  });

  it('rejects a .anon hostname with an actionable .anyone message', () => {
    expect(() => assertRoutableHsHostname('abc234.anon')).toThrow(
      /not a routable hidden-service address; use the \.anyone TLD/
    );
  });

  it('suggests the corrected .anyone form for a .anon hostname', () => {
    expect(() => assertRoutableHsHostname('abc234.anon')).toThrow(
      /abc234\.anyone/
    );
  });

  it('rejects an arbitrary clearnet hostname with a format error', () => {
    expect(() => assertRoutableHsHostname('example.com')).toThrow(
      /Invalid hidden-service hostname/
    );
  });

  it('rejects non-string input', () => {
    expect(() => assertRoutableHsHostname(undefined)).toThrow(
      /Invalid hidden-service hostname/
    );
  });
});
