/**
 * EVM rolling-swap **v2** balance-proof claim digest (EIP-712 domain-separated).
 *
 * Refs connector#324 **finding #1** / connector#325 (canonical spec:
 * `docs/rolling-swap-v2-digest-spec.md`). This is the client's byte-for-byte
 * conformance anchor for the v2 migration.
 *
 * ## Why this exists in the client
 *
 * The v1 digest that shipped in `@toon-protocol/core` `balanceProofHashEvm`
 * (imported transitively by the sdk's `verifyAccumulatedClaim` /
 * `buildSettlementTx`, which is what this repo used to lean on) was
 *
 *     keccak256( channelId(32) || cumulativeAmount(32BE)
 *                 || nonce(32BE) || recipient(20) )
 *
 * — it bound **neither** `chainId` **nor** the settling contract address, so a
 * signer-signed claim redeemed on one (chain, deployment) could be replayed
 * verbatim on another for the same tuple (cross-chain / cross-deployment
 * replay). v2 folds `chainId` **and** `verifyingContract` into the signed
 * preimage via a standard **EIP-712** typed-data domain, so a signature is
 * valid on **exactly one `(chainId, contract)` pair**, and the `version="2"`
 * string makes the cutover fail-closed (a v1 raw-keccak sig can never validate
 * as v2 and vice-versa).
 *
 * ## Lockstep dependency
 *
 * The canonical v2 digest util lives in `@toon-protocol/core`
 * (`balanceProofHashEvm` → EIP-712) + `@toon-protocol/sdk`
 * (`verifyAccumulatedClaim` / `buildSettlementTx`). Those packages migrate in
 * lockstep (connector#324 release order: core/sdk → swap → client). Until a v2
 * core/sdk is published, this module is the client's own v2 digest so the
 * receive-side verify (see {@link file://./received-claims.ts}) is already
 * domain-separated and the golden-vector conformance test
 * (`evm-claim-digest.test.ts`) pins the exact literals from the spec. When the
 * v2 core/sdk ships, the recompute here should delegate to it (or be asserted
 * byte-identical to it) — the golden-vector test stays as the shared fixture.
 *
 * The signer leg (`swap` `EvmPaymentChannelSigner.signBalanceProof`) MUST also
 * move to this same EIP-712 preimage and now REQUIRES `chainId` +
 * `verifyingContract` inputs it did not take before.
 */

import {
  hashTypedData,
  type Hex,
  type Address,
  type TypedDataDomain,
} from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

/** EIP-712 domain `name` for the RollingSwapChannel (spec §2.1). */
export const ROLLING_SWAP_DOMAIN_NAME = 'RollingSwapChannel' as const;
/** EIP-712 domain `version` — `"2"` is the domain-separated migration. */
export const ROLLING_SWAP_DOMAIN_VERSION = '2' as const;

/**
 * `keccak256("ClaimBalanceProof(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce,address recipient)")`.
 * Pinned from the spec; asserted in `evm-claim-digest.test.ts`.
 */
export const CLAIM_TYPEHASH =
  '0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91' as const;
/**
 * `keccak256("CooperativeClose(bytes32 channelId,uint256 cumulativeAmount,uint256 nonce)")`.
 * Pinned from the spec; asserted in `evm-claim-digest.test.ts`.
 */
export const COOP_CLOSE_TYPEHASH =
  '0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f' as const;

