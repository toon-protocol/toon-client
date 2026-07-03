/**
 * Remote repository state reader — the "what does the remote have?" half of
 * `rig push` (epic #222, ticket #225).
 *
 * Queries relay(s) over NIP-01 WebSocket for the repository's NIP-34 state:
 *   - kind:30618 (repository state): `r` tags → ref map, `HEAD` symref,
 *     `arweave` tags → git SHA → Arweave txId hints.
 *   - kind:30617 (repository announcement): presence = the repo exists on
 *     TOON (first-push detection) + name/description/relays metadata.
 *
 * Both kinds are NIP-33 parameterized-replaceable: per relay only the latest
 * event per (kind, author, d) survives, but we still pick the newest across
 * relays (highest created_at, ties broken by lowest id per NIP-01).
 *
 * SHAs missing from the `arweave` tag map can be resolved via the shared
 * Arweave GraphQL Git-SHA resolver (@toon-protocol/arweave — the same module
 * the rig SPA uses) through {@link RemoteState.resolveMissing}.
 *
 * Relay payload encodings (mirrors rig's `web/relay-client.ts` decode logic):
 * EVENT payloads arrive as an inline JSON object (standard NIP-01), as a
 * double-JSON-encoded string (devnet relay quirk: a JSON string containing
 * the event JSON), or as a TOON-encoded string. All three are tolerated.
 */

import { decode as decodeToon } from '@toon-format/toon';
import {
  resolveGitSha,
  seedShaCache,
  shaCacheKey,
} from '@toon-protocol/arweave';
import { REPOSITORY_ANNOUNCEMENT_KIND } from '@toon-protocol/core/nip34';

import { REPOSITORY_STATE_KIND, parseMaintainers } from './nip34-events.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A signed Nostr event as seen on a relay (read side). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** NIP-01 subscription filter (only the fields rig's readers send). */
export interface NostrFilter {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  '#d'?: string[];
  /** Repo address tag filter, e.g. `30617:<owner>:<repoId>` (#278 tracker). */
  '#a'?: string[];
  /** Event-reference tag filter (#278 tracker: statuses + comments). */
  '#e'?: string[];
  limit?: number;
}

/**
 * Minimal structural WebSocket type — satisfied by the WHATWG WebSocket
 * global (Node >= 22 / undici, browsers) and by the `ws` package.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

/** Factory for WebSocket connections (injectable for tests / `ws` fallback). */
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface FetchRemoteStateOptions {
  /**
   * Relay WebSocket URLs to query. Plural from day one (forward-compat with
   * multi-relay routing); size 1 is typical today. Results are merged and the
   * newest replaceable event across all relays wins.
   */
  relayUrls: string[];
  /** Repository owner's pubkey (hex) — the author of 30617/30618. */
  ownerPubkey: string;
  /** Repository identifier (NIP-34 `d` tag). */
  repoId: string;
  /** Per-relay timeout in milliseconds (default 10000). On timeout the relay contributes whatever it sent so far. */
  timeoutMs?: number;
  /**
   * Git-SHA → Arweave txId resolver used by {@link RemoteState.resolveMissing}.
   * Defaults to the shared GraphQL resolver from @toon-protocol/arweave;
   * injectable for tests.
   */
  resolveSha?: (sha: string, repo: string) => Promise<string | null>;
  /** WebSocket constructor override (defaults to the global WebSocket). */
  webSocketFactory?: WebSocketFactory;
}

