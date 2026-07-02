/**
 * Minimal WebSocket relay client for the browser.
 *
 * Connects to a TOON relay, sends Nostr REQ subscriptions, and handles
 * EVENT/EOSE messages. Decodes TOON format responses.
 *
 * Does NOT use nostr-tools SimplePool (known broken in some environments).
 */

import { decode } from '@toon-format/toon';
import type { NostrEvent, NostrFilter } from './nip34-parsers.js';
import { isValidRelayUrl } from './url-utils.js';

/**
 * Build a Nostr filter for querying repository announcement events (kind:30617).
 */
export function buildRepoListFilter(): NostrFilter {
  return { kinds: [30617] };
}

/**
 * Build a Nostr filter for querying profile events (kind:0) by pubkeys.
 */
export function buildProfileFilter(pubkeys: string[]): NostrFilter {
  return { kinds: [0], authors: pubkeys };
}

/**
 * Build a Nostr filter for querying repository refs events (kind:30618).
 *
 * @param pubkey - Repository owner's pubkey (hex)
 * @param repoId - Repository identifier (d tag value from kind:30617)
 * @returns Nostr filter for kind:30618 events
 */
export function buildRepoRefsFilter(
  pubkey: string,
  repoId: string
): NostrFilter {
  return { kinds: [30618], authors: [pubkey], '#d': [repoId] };
}

/**
 * Build a Nostr filter for querying issue events (kind:1621) for a repository.
 */
export function buildIssueListFilter(
  ownerPubkey: string,
  repoId: string
): NostrFilter {
  return {
    kinds: [1621],
    '#a': [`30617:${ownerPubkey}:${repoId}`],
    limit: 100,
  };
}

/**
 * Build a Nostr filter for querying comment events (kind:1622) by parent event IDs.
 */
export function buildCommentFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1622], '#e': eventIds, limit: 500 };
}

/**
 * Build a Nostr filter for querying PR/patch events (kind:1617) for a repository.
 */
export function buildPRListFilter(
  ownerPubkey: string,
  repoId: string
): NostrFilter {
  return {
    kinds: [1617],
    '#a': [`30617:${ownerPubkey}:${repoId}`],
    limit: 100,
  };
}

/**
 * Build a Nostr filter for querying PR status events (kind:1630-1633) by PR event IDs.
 */
export function buildStatusFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1630, 1631, 1632, 1633], '#e': eventIds, limit: 500 };
}

/**
 * Build a Nostr filter for fetching specific events by their IDs.
 */
export function buildEventByIdFilter(eventIds: string[]): NostrFilter {
  return { ids: eventIds };
}

/**
 * Build a Nostr filter for querying issue close events (kind:1632) by issue event IDs.
 */
export function buildIssueCloseFilter(eventIds: string[]): NostrFilter {
  return { kinds: [1632], '#e': eventIds, limit: 500 };
}

/**
 * An EVENT frame whose payload could not be decoded into a NostrEvent.
 *
 * Instead of silently dropping such frames, the relay client surfaces them
 * so views can render a degraded row (id + raw payload) — an event must
 * NEVER vanish without a trace just because its serialization broke a parser.
 */
export interface UnparseableEvent {
  /** Event id salvaged from the raw payload, if recognizable */
  id: string | null;
  /** The raw wire payload as received from the relay */
  raw: string;
  /** The decode error message */
  error: string;
}

/**
 * Best-effort extraction of the 64-hex event id from a raw EVENT payload
 * (TOON `id: <hex>` line or JSON `"id":"<hex>"`).
 */
export function salvageEventId(raw: string): string | null {
  const toonId = /^id:\s*"?([0-9a-f]{64})"?\s*$/im.exec(raw)?.[1];
  if (toonId) return toonId.toLowerCase();
  const jsonId = /"id"\s*:\s*"([0-9a-f]{64})"/i.exec(raw)?.[1];
  return jsonId ? jsonId.toLowerCase() : null;
}

/**
 * Decode a single TOON scalar value (the part after `key: ` on one line).
 * Quoted values use JSON string syntax; bare values are numbers or strings.
 */
