/**
 * NIP-34 event parsers for Forge-UI.
 *
 * Parses kind:30617 repository announcement events into RepoMetadata
 * for rendering in the repository list.
 */

/**
 * Parsed repository metadata from a kind:30617 event.
 */
export interface RepoMetadata {
  /** Repository name (from `name` tag, falling back to `d` tag) */
  name: string;
  /** Repository description (from `description` tag or content) */
  description: string;
  /** Owner pubkey (hex) */
  ownerPubkey: string;
  /** Default branch (from `r` tag with HEAD marker) */
  defaultBranch: string;
  /** Event ID */
  eventId: string;
  /** Clone URLs (from `clone` tags) */
  cloneUrls: string[];
  /** Web URLs (from `web` tags) */
  webUrls: string[];
}

/**
 * Minimal NostrEvent interface for browser use (avoids importing nostr-tools).
 */
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
 * Nostr subscription filter.
 */
export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  '#d'?: string[];
  limit?: number;
}

/**
 * Get the first value for a tag name.
 */
function getTagValue(tags: string[][], name: string): string | undefined {
  const tag = tags.find((t) => t[0] === name);
  return tag?.[1];
}

/**
 * Get all values for a tag name.
 */
function getTagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((t) => t[0] === name)
    .map((t) => t[1])
    .filter((v): v is string => v !== undefined);
}

/**
 * Parse a kind:30617 repository announcement event into RepoMetadata.
 *
 * @param event - A NostrEvent (expected kind:30617)
 * @returns RepoMetadata if valid, null if malformed
 */
export function parseRepoAnnouncement(event: NostrEvent): RepoMetadata | null {
  // Validate kind
  if (event.kind !== 30617) {
    return null;
  }

  // d tag is required (NIP-33 parameterized replaceable event identifier)
  const dTag = getTagValue(event.tags, 'd');
  if (!dTag) {
    return null;
  }

  // Name: prefer `name` tag, fall back to `d` tag
  const name = getTagValue(event.tags, 'name') ?? dTag;

  // Description: prefer `description` tag, fall back to content
  const description = getTagValue(event.tags, 'description') ?? event.content;

  // Default branch: extracted from `r` tag with HEAD marker
  // Format: ["r", "HEAD", "main"]
  const refTag = event.tags.find(
    (t) => t[0] === 'r' && t[1] === 'HEAD' && t[2]
  );
  const defaultBranch = refTag?.[2] ?? 'main';

  // Clone URLs
  const cloneUrls = getTagValues(event.tags, 'clone');

  // Web URLs
  const webUrls = getTagValues(event.tags, 'web');

  return {
    name,
    description,
    ownerPubkey: event.pubkey,
    defaultBranch,
    eventId: event.id,
    cloneUrls,
    webUrls,
  };
}
