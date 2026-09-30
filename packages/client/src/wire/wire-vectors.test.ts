/**
 * The vector-replay harness — the acceptance test for `envelope.ts`,
 * `giftwrap.ts`, and the x402 `batch-settlement` vouchers and claim-state
 * challenges that `channel/batch-settlement/` produces.
 *
 * The committed vector file is the contract (connector ADR 0021), not the prose
 * describing it and not this file's own opinions. Everything below is
 * data-driven off `vectors/wire-vectors.json`: no expectation is written out by
 * hand, so a vector the file gains is a test this suite gains, and a vector it
 * loses cannot leave a silently-passing assertion behind.
 *
 * Structure: one top-level `describe` per section, each driven by `it.each`
 * over `loadWireVectors()`. `giftwrap` and `fulfilment` (toon-client#449),
 * `peer_carriage`, and the voucher sections (toon-client#692) each arrived as
 * exactly that — a new block, no restructure. Every section the
 * file carries is replayed.
 *
 * `peer_carriage` is replayed only in PART, and deliberately so. Most of it is
 * the wire between two connectors — claim-ack carriage, flush, retransmission
 * semantics — which this client never speaks. But the OER ILP packet lives
 * inside those fixtures and is not peer-only at all: it is the same packet the
 * client edge sends and receives, and the connector's `vectors/README.md` says
 * so ("there is no separate top-level `packet` section: replay these"). So are
 * its two vouchers, which this client's voucher signers produce. What is left genuinely peer-only is named
 * in `PEER_ONLY_ITEMS` below, so no item of the section is merely unlooked-at.
 *
 * A section this harness has NOT been taught is a failure, not a no-op — see
 * "accounts for every section the file carries" below.
 */

import { describe, it, expect } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  WIRE_VECTOR_SECTIONS,
  bytesToHex,
  hexToBytes,
  loadWireVectors,
  loadWireVectorsProvenance,
  wireVectorsSha256,
  type ChargeVector,
  type EnvelopeInvalidVector,
  type EnvelopeValidVector,
  type FulfilmentVector,
  type GiftWrapVector,
  type PeerCarriageVectors,
  type PeerPrepareVector,
  type VectorEnvelope,
} from './vectors/load.js';
import {
  EnvelopeError,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
} from './envelope.js';
import {
  GiftWrapError,
  GiftWrapErrorKind,
  deriveFulfillment,
  looksLikeSealedResponse,
  openRequest,
  openResponse,
  sealRequestWithRandomness,
  sealResponseWithRandomness,
} from './giftwrap.js';
import { fulfillmentMatches } from '../utils/fulfillment.js';
import { base58Decode } from '../utils/base58.js';
import { chargeFor } from '../connector/self-description.js';
import {
  X402_BATCH_SETTLEMENT_ADDRESS,
  batchChannelId,
  batchVoucherDigest,
  signBatchVoucher,
} from '../channel/batch-settlement/evm.js';
import {
  buildSvmVoucherMessage,
  signSvmVoucher,
} from '../channel/batch-settlement/svm.js';
import { btpAuthEntry } from '../btp/IsomorphicBtpClient.js';
import {
  CHANNEL_CHALLENGE_MAX_LIFETIME_SECONDS,
  evmChallengeDigest,
  signEvmChallenge,
  signSolanaChallenge,
  solanaChallengeMessage,
} from '../channel/batch-settlement/challenge.js';
import {
  evmVoucherClaim,
  nextVoucherAmount,
  solanaVoucherClaim,
} from '../channel/batch-settlement/claim.js';

import {
  BTPMessageType,
  ILPPacketType,
  deserializeIlpPacket,
  deserializeIlpPrepare,
  parseBtpMessage,
  serializeBtpMessage,
  serializeIlpFulfill,
  serializeIlpPrepare,
  serializeIlpReject,
  type BTPMessageData,
  type ILPRejectPacket,
} from '../btp/protocol.js';
import { must } from '../utils/must.test-support.js';

const vectors = loadWireVectors();
const provenance = loadWireVectorsProvenance();

