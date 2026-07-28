/**
 * The vector-replay harness — the acceptance test for `envelope.ts` and for
 * the EIP-712 `BalanceProof` that `signing/evm-signer.ts` produces.
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
 *
 * A section this harness has NOT been taught is a failure, not a no-op — see
 * "accounts for every section the file carries" below.
 */

import { describe, it, expect } from 'vitest';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import {
  WIRE_VECTOR_SECTIONS,
  bytesToHex,
  hexToBytes,
  loadWireVectors,
  loadWireVectorsProvenance,
  wireVectorsSha256,
  type ClaimVector,
  type EnvelopeInvalidVector,
  type EnvelopeValidVector,
} from './vectors/load.js';
import {
  EnvelopeError,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
} from './envelope.js';
import { EvmSigner } from '../signing/evm-signer.js';

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

  it('accounts for every section the file carries', () => {
    // The failure mode this exists to prevent: the connector adds a section
    // (as #588 added `claim`), the vendored copy is refreshed, and the harness
    // sails past the new bytes because nothing looks at them. A section this
    // repo has not been taught must break the build, not be ignored.
    const sections = Object.keys(vectors).filter((k) => k !== 'schema_version');
    expect(new Set(sections)).toEqual(new Set(WIRE_VECTOR_SECTIONS));

    // ...and each taught section is either replayed below or declared as
    // deliberately not-yet-replayed, with nothing falling between the two.
    expect(
      new Set([
        ...provenance.sectionsReplayed,
        ...provenance.sectionsPresentNotYetReplayed,
      ])
    ).toEqual(new Set(WIRE_VECTOR_SECTIONS));
    expect(
      provenance.sectionsReplayed.filter((s) =>
        provenance.sectionsPresentNotYetReplayed.includes(s)
      )
    ).toEqual([]);
  });

  it('replays the sections its provenance claims it replays', () => {
    expect(new Set(provenance.sectionsReplayed)).toEqual(
      new Set(['envelope', 'claim'])
    );
    // Stated, not incidental: `giftwrap` and `fulfilment` are carried and
    // hashed but no assertion below reproduces their bytes.
    expect(new Set(provenance.sectionsPresentNotYetReplayed)).toEqual(
      new Set(['giftwrap', 'fulfilment'])
    );
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

// ─── claim ──────────────────────────────────────────────────────────────────

/**
 * Replayed against `signing/evm-signer.ts` — this client DOES produce these
 * bytes. `EvmSigner.signBalanceProof` signs an EIP-712 `BalanceProof` under a
 * per-channel `TokenNetwork` domain with zeroed `lockedAmount`/`locksRoot`,
 * which is exactly the scheme connector ADR 0024 moved the peer wire onto. So
 * these vectors are a real conformance check here, not borrowed evidence: a
 * drifted domain field, a reordered struct member or a widened integer would
 * all change the digest and fail below.
 *
 * The one representation difference, normalised and asserted rather than
 * papered over: the connector's `signature_hex` ends in a raw recovery id
 * (`00`/`01`); viem, like every wallet, emits the EIP-155-era `1b`/`1c`.
 */
const CLAIM_DOMAIN_NAME = 'TokenNetwork';
const CLAIM_DOMAIN_VERSION = '1';
const CLAIM_TYPES = {
  BalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'transferredAmount', type: 'uint256' },
    { name: 'lockedAmount', type: 'uint256' },
    { name: 'locksRoot', type: 'bytes32' },
  ],
} as const;

const prefix0x = (hex: string): Hex => `0x${hex}`;

/** `r || s || recovery_id(0|1)` as the vectors carry it → viem's `r || s || v(27|28)`. */
function claimSignatureToViem(signatureHex: string): Hex {
  const recovery = Number.parseInt(signatureHex.slice(128), 16);
  expect(
    recovery,
    'vector recovery id must be raw 0/1, not a wallet 27/28'
  ).toBeLessThan(2);
  return `0x${signatureHex.slice(0, 128)}${(recovery + 27).toString(16)}`;
}

