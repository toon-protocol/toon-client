/**
 * The vector-replay harness — the acceptance test for `envelope.ts`.
 *
 * The committed vector file is the contract (connector ADR 0021), not the prose
 * describing it and not this file's own opinions. Everything below is
 * data-driven off `vectors/wire-vectors.json`: no expectation is written out by
 * hand, so a vector the file gains is a test this suite gains, and a vector it
 * loses cannot leave a silently-passing assertion behind.
 *
 * Structure to preserve when `giftwrap` (toon-client#449) and `fulfilment`
 * arrive: one top-level `describe` per section, each driven by `it.each` over
 * `loadWireVectors()`. Adding a section is a new block, not a restructure.
 */

import { describe, it, expect } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  loadWireVectors,
  loadWireVectorsProvenance,
  wireVectorsSha256,
  type EnvelopeInvalidVector,
  type EnvelopeValidVector,
} from './vectors/load.js';
import {
  EnvelopeError,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
} from './envelope.js';

const vectors = loadWireVectors();
const provenance = loadWireVectorsProvenance();

describe('the vendored vector file', () => {
  it('has not been edited since it was vendored', () => {
    // The one thing vendoring costs is that the copy can be "fixed" to make a
    // failing replay pass. It cannot: the hash is recorded in the provenance
    // file, and changing both is a reviewable act rather than a silent one.
    // Drift against the connector's CURRENT main is a separate check —
    // `pnpm vectors:check`, run daily by wire-vectors-drift.yml.
    expect(wireVectorsSha256()).toBe(provenance.sha256);
  });

  it('is the schema version this harness understands', () => {
    expect(vectors.schema_version).toBe(provenance.schemaVersion);
    expect(vectors.schema_version).toBe(1);
  });

  it('records which connector commit it came from', () => {
    expect(provenance.connectorCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.sourceRepo).toBe('toon-protocol/connector');
  });

  it('carries the sections the later children will replay', () => {
    // Not replayed here — asserted present so that a connector-side removal
    // surfaces in this child rather than blocking #449 later.
    expect(vectors.giftwrap).toBeDefined();
    expect(vectors.fulfilment).toBeDefined();
  });
});

// ─── envelope ───────────────────────────────────────────────────────────────

/** Rebuild the codec's own `Envelope` from a vector's `decoded` object. */
function envelopeFromVector(vector: EnvelopeValidVector): Envelope {
  const decoded = vector.decoded;
  const headers = decoded.headers.map(
    ([name, value]) => [name, value] as const
  );
  const body = hexToBytes(decoded.body_hex);
  return decoded.direction === 'request'
    ? {
        direction: 'request',
        method: decoded.method,
        target: decoded.target,
        headers,
        body,
      }
    : {
        direction: 'response',
        status: decoded.status,
        headers,
        body,
      };
}

describe('envelope.valid — every vector round-trips in both directions', () => {
  const valid = vectors.envelope.valid;

  it('replays all five vectors the connector publishes', () => {
    expect(valid).toHaveLength(5);
  });

  it.each(valid.map((v) => [v.name, v] as const))(
    'decodes %s to exactly the published `decoded`',
    (_name, vector) => {
      const bytes = hexToBytes(vector.encoded_hex);
      const decoded = decodeEnvelope(bytes, vector.decoded.direction);
      expect(decoded).toEqual(envelopeFromVector(vector));
    }
  );

  it.each(valid.map((v) => [v.name, v] as const))(
    're-encodes %s to exactly the published `encoded_hex`',
    (_name, vector) => {
      const encoded = encodeEnvelope(envelopeFromVector(vector));
      expect(bytesToHex(encoded)).toBe(vector.encoded_hex);
    }
  );

  it.each(valid.map((v) => [v.name, v] as const))(
    'round-trips %s through decode → encode without drift',
    (_name, vector) => {
      const bytes = hexToBytes(vector.encoded_hex);
      const decoded = decodeEnvelope(bytes, vector.decoded.direction);
      expect(bytesToHex(encodeEnvelope(decoded))).toBe(vector.encoded_hex);
    }
  );

  it('preserves header order and duplicate names, because both are meaningful', () => {
    // The two vectors that exist precisely to prove this. Asserted explicitly
    // as well as via the round trips: a codec that sorted or de-duplicated
    // headers would still round-trip its OWN output, and only fail here.
    const duplicates = valid.filter((v) =>
      v.decoded.headers.some(
        ([name], i, all) => all.findIndex(([n]) => n === name) !== i
      )
    );
    expect(duplicates.length).toBeGreaterThan(0);

    for (const vector of duplicates) {
      const decoded = decodeEnvelope(
        hexToBytes(vector.encoded_hex),
        vector.decoded.direction
      );
      expect(decoded.headers.map(([n, v]) => [n, v])).toEqual(
        vector.decoded.headers
      );
    }
  });
});

describe('envelope.invalid — every vector is refused for its named reason', () => {
  const invalid = vectors.envelope.invalid;

  it('replays all eight rejection vectors', () => {
    expect(invalid).toHaveLength(8);
  });

  it('covers every error variant the schema names', () => {
    // Guards against a rejection case being silently dropped connector-side:
    // if a variant stops being exercised, this repo notices.
    expect(new Set(invalid.map((v) => v.expected_error))).toEqual(
      new Set([
        'invalid_type',
        'buffer_underflow',
        'trailing_bytes',
        'invalid_utf8',
        'non_canonical_length',
        'length_determinant_overflow',
      ])
    );
  });

  it.each(invalid.map((v) => [v.name, v] as const))(
    'refuses %s with exactly its expected_error',
    (_name, vector: EnvelopeInvalidVector) => {
      let thrown: unknown;
      let succeeded = false;
      try {
        decodeEnvelope(hexToBytes(vector.bytes_hex), vector.direction);
        succeeded = true;
      } catch (error) {
        thrown = error;
      }
      // Never succeed, never panic, never fail differently.
      expect(succeeded, 'decoded successfully — it must be refused').toBe(
        false
      );
      expect(thrown).toBeInstanceOf(EnvelopeError);
      expect((thrown as EnvelopeError).kind).toBe(vector.expected_error);
    }
  );
});