/** anvil's (and hardhat's) well-known account #1: 0x70997970…79C8. */
const ANVIL_ACCOUNT_1_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// `evm_above_u64_max` is signed by the connector's fixture key `seq_bytes(0xe1)`:
// 32 bytes counting up from 0xe1. A literal, non-secret fixture.
const ABOVE_U64_MAX_KEY = `0x${Array.from({ length: 32 }, (_, i) =>
  ((0xe1 + i) & 0xff).toString(16).padStart(2, '0')
).join('')}` as const;

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
    // 8 (connector#1439, ADR 0074 decision 3 amended): an EVM voucher's amount
    // is a uint128, serialised as a decimal string; `claim_voucher.evm_above_u64_max`.
    // 7 (connector#1384, ADR 0075): every claim is a voucher. `claim` and
    // `channel_control_declaration` (the toon-channel balance proof and its BTP
    // declaration) are gone; the voucher claim-state challenge, its BTP auth
    // form and the refused toon-channel shapes arrive.
    // 6 (connector#1347, ADR 0074): `claim_voucher` — the x402
    // batch-settlement voucher on both chains — and `charge`, the metered price.
    // 5 (connector#1269, ADR 0069): `executionCondition` is deleted from
    // PREPARE and a one-byte `greeting` flag takes its place, and the
    // `fulfilment` section narrows to `derive_fulfillment`'s determinism.
    // 4 deleted the `{peerId, secret}` peer credential from both carriages;
    // 2 put the real settlement program into `claim_solana.programId`; 3
    // retired minimum delivery.
    expect(vectors.schema_version).toBe(8);
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
    // `envelope` and `giftwrap`/`fulfilment` against `src/wire/`, the voucher,
    // challenge and refused sections against `src/channel/batch-settlement/`
    // and `src/connector/`, and `peer_carriage` against `src/btp/protocol.ts`
    // (the OER packet and the BTP frame around it) and the voucher signers.
    expect(new Set(provenance.sectionsReplayed)).toEqual(
      new Set([
        'envelope',
        'giftwrap',
        'fulfilment',
        'peer_carriage',
        'charge',
        'claim_voucher',
        'voucher_claim_state_challenge',
        'client_auth_channel_challenge',
        'toon_channel_refused',
        'claim_state_toon_channel_refused',
      ])
    );
    // A payout voucher is what a connector PAYS a client with; this client is
    // payer-only and never receives one, so there is nothing to replay it on.
    expect(provenance.sectionsPresentNotYetReplayed).toEqual([
      'payout_voucher',
    ]);
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

  it('carries two cases built from two different secrets', () => {
    // ADR 0069 narrowed this section to `derive_fulfillment`'s own
    // determinism: with no execution condition left on the wire there is
    // nothing to derive one from or match one against, so the pair now pins
    // the same property from both sides — a fixed secret's fulfilment, and a
    // different secret's different one.
    expect(cases).toHaveLength(2);
    expect(new Set(cases.map((c) => c.shared_secret_hex)).size).toBe(2);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    "derives %s's published fulfilment from its shared secret",
    (_name, vector) => {
      expect(
        bytesToHex(deriveFulfillment(hexToBytes(vector.shared_secret_hex)))
      ).toBe(vector.fulfilment_hex);
    }
  );

  it('carries no condition to check a fulfilment against (ADR 0069)', () => {
    // The removal is asserted, not merely un-asserted: a connector that put
    // the field back would be a wire change this harness must notice.
    for (const vector of cases) {
      expect(Object.keys(vector)).toEqual([
        'name',
        'shared_secret_hex',
        'fulfilment_hex',
      ]);
    }
  });

  it('tells one secret\u2019s fulfilment from another\u2019s — the whole sender check', () => {
    // Since ADR 0069 this comparison IS the delivery check, and the only one
    // made anywhere on the path: no hop verifies a FULFILL any more.
    const [first, second] = cases;
    const expected = deriveFulfillment(
      hexToBytes(first?.shared_secret_hex ?? '')
    );
    expect(fulfillmentMatches(expected, expected)).toBe(true);
    expect(
      fulfillmentMatches(
        deriveFulfillment(hexToBytes(second?.shared_secret_hex ?? '')),
        expected
      )
    ).toBe(false);
  });

  it('agrees with the giftwrap section on the secret they share', () => {
    // The `giftwrap` case and the first `fulfilment` case are built from the
    // same shared secret, so the packet a sender seals and the preimage it
    // will check against are demonstrably the same transaction — not two
    // fixtures that happen to sit in one file.
    const wrapSecret = vectors.giftwrap?.cases[0]?.shared_secret_hex;
    expect(cases[0]?.shared_secret_hex).toBe(wrapSecret);

    const { sharedSecret } = openRequest(
      hexToBytes(vectors.giftwrap?.cases[0]?.request_wrap_hex ?? ''),
      hexToBytes(vectors.giftwrap?.receiver_identity_secret_hex ?? '')
    );
    expect(bytesToHex(deriveFulfillment(sharedSecret))).toBe(
      cases[0]?.fulfilment_hex
    );
  });
});