describe('claim — the EIP-712 BalanceProof this client signs (connector ADR 0024)', () => {
  const cases: ClaimVector[] = vectors.claim?.cases ?? [];

  it('carries at least one case to replay', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "computes %s's published digest from the published fields",
    (_name, vector) => {
      const digest = hashTypedData({
        domain: {
          name: CLAIM_DOMAIN_NAME,
          version: CLAIM_DOMAIN_VERSION,
          chainId: vector.chain_id,
          verifyingContract: prefix0x(vector.token_network_address_hex),
        },
        types: CLAIM_TYPES,
        primaryType: 'BalanceProof',
        message: {
          channelId: prefix0x(vector.channel_id_hex),
          nonce: BigInt(vector.nonce),
          transferredAmount: BigInt(vector.transferred_amount),
          lockedAmount: BigInt(vector.locked_amount),
          locksRoot: prefix0x(vector.locks_root_hex),
        },
      });
      expect(digest).toBe(prefix0x(vector.digest_hex));
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "derives %s's published signer address from its fixture secret",
    (_name, vector) => {
      const signer = new EvmSigner(prefix0x(vector.signer_secret_hex));
      expect(signer.address.toLowerCase()).toBe(
        prefix0x(vector.signer_address_hex)
      );
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'reproduces %s byte-for-byte through EvmSigner.signBalanceProof',
    async (_name, vector) => {
      const signer = new EvmSigner(prefix0x(vector.signer_secret_hex));
      const proof = await signer.signBalanceProof({
        channelId: prefix0x(vector.channel_id_hex),
        nonce: vector.nonce,
        transferredAmount: BigInt(vector.transferred_amount),
        lockedAmount: BigInt(vector.locked_amount),
        locksRoot: prefix0x(vector.locks_root_hex),
        chainId: vector.chain_id,
        tokenNetworkAddress: prefix0x(vector.token_network_address_hex),
      });
      // The whole 65 bytes, recovery id included — not a prefix comparison.
      expect(proof.signature.toLowerCase()).toBe(
        claimSignatureToViem(vector.signature_hex)
      );
      expect(proof.signerAddress.toLowerCase()).toBe(
        prefix0x(vector.signer_address_hex)
      );
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "recovers %s's published signature to its published signer",
    async (_name, vector) => {
      const recovered = await recoverAddress({
        hash: prefix0x(vector.digest_hex),
        signature: claimSignatureToViem(vector.signature_hex),
      });
      expect(recovered.toLowerCase()).toBe(prefix0x(vector.signer_address_hex));
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'hashes lockedAmount and locksRoot into %s rather than omitting them',
    (_name, vector) => {
      // Both are zero on the wire today (ADR 0004). A signer that dropped them
      // from the struct would still produce a self-consistent signature and
      // would still round-trip its own output — it would only fail here.
      expect(vector.locked_amount).toBe(0);
      expect(vector.locks_root_hex).toBe('0'.repeat(64));

      const withoutZeroFields = hashTypedData({
        domain: {
          name: CLAIM_DOMAIN_NAME,
          version: CLAIM_DOMAIN_VERSION,
          chainId: vector.chain_id,
          verifyingContract: prefix0x(vector.token_network_address_hex),
        },
        types: {
          BalanceProof: [
            { name: 'channelId', type: 'bytes32' },
            { name: 'nonce', type: 'uint256' },
            { name: 'transferredAmount', type: 'uint256' },
          ],
        },
        primaryType: 'BalanceProof',
        message: {
          channelId: prefix0x(vector.channel_id_hex),
          nonce: BigInt(vector.nonce),
          transferredAmount: BigInt(vector.transferred_amount),
        },
      });
      expect(withoutZeroFields).not.toBe(prefix0x(vector.digest_hex));
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'binds %s to its own channel domain, not a node-wide one',
    async (_name, vector) => {
      // The README is explicit that chain_id/token_network_address are set per
      // channel. Prove the digest actually moves with them, so a signer that
      // hardcoded one chain's domain cannot pass by accident.
      const signer = new EvmSigner(prefix0x(vector.signer_secret_hex));
      const elsewhere = await signer.signBalanceProof({
        channelId: prefix0x(vector.channel_id_hex),
        nonce: vector.nonce,
        transferredAmount: BigInt(vector.transferred_amount),
        lockedAmount: BigInt(vector.locked_amount),
        locksRoot: prefix0x(vector.locks_root_hex),
        chainId: vector.chain_id + 1,
        tokenNetworkAddress: prefix0x(vector.token_network_address_hex),
      });
      expect(elsewhere.signature.toLowerCase()).not.toBe(
        claimSignatureToViem(vector.signature_hex)
      );
    }
  );
});
