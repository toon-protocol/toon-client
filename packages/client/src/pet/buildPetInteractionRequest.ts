/**
 * Pet Interaction Request Builder (Kind 5900)
 *
 * Builds unsigned Kind 5900 Nostr events for pet DVM interaction requests.
 * Compatible with nostr-tools/pure finalizeEvent for signing.
 *
 * @module pet/buildPetInteractionRequest
 */

import { PET_INTERACTION_REQUEST_KIND } from '@toon-protocol/core';
import { ValidationError } from '../errors.js';
import type { PetInteractionRequestParams, UnsignedNostrEvent } from './types.js';

/** Maximum valid action type index (0-10 inclusive, ACTION_COUNT = 11) */
const MAX_ACTION_TYPE = 10;

/**
 * Build an unsigned Kind 5900 pet interaction request event.
 *
 * All tag values are stringified per Nostr protocol convention.
 * The returned event is compatible with nostr-tools `finalizeEvent`.
 *
 * @param params - Typed interaction parameters
 * @returns Unsigned Nostr event ready for signing
 * @throws ValidationError for invalid input
 */
export function buildPetInteractionRequest(
  params: PetInteractionRequestParams
): UnsignedNostrEvent {
  const { blobbiId, actionType, itemId, tokenCost, isSleeping } = params;

  // Validate blobbiId
  if (!blobbiId || blobbiId.trim() === '') {
    throw new ValidationError('blobbiId must be a non-empty string');
  }

  // Validate actionType (0 <= actionType <= 10)
  if (
    !Number.isInteger(actionType) ||
    actionType < 0 ||
    actionType > MAX_ACTION_TYPE
  ) {
    throw new ValidationError(
      `actionType must be an integer between 0 and ${MAX_ACTION_TYPE}, got ${actionType}`
    );
  }

  // Validate itemId (>= 0)
  if (!Number.isInteger(itemId) || itemId < 0) {
    throw new ValidationError(`itemId must be a non-negative integer, got ${itemId}`);
  }

  // Validate tokenCost (>= 0)
  if (!Number.isFinite(tokenCost) || tokenCost < 0) {
    throw new ValidationError(
      `tokenCost must be a non-negative number, got ${tokenCost}`
    );
  }

  return {
    kind: PET_INTERACTION_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', blobbiId],
      ['action', String(actionType)],
      ['item', String(itemId)],
      ['cost', String(tokenCost)],
      ['sleeping', String(isSleeping)],
    ],
    content: '',
  };
}
