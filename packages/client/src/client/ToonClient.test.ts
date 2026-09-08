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
import { startFakeSocks5 } from '../transport/fake-socks5.js';

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

describe('ToonClient.defaultDestination — a URL is the whole of the config', () => {
  // The route a node answers to is a fact it publishes. Making a caller repeat it
  // is how you end up paying a node for a route it does not serve.
  it('is the address the node published for itself', async () => {
    const client = await create(fixture());
    expect(client.defaultDestination).toBe('g.fake');
  });

  it('sends there when no destination is named', async () => {
    const fake = fixture();
    // Free route: this is about which destination is addressed, not about paying.
    fake.routePrice = 0n;
    const client = await create(fake);
    const result = await client.send({ body: 'hello' });
    expect(result.fulfilled).toBe(true);
    expect(fake.destinations).toEqual(['g.fake']);
  });

  it('still honours a destination the caller does name', async () => {
    const fake = fixture();
    fake.routePrice = 0n;
    fake.ilpAddresses = ['g.fake', 'g.fake.other'];
    const client = await create(fake);
    await client.send('g.fake.other', { body: 'hello' });
    expect(fake.destinations).toEqual(['g.fake.other']);
  });

  it('follows a re-read of the node', async () => {
    const fake = fixture();
    const client = await create(fake);
    fake.ilpAddresses = ['g.fake.renamed'];
    fake.routes = [{ prefix: 'g.fake.renamed', price: '1000' }];
    await client.describe({ fresh: true });
    expect(client.defaultDestination).toBe('g.fake.renamed');
  });

  it('refuses to guess when the node publishes no address', async () => {
    const fake = fixture();
    fake.ilpAddresses = [];
    const client = await create(fake);
    expect(client.defaultDestination).toBeUndefined();
    await expect(client.send({ body: 'hello' })).rejects.toBeInstanceOf(ConfigError);
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

/**
 * toon-client#671 — the read `send` performs before signing a claim on a
 * channel whose last one was signed and never confirmed. `send.test.ts` owns
 * the pipeline's half of this; here the subject is the wiring: a real
 * `POST /ilp/claim-state` round trip, and what the manager does with the answer.
 */
describe('ToonClient — reconciling a doubtful watermark', () => {
  /** A client tracking `CHANNEL`, with a doubt recorded against it. */
  async function withDoubt(fake: FakeTerminatingConnector): Promise<{
    client: ToonClient;
    channels: ChannelManager;
  }> {
    const client = await create(fake, { autoOpenChannel: false });
    const description = await client.describe();
    const terms = settlementToTerms(description.settlements[0]!);
    const channels = (client as unknown as { channels: ChannelManager }).channels;
    channels.adoptChannel(fake.endpoint, terms, CHANNEL);
    // A claim signed, sent, and lost to a timeout: repaid locally, and doubted.
    await channels.signBalanceProof(CHANNEL, 1000n);
    channels.rollbackAmount(CHANNEL, 1000n);
    channels.markWatermarkUncertain(CHANNEL);
    return { client, channels };
  }

  /** `send` reaches this through the port; the test reaches it directly. */
  function reconcile(client: ToonClient, channelId: string): Promise<void> {
    return (
      client as unknown as { reconcileWatermark(id: string): Promise<void> }
    ).reconcileWatermark(channelId);
  }

  it('adopts the figure the connector actually banked, and settles the doubt', async () => {
    const fake = fixture();
    const { client, channels } = await withDoubt(fake);
    // The packet WAS delivered: the connector banked the claim this client
    // gave up on.
    fake.banked.set(CHANNEL, { nonce: 1, cumulativeClaimed: 1000n, depositTotal: 100_000n });

    await reconcile(client, CHANNEL);

    expect(fake.claimStateAsks).toEqual([CHANNEL]);
    expect(channels.getCumulativeAmount(CHANNEL)).toBe(1000n);
    expect(channels.isWatermarkUncertain(CHANNEL)).toBe(false);
  });

  it('leaves the doubt in place for a channel the connector will not verify', async () => {
    const fake = fixture();
    const { client, channels } = await withDoubt(fake);
    // No entry: answered `ok: false, error: 'unverified'`, which covers "no
    // such channel" and "bad signature" identically — neither is a watermark.
    await reconcile(client, CHANNEL);

    expect(channels.getCumulativeAmount(CHANNEL)).toBe(0n);
    expect(channels.isWatermarkUncertain(CHANNEL)).toBe(true);
  });

  it('never adopts more than this client has signed, however much is reported', async () => {
    const fake = fixture();
    const { client, channels } = await withDoubt(fake);
    fake.banked.set(CHANNEL, { nonce: 1, cumulativeClaimed: 99_000_000n });

    await reconcile(client, CHANNEL);

    expect(channels.getCumulativeAmount(CHANNEL)).toBe(1000n);
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

/**
 * A node's endpoints are its own strings, and a hidden-service node may publish
 * absolute `.anyone` ones. The configured client edge stays authoritative for
 * reachability — so an advertised endpoint this client has no way to dial is
 * REFUSED, never resolved and never redirected. Without a proxy such an address
 * does not merely fail: the hostname goes out in a plaintext DNS query first,
 * which is exactly what a hidden service exists to prevent.
 */
describe('ToonClient — an endpoint the node advertises and this client cannot dial', () => {
  const HS_HOST = 'vk4kmzvhx7jgh2vkrqmb2xtoztgqkoqxhy3trkirpvfx7yr4h4ymxwyd.anyone';

  /**
   * Serves `fake`, but rewrites the endpoints its self-description publishes —
   * which is how a node advertises somewhere the configured edge does not live.
   */
  function publishing(
    fake: FakeTerminatingConnector,
    endpoints: Record<string, string>
  ): typeof fetch {
    const inner = fake.fetch;
    return async (input, init) => {
      const response = await inner(input, init);
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' || !(url.endsWith('/ilp') || url.endsWith('/ilp/'))) {
        return response;
      }
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, ...endpoints }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  it('refuses a published HTTP endpoint that is a hidden service, naming the missing proxy', async () => {
    const fake = fixture();
    const client = await create(fake, {
      fetch: publishing(fake, { httpEndpoint: `http://${HS_HOST}/ilp` }),
    });

    await expect(client.send('g.fake.route')).rejects.toBeInstanceOf(ConfigError);
    // Through the message: what is wrong, the knob that fixes it, and the way
    // out that does not need one.
    await expect(client.send('g.fake.route')).rejects.toThrow(
      /published the endpoint .*\.anyone/
    );
    await expect(client.send('g.fake.route')).rejects.toThrow(/socksProxy/);
    await expect(client.send('g.fake.route')).rejects.toThrow(/anon.*daemon/is);
    await expect(client.send('g.fake.route')).rejects.toThrow(/socks5h:\/\/127\.0\.0\.1:9050/);
    await expect(client.send('g.fake.route')).rejects.toThrow(/clearnet endpoint/);
  });

  it('refuses BEFORE anything dials — the address never reaches a DNS lookup', async () => {
    const fake = fixture();
    const seen: string[] = [];
    const published = publishing(fake, { httpEndpoint: `http://${HS_HOST}/ilp` });
    const spy: typeof fetch = async (input, init) => {
      seen.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
      return published(input, init);
    };
    const client = await create(fake, { fetch: spy });

    await expect(client.send('g.fake.route')).rejects.toBeInstanceOf(ConfigError);

    // Nothing was ever addressed to the hidden service…
    expect(seen.filter((r) => r.includes('.anyone'))).toEqual([]);
    // …and the check REFUSED rather than redirecting: the packet was not
    // quietly re-addressed to the configured edge either. Only the reads that
    // precede carriage selection happened.
    expect(seen.filter((r) => r.startsWith('POST'))).toEqual([]);
    expect(client.connector).toBe(fake.endpoint);
  });

  it("checks the selected carriage's own URL, not only the HTTP endpoint", async () => {
    const fake = fixture();
    // Clearnet HTTP, hidden-service BTP, and the node pins BTP: the only
    // hidden-service string in play is `choice.url`.
    fake.requiredTransport = 'btp';
    const client = await create(fake, {
      fetch: publishing(fake, { btpEndpoint: `ws://${HS_HOST}/ilp/btp` }),
    });

    await expect(client.send('g.fake.route')).rejects.toThrow(
      new RegExp(`published the endpoint "ws://${HS_HOST}/ilp/btp"`)
    );
  });

  it('checks the resolved HTTP endpoint beneath a BTP carriage', async () => {
    const fake = fixture();
    // The mirror image: the carriage URL is clearnet, and the hidden service is
    // only the HTTP endpoint resolved for the fallback beneath it.
    fake.requiredTransport = 'btp';
    const client = await create(fake, {
      fetch: publishing(fake, { httpEndpoint: `http://${HS_HOST}/ilp` }),
    });

    await expect(client.send('g.fake.route')).rejects.toThrow(
      new RegExp(`published the endpoint "http://${HS_HOST}/ilp"`)
    );
  });

  it('dials a published hidden-service endpoint normally when a proxy IS configured', async () => {
    const proxy = await startFakeSocks5(new Map());
    const fake = new FakeTerminatingConnector({ endpoint: `http://${HS_HOST}` });
    // The node publishes its own absolute `.anyone` endpoint, exactly as a
    // hidden-service node does.
    const client = await ToonClient.create({
      connector: fake.endpoint,
      mnemonic: MNEMONIC,
      channelStore: new InMemoryChannelStore(),
      socksProxy: proxy.url,
      // An injected `fetch` wins over the proxy's, so this exercises the check
      // rather than the overlay — `transport/socks.test.ts` owns the overlay.
      fetch: fake.fetch,
      autoOpenChannel: false,
    });

    try {
      const description = await client.describe();
      expect(description.httpEndpoint).toBe(`http://${HS_HOST}/ilp`);
      const [settlement] = description.settlements;
      if (settlement === undefined) throw new Error('the fixture publishes a settlement');
      const terms = settlementToTerms(settlement);
      const channels = (client as unknown as { channels: ChannelManager }).channels;
      channels.adoptChannel(fake.endpoint, terms, CHANNEL);

      // Not refused: the carriage is built against the published `.anyone`
      // endpoint and the request is paid for over it.
      const result = await client.send('g.fake.route');
      expect(result.fulfilled).toBe(true);
      expect(fake.paidRequests).toBe(1);
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});
