/**
 * The structured envelope (ADR 0018): what a packet carries between a
 * connector and the app behind it, encoded with the same OER primitives an ILP
 * packet already uses rather than as HTTP text.
 *
 * A faithful port of `connector_domain::envelope`
 * (`crates/connector-domain/src/envelope.rs`) — a method, target, ordered
 * headers and body going in; a two-byte big-endian status, headers and body
 * coming back. `vectors/wire-vectors.json` is the contract this is checked
 * against, and `wire-vectors.test.ts` is where that check happens; the prose
 * here describes the same thing but the bytes decide.
 *
 * ─── Why not HTTP text ─────────────────────────────────────────────────────
 * `utils/store-envelope.ts` builds latin1 HTTP/1.1 request text and
 * `utils/fulfill-http.ts` hand-parses a status line and scans for `\r\n\r\n`,
 * which is how they acquired leniencies nobody chose: a missing header/body
 * separator yielding an empty body, blank header lines skipped, spaces
 * tolerated inside the target. A structured encoding has exactly one
 * representation per message and nothing to smuggle. This module lands BESIDE
 * those two rather than replacing them — the swap is a later child — so it can
 * be reviewed against the vectors in isolation.
 *
 * ─── Headers are a list, not a map ─────────────────────────────────────────
 * A count prefix then `(name, value)` pairs in order. Both header ORDER and
 * DUPLICATE NAMES are meaningful on this wire and both survive a round trip; a
 * `Record<string, string>` would silently destroy each.
 *
 * Pure: no keys, no I/O, no clock. `@noble/*` is not involved.
 */

import {
  OerError,
  OerErrorKind,
  decodeVarOctetString,
  decodeVarUint,
  encodeVarOctetString,
  encodeVarUint,
} from './oer.js';

const TYPE_ENVELOPE_REQUEST = 1;
const TYPE_ENVELOPE_RESPONSE = 2;

/**
 * Every distinguishable way an envelope can fail to decode. These strings are
 * the vector file's `expected_error` values verbatim — the same names
 * `EnvelopeError` uses in `connector-domain` — so a replay compares reasons,
 * not just "it threw".
 *
 * There is deliberately no catch-all: a decoder with an `Invalid` bucket is a
 * decoder that can be lenient without anyone noticing.
 */
export enum EnvelopeErrorKind {
  /** The buffer ends before the envelope does. */
  BufferUnderflow = 'buffer_underflow',
  /** A length determinant that is not the minimal encoding of its value. */
  NonCanonicalLength = 'non_canonical_length',
  /** A length determinant wider than eight bytes. */
  LengthDeterminantOverflow = 'length_determinant_overflow',
  /** The type byte is not the one the requested direction requires. */
  InvalidType = 'invalid_type',
  /** A field that must be UTF-8 is not. */
  InvalidUtf8 = 'invalid_utf8',
  /** Bytes remain after a fully decoded envelope. */
  TrailingBytes = 'trailing_bytes',
}

/**
 * A refusal to decode. `kind` is the machine-readable reason; `field` names
 * the offending field for {@link EnvelopeErrorKind.InvalidUtf8}, matching
 * `EnvelopeError::InvalidUtf8(&'static str)` on the Rust side.
 */
export class EnvelopeError extends Error {
  constructor(
    readonly kind: EnvelopeErrorKind,
    readonly field?: string
  ) {
    super(
      field === undefined
        ? ENVELOPE_ERROR_MESSAGES[kind]
        : `${ENVELOPE_ERROR_MESSAGES[kind]} (field '${field}')`
    );
    this.name = 'EnvelopeError';
  }
}

const ENVELOPE_ERROR_MESSAGES: Record<EnvelopeErrorKind, string> = {
  [EnvelopeErrorKind.BufferUnderflow]:
    'buffer underflow: envelope is truncated',
  [EnvelopeErrorKind.NonCanonicalLength]:
    'non-canonical OER length determinant: not the minimal encoding of its value',
  [EnvelopeErrorKind.LengthDeterminantOverflow]:
    'OER length determinant wider than 8 bytes',
  [EnvelopeErrorKind.InvalidType]:
    'invalid envelope type byte: expected 1 (REQUEST) or 2 (RESPONSE)',
  [EnvelopeErrorKind.InvalidUtf8]: 'invalid UTF-8 in envelope field',
  [EnvelopeErrorKind.TrailingBytes]:
    'trailing bytes after a fully decoded envelope',
};

