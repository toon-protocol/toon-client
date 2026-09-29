/**
 * The wallet facade: which chain it acts on, and where it gets the token from.
 *
 * The reads themselves are `wallet/balances.ts`'s subject and are tested there
 * against RPC fixtures. What is under test here is the wiring — that the token
 * a balance is read in comes from the CONNECTOR's published settlement rather
 * than from a preset, and that `faucet()` funds the wallet that is about to open
 * a channel rather than an unrelated one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClientWalletFacade } from './wallet-facade.js';
import { resolveConfig } from './config.js';
import { parseSelfDescription } from '../connector/self-description.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { ChainUnavailableError } from './errors.js';
import { DEVNET } from '../presets.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const IDENTITY = deriveFullIdentity(MNEMONIC);
const CONNECTOR = 'http://connector.test';

// `batchSettlements` terms as GET /ilp publishes them (connector ADR 0074).
const EVM_SETTLEMENT = {
  network: 'eip155:84532',
  asset: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
  payTo: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  receiverAuthorizer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  withdrawDelay: 86_400,
  name: 'USDC',
  version: '2',
};
const SOLANA_SETTLEMENT = {
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  asset: '34eSxY7qxQ4GzyhDJ8GpUcTz1WWzruGbJbR8q6TtxfQU',
  payTo: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1',
  feePayer: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  withdrawDelay: 86_400,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  minDeposit: '1000000',
  sponsorEndpoint: '/ilp/batch-settlement/solana/open',
};

interface Call {
  url: string;
  body: unknown;
}

function facade(
  settlements: Record<string, unknown>[] = [EVM_SETTLEMENT],
  overrides: Record<string, unknown> = {}
): { facade: ClientWalletFacade; calls: Call[] } {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  };
  const config = resolveConfig({
    connector: CONNECTOR,
    mnemonic: MNEMONIC,
    channelStore: new InMemoryChannelStore(),
    fetch: fetchImpl,
    ...overrides,
  });
  const description = parseSelfDescription(
    {
      ilpAddresses: ['g.fake'],
      peerCarriages: [],
      batchSettlements: settlements,
      routes: [],
      supportedVersions: [1],
      defaultVersion: 1,
    },
    CONNECTOR
  );
  return {
    facade: new ClientWalletFacade({ config, describe: () => Promise.resolve(description) }),
    calls,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('faucet', () => {
  it('funds the chain the client settles on, at the configured faucet', async () => {
    const h = facade();
    await h.facade.faucet();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(`${DEVNET.faucet}/api/base-sepolia/request`);
    expect(h.calls[0]?.body).toEqual({ address: IDENTITY.evm.address });
  });

  it('follows the node when it settles on Solana first', async () => {
    const h = facade([SOLANA_SETTLEMENT, EVM_SETTLEMENT]);
    await h.facade.faucet();
    expect(h.calls[0]?.url).toBe(`${DEVNET.faucet}/api/solana/usdc-request`);
    expect(h.calls[0]?.body).toEqual({ address: IDENTITY.solana.publicKey });
  });

  it('honours an explicit chain over the node\'s order', async () => {
    const h = facade([SOLANA_SETTLEMENT, EVM_SETTLEMENT]);
    await h.facade.faucet('evm');
    expect(h.calls[0]?.url).toContain('base-sepolia');
  });

  it('honours a configured faucet URL', async () => {
    const h = facade([EVM_SETTLEMENT], { faucetUrl: 'https://faucet.example' });
    await h.facade.faucet();
    expect(h.calls[0]?.url).toBe('https://faucet.example/api/base-sepolia/request');
  });

  it('refuses a chain this client holds no address on', async () => {
    const h = facade([SOLANA_SETTLEMENT], {
      mnemonic: undefined,
      evmPrivateKey: `0x${'11'.repeat(32)}`,
    });
    await expect(h.facade.faucet('solana')).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('balances', () => {
  it('refuses when the client holds no key for the chain asked about', async () => {
    const h = facade([SOLANA_SETTLEMENT], {
      mnemonic: undefined,
      evmPrivateKey: `0x${'11'.repeat(32)}`,
    });
    await expect(h.facade.balances('solana')).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('reads a chain in the token the CONNECTOR published, not a preset', async () => {
    // The Solana leg reads over the injected fetch, so nothing leaves the
    // process: what is asserted is that the read was ADDRESSED with this
    // client's own pubkey and the node's own mint.
    const h = facade([SOLANA_SETTLEMENT]);
    const [solana] = await h.facade.balances('solana');
    expect(solana?.chain).toBe('solana');
    expect(solana?.address).toBe(IDENTITY.solana.publicKey);

    const params = h.calls
      .map((c) => JSON.stringify(c.body))
      .join(' ');
    expect(params).toContain(IDENTITY.solana.publicKey);
    expect(params).toContain(SOLANA_SETTLEMENT.asset);
  });
});