// ─── peer_carriage ──────────────────────────────────────────────────────────

const prefix0x = (hex: string): Hex => `0x${hex}`;

/**
 * The items of `peer_carriage` that are genuinely the wire between two
 * connectors, and have no counterpart in a client.
 *
 * This client answers a connector; it never acknowledges a voucher and never
 * proves the peer role with a zero-value challenge — so there is nothing here
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
  'zero_value_challenge',
] as const;

/** The items replayed below, against this client's own codec and signers. */
const PEER_REPLAYED_ITEMS = [
  'voucher_evm',
  'voucher_solana',
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
  });

  // ── the OER PREPARE ──────────────────────────────────────────────────────

  /** Both directions: these bytes decode to those values, those values re-encode to these bytes. */
  function replayPrepare(vector: PeerPrepareVector): void {
    const bytes = hexToBytes(vector.http_body_hex);
    const decoded = deserializeIlpPrepare(bytes);

    expect(decoded.type).toBe(ILPPacketType.PREPARE);
    expect(decoded.amount).toBe(BigInt(vector.prepare.amount));
    expect(decoded.destination).toBe(vector.prepare.destination);
    // One octet, 0x00/0x01, where a 32-byte condition sat until ADR 0069.
    expect(decoded.greeting).toBe(vector.prepare.greeting);
    expect(bytesToHex(decoded.data)).toBe(vector.prepare.data_hex);
    // The 19-byte GeneralizedTime, `YYYYMMDDHHMMSS.fffZ` — TOON's dialect, not
    // RFC 0027's 17-byte Interledger Timestamp (connector ADR 0063).
    expect(decoded.expiresAt.toISOString()).toBe(vector.prepare.expires_at);
    expect(bytesToHex(serializeIlpPrepare(decoded))).toBe(vector.http_body_hex);
  }

  it('decodes and re-encodes the voucher-bearing PREPARE byte-for-byte', () => {
    replayPrepare(peer.prepare);
  });

  it('decodes and re-encodes the voucherless PREPARE — the same packet', () => {
    replayPrepare(peer.prepare_no_claim);
    expect(peer.prepare_no_claim.http_body_hex).toBe(
      peer.prepare.http_body_hex
    );
    expect(peer.prepare_no_claim.claim_json).toBeNull();
    expect(peer.prepare_no_claim.http_headers).toEqual([]);
  });

  it('carries the same OER packet, and the voucher, inside the BTP MESSAGE frame', () => {
    const frame = parseBtpMessage(hexToBytes(peer.prepare.btp_message_hex));
    expect(frame.type).toBe(BTPMessageType.MESSAGE);
    const data = frame.data as BTPMessageData;
    expect(bytesToHex(data.ilpPacket ?? new Uint8Array(0))).toBe(
      peer.prepare.http_body_hex
    );

    // The voucher rides as one `payment-channel-claim` protocolData entry whose
    // payload is the claim JSON's raw UTF-8; the HTTP header is base64 of the
    // same bytes.
    expect(data.protocolData).toHaveLength(1);
    const entry = data.protocolData[0];
    expect(entry?.protocolName).toBe('payment-channel-claim');
    expect(new TextDecoder().decode(entry?.data)).toBe(peer.prepare.claim_json);
    expect(bytesToHex(entry?.data ?? new Uint8Array(0))).toBe(
      peer.voucher_evm.btp_raw_hex
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
    // the packet.
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
    expect(vector.http_body_hex).toContain(vector.sealed_data_hex);
    const decoded = deserializeIlpPrepare(hexToBytes(vector.http_body_hex));
    expect(bytesToHex(decoded.data)).toBe(vector.sealed_data_hex);
    expect(vector.sealed_data_hex).toBe(
      vectors.giftwrap?.cases[0]?.request_wrap_hex
    );
    expect(vector.btp_ilp_packet_prepare_hex).toContain(vector.sealed_data_hex);
    const frame = parseBtpMessage(
      hexToBytes(vector.btp_ilp_packet_prepare_hex)
    );
    expect(
      bytesToHex((frame.data as BTPMessageData).ilpPacket ?? new Uint8Array(0))
    ).toBe(vector.http_body_hex);
  });

  // ── the vouchers a carriage carries ──────────────────────────────────────

  it('signs the EVM voucher’s published digest', () => {
    const v = peer.voucher_evm;
    expect(
      batchVoucherDigest(
        v.chain_id,
        prefix0x(v.channel_id_hex),
        BigInt(v.max_claimable_amount)
      )
    ).toBe(prefix0x(v.digest_hex));
  });

  it('reproduces the Solana voucher’s message and signature from its secret', () => {
    const v = peer.voucher_solana;
    expect(
      bytesToHex(
        buildSvmVoucherMessage(
          v.channel_account_base58,
          BigInt(v.max_claimable_amount)
        )
      )
    ).toBe(v.signed_message_hex);
    const privateKey = hexToBytes(v.signer_secret_hex);
    const signer = { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
    expect(
      signSvmVoucher(
        signer,
        v.channel_account_base58,
        BigInt(v.max_claimable_amount)
      ).signature
    ).toBe(v.signature_base58);
  });

  it('decodes each voucher to the same JSON on both carriages, with the fields this client writes', () => {
    for (const v of [peer.voucher_evm, peer.voucher_solana]) {
      expect(new TextDecoder().decode(hexToBytes(v.btp_raw_hex))).toBe(v.json);
      expect(Buffer.from(v.http_base64, 'base64').toString('utf8')).toBe(
        v.json
      );
      const parsed = JSON.parse(v.json) as Record<string, unknown>;
      expect(parsed['scheme']).toBe('batch-settlement');
    }
    const evm = JSON.parse(peer.voucher_evm.json) as Record<string, unknown>;
    const ours = evmVoucherClaim(
      {
        channelId: prefix0x(peer.voucher_evm.channel_id_hex),
        maxClaimableAmount: '1',
        signature: '0x00',
      },
      {
        payer: '0x1',
        payerAuthorizer: '0x1',
        receiver: '0x2',
        receiverAuthorizer: '0x2',
        token: '0x3',
        withdrawDelay: 1,
        salt: '0x00',
      }
    );
    expect(new Set(Object.keys(ours))).toEqual(new Set(Object.keys(evm)));
    const solana = JSON.parse(peer.voucher_solana.json) as Record<
      string,
      unknown
    >;
    const oursSolana = solanaVoucherClaim(
      { channelId: 'x', maxClaimableAmount: '1', expiresAt: 0, signature: 's' },
      'k'
    );
    expect(new Set(Object.keys(oursSolana))).toEqual(
      new Set(Object.keys(solana))
    );
  });
});

