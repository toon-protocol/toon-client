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
 * Decode a TOON-encoded event string into a NostrEvent.
 *
 * The relay sends EVENT messages as ["EVENT", subId, toonString] where the
 * event payload is TOON-encoded rather than standard JSON.
 *
 * @param toonData - TOON-encoded string or already-decoded object
 * @returns Decoded NostrEvent
 */
export function decodeToonMessage(toonData: string | NostrEvent): NostrEvent {
  if (typeof toonData === 'object') {
    // Already decoded (e.g., in tests or non-TOON relay)
    return toonData;
  }
  return decode(toonData) as unknown as NostrEvent;
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
 * @returns Array of decoded NostrEvents
 */
export function queryRelay(
  relayUrl: string,
  filter: NostrFilter,
  timeoutMs = 10000
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
          const event = decodeToonMessage(msg[2] as string | NostrEvent);
          events.push(event);
        } else if (msgType === 'EOSE' && msg[1] === subId) {
          settle('resolve', events);
        }
      } catch {
        // Ignore parse errors for individual messages
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
