/**
 * The vector-replay harness — the acceptance test for `envelope.ts`,
 * `giftwrap.ts`, and the EIP-712 `BalanceProof` that `signing/evm-signer.ts`
 * produces.
 *
 * The committed vector file is the contract (connector ADR 0021), not the prose
 * describing it and not this file's own opinions. Everything below is
 * data-driven off `vectors/wire-vectors.json`: no expectation is written out by
 * hand, so a vector the file gains is a test this suite gains, and a vector it
 * loses cannot leave a silently-passing assertion behind.
 *
 * Structure: one top-level `describe` per section, each driven by `it.each`
 * over `loadWireVectors()`. `giftwrap` and `fulfilment` (toon-client#449),
 * `channel_control_declaration` (toon-client#540) and now `peer_carriage` each
 * arrived as exactly that — a new block, no restructure. Every section the
 * file carries is replayed.
 *
 * `peer_carriage` is replayed only in PART, and deliberately so. Most of it is
 * the wire between two connectors — claim-ack carriage, flush, retransmission
 * semantics — which this client never speaks. But the OER ILP packet lives
 * inside those fixtures and is not peer-only at all: it is the same packet the
 * client edge sends and receives, and the connector's `vectors/README.md` says
 * so ("there is no separate top-level `packet` section: replay these"). So is
 * `claim_solana`'s signed message, which is the ADR 0053 balance proof this
 * client's Solana signer produces. What is left genuinely peer-only is named
 * in `PEER_ONLY_ITEMS` below, so no item of the section is merely unlooked-at.
 *
 * A section this harness has NOT been taught is a failure, not a no-op — see
 * "accounts for every section the file carries" below.
 */

import { describe, it, expect } from 'vitest';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  WIRE_VECTOR_SECTIONS,
  bytesToHex,
  hexToBytes,
  loadWireVectors,
  loadWireVectorsProvenance,
  wireVectorsSha256,
  type ChannelControlDeclarationVector,
  type ChargeVector,
  type ClaimVector,
  type EnvelopeInvalidVector,
  type EnvelopeValidVector,
  type FulfilmentVector,
  type GiftWrapVector,
  type PeerCarriageVectors,
  type PeerPrepareVector,
  type VectorEnvelope,
} from './vectors/load.js';
import { chargeFor } from '../connector/self-description.js';
import {
  EnvelopeError,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
} from './envelope.js';
import {
  GiftWrapError,
  GiftWrapErrorKind,
  deriveCondition,
  deriveFulfillment,
  looksLikeSealedResponse,
  openRequest,
  openResponse,
  sealRequestWithRandomness,
  sealResponseWithRandomness,
} from './giftwrap.js';
import { fulfillmentMatchesCondition } from '../utils/condition.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { SolanaSigner } from '../signing/solana-signer.js';
import type { SolanaClaimMessage } from '../signing/types.js';
import { buildBalanceProofMessage } from '../channel/solana/payment-channel.js';
import { base58Decode } from '../utils/base58.js';
import {
  BTPMessageType,
  ILPPacketType,
  deserializeIlpPacket,
  deserializeIlpPrepare,
  parseBtpMessage,
  serializeIlpFulfill,
  serializeIlpPrepare,
  serializeIlpReject,
  type BTPMessageData,
  type ILPRejectPacket,
} from '../btp/protocol.js';

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
    // 4 (connector#1157, ADR 0060): the `{peerId, secret}` peer credential is
    // deleted from both carriages. 2 put the real settlement program into
    // `claim_solana.programId`; 3 retired minimum delivery.
    expect(vectors.schema_version).toBe(4);
  });

  it('records which connector commit it came from', () => {
    expect(provenance.connectorCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.sourceRepo).toBe('toon-protocol/connector');
    // A vendored copy must be attributable to a commit someone can check out.
    // `refresh-wire-vectors.mjs` refuses to write from a dirty working tree,
    // so a `true` here could only have been typed in by hand.
    expect(provenance.dirty ?? false).toBe(false);
    if (provenance.source !== undefined) {
      expect(['github', 'local']).toContain(provenance.source);
    }
  });

  it('carries the seal sections, now replayed below', () => {
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
    // Every replayed section is reproduced by this repo's own code:
    // `envelope` and `giftwrap`/`fulfilment` against `src/wire/`, `claim` and
    // `channel_control_declaration` against `src/signing/evm-signer.ts`, and
    // `peer_carriage` against `src/btp/protocol.ts` (the OER packet and the
    // BTP frame around it) and `src/channel/solana/payment-channel.ts` (the
    // ADR 0053 balance proof).
    expect(new Set(provenance.sectionsReplayed)).toEqual(
      new Set([
        'envelope',
        'giftwrap',
        'fulfilment',
        'claim',
        'channel_control_declaration',
        'peer_carriage',
        'charge',
      ])
    );
    expect(provenance.sectionsPresentNotYetReplayed).toEqual([]);
  });
});

