/**
 * The x402 greeting parser. These cases pin how a `402` body from the Rust
 * connector (`client-edge-spec.md` §1.4, connector ADR 0075) is read: `accepts[]`
 * holds only x402-valid `batch-settlement` entries, TOON's own facts — the ILP
 * address, the endpoint, the price — ride in `extensions.toon.info`, the
 * endpoint is RELATIVE, and the info may carry fields this client does not yet
 * know by name.
 */
import { describe, it, expect } from 'vitest';
import { parseX402Body, parsePaymentTerms } from './x402.js';
import { must } from '../utils/must.test-support.js';

// The two entries exactly as the connector writes them
// (`connector_domain::x402::batch_settlement_accept`).
const EVM_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '1',
  asset: '0x49beE1Bc3e4Ea2aF5f6E7a1B5A7A4c7F16a9a9Ce',
  payTo: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  maxTimeoutSeconds: 60,
  extra: {
    receiverAuthorizer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    withdrawDelay: 86_400,
    name: 'USDC',
    version: '2',
  },
};

const SOLANA_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  amount: '1',
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

/** A greeting with `info` as `extensions.toon.info`. */
function greeting(info: Record<string, unknown>, accepts: unknown[] = [EVM_ACCEPT]): unknown {
  return {
    x402Version: 2,
    resource: { url: 'g.toon.relay' },
    accepts,
    extensions: { toon: { info, schema: {} } },
  };
}

const INFO = { ilpAddress: 'g.toon.relay', amount: '1', endpoint: '/ilp', price: '1' };

describe('x402 challenge parsing', () => {
  it('reads TOON terms out of extensions.toon.info, resolving a relative endpoint', () => {
    const parsed = parseX402Body(greeting(INFO), 'https://relay.example/ilp');
    expect(parsed.x402Version).toBe(2);
    expect(parsed.toon).toEqual({
      destination: 'g.toon.relay',
      amount: 1n,
      httpEndpoint: 'https://relay.example/ilp',
      info: INFO,
    });
  });

  it('falls back to price when the info carries no amount', () => {
    const parsed = parseX402Body(
      greeting({ ilpAddress: 'g.toon.alt', price: '42', endpoint: 'https://alt/ilp' })
    );
    expect(parsed.toon?.amount).toBe(42n);
    expect(parsed.toon?.httpEndpoint).toBe('https://alt/ilp');
  });

  it('yields no TOON terms when the info is missing a destination or an endpoint', () => {
    expect(parseX402Body(greeting({ amount: '5', endpoint: '/ilp' })).toon).toBeUndefined();
    expect(parseX402Body(greeting({ ilpAddress: 'g.x', amount: '5' })).toon).toBeUndefined();
    expect(parseX402Body({ x402Version: 2, accepts: [EVM_ACCEPT] }).toon).toBeUndefined();
  });

  it('reads every well-formed batch-settlement entry, one per chain, and nothing else', () => {
    const parsed = parseX402Body(
      greeting(INFO, [
        EVM_ACCEPT,
        { scheme: 'toon-channel', amount: '1', payTo: 'g.toon.relay' },
        { ...SOLANA_ACCEPT, extra: { ...SOLANA_ACCEPT.extra, feePayer: undefined } },
        SOLANA_ACCEPT,
      ])
    );
    expect(parsed.batchSettlements).toEqual([
      { chain: 'evm', offer: EVM_ACCEPT },
      { chain: 'solana', offer: SOLANA_ACCEPT },
    ]);
  });

  it('preserves the info verbatim, including unknown keys (issue #506)', () => {
    const info = { ...INFO, sessionLeaseTtlMs: 120_000, someFutureField: 'unknown-but-preserved' };
    expect(parseX402Body(greeting(info)).toon?.info).toEqual(info);
  });

  it('yields an empty parse, never a throw, on a body that is not an object', () => {
    expect(parseX402Body('not json')).toEqual({ batchSettlements: [] });
    expect(parseX402Body(null)).toEqual({ batchSettlements: [] });
  });
});

describe('requiredTransport on a greeting (issue #701)', () => {
  it('is absent on an ordinary unpaid-request greeting — never defaulted to http', () => {
    const parsed = parseX402Body(greeting(INFO), 'https://relay.example/ilp');
    expect(parsed.toon?.requiredTransport).toBeUndefined();
  });

  it('is read from extensions.toon.info, where the connector writes it', () => {
    const parsed = parseX402Body(
      greeting({ ...INFO, requiredTransport: 'btp' }),
      'https://relay.example/ilp'
    );
    expect(parsed.toon?.requiredTransport).toBe('btp');
  });

  it('drops a transport this client cannot name rather than carrying it', () => {
    const parsed = parseX402Body(
      greeting({ ...INFO, requiredTransport: 'carrier-pigeon' }),
      'https://relay.example/ilp'
    );
    expect(parsed.toon?.requiredTransport).toBeUndefined();
  });
});

describe('parsePaymentTerms — the greeting projected onto PaymentTerms', () => {
  const BODY = greeting(
    {
      ...INFO,
      btpEndpoint: 'wss://relay.example/ilp/btp',
      sessionLeaseTtlMs: 120000,
      requiredTransport: 'btp',
    },
    [EVM_ACCEPT, SOLANA_ACCEPT]
  );

  it('carries the price, both endpoints, the required carriage and every chain', () => {
    const terms = parsePaymentTerms(BODY, 'https://relay.example/ilp');
    expect(terms).toBeDefined();
    expect(must(terms).destination).toBe('g.toon.relay');
    expect(must(terms).price).toBe(1n);
    expect(must(terms).httpEndpoint).toBe('https://relay.example/ilp');
    expect(must(terms).btpEndpoint).toBe('wss://relay.example/ilp/btp');
    expect(must(terms).requiredTransport).toBe('btp');
    expect(must(terms).sessionLeaseTtlMs).toBe(120000);
    expect(must(terms).batchSettlements.map((s) => s.chain)).toEqual(['evm', 'solana']);
    expect(must(terms).raw).toBe(BODY);
  });

  it('leaves the session lease out when the info does not publish one', () => {
    expect(parsePaymentTerms(greeting(INFO))?.sessionLeaseTtlMs).toBeUndefined();
  });

  it('reports an empty batchSettlements list on a node that settles on nothing, never a fabricated one', () => {
    const terms = parsePaymentTerms(greeting(INFO, []));
    expect(terms?.batchSettlements).toEqual([]);
  });

  it('is undefined for a body carrying no TOON terms at all', () => {
    expect(parsePaymentTerms({ x402Version: 2, accepts: [EVM_ACCEPT] })).toBeUndefined();
    expect(parsePaymentTerms('not an object')).toBeUndefined();
  });
});
