/**
 * Canonical OER length primitives (RFC-0030), ported byte-for-byte from
 * `connector_domain::oer` so the Rust and TypeScript fleets agree on the wire.
 *
 * "Canonical" is the whole point (ADR 0023): every value has exactly ONE
 * encoding, and a decoder that quietly accepts a second spelling of the same
 * value is a decoder two implementations can disagree through. So a
 * determinant is refused unless the bytes it introduces are exactly what
 * {@link encodeVarUint} would have produced:
 *
 * - `0x81 0x03` — a long form for `3`, which `0x03` already encodes — is
 *   {@link OerErrorKind.NonCanonicalLength}, not `3`.
 * - `0x80` — a zero-byte long form aliasing `0x00` — is
 *   {@link OerErrorKind.NonCanonicalLength}, not `0`.
 * - `0x89 …` — nine length bytes, which cannot fit a `u64` without silently
 *   discarding the high-order ones — is
 *   {@link OerErrorKind.LengthDeterminantOverflow}, not a truncated read.
 *
 * Values are `bigint` because the wire type is `u64` and `number` cannot hold
 * one; the caller narrows.
 *
 * Pure: no I/O, no keys, no clock.
 */

/** The three, and only three, ways a length determinant can be refused. */
export enum OerErrorKind {
  /** The buffer ends before the field it declares does. */
  BufferUnderflow = 'buffer_underflow',
  /** A determinant that is not the minimal encoding of its own value. */
  NonCanonicalLength = 'non_canonical_length',
  /** A determinant wider than eight bytes (cannot be a `u64`). */
  LengthDeterminantOverflow = 'length_determinant_overflow',
}

/** A refusal from the length primitives, carrying which of the three it is. */
export class OerError extends Error {
  constructor(readonly kind: OerErrorKind) {
    super(OER_ERROR_MESSAGES[kind]);
    this.name = 'OerError';
  }
}

const OER_ERROR_MESSAGES: Record<OerErrorKind, string> = {
  [OerErrorKind.BufferUnderflow]: 'buffer underflow: the value is truncated',
  [OerErrorKind.NonCanonicalLength]:
    'non-canonical OER length determinant: not the minimal encoding of its value',
  [OerErrorKind.LengthDeterminantOverflow]:
    'OER length determinant wider than 8 bytes',
};

const MAX_DETERMINANT_BYTES = 8;

/** Encode a VarUInt: `0..=127` as one byte, `128+` as a length-prefixed BE value. */
export function encodeVarUint(value: bigint): Uint8Array {
  if (value < 0n)
    throw new RangeError('VarUInt cannot encode a negative value');
  if (value <= 127n) return Uint8Array.of(Number(value));

  const body: number[] = [];
  let remaining = value;
  while (remaining > 0n) {
    body.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  if (body.length > MAX_DETERMINANT_BYTES) {
    throw new RangeError('VarUInt cannot encode a value wider than 8 bytes');
  }
  return Uint8Array.from([0x80 | body.length, ...body]);
}

/** A decoded field: its value, and how many bytes it consumed. */
export interface Decoded<T> {
  value: T;
  consumed: number;
}

/**
 * Decode a VarUInt at `offset`, refusing any non-canonical spelling.
 *
 * @throws {OerError} and nothing else — arbitrary bytes never produce a
 * `RangeError`, a `TypeError`, or a plausible-but-wrong value.
 */
export function decodeVarUint(
  buf: Uint8Array,
  offset: number
): Decoded<bigint> {
  const first = buf[offset];
  if (first === undefined) throw new OerError(OerErrorKind.BufferUnderflow);
  if (first <= 127) return { value: BigInt(first), consumed: 1 };

  const length = first & 0x7f;
  if (length > MAX_DETERMINANT_BYTES) {
    throw new OerError(OerErrorKind.LengthDeterminantOverflow);
  }
  const start = offset + 1;
  const end = start + length;
  if (end > buf.length) throw new OerError(OerErrorKind.BufferUnderflow);

  let value = 0n;
  for (let i = start; i < end; i++) {
    value = (value << 8n) | BigInt(buf[i] as number);
  }
  const consumed = 1 + length;

  // The canonicality test, exactly as `connector_domain::oer` states it:
  // re-encode and demand the same bytes back. This is what rejects the
  // non-minimal long form and the zero-length alias in one check.
  const canonical = encodeVarUint(value);
  if (
    canonical.length !== consumed ||
    !canonical.every((byte, i) => byte === buf[offset + i])
  ) {
    throw new OerError(OerErrorKind.NonCanonicalLength);
  }
  return { value, consumed };
}

/** Encode a VarOctetString: a VarUInt length prefix followed by the bytes. */
export function encodeVarOctetString(data: Uint8Array): Uint8Array {
  const prefix = encodeVarUint(BigInt(data.length));
  const out = new Uint8Array(prefix.length + data.length);
  out.set(prefix, 0);
  out.set(data, prefix.length);
  return out;
}

/**
 * Decode a VarOctetString at `offset`.
 *
 * @throws {OerError} and nothing else.
 */
export function decodeVarOctetString(
  buf: Uint8Array,
  offset: number
): Decoded<Uint8Array> {
  const { value: length, consumed: lengthBytes } = decodeVarUint(buf, offset);

  // A declared length larger than the whole buffer is underflow, checked in
  // `bigint` BEFORE any `Number` conversion so a `u64`-scale length can never
  // wrap into a plausible small one.
  if (length > BigInt(buf.length)) {
    throw new OerError(OerErrorKind.BufferUnderflow);
  }
  const start = offset + lengthBytes;
  const end = start + Number(length);
  if (end > buf.length) throw new OerError(OerErrorKind.BufferUnderflow);

  // A copy, not a view: a decoded body that aliases the input buffer would
  // change under a caller who reuses that buffer.
  return {
    value: buf.slice(start, end),
    consumed: lengthBytes + Number(length),
  };
}
