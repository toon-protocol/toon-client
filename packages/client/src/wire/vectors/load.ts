/**
 * Load the vendored cross-repo wire vectors.
 *
 * The vector FILE is the contract (connector ADR 0021); this module is only the
 * door to it. It reads from disk rather than `import`ing the JSON so the file
 * stays a data artefact — vendored, hashed and refreshable — instead of
 * something the bundler inlines into the published package.
 *
 * The shape mirrors `vectors/README.md` on the connector: every section the
 * file carries is typed and returned, and every section is now replayed —
 * `giftwrap` and `fulfilment` arrived against `src/wire/giftwrap.ts`
 * (toon-client#449), `channel_control_declaration` against
 * `src/signing/evm-signer.ts` (toon-client#540), and `peer_carriage` against
 * `src/btp/protocol.ts` and `src/channel/solana/payment-channel.ts` — each as
 * a new `describe` block in the harness rather than a restructure of it,
 * exactly as this module was shaped for. `peer_carriage` is replayed only in
 * part: its claim-ack, flush and retransmission items really are the wire
 * between two connectors, and those are named in the harness's
 * `PEER_ONLY_ITEMS` so the "nothing unlooked-at" assertion stays closed.
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

/**
 * A sealed request/response pair (connector ADR 0018). Every value a real seal
 * draws at random is pinned, so `request_wrap_hex` and `response_wrap_hex` are
 * reproducible byte-for-byte rather than merely round-trippable — a seal that
 * derived its AEAD key differently would still open its own output and would
 * only fail against these bytes.
 *
 * Hex fields carry no `0x` prefix (see `hexToBytes`).
 */
export interface GiftWrapVector {
  name: string;
  /** The sender's per-packet ephemeral secp256k1 secret, 32 bytes. */
  ephemeral_secret_hex: string;
  /** The 32 random bytes sealed inside the request. */
  shared_secret_hex: string;
  /** ChaCha20-Poly1305 nonce for the request, 12 bytes. */
  request_nonce_hex: string;
  /** ChaCha20-Poly1305 nonce for the response, 12 bytes. */
  response_nonce_hex: string;
  request_envelope: VectorEnvelope;
  /** `request_envelope` encoded — the plaintext the request wrap seals. */
  request_envelope_hex: string;
  /** `0x01 ‖ ephemeral_public(65) ‖ nonce(12) ‖ ciphertext`. */
  request_wrap_hex: string;
  response_envelope: VectorEnvelope;
  response_envelope_hex: string;
  /** `0x02 ‖ nonce(12) ‖ ciphertext`, sealed with `shared_secret_hex`. */
  response_wrap_hex: string;
}

export interface GiftWrapVectors {
  /** The fixture identity secret a replaying SDK opens the request with. */
  receiver_identity_secret_hex: string;
  /** 65-byte uncompressed — what a real connector reports at `/ilp/identity`. */
  receiver_identity_public_hex: string;
  cases: GiftWrapVector[];
}

/**
 * A derived fulfilment and the condition it is checked against (connector ADR
 * 0019). `matches` is `false` for the case whose fulfilment belongs to a
 * DIFFERENT secret than the one that minted `condition_hex`, so rejection is
 * exercised as well as acceptance.
 */
export interface FulfilmentVector {
  name: string;
  shared_secret_hex: string;
  /** `HKDF-SHA256(shared_secret, "toon-giftwrap-fulfillment")`. */
  fulfilment_hex: string;
  /** The condition a sender mints: `sha256(fulfilment)`. */
  condition_hex: string;
  /** Whether `fulfilment_hex` is the preimage of `condition_hex`. */
  matches: boolean;
}

/**
 * The BTP auth greeting's `channelId`/`expires`/`signature` declaration
 * (connector#795, client-edge-spec.md §1.9 step 1), replayed against
 * `EvmSigner.signClaimStateChallenge`. The signature scheme is the SAME
 * domain-separated `ClaimStateChallenge` EIP-712 type `POST /ilp/claim-state`
 * uses (see `signClaimStateChallenge`'s doc comment) — deliberately distinct
 * from `claim`'s `BalanceProof` typehash above, so the two can never collide.
 *
 * Unlike every other section, `channel_id_hex` and `signature_hex` carry a
 * `0x` prefix here — the literal strings the auth entry's JSON body carries,
 * not this file's usual internal byte encoding.
 */
