/**
 * Pet DVM Provider Discovery
 *
 * Filters Kind 10035 service discovery events to find providers that
 * support Pet DVM interactions (Kind 5900).
 *
 * @module pet/filterPetDvmProviders
 */

import { parseServiceDiscovery } from '@toon-protocol/core';
import { PET_INTERACTION_REQUEST_KIND } from '@toon-protocol/core';
import type { PetDvmProvider } from './types.js';

/**
 * Minimal Nostr event shape needed for filtering.
 * Using a local interface to avoid importing nostr-tools types.
 */
interface NostrEventLike {
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
  id: string;
  sig: string;
  created_at: number;
}

/**
 * Filter Kind 10035 service discovery events to find pet DVM providers.
 *
 * Accepts raw NostrEvent[] and internally parses content via parseServiceDiscovery.
 * Filters events where skill.kinds includes 5900 (PET_INTERACTION_REQUEST_KIND).
 * Returns provider metadata sorted by price ascending (cheapest first).
 *
 * Handles missing/malformed skill descriptors gracefully (returns empty array, no throw).
 *
 * @param events - Array of raw Nostr events (kind:10035)
 * @returns Array of PetDvmProvider metadata, sorted by price ascending
 */
export function filterPetDvmProviders(events: NostrEventLike[]): PetDvmProvider[] {
  const providers: PetDvmProvider[] = [];

  for (const event of events) {
    let parsed;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsed = parseServiceDiscovery(event as any);
    } catch {
      continue;
    }

    if (!parsed) continue;

    const skill = parsed.skill;
    if (!skill) continue;

    // Check if this provider supports Kind 5900
    if (!skill.kinds.includes(PET_INTERACTION_REQUEST_KIND)) continue;

    const pricing = skill.pricing[String(PET_INTERACTION_REQUEST_KIND)] ?? '0';

    providers.push({
      ilpAddress: parsed.ilpAddress,
      pricing,
      pubkey: event.pubkey,
      features: skill.features,
    });
  }

  // Sort by price ascending (cheapest first)
  providers.sort((a, b) => {
    const priceA = Number(a.pricing) || 0;
    const priceB = Number(b.pricing) || 0;
    return priceA - priceB;
  });

  return providers;
}
