import { describe, expect, it } from 'vitest';
import {
  assertRoutableHsHostname,
  isHiddenServiceUrl,
  isRoutableHsHostname,
} from './hs-hostname.js';

const HS = 'qrstuvwxyz234567abcdefghijklmnop.anyone';

describe('isRoutableHsHostname', () => {
  it('accepts a base32 .anyone address', () => {
    expect(isRoutableHsHostname(HS)).toBe(true);
  });

  it('rejects the TLDs that look right and are not', () => {
    expect(isRoutableHsHostname(HS.replace('.anyone', '.anon'))).toBe(false);
    expect(isRoutableHsHostname(HS.replace('.anyone', '.onion'))).toBe(false);
  });

  it('rejects an address outside the base32 alphabet', () => {
    // 0, 1, 8 and 9 are not in a-z2-7.
    expect(isRoutableHsHostname('abc189.anyone')).toBe(false);
  });

  it('rejects a pathologically long label', () => {
    expect(isRoutableHsHostname(`${'a'.repeat(200)}.anyone`)).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isRoutableHsHostname(undefined)).toBe(false);
    expect(isRoutableHsHostname(42)).toBe(false);
  });
});

describe('isHiddenServiceUrl', () => {
  it('sees through a URL to its host', () => {
    expect(isHiddenServiceUrl(`http://${HS}/ilp`)).toBe(true);
    expect(isHiddenServiceUrl(`http://${HS}:8080`)).toBe(true);
  });

  it('is false for clearnet and for anything that is not a URL', () => {
    expect(isHiddenServiceUrl('https://proxy.relay.devnet.toonprotocol.dev')).toBe(false);
    expect(isHiddenServiceUrl('not a url')).toBe(false);
    expect(isHiddenServiceUrl(undefined)).toBe(false);
  });
});

describe('assertRoutableHsHostname', () => {
  it('returns the hostname unchanged when it is routable', () => {
    expect(assertRoutableHsHostname(HS)).toBe(HS);
  });

  it('names the fix when handed .anon', () => {
    // The whole reason this check exists: anon treats `.anon` as clearnet and
    // fails deep in the transport with `HostUnreachable`, far from the typo.
    expect(() => assertRoutableHsHostname('abc.anon')).toThrow(/use the \.anyone TLD/);
    expect(() => assertRoutableHsHostname('abc.anon')).toThrow(/abc\.anyone/);
  });

  it('names the network when handed a Tor address', () => {
    expect(() => assertRoutableHsHostname('abc.onion')).toThrow(/Tor hidden service/);
    expect(() => assertRoutableHsHostname('abc.onion')).toThrow(/Anyone Protocol/);
  });

  it('rejects a clearnet host', () => {
    expect(() => assertRoutableHsHostname('example.com')).toThrow(/Invalid hidden-service hostname/);
  });
});
