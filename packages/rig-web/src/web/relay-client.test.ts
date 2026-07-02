// Test IDs: 8.1-UNIT-006
// AC covered: AC11 (TOON format decoding in browser relay client)

import { describe, it, expect, vi } from 'vitest';
import { encode } from '@toon-format/toon';

import {
  decodeToonMessage,
  decodeEventFallback,
  salvageEventId,
  queryRelay,
} from './relay-client.js';
import type { UnparseableEvent } from './relay-client.js';
import {
  ISSUE_68F5C016_WIRE_FRAME,
  ISSUE_68F5C016_WIRE_PAYLOAD,
} from './__fixtures__/issue-68f5c016-wire.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory: creates a minimal kind:30617 NostrEvent object.
 */
function createMockRepoAnnouncementEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    name?: string;
    description?: string;
    dTag?: string;
  } = {}
) {
  return {
    id: overrides.id ?? 'a'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: 1700000000,
    kind: 30617,
    tags: [
      ['d', overrides.dTag ?? 'my-repo'],
      ['name', overrides.name ?? 'My Repository'],
      ['description', overrides.description ?? 'A test repository'],
      ['clone', 'https://git.example.com/my-repo.git'],
      ['r', 'HEAD', 'main'],
    ],
    content: overrides.description ?? 'A test repository',
    sig: 'b'.repeat(128),
  };
}

describe('Relay Client - TOON Format Decoding', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-006: TOON-encoded kind:30617 event is correctly decoded
  // AC: #11
  // ---------------------------------------------------------------------------

  it('[P1] decodes TOON-encoded string to a valid NostrEvent', () => {
    // Arrange -- encode a real event as a TOON string
    const mockEvent = createMockRepoAnnouncementEvent({
      name: 'test-project',
      dTag: 'test-project',
    });
    const toonString = encode(mockEvent);

    // Act -- decode the TOON string
    const decoded = decodeToonMessage(toonString);

    // Assert
    expect(decoded).toBeDefined();
    expect(decoded.kind).toBe(30617);
    expect(decoded.id).toBe('a'.repeat(64));
    expect(decoded.pubkey).toBe('ab'.repeat(32));
  });

  it('[P1] decodes TOON-encoded event preserving all tags', () => {
    // Arrange
    const mockEvent = createMockRepoAnnouncementEvent({
      name: 'tagged-repo',
      dTag: 'tagged-repo',
    });
    const toonString = encode(mockEvent);

    // Act
    const decoded = decodeToonMessage(toonString);

    // Assert -- verify tags are preserved
    const dTag = decoded.tags.find((t: string[]) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe('tagged-repo');

    const nameTag = decoded.tags.find((t: string[]) => t[0] === 'name');
    expect(nameTag).toBeDefined();
    expect(nameTag![1]).toBe('tagged-repo');

    const cloneTag = decoded.tags.find((t: string[]) => t[0] === 'clone');
    expect(cloneTag).toBeDefined();
    expect(cloneTag![1]).toBe('https://git.example.com/my-repo.git');
  });

  it('[P1] handles object passthrough for already-decoded events', () => {
    // Arrange -- pass an already-decoded object (non-TOON relay or test scenario)
    const mockEvent = createMockRepoAnnouncementEvent({
      name: 'passthrough-project',
      dTag: 'passthrough-project',
    });

    // Act -- decode should pass through objects unchanged
    const decoded = decodeToonMessage(mockEvent);

    // Assert
    expect(decoded).toBe(mockEvent);
    expect(decoded.kind).toBe(30617);
  });

  it('[P1] decoded TOON string preserves content field', () => {
    // Arrange
    const mockEvent = createMockRepoAnnouncementEvent({
      description: 'A longer description with special chars: <>&"',
    });
    const toonString = encode(mockEvent);

    // Act
    const decoded = decodeToonMessage(toonString);

    // Assert -- content field preserved
    expect(decoded.content).toBe(
      'A longer description with special chars: <>&"'
    );
  });
});

// ============================================================================
// #276: the exact wire payload the Issues tab silently dropped
// ============================================================================

