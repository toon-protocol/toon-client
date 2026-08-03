/**
 * ToonClient.getClaimState (toon-client#494, toon-meta#262 decision 9):
 * the credited-balance read surface over the connector's
 * `POST /ilp/claim-state` (client-edge-spec.md §1.10).
 */

import { describe, it, expect, vi } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { ChannelManager } from './channel/ChannelManager.js';
import { EvmSigner } from './signing/evm-signer.js';
import { SolanaSigner } from './signing/solana-signer.js';
import type { ClaimStateResult } from './adapters/ConnectorEdgeClient.js';

const EVM_CHANNEL_ID = '0x' + 'aa'.repeat(32);
const EVM_TOKEN_NETWORK = '0x' + 'bb'.repeat(20);
const SOLANA_CHANNEL_PDA = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';
const SOLANA_PROGRAM_ID = '11111111111111111111111111111111';

function baseConfig() {
  return {
    secretKey: new Uint8Array(32).fill(7),
    connectorUrl: 'http://localhost:9999',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

function stubConnectorEdge(client: ToonClient, results: ClaimStateResult[]) {
  const getClaimState = vi.fn(async () => results);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).connectorEdge = { getClaimState };
  return getClaimState;
}

describe('ToonClient.getClaimState', () => {
  it('throws when no channel manager is configured', async () => {
    const client = new ToonClient(baseConfig());
    await expect(client.getClaimState()).rejects.toMatchObject({
      code: 'NO_EVM_SIGNER',
    });
  });

  it('returns [] when no channels are tracked', async () => {
    const client = new ToonClient(baseConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = new ChannelManager();

    await expect(client.getClaimState()).resolves.toEqual([]);
  });

  it('signs and requests claim state for a tracked EVM channel', async () => {
    const client = new ToonClient(baseConfig());
    const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
    const cm = new ChannelManager(evmSigner);
    cm.trackChannel(EVM_CHANNEL_ID, {
      chainType: 'evm',
      chainId: 31337,
      tokenNetworkAddress: EVM_TOKEN_NETWORK,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = cm;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).evmSigner = evmSigner;

    const okResult: ClaimStateResult = {
      blockchain: 'evm',
      channelId: EVM_CHANNEL_ID,
      ok: true,
      depositTotal: '1000000',
      cumulativeClaimed: '250000',
      available: '750000',
      nonce: 3,
      lastClaimTime: 1735680000,
    };
    const getClaimState = stubConnectorEdge(client, [okResult]);

    const results = await client.getClaimState();

    expect(getClaimState).toHaveBeenCalledTimes(1);
    const [endpoint, requests] = getClaimState.mock.calls[0]!;
    expect(endpoint).toContain('localhost:9999');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ blockchain: 'evm', channelId: EVM_CHANNEL_ID });
    expect(typeof requests[0].expires).toBe('number');
    expect(typeof requests[0].signature).toBe('string');
    expect(results).toEqual([okResult]);
  });

  it('signs and requests claim state for a tracked Solana channel', async () => {
    const client = new ToonClient(baseConfig());
    const cm = new ChannelManager();
    const solanaSigner = new SolanaSigner(new Uint8Array(32).fill(3));
    cm.registerChainSigner('solana', solanaSigner);
    cm.trackChannel(SOLANA_CHANNEL_PDA, {
      chainType: 'solana',
      chainId: 0,
      tokenNetworkAddress: SOLANA_PROGRAM_ID,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = cm;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).solanaSigner = solanaSigner;

    const getClaimState = stubConnectorEdge(client, []);

    await client.getClaimState();

    const [, requests] = getClaimState.mock.calls[0]!;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      blockchain: 'solana',
      channelAccount: SOLANA_CHANNEL_PDA,
    });
  });

  it('skips a tracked channel with no matching signer', async () => {
    const client = new ToonClient(baseConfig());
    const cm = new ChannelManager(); // no EVM signer registered
    cm.trackChannel(EVM_CHANNEL_ID, {
      chainType: 'evm',
      chainId: 31337,
      tokenNetworkAddress: EVM_TOKEN_NETWORK,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = cm;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).evmSigner = undefined;

    const getClaimState = stubConnectorEdge(client, []);

    const results = await client.getClaimState();

    expect(getClaimState).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('respects an explicit channelIds filter', async () => {
    const client = new ToonClient(baseConfig());
    const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
    const cm = new ChannelManager(evmSigner);
    const otherChannel = '0x' + 'cc'.repeat(32);
    cm.trackChannel(EVM_CHANNEL_ID, {
      chainType: 'evm',
      chainId: 31337,
      tokenNetworkAddress: EVM_TOKEN_NETWORK,
    });
    cm.trackChannel(otherChannel, {
      chainType: 'evm',
      chainId: 31337,
      tokenNetworkAddress: EVM_TOKEN_NETWORK,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = cm;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).evmSigner = evmSigner;

    const getClaimState = stubConnectorEdge(client, []);

    await client.getClaimState([EVM_CHANNEL_ID]);

    const [, requests] = getClaimState.mock.calls[0]!;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ channelId: EVM_CHANNEL_ID });
  });
});
