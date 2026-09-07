import { describe, expect, it } from 'vitest';
import { validateSocks5hUrl } from './socks-url.js';

describe('validateSocks5hUrl', () => {
  it('parses host and port', () => {
    expect(validateSocks5hUrl('socks5h://127.0.0.1:9050')).toEqual({ host: '127.0.0.1', port: 9050 });
  });

  it('defaults to the SOCKS port when none is given', () => {
    expect(validateSocks5hUrl('socks5h://proxy.local')).toEqual({ host: 'proxy.local', port: 1080 });
  });

  it('refuses socks5:// — the missing h is a DNS leak, not a typo', () => {
    expect(() => validateSocks5hUrl('socks5://127.0.0.1:9050')).toThrow(/socks5h:\/\/ scheme/);
    expect(() => validateSocks5hUrl('socks5://127.0.0.1:9050')).toThrow(/local DNS query/);
  });

  it('refuses any other scheme, naming what it got', () => {
    expect(() => validateSocks5hUrl('http://127.0.0.1:9050')).toThrow(/socks5h:\/\/ scheme/);
    expect(() => validateSocks5hUrl('http://127.0.0.1:9050')).toThrow(/"http:\/\/"/);
  });

  it('refuses a malformed URL', () => {
    expect(() => validateSocks5hUrl('socks5h://')).toThrow(/Malformed|missing host/);
    // `URL` rejects a port above 65535 itself, before our own range check.
    expect(() => validateSocks5hUrl('socks5h://host:99999')).toThrow(/Malformed/);
  });

  it('refuses a port URL accepts but SOCKS cannot use', () => {
    // Distinct from the malformed case above: this URL parses fine, and it is
    // the port range — not the syntax — that the parser objects to.
    expect(() => validateSocks5hUrl('socks5h://host:0')).toThrow(/out of range/);
  });
});
