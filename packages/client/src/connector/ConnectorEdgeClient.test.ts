import { describe, it, expect, vi } from 'vitest';
import {
  ConnectorEdgeClient,
  ConnectorEdgeError,
  connectorEdgeBaseUrl,
  decodeConnectorPublicKey,
  parseConnectorIdentity,
  parseConnectorRoutePrice,
  parseConnectorRouteTerms,
  parseClaimStateResponse,
} from './ConnectorEdgeClient.js';
import { NetworkError, ConnectorError } from '../client/errors.js';
import { deserializeIlpPrepare } from '../btp/protocol.js';

/**
 * A 65-byte SEC1-uncompressed secp256k1 key: `0x04` + 64 body bytes. The exact
 * bytes don't matter (nothing here does curve arithmetic) — the LENGTH and the
 * PREFIX are the contract, per `GET /ilp/identity` (client-edge-spec §1.7).
 */
const VALID_KEY_HEX = `0x04${'ab'.repeat(64)}`;

/** The URL of the nth request the mocked fetch was given. */
function requestedUrl(
  fetchImpl: { mock: { calls: [string, RequestInit?][] } },
  index = 0
): string | undefined {
  return fetchImpl.mock.calls[index]?.[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('connectorEdgeBaseUrl', () => {
  it('accepts the POST /ilp endpoint a caller already holds', () => {
    expect(connectorEdgeBaseUrl('https://apex.example/ilp')).toBe(
      'https://apex.example'
    );
  });

  it('accepts a bare origin, with or without a trailing slash', () => {
    expect(connectorEdgeBaseUrl('https://apex.example')).toBe(
      'https://apex.example'
    );
    expect(connectorEdgeBaseUrl('https://apex.example/')).toBe(
      'https://apex.example'
    );
  });

  it('preserves a path prefix the connector is mounted under', () => {
    expect(connectorEdgeBaseUrl('https://host.example/connector/ilp')).toBe(
      'https://host.example/connector'
    );
  });

  it('drops a query string and fragment', () => {
    expect(connectorEdgeBaseUrl('https://apex.example/ilp?a=1#f')).toBe(
      'https://apex.example'
    );
  });

  it('refuses a non-URL rather than guessing', () => {
    expect(() => connectorEdgeBaseUrl('apex.example')).toThrow(
      ConnectorEdgeError
    );
  });
});

describe('decodeConnectorPublicKey', () => {
  it('decodes an uncompressed key to 65 raw bytes', () => {
    const bytes = decodeConnectorPublicKey(VALID_KEY_HEX);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
    expect(bytes[1]).toBe(0xab);
  });

  it.each([
    ['no 0x prefix', `04${'ab'.repeat(64)}`, 'IDENTITY_KEY_NOT_HEX'],
    ['non-hex characters', `0x04${'zz'.repeat(64)}`, 'IDENTITY_KEY_NOT_HEX'],
    ['odd length', `0x04${'ab'.repeat(63)}a`, 'IDENTITY_KEY_NOT_HEX'],
    ['too short', `0x04${'ab'.repeat(31)}`, 'IDENTITY_KEY_LENGTH'],
    ['too long', `0x04${'ab'.repeat(65)}`, 'IDENTITY_KEY_LENGTH'],
    [
      'compressed-form prefix at the right length',
      `0x02${'ab'.repeat(64)}`,
      'IDENTITY_KEY_NOT_UNCOMPRESSED',
    ],
  ])('refuses %s with a distinguishable code', (_name, hex, code) => {
    expect(() => decodeConnectorPublicKey(hex)).toThrow(ConnectorEdgeError);
    try {
      decodeConnectorPublicKey(hex);
    } catch (error) {
      expect((error as ConnectorEdgeError).code).toBe(code);
    }
  });
});

describe('parseConnectorIdentity', () => {
  it('parses the body the connector actually emits', () => {
    // Pinned against `identity()` in crates/connector-client-edge/src/lib.rs:
    // `{ "keyId": ..., "publicKey": "0x04..." }`, and nothing else.
    const identity = parseConnectorIdentity(
      { keyId: 'apex-key-1', publicKey: VALID_KEY_HEX },
      'https://apex.example'
    );
    expect(identity.keyId).toBe('apex-key-1');
    expect(identity.publicKeyHex).toBe(VALID_KEY_HEX);
    expect(identity.publicKey).toHaveLength(65);
    expect(identity.endpoint).toBe('https://apex.example');
  });

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', []],
    ['a missing keyId', { publicKey: VALID_KEY_HEX }],
    ['a missing publicKey', { keyId: 'k' }],
    ['an empty publicKey', { keyId: 'k', publicKey: '' }],
  ])('refuses %s as malformed', (_name, body) => {
    expect(() => parseConnectorIdentity(body, 'https://apex.example')).toThrow(
      ConnectorEdgeError
    );
  });
});

