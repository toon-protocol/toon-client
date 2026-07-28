/**
 * Load the vendored cross-repo wire vectors.
 *
 * The vector FILE is the contract (connector ADR 0021); this module is only the
 * door to it. It reads from disk rather than `import`ing the JSON so the file
 * stays a data artefact — vendored, hashed and refreshable — instead of
 * something the bundler inlines into the published package.
 *
 * The shape mirrors `vectors/README.md` on the connector: every section the
 * file carries is typed and returned, including the two this repo does not
 * replay yet, so `giftwrap` (toon-client#449) and `fulfilment` become new
 * `describe` blocks in the harness rather than a restructure of it.
 *
 * Test-only: nothing in `src/index.ts` reaches here, so it is not published.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── The file's schema (connector `vectors/README.md`) ──────────────────────

/** A decoded envelope as the vector file spells it: tagged, hex body. */
export type VectorEnvelope =
  | {
      direction: 'request';
      method: string;
      target: string;
      headers: [string, string][];
      body_hex: string;
    }
  | {
      direction: 'response';
      status: number;
      headers: [string, string][];
      body_hex: string;
    };

export interface EnvelopeValidVector {
  name: string;
  encoded_hex: string;
  decoded: VectorEnvelope;
}

/** The six error names the connector's `EnvelopeError` variants map onto. */
export type VectorEnvelopeError =
  | 'buffer_underflow'
  | 'non_canonical_length'
  | 'length_determinant_overflow'
  | 'invalid_type'
  | 'invalid_utf8'
  | 'trailing_bytes';

export interface EnvelopeInvalidVector {
  name: string;
  direction: 'request' | 'response';
  bytes_hex: string;
  expected_error: VectorEnvelopeError;
}

export interface WireVectors {
  schema_version: number;
  envelope: {
    valid: EnvelopeValidVector[];
    invalid: EnvelopeInvalidVector[];
  };
  /** Not replayed yet — toon-client#449 owns the seal. Typed loosely on purpose. */
  giftwrap?: { cases?: Record<string, unknown>[] } & Record<string, unknown>;
  /** Not replayed yet. */
  fulfilment?: { cases?: Record<string, unknown>[] } & Record<string, unknown>;
}

// ─── Provenance ─────────────────────────────────────────────────────────────

export interface WireVectorsProvenance {
  sourceRepo: string;
  sourcePath: string;
  sourceRawUrl: string;
  connectorCommit: string;
  connectorCommitDate: string;
  connectorCommitSubject: string;
  schemaVersion: number;
  /** SHA-256 of the vendored `wire-vectors.json`, exactly as committed. */
  sha256: string;
  sectionsReplayed: string[];
  sectionsPresentNotYetReplayed: string[];
}

const VECTORS_PATH = fileURLToPath(
  new URL('./wire-vectors.json', import.meta.url)
);
const PROVENANCE_PATH = fileURLToPath(
  new URL('./wire-vectors.provenance.json', import.meta.url)
);

/** The vendored file's raw bytes — what the integrity hash is taken over. */
export function readWireVectorsBytes(): Buffer {
  return readFileSync(VECTORS_PATH);
}

/** SHA-256 of the vendored file, lowercase hex. */
export function wireVectorsSha256(): string {
  return createHash('sha256').update(readWireVectorsBytes()).digest('hex');
}

export function loadWireVectors(): WireVectors {
  return JSON.parse(readWireVectorsBytes().toString('utf8')) as WireVectors;
}

export function loadWireVectorsProvenance(): WireVectorsProvenance {
  return JSON.parse(
    readFileSync(PROVENANCE_PATH, 'utf8')
  ) as WireVectorsProvenance;
}

// ─── Hex ────────────────────────────────────────────────────────────────────

/** The vector file's convention: lowercase hex, no `0x`, `""` for empty. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`not a vector hex string: '${hex}'`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
