/**
 * Shared presentational helpers for the social atoms.
 *
 * Pure, deterministic, no network calls and no new deps — everything is derived
 * from the data already on the event (pubkey, timestamps, content bytes).
 */
import { type FC } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar.js';
import { cn } from '@/lib/utils.js';

/** A small fnv-1a hash → 32-bit unsigned int, stable for a given string. */
function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Two-char initials from a pubkey/npub, for the avatar fallback. */
export function initialsFor(pubkey: string): string {
  const cleaned = pubkey.replace(/^npub1?/i, '') || pubkey;
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * A deterministic gradient + readable foreground for an identity, derived from
 * its pubkey. No network, no persisted state — the same key always renders the
 * same colour, so a feed reads as a set of stable identities. Hue comes from the
 * hash; lightness/chroma are fixed so it stays legible in light and dark.
 */
export function avatarColorsFor(pubkey: string): { from: string; to: string; fg: string } {
  const hue = hashString(pubkey) % 360;
  const hue2 = (hue + 38) % 360;
  return {
    from: `oklch(0.62 0.17 ${hue})`,
    to: `oklch(0.55 0.19 ${hue2})`,
    fg: 'oklch(0.99 0 0)',
  };
}

/**
 * Format a unix timestamp (seconds) as a compact relative label: now, 5m, 3h,
 * 2d, then an absolute month/day for anything older than a week. `nowMs` is
 * injectable for deterministic tests.
 */
export function relativeTime(createdAtSec: number, nowMs: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.floor(nowMs / 1000 - createdAtSec));
  if (deltaSec < 45) return 'now';
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const d = new Date(createdAtSec * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** UTF-8 byte length of a string — the unit pay-to-write fees scale with. */
export function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

/**
 * Identity avatar: profile picture when we have one, otherwise a deterministic
 * gradient fallback with initials. The gradient hue is the only inline style and
 * is derived from the pubkey; everything else rides the design tokens.
 */
export const IdentityAvatar: FC<{
  pubkey: string;
  name?: string | undefined;
  picture?: string | undefined;
  className?: string;
  size?: 'default' | 'sm' | 'lg';
}> = ({ pubkey, name, picture, className, size = 'lg' }) => {
  const colors = avatarColorsFor(pubkey);
  const label = name ?? pubkey;
  return (
    <Avatar size={size} className={cn('shrink-0', className)}>
      {picture ? <AvatarImage src={picture} alt={`${label} avatar`} /> : null}
      <AvatarFallback
        className="font-semibold tracking-tight"
        style={{
          backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})`,
          color: colors.fg,
        }}
      >
        {initialsFor(pubkey)}
      </AvatarFallback>
    </Avatar>
  );
};
