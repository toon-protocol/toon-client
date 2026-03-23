// Test IDs: 8.1-UNIT-005, 8.2 router tests
// AC covered: AC10 (Relay URL configuration via query param), AC17 (tree/blob routes)

import { describe, it, expect } from 'vitest';

import { parseRelayUrl, parseRoute, isValidRelayUrl } from './router.js';

describe('Router - Relay URL Configuration', () => {
  it('[P2] extracts relay URL from ?relay= query parameter', () => {
    const relayUrl = parseRelayUrl('?relay=wss://relay.example.com');
    expect(relayUrl).toBe('wss://relay.example.com');
  });

  it('[P2] returns default relay URL when ?relay= is absent', () => {
    const relayUrl = parseRelayUrl('');
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P2] handles relay URL with other query params present', () => {
    const relayUrl = parseRelayUrl('?foo=bar&relay=wss://my-relay.com&baz=qux');
    expect(relayUrl).toBe('wss://my-relay.com');
  });

  it('[P1] rejects relay URL with http:// protocol and returns default', () => {
    const relayUrl = parseRelayUrl('?relay=http://internal-service:8080');
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P1] rejects relay URL with javascript: protocol and returns default', () => {
    const relayUrl = parseRelayUrl('?relay=javascript:alert(1)');
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P2] accepts ws:// relay URL', () => {
    const relayUrl = parseRelayUrl('?relay=ws://localhost:7100');
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
    const route = parseRoute('/');
    expect(route.type).toBe('repo-list');
  });

  it('[P2] parses /<npub>/<repo>/ as tree route with empty ref and path', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.ref).toBe('');
      expect(route.path).toBe('');
    }
  });

  it('[P2] parses /<npub>/<repo>/commit/<sha> as commit route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const sha = 'deadbeef'.repeat(5);
    const route = parseRoute(`/${npub}/my-repo/commit/${sha}`);

    expect(route.type).toBe('commit');
    if (route.type === 'commit') {
      expect(route.sha).toBe(sha);
    }
  });

  it('[P2] parses /<npub>/<repo>/blame/<path> as blame route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blame/src/main.ts`);

    expect(route.type).toBe('blame');
    if (route.type === 'blame') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.path).toBe('src/main.ts');
    }
  });

  it('[P2] parses single-segment path as not-found', () => {
    const route = parseRoute('/only-one-segment');
    expect(route.type).toBe('not-found');
  });

  // ---------------------------------------------------------------------------
  // Story 8.2: Tree and Blob route parsing
  // AC: #17
  // ---------------------------------------------------------------------------

  it('[P1] parses /<npub>/<repo>/tree/main/src/ as tree route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/tree/main/src/`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.ref).toBe('main');
      expect(route.path).toBe('src');
    }
  });

  it('[P1] parses /<npub>/<repo>/tree/main/ as tree route with empty path', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/tree/main/`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      expect(route.ref).toBe('main');
      expect(route.path).toBe('');
    }
  });

  it('[P1] parses /<npub>/<repo>/blob/main/src/index.ts as blob route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blob/main/src/index.ts`);

    expect(route.type).toBe('blob');
    if (route.type === 'blob') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.ref).toBe('main');
      expect(route.path).toBe('src/index.ts');
    }
  });

  it('[P1] parses nested tree path with multiple segments', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/repo/tree/develop/src/web/templates`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      expect(route.ref).toBe('develop');
      expect(route.path).toBe('src/web/templates');
    }
  });

  it('[P2] parses /<npub>/<repo>/blob/main/ as blob route with empty path', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blob/main/`);

    expect(route.type).toBe('blob');
    if (route.type === 'blob') {
      expect(route.ref).toBe('main');
      expect(route.path).toBe('');
    }
  });

  // ---------------------------------------------------------------------------
  // Story 8.3: Commits log route
  // AC: #15
  // ---------------------------------------------------------------------------

  it('[P1] parses /<npub>/<repo>/commits/main as commits route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/commits/main`);

    expect(route.type).toBe('commits');
    if (route.type === 'commits') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.ref).toBe('main');
    }
  });

  it('[P1] commits route (plural) does not conflict with commit route (singular)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const sha = 'deadbeef'.repeat(5);

    // commits (plural) -> commits route
    const commitsRoute = parseRoute(`/${npub}/my-repo/commits/develop`);
    expect(commitsRoute.type).toBe('commits');

    // commit (singular) -> commit route (regression test)
    const commitRoute = parseRoute(`/${npub}/my-repo/commit/${sha}`);
    expect(commitRoute.type).toBe('commit');
    if (commitRoute.type === 'commit') {
      expect(commitRoute.sha).toBe(sha);
    }
  });
});