describe('parseConnectorRoutePrice', () => {
  it('parses the documented 200 body', () => {
    expect(
      parseConnectorRoutePrice({ destination: 'g.example.app', price: 100 })
    ).toEqual({ destination: 'g.example.app', price: 100n });
  });

  it.each([
    ['a string price', { destination: 'g.a', price: '100' }],
    ['a fractional price', { destination: 'g.a', price: 1.5 }],
    ['a negative price', { destination: 'g.a', price: -1 }],
    ['a missing destination', { price: 100 }],
  ])('refuses %s', (_name, body) => {
    expect(() => parseConnectorRoutePrice(body)).toThrow(ConnectorEdgeError);
  });

  // The deployed store node answers this endpoint with a snake_case
  // `price_per_kib` beside the camelCase `pricePerKib` it puts in `GET /ilp`.
  // Dropping it quoted a metered route at its base price and every send was
  // refused `F03`.
  it('reads the snake_case per-KiB rate this endpoint uses', () => {
    expect(
      parseConnectorRoutePrice({
        destination: 'g.toon.store',
        price: 1000,
        price_per_kib: 10,
      })
    ).toEqual({ destination: 'g.toon.store', price: 1000n, pricePerKib: 10n });
  });

  it('also accepts the camelCase spelling', () => {
    expect(
      parseConnectorRoutePrice({
        destination: 'g.toon.store',
        price: 1000,
        pricePerKib: 10,
      }).pricePerKib
    ).toBe(10n);
  });

  it('omits the rate entirely on a flat-priced route', () => {
    expect(
      parseConnectorRoutePrice({ destination: 'g.a', price: 100 })
    ).not.toHaveProperty('pricePerKib');
  });

  it('treats an unusable rate as absent rather than failing the whole quote', () => {
    expect(
      parseConnectorRoutePrice({ destination: 'g.a', price: 100, price_per_kib: 'lots' })
    ).not.toHaveProperty('pricePerKib');
  });
});

describe('ConnectorEdgeClient.getIdentity', () => {
  it('asks GET /ilp/identity on the client edge and returns the key', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({ keyId: 'apex-key-1', publicKey: VALID_KEY_HEX })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    // Given the POST /ilp URL a caller already has, not a bare origin.
    const identity = await client.getIdentity('https://apex.example/ilp');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestedUrl(fetchImpl)).toBe('https://apex.example/ilp/identity');
    expect(identity.publicKey).toHaveLength(65);
  });

  it('caches per endpoint rather than re-fetching per packet', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockImplementation(async (url: string) =>
        jsonResponse({ keyId: url, publicKey: VALID_KEY_HEX })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getIdentity('https://apex.example/ilp');
    await client.getIdentity('https://apex.example');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A DIFFERENT connector is a different cache entry.
    await client.getIdentity('https://store.example/ilp');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one round trip between concurrent callers', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ keyId: 'k', publicKey: VALID_KEY_HEX })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([
      client.getIdentity('https://apex.example'),
      client.getIdentity('https://apex.example'),
      client.getIdentity('https://apex.example'),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is invalidatable, per endpoint and wholesale', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ keyId: 'k', publicKey: VALID_KEY_HEX })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getIdentity('https://apex.example');
    expect(client.hasCachedIdentity('https://apex.example/ilp')).toBe(true);

    client.invalidateIdentity('https://apex.example/ilp');
    expect(client.hasCachedIdentity('https://apex.example')).toBe(false);
    await client.getIdentity('https://apex.example');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    client.invalidateIdentity();
    await client.getIdentity('https://apex.example');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('re-fetches on forceRefresh', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ keyId: 'k', publicKey: VALID_KEY_HEX })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getIdentity('https://apex.example');
    await client.getIdentity('https://apex.example', { forceRefresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ keyId: 'k', publicKey: VALID_KEY_HEX })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getIdentity('https://apex.example')).rejects.toThrow(
      ConnectorEdgeError
    );
    await expect(
      client.getIdentity('https://apex.example')
    ).resolves.toMatchObject({ keyId: 'k' });
  });

  it('refuses a bad key rather than carrying it forward', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({ keyId: 'k', publicKey: `0x04${'ab'.repeat(10)}` })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getIdentity('https://apex.example')
    ).rejects.toMatchObject({ code: 'IDENTITY_KEY_LENGTH' });
  });

  it('distinguishes a transport failure from a refusal', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getIdentity('https://apex.example')).rejects.toThrow(
      NetworkError
    );
  });
});

