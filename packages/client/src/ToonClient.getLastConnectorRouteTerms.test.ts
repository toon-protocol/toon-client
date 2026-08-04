/**
 * ToonClient.getLastConnectorRouteTerms (issue #509): the client-level
 * surface for the x402 `accepts[0].extra` bag on the LIVE bootstrap path —
 * `ConnectorEdgeClient.getRouteTerms` / `negotiateFromGreeting`, which
 * `publishEvent`/`openChannel`/`adoptChannel` already call. Unlike
 * `getLastX402Terms` (issue #506/#507), this populates from a client that
 * only ever calls `start()`/`openChannel()` — no separate `h402Fetch` probe
 * is needed to read `session_lease_ttl_ms`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { FakeTerminatingConnector } from './wire/fake-connector.test-support.js';

const SECRET_KEY = new Uint8Array(32).fill(7);

function baseConfig() {
  return {
    secretKey: SECRET_KEY,
    connectorUrl: 'http://connector.test',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

const GREETING_SETTLEMENT = {
  chain: 'evm:84532',
  settlementAddress: '0x' + 'a'.repeat(40),
  tokenNetworkRegistry: '0x' + 'b'.repeat(40),
  tokenNetwork: '0x' + 'e'.repeat(40),
  tokenAddress: '0x' + 'f'.repeat(40),
  decimals: 6,
};

/** A started client with a stubbed ChannelManager so `openChannel` can run
 * end to end without real signer/chain infrastructure. */
function startedClientWithChannelManager(): ToonClient {
  const client = new ToonClient(baseConfig());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: {},
    runtimeClient: {},
    peersDiscovered: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).channelManager = {
    ensureChannel: async () => 'chan-1',
    signBalanceProof: async () => ({}),
    isTracking: () => false,
    getSignerForChannel: () => ({
      buildClaimMessage: (proof: unknown, sender: unknown) => ({
        proof,
        sender,
      }),
    }),
  };
  return client;
}

let connector: FakeTerminatingConnector;
let realFetch: typeof fetch;

beforeEach(() => {
  connector = new FakeTerminatingConnector();
  realFetch = globalThis.fetch;
  globalThis.fetch = connector.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('ToonClient.getLastConnectorRouteTerms', () => {
  it('is undefined before any greeting has been parsed', () => {
    const client = new ToonClient(baseConfig());
    expect(client.getLastConnectorRouteTerms()).toBeUndefined();
  });

  it('surfaces session_lease_ttl_ms after ordinary bootstrap, with no h402Fetch call', async () => {
    const client = startedClientWithChannelManager();
    connector.settlementTerms = GREETING_SETTLEMENT;
    connector.extraFields = {
      session_lease_ttl_ms: 120_000,
      some_future_field: 'unknown-but-preserved',
    };

    await client.openChannel('g.proxy');

    const terms = client.getLastConnectorRouteTerms();
    expect(terms?.extra?.session_lease_ttl_ms).toBe(120_000);
    expect(terms?.extra?.['some_future_field']).toBe('unknown-but-preserved');
  });

  it('yields extra: undefined for a greeting with no extra fields beyond the known ones, not a default', async () => {
    const client = startedClientWithChannelManager();
    connector.settlementTerms = GREETING_SETTLEMENT;
    connector.extraFields = null;

    await client.openChannel('g.proxy');

    // The fixture's own `ilpAddress`/`endpoint`/`price` plus `settlement` are
    // present on the wire, but no session_lease_ttl_ms — extra itself is
    // still defined (the entry DID carry an extra bag), just without that key.
    expect(
      client.getLastConnectorRouteTerms()?.extra?.session_lease_ttl_ms
    ).toBeUndefined();
  });

  it('still captures the extra bag when the greeting carries no settlement facts to negotiate from', async () => {
    const client = startedClientWithChannelManager();
    connector.settlementTerms = null;
    connector.extraFields = { session_lease_ttl_ms: 45_000 };

    await expect(client.openChannel('g.proxy')).rejects.toThrow(
      /No negotiation metadata/
    );

    expect(
      client.getLastConnectorRouteTerms()?.extra?.session_lease_ttl_ms
    ).toBe(45_000);
  });
});