// ─── charge ─────────────────────────────────────────────────────────────────

describe('charge — the metered price of one packet (connector ADR 0065)', () => {
  const cases: ChargeVector[] = vectors.charge?.cases ?? [];

  it('carries at least one case to replay', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'prices %s exactly as the connector does, saturating at u64::MAX',
    (_name, vector) => {
      const charge = chargeFor(
        { price: BigInt(vector.base), pricePerKib: BigInt(vector.per_kib) },
        vector.payload_len
      );
      expect(charge.toString()).toBe(vector.charge);
    }
  );
});

// ─── claim_voucher ──────────────────────────────────────────────────────────

describe('claim_voucher — the x402 batch-settlement voucher (connector ADR 0074)', () => {
  const voucher = vectors.claim_voucher;

  it('carries both chains and the connector-side cases', () => {
    expect(voucher?.evm).toBeDefined();
    expect(voucher?.solana).toBeDefined();
    expect(voucher?.evm_above_u64_max).toBeDefined();
    expect(voucher?.amount_only_watermark.length).toBeGreaterThan(0);
    expect(voucher?.invalid.length).toBeGreaterThan(0);
  });

  describe.each([
    ['evm', must(voucher).evm, ANVIL_ACCOUNT_1_KEY],
    ['evm_above_u64_max', must(voucher).evm_above_u64_max, ABOVE_U64_MAX_KEY],
  ] as const)('%s', (_label, v, signerKey) => {
    const config = {
      payer: getAddress(prefix0x(v.channel_config.payer_hex)),
      payerAuthorizer: getAddress(
        prefix0x(v.channel_config.payer_authorizer_hex)
      ),
      receiver: getAddress(prefix0x(v.channel_config.receiver_hex)),
      receiverAuthorizer: getAddress(
        prefix0x(v.channel_config.receiver_authorizer_hex)
      ),
      token: getAddress(prefix0x(v.channel_config.token_hex)),
      withdrawDelay: v.channel_config.withdraw_delay,
      salt: prefix0x(v.channel_config.salt_hex),
    };

    it('names the contract this client signs for', () => {
      expect(prefix0x(v.verifying_contract_hex)).toBe(
        X402_BATCH_SETTLEMENT_ADDRESS.toLowerCase()
      );
    });

    it('hashes the ChannelConfig to the published channelId', () => {
      expect(batchChannelId(config, v.chain_id)).toBe(
        prefix0x(v.channel_id_hex)
      );
    });

    it('computes the published voucher digest', () => {
      expect(
        batchVoucherDigest(
          v.chain_id,
          prefix0x(v.channel_id_hex),
          BigInt(v.max_claimable_amount)
        )
      ).toBe(prefix0x(v.digest_hex));
    });

    it('reproduces the signature byte-for-byte through signBatchVoucher', async () => {
      // The vector publishes the signer's address; the fixture key derives it.
      const account = privateKeyToAccount(signerKey);
      expect(account.address.toLowerCase()).toBe(
        prefix0x(v.signer_address_hex)
      );
      const signed = await signBatchVoucher(
        account,
        v.chain_id,
        prefix0x(v.channel_id_hex),
        BigInt(v.max_claimable_amount)
      );
      expect(signed.signature).toBe(prefix0x(v.signature_hex));
    });

    it('writes the published claim JSON byte for byte', () => {
      const published = JSON.parse(v.json) as Record<string, string>;
      const claim = evmVoucherClaim(
        {
          channelId: prefix0x(v.channel_id_hex),
          maxClaimableAmount: String(v.max_claimable_amount),
          signature: prefix0x(v.signature_hex),
        },
        config,
        { messageId: published['messageId'], timestamp: published['timestamp'] }
      );
      expect(JSON.stringify(claim)).toBe(v.json);
    });

    it('carries the amount as a decimal string that survives BigInt exactly', () => {
      expect(BigInt(v.max_claimable_amount).toString()).toBe(
        v.max_claimable_amount
      );
    });
  });

  describe('solana', () => {
    const v = must(voucher).solana;

    it('builds the published 50-byte message', () => {
      expect(v.expires_at).toBe(0);
      expect(
        bytesToHex(
          buildSvmVoucherMessage(
            v.channel_account_base58,
            BigInt(v.max_claimable_amount)
          )
        )
      ).toBe(v.signed_message_hex);
    });

    it('verifies the published signature over it, under the published key', () => {
      expect(bytesToHex(base58Decode(v.signer_public_key_base58))).toBe(
        v.signer_public_key_hex
      );
      expect(bytesToHex(base58Decode(v.signature_base58))).toBe(
        v.signature_hex
      );
      expect(
        ed25519.verify(
          hexToBytes(v.signature_hex),
          hexToBytes(v.signed_message_hex),
          hexToBytes(v.signer_public_key_hex)
        )
      ).toBe(true);
    });

    it('writes the published claim JSON byte for byte', () => {
      const published = JSON.parse(v.json) as Record<string, string>;
      const claim = solanaVoucherClaim(
        {
          channelId: v.channel_account_base58,
          maxClaimableAmount: String(v.max_claimable_amount),
          expiresAt: 0,
          signature: v.signature_base58,
        },
        v.signer_public_key_base58,
        { messageId: published['messageId'], timestamp: published['timestamp'] }
      );
      expect(JSON.stringify(claim)).toBe(v.json);
    });
  });

  describe('amount_only_watermark — the amount this client chooses', () => {
    // The connector judges a voucher it was handed; the client's part is to
    // choose an amount the connector accepts. `nextVoucherAmount` never
    // re-presents the watermark (every refused or retransmitted case) and
    // presents exactly watermark + charge (the accepted case).
    it.each(must(voucher).amount_only_watermark.map((c) => [c.name, c] as const))(
      '%s',
      (_name, c) => {
        const next = nextVoucherAmount(
          BigInt(c.watermark_amount),
          BigInt(c.charge)
        );
        if (c.outcome === 'advances') {
          expect(next).toBe(BigInt(c.presented_amount));
          expect(must(next) - BigInt(c.watermark_amount)).toBe(BigInt(must(c.advanced)));
        } else {
          // Refused, retransmitted or underpaid: all present the watermark
          // itself, which the client never signs as a new voucher.
          expect(c.presented_amount).toBe(c.watermark_amount);
          expect(next).not.toBe(BigInt(c.presented_amount));
        }
      }
    );
  });

  it('names the connector-side refusals this client must never provoke', () => {
    // `amount_only_watermark` and `invalid` are the connector's verdicts on a
    // voucher it was handed; payment-claim validation lives only there. What
    // the client owes them is never to build a voucher they refuse: a Solana
    // voucher's expires_at is always zero by construction (see above), and the
    // amount rule is replayed above, against `nextVoucherAmount`.
    expect(must(voucher).invalid.map((c) => c.expected_error)).toContain(
      'voucher_expires'
    );
    expect(
      new Set(must(voucher).amount_only_watermark.map((c) => c.outcome))
    ).toEqual(
      new Set([
        'amount_not_advancing',
        'advances',
        'retransmission',
        'underpayment',
      ])
    );
  });
});