describe('ConnectorEdgeClient.getRoutePrice', () => {
  it('asks GET /ilp/routes/price with an encoded destination', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({ destination: 'g.example.app', price: 100 })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const price = await client.getRoutePrice(
      'https://apex.example/ilp',
      'g.example.app'
    );

    expect(requestedUrl(fetchImpl)).toBe(
      'https://apex.example/ilp/routes/price?destination=g.example.app'
    );
    expect(price).toEqual({ destination: 'g.example.app', price: 100n });
  });

  it('percent-encodes a destination that needs it', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(jsonResponse({ destination: 'g.a b', price: 1 }));
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getRoutePrice('https://apex.example', 'g.a b');
    expect(requestedUrl(fetchImpl)).toContain('destination=g.a%20b');
  });

  it('answers null for a 404 — no locally-terminated route matches', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(
        new Response("no locally-terminated route matches 'g.nope'", {
          status: 404,
        })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getRoutePrice('https://apex.example', 'g.nope')
    ).resolves.toBeNull();
  });

  it('throws NetworkError on a transport failure, so it is not read as a 404', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockRejectedValue(new Error('ETIMEDOUT'));
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getRoutePrice('https://apex.example', 'g.example.app')
    ).rejects.toThrow(NetworkError);
  });

  it('refuses a 5xx distinguishably from a 404', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getRoutePrice('https://apex.example', 'g.example.app')
    ).rejects.toMatchObject({ code: 'ROUTE_PRICE_HTTP_STATUS' });
  });

  it('refuses an empty destination before making a request', async () => {
    const fetchImpl = vi.fn<[string, RequestInit?], Promise<Response>>();
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getRoutePrice('https://apex.example', '  ')
    ).rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ConnectorEdgeClient route-price caching (toon-client#452)', () => {
  // A FRESH Response per call: a Response body is single-use, so a shared one
  // would fail the second read rather than the assertion under test.
  const priced = (price: number) =>
    vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ destination: 'g.example.app', price })
      );

  it('fetches once per (endpoint, destination) and reuses the answer', async () => {
    const fetchImpl = priced(100);
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getRoutePrice('https://apex.example', 'g.example.app');
    await client.getRoutePrice('https://apex.example/ilp', 'g.example.app');
    await client.getRoutePrice('https://apex.example', 'g.example.app');

    // The trailing `/ilp` normalizes away, so all three are the same route.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      client.hasCachedRoutePrice('https://apex.example', 'g.example.app')
    ).toBe(true);
  });

  it('shares one round trip between concurrent callers', async () => {
    const fetchImpl = priced(100);
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([
      client.getRoutePrice('https://apex.example', 'g.example.app'),
      client.getRoutePrice('https://apex.example', 'g.example.app'),
      client.getRoutePrice('https://apex.example', 'g.example.app'),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by destination, not only by endpoint', async () => {
    const fetchImpl = priced(100);
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getRoutePrice('https://apex.example', 'g.example.app');
    await client.getRoutePrice('https://apex.example', 'g.example.other');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches a 404 — "I do not terminate that" is an answer, not a failure', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockImplementation(
        async () => new Response('no route', { status: 404 })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getRoutePrice('https://apex.example', 'g.nowhere')
    ).resolves.toBeNull();
    await expect(
      client.getRoutePrice('https://apex.example', 'g.nowhere')
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a transport failure — a transient error must be retryable', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValue(
        jsonResponse({ destination: 'g.example.app', price: 100 })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getRoutePrice('https://apex.example', 'g.example.app')
    ).rejects.toMatchObject({ code: 'ROUTE_PRICE_HTTP_STATUS' });
    await expect(
      client.getRoutePrice('https://apex.example', 'g.example.app')
    ).resolves.toEqual({ destination: 'g.example.app', price: 100n });
  });

  it('forceRefresh replaces the cached answer', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse({ destination: 'g.example.app', price: 100 })
      )
      .mockResolvedValue(
        jsonResponse({ destination: 'g.example.app', price: 250 })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getRoutePrice('https://apex.example', 'g.example.app');
    const repriced = await client.getRoutePrice(
      'https://apex.example',
      'g.example.app',
      { forceRefresh: true }
    );
    expect(repriced?.price).toBe(250n);
  });

  it('invalidateRoutePrice drops one route, one endpoint, or all of them', async () => {
    const fetchImpl = priced(100);
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.getRoutePrice('https://apex.example', 'g.a');
    await client.getRoutePrice('https://apex.example', 'g.b');
    await client.getRoutePrice('https://other.example', 'g.a');

    client.invalidateRoutePrice('https://apex.example', 'g.a');
    expect(client.hasCachedRoutePrice('https://apex.example', 'g.a')).toBe(
      false
    );
    expect(client.hasCachedRoutePrice('https://apex.example', 'g.b')).toBe(
      true
    );

    client.invalidateRoutePrice('https://apex.example');
    expect(client.hasCachedRoutePrice('https://apex.example', 'g.b')).toBe(
      false
    );
    expect(client.hasCachedRoutePrice('https://other.example', 'g.a')).toBe(
      true
    );

    client.invalidateRoutePrice();
    expect(client.hasCachedRoutePrice('https://other.example', 'g.a')).toBe(
      false
    );
  });
});

