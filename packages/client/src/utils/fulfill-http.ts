/**
 * Shared parser for the HTTP-over-ILP response carried in an ILP **FULFILL**
 * packet's `data` field.
 *
 * The deployed connector is a payment-proxy (HTTP-in-ILP): a paid write/upload
 * is reverse-proxied to the relay/DVM origin and the origin's reply is returned
 * **verbatim as a full HTTP/1.1 response message** inside the FULFILL `data`:
 *
 *   HTTP/1.1 200 OK\r\n
 *   content-length: 189\r\n
 *   \r\n
 *   {"accept":true,"txId":"4QcRav...","data":"<base64-txid>",...}
 *
 * Callers (`ToonClient.publishEvent`, `requestBlobStorage`) previously treated
 * this `data` as opaque success bytes — `publishEvent` reported success on ANY
 * FULFILL even when the embedded HTTP status was `404 Not Found`, and
 * `requestBlobStorage` base64-decoded the WHOLE response as if it were the bare
 * Arweave tx id. This module makes the HTTP envelope first-class so both paths
 * can read the real status and body.
 *
 * The full Web-`Response` reconstruction used by the h402 fetch path lives in
 * `adapters/Http402Client.ts` (`parseHttpResponse`); this is a smaller,
 * dependency-free helper that returns the status code + raw body string, which
 * is all the publish/upload paths need.
 *
 * DEFENSIVE: not every FULFILL is HTTP-enveloped (e.g. Mill-swap raw-TOON
 * FULFILLs go through `sendSwapPacket`, not these paths). If the decoded data
 * does not begin with an `HTTP/<v>` status line, `isHttp` is `false` and the
 * caller should fall back to its prior (non-HTTP) interpretation rather than
 * fail. This keeps non-HTTP FULFILLs from regressing.
 */

import { fromBase64, decodeUtf8 } from './binary.js';

const CRLF = '\r\n';

/** Result of parsing FULFILL `data` as an HTTP/1.1 response. */
export interface ParsedFulfillHttp {
  /** Whether the data looked like an HTTP/1.1 response (status line present). */
  isHttp: boolean;
  /** HTTP status code (e.g. 200, 404). Only meaningful when `isHttp` is true. */
  status: number;
  /** Reason phrase from the status line (may be empty). */
  statusText: string;
  /** Decoded response body as a UTF-8 string (empty when none). */
  body: string;
}

/** Find the index just past the first `\r\n\r\n` (header/body boundary). */
function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return i + 4;
    }
  }
  return -1;
}

/**
 * Parse FULFILL `data` bytes as an HTTP/1.1 response.
 *
 * Returns `{ isHttp: false, ... }` (without throwing) when the payload does not
 * start with an `HTTP/<v>` status line, so callers can fall back to their
 * legacy non-HTTP interpretation. When it IS an HTTP response, the status code
 * and body are extracted; a present-but-malformed status line yields
 * `isHttp: false` as well (treated as non-HTTP rather than throwing).
 */
export function parseFulfillHttpBytes(bytes: Uint8Array): ParsedFulfillHttp {
  const notHttp: ParsedFulfillHttp = {
    isHttp: false,
    status: 0,
    statusText: '',
    body: '',
  };

  const headerEnd = findHeaderEnd(bytes);
  const headBytes = headerEnd === -1 ? bytes : bytes.subarray(0, headerEnd - 2);
  const bodyBytes =
    headerEnd === -1 ? new Uint8Array(0) : bytes.subarray(headerEnd);

  const headText = decodeUtf8(headBytes);
  const lines = headText.split(CRLF).filter((l) => l.length > 0);
  const statusLine = lines.shift();
  if (!statusLine) return notHttp;

  // Cheap guard before the regex: must look like an HTTP status line.
  if (!statusLine.trimStart().startsWith('HTTP/')) return notHttp;

  // `HTTP/1.1 200 OK` — tolerate a missing reason phrase.
  const match = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine.trim());
  if (!match) return notHttp;

  return {
    isHttp: true,
    status: parseInt(match[1] as string, 10),
    statusText: match[2] ?? '',
    body: decodeUtf8(bodyBytes),
  };
}

/**
 * Convenience wrapper: decode a base64 FULFILL `data` string (the shape carried
 * on `IlpSendResult.data`) and parse it as an HTTP/1.1 response.
 */
export function parseFulfillHttp(base64Data: string): ParsedFulfillHttp {
  return parseFulfillHttpBytes(fromBase64(base64Data));
}