export interface ChannelControlDeclarationVector {
  name: string;
  peer_id: string;
  chain_id: number;
  token_network_address_hex: string;
  /** `0x`-prefixed, unlike this file's other hex fields. */
  channel_id_hex: string;
  expires: number;
  /** What `signature_hex` must recover to for `signature_verifies` to hold. */
  counterparty_address_hex: string;
  signer_secret_hex: string;
  signer_address_hex: string;
  digest_hex: string;
  /** `0x`-prefixed, unlike this file's other hex fields. */
  signature_hex: string;
  /** The auth entry's full JSON body — one valid serialization of it, not
   * byte-replayed here; see `wire-vectors.test.ts` for why. */
  auth_json: string;
  btp_message_hex: string;
  signature_verifies: boolean;
}

/**
 * A peer claim, in both carriages, plus what it decodes to in-process.
 *
 * `json` is the plain string a real interaction carries; `btp_raw_hex` is that
 * same string's raw UTF-8 (the BTP `protocolData` entry payload) and
 * `http_base64` is base64 of the same bytes (the HTTP header value) — never a
 * second encoding of a different value.
 *
 * `signed_message_hex` is the bytes the claim's `signature` actually covers:
 * empty for EVM (whose signature covers an EIP-712 digest, pinned as
 * `claim_digest_hex`), and for Solana the 96-byte ADR 0053 balance proof.
 */
export interface PeerClaimVector {
  name: string;
  blockchain: 'evm' | 'solana';
  /** Solana: the 96-byte ADR 0053 message. EVM: empty (see `claim_digest_hex`). */
  signed_message_hex: string;
  json: string;
  btp_raw_hex: string;
  http_base64: string;
  /** The channel id both carriage decoders must agree the claim names. */
  wire_channel_id: string;
  wire_nonce: number;
  wire_cumulative_amount: number;
  wire_signature_hex: string;
}

/** The decoded values a pinned OER `Prepare` must produce, and re-encode from. */
export interface PeerPrepareFields {
  amount: number;
  /** ISO-8601 with milliseconds and a `Z` — the 19-byte GeneralizedTime. */
  expires_at: string;
  execution_condition_hex: string;
  destination: string;
  data_hex: string;
}

/**
 * A claim-bearing PREPARE on both carriages. **This is also the file's pin of
 * the ILP packet encoding itself** (connector ADR 0063): the OER bytes in
 * `http_body_hex` appear byte-identically inside `btp_message_hex`, and the
 * connector's own `vectors/README.md` walks them field by field.
 */
export interface PeerPrepareVector {
  name: string;
  prepare: PeerPrepareFields;
  /** `null` on `prepare_no_claim` — "claimless is legal", pinned. */
  claim_json: string | null;
  /** A complete BTP MESSAGE frame: type, requestId, the claim entry, the packet. */
  btp_message_hex: string;
  http_headers: [string, string][];
  http_body_hex: string;
}

/** A peer's answer: the ILP packet, plus the claim-ack riding beside it. */
export interface PeerResponseVector {
  name: string;
  packet: 'fulfill' | 'reject' | 'none';
  /** Empty when `packet` is `"none"` (the answer to a FLUSH). */
  packet_hex: string;
  ack: { result: 'accepted' | 'rejected'; reason: string | null } | null;
  /** Rides BESIDE the packet, never inside it (ADR 0011). */
  accumulated_cost: number | null;
  btp_response_hex: string;
  /** Always 200: the packet's verdict is independent of the claim's. */
  http_status: number;
  http_headers: [string, string][];
  http_body_hex: string;
}

/** One real sealed gift wrap carried as a PREPARE's `data`, unchanged. */
export interface PeerForwardedDataVector {
  name: string;
  sealed_data_hex: string;
  btp_ilp_packet_prepare_hex: string;
  http_body_hex: string;
}

/**
 * The connector-to-connector peer wire (connector#758, `peer-carriage-spec.md`
 * §10).
 *
 * Most of it is genuinely peer-only — claim-ack carriage, flush, retransmission
 * semantics — and no client SDK speaks any of it. But the OER **packet** bytes
 * live in here too, and those are the client edge's wire as much as the peer
 * wire's, so `prepare`, the FULFILL/REJECT `packet_hex`es, `claim_solana`'s
 * signed message and `forwarded_data_unchanged` are all replayed against this
 * client's own codec. What remains peer-only is listed by name in
 * `wire-vectors.test.ts`'s `PEER_ONLY_ITEMS`, so nothing in this section is
 * merely unlooked-at.
 */