/** Remote repository state assembled from relay events. */
export interface RemoteState {
  /** True when a kind:30617 announcement exists (false ⇒ first push). */
  announced: boolean;
  /** Ref map from the latest kind:30618: refname → commit SHA. */
  refs: Map<string, string>;
  /** HEAD symref target (e.g. `refs/heads/main`), or null if unset. */
  headSymref: string | null;
  /** Git SHA → Arweave txId hints from the latest kind:30618 `arweave` tags. */
  shaToTxId: Map<string, string>;
  /** The latest kind:30618 event, or null if the repo has no state yet. */
  refsEvent: NostrEvent | null;
  /** The latest kind:30617 event, or null if the repo is unannounced. */
  announceEvent: NostrEvent | null;
  /** Repository name from the announcement `name` tag. */
  name: string | null;
  /** Announcement `description` tag (falls back to event content). */
  description: string | null;
  /** Relay URLs advertised in the announcement `relays` tag(s). */
  relays: string[];
  /**
   * Declared maintainer pubkeys (hex) from the announcement `maintainers`
   * tag (#287). Does NOT include the owner (an implicit maintainer). Empty
   * when unannounced or owner-only.
   */
  maintainers: string[];
  /**
   * Resolve SHAs to Arweave txIds: served from the `arweave` tag map when
   * present, otherwise via the GraphQL Git-SHA resolver. SHAs that resolve
   * nowhere are omitted from the returned map.
   */
  resolveMissing(shas: string[]): Promise<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// Relay query (NIP-01 REQ → EVENT* → EOSE)
// ---------------------------------------------------------------------------

/** Validate that a relay URL uses a WebSocket scheme (mirrors rig's url-utils). */
function isValidRelayUrl(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

/** WHATWG WebSocket OPEN ready state. */
const WS_OPEN = 1;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (
    globalThis as { WebSocket?: new (url: string) => WebSocketLike }
  ).WebSocket;
  if (!ctor) {
    throw new Error(
      'No global WebSocket constructor (Node >= 22 required) — pass webSocketFactory'
    );
  }
  return new ctor(url);
}

/**
 * Decode a relay EVENT payload, tolerating every encoding seen in the wild:
 * inline object (standard NIP-01), double-JSON-encoded string (devnet relay
 * serves the event as a JSON string containing the event JSON), or a
 * TOON-encoded string (rig's `decodeToonMessage` path).
 */
function decodeEventPayload(payload: unknown): NostrEvent | null {
  if (payload !== null && typeof payload === 'object') {
    return payload as NostrEvent;
  }
  if (typeof payload !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as NostrEvent;
    }
  } catch {
    // Not JSON — fall through to TOON
  }
  try {
    return decodeToon(payload) as unknown as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * Query one relay: send a REQ, collect EVENTs until EOSE, then CLOSE.
 * Mirrors rig's `queryRelay` (partial results on timeout / early close).
 * Exported for reuse by the network-bootstrap discovery (kind:10032).
 */
export function queryRelay(
  relayUrl: string,
  filter: NostrFilter,
  timeoutMs: number,
  webSocketFactory: WebSocketFactory
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const subId = `git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let ws: WebSocketLike;
    // eslint-disable-next-line prefer-const -- assigned after `settle` is defined
    let timeoutHandle: ReturnType<typeof setTimeout>;
    let settled = false;

    const settle = (outcome: 'resolve' | 'reject', error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        if (ws.readyState === WS_OPEN) {
          ws.send(JSON.stringify(['CLOSE', subId]));
        }
        ws.close();
      } catch {
        // Ignore close errors
      }
      if (outcome === 'reject') {
        reject(error);
      } else {
        resolve(events);
      }
    };

    if (!isValidRelayUrl(relayUrl)) {
      reject(
        new Error(
          `Invalid relay URL protocol (must be ws:// or wss://): ${relayUrl}`
        )
      );
      return;
    }

    try {
      ws = webSocketFactory(relayUrl);
    } catch (err) {
      reject(new Error(`Failed to connect to relay ${relayUrl}: ${String(err)}`));
      return;
    }

