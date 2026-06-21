import { describe, it, expect, vi } from 'vitest';
import type { ControlClient } from '../control-client.js';
import type { ChannelsResponse, SwapResponse } from '../control-api.js';
import { runJourney } from './runner.js';
import { deFiJourney } from './defi.js';
import type { DeFiJourneyOpts } from './defi.js';

function stubClient(impl: Partial<Record<keyof ControlClient, unknown>>): ControlClient {
  return impl as unknown as ControlClient;
}

const swapPair = {
  from: { assetCode: 'ETH', assetScale: 18, chain: 'evm' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'evm' },
  rate: '3500',
};

const opts: DeFiJourneyOpts = {
  destination: 'g.townhouse.mill',
  amount: '1000000',
  millPubkey: 'a'.repeat(64),
  pair: swapPair,
  chainRecipient: '0x1234567890123456789012345678901234567890',
};

const swapFixture: SwapResponse = {
  accepted: true,
  packetsAccepted: 1,
  claims: [
    {
      sourceAmount: '1000000',
      targetAmount: '285714',
      claim: 'base64claim==',
      channelId: 'chan-1',
      nonce: '1',
      cumulativeAmount: '285714',
    },
  ],
  cumulativeSource: '1000000',
  cumulativeTarget: '285714',
  state: 'completed',
};

const channelsFixture: ChannelsResponse = {
  channels: [{ channelId: 'chan-1', nonce: 1, cumulativeAmount: '1000' }],
};

function makeClient() {
  const openChannel = vi.fn().mockResolvedValue({ channelId: 'chan-1' });
  const swap = vi.fn().mockResolvedValue(swapFixture);
  const channels = vi.fn().mockResolvedValue(channelsFixture);
  return { client: stubClient({ openChannel, swap, channels }), openChannel, swap, channels };
}

describe('deFiJourney', () => {
  it('runs all 3 steps in order and completes', async () => {
    const { client } = makeClient();
    const result = await runJourney(deFiJourney(opts), client);

    expect(result.completed).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.error).toBeUndefined();
    expect(result.steps[0]!.stepId).toBe('open-channel');
    expect(result.steps[1]!.stepId).toBe('swap');
    expect(result.steps[2]!.stepId).toBe('settlement-receipt');
  });

  it('step 1 calls openChannel with the supplied destination', async () => {
    const { client, openChannel } = makeClient();
    await runJourney(deFiJourney(opts), client);

    expect(openChannel).toHaveBeenCalledWith({ destination: opts.destination });
  });

  it('step 2 calls swap with the supplied SwapRequest args', async () => {
    const { client, swap } = makeClient();
    await runJourney(deFiJourney(opts), client);

    expect(swap).toHaveBeenCalledWith({
      destination: opts.destination,
      amount: opts.amount,
      millPubkey: opts.millPubkey,
      pair: opts.pair,
      chainRecipient: opts.chainRecipient,
    });
  });

  it('step 3 calls channels() — not any non-existent settle method', async () => {
    const { client, channels } = makeClient();
    await runJourney(deFiJourney(opts), client);

    expect(channels).toHaveBeenCalledOnce();
  });

  it('each step panel carries the expected atom id', async () => {
    const { client } = makeClient();
    const result = await runJourney(deFiJourney(opts), client);

    type SpecRoot = { root: { children: { atom: string }[] } };
    const spec1 = result.steps[0]!.panel.structuredContent?.['viewSpec'] as SpecRoot;
    const spec2 = result.steps[1]!.panel.structuredContent?.['viewSpec'] as SpecRoot;
    const spec3 = result.steps[2]!.panel.structuredContent?.['viewSpec'] as SpecRoot;

    expect(spec1.root.children[0]!.atom).toBe('channel-card');
    expect(spec2.root.children[0]!.atom).toBe('swap-form');
    expect(spec3.root.children[0]!.atom).toBe('settlement-receipt');
  });

  it('settlement-receipt panel reflects the threaded swap result joined with channel watermark', async () => {
    const { client } = makeClient();
    const result = await runJourney(deFiJourney(opts), client);

    type ReceiptSpec = { root: { children: { atom: string; props: Record<string, unknown> }[] } };
    const spec = result.steps[2]!.panel.structuredContent?.['viewSpec'] as ReceiptSpec;
    const props = spec.root.children[0]!.props;

    expect(props['claims']).toEqual(swapFixture.claims);
    expect(props['cumulativeSource']).toBe(swapFixture.cumulativeSource);
    expect(props['cumulativeTarget']).toBe(swapFixture.cumulativeTarget);
    expect(props['channels']).toEqual(channelsFixture.channels);
  });
});