/** One `(name, value)` header, in wire order. Duplicates are legal. */
export type EnvelopeHeader = readonly [name: string, value: string];

/** The request a connector is to make of the app behind a terminated route. */
export interface EnvelopeRequest {
  method: string;
  target: string;
  headers: readonly EnvelopeHeader[];
  body: Uint8Array;
}

/** The app's response back to the connector. */
export interface EnvelopeResponse {
  /** HTTP status, two bytes big-endian on the wire (`0..=65535`). */
  status: number;
  headers: readonly EnvelopeHeader[];
  body: Uint8Array;
}

/** Either direction, tagged — the shape the vector file's `decoded` carries. */
export type Envelope =
  | ({ direction: 'request' } & EnvelopeRequest)
  | ({ direction: 'response' } & EnvelopeResponse);

// ─── Shared helpers ─────────────────────────────────────────────────────────

const UTF8_ENCODER = new TextEncoder();
/** `fatal` is load-bearing: a lenient decoder would turn bad bytes into U+FFFD. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Map an {@link OerError} onto its envelope-level counterpart, 1:1. */
function fromOerError(error: unknown): EnvelopeError {
  if (error instanceof OerError) {
    switch (error.kind) {
      case OerErrorKind.BufferUnderflow:
        return new EnvelopeError(EnvelopeErrorKind.BufferUnderflow);
      case OerErrorKind.NonCanonicalLength:
        return new EnvelopeError(EnvelopeErrorKind.NonCanonicalLength);
      case OerErrorKind.LengthDeterminantOverflow:
        return new EnvelopeError(EnvelopeErrorKind.LengthDeterminantOverflow);
    }
  }
  throw error;
}

function decodeOctets(
  buf: Uint8Array,
  offset: number
): { value: Uint8Array; consumed: number } {
  try {
    return decodeVarOctetString(buf, offset);
  } catch (error) {
    throw fromOerError(error);
  }
}

function decodeCount(
  buf: Uint8Array,
  offset: number
): {
  value: bigint;
  consumed: number;
} {
  try {
    return decodeVarUint(buf, offset);
  } catch (error) {
    throw fromOerError(error);
  }
}

/** Decode a VarOctetString and validate it as UTF-8 in one step. */
function decodeStringField(
  buf: Uint8Array,
  offset: number,
  field: string
): { value: string; consumed: number } {
  const { value: bytes, consumed } = decodeOctets(buf, offset);
  try {
    return { value: UTF8_DECODER.decode(bytes), consumed };
  } catch {
    throw new EnvelopeError(EnvelopeErrorKind.InvalidUtf8, field);
  }
}

