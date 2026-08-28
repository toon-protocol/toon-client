/**
 * The facade: what `create` settles, what it refuses to touch, and what `close`
 * does and does not do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { ChainUnavailableError, ChannelNotOpenError, ConfigError } from './errors.js';
import { settlementToTerms } from './channel-facade.js';
import type { ChannelManager } from '../channel/ChannelManager.js';

const CHANNEL = `0x${'ab'.repeat(32)}`;

const MNEMONIC = 'test test test test test test test test test test test junk';
const IDENTITY = deriveFullIdentity(MNEMONIC);

const SOLANA_SETTLEMENT = {
  chain: 'solana',
  settlementAddress: 'So11111111111111111111111111111111111111112',
  programId: '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip',
  tokenAddress: 'xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in',
  decimals: 6,
};

function fixture(): FakeTerminatingConnector {
  return new FakeTerminatingConnector({ endpoint: 'http://connector.test' });
}

function create(
  fake: FakeTerminatingConnector,
  overrides: Record<string, unknown> = {}
): Promise<ToonClient> {
  return ToonClient.create({
    connector: fake.endpoint,
    mnemonic: MNEMONIC,
    channelStore: new InMemoryChannelStore(),
    fetch: fake.fetch,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToonClient.create', () => {
  it('reads the node once and settles the chain, the identity and the edge', async () => {
    const fake = fixture();
    const client = await create(fake);

    expect(client.connector).toBe(fake.endpoint);
    expect(client.chain).toBe('evm');
    expect(client.identity.evmAddress).toBe(IDENTITY.evm.address);
    expect(client.identity.solanaPublicKey).toBe(IDENTITY.solana.publicKey);
    // A claim is labelled with the address on the chain it settles on.
    expect(client.identity.senderId).toBe(IDENTITY.evm.address);
  });

  it('takes the FIRST published settlement it holds a key for — the node\'s order is the preference', async () => {
    const fake = fixture();
    fake.describeSettlements = [SOLANA_SETTLEMENT, ...fake.describeSettlements];
    const client = await create(fake);
    expect(client.chain).toBe('solana');
    expect(client.identity.senderId).toBe(IDENTITY.solana.publicKey);
  });

  it('honours an explicit chain over the node\'s order', async () => {
    const fake = fixture();
    fake.describeSettlements = [SOLANA_SETTLEMENT, ...fake.describeSettlements];
    const client = await create(fake, { chain: 'evm' });
    expect(client.chain).toBe('evm');
  });

  it('refuses a chain the node does not settle on, naming the ones it does', async () => {
    const fake = fixture();
    const error = await create(fake, { chain: 'solana' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect((error as ChainUnavailableError).offered).toEqual(['evm:84532']);
  });

  it('refuses a node that settles on nothing — nothing can be paid for', async () => {
    const fake = fixture();
    fake.describeSettlements = [];
    await expect(create(fake)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('refuses when the client holds no key for any chain the node offers', async () => {
    const fake = fixture();
    fake.describeSettlements = [SOLANA_SETTLEMENT];
    const error = await ToonClient.create({
      connector: fake.endpoint,
      evmPrivateKey: `0x${'11'.repeat(32)}`,
      channelStore: new InMemoryChannelStore(),
      fetch: fake.fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect((error as Error).message).toContain('mnemonic');
  });

  it('lets an explicit senderId override the address — it is a label, never an authority', async () => {
    const client = await create(fixture(), { senderId: 'g.my.agent' });
    expect(client.identity.senderId).toBe('g.my.agent');
  });

  it('surfaces a configuration mistake before it reaches the network', async () => {
    await expect(
      ToonClient.create({ connector: 'not-a-url', mnemonic: MNEMONIC })
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('touches no chain: only the client edge is fetched', async () => {
    const fake = fixture();
    const seen: string[] = [];
    const spy: typeof fetch = (input, init) => {
      seen.push(String(input));
      return fake.fetch(input, init);
    };
    await create(fake, { fetch: spy });
    // Exactly one call, and it is the self-description. No RPC, no identity
    // round trip (the description carries the sealing key), no price lookup.
    expect(seen).toEqual([`${fake.endpoint}/ilp`]);
  });
});

describe('ToonClient.describe', () => {
  it('caches: the document describes a deployment, not a reading', async () => {
    const fake = fixture();
    let reads = 0;
    const spy: typeof fetch = (input, init) => {
      if (String(input).endsWith('/ilp') && (init?.method ?? 'GET') === 'GET') reads += 1;
      return fake.fetch(input, init);
    };
    const client = await create(fake, { fetch: spy });

    await client.describe();
    await client.describe();
    expect(reads).toBe(1);

    await client.describe({ fresh: true });
    expect(reads).toBe(2);
  });

  it('surfaces the node\'s routes and settlements as published', async () => {
    const client = await create(fixture());
    const description = await client.describe();
    expect(description.routes).toEqual([{ prefix: 'g.fake', price: 1000n }]);
    expect(description.settlements[0]).toMatchObject({ kind: 'evm', chain: 'evm:84532' });
    expect(description.edgeIdentity?.publicKey).toBeTruthy();
  });
});

describe('ToonClient.price', () => {
  it('answers the flat per-handler price', async () => {
    const client = await create(fixture());
    await expect(client.price('g.fake.route')).resolves.toBe(1000n);
  });

  it('answers null — "I do not terminate that" — rather than failing', async () => {
    const fake = fixture();
    fake.routePrice = null;
    const client = await create(fake);
    await expect(client.price('g.elsewhere')).resolves.toBeNull();
  });
});

describe('ToonClient — opening is never a side effect', () => {
  it('refuses to send with autoOpenChannel off and no channel held', async () => {
    const client = await create(fixture(), { autoOpenChannel: false });
    const error = await client.send('g.fake.route').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelNotOpenError);
    expect((error as ChannelNotOpenError).code).toBe('CHANNEL_NOT_OPEN');
  });

  it('refuses to probe with no channel to identify with', async () => {
    const client = await create(fixture(), { autoOpenChannel: false });
    await expect(client.probe('g.fake.route')).rejects.toBeInstanceOf(ChannelNotOpenError);
  });

  it('refuses to read, deposit into, close or settle a channel that does not exist', async () => {
    const client = await create(fixture(), { autoOpenChannel: false });
    await expect(client.channel.state()).rejects.toBeInstanceOf(ChannelNotOpenError);
    await expect(client.channel.deposit(1n)).rejects.toBeInstanceOf(ChannelNotOpenError);
    await expect(client.channel.close()).rejects.toBeInstanceOf(ChannelNotOpenError);
    await expect(client.channel.settle()).rejects.toBeInstanceOf(ChannelNotOpenError);
    expect(client.channel.id).toBeUndefined();
  });
});

describe('ToonClient.probe', () => {
  /**
   * A client with a channel already open, without touching a chain: the channel
   * is adopted straight into the manager, which is the restart path anyway.
   */
  async function withChannel(fake: FakeTerminatingConnector): Promise<ToonClient> {
    const client = await create(fake, { autoOpenChannel: false });
    const description = await client.describe();
    const terms = settlementToTerms(description.settlements[0]!);
    // Reaching for the manager keeps this test about `probe` rather than about
    // opening; `channel-facade.test.ts` owns the opening path.
    const channels = (client as unknown as { channels: ChannelManager }).channels;
    channels.adoptChannel(fake.endpoint, terms, CHANNEL);
    return client;
  }

  it('learns a path cost without buying the work behind it', async () => {
    const fake = fixture();
    const client = await withChannel(fake);

    const result = await client.probe('g.fake.route');
    // A destination this node terminates is answered F03 with the route's price
    // as the whole path cost — no hop was traversed to reach it.
    expect(result.code).toBe('F03');
    expect(result.accumulatedCost).toBe(1000n);
    // Nothing was delivered: the app was never called.
    expect(fake.opened).toHaveLength(0);
  });

  it('identifies with a claim that advances the nonce but moves no value', async () => {
    const fake = fixture();
    const client = await withChannel(fake);
    await client.probe('g.fake.route');

    const claim = fake.claims.at(-1)!;
    expect(claim['nonce']).toBe(1);
    // A replay is still refused, so the nonce advances — but the cumulative
    // does not, because a probe identifies rather than pays.
    expect(claim['transferredAmount']).toBe('0');
  });

  it('surfaces a 403 as a refusal to AUTHORIZE, distinct from failing to authenticate', async () => {
    const fake = fixture();
    fake.probeForbidden = true;
    const client = await withChannel(fake);
    await expect(client.probe('g.fake.route')).rejects.toThrow(/probe/i);
  });
});

describe('ToonClient.claimState', () => {
  it('asks about nothing when this client tracks no channel', async () => {
    const client = await create(fixture());
    await expect(client.claimState()).resolves.toEqual([]);
  });
});

describe('ToonClient.close', () => {
  it('releases the client without touching the channel', async () => {
    const client = await create(fixture());
    await expect(client.close()).resolves.toBeUndefined();
    // The channel is untouched: closing one starts a challenge period measured
    // in hours, and a script ending must not settle a user's collateral.
    expect(client.channel.id).toBeUndefined();
  });

  it('is idempotent', async () => {
    const client = await create(fixture());
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('refuses to send afterwards rather than silently reopening a carriage', async () => {
    const client = await create(fixture());
    await client.close();
    await expect(client.send('g.fake.route')).rejects.toBeInstanceOf(ConfigError);
  });
});
