import { describe, it, expect } from 'vitest';
import { ILP_PEER_INFO_KIND } from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';
import { RelaySubscription } from '../relay-subscription.js';
import { discoverApex, ApexDiscoveryError } from './apex-discovery.js';

/** A relay backed by a fake WS we can drive: open it, push EVENT frames. */
function controllableRelay(relayUrl = 'ws://disc.test'): {
  relay: RelaySubscription;
  open: () => void;
  emit: (msg: unknown) => void;
} {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const ws = {
    send: () => {},
    close: () => {},
    on: (ev: string, cb: (arg?: unknown) => void) => {
      handlers[ev] = cb;
    },
  };
  const relay = new RelaySubscription({
    relayUrl,
    wsFactory: () => ws as never,
  });
  relay.start();
  return {
    relay,
    open: () => handlers['open']?.(),
    emit: (msg) => handlers['message']?.(JSON.stringify(msg)),
  };
}

function announcement(ilpAddress: string): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1,
    kind: ILP_PEER_INFO_KIND,
    tags: [],
    sig: 'c'.repeat(128),
    content: JSON.stringify({
      ilpAddress,
      btpEndpoint: 'ws://apex.example/btp',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:84532', 'solana:devnet'],
      settlementAddresses: {
        'evm:base:84532': '0xSettle',
        'solana:devnet': 'SolSettle',
      },
      preferredTokens: { 'evm:base:84532': '0xUSDC' },
      tokenNetworks: { 'evm:base:84532': '0xTN' },
    }),
  };
}

describe('discoverApex', () => {
  it('maps a kind:10032 announcement to a negotiation (preferred chain)', async () => {
    const { relay, open, emit } = controllableRelay();
    open();
    emit([
      'EVENT',
      'apex-discovery-g.townhouse.town',
      announcement('g.townhouse.town'),
    ]);

    const result = await discoverApex({
      relay,
      ilpAddress: 'g.townhouse.town',
      chain: 'evm',
      childPeers: ['dvm', 'mill'],
      timeoutMs: 1000,
      pollMs: 10,
    });

    expect(result.btpUrl).toBe('ws://apex.example/btp');
    expect(result.apexChildPeers).toEqual(['dvm', 'mill']);
    expect(result.negotiation).toMatchObject({
      destination: 'g.townhouse.town',
      peerId: 'town',
      chain: 'evm',
      chainKey: 'evm:base:84532',
      chainId: 84532,
      settlementAddress: '0xSettle',
      tokenAddress: '0xUSDC',
      tokenNetwork: '0xTN',
    });
  });

  it('falls back to the first advertised chain when none requested', async () => {
    const { relay, open, emit } = controllableRelay();
    open();
    emit([
      'EVENT',
      'apex-discovery-g.townhouse.town',
      announcement('g.townhouse.town'),
    ]);
    const result = await discoverApex({
      relay,
      ilpAddress: 'g.townhouse.town',
      timeoutMs: 1000,
      pollMs: 10,
    });
    expect(result.negotiation.chainKey).toBe('evm:base:84532');
  });

  it('times out when no matching announcement arrives', async () => {
    const { relay, open } = controllableRelay();
    open();
    await expect(
      discoverApex({
        relay,
        ilpAddress: 'g.missing.town',
        timeoutMs: 120,
        pollMs: 20,
      })
    ).rejects.toBeInstanceOf(ApexDiscoveryError);
  });
});
