/**
 * Daemon-as-accelerator delegation tests (#279): the probe, the
 * decision matrix in resolvePaidSession (same identity → delegate;
 * different → standalone; unreachable → standalone), the identity-first
 * trust boundary, and the plain-fetch /git/* client's success/error paths.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveNostrKeyFromMnemonic } from '@toon-protocol/client';
import type { GitEventResponse } from '../routes.js';
import {
  DaemonGitClient,
  DaemonRouteError,
  DaemonTooOldForGitError,
  DaemonUnreachableError,
  daemonBaseUrl,
  daemonSupportsGit,
  probeDaemon,
  resolvePaidSession,
  type DaemonProbe,
} from './daemon-session.js';
import type { StandaloneContext } from './standalone-context.js';

/** Standard BIP-39 test vector phrase (public; never funded). */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PUBKEY = deriveNostrKeyFromMnemonic(TEST_MNEMONIC, 0).pubkey;
const OTHER_PUBKEY = 'ff'.repeat(32);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// daemonBaseUrl / probeDaemon
// ---------------------------------------------------------------------------

describe('daemonBaseUrl', () => {
  it('defaults to port 8787 and honors TOON_CLIENT_HTTP_PORT', () => {
    expect(daemonBaseUrl({})).toBe('http://127.0.0.1:8787');
    expect(daemonBaseUrl({ TOON_CLIENT_HTTP_PORT: '9001' })).toBe(
      'http://127.0.0.1:9001'
    );
    expect(daemonBaseUrl({ TOON_CLIENT_HTTP_PORT: 'junk' })).toBe(
      'http://127.0.0.1:8787'
    );
  });
});

describe('probeDaemon', () => {
  it('parses identity, ready, relay URL, feePerEvent, and capabilities from /status', async () => {
    const probe = await probeDaemon({}, (async (url: unknown) => {
      expect(String(url)).toBe('http://127.0.0.1:8787/status');
      return jsonResponse({
        ready: true,
        identity: { nostrPubkey: TEST_PUBKEY },
        relay: { url: 'wss://relay.example' },
        feePerEvent: '7',
        capabilities: ['git'],
      });
    }) as typeof fetch);
    expect(probe).toEqual({
      baseUrl: 'http://127.0.0.1:8787',
      reachable: true,
      identity: TEST_PUBKEY,
      ready: true,
      relayUrl: 'wss://relay.example',
      feePerEvent: '7',
      capabilities: ['git'],
    });
  });

  it('leaves capabilities undefined for an OLD daemon that omits the field', async () => {
    const probe = await probeDaemon({}, (async () =>
      jsonResponse({ identity: { nostrPubkey: TEST_PUBKEY } })) as typeof fetch);
    expect(probe.capabilities).toBeUndefined();
    expect(daemonSupportsGit(probe)).toBe(false);
  });

  it('keeps only string capability entries (garbage is filtered)', async () => {
    const probe = await probeDaemon({}, (async () =>
      jsonResponse({
        identity: { nostrPubkey: TEST_PUBKEY },
        capabilities: ['git', 7, null, 'future'],
      })) as typeof fetch);
    expect(probe.capabilities).toEqual(['git', 'future']);
    expect(daemonSupportsGit(probe)).toBe(true);
  });
});

