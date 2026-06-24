/**
 * Store-write HTTP envelope for the payment-proxy (HTTP-in-ILP) path.
 *
 * The deployed connector is a payment-proxy: it terminates a paid write by
 * decoding the ILP PREPARE `data` as a literal RFC 7230 HTTP/1.1 request and
 * reverse-proxying it to the relay store's `POST /write` (see the connector's
 * `HttpProxyHandler.decodeHttpRequest`). The ILP `data` MUST therefore be a
 * full HTTP request envelope:
 *
 *   POST /write HTTP/1.1\r\n
 *   Host: relay\r\n
 *   Content-Type: application/json\r\n
 *   \r\n
 *   {"event": <signed nostr event object>}
 *
 * Sending the bare TOON-encoded event (no request-line) makes the proxy reject
 * with `F01 - Invalid HTTP envelope: malformed request-line`. The relay's
 * `/write` handler parses the body as JSON and reads `body.event` as a full
 * signed Nostr event OBJECT (it runs `verifyEvent(event)` + `store(event)`), so
 * the body carries the event object verbatim — NOT the TOON string.
 *
 * This helper is the single source of truth for that envelope so the proxy
 * paid-write path (`ToonClient.publishEvent`) and any future caller stay
 * byte-compatible with the deployed store. It is isomorphic (Node + browser):
 * `JSON.stringify` escapes non-ASCII to `\uXXXX`, so the serialized envelope is
 * pure ASCII and `encodeUtf8` matches the bytes the store expects.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { encodeUtf8 } from './binary.js';

/** Request-line + headers the deployed store accepts (proven against devnet). */
const REQUEST_LINE = 'POST /write HTTP/1.1';
const HEADERS = ['Host: relay', 'Content-Type: application/json'];

/**
 * Wrap a signed Nostr event in the `POST /write` HTTP envelope the deployed
 * payment-proxy reverse-proxies to the relay store.
 *
 * @param event - A finalized (signed) Nostr event — passed through to the store
 *   as the JSON `event` field verbatim (the store re-verifies the signature).
 * @returns The envelope bytes to use as the ILP PREPARE `data`.
 */
export function buildStoreWriteEnvelope(event: NostrEvent): Uint8Array {
  const body = JSON.stringify({ event });
  const head = [REQUEST_LINE, ...HEADERS].join('\r\n');
  return encodeUtf8(head + '\r\n\r\n' + body);
}