describe('Relay Client - tolerant decoding of the #276 wire payload', () => {
  it('[P0] decodes the real devnet issue event that @toon-format/toon rejects', async () => {
    // Pin: this payload really does break the upstream TOON decoder — if
    // this ever starts passing, the fallback (and this pin) can be retired.
    const { decode } = await import('@toon-format/toon');
    expect(() => decode(ISSUE_68F5C016_WIRE_PAYLOAD)).toThrow();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const decoded = decodeToonMessage(ISSUE_68F5C016_WIRE_PAYLOAD);

      expect(decoded.id).toBe(
        '68f5c016e5a3128d7af740e088fc5d94e56edda4205fffa56aa3d58fe6bb55ee'
      );
      expect(decoded.pubkey).toBe(
        '3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5'
      );
      expect(decoded.kind).toBe(1621);
      expect(decoded.created_at).toBe(1783027036);
      // Escaped quotes and backticks survive intact
      expect(decoded.content).toContain('prints "Hello, world!"');
      expect(decoded.content).toContain('(process.argv[2])');
      expect(decoded.content).toContain('`node index.js Ada` -> "Hello, Ada!"');
      // All four tags survive, including the `t` label and the quoted #a value
      expect(decoded.tags).toEqual([
        [
          'a',
          '30617:3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5:hello-compare-rig',
        ],
        ['p', '3cd318a74dbac2a29491ebf64db6ac66965c2ba907585d34705772f417aad6d5'],
        ['subject', 'greeting should accept a name argument'],
        ['t', 'enhancement'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('[P1] fallback decoder round-trips any content the canonical encoder emits', () => {
    // The minimal trigger of the upstream bug: a quoted scalar containing
    // an inline-array-header-shaped substring ("[2]:").
    const nasty = {
      id: 'f'.repeat(64),
      pubkey: 'e'.repeat(64),
      created_at: 1700000001,
      kind: 1621,
      tags: [['t', 'bug']],
      content: 'watch argv[2]: and "quotes", `ticks`, newline-free',
      sig: 'd'.repeat(128),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const decoded = decodeToonMessage(encode(nasty));
      expect(decoded).toEqual(nasty);
    } finally {
      warn.mockRestore();
    }
  });

  it('[P1] decodes canonical NIP-01 JSON payloads (post relay#46 world)', () => {
    const event = {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: 1700000000,
      kind: 1621,
      tags: [['t', 'enhancement']],
      content: 'plain JSON event',
      sig: 'c'.repeat(128),
    };
    const decoded = decodeToonMessage(JSON.stringify(event));
    expect(decoded).toEqual(event);
  });

  it('[P1] decodeEventFallback rejects payloads that are not NostrEvent-shaped', () => {
    expect(() => decodeEventFallback('definitely: not-an-event')).toThrow();
    expect(() => decodeEventFallback('')).toThrow();
  });

  it('[P1] salvageEventId extracts the id from TOON and JSON payloads', () => {
    expect(salvageEventId(ISSUE_68F5C016_WIRE_PAYLOAD)).toBe(
      '68f5c016e5a3128d7af740e088fc5d94e56edda4205fffa56aa3d58fe6bb55ee'
    );
    expect(salvageEventId(`{"id":"${'a'.repeat(64)}","kind":1}`)).toBe(
      'a'.repeat(64)
    );
    expect(salvageEventId('garbage')).toBeNull();
  });

  it('[P2] the captured frame is a standard ["EVENT", subId, payload] message', () => {
    const frame = JSON.parse(ISSUE_68F5C016_WIRE_FRAME) as unknown[];
    expect(frame[0]).toBe('EVENT');
    expect(frame[2]).toBe(ISSUE_68F5C016_WIRE_PAYLOAD);
  });
});

// ============================================================================
// #276: queryRelay must never silently drop an undecodable EVENT frame
// ============================================================================

/** Minimal WebSocket mock that lets the test script the relay's frames. */
class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

describe('queryRelay - unparseable events are surfaced, never dropped', () => {
  it('[P0] reports an undecodable EVENT via onUnparseable and still resolves good events', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    MockWebSocket.instances = [];

    try {
      const reported: UnparseableEvent[] = [];
      const promise = queryRelay(
        'wss://mock.example',
        { kinds: [1621] },
        1000,
        (u) => reported.push(u)
      );

      // Wait for the socket to open and the REQ to be sent
      await new Promise((r) => setTimeout(r, 0));
      const ws = MockWebSocket.instances[0]!;
      const req = JSON.parse(ws.sent[0]!) as [string, string, unknown];
      expect(req[0]).toBe('REQ');
      const subId = req[1];

      const goodEvent = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1700000000,
        kind: 1621,
        tags: [['t', 'ok']],
        content: 'fine',
        sig: 'c'.repeat(128),
      };
      const badId = '9'.repeat(64);
      // Defeats ALL decoders: not JSON, TOON decode yields a non-event shape,
      // and the tolerant fallback rejects it (kind is not a number).
      const badPayload = `id: ${badId}\nkind: not-a-number`;

      ws.onmessage?.({
        data: JSON.stringify(['EVENT', subId, encode(goodEvent)]),
      });
      ws.onmessage?.({ data: JSON.stringify(['EVENT', subId, badPayload]) });
      ws.onmessage?.({ data: JSON.stringify(['EOSE', subId]) });

      const events = await promise;

      // The good event decoded; the bad one was surfaced — not dropped
      expect(events).toEqual([goodEvent]);
      expect(reported).toHaveLength(1);
      expect(reported[0]!.id).toBe(badId);
      expect(reported[0]!.raw).toBe(badPayload);
      expect(reported[0]!.error).toBeTruthy();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
