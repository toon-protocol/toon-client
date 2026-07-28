/**
 * Load the vendored cross-repo wire vectors.
 *
 * The vector FILE is the contract (connector ADR 0021); this module is only the
 * door to it. It reads from disk rather than `import`ing the JSON so the file
 * stays a data artefact — vendored, hashed and refreshable — instead of
 * something the bundler inlines into the published package.
 *
 * The shape mirrors `vectors/README.md` on the connector: every section the
 * file carries is typed and returned, including the ones this repo does not
 * replay yet, so `giftwrap` (toon-client#449) and `fulfilment` become new
 * `describe` blocks in the harness rather than a restructure of it.
 *
 * `WIRE_VECTOR_SECTIONS` is the closed list of sections this loader has been
 * taught. The harness asserts the file carries exactly these, so a section the
 * connector ADDS (as `claim` was added in connector#588) fails loudly here
 * instead of being quietly ignored by a replay that never looks at it.
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

/**
 * A signed EIP-712 `BalanceProof` (connector ADR 0024) — the digest and
 * signature scheme both the peer wire and the client edge are checked against.
 *
 * Integer fields are JSON numbers in the file; `nonce`, `transferred_amount`
 * and `locked_amount` are `uint256` on the wire, so widen them to `bigint`
 * before hashing. Hex fields carry no `0x` prefix (see `hexToBytes`).
 */
export interface ClaimVector {
  name: string;
  /** EIP-712 domain `chainId` — per channel, never a node-wide default. */
  chain_id: number;
  /** EIP-712 domain `verifyingContract`, 20 bytes. */
  token_network_address_hex: string;
  /** The channel's on-chain `bytes32` identifier. */
  channel_id_hex: string;
  nonce: number;
  transferred_amount: number;
  /** Always 0 on the wire today (ADR 0004), still part of the hashed struct. */
  locked_amount: number;
  /** Always zero today, still part of the hashed struct. */
  locks_root_hex: string;
  /** `keccak256(0x1901 || domainSeparator || structHash)`. */
  digest_hex: string;
  signer_secret_hex: string;
  signer_address_hex: string;
  /** 65 bytes, `r || s || recovery_id`; `recovery_id` is raw 0/1, not 27/28. */
  signature_hex: string;
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
  /** Replayed against `src/signing/evm-signer.ts`. */
  claim?: { cases: ClaimVector[] };
}

/**
 * Every section this loader knows about. The harness asserts the vendored
 * file's top-level sections are exactly this set (plus `schema_version`), so a
 * newly-added connector section cannot pass through unreplayed and unnoticed.
 */
export const WIRE_VECTOR_SECTIONS = [
  'envelope',
  'giftwrap',
  'fulfilment',
  'claim',
] as const;

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