/**
 * Connector #632: the x402 greeting additively carries a per-chain
 * `settlements` list beside the legacy EVM-shaped `settlement` object — a
 * two-chain node advertises both an EVM and a Solana entry, disambiguated
 * structurally (untagged wire, `tokenNetworkRegistry` for EVM vs `programId`
 * for Solana) since the connector adds no explicit tag.
 */
// Both entries as the connector writes them (`batch_settlement_accept`).
const EVM_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x' + 'f'.repeat(40),
  payTo: '0x' + 'a'.repeat(40),
  maxTimeoutSeconds: 60,
  extra: {
    receiverAuthorizer: '0x' + 'a'.repeat(40),
    withdrawDelay: 86_400,
    name: 'USDC',
    version: '2',
  },
};
const SOLANA_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  amount: '1000',
  asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  payTo: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
  maxTimeoutSeconds: 60,
  extra: {
    feePayer: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
    withdrawDelay: 86_400,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    minDeposit: '1000000',
    sponsorEndpoint: '/ilp/batch-settlement/solana/open',
  },
};

/** A v7 greeting: batch-settlement `accepts[]`, TOON's facts in `extensions.toon.info`. */
function greetingBody(
  accepts: unknown[],
  info: Record<string, unknown> = {},
  price = '1000'
): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: 'g.fake.route' },
    accepts,
    extensions: {
      toon: {
        info: { ilpAddress: 'g.fake.route', amount: price, endpoint: '/ilp', price, ...info },
        schema: {},
      },
    },
  };
}

describe('parseConnectorRouteTerms — per-chain batch-settlement offers (ADR 0075)', () => {
  it('parses an EVM-only greeting into one offer', () => {
    const terms = parseConnectorRouteTerms(greetingBody([EVM_ACCEPT]));
    expect(terms.destination).toBe('g.fake.route');
    expect(terms.price).toBe('1000');
    expect(terms.batchSettlements).toEqual([{ chain: 'evm', offer: EVM_ACCEPT }]);
  });

  it('parses a two-chain greeting, telling EVM and Solana apart by CAIP-2 network', () => {
    const terms = parseConnectorRouteTerms(greetingBody([EVM_ACCEPT, SOLANA_ACCEPT]));
    expect(terms.batchSettlements).toEqual([
      { chain: 'evm', offer: EVM_ACCEPT },
      { chain: 'solana', offer: SOLANA_ACCEPT },
    ]);
  });

  it('drops a malformed entry but keeps the well-formed ones', () => {
    const malformed = { ...SOLANA_ACCEPT, extra: { ...SOLANA_ACCEPT.extra, feePayer: undefined } };
    const terms = parseConnectorRouteTerms(greetingBody([EVM_ACCEPT, malformed]));
    expect(terms.batchSettlements.map((o) => o.chain)).toEqual(['evm']);
  });

  it('refuses a priced route that offers no channel to pay it on — it is not free', () => {
    expect(() => parseConnectorRouteTerms(greetingBody([]))).toThrow(ConnectorEdgeError);
    expect(() =>
      parseConnectorRouteTerms(greetingBody([{ scheme: 'toon-channel', amount: '1000' }]))
    ).toThrow(ConnectorEdgeError);
  });

  it('accepts a zero-priced route with no offers', () => {
    const terms = parseConnectorRouteTerms(greetingBody([], {}, '0'));
    expect(terms.price).toBe('0');
    expect(terms.batchSettlements).toEqual([]);
  });

  it('refuses a greeting with no TOON terms at all', () => {
    expect(() =>
      parseConnectorRouteTerms({ x402Version: 2, accepts: [EVM_ACCEPT] })
    ).toThrow(ConnectorEdgeError);
    expect(() => parseConnectorRouteTerms('nope')).toThrow(ConnectorEdgeError);
  });
});