    timeoutHandle = setTimeout(() => {
      // Resolve with whatever we collected so far (partial results)
      settle('resolve');
    }, timeoutMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.addEventListener('message', (msgEvent: { data?: unknown }) => {
      try {
        const msg = JSON.parse(String(msgEvent.data)) as unknown[];
        if (!Array.isArray(msg) || msg.length < 2) return;

        const msgType = msg[0];
        if (msgType === 'EVENT' && msg[1] === subId && msg[2] !== undefined) {
          const event = decodeEventPayload(msg[2]);
          if (event) events.push(event);
        } else if (msgType === 'EOSE' && msg[1] === subId) {
          settle('resolve');
        }
      } catch {
        // Ignore parse errors for individual messages
      }
    });

    ws.addEventListener('error', (event: { message?: unknown }) => {
      const detail =
        typeof event === 'object' && event !== null && 'message' in event
          ? String(event.message)
          : 'unknown';
      settle(
        'reject',
        new Error(`WebSocket error connecting to ${relayUrl}: ${detail}`)
      );
    });

    ws.addEventListener('close', () => {
      // If we haven't settled yet, resolve with what we have
      settle('resolve');
    });
  });
}

// ---------------------------------------------------------------------------
// NIP-33 replaceable selection + tag parsing
// ---------------------------------------------------------------------------

/**
 * Pick the winning replaceable event: highest created_at, ties broken by
 * lowest id (NIP-01 replaceable-event convention).
 */
function latestReplaceable(events: NostrEvent[]): NostrEvent | null {
  let winner: NostrEvent | null = null;
  for (const event of events) {
    if (
      winner === null ||
      event.created_at > winner.created_at ||
      (event.created_at === winner.created_at && event.id < winner.id)
    ) {
      winner = event;
    }
  }
  return winner;
}

/** Get the first value for a tag name. */
function getTagValue(tags: string[][], name: string): string | undefined {
  const tag = tags.find((t) => t[0] === name);
  return tag?.[1];
}

/** Maximum number of refs parsed from a single kind:30618 event (mirrors views). */
const MAX_REFS_PER_EVENT = 1000;

/** Symref prefix used in `HEAD` tags: `["HEAD", "ref: refs/heads/main"]`. */
const SYMREF_PREFIX = 'ref: ';

interface ParsedRefs {
  refs: Map<string, string>;
  headSymref: string | null;
  shaToTxId: Map<string, string>;
}

/** Parse a kind:30618 event's `r` / `HEAD` / `arweave` tags. */
function parseRefsEvent(event: NostrEvent): ParsedRefs {
  const refs = new Map<string, string>();
  const shaToTxId = new Map<string, string>();
  let headSymref: string | null = null;

  for (const tag of event.tags) {
    const [tagName, v1, v2] = tag;
    if (tagName === 'r' && v1 && v2) {
      if (v1 === 'HEAD' && v2.startsWith(SYMREF_PREFIX)) {
        // Alternate symref spelling: ["r", "HEAD", "ref: refs/heads/main"]
        headSymref = v2.slice(SYMREF_PREFIX.length);
        continue;
      }
      if (refs.size >= MAX_REFS_PER_EVENT) continue;
      refs.set(v1, v2);
    } else if (tagName === 'HEAD' && v1?.startsWith(SYMREF_PREFIX)) {
      // NIP-34 symref tag: ["HEAD", "ref: refs/heads/main"]
      headSymref = v1.slice(SYMREF_PREFIX.length);
    } else if (tagName === 'arweave' && v1 && v2) {
      shaToTxId.set(v1, v2);
    }
  }

  return { refs, headSymref, shaToTxId };
}

// ---------------------------------------------------------------------------
// fetchRemoteState
// ---------------------------------------------------------------------------

/**
 * Fetch the remote repository state from the relay(s).
 *
 * Sends one REQ per relay for kind:30617 + kind:30618 with
 * `authors=[ownerPubkey]`, `#d=[repoId]`, collects until EOSE (or timeout),
 * and reduces to the latest replaceable event per kind.
 *
 * Resolves as long as at least one relay answers; throws only when every
 * relay fails. Events from other authors / repos are ignored (defense
 * against misbehaving relays that over-return).
 */
