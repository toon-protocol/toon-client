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
 * (toon-client#449), the voucher sections against
 * `src/channel/batch-settlement/` (toon-client#692), and `peer_carriage`
 * against `src/btp/protocol.ts` and the voucher signers — each as
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
 * A fulfilment derived from a shared secret (connector ADR 0019).
 *
 * Narrowed by ADR 0069 to `derive_fulfillment`'s own determinism: with no
 * execution condition left on the wire there is nothing to derive one from or
 * match one against, so `condition_hex` and `matches` are gone from the file.
 * The two cases now pin the same property from opposite sides — a fixed
 * secret's fulfilment, and a different secret's different fulfilment.
 */
export interface FulfilmentVector {
  name: string;
  shared_secret_hex: string;
  /** `HKDF-SHA256(shared_secret, "toon-giftwrap-fulfillment")`. */
  fulfilment_hex: string;
}

/** The decoded values a pinned OER `Prepare` must produce, and re-encode from. */
export interface PeerPrepareFields {
  amount: number;
  /** ISO-8601 with milliseconds and a `Z` — the 19-byte GeneralizedTime. */
  expires_at: string;
  /**
   * The bootstrap-probe flag, one octet on the wire, where a 32-byte
   * `execution_condition_hex` sat until schema 5 (connector ADR 0069).
   */
  greeting: boolean;
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

/** A voucher as a carriage carries it: the JSON, and its BTP and HTTP spellings. */
interface PeerVoucherCarriage {
  name: string;
  max_claimable_amount: string;
  json: string;
  /** The claim JSON's raw UTF-8, as the BTP protocolData entry carries it. */
  btp_raw_hex: string;
  /** The same bytes, base64, as the HTTP claim header carries them. */
  http_base64: string;
}

export interface PeerVoucherEvmVector extends PeerVoucherCarriage {
  chain_id: number;
  verifying_contract_hex: string;
  channel_config: VoucherChannelConfigVector;
  channel_id_hex: string;
  digest_hex: string;
  signer_address_hex: string;
  signature_hex: string;
}

export interface PeerVoucherSolanaVector extends PeerVoucherCarriage {
  channel_account_base58: string;
  authorized_signer_base58: string;
  signer_secret_hex: string;
  signed_message_hex: string;
  signature_base58: string;
}

/** A voucher claim-state challenge on EVM (ADR 0075). */
export interface EvmChallengeVector {
  name: string;
  chain_id: number;
  verifying_contract_hex: string;
  channel_id_hex: string;
  expires: number;
  voucher_signer_address_hex: string;
  signer_secret_hex: string;
  signer_address_hex: string;
  digest_hex: string;
  signature_hex: string;
  signature_verifies: boolean;
  entry_json: string;
}

/** A voucher claim-state challenge on Solana; the signature is base64. */
export interface SolanaChallengeVector {
  name: string;
  channel_account_base58: string;
  expires: number;
  authorized_signer_base58: string;
  signer_secret_hex: string;
  signer_public_key_base58: string;
  signed_message_hex: string;
  signature_base64: string;
  signature_verifies: boolean;
  entry_json: string;
}

/** The BTP auth frame's `channelChallenge`, judged at `now`. */
export interface AuthChallengeVector {
  name: string;
  blockchain: 'evm' | 'solana';
  now: number;
  expires: number;
  accepted: boolean;
  challenge_json: string;
  auth_entry_json: string;
  btp_message_hex: string;
}

/**
 * The connector-to-connector peer wire (connector#758, `peer-carriage-spec.md`
 * §10).
 *
 * Most of it is genuinely peer-only — claim-ack carriage, flush, retransmission
 * semantics — and no client SDK speaks any of it. But the OER **packet** bytes
 * live in here too, and those are the client edge's wire as much as the peer
 * wire's, so `prepare`, the FULFILL/REJECT `packet_hex`es, the two vouchers
 * and `forwarded_data_unchanged` are all replayed against this
 * client's own codec. What remains peer-only is listed by name in
 * `wire-vectors.test.ts`'s `PEER_ONLY_ITEMS`, so nothing in this section is
 * merely unlooked-at.
 */
export interface PeerCarriageVectors {
  voucher_evm: PeerVoucherEvmVector;
  voucher_solana: PeerVoucherSolanaVector;
  prepare: PeerPrepareVector;
  prepare_no_claim: PeerPrepareVector;
  fulfill_ack_accepted: PeerResponseVector;
  fulfill_ack_rejected: PeerResponseVector;
  ack_rejected_reasons: PeerResponseVector[];
  reject_with_cost: PeerResponseVector;
  ack_absent: PeerResponseVector;
  forwarded_data_unchanged: PeerForwardedDataVector;
  /** The peer-only items, typed loosely — see `PEER_ONLY_ITEMS`. */
  [item: string]: unknown;
}

/**
 * One metered-price case (connector ADR 0065): `base + per_kib ×
 * ceil(payload_len / 1024)`, saturating at `u64::MAX`. Amounts are decimal
 * strings because two cases sit at `u64::MAX`, past a JSON number's precision.
 */
export interface ChargeVector {
  name: string;
  base: string;
  per_kib: string;
  payload_len: number;
  kib: number;
  charge: string;
  saturated: boolean;
}

/** An x402 `ChannelConfig`, in the file's hex spelling. */
export interface VoucherChannelConfigVector {
  payer_hex: string;
  payer_authorizer_hex: string;
  receiver_hex: string;
  receiver_authorizer_hex: string;
  token_hex: string;
  withdraw_delay: number;
  salt_hex: string;
}

/** An EVM `batch-settlement` voucher (connector ADR 0074 decision 4). */
export interface EvmVoucherVector {
  name: string;
  chain_id: number;
  verifying_contract_hex: string;
  channel_config: VoucherChannelConfigVector;
  /** `getChannelId(channel_config)`. */
  channel_id_hex: string;
  max_claimable_amount: string;
  /** `getVoucherDigest(channelId, maxClaimableAmount)`. */
  digest_hex: string;
  signer_address_hex: string;
  /** 65 bytes, `r || s || v` with `v` in {27, 28}. */
  signature_hex: string;
  /** The claim as it rides the wire. */
  json: string;
}

/** A Solana `batch-settlement` voucher: Ed25519 over the 50-byte message. */
export interface SolanaVoucherVector {
  name: string;
  channel_account_hex: string;
  channel_account_base58: string;
  signer_public_key_hex: string;
  signer_public_key_base58: string;
  max_claimable_amount: string;
  expires_at: number;
  signed_message_hex: string;
  signature_hex: string;
  signature_base58: string;
  json: string;
}

/**
 * The amount-only watermark (ADR 0074 decision 3). The connector's verdict,
 * not the client's: payment-claim validation lives only in the connector.
 */
export interface VoucherWatermarkVector {
  name: string;
  watermark_amount: string;
  watermark_signature_hex: string;
  presented_amount: string;
  presented_signature_hex: string;
  charge: number;
  outcome:
    | 'amount_not_advancing'
    | 'advances'
    | 'retransmission'
    | 'underpayment';
  advanced: string | null;
}

export interface VoucherInvalidVector {
  name: string;
  claim_json: string;
  expected_error: string;
}

export interface ClaimVoucherVectors {
  evm: EvmVoucherVector;
  /** An EVM voucher above `u64::MAX`: 2^64 (connector#1439). */
  evm_above_u64_max: EvmVoucherVector;
  solana: SolanaVoucherVector;
  amount_only_watermark: VoucherWatermarkVector[];
  invalid: VoucherInvalidVector[];
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
  /**
   * Partly replayed: the OER packet bytes and the vouchers it pins are the
   * client edge's wire too. See {@link PeerCarriageVectors}.
   */
  peer_carriage?: PeerCarriageVectors;
  /** Replayed against `src/connector/self-description.ts`'s `chargeFor`. */
  charge?: { cases: ChargeVector[] };
  /** Replayed against `src/channel/batch-settlement/` (connector ADR 0074). */
  claim_voucher?: ClaimVoucherVectors;
  /** Replayed against `src/channel/batch-settlement/challenge.ts` (ADR 0075). */
  voucher_claim_state_challenge?: {
    evm: EvmChallengeVector[];
    solana: SolanaChallengeVector[];
  };
  /** The BTP auth `channelChallenge`, replayed against the same module. */
  client_auth_channel_challenge?: {
    now: number;
    max_lifetime_secs: number;
    evm: AuthChallengeVector[];
    solana: AuthChallengeVector[];
  };
  /** Claims the connector refuses by name; this client must never build one. */
  toon_channel_refused?: { cases: { name: string; claim_json: string }[] };
  /** Claim-state entries refused by name; likewise never built here. */
  claim_state_toon_channel_refused?: {
    cases: {
      name: string;
      request_entry_json: string;
      response_entry_json: string;
    }[];
  };
  /** What a connector pays a client with; not replayed — this client is payer-only. */
  payout_voucher?: unknown;
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
  'peer_carriage',
  'charge',
  'claim_voucher',
  'voucher_claim_state_challenge',
  'toon_channel_refused',
  'payout_voucher',
  'client_auth_channel_challenge',
  'claim_state_toon_channel_refused',
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
