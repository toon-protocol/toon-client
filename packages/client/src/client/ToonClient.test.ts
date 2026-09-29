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
import type {
  BatchChannel,
  BatchChannelManager,
} from '../channel/batch-settlement/manager.js';
import type { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { startFakeSocks5 } from '../transport/fake-socks5.js';

const CHANNEL = `0x${'ab'.repeat(32)}`;

const MNEMONIC = 'test test test test test test test test test test test junk';
const IDENTITY = deriveFullIdentity(MNEMONIC);

const SOLANA_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const SOLANA_SETTLEMENT = {
  network: SOLANA_NETWORK,
  asset: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
  payTo: 'So11111111111111111111111111111111111111112',
  feePayer: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  sponsorEndpoint: '/ilp/batch-settlement/solana/open',
  minDeposit: '1000',
  withdrawDelay: 86_400,
};

/** The client's private wiring, which these tests reach into rather than a chain. */
interface Internals {
  manager: BatchChannelManager;
  payer: BatchSettlementPayer;
  connectorWatermark(entry: Record<string, unknown>): Promise<bigint | undefined>;
}

function internals(client: ToonClient): Internals {
  return client as unknown as Internals;
}

/**
 * The EVM channel the fake's `batchSettlements[0]` would have opened, recorded
 * straight into the manager with a deposit — which is the restart path anyway,
 * and keeps these tests off a chain. `channel-facade.test.ts` and the payer's
 * own suite own the opening path.
 */
function adoptChannel(client: ToonClient, fake: FakeTerminatingConnector): BatchChannel {
  const terms = fake.batchSettlements[0]!;
  const channel: BatchChannel = {
    chain: 'evm',
    channelId: CHANNEL,
    network: String(terms['network']),
    config: {
      payer: IDENTITY.evm.address,
      payerAuthorizer: IDENTITY.evm.address,
      receiver: String(terms['payTo']),
      receiverAuthorizer: String(terms['receiverAuthorizer']),
      token: String(terms['asset']),
      withdrawDelay: Number(terms['withdrawDelay']),
      salt: `0x${'00'.repeat(32)}`,
    },
  };
  internals(client).manager.adopt(fake.endpoint, channel, 100_000n);
  return channel;
}

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
    fake.batchSettlements = [SOLANA_SETTLEMENT, ...fake.batchSettlements];
    const client = await create(fake);
    expect(client.chain).toBe('solana');
    expect(client.identity.senderId).toBe(IDENTITY.solana.publicKey);
  });

  it('honours an explicit chain over the node\'s order', async () => {
    const fake = fixture();
    fake.batchSettlements = [SOLANA_SETTLEMENT, ...fake.batchSettlements];
    const client = await create(fake, { chain: 'evm' });
    expect(client.chain).toBe('evm');
  });

  it('refuses a chain the node does not settle on, naming the ones it does', async () => {
    const fake = fixture();
    const error = await create(fake, { chain: 'solana' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainUnavailableError);
    expect((error as ChainUnavailableError).offered).toEqual(['eip155:84532']);
  });

  it('refuses a node that settles on nothing — nothing can be paid for', async () => {
    const fake = fixture();
    fake.batchSettlements = [];
    await expect(create(fake)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('refuses when the client holds no key for any chain the node offers', async () => {
    const fake = fixture();
    fake.batchSettlements = [SOLANA_SETTLEMENT];
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
    expect(description.batchSettlements[0]).toMatchObject({
      chain: 'evm',
      network: 'eip155:84532',
    });
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

  it('refuses to deposit into or close a channel that does not exist, and settles nothing', async () => {
    const client = await create(fixture(), { autoOpenChannel: false });
    await expect(client.channel.current()).resolves.toBeUndefined();
    expect(client.channel.channels()).toEqual([]);
    await expect(client.channel.deposit(1n)).rejects.toBeInstanceOf(ChannelNotOpenError);
    await expect(client.channel.close()).rejects.toBeInstanceOf(ChannelNotOpenError);
    await expect(client.channel.settle()).resolves.toEqual([]);
  });
});

describe('ToonClient.probe', () => {
  /** A client holding a channel it has already paid on once. */
  async function withVoucher(fake: FakeTerminatingConnector): Promise<ToonClient> {
    const client = await create(fake, { autoOpenChannel: false });
    adoptChannel(client, fake);
    const paid = await client.send('g.fake.route');
    expect(paid.fulfilled).toBe(true);
    return client;
  }

  it('learns a path cost without buying the work behind it', async () => {
    const fake = fixture();
    const client = await withVoucher(fake);
    const delivered = fake.opened.length;

    const result = await client.probe('g.fake.route');
    // A destination this node terminates is answered F03 with the route's price
    // as the whole path cost — no hop was traversed to reach it.
    expect(result.code).toBe('F03');
    expect(result.accumulatedCost).toBe(1000n);
    // Nothing more was delivered: the app was not called for the probe.
    expect(fake.opened).toHaveLength(delivered);
  });

  it('identifies with the latest voucher, resent byte for byte — it pays nothing more', async () => {
    const fake = fixture();
    const client = await withVoucher(fake);
    const paid = fake.claims.at(-1)!;
    await client.probe('g.fake.route');

    expect(fake.claims.at(-1)).toEqual(paid);
    expect(paid['maxClaimableAmount']).toBe('1000');
    // And the running total did not move: the next paid voucher is 2000.
    await client.send('g.fake.route');
    expect(fake.claims.at(-1)!['maxClaimableAmount']).toBe('2000');
  });

  it('refuses on a channel held but never paid on — there is no voucher to identify with', async () => {
    const fake = fixture();
    const client = await create(fake, { autoOpenChannel: false });
    adoptChannel(client, fake);
    await expect(client.probe('g.fake.route')).rejects.toBeInstanceOf(ChannelNotOpenError);
  });

  it('surfaces a 403 as a refusal to AUTHORIZE, distinct from failing to authenticate', async () => {
    const fake = fixture();
    const client = await withVoucher(fake);
    fake.probeForbidden = true;
    await expect(client.probe('g.fake.route')).rejects.toThrow(/probe/i);
  });
});

describe('ToonClient.claimState', () => {
  it('asks about nothing when this client tracks no channel', async () => {
    const client = await create(fixture());
    await expect(client.claimState()).resolves.toEqual([]);
  });

  it('proves control with the voucher claim-state challenge, and reports the connector\'s watermark', async () => {
    const fake = fixture();
    const asked: Record<string, unknown>[] = [];
    const spy: typeof fetch = (input, init) => {
      if (String(input).endsWith('/ilp/claim-state')) {
        asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return fake.fetch(input, init);
    };
    const client = await create(fake, { fetch: spy });
    adoptChannel(client, fake);
    fake.banked.set(CHANNEL, { cumulativeClaimed: 3000n, maxCumulative: 100_000n });

    const [entry] = await client.claimState();

    expect(entry).toMatchObject({
      channelId: CHANNEL,
      ok: true,
      scheme: 'batch-settlement',
      cumulativeClaimed: '3000',
      maxCumulative: '100000',
      available: '97000',
    });
    const [challenge] = (asked[0]?.['channels'] ?? []) as Record<string, unknown>[];
    expect(challenge).toMatchObject({ channelId: CHANNEL });
    expect(challenge?.['channelConfig']).toBeDefined();
    expect(String(challenge?.['signature'])).toMatch(/^0x[0-9a-f]{130}$/);
    const expires = Number(challenge?.['expires']);
    expect(expires).toBeGreaterThan(Date.now() / 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() / 1000 + 300);
  });

  it('asks only about the channels named', async () => {
    const fake = fixture();
    const client = await create(fake);
    adoptChannel(client, fake);
    await expect(client.claimState([`0x${'cd'.repeat(32)}`])).resolves.toEqual([]);
    expect(fake.claimStateAsks).toEqual([]);
  });
});

/**
 * Where the connector's watermark comes from when this client's own is in
 * doubt: a real `POST /ilp/claim-state` round trip behind the payer's
 * `connectorWatermark` port, and what the manager does with the answer. The
 * payer's suite owns WHEN it asks; the subject here is the wiring.
 */
describe('ToonClient — reading the connector\'s watermark', () => {
  async function withChannel(fake: FakeTerminatingConnector): Promise<{
    client: ToonClient;
    channel: BatchChannel;
  }> {
    const client = await create(fake, { autoOpenChannel: false });
    const channel = adoptChannel(client, fake);
    return { client, channel };
  }

  async function ask(client: ToonClient, channel: BatchChannel): Promise<bigint | undefined> {
    const { payer, connectorWatermark } = internals(client);
    const entry = await payer.challenge(channel, BigInt(Math.floor(Date.now() / 1000) + 60));
    return connectorWatermark.call(client, entry);
  }

  /** The payer's resync, reached directly. */
  function resync(client: ToonClient, channel: BatchChannel): Promise<void> {
    return (
      internals(client).payer as unknown as { resync(c: BatchChannel): Promise<void> }
    ).resync(channel);
  }

  it('answers the figure the connector actually banked', async () => {
    const fake = fixture();
    const { client, channel } = await withChannel(fake);
    fake.banked.set(CHANNEL, { cumulativeClaimed: 1000n });

    await expect(ask(client, channel)).resolves.toBe(1000n);
    expect(fake.claimStateAsks).toEqual([CHANNEL]);
  });

  it('answers nothing for a channel the connector will not verify', async () => {
    const fake = fixture();
    const { client, channel } = await withChannel(fake);
    // No entry: answered `ok: false, error: 'unverified'`, which covers "no
    // such channel" and "bad signature" identically — neither is a watermark.
    await expect(ask(client, channel)).resolves.toBeUndefined();
  });

  it('adopts the banked figure as the running total the next voucher builds on', async () => {
    const fake = fixture();
    const { client, channel } = await withChannel(fake);
    // Two vouchers signed, the second lost in transit before the connector
    // ever saw it — and then a figure read back from the connector.
    await client.send('g.fake.route');
    internals(client).manager.reserve(CHANNEL, 1000n);
    fake.banked.set(CHANNEL, { cumulativeClaimed: 1000n });

    await resync(client, channel);

    expect(internals(client).manager.signedSoFar(CHANNEL)).toBe(1000n);
    await client.send('g.fake.route');
    expect(fake.claims.at(-1)!['maxClaimableAmount']).toBe('2000');
  });

  it('never adopts more than this client has signed, however much is reported', async () => {
    const fake = fixture();
    const { client, channel } = await withChannel(fake);
    await client.send('g.fake.route');
    fake.banked.set(CHANNEL, { cumulativeClaimed: 99_000_000n });

    await resync(client, channel);

    expect(internals(client).manager.signedSoFar(CHANNEL)).toBe(1000n);
  });

  it('leaves the local figure alone when the connector will not say', async () => {
    const fake = fixture();
    const { client, channel } = await withChannel(fake);
    await client.send('g.fake.route');

    await resync(client, channel);

    expect(internals(client).manager.signedSoFar(CHANNEL)).toBe(1000n);
  });
});

describe('ToonClient.close', () => {
  it('releases the client without touching the channel', async () => {
    const client = await create(fixture());
    await expect(client.close()).resolves.toBeUndefined();
    // No channel was touched: leaving one starts a withdrawal window measured
    // in hours, and a script ending must not pull a user's deposit.
    expect(client.channel.channels()).toEqual([]);
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

  /**
   * TOON_Network#111: a route's own pin decides the carriage, on the first
   * attempt, with no refusal round trip.
   *
   * This node is the devnet relay's shape — one pinned address, one not — so
   * there is no node-wide `requiredTransport` to read and the pin can only come
   * from the route entry. Proved through the reachability check: it names
   * `choice.url`, and the only hidden-service string in play is the BTP one. A
   * client that had chosen HTTP would have sent a POST and been refused instead.
   */
  it("dials the carriage the destination's own route pins, with no node-wide field", async () => {
    const fake = fixture();
    fake.ilpAddresses = ['g.fake', 'g.fake.free'];
    fake.routes = [
      { prefix: 'g.fake', price: '1000', requiredTransport: 'btp' },
      { prefix: 'g.fake.free', price: '0' },
    ];
    const posts: string[] = [];
    const published = publishing(fake, { btpEndpoint: `ws://${HS_HOST}/ilp/btp` });
    const spy: typeof fetch = async (input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') posts.push(String(input));
      return published(input, init);
    };
    const client = await create(fake, { fetch: spy });

    const description = await client.describe();
    expect(description.requiredTransport).toBeUndefined();

    await expect(client.send('g.fake.route')).rejects.toThrow(
      new RegExp(`published the endpoint "ws://${HS_HOST}/ilp/btp"`)
    );
    expect(posts).toEqual([]);
  });

  /**
   * The other half of the same rule: an unpinned route on that same node is
   * left exactly as it was, over HTTP.
   */
  it('leaves an unpinned route on a pinning node on HTTP', async () => {
    const fake = fixture();
    fake.ilpAddresses = ['g.fake', 'g.fake.free'];
    fake.routes = [
      { prefix: 'g.fake', price: '1000', requiredTransport: 'btp' },
      { prefix: 'g.fake.free', price: '0' },
    ];
    // `routes` only shapes the SELF-DESCRIPTION this fake publishes (what
    // `requiredTransportFor` reads); the fake's own request handling — the
    // `GET /ilp/routes/price` answer and the claim gate on `POST /ilp` — is
    // keyed on the flat `routePrice` scalar instead (it has no per-prefix
    // pricing of its own). Leaving it at the default 1000n would make
    // "g.fake.free" priced in fact, so `send` would open a real channel to
    // pay for it — reaching out to a live chain RPC that a unit test must
    // never touch. Zeroing it here is what actually makes the route free.
    fake.routePrice = 0n;
    const seen: string[] = [];
    const spy: typeof fetch = (input, init) => {
      seen.push(String(input));
      return publishing(fake, { btpEndpoint: `ws://${HS_HOST}/ilp/btp` })(input, init);
    };
    const client = await create(fake, { fetch: spy });

    // The BTP endpoint is unreachable for want of a proxy, so reaching it at
    // all would refuse. This route is answered over HTTP instead.
    const result = await client.send('g.fake.free');
    expect(result.fulfilled).toBe(true);
    // Hermetic: every request this test made landed on the fake connector's
    // own origin. In particular, no chain RPC (e.g. a live testnet endpoint)
    // and no dial of the unreachable `.anyone` BTP host ever happened.
    expect(seen.every((url) => url.startsWith(fake.endpoint))).toBe(true);
    expect(seen.some((url) => url.includes('.anyone'))).toBe(false);
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
      adoptChannel(client, fake);

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