function decodeToonScalar(rawValue: string): string | number {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      // Non-canonical quoting — strip outer quotes and unescape best-effort
      const inner = trimmed.replace(/^"/, '').replace(/"$/, '');
      return inner.replace(/\\(["\\/bfnrt])/g, (_m, c: string) => {
        const map: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        return map[c] ?? c;
      });
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Split a TOON inline-array row (`a,"b,c",d`) into items, honoring quoted
 * strings (JSON escape rules) so commas/quotes inside values don't split.
 */
function splitToonRow(row: string): string[] {
  const rawItems: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row.charAt(i);
    if (inQuote) {
      if (ch === '\\' && i + 1 < row.length) {
        current += ch + row.charAt(i + 1);
        i++;
      } else {
        if (ch === '"') inQuote = false;
        current += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
      current += ch;
    } else if (ch === ',') {
      rawItems.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  rawItems.push(current);
  return rawItems.map((item) => String(decodeToonScalar(item)));
}

/**
 * Tolerant line-based decoder for the fixed NostrEvent wire shape.
 *
 * The upstream `@toon-format/toon` decoder rejects quoted scalars whose
 * CONTENT happens to contain text matching its inline-array-header syntax
 * (e.g. an issue body mentioning `process.argv[2]` plus a later colon —
 * "Expected 2 inline array items" / "Unterminated string"), even on
 * byte-identical output of its own encoder. Since relay EVENT payloads are
 * always flat NostrEvents, this fallback parses that one shape directly:
 * scalar `key: value` lines plus one `tags[N]:` block of `- [k]: a,b` rows.
 *
 * @throws if the result does not look like a NostrEvent
 */
export function decodeEventFallback(toonData: string): NostrEvent {
  const out: Record<string, unknown> = {};
  const tags: string[][] = [];
  let inTags = false;

  for (const line of toonData.split('\n')) {
    if (/^tags\[\d+\]:\s*$/.test(line)) {
      inTags = true;
      continue;
    }
    if (inTags) {
      const row = /^\s+-\s+\[\d+\]:\s?(.*)$/.exec(line)?.[1];
      if (row !== undefined) {
        tags.push(splitToonRow(row));
        continue;
      }
      if (/^\s/.test(line)) continue; // unrecognized indented line inside tags
      inTags = false; // top-level line ends the tags block — fall through
    }
    const kv = /^(\w+):\s?(.*)$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      out[kv[1]] = decodeToonScalar(kv[2]);
    }
  }

  out.tags = tags;
  if (
    typeof out.id !== 'string' ||
    typeof out.pubkey !== 'string' ||
    typeof out.kind !== 'number' ||
    typeof out.created_at !== 'number'
  ) {
    throw new Error('Tolerant fallback: payload is not a NostrEvent shape');
  }
  if (typeof out.content !== 'string') out.content = String(out.content ?? '');
  if (typeof out.sig !== 'string') out.sig = String(out.sig ?? '');
  return out as unknown as NostrEvent;
}

/** Structural check that a decoded value is a usable NostrEvent. */
function isNostrEventShape(value: unknown): value is NostrEvent {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.pubkey === 'string' &&
    typeof v.kind === 'number' &&
    typeof v.created_at === 'number' &&
    Array.isArray(v.tags)
  );
}

/**
 * Decode a TOON-encoded event string into a NostrEvent.
 *
 * The relay sends EVENT messages as ["EVENT", subId, toonString] where the
 * event payload is TOON-encoded rather than standard JSON. Also accepts
 * canonical NIP-01 JSON, and falls back to a tolerant NostrEvent-shaped
 * parser when the TOON decoder rejects content it cannot round-trip
 * (see {@link decodeEventFallback}).
 *
 * @param toonData - TOON-encoded string, JSON string, or already-decoded object
 * @returns Decoded NostrEvent
 * @throws if no decoding strategy yields a NostrEvent-shaped value
 */
export function decodeToonMessage(toonData: string | NostrEvent): NostrEvent {
  if (typeof toonData === 'object') {
    // Already decoded (e.g., in tests or non-TOON relay)
    return toonData;
  }
  if (toonData.trimStart().startsWith('{')) {
    // Canonical NIP-01 JSON serialization
    try {
      const parsed = JSON.parse(toonData) as unknown;
      if (isNostrEventShape(parsed)) return parsed;
    } catch {
      // Not valid JSON after all — try TOON below
    }
  }
  let toonError: unknown = null;
  try {
    const decoded = decode(toonData) as unknown;
    if (isNostrEventShape(decoded)) return decoded;
    toonError = new Error('TOON decode result is not a NostrEvent shape');
  } catch (err) {
    toonError = err;
  }
  // decodeEventFallback throws if the payload is unrecoverable — the caller
  // is responsible for surfacing that (never silently dropping the event).
  const event = decodeEventFallback(toonData);
  console.warn(
    '[rig-web] TOON decode failed; event recovered via tolerant fallback:',
    toonError instanceof Error ? toonError.message : toonError
  );
  return event;
}

/**
 * Query a relay via WebSocket and collect events matching a filter.
 *
 * Sends a REQ subscription, collects EVENT messages until EOSE, then
 * closes the subscription and resolves.
 *
 * @param relayUrl - WebSocket URL of the relay
 * @param filter - Nostr filter to subscribe with
 * @param timeoutMs - Timeout in milliseconds (default 10000)
 * @param onUnparseable - Called for each EVENT frame whose payload fails to
 *   decode (after all fallbacks). Such frames are never silently dropped:
 *   they are reported here and logged via console.warn.
 * @returns Array of decoded NostrEvents
 */
export function queryRelay(
  relayUrl: string,
  filter: NostrFilter,
  timeoutMs = 10000,
  onUnparseable?: (unparseable: UnparseableEvent) => void
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const subId = `rig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let ws: WebSocket;
    // eslint-disable-next-line prefer-const -- reassigned in setTimeout below
    let timeoutHandle: ReturnType<typeof setTimeout>;
    let settled = false;

    const settle = (
      outcome: 'resolve' | 'reject',
      value?: NostrEvent[] | Error
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
        }
      } catch {
        // Ignore close errors
      }
      if (outcome === 'reject') {
        reject(value as Error);
      } else {
        resolve((value as NostrEvent[] | undefined) ?? events);
      }
    };

    // Validate relay URL protocol to prevent SSRF / protocol confusion
    if (!isValidRelayUrl(relayUrl)) {
      reject(
        new Error(
          // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
          `Invalid relay URL protocol (must be ws:// or wss://): ${relayUrl}`
        )
      );
      return;
    }

    try {
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      ws = new WebSocket(relayUrl);
    } catch (err) {
      reject(new Error(`Failed to connect to relay: ${String(err)}`));
      return;
    }

    timeoutHandle = setTimeout(() => {
      // Resolve with whatever we collected so far (partial results)
      settle('resolve', events);
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (msgEvent: MessageEvent) => {
      try {
        const msg = JSON.parse(String(msgEvent.data)) as unknown[];
        if (!Array.isArray(msg) || msg.length < 2) return;

        const msgType = msg[0];

        if (msgType === 'EVENT' && msg[1] === subId && msg[2] !== undefined) {
          const payload = msg[2] as string | NostrEvent;
          try {
            events.push(decodeToonMessage(payload));
          } catch (decodeErr) {
            // NEVER drop an event silently: report it as unparseable so the
            // UI can render a degraded row instead of nothing.
            const raw =
              typeof payload === 'string' ? payload : JSON.stringify(payload);
            const message =
              decodeErr instanceof Error
                ? decodeErr.message
                : String(decodeErr);
            console.warn(
              '[rig-web] relay EVENT payload failed to decode; surfacing as unparseable:',
              message,
              raw
            );
            onUnparseable?.({ id: salvageEventId(raw), raw, error: message });
          }
        } else if (msgType === 'EOSE' && msg[1] === subId) {
          settle('resolve', events);
        }
      } catch {
        // Ignore frames that are not valid relay messages at all
      }
    };

    ws.onerror = (event: Event) => {
      const detail =
        'message' in event ? String((event as ErrorEvent).message) : 'unknown';
      settle(
        'reject',
        new Error(`WebSocket error connecting to ${relayUrl}: ${detail}`)
      );
    };

    ws.onclose = () => {
      // If we haven't settled yet, resolve with what we have
      settle('resolve', events);
    };
  });
}
