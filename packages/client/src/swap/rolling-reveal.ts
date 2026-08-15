/**
 * Wires an inbound leg-B advance to the verify-before-reveal seam
 * ({@link ingestAndReveal}, toon-client#360) for a LIVE rolling-swap sender
 * (toon-client#573).
 *
 * `ingestAndReveal` composed verify -> persist -> reveal atomically, but
 * nothing ever called it with a `reveal` fn that could actually WITHHOLD:
 * the deployed legacy path resolves leg A inline at `sendSwapPacket` time,
 * so by the time it ran there was nothing left to withhold (see
 * `client-runner.ts`'s `swap()` — `reveal: () => ({ decision: 'revealed' })`).
 * This module is the missing live caller: {@link handleRollingAdvance} parses
 * one maker→sender leg-B PREPARE (a `RollingAdvancePayload`), verifies it,
 * and — ONLY if it verifies — resolves with the packet's retained preimage
 * so the caller can FULFILL leg B. A withheld/failed verification throws,
 * so the caller never learns a preimage to reveal, and the maker's connector
 * never gets one to relay upstream on leg A (spec R5/R8): the coupled unwind
 * this issue makes reachable falls out of the protocol, not extra logic here.
 */

import type { SwapPair } from '@toon-protocol/core';
import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import { fromBase64 } from '../utils/binary.js';
import { parseRollingAdvancePayload, type RollingAdvancePayload } from './rolling-protocol.js';
import { ingestAndReveal, type RevealFn } from './atomic-reveal.js';
import type { IngestReceivedClaimsParams } from './received-claims.js';
import type { PreimageRetentionStore, RetainedPreimage } from './preimage-retention.js';

/** Everything `handleRollingAdvance` needs beyond the advance itself. */
export interface RollingAdvanceContext
  extends Omit<IngestReceivedClaimsParams, 'claims'> {
  /** The session's pair — echoed onto the synthesized `AccumulatedClaim`. */
  pair: SwapPair;
  /** Retained per-packet preimages, keyed by `seq - 1` (see preimage-retention.ts). */
  preimages: PreimageRetentionStore;
}

export interface RollingAdvanceOutcome {
  advance: RollingAdvancePayload;
  claim: AccumulatedClaim;
  /** The retained preimage `P_i` — reveal this to commit leg A (spec R6). */
  fulfillment: Uint8Array;
  /** How far this claim advanced the persisted watermark. */
  watermarkAdvance: bigint;
}

/** Thrown for any advance that must NOT be revealed — malformed, unverified, or withheld. */
export class RollingAdvanceRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RollingAdvanceRejectedError';
  }
}

function advanceToAccumulatedClaim(
  advance: RollingAdvancePayload,
  pair: SwapPair
): AccumulatedClaim {
  return {
    packetIndex: advance.seq - 1,
    sourceAmount: BigInt(advance.sourceAmount),
    targetAmount: BigInt(advance.targetAmount),
    claimBytes: fromBase64(advance.claim),
    // The rolling wire has no gift-wrap ephemeral layer (unlike the legacy
    // path) — this field only informs FULFILL-metadata decoding elsewhere,
    // which the rolling receiver never does, so a placeholder is safe.
    swapEphemeralPubkey: '0'.repeat(64),
    pair,
    receivedAt: Date.now(),
    ...(advance.claimId !== undefined ? { claimId: advance.claimId } : {}),
    ...(advance.channelId !== undefined ? { channelId: advance.channelId } : {}),
    ...(advance.nonce !== undefined ? { nonce: advance.nonce } : {}),
    ...(advance.cumulativeAmount !== undefined
      ? { cumulativeAmount: advance.cumulativeAmount }
      : {}),
    ...(advance.recipient !== undefined ? { recipient: advance.recipient } : {}),
    ...(advance.swapSignerAddress !== undefined
      ? { swapSignerAddress: advance.swapSignerAddress }
      : {}),
    rate: advance.rate,
    rateTimestamp: advance.rateTimestamp,
  };
}

/**
 * Parse, verify, and (only on success) reveal one leg-B advance.
 *
 * @throws {RollingAdvanceRejectedError} the payload is not a well-formed
 *   rolling advance, verification failed, or no preimage was retained for
 *   its `seq` (e.g. a replayed/unknown packet) — in every case the caller
 *   MUST NOT fulfill leg B.
 */
export async function handleRollingAdvance(
  data: Uint8Array,
  ctx: RollingAdvanceContext
): Promise<RollingAdvanceOutcome> {
  const advance = parseRollingAdvancePayload(data);
  if (!advance) {
    throw new RollingAdvanceRejectedError(
      'malformed or non-rolling leg-B advance payload'
    );
  }

  let revealedPreimage: RetainedPreimage | undefined;
  const reveal: RevealFn = (_claim, preimage) => {
    if (!preimage) {
      return {
        decision: 'withheld',
        reason: `no retained preimage for seq ${advance.seq}`,
      };
    }
    revealedPreimage = preimage;
    return { decision: 'revealed' };
  };

  const claim = advanceToAccumulatedClaim(advance, ctx.pair);
  const { preimages, pair: _pair, ...ingestParams } = ctx;
  const result = await ingestAndReveal({
    ...ingestParams,
    claims: [claim],
    preimages,
    reveal,
  });

  const rejection = result.rejected[0];
  if (rejection) {
    throw new RollingAdvanceRejectedError(
      `leg-B claim verification failed: ${rejection.code} — ${rejection.message}`
    );
  }
  const rolledBack = result.rolledBack[0];
  if (rolledBack) {
    throw new RollingAdvanceRejectedError(
      `leg-B claim verified but reveal was withheld: ${rolledBack.reason}`
    );
  }
  const revealed = result.revealed[0];
  if (!revealed || !revealedPreimage) {
    throw new RollingAdvanceRejectedError(
      'leg-B advance carried no verifiable settlement metadata'
    );
  }

  return {
    advance,
    claim,
    fulfillment: revealedPreimage.preimage,
    watermarkAdvance: revealed.watermarkAdvance,
  };
}
