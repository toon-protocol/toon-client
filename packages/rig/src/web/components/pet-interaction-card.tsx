/**
 * PetInteractionCard component
 *
 * Displays a summary of a parsed Kind 14919 pet interaction event,
 * including the action performed, proof status badge, brain hash,
 * and final stat values when available.
 *
 * @module components/pet-interaction-card
 */

import { ProofStatusBadge } from './proof-status-badge.js';
import { getActionName, getStageName, truncateBrainHash } from '@/lib/pet-utils';
import { cn } from '@/lib/utils';
import type { PetInteractionEventData } from '@toon-protocol/client';

interface PetInteractionCardProps {
  event: PetInteractionEventData;
  className?: string;
}

/**
 * Card displaying a pet interaction event with its ZK proof status.
 */
export function PetInteractionCard({ event, className }: PetInteractionCardProps) {
  const actionName = getActionName(event.actionType);
  const stageName = getStageName(event.stage);
  const shortHash = truncateBrainHash(event.brainHash);

  return (
    <div
      className={cn('rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm', className)}
    >
      {/* Header row: action + proof badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{actionName}</span>
          <span className="text-xs text-muted-foreground">
            Cycle {event.cycle} · {stageName}
          </span>
        </div>
        <ProofStatusBadge proofStatus={event.proofStatus} />
      </div>

      {/* Brain hash */}
      <div className="mt-2 font-mono text-xs text-muted-foreground" title={event.brainHash}>
        Hash: {shortHash}
      </div>

      {/* Final stats (when content is available) */}
      {event.content !== null && (
        <div className="mt-3 grid grid-cols-5 gap-1 text-center text-xs">
          {(
            [
              ['Hunger', event.content.finalStats.hunger],
              ['Happy', event.content.finalStats.happiness],
              ['Health', event.content.finalStats.health],
              ['Hygiene', event.content.finalStats.hygiene],
              ['Energy', event.content.finalStats.energy],
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col items-center">
              <span className="font-medium">{value}</span>
              <span className="text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      )}

      {/* Mina TX (when proven) */}
      {event.minaTx !== undefined && (
        <div className="mt-2 font-mono text-xs text-muted-foreground">
          Mina: {event.minaTx}
        </div>
      )}
    </div>
  );
}