describe('parseConnectorRouteTerms — the info bag (issue #509)', () => {
  it('surfaces sessionLeaseTtlMs from extensions.toon.info', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody([EVM_ACCEPT], { sessionLeaseTtlMs: 120_000 })
    );
    expect(terms.info.sessionLeaseTtlMs).toBe(120_000);
  });

  it('leaves sessionLeaseTtlMs absent when the node publishes none, not a default', () => {
    const terms = parseConnectorRouteTerms(greetingBody([EVM_ACCEPT]));
    expect(terms.info.sessionLeaseTtlMs).toBeUndefined();
  });

  it('preserves unknown keys in the info bag', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody([EVM_ACCEPT], { someFutureField: 'unknown-but-preserved' })
    );
    expect(terms.info['someFutureField']).toBe('unknown-but-preserved');
  });

  it('keeps the offers unchanged when the info also carries a session lease', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody([EVM_ACCEPT], { sessionLeaseTtlMs: 120_000 })
    );
    expect(terms.batchSettlements).toEqual([{ chain: 'evm', offer: EVM_ACCEPT }]);
  });
});

/** An ok entry exactly as the connector answers one (ADR 0075). */
function okEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blockchain: 'evm',
    channelId: '0x' + '11'.repeat(32),
    ok: true,
    scheme: 'batch-settlement',
    cumulativeClaimed: '250000',
    maxCumulative: '300000',
    available: '750000',
    lastClaimTime: 1735680000,
    ...overrides,
  };
}

describe('parseClaimStateResponse — POST /ilp/claim-state (§1.10)', () => {
  it('parses an ok EVM entry', () => {
    expect(parseClaimStateResponse({ channels: [okEntry()] })).toEqual([
      {
        blockchain: 'evm',
        channelId: '0x' + '11'.repeat(32),
        ok: true,
        scheme: 'batch-settlement',
        cumulativeClaimed: '250000',
        maxCumulative: '300000',
        available: '750000',
        lastClaimTime: 1735680000,
      },
    ]);
  });

  it('reads a Solana entry’s channelAccount as its channelId, and a missing lastClaimTime as null', () => {
    const results = parseClaimStateResponse({
      channels: [
        okEntry({
          blockchain: 'solana',
          channelId: undefined,
          channelAccount: 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm',
          lastClaimTime: undefined,
        }),
      ],
    });
    expect(results[0]).toMatchObject({
      blockchain: 'solana',
      channelId: 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm',
      ok: true,
      lastClaimTime: null,
    });
  });

  it('parses a failed entry, carrying only blockchain/id/ok/error', () => {
    const results = parseClaimStateResponse({
      channels: [
        {
          blockchain: 'evm',
          channelId: '0x' + '22'.repeat(32),
          ok: false,
          error: 'unverified',
        },
      ],
    });
    expect(results).toEqual([
      {
        blockchain: 'evm',
        channelId: '0x' + '22'.repeat(32),
        ok: false,
        error: 'unverified',
      },
    ]);
  });

  it('parses the toon-channel refusal a connector answers a retired declaration with', () => {
    const results = parseClaimStateResponse({
      channels: [{ blockchain: 'evm', channelId: '0xaa', ok: false, error: 'toon-channel-refused' }],
    });
    expect(results[0]).toMatchObject({ ok: false, error: 'toon-channel-refused' });
  });

  it('preserves request order across mixed ok/failed EVM/Solana entries', () => {
    const results = parseClaimStateResponse({
      channels: [
        { blockchain: 'evm', channelId: '0xaa', ok: false, error: 'expired' },
        okEntry({ blockchain: 'solana', channelId: undefined, channelAccount: 'acct' }),
      ],
    });
    expect(results.map((r) => r.blockchain)).toEqual(['evm', 'solana']);
    expect(results[0]!.ok).toBe(false);
    expect(results[1]!.ok).toBe(true);
  });

  it('throws on a body that is not { channels: [...] }', () => {
    expect(() => parseClaimStateResponse({ nope: true })).toThrow(ConnectorEdgeError);
    expect(() => parseClaimStateResponse([])).toThrow(ConnectorEdgeError);
    expect(() => parseClaimStateResponse(null)).toThrow(ConnectorEdgeError);
  });

  it('throws on an undocumented error code', () => {
    expect(() =>
      parseClaimStateResponse({
        channels: [{ blockchain: 'evm', ok: false, error: 'nope' }],
      })
    ).toThrow(ConnectorEdgeError);
  });

  it('throws when an ok entry names no channel', () => {
    expect(() =>
      parseClaimStateResponse({ channels: [okEntry({ channelId: undefined })] })
    ).toThrow(ConnectorEdgeError);
  });

  it('throws when an ok entry is missing cumulativeClaimed or maxCumulative', () => {
    expect(() =>
      parseClaimStateResponse({ channels: [okEntry({ cumulativeClaimed: undefined })] })
    ).toThrow(ConnectorEdgeError);
    expect(() =>
      parseClaimStateResponse({ channels: [okEntry({ maxCumulative: undefined })] })
    ).toThrow(ConnectorEdgeError);
  });

  it('throws when money fields are numbers instead of decimal strings', () => {
    expect(() =>
      parseClaimStateResponse({ channels: [okEntry({ available: 1000000 })] })
    ).toThrow(ConnectorEdgeError);
  });

  it('throws when lastClaimTime is neither an integer nor null', () => {
    expect(() =>
      parseClaimStateResponse({ channels: [okEntry({ lastClaimTime: 'yesterday' })] })
    ).toThrow(ConnectorEdgeError);
  });
});

