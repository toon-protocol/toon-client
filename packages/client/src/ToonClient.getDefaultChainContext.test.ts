/**
 * Regression tests for #485: `ToonClient.getDefaultChainContext()` used to
 * always pick `supportedChains[0]`, ignoring the daemon's configured
 * settlement chain (`TOON_CLIENT_CHAIN` / `ToonClientConfig.preferredChain`).
 * With a multi-chain devnet announce this pinned a daemon configured for evm
 * to Solana (buzz#47) because Solana happened to sort first.
 *
 * Fix semantics:
 *   - `preferredChain` set + present in `supportedChains` → honor it,
 *     regardless of array order.
 *   - `preferredChain` set but NOT present in `supportedChains` → throw a
 *     `CHAIN_NOT_SUPPORTED` error naming both, rather than silently
 *     substituting a different chain.
 *   - `preferredChain` unset → unchanged legacy behavior, `supportedChains[0]`.
 */

import { describe, it, expect } from 'vitest';
import { resolveClientNetwork } from '@toon-protocol/core';
import { ToonClient } from './ToonClient.js';
import { ToonClientError } from './errors.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ToonClientConfig } from './types.js';

const noop: any = () => new Uint8Array();

function baseConfig(overrides: Partial<ToonClientConfig>): ToonClientConfig {
  return {
    connectorUrl: 'http://localhost:8080',
    secretKey: new Uint8Array(32).fill(9),
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.test',
      btpEndpoint: 'ws://localhost:3000',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: noop,
    toonDecoder: () => ({}) as NostrEvent,
    // Solana sorts FIRST — reproduces the buzz#47 ordering that pinned an
    // evm-configured daemon to Solana.
    supportedChains: ['solana:devnet:0', 'evm:base:84532'],
    tokenNetworks: {
      'solana:devnet:0': 'SolProgram11111111111111111111111111111111',
      'evm:base:84532': '0xTOKENNETWORK',
    },
    ...overrides,
  } as ToonClientConfig;
}

function getDefaultChainContext(client: ToonClient) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).getDefaultChainContext();
}

describe('ToonClient.getDefaultChainContext (#485)', () => {
  it('honors an explicitly configured chain that IS supported, even when it does not sort first', () => {
    const client = new ToonClient(baseConfig({ preferredChain: 'evm' }));
    const ctx = getDefaultChainContext(client);
    expect(ctx).toMatchObject({
      chainId: 84532,
      tokenNetworkAddress: '0xTOKENNETWORK',
    });
  });

  it('throws a clear error naming both chains when the configured chain is NOT supported', () => {
    const client = new ToonClient(
      baseConfig({ preferredChain: 'mina', supportedChains: ['evm:base:84532'] })
    );
    expect(() => getDefaultChainContext(client)).toThrow(ToonClientError);
    try {
      getDefaultChainContext(client);
      expect.unreachable('expected getDefaultChainContext to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToonClientError);
      expect((err as ToonClientError).code).toBe('CHAIN_NOT_SUPPORTED');
      expect((err as Error).message).toContain('mina');
      expect((err as Error).message).toContain('evm:base:84532');
    }
  });

  it('falls back to supportedChains[0] when no chain is explicitly configured (legacy behavior)', () => {
    const client = new ToonClient(baseConfig({}));
    const ctx = getDefaultChainContext(client);
    // supportedChains[0] is solana:devnet:0 — chainId parses to 0 for solana.
    expect(ctx).toMatchObject({
      chainId: 0,
      tokenNetworkAddress: 'SolProgram11111111111111111111111111111111',
    });
  });
});

/**
 * Sibling call site (#485): the lightweight bootstrap-fallback negotiation
 * (peer discovered but no connector admin registered a chain) has the same
 * "pick the first mutually-supported chain, ignoring configuration" pattern.
 */
describe('ToonClient.matchNegotiatedChain (#485 sibling)', () => {
  function matchNegotiatedChain(
    client: ToonClient,
    ourChains: string[],
    peerChains: string[],
    peerId = 'peer1'
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).matchNegotiatedChain(ourChains, peerChains, peerId);
  }

  it('honors the configured chain over array order when both sides support it', () => {
    const client = new ToonClient(baseConfig({ preferredChain: 'evm' }));
    const matched = matchNegotiatedChain(
      client,
      ['solana:devnet:0', 'evm:base:84532'],
      ['solana:devnet:0', 'evm:base:84532']
    );
    expect(matched).toBe('evm:base:84532');
  });

  it('throws naming the configured chain and the peer supportedChains when unsupported by the peer', () => {
    const client = new ToonClient(baseConfig({ preferredChain: 'evm' }));
    expect(() =>
      matchNegotiatedChain(
        client,
        ['solana:devnet:0', 'evm:base:84532'],
        ['solana:devnet:0'],
        'peerXYZ'
      )
    ).toThrow(ToonClientError);
    try {
      matchNegotiatedChain(
        client,
        ['solana:devnet:0', 'evm:base:84532'],
        ['solana:devnet:0'],
        'peerXYZ'
      );
      expect.unreachable('expected matchNegotiatedChain to throw');
    } catch (err) {
      expect((err as ToonClientError).code).toBe('CHAIN_NOT_SUPPORTED');
      expect((err as Error).message).toContain('evm');
      expect((err as Error).message).toContain('peerXYZ');
      expect((err as Error).message).toContain('solana:devnet:0');
    }
  });

  it('falls back to the first mutually-supported chain when unconfigured (legacy behavior)', () => {
    const client = new ToonClient(baseConfig({}));
    const matched = matchNegotiatedChain(
      client,
      ['solana:devnet:0', 'evm:base:84532'],
      ['evm:base:84532']
    );
    expect(matched).toBe('evm:base:84532');
  });

  it('throws naming both chain sets when nothing overlaps at all, instead of silently substituting a different chain (#500)', () => {
    const client = new ToonClient(baseConfig({}));
    expect(() =>
      matchNegotiatedChain(
        client,
        ['evm:base:84532'],
        ['evm:999999'],
        'peerNoOverlap'
      )
    ).toThrow(ToonClientError);
    try {
      matchNegotiatedChain(
        client,
        ['evm:base:84532'],
        ['evm:999999'],
        'peerNoOverlap'
      );
      expect.unreachable('expected matchNegotiatedChain to throw');
    } catch (err) {
      expect((err as ToonClientError).code).toBe('CHAIN_NOT_SUPPORTED');
      expect((err as Error).message).toContain('evm:base:84532');
      expect((err as Error).message).toContain('evm:999999');
      expect((err as Error).message).toContain('peerNoOverlap');
    }
  });
});