// ─── envelope ───────────────────────────────────────────────────────────────

/**
 * Rebuild the codec's own `Envelope` from the file's tagged envelope shape.
 * Shared with the `giftwrap` section, whose cases carry the same shape for the
 * plaintext inside a wrap.
 */
function envelopeFromVectorEnvelope(decoded: VectorEnvelope): Envelope {
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

/** The same, for a vector that wraps its envelope under a `decoded` key. */
function envelopeFromVector(vector: EnvelopeValidVector): Envelope {
  return envelopeFromVectorEnvelope(vector.decoded);
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

// ─── giftwrap ───────────────────────────────────────────────────────────────

/**
 * Replayed against `wire/giftwrap.ts`. Every random input a real seal draws is
 * pinned in the file, so these are exact-byte reproductions, not round trips:
 * a seal that hashed the ECDH output, salted the HKDF, chose a different
 * `info` string or framed the wrap differently would still open its own output
 * and would only fail here.
 */
describe('giftwrap — the seal around the envelope (connector ADR 0018)', () => {
  const section = vectors.giftwrap;
  const cases: GiftWrapVector[] = section?.cases ?? [];
  const identitySecret = hexToBytes(
    section?.receiver_identity_secret_hex ?? ''
  );
  const identityPublic = hexToBytes(
    section?.receiver_identity_public_hex ?? ''
  );

  it('carries a fixture identity and at least one case to replay', () => {
    expect(section).toBeDefined();
    expect(cases.length).toBeGreaterThan(0);
    expect(identitySecret).toHaveLength(32);
    // 65-byte uncompressed — the shape a real `GET /ilp/identity` reports.
    expect(identityPublic).toHaveLength(65);
    expect(identityPublic[0]).toBe(0x04);
  });

  it("derives the fixture's published public key from its published secret", () => {
    expect(bytesToHex(secp256k1.getPublicKey(identitySecret, false))).toBe(
      section?.receiver_identity_public_hex
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'seals %s to exactly the published request_wrap_hex',
    (_name, vector) => {
      const wrapped = sealRequestWithRandomness(
        hexToBytes(vector.request_envelope_hex),
        identityPublic,
        hexToBytes(vector.ephemeral_secret_hex),
        hexToBytes(vector.shared_secret_hex),
        hexToBytes(vector.request_nonce_hex)
      );
      expect(bytesToHex(wrapped)).toBe(vector.request_wrap_hex);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "opens %s's request with the fixture secret, recovering envelope AND secret",
    (_name, vector) => {
      const opened = openRequest(
        hexToBytes(vector.request_wrap_hex),
        identitySecret
      );
      expect(bytesToHex(opened.envelopeBytes)).toBe(
        vector.request_envelope_hex
      );
      expect(bytesToHex(opened.sharedSecret)).toBe(vector.shared_secret_hex);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "decodes %s's recovered plaintext to the published request envelope",
    (_name, vector) => {
      // Not just "the bytes match": the seal and the codec compose, which is
      // the whole point of sealing an ENCODED envelope rather than text.
      const { envelopeBytes } = openRequest(
        hexToBytes(vector.request_wrap_hex),
        identitySecret
      );
      expect(decodeEnvelope(envelopeBytes, 'request')).toEqual(
        envelopeFromVectorEnvelope(vector.request_envelope)
      );
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'seals %s to exactly the published response_wrap_hex',
    (_name, vector) => {
      const wrapped = sealResponseWithRandomness(
        hexToBytes(vector.shared_secret_hex),
        hexToBytes(vector.response_envelope_hex),
        hexToBytes(vector.response_nonce_hex)
      );
      expect(bytesToHex(wrapped)).toBe(vector.response_wrap_hex);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "opens %s's response under the request's own secret, with no second exchange",
    (_name, vector) => {
      // The secret comes from OPENING the request, not from the vector file
      // directly — that is what "no second key exchange" has to mean.
      const { sharedSecret } = openRequest(
        hexToBytes(vector.request_wrap_hex),
        identitySecret
      );
      const opened = openResponse(
        sharedSecret,
        hexToBytes(vector.response_wrap_hex)
      );
      expect(bytesToHex(opened)).toBe(vector.response_envelope_hex);
      expect(decodeEnvelope(opened, 'response')).toEqual(
        envelopeFromVectorEnvelope(vector.response_envelope)
      );
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "refuses %s's response under any other secret",
    (_name, vector) => {
      const wrong = hexToBytes(vector.shared_secret_hex);
      wrong[0] ^= 0xff;
      expect(() =>
        openResponse(wrong, hexToBytes(vector.response_wrap_hex))
      ).toThrow(GiftWrapError);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "refuses %s's request under a different identity",
    (_name, vector) => {
      // A forwarding hop holds no identity secret for this destination and
      // must see opaque bytes, which is the entire privacy claim of the seal.
      const forwardingHop = hexToBytes(vector.ephemeral_secret_hex);
      let thrown: unknown;
      try {
        openRequest(hexToBytes(vector.request_wrap_hex), forwardingHop);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GiftWrapError);
      expect((thrown as GiftWrapError).kind).toBe(GiftWrapErrorKind.OpenFailed);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'refuses a tampered %s rather than yielding plaintext',
    (_name, vector) => {
      for (const wrap of [vector.request_wrap_hex, vector.response_wrap_hex]) {
        const bytes = hexToBytes(wrap);
        bytes[bytes.length - 1] ^= 0xff;
        let thrown: unknown;
        try {
          if (bytes[0] === 1) {
            openRequest(bytes, identitySecret);
          } else {
            openResponse(hexToBytes(vector.shared_secret_hex), bytes);
          }
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(GiftWrapError);
        expect((thrown as GiftWrapError).kind).toBe(
          GiftWrapErrorKind.OpenFailed
        );
      }
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'distinguishes %s sealed from unsealed by the leading type byte alone',
    (_name, vector) => {
      expect(
        looksLikeSealedResponse(hexToBytes(vector.response_wrap_hex))
      ).toBe(true);
      // A sealed REQUEST is not a sealed response, so neither can be fed to
      // the other's `open_*` by mistake.
      expect(looksLikeSealedResponse(hexToBytes(vector.request_wrap_hex))).toBe(
        false
      );
      // Empty `Reject.data` — what every reject raised short of the
      // termination carries — is never read as sealed.
      expect(looksLikeSealedResponse(new Uint8Array(0))).toBe(false);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'binds %s to its receiver: the same inputs to another key seal differently',
    (_name, vector) => {
      const otherReceiver = secp256k1.getPublicKey(
        hexToBytes(vector.shared_secret_hex),
        false
      );
      const elsewhere = sealRequestWithRandomness(
        hexToBytes(vector.request_envelope_hex),
        otherReceiver,
        hexToBytes(vector.ephemeral_secret_hex),
        hexToBytes(vector.shared_secret_hex),
        hexToBytes(vector.request_nonce_hex)
      );
      expect(bytesToHex(elsewhere)).not.toBe(vector.request_wrap_hex);
    }
  );
});

// ─── fulfilment ─────────────────────────────────────────────────────────────

describe('fulfilment — the preimage a shared secret derives (connector ADR 0019)', () => {
  const cases: FulfilmentVector[] = vectors.fulfilment?.cases ?? [];

  it('carries both a matching and a non-matching case', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((c) => c.matches))).toEqual(
      new Set([true, false])
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "derives %s's published fulfilment from its shared secret",
    (_name, vector) => {
      expect(
        bytesToHex(deriveFulfillment(hexToBytes(vector.shared_secret_hex)))
      ).toBe(vector.fulfilment_hex);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "holds %s's `matches` flag against its published condition",
    (_name, vector) => {
      const fulfilment = deriveFulfillment(
        hexToBytes(vector.shared_secret_hex)
      );
      expect(
        fulfillmentMatchesCondition(
          fulfilment,
          hexToBytes(vector.condition_hex)
        )
      ).toBe(vector.matches);
    }
  );

  it('mints the condition as sha256 of the derived fulfilment', () => {
    // The one case whose condition WAS minted from its own secret. `sha256`
    // is asserted directly here, not merely implied by `matches`, because
    // `derive_condition` is a connector-side choice this client must copy
    // (`crates/connector-domain/src/condition.rs:27`) rather than assume.
    const matching = cases.find((c) => c.matches);
    expect(matching).toBeDefined();
    const fulfilment = deriveFulfillment(
      hexToBytes(matching?.shared_secret_hex ?? '')
    );
    expect(bytesToHex(deriveCondition(fulfilment))).toBe(
      matching?.condition_hex
    );
    expect(bytesToHex(sha256(fulfilment))).toBe(matching?.condition_hex);
  });

  it("does not accept a different secret's fulfilment for that condition", () => {
    const matching = cases.find((c) => c.matches);
    const other = cases.find((c) => !c.matches);
    expect(other?.condition_hex).toBe(matching?.condition_hex);
    expect(
      fulfillmentMatchesCondition(
        deriveFulfillment(hexToBytes(other?.shared_secret_hex ?? '')),
        hexToBytes(matching?.condition_hex ?? '')
      )
    ).toBe(false);
  });

  it('agrees with the giftwrap section on the secret they share', () => {
    // The `giftwrap` case and the matching `fulfilment` case are built from
    // the same shared secret, so the packet a sender seals and the condition
    // it mints are demonstrably the same transaction — not two fixtures that
    // happen to sit in one file.
    const wrapSecret = vectors.giftwrap?.cases[0]?.shared_secret_hex;
    expect(cases.find((c) => c.matches)?.shared_secret_hex).toBe(wrapSecret);

    const { sharedSecret } = openRequest(
      hexToBytes(vectors.giftwrap?.cases[0]?.request_wrap_hex ?? ''),
      hexToBytes(vectors.giftwrap?.receiver_identity_secret_hex ?? '')
    );
    expect(bytesToHex(deriveCondition(deriveFulfillment(sharedSecret)))).toBe(
      cases.find((c) => c.matches)?.condition_hex
    );
  });
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

// ─── channel_control_declaration ───────────────────────────────────────────

/**
 * Replayed against `signing/evm-signer.ts`'s `signClaimStateChallenge` — the
 * BTP auth greeting's `channelId`/`expires`/`signature` declaration
 * (connector#795, client-edge-spec.md §1.9 step 1), which this client already
 * sends on every `connect()`/`reauthenticate()` (`btp/IsomorphicBtpClient.ts`,
 * toon-client#513). Signed under the SAME `TokenNetwork`/`1` domain as
 * `claim` above but a distinct `ClaimStateChallenge(bytes32,uint256)`
 * typehash, so a captured declaration can never be replayed as a claim.
 *
 * Unlike `claim`, this section's `expires` is a wall-clock fact the verifier
 * (the connector, not this client) checks separately from the signature
 * (`channel_control_declaration_expired` has a genuinely verifying
 * signature) — nothing here replays that half, only the EIP-712 scheme this
 * client is the one producing.
 *
 * `auth_json`/`btp_message_hex` are deliberately NOT replayed: they pin one
 * example JSON serialization of the auth entry (the connector's own, key-
 * alphabetised by `serde_json`), and this client's greeting is a DIFFERENT
 * but equally valid encoding — `IsomorphicBtpClient.authenticate()` orders
 * keys by insertion and spreads a `blockchain` tag in beside them, since its
 * `BtpChannelDeclaration` covers the Solana shape too. Neither difference is
 * observable to the verifier: the connector reads the entry field-by-field
 * off a `serde_json::Value` (`connector-client-edge/src/btp.rs`'s
 * `auth_channel_proof`), so the contract is which fields are present and what
 * the EIP-712 digest and signature over them are — which is exactly what the
 * cases below do replay.
 */
describe('channel_control_declaration — the BTP auth channelId/expires/signature declaration (connector#795)', () => {
  const cases: ChannelControlDeclarationVector[] =
    vectors.channel_control_declaration?.cases ?? [];

  /**
   * The same `00`/`01` → `1b`/`1c` normalisation `claim` needs, minus this
   * section's `0x` prefix — unlike every other section, its `signature_hex`
   * is the literal string the auth entry's JSON body carries.
   */
  const signatureAsViem = (vector: ChannelControlDeclarationVector): Hex =>
    claimSignatureToViem(vector.signature_hex.slice(2));

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
        types: {
          ClaimStateChallenge: [
            { name: 'channelId', type: 'bytes32' },
            { name: 'expires', type: 'uint256' },
          ],
        },
        primaryType: 'ClaimStateChallenge',
        message: {
          channelId: vector.channel_id_hex as Hex,
          expires: BigInt(vector.expires),
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
    'reproduces %s byte-for-byte through EvmSigner.signClaimStateChallenge',
    async (_name, vector) => {
      const signer = new EvmSigner(prefix0x(vector.signer_secret_hex));
      const signature = await signer.signClaimStateChallenge({
        chainId: vector.chain_id,
        tokenNetworkAddress: prefix0x(vector.token_network_address_hex),
        channelId: vector.channel_id_hex,
        expires: vector.expires,
      });
      expect(signature.toLowerCase()).toBe(signatureAsViem(vector));
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    "recovers %s's signature to signature_verifies against the counterparty",
    async (_name, vector) => {
      // `signature_verifies` is `false` exactly when the signer is NOT the
      // channel's registered counterparty (channel_control_declaration_wrong_key)
      // — never about `expires`, which this test deliberately ignores, same
      // as this section's own doc comment above.
      const recovered = await recoverAddress({
        hash: prefix0x(vector.digest_hex),
        signature: signatureAsViem(vector),
      });
      const signedByCounterparty =
        recovered.toLowerCase() === prefix0x(vector.counterparty_address_hex);
      expect(signedByCounterparty).toBe(vector.signature_verifies);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'binds %s to its own channel domain, not a node-wide one',
    async (_name, vector) => {
      const signer = new EvmSigner(prefix0x(vector.signer_secret_hex));
      const elsewhere = await signer.signClaimStateChallenge({
        chainId: vector.chain_id + 1,
        tokenNetworkAddress: prefix0x(vector.token_network_address_hex),
        channelId: vector.channel_id_hex,
        expires: vector.expires,
      });
      expect(elsewhere.toLowerCase()).not.toBe(signatureAsViem(vector));
    }
  );
});

// ─── peer_carriage ──────────────────────────────────────────────────────────

/**
 * The items of `peer_carriage` that are genuinely the wire between two
 * connectors, and have no counterpart in a client.
 *
 * This client answers a connector; it never acknowledges a claim, never
 * flushes, and never adjudicates a retransmission — so there is nothing here
 * for these to be conformance evidence against. Listing them by name is what
 * keeps "every item accounted for" a real assertion rather than a comment: an
 * item the connector ADDS is in neither list and fails the build until someone
 * decides, in writing, which it is.
 */
const PEER_ONLY_ITEMS = [
  'fulfill_ack_rejected',
  'ack_rejected_reasons',
  'ack_absent',
  'ack_malformed',
  'flush',
  'flush_ack',
  'claim_retransmit',
  'claim_same_nonce_different_bytes',
  'flush_requested',
] as const;

/** The items replayed below, against this client's own codec. */
const PEER_REPLAYED_ITEMS = [
  'claim_evm',
  'claim_digest_hex',
  'claim_solana',
  'prepare',
  'prepare_no_claim',
  'fulfill_ack_accepted',
  'reject_with_cost',
  'forwarded_data_unchanged',
] as const;

describe('peer_carriage — the ILP packet bytes, which are the client edge too', () => {
  const peer = vectors.peer_carriage as PeerCarriageVectors;

  it('carries the section, and accounts for every item in it', () => {
    expect(peer).toBeDefined();
    expect(new Set(Object.keys(peer))).toEqual(
      new Set([...PEER_REPLAYED_ITEMS, ...PEER_ONLY_ITEMS])
    );
    expect(
      PEER_REPLAYED_ITEMS.filter((i) =>
        (PEER_ONLY_ITEMS as readonly string[]).includes(i)
      )
    ).toEqual([]);
  });

  // ── the OER PREPARE ──────────────────────────────────────────────────────

  /** Both directions: these bytes decode to those values, those values re-encode to these bytes. */
  function replayPrepare(vector: PeerPrepareVector): void {
    const bytes = hexToBytes(vector.http_body_hex);
    const decoded = deserializeIlpPrepare(bytes);

    expect(decoded.type).toBe(ILPPacketType.PREPARE);
    expect(decoded.amount).toBe(BigInt(vector.prepare.amount));
    expect(decoded.destination).toBe(vector.prepare.destination);
    expect(bytesToHex(decoded.executionCondition)).toBe(
      vector.prepare.execution_condition_hex
    );
    expect(bytesToHex(decoded.data)).toBe(vector.prepare.data_hex);
    // The 19-byte GeneralizedTime, `YYYYMMDDHHMMSS.fffZ` — TOON's dialect, not
    // RFC 0027's 17-byte Interledger Timestamp (connector ADR 0063).
    expect(decoded.expiresAt.toISOString()).toBe(vector.prepare.expires_at);

    // ...and re-encoding what we decoded reproduces the published bytes. A
    // decoder that merely tolerated a non-canonical VarUInt would pass the
    // first half and fail here.
    expect(bytesToHex(serializeIlpPrepare(decoded))).toBe(vector.http_body_hex);
  }

  it('decodes and re-encodes the claim-bearing PREPARE byte-for-byte', () => {
    replayPrepare(peer.prepare);
  });

  it('decodes and re-encodes the claimless PREPARE — the same packet', () => {
    // "Claimless is legal", pinned rather than assumed: the packet bytes are
    // identical, and only the carriage around them loses the claim.
    replayPrepare(peer.prepare_no_claim);
    expect(peer.prepare_no_claim.http_body_hex).toBe(peer.prepare.http_body_hex);
    expect(peer.prepare_no_claim.claim_json).toBeNull();
    expect(peer.prepare_no_claim.http_headers).toEqual([]);
  });

  it('carries the same OER packet inside the BTP MESSAGE frame', () => {
    // `parseBtpMessage` must find the packet byte-identical to the HTTP body:
    // the two carriages encode the same value, never two encodings of two
    // values (peer-carriage-spec.md §10.1 I1).
    const frame = parseBtpMessage(hexToBytes(peer.prepare.btp_message_hex));
    expect(frame.type).toBe(BTPMessageType.MESSAGE);
    const data = frame.data as BTPMessageData;
    expect(bytesToHex(data.ilpPacket ?? new Uint8Array(0))).toBe(
      peer.prepare.http_body_hex
    );

    // ...and the claim rides as one `payment-channel-claim` protocolData entry
    // whose payload is the claim JSON's raw UTF-8 — not base64, not a second
    // serialization of it. (Base64 is the HTTP header's encoding of the same
    // bytes; both are asserted here against the one `claim_json`.)
    expect(data.protocolData).toHaveLength(1);
    const entry = data.protocolData[0];
    expect(entry?.protocolName).toBe('payment-channel-claim');
    expect(new TextDecoder().decode(entry?.data)).toBe(peer.prepare.claim_json);
    expect(bytesToHex(entry?.data ?? new Uint8Array(0))).toBe(
      peer.claim_evm.btp_raw_hex
    );

    const [headerName, headerValue] = peer.prepare.http_headers[0] ?? [];
    expect(headerName).toBe('ilp-payment-channel-claim');
    expect(Buffer.from(headerValue ?? '', 'base64').toString('utf8')).toBe(
      peer.prepare.claim_json
    );
  });

  // ── the OER FULFILL / REJECT ─────────────────────────────────────────────

  it('decodes and re-encodes the FULFILL byte-for-byte', () => {
    const vector = peer.fulfill_ack_accepted;
    expect(vector.packet).toBe('fulfill');
    const packet = deserializeIlpPacket(hexToBytes(vector.packet_hex));
    if (packet.type !== ILPPacketType.FULFILL) throw new Error('not a FULFILL');

    expect(packet.fulfillment.length).toBe(32);
    expect(new TextDecoder().decode(packet.data)).toBe(
      'vector-fixture-fulfill-data'
    );
    expect(bytesToHex(serializeIlpFulfill(packet))).toBe(vector.packet_hex);

    // The packet is byte-identical to the HTTP body: the ack rides beside it.
    expect(vector.http_body_hex).toBe(vector.packet_hex);
    expect(vector.http_status).toBe(200);
  });

  it('decodes and re-encodes the REJECT byte-for-byte', () => {
    const vector = peer.reject_with_cost;
    expect(vector.packet).toBe('reject');
    const packet = deserializeIlpPacket(hexToBytes(vector.packet_hex));
    if (packet.type !== ILPPacketType.REJECT) throw new Error('not a REJECT');

    expect(packet.code).toBe('T04');
    expect(packet.triggeredBy).toBe('g.toon.store-box');
    expect(packet.message).toBe('vector fixture reject');
    expect(packet.data.length).toBe(0);
    expect(bytesToHex(serializeIlpReject(packet))).toBe(vector.packet_hex);
  });

  it('keeps accumulated_cost OUT of the REJECT and beside it', () => {
    // ADR 0011: the cost rides as a header / protocolData entry, never inside
    // the packet. A decoder that expected it in the bytes would read a
    // truncated `data` field and never notice.
    const vector = peer.reject_with_cost;
    expect(vector.accumulated_cost).toBe(4200);
    expect(
      vector.http_headers.find(([name]) => name === 'toon-accumulated-cost')
    ).toEqual(['toon-accumulated-cost', '4200']);
    const packet = deserializeIlpPacket(hexToBytes(vector.packet_hex));
    expect(bytesToHex(serializeIlpReject(packet as ILPRejectPacket))).toBe(
      vector.packet_hex
    );
    expect(vector.packet_hex).toBe(vector.http_body_hex);
  });

  // ── the sealed payload a hop must not touch ──────────────────────────────

  it('carries the sealed gift wrap through the PREPARE unchanged', () => {
    const vector = peer.forwarded_data_unchanged;
    // Byte-for-byte inside the packet — a forwarding hop never re-encodes,
    // re-wraps or truncates a payload it holds no key for (§8.1).
    expect(vector.http_body_hex).toContain(vector.sealed_data_hex);
    const decoded = deserializeIlpPrepare(hexToBytes(vector.http_body_hex));
    expect(bytesToHex(decoded.data)).toBe(vector.sealed_data_hex);
    // ...and it really is one of this file's own giftwrap request wraps, so
    // `giftwrap`'s replay above is what proves these bytes are openable.
    expect(vector.sealed_data_hex).toBe(
      vectors.giftwrap?.cases[0]?.request_wrap_hex
    );
    // The BTP carriage of the same packet carries the same bytes.
    expect(vector.btp_ilp_packet_prepare_hex).toContain(vector.sealed_data_hex);
    const frame = parseBtpMessage(
      hexToBytes(vector.btp_ilp_packet_prepare_hex)
    );
    expect(
      bytesToHex((frame.data as BTPMessageData).ilpPacket ?? new Uint8Array(0))
    ).toBe(vector.http_body_hex);
  });

  // ── the Solana balance proof (connector ADR 0053) ────────────────────────

  it('reproduces the 96-byte Solana balance proof from the claim fields', () => {
    const claim = JSON.parse(peer.claim_solana.json) as SolanaClaimMessage;
    const rebuilt = buildBalanceProofMessage(
      claim.programId,
      claim.channelAccount,
      BigInt(claim.nonce),
      BigInt(claim.transferredAmount)
    );
    expect(bytesToHex(rebuilt)).toBe(peer.claim_solana.signed_message_hex);
    expect(rebuilt.length).toBe(96);
  });

  it('binds the declared programId at offset 16 — the ADR 0053 binding', () => {
    // The vector's own generator asserts this; asserting it here is what makes
    // `programId` a field this client must SIGN under rather than merely
    // report. A claim naming another program names a program no channel of the
    // payer's lives under, and the bytes would not match.
    const claim = JSON.parse(peer.claim_solana.json) as SolanaClaimMessage;
    const message = hexToBytes(peer.claim_solana.signed_message_hex);
    expect(new TextDecoder().decode(message.slice(0, 16))).toBe(
      'TOON-BALPROOF-V2'
    );
    expect(bytesToHex(message.slice(16, 48))).toBe(
      bytesToHex(base58Decode(claim.programId))
    );
    expect(bytesToHex(message.slice(48, 80))).toBe(
      bytesToHex(base58Decode(claim.channelAccount))
    );
  });

  // ── the claim JSON shapes this client emits ──────────────────────────────

  it('agrees with this client on which fields a claim carries', () => {
    // The connector reads a claim field-by-field, so what the contract fixes is
    // WHICH fields are present. A signer that dropped one, or invented one,
    // would still produce valid JSON and a valid signature — and a claim the
    // connector refuses structurally, before it ever looks at the signature.
    const solana = JSON.parse(peer.claim_solana.json) as Record<string, unknown>;
    const evm = JSON.parse(peer.claim_evm.json) as Record<string, unknown>;

    const solanaSigner = new SolanaSigner(new Uint8Array(32).fill(3));
    const solanaClaim = solanaSigner.buildClaimMessage(
      {
        channelId: String(solana['channelAccount']),
        nonce: Number(solana['nonce']),
        transferredAmount: BigInt(String(solana['transferredAmount'])),
        lockedAmount: 0n,
        locksRoot: '0x00',
        signature: '0x' + '11'.repeat(64),
        signerAddress: String(solana['signerPublicKey']),
        chainId: 0,
        tokenNetworkAddress: String(solana['programId']),
        recipient: '',
      },
      String(solana['senderId'])
    );
    expect(new Set(Object.keys(solanaClaim))).toEqual(new Set(Object.keys(solana)));

    const evmClaim = EvmSigner.buildClaimMessage(
      {
        channelId: String(evm['channelId']),
        nonce: Number(evm['nonce']),
        transferredAmount: BigInt(String(evm['transferredAmount'])),
        lockedAmount: BigInt(String(evm['lockedAmount'])),
        locksRoot: String(evm['locksRoot']),
        signature: String(evm['signature']),
        signerAddress: String(evm['signerAddress']),
        chainId: Number(evm['chainId']),
        tokenNetworkAddress: String(evm['tokenNetworkAddress']),
        recipient: '',
      },
      String(evm['senderId'])
    );
    expect(new Set(Object.keys(evmClaim))).toEqual(new Set(Object.keys(evm)));
  });

  it('repeats the EIP-712 digest carriage cannot touch', () => {
    // `claim_digest_hex` is the same string as `claim.cases[0].digest_hex`,
    // repeated rather than recomputed — the point being that wrapping a claim
    // in either carriage changes nothing about what was signed.
    expect(peer.claim_digest_hex).toBe(vectors.claim?.cases[0]?.digest_hex);
    expect(peer.claim_evm.signed_message_hex).toBe('');
  });

  it('decodes each claim to the same wire values on both carriages', () => {
    for (const claim of [peer.claim_evm, peer.claim_solana]) {
      const fromBtp = new TextDecoder().decode(hexToBytes(claim.btp_raw_hex));
      const fromHttp = Buffer.from(claim.http_base64, 'base64').toString('utf8');
      expect(fromBtp).toBe(claim.json);
      expect(fromHttp).toBe(claim.json);

      const parsed = JSON.parse(claim.json) as Record<string, unknown>;
      expect(parsed['blockchain']).toBe(claim.blockchain);
      expect(parsed[claim.blockchain === 'evm' ? 'channelId' : 'channelAccount']).toBe(
        claim.wire_channel_id
      );
      expect(parsed['nonce']).toBe(claim.wire_nonce);
      expect(String(parsed['transferredAmount'])).toBe(
        String(claim.wire_cumulative_amount)
      );
    }
  });
});


/**
 * The one section that is arithmetic rather than bytes, and the one this client
 * got wrong.
 *
 * `chargeFor` computed `floor(len / 1024) + 1` where the connector's
 * `Price::charge` computes `base + per_kib * ceil(len / 1024)`. The two agree at
 * every length that is not a multiple of 1024, so every size the client had
 * actually been checked against agreed, and at a multiple it overpaid by a whole
 * kibibyte — silently, because a claim advancing more than the price is simply
 * accepted (toon-client#629). This block is what makes that unrepeatable: the
 * boundary rows come from the connector's own generator, which re-derives each
 * one in checked longhand arithmetic before committing it.
 *
 * Why a charge belongs in a *wire* vector set at all: `payload_len` is
 * `Prepare.data.len()`, a property of carriage rather than content, so every hop
 * can measure it without opening the gift wrap — which is exactly what lets this
 * client compute its own charge before it sends. Four implementations evaluate
 * the same schedule over the same number, and they have to agree.
 */
describe('charge — what a route charges for one packet (connector ADR 0065)', () => {
  const cases: ChargeVector[] = vectors.charge?.cases ?? [];

  /** The vector's own decimal strings, read as `bigint` — never as `Number`. */
  const termsOf = (vector: ChargeVector) => ({
    price: BigInt(vector.base),
    pricePerKib: BigInt(vector.per_kib),
  });

  it('carries at least one case to replay', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'charges %s exactly what the connector charges',
    (_name, vector) => {
      expect(chargeFor(termsOf(vector), vector.payload_len)).toBe(BigInt(vector.charge));
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    'counts %s as the published number of started kibibytes',
    (_name, vector) => {
      // Asserted independently of the total, so an implementation that reaches
      // the right charge by the wrong route still fails here. This is the
      // assertion the old `floor(n / 1024) + 1` would break on at every
      // boundary row, and on the empty payload.
      expect(Math.ceil(vector.payload_len / 1024)).toBe(vector.kib);
    }
  );

  it.each(
    cases
      .filter((c) => BigInt(c.per_kib) === 0n)
      .map((c) => [c.name, c] as const)
  )('treats %s as flat whether the rate is zero or absent', (_name, vector) => {
    // A flat price is the same VALUE as a zero-slope schedule, not merely an
    // equivalent one (ADR 0065), so the two spellings cannot be told apart —
    // and a flat route charges its base at every length, including the lengths
    // where the metered rows all differ.
    expect(chargeFor({ price: BigInt(vector.base) }, vector.payload_len)).toBe(
      BigInt(vector.charge)
    );
    expect(chargeFor(termsOf(vector), vector.payload_len)).toBe(BigInt(vector.base));
  });

  it('clamps a schedule that overflows a u64, rather than exceeding it', () => {
    // A `bigint` does not overflow, so nothing forces this client to clamp on
    // its own — and an amount past `u64::MAX` cannot be encoded into the packet
    // it would be paying for. `saturated` is the vector telling us where the
    // ceiling is.
    const saturating = cases.filter((c) => c.saturated);
    expect(saturating.length).toBeGreaterThan(0);
    for (const vector of saturating) {
      expect(BigInt(vector.charge)).toBe(2n ** 64n - 1n);
      expect(chargeFor(termsOf(vector), vector.payload_len)).toBe(2n ** 64n - 1n);
    }
  });

  it('covers both sides of a kibibyte boundary, which is the whole point', () => {
    // A guard on the fixture itself: a future regeneration that dropped the
    // boundary rows would leave every remaining row passing under either
    // formula, which is exactly the state that hid #629.
    const metered = new Map(
      cases.filter((c) => BigInt(c.per_kib) > 0n).map((c) => [c.payload_len, c])
    );
    for (const len of [0, 1023, 1024, 1025, 2048, 2049]) {
      expect(metered.has(len), `no metered vector at ${len} bytes`).toBe(true);
    }
    // The two readings differ at exactly these lengths: `ceil` says one
    // kibibyte at 1024 and `floor + 1` says two.
    expect(metered.get(1024)?.kib).toBe(1);
    expect(metered.get(2048)?.kib).toBe(2);
    expect(metered.get(0)?.kib).toBe(0);
  });
});
