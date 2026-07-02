/**
 * Tests for the remote-state reader (#225).
 *
 * Uses an in-process `ws` WebSocketServer as a mock relay serving canned
 * kind:30617/30618 events; the reader connects with the native (undici)
 * WebSocket client, exactly as it does in production.
 */

import { encode as encodeToon } from '@toon-format/toon';
import { clearShaCache } from '@toon-protocol/arweave';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

import { fetchRemoteState, type NostrEvent } from './remote-state.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = 'a1'.repeat(32);
const OTHER_PUBKEY = 'b2'.repeat(32);
const REPO = 'demo-repo';
const SHA_MAIN = '1a'.repeat(20);
const SHA_DEV = '2b'.repeat(20);
const SHA_UNMAPPED = '3c'.repeat(20);
const TX_MAIN = 'MaInMaInMaInMaInMaInMaInMaInMaInMaInMaInMaI';
const TX_DEV = 'DeVdEvDeVdEvDeVdEvDeVdEvDeVdEvDeVdEvDeVdEvD';
const TX_GRAPHQL = 'GrApHqLgRaPhQlGrApHqLgRaPhQlGrApHqLgRaPhQlX';

function makeAnnounceEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'a0'.repeat(32),
    pubkey: OWNER,
    created_at: 1000,
    kind: 30617,
    tags: [
      ['d', REPO],
      ['name', 'Demo Repo'],
      ['description', 'A demo repository'],
      ['relays', 'wss://relay-one.example', 'wss://relay-two.example'],
    ],
    content: '',
    sig: 'f0'.repeat(64),
    ...overrides,
  };
}

function makeRefsEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'c0'.repeat(32),
    pubkey: OWNER,
    created_at: 2000,
    kind: 30618,
    tags: [
      ['d', REPO],
      ['r', 'refs/heads/main', SHA_MAIN],
      ['r', 'refs/heads/dev', SHA_DEV],
      ['HEAD', 'ref: refs/heads/main'],
      ['arweave', SHA_MAIN, TX_MAIN],
      ['arweave', SHA_DEV, TX_DEV],
    ],
    content: '',
    sig: 'f1'.repeat(64),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock relay
// ---------------------------------------------------------------------------

type PayloadEncoding = 'object' | 'double-json' | 'toon';

interface MockRelay {
  url: string;
  /** Filters received in REQ messages (for asserting the query shape). */
  reqFilters: unknown[];
  close(): Promise<void>;
}

function encodePayload(event: NostrEvent, encoding: PayloadEncoding): unknown {
  switch (encoding) {
    case 'object':
      return event;
    case 'double-json':
      // Devnet relay quirk: the EVENT payload is a JSON *string* containing
      // the event JSON (double-encoded).
      return JSON.stringify(event);
    case 'toon':
      return encodeToon(event as unknown as Parameters<typeof encodeToon>[0]);
  }
}

/**
 * Start an in-process mock relay. On REQ it sends the canned events (in the
 * given payload encoding) followed by EOSE — unless `silent`, in which case
 * it never answers (for timeout tests).
 */