// ─── voucher_claim_state_challenge ──────────────────────────────────────────

describe('voucher_claim_state_challenge — proving control of a channel without moving value', () => {
  const section = must(vectors.voucher_claim_state_challenge);

  it.each(section.evm.map((c) => [c.name, c] as const))(
    '%s',
    async (_name, c) => {
      expect(
        evmChallengeDigest(
          c.chain_id,
          prefix0x(c.channel_id_hex),
          BigInt(c.expires)
        )
      ).toBe(prefix0x(c.digest_hex));
      const signer = privateKeyToAccount(prefix0x(c.signer_secret_hex));
      expect(signer.address.toLowerCase()).toBe(prefix0x(c.signer_address_hex));
      const published = JSON.parse(c.entry_json) as {
        channelConfig: Record<string, string | number>;
      };
      const cc = published.channelConfig;
      const entry = await signEvmChallenge(
        signer,
        c.chain_id,
        {
          payer: String(cc['payer']),
          payerAuthorizer: String(cc['payerAuthorizer']),
          receiver: String(cc['receiver']),
          receiverAuthorizer: String(cc['receiverAuthorizer']),
          token: String(cc['token']),
          withdrawDelay: Number(cc['withdrawDelay']),
          salt: String(cc['salt']) as Hex,
        },
        prefix0x(c.channel_id_hex),
        BigInt(c.expires)
      );
      expect(JSON.stringify(entry)).toBe(c.entry_json);
      // Only the channel's own voucher signer's challenge verifies.
      expect(c.signer_address_hex === c.voucher_signer_address_hex).toBe(
        c.signature_verifies
      );
    }
  );

  it.each(section.solana.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(
      bytesToHex(
        solanaChallengeMessage(c.channel_account_base58, BigInt(c.expires))
      )
    ).toBe(c.signed_message_hex);
    const privateKey = hexToBytes(c.signer_secret_hex);
    const signer = { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
    const entry = signSolanaChallenge(
      signer,
      c.channel_account_base58,
      BigInt(c.expires)
    );
    expect(JSON.stringify(entry)).toBe(c.entry_json);
    expect(c.signer_public_key_base58 === c.authorized_signer_base58).toBe(
      c.signature_verifies
    );
  });
});

