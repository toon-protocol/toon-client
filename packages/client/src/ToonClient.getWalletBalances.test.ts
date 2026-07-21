/**
 * getWalletBalances — the full multi-chain wallet view (#299).
 *
 * Verifies the ToonClient wiring (not the readers, which are unit-tested in
 * balance/WalletBalanceReader.test.ts): the settlement EVM chain + Solana + Mina
 * sources are built from the resolved config, and the Solana/Mina addresses are
 * derived from the mnemonic on an UNSTARTED client (the same keys start() would
 * register), so every configured chain is requested even before a start.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ToonClientConfig } from './types.js';
import type { WalletBalanceSources } from './balance/WalletBalanceReader.js';

const { readWalletBalances } = vi.hoisted(() => ({
  readWalletBalances: vi.fn(async (_sources: unknown) => []),
}));

vi.mock('./balance/WalletBalanceReader.js', () => ({
  parseEvmChainId: (k: string) => Number(k.split(':').pop()),
  readEvmTokenBalance: vi.fn(),
  readEvmNativeBalance: vi.fn(),
  readSolanaTokenBalance: vi.fn(),
  readSolanaNativeBalance: vi.fn(),
  readMinaBalance: vi.fn(),
  readMinaTokenBalance: vi.fn(),
  minaTokenIdToBase58: vi.fn(),
  readWalletBalances,
}));

const { ToonClient } = await import('./ToonClient.js');

const MNEMONIC = 'test test test test test test test test test test test junk';
const noop: any = () => new Uint8Array();

function baseConfig(overrides: Partial<ToonClientConfig>): ToonClientConfig {
  return {
    connectorUrl: 'http://localhost:8080',
    mnemonic: MNEMONIC,
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.test',
      btpEndpoint: 'ws://localhost:3000',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: noop,
    toonDecoder: () => ({}) as NostrEvent,
    supportedChains: ['evm:base:84532', 'evm:anvil:31337'],
    chainRpcUrls: {
      'evm:base:84532': 'https://sepolia.base.org',
      'evm:anvil:31337': 'https://anvil.example',
    },
    preferredTokens: {
      'evm:base:84532': '0xBASEUSDC',
      'evm:anvil:31337': '0xANVILUSDC',
    },
    settlementAddresses: { 'evm:anvil:31337': '0xSETTLE' },
    solanaChannel: {
      rpcUrl: 'https://solana.example',
      programId: 'Prog1111111111111111111111111111111111111111',
      tokenMint: 'Mint1111111111111111111111111111111111111111',
    },
    minaChannel: {
      graphqlUrl: 'https://mina.example/graphql',
      zkAppAddress: 'B62qZkApp1111111111111111111111111111111111',
    },
    ...overrides,
  } as ToonClientConfig;
}

describe('ToonClient.getWalletBalances', () => {
  it('builds settlement-EVM + Solana sources on an UNSTARTED client', async () => {
    readWalletBalances.mockClear();
    const client = new ToonClient(baseConfig({}));
    await client.getWalletBalances(); // no start()
    expect(readWalletBalances).toHaveBeenCalledTimes(1);
    const sources = readWalletBalances.mock.calls[0]![0] as WalletBalanceSources;

    // EVM: the settlement chain (anvil), not the preset-first base chain.
    expect(sources.evm).toMatchObject({
      chainKey: 'evm:anvil:31337',
      rpcUrl: 'https://anvil.example',
      tokenAddress: '0xANVILUSDC',
    });
    expect(sources.evm?.owner).toMatch(/^0x/);

    // Solana: address derived from the mnemonic despite no start().
    expect(sources.solana).toMatchObject({
      chainKey: 'solana',
      rpcUrl: 'https://solana.example',
      tokenMint: 'Mint1111111111111111111111111111111111111111',
    });
    expect(sources.solana?.owner).toBeTruthy();
  });

  it('threads the derived minaChannel.tokenId into the Mina balance source', async () => {
    // A fresh client resolves minaChannel (graphqlUrl + zkApp + tokenId) from the
    // preset/announce even without an explicit config.minaChannel; the tokenId
    // must reach the reader so the custom Mina USDC balance is read (not native).
    readWalletBalances.mockClear();
    const client = new ToonClient(
      baseConfig({
        minaChannel: {
          graphqlUrl: 'https://mina.example/graphql',
          zkAppAddress: 'B62qmgPhv2Xo6QVEtwjLja8UZJUtu8yapRFAR6gaoGtbM9zE5hG7Tkf',
          tokenId:
            '9497120696276615621907376728658022802954262638363646162765282600447713419198',
        },
      })
    );
    await client.getWalletBalances(); // no start()
    const sources = readWalletBalances.mock.calls[0]![0] as WalletBalanceSources;
    expect(sources.mina).toMatchObject({
      chainKey: 'mina',
      graphqlUrl: 'https://mina.example/graphql',
      tokenId:
        '9497120696276615621907376728658022802954262638363646162765282600447713419198',
    });
    expect(sources.mina?.owner).toBeTruthy();
  });

  it('omits the Mina tokenId when the channel has none (native-only)', async () => {
    readWalletBalances.mockClear();
    const client = new ToonClient(baseConfig({})); // baseConfig minaChannel has no tokenId
    await client.getWalletBalances();
    const sources = readWalletBalances.mock.calls[0]![0] as WalletBalanceSources;
    expect(sources.mina).toBeDefined();
    expect(sources.mina?.tokenId).toBeUndefined();
  });

  it('omits Solana/Mina when the identity has no such chain config', async () => {
    readWalletBalances.mockClear();
    const client = new ToonClient(
      baseConfig({ solanaChannel: undefined, minaChannel: undefined })
    );
    await client.getWalletBalances();
    const sources = readWalletBalances.mock.calls[0]![0] as WalletBalanceSources;
    expect(sources.evm).toBeDefined();
    expect(sources.solana).toBeUndefined();
    expect(sources.mina).toBeUndefined();
  });
});