describe('ConnectorEdgeClient.getClaimState', () => {
  it('POSTs { channels } to /ilp/claim-state and parses the response', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({
          channels: [
            okEntry({ cumulativeClaimed: '10', maxCumulative: '10', available: '90', lastClaimTime: null }),
          ],
        })
      );
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const results = await client.getClaimState('https://apex.example/ilp', [
      {
        blockchain: 'evm',
        channelId: '0x' + '11'.repeat(32),
        expires: 1735689600,
        signature: '0xdead',
      },
    ]);

    expect(requestedUrl(fetchImpl)).toBe('https://apex.example/ilp/claim-state');
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      channels: [
        {
          blockchain: 'evm',
          channelId: '0x' + '11'.repeat(32),
          expires: 1735689600,
          signature: '0xdead',
        },
      ],
    });
    expect(results[0]).toMatchObject({ ok: true, cumulativeClaimed: '10' });
  });

  it('returns [] without a request when channels is empty', async () => {
    const fetchImpl = vi.fn<[string, RequestInit?], Promise<Response>>();
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getClaimState('https://apex.example', [])).resolves.toEqual(
      []
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws NetworkError on a transport failure', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockRejectedValue(new Error('ECONNRESET'));
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getClaimState('https://apex.example', [
        { blockchain: 'evm', channelId: '0xaa', expires: 1, signature: '0x00' },
      ])
    ).rejects.toThrow(NetworkError);
  });

  it('throws ConnectorEdgeError on a non-2xx status', async () => {
    const fetchImpl = vi
      .fn<[string, RequestInit?], Promise<Response>>()
      .mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new ConnectorEdgeClient({
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.getClaimState('https://apex.example', [
        { blockchain: 'evm', channelId: '0xaa', expires: 1, signature: '0x00' },
      ])
    ).rejects.toMatchObject({ code: 'CLAIM_STATE_HTTP_STATUS' });
  });
});

// ─── GET /ilp — the node self-description (connector ADR 0050) ──────────────

/** A minimal but complete `GET /ilp` body, the shape the Rust node serves. */
function selfDescriptionBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ilpAddresses: ['g.toon.store'],
    httpEndpoint: 'https://apex.example/ilp',
    btpEndpoint: 'wss://apex.example/ilp/btp',
    peerCarriages: ['btp', 'http'],
    edgeIdentity: { keyId: 'k1', publicKey: VALID_KEY_HEX },
    batchSettlements: [
      {
        network: 'eip155:84532',
        asset: `0x${'44'.repeat(20)}`,
        payTo: `0x${'11'.repeat(20)}`,
        receiverAuthorizer: `0x${'11'.repeat(20)}`,
        withdrawDelay: 86_400,
        name: 'USDC',
        version: '2',
      },
    ],
    voucherSigners: [{ network: 'eip155:84532', signer: `0x${'11'.repeat(20)}` }],
    routes: [{ prefix: 'g.toon.store', price: '1000' }],
    supportedVersions: [1],
    defaultVersion: 1,
    ...overrides,
  };
}

