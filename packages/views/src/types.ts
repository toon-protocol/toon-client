/**
 * Shared Nostr primitives for the views layer.
 *
 * These are intentionally self-contained (no `nostr-tools` / `@toon-protocol/core`
 * import) so the package builds in a browser bundle and stays decoupled from the
 * payment-side packages.
 */

/** A signed Nostr event as seen on a relay (read side). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * A Nostr subscription filter (NIP-01). Tag filters use the `#<letter>` form.
 * Kept permissive: any `#x` single-letter tag filter is allowed.
 */
export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  since?: number;
  until?: number;
  limit?: number;
  '#d'?: string[];
  '#e'?: string[];
  '#a'?: string[];
  '#p'?: string[];
  '#t'?: string[];
}

/** Get the first value for a tag name. */
export function getTagValue(tags: string[][], name: string): string | undefined {
  const tag = tags.find((t) => t[0] === name);
  return tag?.[1];
}

/** Get all values for a tag name. */
export function getTagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((t) => t[0] === name)
    .map((t) => t[1])
    .filter((v): v is string => v !== undefined);
}
