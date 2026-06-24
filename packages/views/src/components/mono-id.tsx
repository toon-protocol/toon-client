/**
 * MonoId — renders a protocol address (pubkey, event ID, channel ID) as a
 * bold·dim·bold split so the head and tail read as distinct identity markers.
 *
 *   npub1abc1234…ef56  →  [bold: npub1abc] [dim: …] [bold: ef56]
 */
import * as React from 'react';
import { cn } from '@/lib/utils.js';

interface MonoIdProps {
  value: string;
  prefixLen?: number;
  suffixLen?: number;
  className?: string;
}

export function MonoId({ value, prefixLen = 8, suffixLen = 4, className }: MonoIdProps) {
  if (value.length <= prefixLen + suffixLen + 1) {
    return <span className={cn('font-mono text-xs', className)}>{value}</span>;
  }
  const prefix = value.slice(0, prefixLen);
  const suffix = value.slice(-suffixLen);
  return (
    <span className={cn('font-mono text-xs', className)}>
      <span className="font-semibold">{prefix}</span>
      <span className="text-muted-foreground select-none">…</span>
      <span className="font-semibold">{suffix}</span>
    </span>
  );
}
