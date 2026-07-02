/**
 * Test fixtures for the #278 read path: an in-process mock relay (a fake
 * WebSocketLike that answers NIP-01 REQs from a filter handler), a mock
 * Arweave gateway (a FetchLike serving txId → bytes with per-host failure
 * injection), and helpers to enumerate a REAL git repository's objects for
 * serving. Used by clone/fetch/tracker tests and the strict-json matrix —
 * NOT shipped (nothing imports it outside *.test.ts files).
 */

import { execFileSync } from 'node:child_process';
import type { FetchLike } from '../object-fetch.js';
import type {
  NostrEvent,
  NostrFilter,
  WebSocketFactory,
  WebSocketLike,
} from '../remote-state.js';

// ---------------------------------------------------------------------------
// Mock relay (fake WebSocket answering REQ → EVENT* → EOSE)
// ---------------------------------------------------------------------------

/** How the mock relay serializes EVENT payloads (devnet tolerance matrix). */
export type PayloadEncoding = 'object' | 'double-json';

type Listener = (event: never) => void;

class FakeRelaySocket implements WebSocketLike {
  readyState = 1;
  private listeners = new Map<string, Listener[]>();

  constructor(
    private readonly url: string,
    private readonly handler: (
      filter: NostrFilter,
      url: string
    ) => NostrEvent[],
    private readonly encoding: PayloadEncoding
  ) {
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (event: unknown) => void)(event);
    }
  }

  send(data: string): void {
    const msg = JSON.parse(data) as unknown[];
    if (msg[0] !== 'REQ') return;
    const subId = msg[1] as string;
    const filter = msg[2] as NostrFilter;
    const events = this.handler(filter, this.url);
    queueMicrotask(() => {
      for (const event of events) {
        const payload =
          this.encoding === 'double-json' ? JSON.stringify(event) : event;
        this.emit('message', {
          data: JSON.stringify(['EVENT', subId, payload]),
        });
      }
      this.emit('message', { data: JSON.stringify(['EOSE', subId]) });
    });
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }
}

/**
 * A WebSocketFactory whose sockets answer every REQ from `handler`. The
 * devnet relay's non-canonical EVENT serialization is reproduced with
 * `encoding: 'double-json'`.
 */
export function makeMockRelayFactory(
  handler: (filter: NostrFilter, url: string) => NostrEvent[],
  encoding: PayloadEncoding = 'object'
): WebSocketFactory {
  return (url) => new FakeRelaySocket(url, handler, encoding);
}