describe('ConnectorEdgeClient.describe', () => {
  it('GETs /ilp and parses the document', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(selfDescriptionBody())
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const description = await client.describe('https://apex.example');

    expect(
      requestedUrl(fetchImpl as unknown as { mock: { calls: [string][] } })
    ).toBe('https://apex.example/ilp');
    expect(description.ilpAddresses).toEqual(['g.toon.store']);
    expect(description.edgeIdentity?.publicKey).toBe(VALID_KEY_HEX);
    expect(description.routes).toEqual([
      { prefix: 'g.toon.store', price: 1000n },
    ]);
    expect(description.batchSettlements[0]).toMatchObject({
      chain: 'evm',
      network: 'eip155:84532',
    });
    expect(description.voucherSigners).toEqual([
      { network: 'eip155:84532', signer: `0x${'11'.repeat(20)}` },
    ]);
  });

  it('records the base it was read from, so a relative endpoint can be resolved', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(selfDescriptionBody({ httpEndpoint: '/ilp' }))
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    // A caller may hand over the POST endpoint; both normalize to the base.
    const description = await client.describe('https://apex.example/ilp');
    expect(description.readFrom).toBe('https://apex.example');
  });

  it('caches per endpoint and shares one in-flight request', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(selfDescriptionBody())
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const [a, b] = await Promise.all([
      client.describe('https://apex.example'),
      client.describe('https://apex.example/ilp'),
    ]);

    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.hasCachedDescription('https://apex.example')).toBe(true);
    await client.describe('https://apex.example');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh re-reads a node an operator changed', async () => {
    let price = '1000';
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        selfDescriptionBody({ routes: [{ prefix: 'g.toon.store', price }] })
      )
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    await client.describe('https://apex.example');
    price = '2000';
    const fresh = await client.describe('https://apex.example', {
      forceRefresh: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fresh.routes[0]?.price).toBe(2000n);
  });

  it('invalidateDescription drops one endpoint, or all of them', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(selfDescriptionBody())
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    await client.describe('https://a.example');
    await client.describe('https://b.example');
    client.invalidateDescription('https://a.example');
    expect(client.hasCachedDescription('https://a.example')).toBe(false);
    expect(client.hasCachedDescription('https://b.example')).toBe(true);
    client.invalidateDescription();
    expect(client.hasCachedDescription('https://b.example')).toBe(false);
  });

  it('surfaces a 429 under its own code — the lookup budget is spent, not the node broken', async () => {
    // The connector runs `GET /ilp` through the shaper that already guards
    // chain lookups (ADR 0050), so this is purely temporal: back off and ask
    // again. Distinct from any other non-2xx for exactly that reason.
    const fetchImpl = vi.fn(
      async () => new Response('lookup budget exhausted', { status: 429 })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const error = (await client
      .describe('https://apex.example')
      .catch((e: unknown) => e)) as ConnectorEdgeError;

    expect(error).toBeInstanceOf(ConnectorEdgeError);
    expect(error.code).toBe('SELF_DESCRIPTION_BUDGETED');
    // Never cached: the same request succeeds once the shaper drains.
    expect(client.hasCachedDescription('https://apex.example')).toBe(false);
  });

  it('maps any other non-2xx to SELF_DESCRIPTION_HTTP_STATUS', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 503 })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const error = (await client
      .describe('https://apex.example')
      .catch((e: unknown) => e)) as ConnectorEdgeError;
    expect(error.code).toBe('SELF_DESCRIPTION_HTTP_STATUS');
  });

  it('maps a non-JSON 200 body to SELF_DESCRIPTION_MALFORMED', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>', { status: 200 })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const error = (await client
      .describe('https://apex.example')
      .catch((e: unknown) => e)) as ConnectorEdgeError;
    expect(error.code).toBe('SELF_DESCRIPTION_MALFORMED');
  });

  it('wraps a transport failure as NetworkError, not a parse refusal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    await expect(client.describe('https://apex.example')).rejects.toBeInstanceOf(
      NetworkError
    );
  });
});

// ─── POST /ilp/probe (client-edge-spec §1.6) ────────────────────────────────

