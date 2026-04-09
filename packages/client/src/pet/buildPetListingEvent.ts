/**
 * Pet Listing Event Builder (Kind 30402)
 *
 * Builds unsigned Kind 30402 (NIP-99 classified listing) Nostr events
 * for pet-for-sale marketplace listings. Every listing includes a
 * verified biography attachment (lifecycleHash + totalSpent) so buyers
 * can verify the listing against on-chain PetZkApp state.
 *
 * Browser-compatible — no Node.js-only imports.
 *
 * @module pet/buildPetListingEvent
 */

import type { PetListingParams, UnsignedNostrEvent } from './types.js';

/**
 * Kind 30402: NIP-99 parameterized replaceable classified listing.
 * Not yet defined in @toon-protocol/core (pet marketplace is new in Story 11-14).
 * Defined locally until core exports this constant.
 */
const PET_LISTING_KIND = 30402;

/** Human-readable stage names for listing summaries */
const STAGE_NAMES: Record<number, string> = {
  0: 'Egg',
  1: 'Baby',
  2: 'Adult',
};

/**
 * Build an unsigned Kind 30402 pet-for-sale classified listing event.
 *
 * The listing uses the NIP-99 classified listing format with TOON-specific
 * extension tags for verified biography (lifecycleHash, totalSpent).
 * The `d` tag is set to `blobbiId` for stable parameterized replaceability —
 * republishing with the same `d` tag updates the listing on relays.
 *
 * The returned event is compatible with nostr-tools `finalizeEvent`.
 *
 * @param params - Typed listing parameters
 * @returns Unsigned Nostr event ready for signing and publishing
 */
export function buildPetListingEvent(
  params: PetListingParams
): UnsignedNostrEvent {
  const {
    blobbiId,
    askPriceUsdc,
    lifecycleHash,
    totalSpent,
    stage,
    stats,
    sellerPubkey,
    relayUrl,
    expiresAt,
  } = params;

  const stageName = STAGE_NAMES[stage] ?? 'Unknown';
  const summary = `${stageName} pet for sale — ${totalSpent} PET tokens spent (verified biography)`;

  return {
    kind: PET_LISTING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', blobbiId],
      ['title', `Pet ${blobbiId} for sale`],
      ['price', String(askPriceUsdc), 'USDC', ''],
      ['summary', summary],
      ['t', 'pet'],
      ['t', 'toon-pet'],
      ['lifecycle_hash', lifecycleHash],
      ['total_spent', totalSpent],
      ['stage', String(stage)],
      ['expiration', String(expiresAt)],
      ['relay', relayUrl],
      ['p', sellerPubkey],
    ],
    content: JSON.stringify(stats),
  };
}
