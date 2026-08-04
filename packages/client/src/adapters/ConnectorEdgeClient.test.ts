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
import { NetworkError } from '../errors.js';

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
describe('parseConnectorRouteTerms — per-chain settlements (connector #632)', () => {
  const EVM_SETTLEMENT = {
    chain: 'evm:84532',
    settlementAddress: '0x' + 'a'.repeat(40),
    tokenNetworkRegistry: '0x' + 'b'.repeat(40),
    tokenNetwork: '0x' + 'e'.repeat(40),
    tokenAddress: '0x' + 'f'.repeat(40),
    decimals: 6,
  };
  const SOLANA_SETTLEMENT = {
    chain: 'solana',
    settlementAddress: 'ApexSolanaSettlementAddress11111111111111',
    programId: 'PaymentChannelProgram1111111111111111111',
    tokenAddress: 'UsdcMint1111111111111111111111111111111',
    decimals: 6,
  };

  function greetingBody(extra: Record<string, unknown>) {
    return {
      x402Version: 2,
      resource: { url: 'g.fake.route' },
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1000',
          extra: {
            ilpAddress: 'g.fake.route',
            endpoint: '/ilp',
            price: '1000',
            ...extra,
          },
        },
      ],
    };
  }

  it('leaves settlements undefined on a settlement-less greeting (pre-#632 shape unaffected)', () => {
    const terms = parseConnectorRouteTerms(greetingBody({}));
    expect(terms.settlement).toBeUndefined();
    expect(terms.settlements).toBeUndefined();
  });

  it('parses an EVM-only one-entry settlements list beside the unchanged legacy object', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody({
        settlement: EVM_SETTLEMENT,
        settlements: [EVM_SETTLEMENT],
      })
    );
    expect(terms.settlement).toEqual(EVM_SETTLEMENT);
    expect(terms.settlements).toEqual([{ kind: 'evm', ...EVM_SETTLEMENT }]);
  });

  it('parses a two-chain settlements list, disambiguating EVM and Solana structurally', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody({
        settlement: EVM_SETTLEMENT,
        settlements: [EVM_SETTLEMENT, SOLANA_SETTLEMENT],
      })
    );
    expect(terms.settlements).toEqual([
      { kind: 'evm', ...EVM_SETTLEMENT },
      { kind: 'solana', ...SOLANA_SETTLEMENT },
    ]);
  });

  it('refuses a settlements entry missing required fields rather than dropping it silently', () => {
    const malformed = { ...SOLANA_SETTLEMENT, programId: undefined };
    expect(() =>
      parseConnectorRouteTerms(greetingBody({ settlements: [malformed] }))
    ).toThrow(ConnectorEdgeError);
  });

  it('refuses a settlements list that is not an array', () => {
    expect(() =>
      parseConnectorRouteTerms(greetingBody({ settlements: 'nope' }))
    ).toThrow(ConnectorEdgeError);
  });
});

describe('parseConnectorRouteTerms — extra bag (issue #509)', () => {
  function greetingBody(extra?: Record<string, unknown>) {
    return {
      x402Version: 2,
      resource: { url: 'g.fake.route' },
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1000',
          ...(extra !== undefined ? { extra } : {}),
        },
      ],
    };
  }

  it('surfaces session_lease_ttl_ms from accepts[0].extra after ordinary bootstrap parsing', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody({ session_lease_ttl_ms: 120_000 })
    );
    expect(terms.extra?.session_lease_ttl_ms).toBe(120_000);
  });

  it('yields extra: undefined for a greeting with no extra bag at all, not a default', () => {
    const terms = parseConnectorRouteTerms(greetingBody());
    expect(terms.extra).toBeUndefined();
  });

  it('preserves unknown keys in the extra bag', () => {
    const terms = parseConnectorRouteTerms(
      greetingBody({ some_future_field: 'unknown-but-preserved' })
    );
    expect(terms.extra?.['some_future_field']).toBe('unknown-but-preserved');
  });

  it('keeps existing settlement/settlements extraction unchanged when extra also carries session_lease_ttl_ms', () => {
    const EVM_SETTLEMENT = {
      chain: 'evm:84532',
      settlementAddress: '0x' + 'a'.repeat(40),
      tokenNetworkRegistry: '0x' + 'b'.repeat(40),
      tokenNetwork: '0x' + 'e'.repeat(40),
      tokenAddress: '0x' + 'f'.repeat(40),
      decimals: 6,
    };
    const terms = parseConnectorRouteTerms(
      greetingBody({
        settlement: EVM_SETTLEMENT,
        session_lease_ttl_ms: 120_000,
      })
    );
    expect(terms.settlement).toEqual(EVM_SETTLEMENT);
    expect(terms.extra?.session_lease_ttl_ms).toBe(120_000);
  });
});

describe('parseClaimStateResponse — POST /ilp/claim-state (§1.10)', () => {
  it('parses an ok EVM entry', () => {
    const results = parseClaimStateResponse({
      channels: [
        {
          blockchain: 'evm',
          channelId: '0x' + '11'.repeat(32),
          ok: true,
          depositTotal: '1000000',
          cumulativeClaimed: '250000',
          available: '750000',
          nonce: 3,
          lastClaimTime: 1735680000,
        },
      ],
    });
    expect(results).toEqual([
      {
        blockchain: 'evm',
        channelId: '0x' + '11'.repeat(32),
        ok: true,
        depositTotal: '1000000',
        cumulativeClaimed: '250000',
        available: '750000',
        nonce: 3,
        lastClaimTime: 1735680000,
      },
    ]);
  });

  it('parses a declared (unresolved) channel with null depositTotal/available', () => {
    const results = parseClaimStateResponse({
      channels: [
        {
          blockchain: 'solana',
          channelAccount: 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm',
          ok: true,
          depositTotal: null,
          cumulativeClaimed: '0',
          available: null,
          nonce: 0,
          lastClaimTime: null,
        },
      ],
    });
    expect(results[0]).toMatchObject({
      ok: true,
      depositTotal: null,
      available: null,
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

  it('preserves request order across mixed ok/failed EVM/Solana entries', () => {
    const results = parseClaimStateResponse({
      channels: [
        { blockchain: 'evm', channelId: '0xaa', ok: false, error: 'expired' },
        {
          blockchain: 'solana',
          channelAccount: 'acct',
          ok: true,
          depositTotal: '1',
          cumulativeClaimed: '0',
          available: '1',
          nonce: 0,
          lastClaimTime: null,
        },
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

  it('throws when an ok entry is missing cumulativeClaimed', () => {
    expect(() =>
      parseClaimStateResponse({
        channels: [
          {
            blockchain: 'evm',
            ok: true,
            depositTotal: '1',
            available: '1',
            nonce: 0,
            lastClaimTime: null,
          },
        ],
      })
    ).toThrow(ConnectorEdgeError);
  });

  it('throws when money fields are numbers instead of decimal strings', () => {
    expect(() =>
      parseClaimStateResponse({
        channels: [
          {
            blockchain: 'evm',
            ok: true,
            depositTotal: 1000000,
            cumulativeClaimed: '0',
            available: '1000000',
            nonce: 0,
            lastClaimTime: null,
          },
        ],
      })
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
            {
              blockchain: 'evm',
              channelId: '0x' + '11'.repeat(32),
              ok: true,
              depositTotal: '100',
              cumulativeClaimed: '10',
              available: '90',
              nonce: 1,
              lastClaimTime: null,
            },
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
