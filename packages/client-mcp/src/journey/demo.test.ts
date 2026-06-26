import { describe, it, expect, vi } from 'vitest';
import type { ControlClient } from '../control-client.js';
import type { ChannelsResponse, SwapResponse } from '../control-api.js';
import {
  chainJourneys,
  capstoneJourney,
  extractReceipt,
  runCapstoneDemo,
  main,
  type DemoLogger,
} from './demo.js';
import { socialFiJourney } from './socialfi.js';
import { deFiJourney, type DeFiJourneyOpts } from './defi.js';
import { runJourney } from './runner.js';

const TEST_PUBKEY = 'a'.repeat(64);

function stubClient(impl: Partial<Record<keyof ControlClient, unknown>>): ControlClient {
  return impl as unknown as ControlClient;
}

const fakeStatus = {
  ready: true,
  bootstrapping: false,
  identity: { nostrPubkey: TEST_PUBKEY },
};

const fakePublishResponse = { eventId: 'evt123', channelId: 'ch1', nonce: 1 };
const fakeUploadResponse = {
  eventId: 'evt456',
  channelId: 'ch1',
  nonce: 2,
  url: 'https://arweave.net/abc123',
  txId: 'arweave-tx-1',
};

const swapPair = {
  from: { assetCode: 'ETH', assetScale: 18, chain: 'evm' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'evm' },
  rate: '3500',
};

