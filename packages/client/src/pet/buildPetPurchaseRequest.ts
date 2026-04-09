/**
 * Pet Purchase Request Builder (Kind 5900, action type 9)
 *
 * Builds unsigned Kind 5900 Nostr events for pet transfer-ownership
 * purchase requests. Action type 9 is a reserved slot in the pet DVM
 * protocol — this event signals purchase intent and routes ILP payment
 * to the seller. The actual Mina on-chain ownership transfer (PetZkApp
 * .transferOperator) is handled by downstream stories.
 *
 * Browser-compatible — no Node.js-only imports.
 *
 * @module pet/buildPetPurchaseRequest
 */

import { PET_INTERACTION_REQUEST_KIND } from '@toon-protocol/core';
import type { PetPurchaseRequestParams, UnsignedNostrEvent } from './types.js';

/**
 * Action type 9 — transfer-ownership reserved slot.
 * Not currently handled server-side; defines the client-side protocol shape
 * for downstream Mina ownership transfer implementation.
 */
const TRANSFER_OWNERSHIP_ACTION = 9;

/**
 * Build an unsigned Kind 5900 pet purchase request event.
 *
 * Reuses the existing pet interaction event kind (5900) with action type 9
 * (transfer-ownership). The `listing` tag references the kind:30402 listing
 * event being purchased. The `p` tag routes ILP payment to the seller.
 *
 * The returned event is compatible with nostr-tools `finalizeEvent`.
 *
 * @param params - Typed purchase request parameters
 * @returns Unsigned Nostr event ready for signing and publishing
 */
export function buildPetPurchaseRequest(
  params: PetPurchaseRequestParams
): UnsignedNostrEvent {
  const { blobbiId, listingEventId, buyerPubkey, tokenCost, sellerPubkey } =
    params;

  return {
    kind: PET_INTERACTION_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['action', String(TRANSFER_OWNERSHIP_ACTION)],
      ['i', blobbiId],
      ['listing', listingEventId],
      ['buyer', buyerPubkey],
      ['p', sellerPubkey],
      ['cost', String(tokenCost)],
    ],
    content: '',
  };
}
