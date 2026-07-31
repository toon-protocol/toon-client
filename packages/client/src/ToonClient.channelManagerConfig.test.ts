/**
 * `ToonClientConfig.initialDeposit` / `settlementTimeout` reach the
 * ChannelManager that `start()` builds.
 *
 * These two fields were documented on `ToonClientConfig` but `start()`
 * constructed `new ChannelManager(evmSigner, store)` with no config at all, so
 * they were accepted and silently dropped and EVERY channel open — on every
 * chain — was pinned to the manager's own defaults. That is a whole-config hunk
 * with no observable behaviour of its own, so it is asserted here at the seam
 * that matters: the parameters a real, started client's manager actually sends
 * to `openChannel`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { ToonClient } from './ToonClient.js';
import type { ToonClientConfig } from './types.js';
import type { ChannelManager } from './channel/ChannelManager.js';

// `start()` does real network work after building the ChannelManager; stub the
// whole HTTP-mode initialization so the test stays at the seam under test.
vi.mock('./modes/http.js', () => ({
  initializeHttpMode: vi.fn(async () => ({
    bootstrapService: {
      setClaimSigner: vi.fn(),
      bootstrap: vi.fn(async () => []),
    },
    discoveryTracker: { start: vi.fn(), stop: vi.fn() },
    runtimeClient: {},
    adminClient: null,
    btpClient: null,
  })),
}));

const MNEMONIC = 'test test test test test test test test test test test junk';

function baseConfig(overrides: Partial<ToonClientConfig>): ToonClientConfig {
  return {
    mnemonic: MNEMONIC,
    connectorUrl: 'http://localhost:8080',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.test',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: (_e: NostrEvent) => new Uint8Array([1]),
    toonDecoder: (_b: Uint8Array) => ({}) as NostrEvent,
    ...overrides,
  } as ToonClientConfig;
}

const NEGOTIATION = {
  chain: 'solana',
  chainType: 'solana',
  chainId: 'solana',
  settlementAddress: 'ApexSolanaSettlement111111111111111111111',
  tokenAddress: 'UsdcMint1111111111111111111111111111111',
  tokenNetwork: 'PaymentChannelProgram1111111111111111111',
};

/**
 * Start a client and capture the `openChannel` params its OWN ChannelManager
 * (the one `start()` built) produces for a peer.
 */
async function openParamsFor(
  overrides: Partial<ToonClientConfig>
): Promise<Record<string, unknown>> {
  const client = new ToonClient(baseConfig(overrides));
  await client.start();

  const openChannel = vi.fn(async () => ({
    channelId: 'chan-1',
    status: 'opening',
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manager = (client as any).channelManager as ChannelManager;
  expect(manager).toBeDefined();
  manager.setChannelClient({
    openChannel,
  } as unknown as Parameters<ChannelManager['setChannelClient']>[0]);

  await manager.ensureChannel('apex', NEGOTIATION);
  return openChannel.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
}

describe('ToonClient.start — ChannelManager config threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the manager defaults when the config sets neither', async () => {
    const params = await openParamsFor({});
    expect(params['initialDeposit']).toBe('100000');
    expect(params['settlementTimeout']).toBe(86400);
  });

  it('honours a configured initialDeposit', async () => {
    const params = await openParamsFor({ initialDeposit: '250000' });
    expect(params['initialDeposit']).toBe('250000');
  });

  it('honours a configured settlementTimeout', async () => {
    const params = await openParamsFor({ settlementTimeout: 3600 });
    expect(params['settlementTimeout']).toBe(3600);
  });

  it('honours an explicit 0 deposit — opting out is a real choice, not "unset"', async () => {
    const params = await openParamsFor({ initialDeposit: '0' });
    expect(params['initialDeposit']).toBe('0');
  });
});