const deFiOpts: DeFiJourneyOpts = {
  destination: 'g.proxy.mill',
  amount: '1000000',
  millPubkey: 'b'.repeat(64),
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

/** A full, happy-path mocked daemon: no network, no funds. */
function makeClient() {
  const status = vi.fn().mockResolvedValue(fakeStatus);
  const publishUnsigned = vi.fn().mockResolvedValue(fakePublishResponse);
  const uploadMedia = vi.fn().mockResolvedValue(fakeUploadResponse);
  const openChannel = vi.fn().mockResolvedValue({ channelId: 'chan-1' });
  const swap = vi.fn().mockResolvedValue(swapFixture);
  const channels = vi.fn().mockResolvedValue(channelsFixture);
  return {
    client: stubClient({ status, publishUnsigned, uploadMedia, openChannel, swap, channels }),
    status,
    publishUnsigned,
    uploadMedia,
    openChannel,
    swap,
    channels,
  };
}

function captureLogger(): DemoLogger & { out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  return {
    out,
    errs,
    log: (m: string) => out.push(m),
    error: (m: string) => errs.push(m),
  };
}

const CAPSTONE_OPTS = { socialFi: { pubkey: TEST_PUBKEY }, deFi: deFiOpts };

describe('chainJourneys', () => {
  it('concatenates steps in plan order', () => {
    const sf = socialFiJourney({ pubkey: TEST_PUBKEY });
    const df = deFiJourney(deFiOpts);
    const plan = chainJourneys('x', 'X', sf, df);
    expect(plan.id).toBe('x');
    expect(plan.steps).toHaveLength(sf.steps.length + df.steps.length);
    // SocialFi steps precede DeFi steps.
    expect(plan.steps.slice(0, sf.steps.length).map((s) => s.id)).toEqual(
      sf.steps.map((s) => s.id)
    );
    expect(plan.steps.slice(sf.steps.length).map((s) => s.id)).toEqual(
      df.steps.map((s) => s.id)
    );
  });

  it('throws on duplicate step ids across chained plans', () => {
    const a = socialFiJourney({ pubkey: TEST_PUBKEY });
    expect(() => chainJourneys('dup', 'Dup', a, a)).toThrow(/duplicate step id/);
  });
});

describe('capstoneJourney', () => {
  it('is the SocialFi 5 steps then the DeFi 3 steps, in order', () => {
    const plan = capstoneJourney(CAPSTONE_OPTS);
    expect(plan.id).toBe('capstone');
    expect(plan.steps.map((s) => s.id)).toEqual([
      'onboard',
      'publish-profile',
      'publish-note',
      'follow',
      'store-upload',
      'open-channel',
      'swap',
      'settlement-receipt',
    ]);
  });
});

describe('runCapstoneDemo (dry run, mocked ControlClient)', () => {
  it('runs the full ordered journey and exits 0', async () => {
    const { client } = makeClient();
    const logger = captureLogger();
    const code = await runCapstoneDemo(client, CAPSTONE_OPTS, logger);
    expect(code).toBe(0);
  });

  it('calls the right tool per step (no network, no funds)', async () => {
    const { client, status, publishUnsigned, uploadMedia, openChannel, swap, channels } =
      makeClient();
    await runCapstoneDemo(client, CAPSTONE_OPTS, captureLogger());

    // SocialFi leg: onboard + store-upload probe both hit status (2x); 3 publishes; no spend-upload.
    expect(status).toHaveBeenCalledTimes(2);
    expect(publishUnsigned).toHaveBeenCalledTimes(3);
    expect(uploadMedia).not.toHaveBeenCalled();
    // DeFi leg.
    expect(openChannel).toHaveBeenCalledWith({ destination: deFiOpts.destination });
    expect(swap).toHaveBeenCalledWith({
      destination: deFiOpts.destination,
      amount: deFiOpts.amount,
      millPubkey: deFiOpts.millPubkey,
      pair: deFiOpts.pair,
      chainRecipient: deFiOpts.chainRecipient,
    });
    expect(channels).toHaveBeenCalledOnce();
  });

  it('prints a panel for every step', async () => {
    const { client } = makeClient();
    const logger = captureLogger();
    await runCapstoneDemo(client, CAPSTONE_OPTS, logger);

    for (const id of [
      'onboard',
      'publish-profile',
      'publish-note',
      'follow',
      'store-upload',
      'open-channel',
      'swap',
      'settlement-receipt',
    ]) {
      expect(logger.out.some((l) => l.includes(`panel: ${id}`))).toBe(true);
    }
  });

  it('prints the settlement receipt sourced from swap + channels, no toon_settle', async () => {
    const { client } = makeClient();
    const logger = captureLogger();
    await runCapstoneDemo(client, CAPSTONE_OPTS, logger);

    const headerIdx = logger.out.findIndex((l) => l.includes('=== Settlement Receipt ==='));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    // The receipt is logged as a single JSON.stringify entry right after the header.
    const receiptBlock = logger.out[headerIdx + 1];
    expect(receiptBlock).toBeDefined();
    const parsed = JSON.parse(receiptBlock!);
    expect(parsed.accepted).toBe(true);
    expect(parsed.state).toBe('completed');
    expect(parsed.cumulativeSource).toBe(swapFixture.cumulativeSource);
    expect(parsed.cumulativeTarget).toBe(swapFixture.cumulativeTarget);
    expect(parsed.claims).toEqual(swapFixture.claims);
    expect(parsed.channels).toEqual(channelsFixture.channels);
  });

  it('halts on a tool error and exits non-zero with no receipt', async () => {
    const { client, swap } = makeClient();
    // Make the DeFi swap fail so the journey halts mid-DeFi.
    swap.mockRejectedValueOnce(new Error('mill unreachable'));
    const logger = captureLogger();
    const code = await runCapstoneDemo(client, CAPSTONE_OPTS, logger);

    expect(code).toBe(1);
    expect(logger.errs.join('\n')).toMatch(/FAILED at step "swap"/);
    expect(logger.out.join('\n')).not.toContain('=== Settlement Receipt ===');
  });

  it('halts on the very first step error with exit 1', async () => {
    const status = vi.fn().mockRejectedValue(new Error('daemon down'));
    const client = stubClient({ status });
    const logger = captureLogger();
    const code = await runCapstoneDemo(client, CAPSTONE_OPTS, logger);

    expect(code).toBe(1);
    expect(logger.errs.join('\n')).toMatch(/FAILED at step "onboard"/);
  });
});

describe('extractReceipt', () => {
  it('returns undefined when the journey halted before the DeFi leg', async () => {
    const { client, openChannel } = makeClient();
    openChannel.mockRejectedValueOnce(new Error('no channel'));
    const result = await runJourney(capstoneJourney(CAPSTONE_OPTS), client);
    expect(result.completed).toBe(false);
    expect(extractReceipt(result)).toBeUndefined();
  });

  it('joins swap + channels into a receipt on a completed run', async () => {
    const { client } = makeClient();
    const result = await runJourney(capstoneJourney(CAPSTONE_OPTS), client);
    const receipt = extractReceipt(result);
    expect(receipt).toEqual({
      accepted: true,
      state: 'completed',
      cumulativeSource: swapFixture.cumulativeSource,
      cumulativeTarget: swapFixture.cumulativeTarget,
      claims: swapFixture.claims,
      channels: channelsFixture.channels,
    });
  });
});

describe('main (env-driven CLI, dry)', () => {
  it('returns exit code 2 when required swap env is missing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main({ TOON_DAEMON_URL: 'http://127.0.0.1:8787' });
    expect(code).toBe(2);
    errSpy.mockRestore();
  });

  it('returns exit code 2 when TOON_SWAP_PAIR is not valid JSON', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await main({
      TOON_SWAP_DEST: 'g.proxy.mill',
      TOON_SWAP_AMOUNT: '1000000',
      TOON_MILL_PUBKEY: 'b'.repeat(64),
      TOON_CHAIN_RECIPIENT: '0xabc',
      TOON_SWAP_PAIR: '{not json',
    });
    expect(code).toBe(2);
    errSpy.mockRestore();
  });
});
