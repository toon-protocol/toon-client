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
