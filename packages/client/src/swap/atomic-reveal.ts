/**
 * Atomic verify -> persist -> reveal composition (toon-client#360, rolling-swap
 * epic toon-meta#145 — spec `docs/rolling-swap.md` §3 R5/R8, §3.2 leg-B reveal).
 *
 * {@link ingestReceivedClaims} (toon-client#358) verifies a received chain-B
 * claim and persists its watermark AT VERIFY TIME. But verification is not the
 * commit: leg-B reveal is (spec R5 — the sender reveals `P_i` only after the
 * claim verifies). A daemon that verifies a claim, advances the watermark, and
 * then WITHHOLDS or FAILS the reveal has advanced a watermark for value it never
 * committed to. Left there, engine rule R8 bites: after the maker rolls its own
 * side back it REUSES the rolled-back nonce for the next fill, and the client's
 * monotonicity check (`nonce <= watermark.nonce -> NON_MONOTONIC_NONCE`) would
 * falsely reject that legitimate re-fill.
 *
 * So verify/persist/reveal must compose as ONE unit whose durable effect is
 * "watermark advanced iff the reveal committed":
 *
 *   1. snapshot the prior watermark for the claim's `(chain, channelId)`;
 *   2. verify + persist via {@link ingestReceivedClaims} (single claim);
 *   3. reveal the retained preimage `P_i` for `claim.packetIndex`;
 *   4. on `withheld` / thrown / preimage-missing -> COMPENSATING ROLLBACK:
 *      restore the snapshot (or delete when there was none), so the watermark
 *      tracks only ACCEPTED/REVEALED packets and R8's reused nonce is accepted.
 *
 * Claims are processed strictly in order and each claim's fate is decided
 * before the next is verified, so cross-claim monotonicity flows through the
 * durable store: a rolled-back claim leaves no trace for the next to trip over.
 * Legacy no-metadata claims (spec §349 path) and hard verification rejects
 * never reach a reveal and never touch a watermark — behavior unchanged.
 */

import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import {
  ingestReceivedClaims,
  hasSettlementMetadata,
  type IngestReceivedClaimsParams,
  type ReceivedClaimRejection,
} from './received-claims.js';
import type { ReceivedClaimEntry } from '../channel/ReceivedClaimStore.js';
import type {
  PreimageRetentionStore,
  RetainedPreimage,
} from './preimage-retention.js';

/** The sender's leg-B decision for a verified claim (spec R5). */
export type RevealDecision = 'revealed' | 'withheld';

export interface RevealResult {
  decision: RevealDecision;
  /** Human-readable detail, surfaced on a rolled-back record when withheld. */
  reason?: string;
}

/**
 * Reveal a verified claim's preimage to commit leg A, OR withhold it. Receives
 * the claim and the retained preimage for its `packetIndex` (`undefined` when
 * none was retained — e.g. a legacy zero-condition packet reaching this path).
 * Returning `withheld`, resolving to no decision, or THROWING all trigger the
 * compensating rollback; only `revealed` keeps the watermark advance.
 */
export type RevealFn = (
  claim: AccumulatedClaim,
  preimage: RetainedPreimage | undefined
) => RevealResult | Promise<RevealResult>;

export interface IngestAndRevealParams extends IngestReceivedClaimsParams {
  /** Leg-B reveal decision, invoked once per VERIFIED claim (spec R5/R6). */
  reveal: RevealFn;
  /**
   * Retained per-packet preimages ({@link PreimageRetentionStore}). The reveal
   * for a verified claim CONSUMES (`take`) the preimage for its `packetIndex`,
   * so a preimage is never revealed twice (spec R1). Optional: without it the
   * reveal fn receives `undefined` and decides on its own.
   */
  preimages?: PreimageRetentionStore;
}

export interface RevealedClaim {
  claim: AccumulatedClaim;
  /** How far the (now committed) watermark advanced. */
  watermarkAdvance: bigint;
}

export interface RolledBackClaim {
  claim: AccumulatedClaim;
  /** The advance that was persisted then rolled back (never counted). */
  watermarkAdvance: bigint;
  /** Why the reveal did not commit (withheld reason, or the thrown error). */
  reason: string;
}