// ─── client_auth_channel_challenge ──────────────────────────────────────────

describe('client_auth_channel_challenge — the BTP auth channel declaration', () => {
  const section = must(vectors.client_auth_channel_challenge);

  it('bounds a challenge’s lifetime the way the connector does', () => {
    expect(section.max_lifetime_secs).toBe(
      CHANNEL_CHALLENGE_MAX_LIFETIME_SECONDS
    );
    for (const c of [...section.evm, ...section.solana]) {
      const inWindow =
        c.expires > c.now && c.expires - c.now <= section.max_lifetime_secs;
      expect(inWindow, c.name).toBe(c.accepted);
    }
  });

  it('wraps each challenge as the auth entry’s channelChallenge', () => {
    for (const c of [...section.evm, ...section.solana]) {
      const auth = JSON.parse(c.auth_entry_json) as Record<string, unknown>;
      expect(auth['channelChallenge']).toEqual(JSON.parse(c.challenge_json));
      expect(JSON.parse(c.challenge_json)).toMatchObject({
        scheme: 'batch-settlement',
      });
    }
  });

  it('frames the auth entry exactly as the vector’s BTP MESSAGE carries it', () => {
    for (const c of [...section.evm, ...section.solana]) {
      const frame = parseBtpMessage(hexToBytes(c.btp_message_hex));
      const data = frame.data as BTPMessageData;
      const auth = data.protocolData.find((p) => p.protocolName === 'auth');
      const published = JSON.parse(c.auth_entry_json) as { peerId: string; secret: string };
      const ours = btpAuthEntry(published.peerId, published.secret, JSON.parse(c.challenge_json));
      expect(ours, c.name).toBe(c.auth_entry_json);
      expect(new TextDecoder().decode(auth?.data)).toBe(ours);
      const rebuilt = serializeBtpMessage({
        type: BTPMessageType.MESSAGE,
        requestId: frame.requestId,
        data: { protocolData: [{ protocolName: 'auth', contentType: 1, data: new TextEncoder().encode(ours) }] },
      });
      expect(bytesToHex(rebuilt), c.name).toBe(c.btp_message_hex);
    }
  });

  it('reproduces the accepted EVM challenge byte for byte', async () => {
    const c = section.evm.find((x) => x.accepted)!;
    const published = JSON.parse(c.challenge_json) as {
      channelId: Hex;
      channelConfig: Record<string, string | number>;
    };
    const cc = published.channelConfig;
    const entry = await signEvmChallenge(
      privateKeyToAccount(ANVIL_ACCOUNT_1_KEY),
      84532,
      {
        payer: String(cc['payer']),
        payerAuthorizer: String(cc['payerAuthorizer']),
        receiver: String(cc['receiver']),
        receiverAuthorizer: String(cc['receiverAuthorizer']),
        token: String(cc['token']),
        withdrawDelay: Number(cc['withdrawDelay']),
        salt: String(cc['salt']) as Hex,
      },
      published.channelId,
      BigInt(c.expires)
    );
    expect(JSON.stringify(entry)).toBe(c.challenge_json);
  });
});

