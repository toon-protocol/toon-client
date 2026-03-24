// @vitest-environment jsdom

// Test IDs: 8.1-UNIT-005, 8.2 router tests
// AC covered: AC10 (Relay URL configuration via query param), AC17 (tree/blob routes)

import { describe, it, expect, beforeEach } from 'vitest';

import { parseRelayUrl, parseRoute, isValidRelayUrl } from './router.js';

describe('Router - Relay URL Configuration', () => {
  // Clear hash between tests to prevent cross-test pollution.
  // parseRelayUrl migrates ?relay= to #relay=, which persists in jsdom.
  beforeEach(() => {
    window.location.hash = '';
  });

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

  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  it('[P2] accepts ws:// relay URL', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    const relayUrl = parseRelayUrl('?relay=ws://localhost:7100');
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    expect(relayUrl).toBe('ws://localhost:7100');
  });

  // ---------------------------------------------------------------------------
  // Story 8.7: Hash fragment relay configuration for Arweave deployment
  // AC: #11 (Relay configurable via URL hash fragment)
  // ---------------------------------------------------------------------------

  it('[P0] extracts relay URL from #relay= hash fragment (Arweave primary)', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    window.location.hash = '#relay=wss://relay.toon-protocol.org';
    const relayUrl = parseRelayUrl('');
    expect(relayUrl).toBe('wss://relay.toon-protocol.org');
  });

  it('[P0] hash fragment takes priority over query parameter', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    window.location.hash = '#relay=wss://hash-relay.example';
    const relayUrl = parseRelayUrl('?relay=wss://query-relay.example');
    expect(relayUrl).toBe('wss://hash-relay.example');
  });

  it('[P1] rejects non-WebSocket hash relay URL and falls through to default', () => {
    window.location.hash = '#relay=https://evil.example';
    const relayUrl = parseRelayUrl('');
    expect(relayUrl).toBe('wss://localhost:7100');
  });

  it('[P1] empty hash fragment falls through to query param', () => {
    window.location.hash = '';
    const relayUrl = parseRelayUrl('?relay=wss://fallback.example');
    expect(relayUrl).toBe('wss://fallback.example');
  });

  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  it('[P2] hash fragment with ws:// (insecure) is accepted for local dev', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    window.location.hash = '#relay=ws://localhost:7100';
    const relayUrl = parseRelayUrl('');
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    expect(relayUrl).toBe('ws://localhost:7100');
  });

  it('[P2] hash fragment relay URL is shareable/bookmarkable pattern', () => {
    // Simulates an Arweave gateway URL like https://ar-io.dev/<txId>/#relay=wss://relay.example
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    window.location.hash = '#relay=wss://relay.example.com';
    const relayUrl = parseRelayUrl('');
    expect(relayUrl).toBe('wss://relay.example.com');
  });
});

