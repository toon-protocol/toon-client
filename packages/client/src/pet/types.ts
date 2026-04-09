/**
 * Pet DVM Client-Side Types
 *
 * Locally defined types for pet DVM interaction utilities.
 * These mirror server-side types but do NOT import from @toon-protocol/pet-dvm,
 * @toon-protocol/pet-circuit, or @toon-protocol/memvid-node.
 *
 * @module pet/types
 */

// ============================================================
// Stat Values (mirrors pet-dvm/src/engine/types.ts)
// ============================================================

/** Plain-number stat values (all clamped to [1, 100]) */
export interface StatValues {
  hunger: number;
  happiness: number;
  health: number;
  hygiene: number;
  energy: number;
}

// ============================================================
// Pet DVM Provider Discovery
// ============================================================

/** Metadata for a pet DVM provider discovered via Kind 10035 events */
export interface PetDvmProvider {
  /** ILP address of the provider's connector */
  ilpAddress: string;
  /** Per-interaction cost from skill.pricing['5900'] */
  pricing: string;
  /** Provider's Nostr pubkey (cryptographically bound from event.pubkey) */
  pubkey: string;
  /** Feature list from skill.features */
  features: string[];
}

// ============================================================
// Pet Interaction Request (Kind 5900 Builder)
// ============================================================

/** Parameters for building a Kind 5900 pet interaction request */
export interface PetInteractionRequestParams {
  /** Blobbi identifier (non-empty string) */
  blobbiId: string;
  /** Action type (0-10, maps to Feed/Play/Clean/etc.) */
  actionType: number;
  /** Item identifier (>= 0) */
  itemId: number;
  /** Token cost for this interaction (>= 0) */
  tokenCost: number;
  /** Whether the pet is currently sleeping */
  isSleeping: boolean;
}

/** Unsigned Nostr event structure compatible with nostr-tools finalizeEvent */
export interface UnsignedNostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

// ============================================================
// Pet Interaction Result (Kind 6900 Parser)
// ============================================================

/** Parsed result data from Kind 6900 DVM response (base64 JSON in IlpSendResult.data) */
export interface PetInteractionResultData {
  /** Current stat values */
  stats: StatValues;
  /** Current stage (0=Egg, 1=Baby, 2=Adult) */
  stage: number;
  /** Current evolution cycle (>= 0) */
  cycle: number;
  /** Unix timestamp of last interaction */
  lastInteraction: number;
  /** 64-char hex BLAKE3 hash of brain state */
  brainHash: string;
  /** Per-action-type cooldown timestamps */
  cooldownTimestamps: number[];
}

// ============================================================
// Pet Interaction Event (Kind 14919 Parser)
// ============================================================

/** Stat snapshot used in interaction result content */
export interface InteractionResultContent {
  priorStats: StatValues;
  decayedStats: StatValues;
  finalStats: StatValues;
  cycle: number;
  stage: number;
  tokenCost: number;
}

/** Proof status of a Kind 14919 event */
export type ProofStatus = 'optimistic' | 'proven';

// ============================================================
// Pet Marketplace (Kind 30402 NIP-99 Classified Listings)
// ============================================================

/** Parameters for building a Kind 30402 pet-for-sale classified listing */
export interface PetListingParams {
  /** Blobbi identifier (non-empty string) — used as the 'd' tag */
  blobbiId: string;
  /** Asking price in USDC (> 0) */
  askPriceUsdc: number;
  /** 64-char hex lifecycleHash from on-chain PetZkApp state */
  lifecycleHash: string;
  /** Cumulative PET tokens spent (numeric string, >= "0") */
  totalSpent: string;
  /** Current stage: 0=Egg, 1=Baby, 2=Adult */
  stage: number;
  /** Current pet stats */
  stats: StatValues;
  /** Seller's Nostr pubkey (64-char hex) */
  sellerPubkey: string;
  /** Preferred relay URL for event relay routing */
  relayUrl: string;
  /** Listing expiry as unix timestamp */
  expiresAt: number;
}

/** A parsed pet-for-sale listing (extends PetListingParams with event metadata) */
export interface PetListing extends PetListingParams {
  /** Nostr event ID of the kind:30402 listing event */
  eventId: string;
  /** Unix timestamp when the listing event was created */
  createdAt: number;
}

/** Filter options for filterPetListings() */
export interface PetListingFilterOptions {
  /** Only include listings for pets at or above this stage */
  minStage?: number;
  /** Only include listings at or below this USDC price */
  maxAskPriceUsdc?: number;
  /** Only include listings where totalSpent >= this value (numeric string comparison) */
  minTotalSpent?: string;
  /** Only include listings from this seller pubkey */
  sellerPubkey?: string;
}

// ============================================================
// Pet Purchase Request (Kind 5900, action type 9)
// ============================================================

/** Parameters for building a Kind 5900 pet purchase request (transfer-ownership) */
export interface PetPurchaseRequestParams {
  /** Blobbi identifier being purchased */
  blobbiId: string;
  /** Nostr event ID of the kind:30402 listing being purchased */
  listingEventId: string;
  /** Buyer's Nostr pubkey (64-char hex) */
  buyerPubkey: string;
  /** Token cost for the purchase (>= 0) */
  tokenCost: number;
  /** Seller's Nostr pubkey — ILP payment routed to this pubkey (64-char hex) */
  sellerPubkey: string;
}

/** Parsed data from a Kind 14919 pet interaction event */
export interface PetInteractionEventData {
  /** Blobbi identifier from 'd' tag */
  blobbiId: string;
  /** Action type from 'action' tag */
  actionType: number;
  /** Item identifier from 'item' tag */
  itemId: number;
  /** Token cost from 'cost' tag */
  tokenCost: number;
  /** Evolution cycle from 'cycle' tag */
  cycle: number;
  /** Stage from 'stage' tag */
  stage: number;
  /** Brain hash from 'brain_hash' tag */
  brainHash: string;
  /** Proof status: 'optimistic' (no proof tag) or 'proven' (has proof + mina_tx tags) */
  proofStatus: ProofStatus;
  /** Parsed content JSON (stats before/after) */
  content: InteractionResultContent | null;
  /** Base64 proof data (only present when proven) */
  proof?: string;
  /** Mina transaction hash (only present when proven) */
  minaTx?: string;
}
