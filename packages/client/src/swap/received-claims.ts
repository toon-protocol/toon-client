/**
 * Receive-side swap-claim ingestion + verification (toon-client#352, part of
 * the rolling-swap epic toon-meta#145; spec: toon-meta docs/rolling-swap.md
 * §3.2/§9 dependency 1).
 *
 * The deployed client used to accept swapped-in chain-B claims blind: no
 * signature check, no watermark, no persistence — `buildSettlementTx` /
 * `verifyAccumulatedClaim` had zero call sites in this repo. This module is
 * the missing pipeline: every accumulated claim harvested from a swap stream
 * is VERIFIED at receipt time and, only if it passes, persisted as the
 * highest-nonce watermark for its `(chain, channelId)` in a
 * {@link ReceivedClaimStore}. A claim that fails verification is NEVER counted
 * as value received — failures are loud and result-shaped, not thrown.
 *
 * Verification order per claim (cheapest first, every check fail-closed):
 *   1. settlement metadata completeness — a claim missing any of channelId /
 *      nonce / cumulativeAmount / recipient / swapSignerAddress cannot be
 *      settled (`MISSING_SETTLEMENT_METADATA` later) and is bucketed `legacy`
 *      (the pre-rename-peer path, #349) rather than rejected: the existing
 *      loud swap-time warning stays the surface for those.
 *   2. chain consistency — the claim must settle on the session's target chain.
 *   3. recipient — must equal the session `chainRecipient` (EVM
 *      case-insensitive), the anti-substitution check.
 *   4. advertised signer — when the caller supplies the maker's advertised
 *      `swapSignerAddress` (kind:10032 discovery / operator config), the
 *      claim's self-reported signer must match (`SWAP_SIGNER_MISMATCH`,
 *      sdk 2.x vocabulary).
 *   5. signature — against the expected signer (advertised address when given,
 *      else the claim's self-reported one). EVM claims verify against the
 *      **v2 EIP-712 domain-separated** balance-proof digest
 *      (`verifyEvmClaimSignature`, connector#324 finding #1) — the digest binds
 *      `chainId` + `verifyingContract`, so `tokenNetworks[chain]` (the
 *      RollingSwapChannel address) and a numeric chain id are REQUIRED (an EVM
 *      claim without them is rejected `MISSING_CHAIN_CONFIG`, fail-closed).
 *      Solana/Mina keep the sdk `verifyAccumulatedClaim` path (their domain is
 *      folded into the message).
 *   6. signer pinning — a claim may not silently rotate the signer of an
 *      already-persisted watermark for the same channel.
 *   7. nonce/cumulative monotonicity vs the locally persisted watermark —
 *      strictly increasing nonce AND cumulative; the cumulative advance must
 *      cover this packet's `targetAmount` (an under-delivering advance means
 *      the maker short-paid the packet).
 */

import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import {
  verifyAccumulatedClaim,
  type MinaSignerClientLike,
} from '@toon-protocol/sdk';
import type {
  ReceivedClaimEntry,
  ReceivedClaimStore,
} from '../channel/ReceivedClaimStore.js';
import { verifyEvmClaimSignature } from './evm-claim-digest.js';
import { parseEvmChainId } from './settle-received-claims.js';

/** Why a claim was rejected at receipt time. Codes are stable API. */
export type ReceivedClaimRejectionCode =
  | 'CHAIN_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'SWAP_SIGNER_MISMATCH'
  | 'SIGNER_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'MINA_VERIFICATION_UNSUPPORTED'
  | 'UNSUPPORTED_CHAIN'
  | 'NON_MONOTONIC_NONCE'
  | 'NON_MONOTONIC_CUMULATIVE'
  | 'CUMULATIVE_SHORTFALL'
  | 'MISSING_CHAIN_CONFIG'
  | 'MALFORMED_METADATA';

