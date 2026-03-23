// Test IDs: 8.1-UNIT-005
// AC covered: AC10 (Relay URL configuration via query param)

import { describe, it, expect } from 'vitest';

import { parseRelayUrl, parseRoute, isValidRelayUrl } from './router.js';

describe('Router - Relay URL Configuration', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-005: Relay URL extracted from query parameter
  // AC: #10
  // ---------------------------------------------------------------------------

  it('[P2] extracts relay URL from ?relay= query parameter', () => {
    // Arrange
    const search = '?relay=wss://relay.example.com';

    // Act
    const relayUrl = parseRelayUrl(search);

    // Assert
    expect(relayUrl).toBe('wss://relay.example.com');
  });

  it('[P2] returns default relay URL when ?relay= is absent', () => {
    // Arrange
    const search = '';

    // Act
    const relayUrl = parseRelayUrl(search);

    // Assert -- should return a sensible default (wss://localhost:7100 for dev)
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P2] handles relay URL with other query params present', () => {
    // Arrange
    const search = '?foo=bar&relay=wss://my-relay.com&baz=qux';

    // Act
    const relayUrl = parseRelayUrl(search);

    // Assert
    expect(relayUrl).toBe('wss://my-relay.com');
  });

  it('[P1] rejects relay URL with http:// protocol and returns default', () => {
    // Arrange -- SSRF / protocol confusion attempt
    const search = '?relay=http://internal-service:8080';

    // Act
    const relayUrl = parseRelayUrl(search);

    // Assert -- should fall back to default, not use the invalid URL
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P1] rejects relay URL with javascript: protocol and returns default', () => {
    // Arrange -- XSS attempt via protocol
    const search = '?relay=javascript:alert(1)';

    // Act
    const relayUrl = parseRelayUrl(search);

    // Assert
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P2] accepts ws:// relay URL', () => {
    // Arrange
    const search = '?relay=ws://localhost:7100';

    // Act
    const relayUrl = parseRelayUrl(search);

    // Assert -- ws:// is valid and returned as-is (not upgraded to wss://)
    expect(relayUrl).toBe('ws://localhost:7100');
  });
});

describe('Router - isValidRelayUrl', () => {
  it('accepts ws:// URLs', () => {
    expect(isValidRelayUrl('ws://localhost:7100')).toBe(true);
  });

  it('accepts wss:// URLs', () => {
    expect(isValidRelayUrl('wss://relay.example.com')).toBe(true);
  });

  it('rejects http:// URLs', () => {
    expect(isValidRelayUrl('http://example.com')).toBe(false);
  });

  it('rejects https:// URLs', () => {
    expect(isValidRelayUrl('https://example.com')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isValidRelayUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidRelayUrl('')).toBe(false);
  });
});

describe('Router - Route Parsing', () => {
  it('[P2] parses root route as repo list', () => {
    // Arrange & Act
    const route = parseRoute('/');

    // Assert
    expect(route.type).toBe('repo-list');
  });

  it('[P2] parses /<npub>/<repo>/ as file tree route', () => {
    // Arrange
    const npub = 'npub1' + 'a'.repeat(58);
    const path = `/${npub}/my-repo/`;

    // Act
    const route = parseRoute(path);

    // Assert
    expect(route.type).toBe('file-tree');
    if (route.type === 'file-tree') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
    }
  });

  it('[P2] parses /<npub>/<repo>/commit/<sha> as commit route', () => {
    // Arrange
    const npub = 'npub1' + 'a'.repeat(58);
    const sha = 'deadbeef'.repeat(5);
    const path = `/${npub}/my-repo/commit/${sha}`;

    // Act
    const route = parseRoute(path);

    // Assert
    expect(route.type).toBe('commit');
    if (route.type === 'commit') {
      expect(route.sha).toBe(sha);
    }
  });

  it('[P2] parses /<npub>/<repo>/blame/<path> as blame route', () => {
    // Arrange
    const npub = 'npub1' + 'a'.repeat(58);
    const path = `/${npub}/my-repo/blame/src/main.ts`;

    // Act
    const route = parseRoute(path);

    // Assert
    expect(route.type).toBe('blame');
    if (route.type === 'blame') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.path).toBe('src/main.ts');
    }
  });

  it('[P2] parses single-segment path as not-found', () => {
    // Arrange & Act
    const route = parseRoute('/only-one-segment');

    // Assert
    expect(route.type).toBe('not-found');
  });
});
