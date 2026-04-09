/**
 * ProofStatusBadge component
 *
 * Displays the ZK proof status of a pet interaction as a visual badge.
 * - 'optimistic': pending ZK proof (yellow/outline style with Clock icon)
 * - 'proven': ZK-settled on Mina (primary style with ShieldCheck icon)
 *
 * @module components/proof-status-badge
 */

import { Clock, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProofStatus } from '@toon-protocol/client';

interface ProofStatusBadgeProps extends React.ComponentProps<'span'> {
  proofStatus: ProofStatus;
}

/**
 * Visual badge indicating whether a pet interaction has been ZK-proven on Mina.
 */
export function ProofStatusBadge({ proofStatus, className, ...props }: ProofStatusBadgeProps) {
  if (proofStatus === 'proven') {
    return (
      <Badge
        variant="default"
        className={cn('gap-1 bg-green-600 text-white hover:bg-green-700', className)}
        {...props}
      >
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        ZK Proven
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn('gap-1 border-amber-400 text-amber-600', className)}
      {...props}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      Optimistic
    </Badge>
  );
}
