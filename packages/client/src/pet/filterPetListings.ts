/**
 * Pet Listing Discovery Filter
 *
 * Filters and sorts Kind 30402 pet marketplace listing events into
 * typed PetListing objects. Handles expiry, stage, price, biography
 * value, and seller filtering. Results sorted by totalSpent descending
 * (highest biography value first) to surface the most battle-hardened pets.
 *
 * Browser-compatible — no Node.js-only imports.
 *
 * @module pet/filterPetListings
 */

import { parsePetListing } from './parsePetListing.js';
import type { PetListing, PetListingFilterOptions } from './types.js';

/** Minimal Nostr event shape accepted by the filter */
interface NostrEventLike {
  id: string;
  kind: number;
  pubkey: string;
  tags: string[][];
  content: string;
  created_at: number;
}

/**
 * Compare two numeric strings. Returns negative if a < b, 0 if equal, positive if a > b.
 * Handles arbitrarily large integers (bigint comparison).
 */
function compareNumericStrings(a: string, b: string): number {
  // Fast path for equal strings
  if (a === b) return 0;
  // Use BigInt for correct comparison of large token amounts
  try {
    const bigA = BigInt(a);
    const bigB = BigInt(b);
    if (bigA < bigB) return -1;
    if (bigA > bigB) return 1;
    return 0;
  } catch {
    // Fallback to float comparison for non-integer numerics
    const fa = Number(a);
    const fb = Number(b);
    // Guard against NaN — treat NaN as less than any valid number
    if (!Number.isFinite(fa) && !Number.isFinite(fb)) return 0;
    if (!Number.isFinite(fa)) return -1;
    if (!Number.isFinite(fb)) return 1;
    return fa - fb;
  }
}

/**
 * Filter and sort Kind 30402 pet marketplace listing events.
 *
 * Parsing is done via parsePetListing — invalid events are silently dropped.
 * Expired listings (expiration tag < current unix time) are excluded.
 * Options allow additional filtering by stage, price, biography value, and seller.
 * Results are sorted by totalSpent descending (highest biography value first).
 *
 * @param events - Array of raw Nostr events to filter
 * @param options - Optional filter criteria
 * @returns Filtered and sorted array of PetListing objects
 */
export function filterPetListings(
  events: NostrEventLike[],
  options?: PetListingFilterOptions
): PetListing[] {
  const now = Math.floor(Date.now() / 1000);
  const listings: PetListing[] = [];

  for (const event of events) {
    // Parse and validate the listing
    const listing = parsePetListing(event);
    if (listing === null) continue;

    // Expiry filter — only exclude if expiresAt is set (> 0) AND has passed
    // listing.expiresAt is already parsed from the expiration tag by parsePetListing
    // (0 means no expiration tag was present — treat as never-expires)
    if (listing.expiresAt > 0 && listing.expiresAt < now) continue;

    // Stage filter
    if (options?.minStage !== undefined && listing.stage < options.minStage) {
      continue;
    }

    // Price filter
    if (
      options?.maxAskPriceUsdc !== undefined &&
      listing.askPriceUsdc > options.maxAskPriceUsdc
    ) {
      continue;
    }

    // Biography value filter (totalSpent numeric string comparison)
    if (options?.minTotalSpent !== undefined) {
      if (compareNumericStrings(listing.totalSpent, options.minTotalSpent) < 0) {
        continue;
      }
    }

    // Seller pubkey filter
    if (
      options?.sellerPubkey !== undefined &&
      listing.sellerPubkey !== options.sellerPubkey
    ) {
      continue;
    }

    listings.push(listing);
  }

  // Sort by totalSpent descending (highest biography value first)
  listings.sort((a, b) =>
    compareNumericStrings(b.totalSpent, a.totalSpent)
  );

  return listings;
}
