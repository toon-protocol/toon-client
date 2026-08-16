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
import {
  parseRollingAdvancePayload,
  type RollingAdvancePayload,
} from './rolling-protocol.js';
import { ingestAndReveal, type RevealFn } from './atomic-reveal.js';
import type { IngestReceivedClaimsParams } from './received-claims.js';
import type {
  PreimageRetentionStore,
  RetainedPreimage,
} from './preimage-retention.js';

/** Everything `handleRollingAdvance` needs beyond the advance itself. */
export interface RollingAdvanceContext extends Omit<
  IngestReceivedClaimsParams,
  'claims'
> {
  /** The session's pair — echoed onto the synthesized `AccumulatedClaim`. */
  pair: SwapPair;
  /** Retained per-packet preimages, keyed by `seq - 1` (see preimage-retention.ts). */
  preimages: PreimageRetentionStore;
  /**
   * Session floor on the per-fill exchange rate (spec §5:
   * `minExchangeRate = R₀ × (1 − tolerance)`, armed once from the RFQ quote's
   * `R₀` and never moved). Decimal string in `SwapPair.rate` units — target
   * WHOLE-units per source whole-unit.
   *
   * Checked here rather than after the fact because THIS is the commit act:
   * an advance quoting `R_i` below the floor, or delivering less than the
   * floor entitles, is WITHHELD — the preimage is never revealed, so leg A
   * stays unfulfilled and the sender pays nothing (spec R5/R8). On the legacy
   * path the equivalent check can only halt the *next* packet, because leg A
   * has already resolved by the time the claim is read.
   *
   * Unset (the default) reproduces the pre-#585 behaviour exactly: rate is
   * recorded on the claim but never enforced.
   */
  minExchangeRate?: string;
}

/** A decimal string as an exact (digits, scale) pair — no float round-trip. */
function parseDecimal(v: string): { digits: bigint; scale: number } | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const [, intDigits = '', fracDigits = ''] = m;
  return { digits: BigInt(intDigits + fracDigits), scale: fracDigits.length };
}

/** `a < b` for two plain positive decimal strings, exactly. */
function decimalLessThan(a: string, b: string): boolean | undefined {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (!da || !db) return undefined;
  const scale = Math.max(da.scale, db.scale);
  const lift = (d: { digits: bigint; scale: number }): bigint =>
    d.digits * 10n ** BigInt(scale - d.scale);
  return lift(da) < lift(db);
}

/**
 * The minimum target micro-units `sourceAmount` is entitled to at `floorRate`.
 *
 * `floorRate` is in WHOLE units both sides, so the micro-unit conversion is
 * `⌊source × rate × 10^(toScale − fromScale)⌋` — done in BigInt so a 1e18-scale
 * chain cannot lose precision through a double.
 */
function floorTargetAmount(
  sourceAmount: bigint,
  floorRate: string,
  pair: SwapPair
): bigint | undefined {
  const rate = parseDecimal(floorRate);
  if (!rate) return undefined;
  const scaleShift = pair.to.assetScale - pair.from.assetScale;
  let numerator = sourceAmount * rate.digits;
  let denominator = 10n ** BigInt(rate.scale);
  if (scaleShift >= 0) numerator *= 10n ** BigInt(scaleShift);
  else denominator *= 10n ** BigInt(-scaleShift);
  return numerator / denominator;
}

/**
 * Why an advance fails the session floor, or `undefined` when it clears it.
 * Both halves of the sdk's `minExchangeRate` contract are enforced: the
 * maker's own quote tape AND what it actually delivered — an honest rate with
 * a short claim is the same loss as a dishonest rate.
 */
function belowFloor(
  advance: RollingAdvancePayload,
  ctx: RollingAdvanceContext
): string | undefined {
  const floor = ctx.minExchangeRate;
  if (floor === undefined) return undefined;
  if (decimalLessThan(advance.rate, floor) === true) {
    return `quoted rate ${advance.rate} is below the session floor ${floor}`;
  }
  let sourceAmount: bigint;
  let targetAmount: bigint;
  try {
    sourceAmount = BigInt(advance.sourceAmount);
    targetAmount = BigInt(advance.targetAmount);
  } catch {
    return `advance amounts are not integers (source ${advance.sourceAmount}, target ${advance.targetAmount})`;
  }
  const entitled = floorTargetAmount(sourceAmount, floor, ctx.pair);
  if (entitled !== undefined && targetAmount < entitled) {
    return `delivered ${targetAmount} for ${sourceAmount} — below the ${entitled} the session floor ${floor} entitles`;
  }
  return undefined;
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
    ...(advance.channelId !== undefined
      ? { channelId: advance.channelId }
      : {}),
    ...(advance.nonce !== undefined ? { nonce: advance.nonce } : {}),
    ...(advance.cumulativeAmount !== undefined
      ? { cumulativeAmount: advance.cumulativeAmount }
      : {}),
    ...(advance.recipient !== undefined
      ? { recipient: advance.recipient }
      : {}),
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
    // Floor FIRST: a below-floor advance must be withheld even when a
    // preimage is retained for it (spec §5/R5) — this is the last moment the
    // sender can decline, and declining costs it nothing.
    const floorFailure = belowFloor(advance, ctx);
    if (floorFailure !== undefined) {
      return { decision: 'withheld', reason: floorFailure };
    }
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
  const {
    preimages,
    pair: _pair,
    minExchangeRate: _minExchangeRate,
    ...ingestParams
  } = ctx;
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
