/**
 * Pet Listing Parser (Kind 30402)
 *
 * Parses Kind 30402 (NIP-99 classified listing) Nostr events into
 * typed PetListing objects. Returns null for invalid or malformed events.
 *
 * Browser-compatible — no Node.js-only imports.
 *
 * @module pet/parsePetListing
 */

import type { PetListing, StatValues } from './types.js';

/** Regex for 64-char lowercase hex strings */
const HEX_64_RE = /^[0-9a-f]{64}$/i;

/** Minimal Nostr event shape required for parsing */
interface NostrEventLike {
  id: string;
  kind: number;
  pubkey: string;
  tags: string[][];
  content: string;
  created_at: number;
}

/**
 * Extract the first value for a given tag name from a tags array.
 * Uses noUncheckedIndexedAccess-safe bracket notation.
 */
function getTagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name) {
      return tag[1];
    }
  }
  return undefined;
}

/**
 * Default StatValues used when listing content is unparseable.
 * Note: values are 0 (outside the normal [1,100] game range) — this is
 * intentional as a sentinel for "stats unknown / content malformed".
 * Consumers should check for all-zero stats and display accordingly.
 */
const DEFAULT_STATS: StatValues = {
  hunger: 0,
  happiness: 0,
  health: 0,
  hygiene: 0,
  energy: 0,
};

/**
 * Attempt to parse content JSON into StatValues.
 * Returns DEFAULT_STATS if content is missing or malformed.
 */
function parseStats(content: string): StatValues {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_STATS;
    const r = parsed as Record<string, unknown>;
    if (
      typeof r['hunger'] === 'number' &&
      typeof r['happiness'] === 'number' &&
      typeof r['health'] === 'number' &&
      typeof r['hygiene'] === 'number' &&
      typeof r['energy'] === 'number'
    ) {
      return {
        hunger: r['hunger'],
        happiness: r['happiness'],
        health: r['health'],
        hygiene: r['hygiene'],
        energy: r['energy'],
      };
    }
    return DEFAULT_STATS;
  } catch {
    return DEFAULT_STATS;
  }
}

/**
 * Parse a Kind 30402 pet classified listing event into a PetListing.
 *
 * Validation rules:
 * - event.kind must be 30402
 * - 'd' tag must be present and non-empty
 * - 'price' tag must be present with a valid positive numeric first element
 * - 'lifecycle_hash' tag must be a 64-char hex string
 * - 'total_spent' tag must be a valid non-negative numeric string
 * - 'stage' tag must be present
 *
 * Stats are parsed from content JSON; unparseable content falls back to DEFAULT_STATS.
 *
 * @param event - A Nostr event (expected Kind 30402)
 * @returns Parsed PetListing or null if invalid
 */
export function parsePetListing(event: NostrEventLike): PetListing | null {
  // Kind check
  if (event.kind !== 30402) return null;

  const { tags } = event;

  // Required: 'd' tag (blobbiId)
  const blobbiId = getTagValue(tags, 'd');
  if (!blobbiId || blobbiId.trim() === '') return null;

  // Required: 'price' tag — must have at least 2 elements, first must be positive numeric
  let askPriceUsdc = 0;
  let foundPrice = false;
  for (const tag of tags) {
    if (tag[0] === 'price') {
      const priceStr = tag[1];
      if (priceStr === undefined) return null;
      const parsed = Number(priceStr);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      askPriceUsdc = parsed;
      foundPrice = true;
      break;
    }
  }
  if (!foundPrice) return null;

  // Required: 'lifecycle_hash' tag — must be 64-char hex
  const lifecycleHash = getTagValue(tags, 'lifecycle_hash');
  if (!lifecycleHash) return null;
  if (!HEX_64_RE.test(lifecycleHash)) return null;

  // Required: 'total_spent' tag — must be a valid non-negative numeric string
  const totalSpent = getTagValue(tags, 'total_spent');
  if (totalSpent === undefined || totalSpent === '') return null;
  const totalSpentNum = Number(totalSpent);
  if (!Number.isFinite(totalSpentNum) || totalSpentNum < 0) return null;

  // Required: 'stage' tag
  const stageStr = getTagValue(tags, 'stage');
  if (stageStr === undefined) return null;
  const stage = Number(stageStr);
  if (!Number.isFinite(stage)) return null;

  // Optional tags
  const sellerPubkey = getTagValue(tags, 'p') ?? '';
  const relayUrl = getTagValue(tags, 'relay') ?? '';
  const expiresAtStr = getTagValue(tags, 'expiration');
  const expiresAt = expiresAtStr !== undefined ? Number(expiresAtStr) : 0;

  // Parse stats from content (null-safe)
  const stats = parseStats(event.content);

  return {
    blobbiId,
    askPriceUsdc,
    lifecycleHash,
    totalSpent,
    stage,
    stats,
    sellerPubkey,
    relayUrl,
    expiresAt,
    eventId: event.id,
    createdAt: event.created_at,
  };
}