describe('ConnectorEdgeClient.probe', () => {
  const ILP_REJECT = 14;

  /** An OER REJECT the client's own deserializer reads back. */
  function rejectBytes(code: string, message: string): Uint8Array {
    const enc = new TextEncoder();
    const msg = enc.encode(message);
    const trigger = enc.encode('g.connector');
    return new Uint8Array([
      ILP_REJECT,
      ...enc.encode(code),
      trigger.length,
      ...trigger,
      msg.length,
      ...msg,
      0,
    ]);
  }

  const PROBE_PARAMS = {
    destination: 'g.toon.store',
    amount: '0',
    data: '',
  };

  function probeClaim(): Record<string, unknown> {
    return {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'probe-1',
      timestamp: '2026-06-20T00:00:00.000Z',
      senderId: 'me',
      channelId: `0x${'12'.repeat(32)}`,
      nonce: 9,
      transferredAmount: '1000',
      signature: `0x${'ab'.repeat(65)}`,
      signerAddress: `0x${'11'.repeat(20)}`,
    };
  }

  it('POSTs an OER PREPARE with the claim header, and reads the cost off the answer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(rejectBytes('F03', 'route terminates here').slice().buffer, {
          status: 200,
          headers: { 'toon-accumulated-cost': '1000' },
        })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const result = await client.probe(
      'https://apex.example/ilp',
      PROBE_PARAMS,
      probeClaim()
    );

    const [url, init] = (fetchImpl as unknown as {
      mock: { calls: [string, RequestInit][] };
    }).mock.calls[0]!;
    expect(url).toBe('https://apex.example/ilp/probe');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // The HTTP spelling of the claim: base64(JSON) (§1.3).
    expect(
      JSON.parse(
        Buffer.from(
          headers['ILP-Payment-Channel-Claim']!,
          'base64'
        ).toString('utf8')
      )
    ).toEqual(probeClaim());
    // Body framing is `POST /ilp`'s exactly.
    const prepare = deserializeIlpPrepare(
      new Uint8Array(init.body as ArrayBuffer)
    );
    expect(prepare.destination).toBe('g.toon.store');

    // A destination this connector terminates is answered F03 with the
    // route's price — never delivered (§1.6).
    expect(result.accepted).toBe(false);
    expect(result.code).toBe('F03');
    expect(result.accumulatedCost).toBe(1000n);
  });

  it('gives a 403 its own code, distinct from a 401', async () => {
    // §1.6: the sender may be perfectly well authenticated and simply not
    // AUTHORIZED to probe — no channel this connector recognizes, or over the
    // rate limit. A 401 is a failure to authenticate; the remedies differ.
    const fetchImpl = vi.fn(
      async () =>
        new Response("no payment channel this connector recognizes: 'evm:0x…'", {
          status: 403,
        })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const error = (await client
      .probe('https://apex.example', PROBE_PARAMS, probeClaim())
      .catch((e: unknown) => e)) as ConnectorEdgeError;

    expect(error).toBeInstanceOf(ConnectorEdgeError);
    expect(error.code).toBe('PROBE_FORBIDDEN');
    expect(error.message).toMatch(/recognizes/);
  });

  it('maps any other non-2xx to PROBE_HTTP_STATUS', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad packet', { status: 400 })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const error = (await client
      .probe('https://apex.example', PROBE_PARAMS, probeClaim())
      .catch((e: unknown) => e)) as ConnectorEdgeError;
    expect(error.code).toBe('PROBE_HTTP_STATUS');
  });

  it('refuses an empty 200 body rather than reporting a phantom outcome', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new ArrayBuffer(0), { status: 200 })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    await expect(
      client.probe('https://apex.example', PROBE_PARAMS, probeClaim())
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('wraps a transport failure as NetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    await expect(
      client.probe('https://apex.example', PROBE_PARAMS, probeClaim())
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('ConnectorEdgeClient.terms', () => {
  it('POSTs a claimless PREPARE and parses the 402 greeting', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            greetingBody([EVM_ACCEPT], {
              ilpAddress: 'g.toon.store',
              sessionLeaseTtlMs: 120000,
            })
          ),
          { status: 402, headers: { 'content-type': 'application/json' } }
        )
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    const terms = await client.terms('https://apex.example', 'g.toon.store');

    expect(
      requestedUrl(fetchImpl as unknown as { mock: { calls: [string][] } })
    ).toBe('https://apex.example/ilp');
    expect(terms).toMatchObject({ destination: 'g.toon.store', price: '1000' });
    expect(terms?.info.sessionLeaseTtlMs).toBe(120000);
    expect(terms?.batchSettlements).toEqual([{ chain: 'evm', offer: EVM_ACCEPT }]);
  });

  it('answers null when the connector does not greet the destination', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new ArrayBuffer(0), { status: 200 })
    ) as unknown as typeof fetch;
    const client = new ConnectorEdgeClient({ fetch: fetchImpl });

    await expect(
      client.terms('https://apex.example', 'g.toon.store')
    ).resolves.toBeNull();
  });

  it('refuses an empty destination', async () => {
    const client = new ConnectorEdgeClient({
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(client.terms('https://apex.example', '  ')).rejects.toThrow(
      /non-empty ILP destination/
    );
  });
});
