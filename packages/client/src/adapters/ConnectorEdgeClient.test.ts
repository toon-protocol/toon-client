import { describe, it, expect, vi } from 'vitest';
import {
  ConnectorEdgeClient,
  ConnectorEdgeError,
  connectorEdgeBaseUrl,
  decodeConnectorPublicKey,
  parseConnectorIdentity,
  parseConnectorRoutePrice,
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