export interface IngestAndRevealResult {
  /** Claims that verified AND revealed — the only ones whose value counts. */
  revealed: RevealedClaim[];
  /**
   * Claims that verified but whose reveal was withheld/failed: the watermark
   * advance was persisted then ROLLED BACK, so a subsequent re-fill reusing
   * the same nonce (engine R8) is accepted, not falsely rejected.
   */
  rolledBack: RolledBackClaim[];
  /** Claims that failed verification. NEVER revealed, NEVER persisted. */
  rejected: ReceivedClaimRejection[];
  /** Legacy no-metadata claims (spec §349). Unchanged: not verified/revealed. */
  legacy: AccumulatedClaim[];
  /** Total watermark advance across REVEALED claims only. */
  valueRevealed: bigint;
}

/**
 * Restore the watermark to `prior` (or delete it when the channel had none),
 * compensating a verify-time persist whose reveal did not commit.
 */
function rollbackWatermark(
  store: IngestReceivedClaimsParams['store'],
  chain: string,
  channelId: string,
  prior: ReceivedClaimEntry | undefined
): void {
  if (prior === undefined) {
    store.delete(chain, channelId);
  } else {
    store.save(prior);
  }
}

/**
 * Verify, persist, and reveal a batch of received chain-B claims atomically:
 * a verified claim's watermark advance survives iff its reveal commits, and is
 * rolled back otherwise (see the module doc for why R8 needs this).
 *
 * Never throws on a bad claim or a throwing reveal — both land in the result
 * (`rejected` / `rolledBack`) with the durable watermark left consistent.
 */
export async function ingestAndReveal(
  params: IngestAndRevealParams
): Promise<IngestAndRevealResult> {
  const { reveal, preimages, claims, store, ...shared } = params;

  const revealed: RevealedClaim[] = [];
  const rolledBack: RolledBackClaim[] = [];
  const rejected: ReceivedClaimRejection[] = [];
  const legacy: AccumulatedClaim[] = [];
  let valueRevealed = 0n;

  for (const claim of claims) {
    // Verify + persist this one claim against the CURRENT durable watermark.
    // Single-claim so each claim's fate is sealed (revealed or rolled back)
    // before the next is checked — rollback leaves nothing for the next claim.
    //
    // A metadata-less (legacy) claim has no `(chain, channelId)` — and its
    // `pair.to` may be absent — so only snapshot when metadata is present, and
    // never dereference `pair.to.chain` before that guard.
    const hasMeta = hasSettlementMetadata(claim);
    const chain = hasMeta ? claim.pair.to.chain : undefined;
    const channelId = hasMeta ? claim.channelId : undefined;
    // Snapshot BEFORE persist so a withheld reveal can be compensated exactly.
    const prior =
      chain !== undefined && channelId !== undefined
        ? store.load(chain, channelId)
        : undefined;

    const ingest = ingestReceivedClaims({ ...shared, claims: [claim], store });

    if (ingest.legacy.length > 0) {
      legacy.push(claim);
      continue;
    }
    const rejection = ingest.rejected[0];
    if (rejection) {
      // Hard verification failure: nothing was persisted, nothing to reveal.
      rejected.push(rejection);
      continue;
    }

    const verified = ingest.verified[0];
    // A metadata-carrying claim that went neither legacy nor rejected verified
    // and was persisted, so `verified`, `chain`, and `channelId` are defined.
    // The guard is belt-and-suspenders for the type-checker and future changes.
    if (!verified || chain === undefined || channelId === undefined) continue;
    const advance = verified.watermarkAdvance;
    const preimage = preimages?.take(claim.packetIndex);

    let outcome: RevealResult;
    try {
      outcome = await reveal(claim, preimage);
    } catch (err) {
      outcome = {
        decision: 'withheld',
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.decision === 'revealed') {
      revealed.push({ claim, watermarkAdvance: advance });
      valueRevealed += advance;
      continue;
    }

    // Withheld / failed: compensate the verify-time persist so the watermark
    // reflects only revealed packets (engine R8 — the maker reuses the nonce).
    rollbackWatermark(store, chain, channelId, prior);
    rolledBack.push({
      claim,
      watermarkAdvance: advance,
      reason: outcome.reason ?? 'reveal withheld',
    });
  }

  return { revealed, rolledBack, rejected, legacy, valueRevealed };
}