async function startMockRelay(
  events: NostrEvent[],
  options: { encoding?: PayloadEncoding; silent?: boolean } = {}
): Promise<MockRelay> {
  const { encoding = 'object', silent = false } = options;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));

  const reqFilters: unknown[] = [];
  wss.on('connection', (socket) => {
    socket.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as unknown[];
      if (msg[0] !== 'REQ') return;
      const subId = msg[1] as string;
      reqFilters.push(msg[2]);
      if (silent) return;
      for (const event of events) {
        socket.send(
          JSON.stringify(['EVENT', subId, encodePayload(event, encoding)])
        );
      }
      socket.send(JSON.stringify(['EOSE', subId]));
    });
  });

  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    reqFilters,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchRemoteState', () => {
  const relays: MockRelay[] = [];

  async function relay(
    events: NostrEvent[],
    options?: Parameters<typeof startMockRelay>[1]
  ): Promise<MockRelay> {
    const r = await startMockRelay(events, options);
    relays.push(r);
    return r;
  }

  beforeEach(() => {
    // fetchRemoteState seeds the shared @toon-protocol/arweave cache; keep
    // tests isolated from each other.
    clearShaCache();
  });

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.close()));
    vi.restoreAllMocks();
  });

  it('fetches 30617 + 30618 and parses refs, HEAD symref, arweave map, and metadata', async () => {
    const r = await relay([makeAnnounceEvent(), makeRefsEvent()]);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.announced).toBe(true);
    expect(state.announceEvent?.id).toBe(makeAnnounceEvent().id);
    expect(state.refsEvent?.id).toBe(makeRefsEvent().id);
    expect(state.refs.get('refs/heads/main')).toBe(SHA_MAIN);
    expect(state.refs.get('refs/heads/dev')).toBe(SHA_DEV);
    expect(state.refs.size).toBe(2);
    expect(state.headSymref).toBe('refs/heads/main');
    expect(state.shaToTxId.get(SHA_MAIN)).toBe(TX_MAIN);
    expect(state.shaToTxId.get(SHA_DEV)).toBe(TX_DEV);
    expect(state.name).toBe('Demo Repo');
    expect(state.description).toBe('A demo repository');
    expect(state.relays).toEqual([
      'wss://relay-one.example',
      'wss://relay-two.example',
    ]);

    // The REQ carried the NIP-01 filter for both kinds, scoped to owner+repo
    expect(r.reqFilters[0]).toEqual({
      kinds: [30617, 30618],
      authors: [OWNER],
      '#d': [REPO],
    });
  });

  it('decodes double-JSON-encoded EVENT payloads (devnet relay quirk)', async () => {
    const r = await relay([makeAnnounceEvent(), makeRefsEvent()], {
      encoding: 'double-json',
    });

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.announced).toBe(true);
    expect(state.refs.get('refs/heads/main')).toBe(SHA_MAIN);
    expect(state.shaToTxId.get(SHA_MAIN)).toBe(TX_MAIN);
  });

  it('decodes TOON-encoded EVENT payloads', async () => {
    const r = await relay([makeAnnounceEvent(), makeRefsEvent()], {
      encoding: 'toon',
    });

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.announced).toBe(true);
    expect(state.refs.get('refs/heads/main')).toBe(SHA_MAIN);
    expect(state.headSymref).toBe('refs/heads/main');
  });

  it('applies NIP-33 replaceable semantics: newest 30618 wins', async () => {
    const older = makeRefsEvent({
      id: 'd1'.repeat(32),
      created_at: 1500,
      tags: [
        ['d', REPO],
        ['r', 'refs/heads/main', SHA_UNMAPPED],
      ],
    });
    const newer = makeRefsEvent({ id: 'd2'.repeat(32), created_at: 2500 });
    // Serve oldest last to prove selection is by created_at, not arrival order
    const r = await relay([newer, older]);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.refsEvent?.id).toBe(newer.id);
    expect(state.refs.get('refs/heads/main')).toBe(SHA_MAIN);
  });

  it('breaks created_at ties by lowest event id (NIP-01)', async () => {
    const idLow = makeRefsEvent({ id: '11'.repeat(32), created_at: 2000 });
    const idHigh = makeRefsEvent({
      id: 'ff'.repeat(32),
      created_at: 2000,
      tags: [
        ['d', REPO],
        ['r', 'refs/heads/main', SHA_UNMAPPED],
      ],
    });
    const r = await relay([idHigh, idLow]);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.refsEvent?.id).toBe(idLow.id);
  });

  it('reports announced=false with empty state for an unknown repo (first push)', async () => {
    const r = await relay([]);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.announced).toBe(false);
    expect(state.announceEvent).toBeNull();
    expect(state.refsEvent).toBeNull();
    expect(state.refs.size).toBe(0);
    expect(state.headSymref).toBeNull();
    expect(state.shaToTxId.size).toBe(0);
    expect(state.name).toBeNull();
    expect(state.description).toBeNull();
    expect(state.relays).toEqual([]);
  });

  it('ignores events from other authors or other repos (untrusted relay)', async () => {
    const foreignAuthor = makeRefsEvent({
      id: 'e1'.repeat(32),
      pubkey: OTHER_PUBKEY,
      created_at: 9999,
    });
    const foreignRepo = makeAnnounceEvent({
      id: 'e2'.repeat(32),
      tags: [['d', 'some-other-repo']],
      created_at: 9999,
    });
    const r = await relay([foreignAuthor, foreignRepo]);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.announced).toBe(false);
    expect(state.refsEvent).toBeNull();
  });

  it('resolveMissing serves tag-mapped SHAs without hitting the resolver', async () => {
    const r = await relay([makeRefsEvent()]);
    const resolveSha = vi.fn(async () => TX_GRAPHQL);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
      resolveSha,
    });

    const resolved = await state.resolveMissing([SHA_MAIN, SHA_DEV]);

    expect(resolved.get(SHA_MAIN)).toBe(TX_MAIN);
    expect(resolved.get(SHA_DEV)).toBe(TX_DEV);
    expect(resolveSha).not.toHaveBeenCalled();
  });

  it('resolveMissing falls back to the GraphQL resolver for unmapped SHAs and omits unresolved ones', async () => {
    const r = await relay([makeRefsEvent()]);
    const unresolvable = '4d'.repeat(20);
    const resolveSha = vi.fn(async (sha: string) =>
      sha === SHA_UNMAPPED ? TX_GRAPHQL : null
    );

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
      resolveSha,
    });

    const resolved = await state.resolveMissing([
      SHA_MAIN,
      SHA_UNMAPPED,
      unresolvable,
    ]);

    expect(resolved.get(SHA_MAIN)).toBe(TX_MAIN);
    expect(resolved.get(SHA_UNMAPPED)).toBe(TX_GRAPHQL);
    expect(resolved.has(unresolvable)).toBe(false);
    expect(resolveSha).toHaveBeenCalledWith(SHA_UNMAPPED, REPO);
    expect(resolveSha).toHaveBeenCalledWith(unresolvable, REPO);
    expect(resolveSha).not.toHaveBeenCalledWith(SHA_MAIN, REPO);
  });

  it('seeds the shared resolver cache from arweave tags (default resolver skips GraphQL)', async () => {
    const r = await relay([makeRefsEvent()]);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => {
      throw new Error('GraphQL should not be hit for tag-mapped SHAs');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const state = await fetchRemoteState({
        relayUrls: [r.url],
        ownerPubkey: OWNER,
        repoId: REPO,
        // default resolveSha (the real resolveGitSha) on purpose
      });

      const resolved = await state.resolveMissing([SHA_MAIN]);
      expect(resolved.get(SHA_MAIN)).toBe(TX_MAIN);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolves with partial (empty) state when the relay never sends EOSE (timeout)', async () => {
    const r = await relay([makeRefsEvent()], { silent: true });

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
      timeoutMs: 250,
    });

    expect(state.announced).toBe(false);
    expect(state.refs.size).toBe(0);
  });

  it('merges multiple relays and picks the newest replaceable across them', async () => {
    const older = makeRefsEvent({
      id: 'a1'.repeat(32),
      created_at: 1500,
      tags: [
        ['d', REPO],
        ['r', 'refs/heads/main', SHA_UNMAPPED],
      ],
    });
    const newer = makeRefsEvent({ id: 'a2'.repeat(32), created_at: 2500 });
    const rOld = await relay([older]);
    const rNew = await relay([newer, makeAnnounceEvent()]);

    const state = await fetchRemoteState({
      relayUrls: [rOld.url, rNew.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.refsEvent?.id).toBe(newer.id);
    expect(state.refs.get('refs/heads/main')).toBe(SHA_MAIN);
    expect(state.announced).toBe(true);
  });

  it('succeeds when one relay is down as long as another answers', async () => {
    const rLive = await relay([makeAnnounceEvent(), makeRefsEvent()]);

    const state = await fetchRemoteState({
      // Port 9 (discard) — nothing listening, connection refused
      relayUrls: ['ws://127.0.0.1:9', rLive.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.announced).toBe(true);
    expect(state.refs.get('refs/heads/main')).toBe(SHA_MAIN);
  });

  it('throws when every relay fails', async () => {
    await expect(
      fetchRemoteState({
        relayUrls: ['ws://127.0.0.1:9', 'http://not-a-relay.example'],
        ownerPubkey: OWNER,
        repoId: REPO,
        timeoutMs: 500,
      })
    ).rejects.toThrow(/all 2 relay\(s\) failed/);
  });

  it('rejects empty relayUrls / missing owner / missing repoId', async () => {
    await expect(
      fetchRemoteState({ relayUrls: [], ownerPubkey: OWNER, repoId: REPO })
    ).rejects.toThrow(/relayUrls/);
    await expect(
      fetchRemoteState({ relayUrls: ['ws://x'], ownerPubkey: '', repoId: REPO })
    ).rejects.toThrow(/ownerPubkey/);
    await expect(
      fetchRemoteState({ relayUrls: ['ws://x'], ownerPubkey: OWNER, repoId: '' })
    ).rejects.toThrow(/repoId/);
  });

  it('parses the alternate ["r", "HEAD", "ref: …"] symref spelling', async () => {
    const refsEvent = makeRefsEvent({
      tags: [
        ['d', REPO],
        ['r', 'refs/heads/main', SHA_MAIN],
        ['r', 'HEAD', 'ref: refs/heads/main'],
      ],
    });
    const r = await relay([refsEvent]);

    const state = await fetchRemoteState({
      relayUrls: [r.url],
      ownerPubkey: OWNER,
      repoId: REPO,
    });

    expect(state.headSymref).toBe('refs/heads/main');
    // The symref row must not leak into the ref map
    expect(state.refs.has('HEAD')).toBe(false);
    expect(state.refs.size).toBe(1);
  });
});