/** Serve canned events with basic NIP-01 filter matching (kinds/ids/#a/#e/#d/authors). */
export function filterEvents(
  events: NostrEvent[],
  filter: NostrFilter
): NostrEvent[] {
  return events.filter((event) => {
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter.ids && !filter.ids.includes(event.id)) return false;
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
    for (const tagName of ['a', 'e', 'd'] as const) {
      const wanted = filter[`#${tagName}`];
      if (
        wanted &&
        !event.tags.some(
          (t) => t[0] === tagName && wanted.includes(t[1] as string)
        )
      ) {
        return false;
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Mock Arweave gateway
// ---------------------------------------------------------------------------

export interface MockGateway {
  fetchFn: FetchLike;
  /** Every URL requested, in order. */
  requests: string[];
  /** txId → bytes served (mutate to tamper / remove). */
  store: Map<string, Uint8Array>;
}

/**
 * A FetchLike serving `https://<host>/<txId>` from an in-memory store.
 * Hosts listed in `failHosts` always return !ok — proving the fallback
 * chain walks to the next gateway.
 */
export function makeMockGateway(
  store: Map<string, Uint8Array>,
  options: { failHosts?: string[] } = {}
): MockGateway {
  const requests: string[] = [];
  const failHosts = new Set(options.failHosts ?? []);
  const fetchFn: FetchLike = async (url) => {
    requests.push(url);
    const parsed = new URL(url);
    const txId = parsed.pathname.slice(1);
    const bytes = store.get(txId);
    if (failHosts.has(parsed.host) || bytes === undefined) {
      return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const copy = bytes.slice();
    return {
      ok: true,
      arrayBuffer: async () =>
        copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    };
  };
  return { fetchFn, requests, store };
}

/** Deterministic fake Arweave txId (43-char base64url) for a git SHA. */
export function txFor(sha: string): string {
  return (sha + sha).slice(0, 43);
}

// ---------------------------------------------------------------------------
// Real-repo enumeration (serve a REAL repository through the mock gateway)
// ---------------------------------------------------------------------------

export interface EnumeratedObject {
  sha: string;
  type: string;
  body: Buffer;
}

/** Run git in `cwd` returning stdout as a Buffer (binary-safe). */
export function gitRaw(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

/** Run git in `cwd` returning trimmed UTF-8 stdout. */
export function gitText(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).toString('utf-8').trim();
}

/** Every object in the repository (sha, type, raw body bytes). */
export function enumerateRepoObjects(repoDir: string): EnumeratedObject[] {
  const listing = gitText(repoDir, [
    'cat-file',
    '--batch-check=%(objectname) %(objecttype)',
    '--batch-all-objects',
    '--unordered',
  ]);
  const objects: EnumeratedObject[] = [];
  for (const line of listing.split('\n')) {
    if (!line) continue;
    const [sha, type] = line.split(' ') as [string, string];
    const body = gitRaw(repoDir, ['cat-file', type, sha]);
    objects.push({ sha, type, body });
  }
  return objects;
}

/** The repo's refs (`refname → sha`) and HEAD symref. */
export function enumerateRepoRefs(repoDir: string): {
  refs: Map<string, string>;
  head: string;
} {
  const refs = new Map<string, string>();
  const out = gitText(repoDir, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads',
    'refs/tags',
  ]);
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [refname, sha] = line.split(' ') as [string, string];
    refs.set(refname, sha);
  }
  const head = gitText(repoDir, ['symbolic-ref', 'HEAD']);
  return { refs, head };
}

/** Build the kind:30617 + kind:30618 relay events describing `repoDir`. */
export function repoStateEvents(opts: {
  repoDir: string;
  owner: string;
  repoId: string;
  createdAt?: number;
  /** Override the arweave map (default: txFor(sha) for every object). */
  arweaveMap?: Map<string, string>;
}): {
  announce: NostrEvent;
  refsEvent: NostrEvent;
  objects: EnumeratedObject[];
} {
  const createdAt = opts.createdAt ?? 1000;
  const { refs, head } = enumerateRepoRefs(opts.repoDir);
  const objects = enumerateRepoObjects(opts.repoDir);
  const arweaveMap =
    opts.arweaveMap ?? new Map(objects.map((o) => [o.sha, txFor(o.sha)]));

  const announce: NostrEvent = {
    id: 'a0'.repeat(32),
    pubkey: opts.owner,
    created_at: createdAt,
    kind: 30617,
    tags: [
      ['d', opts.repoId],
      ['name', opts.repoId],
      ['description', 'test repo'],
    ],
    content: '',
    sig: 'f0'.repeat(64),
  };
  const refsEvent: NostrEvent = {
    id: 'c0'.repeat(31) + `${(createdAt % 97).toString(16).padStart(2, '0')}`,
    pubkey: opts.owner,
    created_at: createdAt,
    kind: 30618,
    tags: [
      ['d', opts.repoId],
      ...[...refs].map(([refname, sha]) => ['r', refname, sha]),
      ['HEAD', `ref: ${head}`],
      ...[...arweaveMap].map(([sha, txId]) => ['arweave', sha, txId]),
    ],
    content: '',
    sig: 'f1'.repeat(64),
  };
  return { announce, refsEvent, objects };
}

/** Load every enumerated object into a mock-gateway store keyed by txFor(sha). */
export function storeFromObjects(
  objects: EnumeratedObject[]
): Map<string, Uint8Array> {
  return new Map(objects.map((o) => [txFor(o.sha), new Uint8Array(o.body)]));
}
