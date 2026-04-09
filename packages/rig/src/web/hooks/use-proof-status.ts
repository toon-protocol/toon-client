/**
 * useProofStatus hook
 *
 * Aggregates proof status counts from an array of parsed Kind 14919 events.
 * Pure computation — no side effects or subscriptions.
 *
 * @module hooks/use-proof-status
 */

import { useMemo } from 'react';
import type { PetInteractionEventData } from '@toon-protocol/client';

export interface ProofStatusSummary {
  optimisticCount: number;
  provenCount: number;
  total: number;
}

/**
 * Computes proof status counts from a list of pet interaction events.
 *
 * @param events - Parsed Kind 14919 event data
 * @returns Counts of optimistic, proven, and total interactions
 */
export function useProofStatus(
  events: PetInteractionEventData[]
): ProofStatusSummary {
  return useMemo(() => {
    let optimisticCount = 0;
    let provenCount = 0;

    for (const event of events) {
      if (event.proofStatus === 'proven') {
        provenCount++;
      } else {
        optimisticCount++;
      }
    }

    return { optimisticCount, provenCount, total: events.length };
  }, [events]);
}