const CLAIM_TYPES = {
  ClaimBalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

const COOP_CLOSE_TYPES = {
  CooperativeClose: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** The two chain-context inputs v2 adds over v1 (the domain binding). */
export interface EvmClaimDomainContext {
  /** Settlement chain id (`block.chainid` on-chain). e.g. `8453` for Base. */
  chainId: number;
  /** Deployed `RollingSwapChannel` address (`address(this)` / EIP-712 `verifyingContract`). */
  verifyingContract: string;
}

/** Fields of the `ClaimBalanceProof` message (the balance-proof claim leg). */
export interface EvmClaimMessage {
  /** Channel id, 0x-prefixed 32-byte hex. */
  channelId: string;
  /** Cumulative transferred amount (target micro-units). */
  cumulativeAmount: bigint;
  /** Monotonic balance-proof nonce. */
  nonce: bigint;
  /** Recipient (the claim payout address), 0x-prefixed 20-byte hex. */
  recipient: string;
}

/** Fields of the `CooperativeClose` message (recipient close-ack leg). */
export interface EvmCooperativeCloseMessage {
  channelId: string;
  cumulativeAmount: bigint;
  nonce: bigint;
}

/**
 * viem validates EIP-712 `address` fields against their checksum; the wire
 * carries non-checksummed hex (e.g. an all-lowercase or all-uppercase
 * recipient). The address BYTES are what EIP-712 encodes, so lowercasing is a
 * no-op on the digest while side-stepping the checksum guard.
 */
function normalizeAddress(addr: string): Address {
  return addr.toLowerCase() as Address;
}

function domainOf(ctx: EvmClaimDomainContext): TypedDataDomain {
  return {
    name: ROLLING_SWAP_DOMAIN_NAME,
    version: ROLLING_SWAP_DOMAIN_VERSION,
    chainId: ctx.chainId,
    verifyingContract: normalizeAddress(ctx.verifyingContract),
  };
}

/**
 * The v2 EIP-712 claim digest — `keccak256(0x1901 || domainSeparator ||
 * hashStruct(ClaimBalanceProof))` — that the on-chain `updateBalance` verifier
 * (and the swap signer) produce. This is what a received claim's signature must
 * recover against.
 */
export function evmClaimDigest(
  ctx: EvmClaimDomainContext,
  message: EvmClaimMessage
): Hex {
  return hashTypedData({
    domain: domainOf(ctx),
    types: CLAIM_TYPES,
    primaryType: 'ClaimBalanceProof',
    message: {
      channelId: message.channelId as Hex,
      cumulativeAmount: message.cumulativeAmount,
      nonce: message.nonce,
      recipient: normalizeAddress(message.recipient),
    },
  });
}

/**
 * The v2 EIP-712 cooperative-close digest — same domain as the claim, distinct
 * type hash — that a recipient's close-ack signature must recover against.
 */
export function evmCooperativeCloseDigest(
  ctx: EvmClaimDomainContext,
  message: EvmCooperativeCloseMessage
): Hex {
  return hashTypedData({
    domain: domainOf(ctx),
    types: COOP_CLOSE_TYPES,
    primaryType: 'CooperativeClose',
    message: {
      channelId: message.channelId as Hex,
      cumulativeAmount: message.cumulativeAmount,
      nonce: message.nonce,
    },
  });
}

/** A 65-byte `r || s || v` signature, as 0x-hex or raw bytes. */
export type ClaimSignature = Hex | Uint8Array;

/** Byte length of a raw `r||s||v` signature. */
const SIG_BYTES = 65;

function signatureToBytes(sig: ClaimSignature): Uint8Array {
  if (typeof sig !== 'string') return sig;
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig;
  return hexToBytes(hex);
}

/**
 * Recover the EVM address that signed a v2 claim digest. Uses the same
 * `@noble/curves` secp256k1 recovery + keccak address derivation as the sdk's
 * on-chain-matching `recoverEvmSignerAddress`, over the **v2** EIP-712 digest.
 * Enforces the same 65-byte `r||s||v`, `v ∈ {27,28}` envelope the on-chain OZ
 * `ECDSA.recover` accepts (fail-closed on a malformed signature).
 *
 * @returns the recovered address (lowercase 0x-hex).
 * @throws if the signature is not 65 bytes or `v` is not 27/28.
 */
export function recoverEvmClaimSigner(
  ctx: EvmClaimDomainContext,
  message: EvmClaimMessage,
  signature: ClaimSignature
): Address {
  const bytes = signatureToBytes(signature);
  if (bytes.length !== SIG_BYTES) {
    throw new Error(
      `EVM signature must be 65 bytes (r||s||v), got ${bytes.length}`
    );
  }
  const v = bytes[64];
  if (v !== 27 && v !== 28) {
    throw new Error(`EVM signature v must be 27 or 28, got ${v}`);
  }
  const digest = evmClaimDigest(ctx, message).slice(2);
  const recovered = secp256k1.Signature.fromBytes(bytes.slice(0, 64), 'compact')
    .addRecoveryBit(v - 27)
    .recoverPublicKey(hexToBytes(digest));
  const uncompressed = recovered.toBytes(false);
  const addrHash = keccak_256(uncompressed.slice(1));
  return `0x${bytesToHex(addrHash.slice(-20))}` as Address;
}

/** Result of {@link verifyEvmClaimSignature}. Mirrors the sdk verify shape. */
export type EvmClaimVerifyResult =
  | { valid: true; recovered: Address }
  | { valid: false; reason: string };

/**
 * Verify a received EVM balance-proof claim: recover the v2-digest signer and
 * check it equals `expectedSigner` (case-insensitive, per EVM address rules).
 *
 * Result-shaped — never throws; a malformed signature or a mismatch is a
 * `{ valid: false, reason }` so the receive ladder can bucket it fail-closed.
 */
export function verifyEvmClaimSignature(params: {
  ctx: EvmClaimDomainContext;
  message: EvmClaimMessage;
  signature: ClaimSignature;
  expectedSigner: string;
}): EvmClaimVerifyResult {
  let recovered: Address;
  try {
    recovered = recoverEvmClaimSigner(
      params.ctx,
      params.message,
      params.signature
    );
  } catch (err) {
    return {
      valid: false,
      reason: `SIGNATURE_INVALID: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (recovered.toLowerCase() !== params.expectedSigner.toLowerCase()) {
    return {
      valid: false,
      reason: `SIGNER_MISMATCH: recovered ${recovered}, expected ${params.expectedSigner}`,
    };
  }
  return { valid: true, recovered };
}