export async function fetchRemoteState(
  options: FetchRemoteStateOptions
): Promise<RemoteState> {
  const {
    relayUrls,
    ownerPubkey,
    repoId,
    timeoutMs = 10000,
    resolveSha = resolveGitSha,
    webSocketFactory = defaultWebSocketFactory,
  } = options;

  if (relayUrls.length === 0) {
    throw new Error('fetchRemoteState: relayUrls must not be empty');
  }
  if (!ownerPubkey) {
    throw new Error('fetchRemoteState: ownerPubkey is required');
  }
  if (!repoId) {
    throw new Error('fetchRemoteState: repoId is required');
  }

  const filter: NostrFilter = {
    kinds: [REPOSITORY_ANNOUNCEMENT_KIND, REPOSITORY_STATE_KIND],
    authors: [ownerPubkey],
    '#d': [repoId],
  };

  const results = await Promise.allSettled(
    relayUrls.map((url) => queryRelay(url, filter, timeoutMs, webSocketFactory))
  );

  const failures: string[] = [];
  const byId = new Map<string, NostrEvent>();
  for (const result of results) {
    if (result.status === 'rejected') {
      failures.push(String((result.reason as Error)?.message ?? result.reason));
      continue;
    }
    for (const event of result.value) {
      // Only trust events from the repo owner for this repo — relays are
      // untrusted and may over-return.
      if (event.pubkey !== ownerPubkey) continue;
      if (getTagValue(event.tags, 'd') !== repoId) continue;
      if (typeof event.id === 'string' && !byId.has(event.id)) {
        byId.set(event.id, event);
      }
    }
  }

  if (failures.length === relayUrls.length) {
    throw new Error(
      `fetchRemoteState: all ${relayUrls.length} relay(s) failed: ${failures.join('; ')}`
    );
  }

  const events = [...byId.values()];
  const refsEvent = latestReplaceable(
    events.filter((e) => e.kind === REPOSITORY_STATE_KIND)
  );
  const announceEvent = latestReplaceable(
    events.filter((e) => e.kind === REPOSITORY_ANNOUNCEMENT_KIND)
  );

  const { refs, headSymref, shaToTxId } = refsEvent
    ? parseRefsEvent(refsEvent)
    : {
        refs: new Map<string, string>(),
        headSymref: null,
        shaToTxId: new Map<string, string>(),
      };

  // Seed the shared resolver cache so later resolveGitSha calls (here or in
  // any other consumer of @toon-protocol/arweave) skip GraphQL for known SHAs.
  if (shaToTxId.size > 0) {
    seedShaCache(
      [...shaToTxId].map(
        ([sha, txId]) => [shaCacheKey(sha, repoId), txId] as [string, string]
      )
    );
  }

  // Announcement metadata (mirrors views' parseRepoAnnouncement defaults).
  const name = announceEvent
    ? (getTagValue(announceEvent.tags, 'name') ?? null)
    : null;
  const description = announceEvent
    ? (getTagValue(announceEvent.tags, 'description') ?? announceEvent.content)
    : null;
  // NIP-34 announcement relays tag is multi-valued: ["relays", url1, url2, …]
  const relays: string[] = [];
  if (announceEvent) {
    for (const tag of announceEvent.tags) {
      if (tag[0] === 'relays') {
        relays.push(...tag.slice(1).filter((url) => url.length > 0));
      }
    }
  }
  // Declared maintainers (#287): the `maintainers` tag on the 30617. Owner is
  // an implicit maintainer and is NOT listed here.
  const maintainers = announceEvent
    ? parseMaintainers(announceEvent.tags)
    : [];

  const resolveMissing = async (
    shas: string[]
  ): Promise<Map<string, string>> => {
    const resolved = new Map<string, string>();
    const missing: string[] = [];
    for (const sha of new Set(shas)) {
      const known = shaToTxId.get(sha);
      if (known !== undefined) {
        resolved.set(sha, known);
      } else {
        missing.push(sha);
      }
    }
    const lookups = await Promise.all(
      missing.map(
        async (sha) => [sha, await resolveSha(sha, repoId)] as const
      )
    );
    for (const [sha, txId] of lookups) {
      if (txId) resolved.set(sha, txId);
    }
    return resolved;
  };

  return {
    announced: announceEvent !== null,
    refs,
    headSymref,
    shaToTxId,
    refsEvent,
    announceEvent,
    name,
    description,
    relays,
    maintainers,
    resolveMissing,
  };
}