describe('Router - isValidRelayUrl', () => {
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  it('accepts ws:// URLs', () => {
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
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

  it('[P2] parses /<npub>/<repo>/blame/<ref>/<path> as blame route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blame/main/src/file.ts`);

    expect(route.type).toBe('blame');
    if (route.type === 'blame') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.ref).toBe('main');
      expect(route.path).toBe('src/file.ts');
    }
  });

  it('[P2] blame route with no file path (segments.length === 4) does NOT match blame', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blame/main`);

    // Should fall through to bare repo tree route, not blame
    expect(route.type).not.toBe('blame');
  });

  it('[P2] blame route with trailing slash and no file path does NOT match blame', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blame/main/`);

    // Trailing slash produces empty segment removed by filter(Boolean),
    // leaving [npub, repo, 'blame', 'main'] — only 4 segments, below the
    // segments.length >= 5 guard, so this must NOT match blame.
    expect(route.type).not.toBe('blame');
  });

  it('[P2] parses single-segment path as short-form repo route', () => {
    const route = parseRoute('/only-one-segment');
    expect(route.type).toBe('tree');
    expect((route as { owner: string }).owner).toBe('');
    expect((route as { repo: string }).repo).toBe('only-one-segment');
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

  // ---------------------------------------------------------------------------
  // Story 8.5: Issue and PR routes
  // ---------------------------------------------------------------------------

  it('[P1] parses /<npub>/<repo>/issues as issues list route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/issues`);

    expect(route.type).toBe('issues');
    if (route.type === 'issues') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
    }
  });

  it('[P1] parses /<npub>/<repo>/issues/<eventId> as issue detail route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const eventId = 'e'.repeat(64);
    const route = parseRoute(`/${npub}/my-repo/issues/${eventId}`);

    expect(route.type).toBe('issue-detail');
    if (route.type === 'issue-detail') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.eventId).toBe(eventId);
    }
  });

  it('[P1] parses /<npub>/<repo>/pulls as pulls list route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/pulls`);

    expect(route.type).toBe('pulls');
    if (route.type === 'pulls') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
    }
  });

  it('[P1] parses /<npub>/<repo>/pulls/<eventId> as pull detail route', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const eventId = 'f'.repeat(64);
    const route = parseRoute(`/${npub}/my-repo/pulls/${eventId}`);

    expect(route.type).toBe('pull-detail');
    if (route.type === 'pull-detail') {
      expect(route.owner).toBe(npub);
      expect(route.repo).toBe('my-repo');
      expect(route.eventId).toBe(eventId);
    }
  });

  // Regression: existing routes still parse correctly
  it('[P1] existing tree route still works after adding issues/pulls routes', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/tree/main/src`);

    expect(route.type).toBe('tree');
  });

  it('[P1] existing blob route still works after adding issues/pulls routes', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blob/main/src/index.ts`);

    expect(route.type).toBe('blob');
  });

  it('[P1] existing blame route still works after adding issues/pulls routes', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/blame/main/src/file.ts`);

    expect(route.type).toBe('blame');
  });

  it('[P1] bare repo route still works after adding issues/pulls routes', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/`);

    expect(route.type).toBe('tree');
  });

  // ---------------------------------------------------------------------------
  // Story 8.6: 8.6-UNIT-004 — URL-encoded ref decoding
  // AC: #4 (refs containing / round-trip through URL encoding)
  // ---------------------------------------------------------------------------

  it('[P1] decodes URL-encoded ref for tree route (refs%2Fheads%2Fmain)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/tree/refs%2Fheads%2Fmain/src`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      expect(route.ref).toBe('refs/heads/main');
      expect(route.path).toBe('src');
    }
  });

  it('[P1] decodes URL-encoded ref for blob route (refs%2Fheads%2Fmain)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(
      `/${npub}/my-repo/blob/refs%2Fheads%2Fmain/src/index.ts`
    );

    expect(route.type).toBe('blob');
    if (route.type === 'blob') {
      expect(route.ref).toBe('refs/heads/main');
      expect(route.path).toBe('src/index.ts');
    }
  });

  it('[P1] decodes URL-encoded ref for commits route (refs%2Fheads%2Fmain)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/commits/refs%2Fheads%2Fmain`);

    expect(route.type).toBe('commits');
    if (route.type === 'commits') {
      expect(route.ref).toBe('refs/heads/main');
    }
  });

  it('[P1] decodes URL-encoded ref for blame route (refs%2Fheads%2Fmain)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(
      `/${npub}/my-repo/blame/refs%2Fheads%2Fmain/src/file.ts`
    );

    expect(route.type).toBe('blame');
    if (route.type === 'blame') {
      expect(route.ref).toBe('refs/heads/main');
      expect(route.path).toBe('src/file.ts');
    }
  });

  it('[P2] non-encoded ref still works (no double-decode)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    const route = parseRoute(`/${npub}/my-repo/tree/main/src`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      expect(route.ref).toBe('main');
    }
  });

  it('[P1] malformed percent-encoding does not throw (returns original string)', () => {
    const npub = 'npub1' + 'a'.repeat(58);
    // %ZZ is not valid percent-encoding — decodeURIComponent would throw URIError
    const route = parseRoute(`/${npub}/my-repo/tree/%ZZ/src`);

    expect(route.type).toBe('tree');
    if (route.type === 'tree') {
      // Should return the original string rather than throwing
      expect(route.ref).toBe('%ZZ');
    }
  });
});