export interface ReceivedClaimRejection {
  claim: AccumulatedClaim;
  code: ReceivedClaimRejectionCode;
  message: string;
}

export interface VerifiedReceivedClaim {
  claim: AccumulatedClaim;
  /** How far this claim advanced the persisted cumulative watermark. */
  watermarkAdvance: bigint;
}

export interface IngestReceivedClaimsParams {
  /** Accumulated claims off a swap stream (`streamSwap().claims`), in order. */
  claims: readonly AccumulatedClaim[];
  /** The session's target chain (`pair.to.chain` of the requested swap). */
  expectedChain: string;
  /** The session's payout address on `expectedChain`. */
  chainRecipient: string;
  /**
   * The maker's ADVERTISED on-chain signer address for `expectedChain`
   * (kind:10032 discovery or operator-supplied). When set, a claim whose
   * self-reported `swapSignerAddress` differs is rejected with
   * `SWAP_SIGNER_MISMATCH` and the signature is verified against THIS address,
   * never the claim's own.
   */
  expectedSignerAddress?: string;
  /**
   * Per-chain settlement contract addresses (the deployed `RollingSwapChannel`
   * / `verifyingContract`), keyed by the FULL chain key (e.g. `evm:base:8453`).
   * Matches the daemon config's `tokenNetworks` map and what
   * `buildSwapSettlements` already threads on the submit side.
   *
   * REQUIRED for EVM claims under the v2 EIP-712 digest (connector#324 finding
   * #1): the claim signature is domain-separated over `(chainId,
   * verifyingContract)`, so an EVM claim whose chain key lacks a `tokenNetworks`
   * entry (or a numeric chain id) is rejected `MISSING_CHAIN_CONFIG` — it cannot
   * be verified fail-closed without the domain. Supplied by the connector/swap
   * session context (the RollingSwapChannel the client settles against). Unused
   * for Solana/Mina claims, which fold their domain into the message itself.
   */
  tokenNetworks?: Record<string, string>;
  /** Durable watermark store; verified claims are persisted here. */
  store: ReceivedClaimStore;
  /** Pre-loaded `mina-signer` client — required to verify `mina:*` claims. */
  minaSignerClient?: MinaSignerClientLike;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface IngestReceivedClaimsResult {
  /** Claims that passed every check and advanced a persisted watermark. */
  verified: VerifiedReceivedClaim[];
  /** Claims that failed verification. NEVER counted as value received. */
  rejected: ReceivedClaimRejection[];
  /**
   * Claims missing settlement metadata (pre-rename / legacy swap peer, #349).
   * Not verified, not persisted, surfaced through the existing swap-time
   * warning — behavior for legacy no-metadata swaps is unchanged.
   */
  legacy: AccumulatedClaim[];
  /** Total watermark advance across verified claims (target micro-units). */
  valueReceived: bigint;
}

/** True when the claim carries every settlement-context field. */
export function hasSettlementMetadata(
  claim: AccumulatedClaim
): claim is AccumulatedClaim &
  Required<
    Pick<
      AccumulatedClaim,
      | 'channelId'
      | 'nonce'
      | 'cumulativeAmount'
      | 'recipient'
      | 'swapSignerAddress'
    >
  > {
  return (
    claim.channelId !== undefined &&
    claim.nonce !== undefined &&
    claim.cumulativeAmount !== undefined &&
    claim.recipient !== undefined &&
    claim.swapSignerAddress !== undefined
  );
}

/** EVM addresses compare case-insensitively; other chains byte-exact. */
function sameAddress(chain: string, a: string, b: string): boolean {
  return chain.startsWith('evm')
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** Map a `verifyAccumulatedClaim` reason string onto a stable rejection code. */
function signatureRejectionCode(reason: string): ReceivedClaimRejectionCode {
  if (reason.startsWith('SIGNER_MISMATCH')) return 'SIGNER_MISMATCH';
  if (reason.startsWith('MINA_VERIFICATION_UNSUPPORTED'))
    return 'MINA_VERIFICATION_UNSUPPORTED';
  if (reason.startsWith('UNSUPPORTED_CHAIN')) return 'UNSUPPORTED_CHAIN';
  return 'SIGNATURE_INVALID';
}

/**
 * Verify a batch of received chain-B claims and persist the winning watermark
 * per `(chain, channelId)`. See the module doc for the check ladder.
 *
 * Result-shaped: never throws on a bad claim — it lands in `rejected` with a
 * stable code, and later claims are still processed (a channel's watermark
 * only advances through claims that verified).
 */
export function ingestReceivedClaims(
  params: IngestReceivedClaimsParams
): IngestReceivedClaimsResult {
  const now = params.now ?? Date.now;
  const verified: VerifiedReceivedClaim[] = [];
  const rejected: ReceivedClaimRejection[] = [];
  const legacy: AccumulatedClaim[] = [];
  let valueReceived = 0n;

  // Session-local watermarks layered over the store so a multi-packet stream
  // is checked claim-against-claim without re-reading the file per packet.
  const watermarks = new Map<string, ReceivedClaimEntry>();
  const reject = (
    claim: AccumulatedClaim,
    code: ReceivedClaimRejectionCode,
    message: string
  ): void => {
    rejected.push({ claim, code, message });
  };

  for (const claim of params.claims) {
    if (!hasSettlementMetadata(claim)) {
      legacy.push(claim);
      continue;
    }
    const chain = claim.pair.to.chain;
    if (chain !== params.expectedChain) {
      reject(
        claim,
        'CHAIN_MISMATCH',
        `claim settles on "${chain}", session expected "${params.expectedChain}"`
      );
      continue;
    }
    if (!sameAddress(chain, claim.recipient, params.chainRecipient)) {
      reject(
        claim,
        'RECIPIENT_MISMATCH',
        `claim recipient "${claim.recipient}" is not the session chainRecipient "${params.chainRecipient}"`
      );
      continue;
    }
    if (
      params.expectedSignerAddress !== undefined &&
      !sameAddress(chain, claim.swapSignerAddress, params.expectedSignerAddress)
    ) {
      reject(
        claim,
        'SWAP_SIGNER_MISMATCH',
        `claim swapSignerAddress "${claim.swapSignerAddress}" does not match the maker's advertised signer "${params.expectedSignerAddress}"`
      );
      continue;
    }
    const expectedSigner =
      params.expectedSignerAddress ?? claim.swapSignerAddress;
    // Signature check. EVM uses the v2 EIP-712 domain-separated digest
    // (connector#324 finding #1): the digest binds `chainId` +
    // `verifyingContract`, so the recovered signer is only valid for the exact
    // (chain, deployment) the claim settles against — closing cross-chain /
    // cross-deployment replay. Solana/Mina fold their domain into the message
    // itself and stay on the sdk `verifyAccumulatedClaim` path.
    let sig: { valid: true } | { valid: false; reason: string };
    if (chain.startsWith('evm')) {
      const chainId = parseEvmChainId(chain);
      const verifyingContract = params.tokenNetworks?.[chain];
      if (chainId === undefined || !verifyingContract) {
        reject(
          claim,
          'MISSING_CHAIN_CONFIG',
          `EVM v2 balance-proof verification for ${chain} needs a numeric chain id in the ` +
            `chain key AND tokenNetworks["${chain}"] (the RollingSwapChannel / verifyingContract) ` +
            `to reconstruct the EIP-712 domain; supply it from the connector/swap session context.`
        );
        continue;
      }
      let msgNonce: bigint;
      let msgCumulative: bigint;
      try {
        msgNonce = BigInt(claim.nonce);
        msgCumulative = BigInt(claim.cumulativeAmount);
      } catch {
        reject(
          claim,
          'MALFORMED_METADATA',
          `nonce "${claim.nonce}" / cumulativeAmount "${claim.cumulativeAmount}" are not decimal integers`
        );
        continue;
      }
      sig = verifyEvmClaimSignature({
        ctx: { chainId, verifyingContract },
        message: {
          channelId: claim.channelId,
          cumulativeAmount: msgCumulative,
          nonce: msgNonce,
          recipient: claim.recipient,
        },
        signature: claim.claimBytes,
        expectedSigner,
      });
    } else {
      sig = verifyAccumulatedClaim(
        claim,
        { address: expectedSigner },
        params.minaSignerClient
      );
    }
    if (!sig.valid) {
      reject(claim, signatureRejectionCode(sig.reason), sig.reason);
      continue;
    }

    let nonce: bigint;
    let cumulativeAmount: bigint;
    try {
      nonce = BigInt(claim.nonce);
      cumulativeAmount = BigInt(claim.cumulativeAmount);
    } catch {
      reject(
        claim,
        'MALFORMED_METADATA',
        `nonce "${claim.nonce}" / cumulativeAmount "${claim.cumulativeAmount}" are not decimal integers`
      );
      continue;
    }

    const wmKey = `${chain}|${claim.channelId}`;
    const watermark =
      watermarks.get(wmKey) ?? params.store.load(chain, claim.channelId);

    if (watermark) {
      if (!sameAddress(chain, watermark.swapSignerAddress, expectedSigner)) {
        reject(
          claim,
          'SWAP_SIGNER_MISMATCH',
          `channel ${claim.channelId} watermark was signed by "${watermark.swapSignerAddress}"; a claim signed by "${expectedSigner}" may not rotate it`
        );
        continue;
      }
      if (nonce <= watermark.nonce) {
        reject(
          claim,
          'NON_MONOTONIC_NONCE',
          `nonce ${nonce} does not advance the persisted watermark nonce ${watermark.nonce} for channel ${claim.channelId}`
        );
        continue;
      }
      if (cumulativeAmount <= watermark.cumulativeAmount) {
        reject(
          claim,
          'NON_MONOTONIC_CUMULATIVE',
          `cumulativeAmount ${cumulativeAmount} does not advance the persisted watermark ${watermark.cumulativeAmount} for channel ${claim.channelId}`
        );
        continue;
      }
    }

    // The watermark advance is the value this claim actually adds. It must
    // cover the packet's expected targetAmount — a smaller advance means the
    // maker short-paid the packet (e.g. re-signed value we already held).
    const advance = cumulativeAmount - (watermark?.cumulativeAmount ?? 0n);
    if (advance < claim.targetAmount) {
      reject(
        claim,
        'CUMULATIVE_SHORTFALL',
        `cumulative advance ${advance} is less than the packet's targetAmount ${claim.targetAmount} for channel ${claim.channelId}`
      );
      continue;
    }

    const entry: ReceivedClaimEntry = {
      chain,
      channelId: claim.channelId,
      nonce,
      cumulativeAmount,
      recipient: claim.recipient,
      swapSignerAddress: expectedSigner,
      claimBytes: claim.claimBytes,
      ...(claim.claimId !== undefined ? { claimId: claim.claimId } : {}),
      pair: claim.pair,
      receivedAt: claim.receivedAt,
      updatedAt: now(),
      // Settlement bookkeeping survives watermark advances.
      ...(watermark?.settledAt !== undefined
        ? { settledAt: watermark.settledAt }
        : {}),
      ...(watermark?.settledNonce !== undefined
        ? { settledNonce: watermark.settledNonce }
        : {}),
      ...(watermark?.settleTxHash !== undefined
        ? { settleTxHash: watermark.settleTxHash }
        : {}),
    };
    params.store.save(entry);
    watermarks.set(wmKey, entry);
    verified.push({ claim, watermarkAdvance: advance });
    valueReceived += advance;
  }

  return { verified, rejected, legacy, valueReceived };
}
