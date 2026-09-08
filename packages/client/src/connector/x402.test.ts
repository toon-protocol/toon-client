/**
 * The x402 greeting parser — carved out of the retired `Http402Client` suite
 * along with the parser itself. These cases pin how a `402` body from the Rust
 * connector (`client-edge-spec.md` §1.4) is read: the connector puts the ILP
 * address, the endpoint and the price under `extra`, emits a RELATIVE
 * `httpEndpoint`, and may carry fields this client does not yet know by name.
 */
import { describe, it, expect } from 'vitest';
import { parseX402Body, parsePaymentTerms } from './x402.js';

describe('x402 challenge parsing', () => {
  it('parseX402Body reads field aliases defensively', () => {
    const parsed = parseX402Body({
      accepts: [
        {
          scheme: 'toon-channel',
          payTo: 'g.toon.alt',
          price: 42,
          ilpEndpoint: 'https://alt/ilp',
          upgradable: true,
        },
      ],
    });
    expect(parsed.toonChannel).toEqual({
      scheme: 'toon-channel',
      destination: 'g.toon.alt',
      amount: 42n,
      httpEndpoint: 'https://alt/ilp',
      supportsUpgrade: true,
    });
  });

  it('parseX402Body ignores a toon-channel entry missing destination/endpoint', () => {
    const parsed = parseX402Body({
      accepts: [{ scheme: 'toon-channel', amount: '5' }],
    });
    expect(parsed.toonChannel).toBeUndefined();
  });

  it('preserves the extra bag, including session_lease_ttl_ms and unknown keys (issue #506)', () => {
    const parsed = parseX402Body({
      accepts: [
        {
          scheme: 'toon-channel',
          payTo: 'g.toon.alt',
          amount: '42',
          httpEndpoint: 'https://alt/ilp',
          extra: {
            ilpAddress: 'g.toon.alt',
            session_lease_ttl_ms: 120_000,
            some_future_field: 'unknown-but-preserved',
          },
        },
      ],
    });
    expect(parsed.toonChannel?.extra).toEqual({
      ilpAddress: 'g.toon.alt',
      session_lease_ttl_ms: 120_000,
      some_future_field: 'unknown-but-preserved',
    });
  });

  it('yields extra: undefined — not a default, not a throw — when the entry has no extra bag', () => {
    const parsed = parseX402Body({
      accepts: [
        {
          scheme: 'toon-channel',
          payTo: 'g.toon.alt',
          amount: '42',
          httpEndpoint: 'https://alt/ilp',
        },
      ],
    });
    expect(parsed.toonChannel?.extra).toBeUndefined();
  });
});

describe('requiredTransport on a greeting (issue #701)', () => {
  function greeting(entry: Record<string, unknown>): unknown {
    return {
      x402Version: 2,
      resource: { url: 'g.toon.relay' },
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1',
          httpEndpoint: '/ilp',
          extra: { ilpAddress: 'g.toon.relay', endpoint: '/ilp', price: '1' },
          ...entry,
        },
      ],
    };
  }

  it('is absent on an ordinary unpaid-request greeting — never defaulted to http', () => {
    const parsed = parseX402Body(greeting({}), 'https://relay.example/ilp');
    expect(parsed.toonChannel?.requiredTransport).toBeUndefined();
  });

  it('is read from extra, where the connector actually writes it', () => {
    const parsed = parseX402Body(
      greeting({
        extra: {
          ilpAddress: 'g.toon.relay',
          endpoint: '/ilp',
          price: '1',
          requiredTransport: 'btp',
        },
      }),
      'https://relay.example/ilp'
    );
    expect(parsed.toonChannel?.requiredTransport).toBe('btp');
  });

  it('is read from the entry top level as a fallback', () => {
    const parsed = parseX402Body(
      greeting({ requiredTransport: 'http' }),
      'https://relay.example/ilp'
    );
    expect(parsed.toonChannel?.requiredTransport).toBe('http');
  });

  it('drops a transport this client cannot name rather than carrying it', () => {
    const parsed = parseX402Body(
      greeting({ requiredTransport: 'carrier-pigeon' }),
      'https://relay.example/ilp'
    );
    expect(parsed.toonChannel?.requiredTransport).toBeUndefined();
  });
});

describe('parsePaymentTerms — the greeting projected onto PaymentTerms', () => {
  const EVM_SETTLEMENT = {
    chain: 'evm:84532',
    settlementAddress: `0x${'11'.repeat(20)}`,
    tokenNetworkRegistry: `0x${'22'.repeat(20)}`,
    tokenNetwork: `0x${'33'.repeat(20)}`,
    tokenAddress: `0x${'44'.repeat(20)}`,
    decimals: 6,
  };
  const SOLANA_SETTLEMENT = {
    chain: 'solana',
    settlementAddress: 'So11111111111111111111111111111111111111112',
    programId: '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip',
    tokenAddress: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
    decimals: 6,
  };

  const BODY = {
    x402Version: 2,
    resource: { url: 'g.toon.relay' },
    accepts: [
      {
        scheme: 'toon-channel',
        network: 'g.toon.relay',
        amount: '1',
        payTo: 'g.toon.relay',
        httpEndpoint: '/ilp',
        extra: {
          ilpAddress: 'g.toon.relay',
          endpoint: '/ilp',
          price: '1',
          btpEndpoint: 'wss://relay.example/ilp/btp',
          sessionLeaseTtlMs: 120000,
          requiredTransport: 'btp',
          settlements: [EVM_SETTLEMENT, SOLANA_SETTLEMENT],
        },
      },
    ],
  };

  it('carries the price, both endpoints, the required carriage and every chain', () => {
    const terms = parsePaymentTerms(BODY, 'https://relay.example/ilp');
    expect(terms).toBeDefined();
    expect(terms!.destination).toBe('g.toon.relay');
    expect(terms!.price).toBe(1n);
    expect(terms!.httpEndpoint).toBe('https://relay.example/ilp');
    expect(terms!.btpEndpoint).toBe('wss://relay.example/ilp/btp');
    expect(terms!.requiredTransport).toBe('btp');
    expect(terms!.sessionLeaseTtlMs).toBe(120000);
    expect(terms!.settlements.map((s) => s.kind)).toEqual(['evm', 'solana']);
    expect(terms!.raw).toBe(BODY);
  });

  it('accepts the snake_case session-lease alias a fixture may still carry', () => {
    const terms = parsePaymentTerms({
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1',
          httpEndpoint: '/ilp',
          extra: {
            ilpAddress: 'g.x',
            price: '1',
            session_lease_ttl_ms: 60000,
          },
        },
      ],
    });
    expect(terms?.sessionLeaseTtlMs).toBe(60000);
  });

  it('reports an empty settlements list on a settlement-less node, never a fabricated one', () => {
    const terms = parsePaymentTerms({
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1',
          httpEndpoint: '/ilp',
          extra: { ilpAddress: 'g.x', price: '1' },
        },
      ],
    });
    expect(terms?.settlements).toEqual([]);
  });

  it('is undefined for a body offering no toon-channel option at all', () => {
    expect(parsePaymentTerms({ x402Version: 2, accepts: [] })).toBeUndefined();
    expect(parsePaymentTerms('not an object')).toBeUndefined();
  });
});