export interface PeerCarriageVectors {
  claim_evm: PeerClaimVector;
  /** The same string as `claim.cases[0].digest_hex` — carriage cannot touch it. */
  claim_digest_hex: string;
  claim_solana: PeerClaimVector;
  prepare: PeerPrepareVector;
  prepare_no_claim: PeerPrepareVector;
  fulfill_ack_accepted: PeerResponseVector;
  fulfill_ack_rejected: PeerResponseVector;
  ack_rejected_reasons: PeerResponseVector[];
  reject_with_cost: PeerResponseVector;
  ack_absent: PeerResponseVector;
  flush_ack: PeerResponseVector;
  forwarded_data_unchanged: PeerForwardedDataVector;
  /** The peer-only items, typed loosely — see `PEER_ONLY_ITEMS`. */
  [item: string]: unknown;
}

/**
 * One row of a price schedule: what a route priced `base + per_kib/KiB` charges
 * for a packet whose sealed payload is `payload_len` bytes.
 *
 * The only section of the vector set that pins arithmetic rather than bytes,
 * and the one this client got wrong (toon-client#629). See the connector's
 * `vectors/README.md` for why a charge is a cross-repo contract in the way an
 * encoding is: `payload_len` is `Prepare.data.len()`, a property of carriage
 * that every hop can measure without opening the wrap, so four implementations
 * evaluate the same schedule over the same number and must agree.
 */
export interface ChargeVector {
  name: string;
  /**
   * Decimal **strings**, not numbers: the saturating rows reach `u64::MAX`,
   * which is past 2^53 and would be rounded by `JSON.parse`. Read them with
   * `BigInt`, never `Number`.
   */
  base: string;
  per_kib: string;
  /** `Prepare.data.len()` — the sealed gift wrap, before base64 or OER framing. */
  payload_len: number;
  /** `ceil(payload_len / 1024)`: kibibytes started, and zero for an empty payload. */
  kib: number;
  charge: string;
  /**
   * Whether `u64` saturation clamped this row. A `bigint` does not clamp on its
   * own, so {@link ../../connector/self-description.js!chargeFor} has to apply
   * the ceiling explicitly — an amount past `u64::MAX` cannot be encoded into
   * the packet it would be paying for.
   */
  saturated: boolean;
}

export interface WireVectors {
  schema_version: number;
  envelope: {
    valid: EnvelopeValidVector[];
    invalid: EnvelopeInvalidVector[];
  };
  /** Replayed against `src/wire/giftwrap.ts` (toon-client#449). */
  giftwrap?: GiftWrapVectors;
  /** Replayed against `src/wire/giftwrap.ts` (toon-client#449). */
  fulfilment?: { cases: FulfilmentVector[] };
  /** Replayed against `src/signing/evm-signer.ts`. */
  claim?: { cases: ClaimVector[] };
  /**
   * Partly replayed: the OER packet bytes and the Solana balance proof it
   * pins are the client edge's wire too. See {@link PeerCarriageVectors}.
   */
  peer_carriage?: PeerCarriageVectors;
  /** Replayed against `src/signing/evm-signer.ts`. */
  channel_control_declaration?: { cases: ChannelControlDeclarationVector[] };
  /** Replayed against `src/connector/self-description.ts`'s `chargeFor`. */
  charge?: { cases: ChargeVector[] };
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
  'peer_carriage',
  'channel_control_declaration',
  'charge',
] as const;

// ─── Provenance ─────────────────────────────────────────────────────────────

export interface WireVectorsProvenance {
  sourceRepo: string;
  sourcePath: string;
  sourceRawUrl: string;
  connectorCommit: string;
  connectorCommitDate: string;
  connectorCommitSubject: string;
  /**
   * Where these exact bytes came from: `'github'` for a fetched ref,
   * `'local'` for `--from-local <checkout>`. A wire change usually lands in a
   * working connector checkout before it reaches `main`, and vendoring from
   * GitHub at that moment copies the wrong bytes under a commit that does not
   * contain them — so the refresh script offers both, and records which.
   *
   * Optional only for provenance written before this field existed.
   */
  source?: 'github' | 'local';
  /**
   * Whether the source checkout had uncommitted changes to the vector file.
   * The refresh script refuses to write in that case, so this is always
   * `false` — which is precisely why the harness asserts it: a `true` could
   * only have been typed in by hand.
   */
  dirty?: boolean;
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