// ─── toon_channel_refused / claim_state_toon_channel_refused ───────────────

describe('the retired toon-channel shapes — which this client never produces', () => {
  it('names every refused claim and claim-state entry for having no batch-settlement scheme', () => {
    for (const c of must(vectors.toon_channel_refused).cases) {
      const claim = JSON.parse(c.claim_json) as Record<string, unknown>;
      expect(
        claim['scheme'] === undefined || claim['scheme'] === 'toon-channel',
        c.name
      ).toBe(true);
    }
    for (const c of must(vectors.claim_state_toon_channel_refused).cases) {
      const entry = JSON.parse(c.request_entry_json) as Record<string, unknown>;
      expect(
        entry['scheme'] === undefined || entry['scheme'] === 'toon-channel',
        c.name
      ).toBe(true);
      expect(JSON.parse(c.response_entry_json)).toMatchObject({
        ok: false,
        error: 'toon-channel-refused',
      });
    }
  });

  it('always writes scheme batch-settlement, on every claim and challenge it builds', async () => {
    const config = {
      payer: '0x1',
      payerAuthorizer: '0x1',
      receiver: '0x2',
      receiverAuthorizer: '0x2',
      token: '0x3',
      withdrawDelay: 1,
      salt: '0x00' as Hex,
    };
    const key = new Uint8Array(32).fill(1);
    const solanaSigner = {
      privateKey: key,
      publicKey: ed25519.getPublicKey(key),
    };
    const built = [
      evmVoucherClaim(
        { channelId: '0x00', maxClaimableAmount: '1', signature: '0x00' },
        config
      ),
      solanaVoucherClaim(
        {
          channelId: 'x',
          maxClaimableAmount: '1',
          expiresAt: 0,
          signature: 's',
        },
        'k'
      ),
      await signEvmChallenge(
        privateKeyToAccount(ANVIL_ACCOUNT_1_KEY),
        1,
        config,
        `0x${'00'.repeat(32)}`,
        1n
      ),
      signSolanaChallenge(
        solanaSigner,
        'EBBduiozK9vBCemy4FcAjhVkby2FLPstxZxxN7jpgxtr',
        1n
      ),
    ];
    for (const entry of built) expect(entry['scheme']).toBe('batch-settlement');
  });
});