function checkTypeByte(buf: Uint8Array, expected: number): number {
  const typeByte = buf[0];
  if (typeByte === undefined) {
    throw new EnvelopeError(EnvelopeErrorKind.BufferUnderflow);
  }
  if (typeByte !== expected) {
    throw new EnvelopeError(EnvelopeErrorKind.InvalidType);
  }
  return 1;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeHeaders(headers: readonly EnvelopeHeader[]): Uint8Array {
  const parts: Uint8Array[] = [encodeVarUint(BigInt(headers.length))];
  for (const [name, value] of headers) {
    parts.push(encodeVarOctetString(UTF8_ENCODER.encode(name)));
    parts.push(encodeVarOctetString(UTF8_ENCODER.encode(value)));
  }
  return concat(parts);
}

function decodeHeaders(
  buf: Uint8Array,
  offset: number
): { value: EnvelopeHeader[]; consumed: number } {
  const { value: count, consumed: countBytes } = decodeCount(buf, offset);

  // Every header costs at least two bytes, so a count exceeding what remains
  // cannot be honoured. Checked in `bigint`, before any loop, so a `u64`-scale
  // count is refused as underflow instead of spinning.
  if (count * 2n > BigInt(buf.length - offset - countBytes)) {
    throw new EnvelopeError(EnvelopeErrorKind.BufferUnderflow);
  }

  let consumed = countBytes;
  const headers: EnvelopeHeader[] = [];
  for (let i = 0n; i < count; i++) {
    const name = decodeStringField(buf, offset + consumed, 'header name');
    consumed += name.consumed;
    const value = decodeStringField(buf, offset + consumed, 'header value');
    consumed += value.consumed;
    headers.push([name.value, value.value]);
  }
  return { value: headers, consumed };
}

// ─── Request ────────────────────────────────────────────────────────────────

/** Encode a request envelope. The inverse of {@link decodeEnvelopeRequest}. */
export function encodeEnvelopeRequest(request: EnvelopeRequest): Uint8Array {
  return concat([
    Uint8Array.of(TYPE_ENVELOPE_REQUEST),
    encodeVarOctetString(UTF8_ENCODER.encode(request.method)),
    encodeVarOctetString(UTF8_ENCODER.encode(request.target)),
    encodeHeaders(request.headers),
    encodeVarOctetString(request.body),
  ]);
}

/**
 * Decode a request envelope, consuming the WHOLE buffer.
 *
 * @throws {EnvelopeError} and nothing else, for any input whatsoever.
 */
export function decodeEnvelopeRequest(buf: Uint8Array): EnvelopeRequest {
  let offset = checkTypeByte(buf, TYPE_ENVELOPE_REQUEST);

  const method = decodeStringField(buf, offset, 'method');
  offset += method.consumed;

  const target = decodeStringField(buf, offset, 'target');
  offset += target.consumed;

  const headers = decodeHeaders(buf, offset);
  offset += headers.consumed;

  const body = decodeOctets(buf, offset);
  offset += body.consumed;

  if (offset !== buf.length) {
    throw new EnvelopeError(EnvelopeErrorKind.TrailingBytes);
  }
  return {
    method: method.value,
    target: target.value,
    headers: headers.value,
    body: body.value,
  };
}

// ─── Response ───────────────────────────────────────────────────────────────

/** Encode a response envelope. The inverse of {@link decodeEnvelopeResponse}. */
export function encodeEnvelopeResponse(response: EnvelopeResponse): Uint8Array {
  if (
    !Number.isInteger(response.status) ||
    response.status < 0 ||
    response.status > 0xffff
  ) {
    throw new RangeError(
      `envelope status must fit two bytes, got ${response.status}`
    );
  }
  return concat([
    Uint8Array.of(
      TYPE_ENVELOPE_RESPONSE,
      (response.status >> 8) & 0xff,
      response.status & 0xff
    ),
    encodeHeaders(response.headers),
    encodeVarOctetString(response.body),
  ]);
}

/**
 * Decode a response envelope, consuming the WHOLE buffer.
 *
 * @throws {EnvelopeError} and nothing else, for any input whatsoever.
 */
export function decodeEnvelopeResponse(buf: Uint8Array): EnvelopeResponse {
  let offset = checkTypeByte(buf, TYPE_ENVELOPE_RESPONSE);

  const high = buf[offset];
  const low = buf[offset + 1];
  if (high === undefined || low === undefined) {
    throw new EnvelopeError(EnvelopeErrorKind.BufferUnderflow);
  }
  const status = (high << 8) | low;
  offset += 2;

  const headers = decodeHeaders(buf, offset);
  offset += headers.consumed;

  const body = decodeOctets(buf, offset);
  offset += body.consumed;

  if (offset !== buf.length) {
    throw new EnvelopeError(EnvelopeErrorKind.TrailingBytes);
  }
  return { status, headers: headers.value, body: body.value };
}

// ─── Direction-tagged façade ────────────────────────────────────────────────

/** Encode either direction from its tagged form. */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
  return envelope.direction === 'request'
    ? encodeEnvelopeRequest(envelope)
    : encodeEnvelopeResponse(envelope);
}

/**
 * Decode as the named direction. The direction is an INPUT, never guessed from
 * the type byte: a caller that asked for a request and got a response has been
 * handed the wrong bytes, and `invalid_type` is the honest answer.
 */
export function decodeEnvelope(
  buf: Uint8Array,
  direction: 'request' | 'response'
): Envelope {
  return direction === 'request'
    ? { direction, ...decodeEnvelopeRequest(buf) }
    : { direction, ...decodeEnvelopeResponse(buf) };
}
