import { describe, it, expect } from 'vitest';
import { filterPetDvmProviders } from './filterPetDvmProviders.js';
import type { PetDvmProvider } from './types.js';

/** Helper to create a minimal Kind 10035 event with skill descriptor */
function makeServiceDiscoveryEvent(overrides: {
  pubkey?: string;
  ilpAddress?: string;
  pricing5900?: string;
  kinds?: number[];
  features?: string[];
  skillPresent?: boolean;
  malformedContent?: boolean;
}): { kind: number; pubkey: string; content: string; tags: string[][]; id: string; sig: string; created_at: number } {
  const {
    pubkey = 'abc123pubkey',
    ilpAddress = 'g.toon.provider1',
    pricing5900 = '1000',
    kinds = [5900],
    features = ['pet-interaction'],
    skillPresent = true,
    malformedContent = false,
  } = overrides;

  if (malformedContent) {
    return {
      kind: 10035,
      pubkey,
      content: 'not-valid-json{{{',
      tags: [['d', 'toon-service-discovery']],
      id: 'event-id',
      sig: 'event-sig',
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  const contentObj: Record<string, unknown> = {
    serviceType: 'relay',
    ilpAddress,
    pricing: { basePricePerByte: 1, currency: 'USDC' },
    supportedKinds: [1, 30023],
    capabilities: ['relay'],
    chain: 'anvil',
    version: '1.0.0',
  };

  if (skillPresent) {
    contentObj.skill = {
      name: 'toon-dvm',
      version: '1.0',
      kinds,
      features,
      inputSchema: {},
      pricing: pricing5900 ? { '5900': pricing5900 } : {},
    };
  }

  return {
    kind: 10035,
    pubkey,
    content: JSON.stringify(contentObj),
    tags: [['d', 'toon-service-discovery']],
    id: 'event-id',
    sig: 'event-sig',
    created_at: Math.floor(Date.now() / 1000),
  };
}

describe('filterPetDvmProviders', () => {
  it('should return provider metadata for valid pet DVM event', () => {
    const event = makeServiceDiscoveryEvent({
      pubkey: 'provider-pubkey-1',
      ilpAddress: 'g.toon.pet-provider',
      pricing5900: '500',
      features: ['pet-interaction', 'optimistic-pipeline'],
    });

    const providers = filterPetDvmProviders([event]);

    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual<PetDvmProvider>({
      ilpAddress: 'g.toon.pet-provider',
      pricing: '500',
      pubkey: 'provider-pubkey-1',
      features: ['pet-interaction', 'optimistic-pipeline'],
    });
  });

  it('should filter out events without skill descriptor', () => {
    const event = makeServiceDiscoveryEvent({ skillPresent: false });
    const providers = filterPetDvmProviders([event]);
    expect(providers).toHaveLength(0);
  });

  it('should filter out events where skill.kinds does not include 5900', () => {
    const event = makeServiceDiscoveryEvent({ kinds: [5100, 5200] });
    const providers = filterPetDvmProviders([event]);
    expect(providers).toHaveLength(0);
  });

  it('should handle malformed content gracefully (return empty array)', () => {
    const event = makeServiceDiscoveryEvent({ malformedContent: true });
    const providers = filterPetDvmProviders([event]);
    expect(providers).toHaveLength(0);
  });

  it('should sort results by price ascending (cheapest first)', () => {
    const cheap = makeServiceDiscoveryEvent({
      pubkey: 'cheap',
      ilpAddress: 'g.toon.cheap',
      pricing5900: '100',
    });
    const expensive = makeServiceDiscoveryEvent({
      pubkey: 'expensive',
      ilpAddress: 'g.toon.expensive',
      pricing5900: '5000',
    });
    const mid = makeServiceDiscoveryEvent({
      pubkey: 'mid',
      ilpAddress: 'g.toon.mid',
      pricing5900: '1000',
    });

    const providers = filterPetDvmProviders([expensive, cheap, mid]);

    expect(providers).toHaveLength(3);
    expect(providers[0]!.pricing).toBe('100');
    expect(providers[1]!.pricing).toBe('1000');
    expect(providers[2]!.pricing).toBe('5000');
  });

  it('should return empty array for empty input', () => {
    const providers = filterPetDvmProviders([]);
    expect(providers).toHaveLength(0);
  });
});
