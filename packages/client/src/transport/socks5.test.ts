import { describe, it, expect } from 'vitest';
import { validateSocks5hUrl } from './socks5.js';

describe('validateSocks5hUrl', () => {
  it('accepts valid socks5h:// URL', () => {
    const result = validateSocks5hUrl('socks5h://127.0.0.1:9050');
    expect(result).toEqual({ host: '127.0.0.1', port: 9050 });
  });

  it('accepts socks5h:// with hostname', () => {
    const result = validateSocks5hUrl('socks5h://proxy.example.com:1080');
    expect(result).toEqual({ host: 'proxy.example.com', port: 1080 });
  });

  it('defaults to port 1080 when port omitted', () => {
    const result = validateSocks5hUrl('socks5h://localhost');
    expect(result).toEqual({ host: 'localhost', port: 1080 });
  });

  it('rejects socks5:// (missing h — DNS leak risk)', () => {
    expect(() => validateSocks5hUrl('socks5://127.0.0.1:9050')).toThrow(
      'socks5h://'
    );
  });

  it('rejects http:// scheme', () => {
    expect(() => validateSocks5hUrl('http://127.0.0.1:9050')).toThrow(
      'socks5h://'
    );
  });

  it('rejects empty string', () => {
    expect(() => validateSocks5hUrl('')).toThrow('socks5h://');
  });

  it('rejects malformed URL', () => {
    expect(() => validateSocks5hUrl('socks5h://:')).toThrow();
  });
});
