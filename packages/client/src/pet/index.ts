/**
 * Pet DVM Client Utilities
 *
 * Client-side utilities for discovering pet DVM providers, building Kind 5900
 * interaction requests, and parsing Kind 6900/14919 results.
 *
 * Browser-compatible -- no dependency on pet-dvm, pet-circuit, or memvid-node.
 *
 * @module pet
 */

// Utilities
export { filterPetDvmProviders } from './filterPetDvmProviders.js';
export { buildPetInteractionRequest } from './buildPetInteractionRequest.js';
export { parsePetInteractionResult } from './parsePetInteractionResult.js';
export { parsePetInteractionEvent } from './parsePetInteractionEvent.js';

// Types
export type {
  PetDvmProvider,
  PetInteractionRequestParams,
  PetInteractionResultData,
  PetInteractionEventData,
  InteractionResultContent,
  UnsignedNostrEvent,
  StatValues,
  ProofStatus,
} from './types.js';