describe('daemonSupportsGit', () => {
  const base: DaemonProbe = { baseUrl: 'http://127.0.0.1:8787', reachable: true };
  it('true only when capabilities includes "git"', () => {
    expect(daemonSupportsGit({ ...base, capabilities: ['git'] })).toBe(true);
    expect(daemonSupportsGit({ ...base, capabilities: ['other'] })).toBe(false);
    expect(daemonSupportsGit({ ...base, capabilities: [] })).toBe(false);
    // Old daemon (field absent) fails closed.
    expect(daemonSupportsGit(base)).toBe(false);
  });

  it.each([
    ['fetch throws', async () => Promise.reject(new Error('ECONNREFUSED'))],
    ['non-2xx', async () => new Response('nope', { status: 500 })],
    ['non-JSON', async () => new Response('<html>', { status: 200 })],
  ])('reports unreachable when %s', async (_label, impl) => {
    const probe = await probeDaemon({}, impl as unknown as typeof fetch);
    expect(probe.reachable).toBe(false);
    expect(probe.identity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePaidSession — the decision matrix
// ---------------------------------------------------------------------------

describe('resolvePaidSession', () => {
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  let warnings: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-session-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'rig-session-cwd-'));
    env = { TOON_CLIENT_HOME: home, RIG_MNEMONIC: TEST_MNEMONIC };
    warnings = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const fakeCtx = { ownerPubkey: TEST_PUBKEY } as StandaloneContext;

  function probeOf(
    overrides: Partial<DaemonProbe>
  ): () => Promise<DaemonProbe> {
    return async () => ({
      baseUrl: 'http://127.0.0.1:8787',
      reachable: false,
      ...overrides,
    });
  }

  it('SAME identity + git capability → delegates (standalone loader never invoked)', async () => {
    let loaded = 0;
    const session = await resolvePaidSession({
      env,
      cwd,
      warn: (l) => warnings.push(l),
      loadStandalone: async () => {
        loaded += 1;
        return fakeCtx;
      },
      probeDaemon: probeOf({
        reachable: true,
        identity: TEST_PUBKEY,
        feePerEvent: '5',
        relayUrl: 'wss://daemon-relay.example',
        capabilities: ['git'],
      }),
    });
    expect(session.path).toBe('daemon');
    if (session.path !== 'daemon') throw new Error('unreachable');
    expect(session.identity.pubkey).toBe(TEST_PUBKEY);
    expect(session.identity.source).toBe('env');
    expect(session.feePerEvent).toBe('5');
    expect(session.daemonRelayUrl).toBe('wss://daemon-relay.example');
    expect(loaded).toBe(0);
    expect(warnings.join('\n')).toContain('paid path: daemon');
  });

  it('SAME identity but OLD daemon (no git capability) → actionable error, NOT a raw 404', async () => {
    let loaded = 0;
    const err = await resolvePaidSession({
      env,
      cwd,
      warn: (l) => warnings.push(l),
      loadStandalone: async () => {
        loaded += 1;
        return fakeCtx;
      },
      // No `capabilities` field at all — an old client-mcp daemon.
      probeDaemon: probeOf({ reachable: true, identity: TEST_PUBKEY }),
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DaemonTooOldForGitError);
    const message = (err as Error).message;
    // Names the identity, the missing routes, AND both remediations.
    expect(message).toContain(TEST_PUBKEY.slice(0, 8));
    expect(message).toContain('missing /git routes');
    expect(message).toContain('npm i -g @toon-protocol/client-mcp@latest');
    expect(message).toContain('stop it to let rig run standalone');
    // Never surfaced as an opaque 404, and standalone never silently ran
    // (that would trip the #228 nonce guard anyway).
    expect(message).not.toContain('404');
    expect(loaded).toBe(0);
    // It did NOT announce "delegating".
    expect(warnings.join('\n')).not.toContain('delegating');
  });

  it('SAME identity + capabilities present but WITHOUT git → actionable error', async () => {
    await expect(
      resolvePaidSession({
        env,
        cwd,
        warn: (l) => warnings.push(l),
        loadStandalone: async () => fakeCtx,
        probeDaemon: probeOf({
          reachable: true,
          identity: TEST_PUBKEY,
          capabilities: ['something-else'],
        }),
      })
    ).rejects.toBeInstanceOf(DaemonTooOldForGitError);
  });

  it('RIG_STANDALONE set → standalone, probe NEVER run even for a same-identity git daemon', async () => {
    let probed = 0;
    let loaded = 0;
    const session = await resolvePaidSession({
      env: { ...env, RIG_STANDALONE: '1' },
      cwd,
      warn: (l) => warnings.push(l),
      loadStandalone: async () => {
        loaded += 1;
        return fakeCtx;
      },
      // A same-identity daemon that DOES support git would normally delegate;
      // the override must skip the probe entirely and run standalone instead.
      probeDaemon: async () => {
        probed += 1;
        return {
          baseUrl: 'http://127.0.0.1:8787',
          reachable: true,
          identity: TEST_PUBKEY,
          capabilities: ['git'],
        };
      },
    });
    expect(session.path).toBe('standalone');
    expect(probed).toBe(0);
    expect(loaded).toBe(1);
    expect(warnings.join('\n')).toContain('RIG_STANDALONE set');
  });

  it('DIFFERENT identity → standalone (no conflict, no delegation)', async () => {
    const session = await resolvePaidSession({
      env,
      cwd,
      warn: (l) => warnings.push(l),
      loadStandalone: async () => fakeCtx,
      probeDaemon: probeOf({ reachable: true, identity: OTHER_PUBKEY }),
    });
    expect(session.path).toBe('standalone');
    expect(warnings.join('\n')).toContain('different identity');
  });

  it('UNREACHABLE daemon → standalone', async () => {
    const session = await resolvePaidSession({
      env,
      cwd,
      warn: (l) => warnings.push(l),
      loadStandalone: async () => fakeCtx,
      probeDaemon: probeOf({}),
    });
    expect(session.path).toBe('standalone');
    expect(warnings.join('\n')).toContain(
      'paid path: standalone (no toon-clientd'
    );
  });

  it('confirms the identity match BEFORE any request body is sent', async () => {
    // The probe is injected, so the only way a request could reach the
    // daemon is through the returned client — and with a DIFFERENT identity
    // no client is ever constructed. fetchImpl proves nothing was sent.
    let fetches = 0;
    const session = await resolvePaidSession({
      env,
      cwd,
      warn: () => {},
      loadStandalone: async () => fakeCtx,
      fetchImpl: (async () => {
        fetches += 1;
        return jsonResponse({});
      }) as typeof fetch,
      probeDaemon: probeOf({ reachable: true, identity: OTHER_PUBKEY }),
    });
    expect(session.path).toBe('standalone');
    expect(fetches).toBe(0);
  });

  it('a reachable daemon + missing local identity surfaces MissingIdentityError', async () => {
    delete env['RIG_MNEMONIC'];
    await expect(
      resolvePaidSession({
        env,
        cwd,
        warn: () => {},
        loadStandalone: async () => fakeCtx,
        probeDaemon: probeOf({ reachable: true, identity: TEST_PUBKEY }),
      })
    ).rejects.toThrow(/no identity found/);
  });
});

// ---------------------------------------------------------------------------
// DaemonGitClient — wire behavior
// ---------------------------------------------------------------------------

describe('DaemonGitClient', () => {
  const RECEIPT: GitEventResponse = {
    eventId: 'ef'.repeat(32),
    feePaid: '5',
    kind: 1622,
  };

  it('POSTs the request body to the matching /git/* route', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const client = new DaemonGitClient('http://127.0.0.1:8787', (async (
      url: unknown,
      init: RequestInit | undefined
    ) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse(RECEIPT);
    }) as typeof fetch);

    const req = {
      repoAddr: { ownerPubkey: 'ab'.repeat(32), repoId: 'demo' },
      rootEventId: '12'.repeat(32),
      body: 'B',
      marker: 'root' as const,
    };
    await expect(client.gitComment(req)).resolves.toEqual(RECEIPT);
    expect(seen).toEqual([
      { url: 'http://127.0.0.1:8787/git/comment', body: req },
    ]);
  });

  it('maps a non-2xx envelope to DaemonRouteError with the structured payload', async () => {
    const client = new DaemonGitClient('http://x', (async () =>
      jsonResponse(
        { error: 'non_fast_forward', detail: 'remote moved', refs: [] },
        409
      )) as typeof fetch);
    const err = await client
      .gitPush({ repoPath: '/r', repoId: 'demo', confirm: true })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(DaemonRouteError);
    expect((err as DaemonRouteError).status).toBe(409);
    expect((err as DaemonRouteError).envelope['error']).toBe(
      'non_fast_forward'
    );
    expect((err as DaemonRouteError).envelope['refs']).toEqual([]);
  });

  it('maps a 404 on a git route to DaemonTooOldForGitError (defense in depth)', async () => {
    // The capability probe said "git" but the route is actually missing (a
    // lie, or a mid-restart skew): the raw 404 must still degrade to the
    // actionable upgrade error, never the opaque "HTTP 404" envelope.
    const client = new DaemonGitClient(
      'http://127.0.0.1:8787',
      (async () => new Response('Not Found', { status: 404 })) as typeof fetch,
      TEST_PUBKEY
    );
    const err = await client
      .gitPush({ repoPath: '/r', repoId: 'demo', confirm: true })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(DaemonTooOldForGitError);
    const message = (err as Error).message;
    expect(message).toContain('missing /git routes');
    expect(message).toContain(TEST_PUBKEY.slice(0, 8));
    expect(message).not.toContain('404');
  });

  it('wraps a vanished daemon in DaemonUnreachableError (post-probe race)', async () => {
    const client = new DaemonGitClient('http://x', (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch);
    await expect(
      client.gitIssue({
        repoAddr: { ownerPubkey: 'ab'.repeat(32), repoId: 'demo' },
        title: 'T',
        body: 'B',
      })
    ).rejects.toThrow(DaemonUnreachableError);
  });
});