/**
 * Regression tests for #500: `network: 'devnet'`'s preset names its EVM chain
 * in the family-qualified form (`evm:base:84532`, from
 * `@toon-protocol/core`'s `resolveClientNetwork`), but the live devnet apex's
 * `kind:10032` announce names the SAME chain unqualified (`evm:84532`). Exact
 * string matching never intersects the two sets, so `matchNegotiatedChain`
 * skipped straight past EVM to the next mutually-supported chain
 * (`solana:devnet`) — silently negotiating a chain nobody asked for instead
 * of failing loudly or matching the equivalent chain.
 */
describe('ToonClient.matchNegotiatedChain — devnet preset vs live announce (#500)', () => {
  function matchNegotiatedChain(
    client: ToonClient,
    ourChains: string[],
    peerChains: string[],
    peerId = 'devnetApex'
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any).matchNegotiatedChain(ourChains, peerChains, peerId);
  }

  it('negotiates the devnet preset\'s EVM chain against an announce using the unqualified form', () => {
    const client = new ToonClient(baseConfig({}));
    // The real `network: 'devnet'` preset — pins this test to whatever chain
    // id @toon-protocol/core actually resolves, so a future core bump that
    // changes the id still exercises the real drift this issue found.
    const presets = resolveClientNetwork('devnet');
    const evmId = presets.supportedChains.find((c) => c.startsWith('evm:'));
    expect(evmId).toBeDefined();
    const numericChainId = evmId!.split(':').pop();

    // The live devnet apex's kind:10032 announce, unqualified.
    const announceChains = [
      `evm:${numericChainId}`,
      'solana:devnet',
      'mina:devnet',
    ];

    const matched = matchNegotiatedChain(
      client,
      presets.supportedChains,
      announceChains
    );
    expect(matched).toBe(`evm:${numericChainId}`);
    expect(matched).not.toBe('solana:devnet');
  });

  it('honors an explicitly configured evm preferredChain against the unqualified announce form', () => {
    const client = new ToonClient(baseConfig({ preferredChain: 'evm' }));
    const matched = matchNegotiatedChain(
      client,
      ['solana:devnet:0', 'evm:base:84532'],
      ['solana:devnet:0', 'evm:84532']
    );
    expect(matched).toBe('evm:84532');
  });
});
