/**
 * Withdraw time-guard: ToonClient.settleChannel must NEVER settle before
 * `settleableAt` (unix seconds). This is the single highest-risk invariant of
 * the withdraw flow — a seconds-vs-ms slip would settle ~1000× too early.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { ToonClient } from './ToonClient.js';
import { ChannelManager } from './channel/ChannelManager.js';
import { EvmSigner } from './signing/evm-signer.js';
import { generatePrivateKey } from 'viem/accounts';
import type { ToonClientConfig } from './types.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const CHANNEL_ID = '0x' + 'cd'.repeat(32);

function baseConfig(): ToonClientConfig {
  return {
    connectorUrl: 'http://localhost:8080',
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.test',
      btpEndpoint: 'ws://localhost:3000',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: (_e: NostrEvent): Uint8Array => new Uint8Array(),
    toonDecoder: (_b: Uint8Array): NostrEvent => ({}) as NostrEvent,
    mnemonic: MNEMONIC,
  };
}

/** Build a client with an injected ChannelManager + fake on-chain client. */
function makeClient(closeState: 'open' | 'closed') {
  const client = new ToonClient(baseConfig());
  const manager = new ChannelManager(new EvmSigner(generatePrivateKey()));
  manager.trackChannel(CHANNEL_ID);
  if (closeState === 'closed') manager.setChannelClosed(CHANNEL_ID, 1000n, 2000n); // settleable at t=2000s
  const onChain = {
    settleChannel: vi.fn().mockResolvedValue({ txHash: '0xsettle' }),
    closeChannel: vi.fn().mockResolvedValue({ closedAt: 1000n, settlementTimeout: 1000n, settleableAt: 2000n, txHash: '0xclose' }),
  };
  (client as unknown as { channelManager: ChannelManager }).channelManager = manager;
  (client as unknown as { onChainChannelClient: typeof onChain }).onChainChannelClient = onChain;
  return { client, onChain };
}

describe('ToonClient.settleChannel time guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('throws a retryable error and does NOT settle before settleableAt', async () => {
    const { client, onChain } = makeClient('closed');
    vi.setSystemTime(new Date(1_500_000)); // t = 1500s < 2000s
    await expect(client.settleChannel(CHANNEL_ID)).rejects.toMatchObject({
      name: 'SettleTooEarlyError',
      retryable: true,
    });
    expect(onChain.settleChannel).not.toHaveBeenCalled();
  });

  it('settles once now ≥ settleableAt', async () => {
    const { client, onChain } = makeClient('closed');
    vi.setSystemTime(new Date(2_000_000)); // t = 2000s >= 2000s
    const out = await client.settleChannel(CHANNEL_ID);
    expect(out.txHash).toBe('0xsettle');
    expect(onChain.settleChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('throws when the channel was never closed', async () => {
    const { client } = makeClient('open');
    await expect(client.settleChannel(CHANNEL_ID)).rejects.toThrow(/not closed/i);
  });
});
