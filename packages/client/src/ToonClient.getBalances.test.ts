/**
 * getBalances EVM chain selection.
 *
 * Regression guard: `supportedChains` is a union with the network PRESET first
 * (applyDefaults), so the preset's primary EVM chain (e.g. base-sepolia on
 * devnet) sorts ahead of an explicitly-configured settlement chain like
 * `evm:anvil:31337`. getBalances must read the SETTLEMENT chain's token (where
 * the faucet funds and channels live), not the first chain in the list — else a
 * funded wallet reads a different contract and reports a 0 balance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ToonClientConfig } from './types.js';

const { readEvmTokenBalance } = vi.hoisted(() => ({
  readEvmTokenBalance: vi.fn(async (opts: any) => ({
    chain: 'evm' as const,
    address: opts?.owner ?? '?',
    amount: '79998500000',
    asset: 'USDC',
    assetScale: 6,
  })),
}));

vi.mock('./balance/WalletBalanceReader.js', () => ({
  parseEvmChainId: (k: string) => Number(k.split(':').pop()),
  readEvmTokenBalance,
  readSolanaTokenBalance: vi.fn(),
  readMinaBalance: vi.fn(),
}));

const { ToonClient } = await import('./ToonClient.js');

const MNEMONIC =
  'test test test test test test test test test test test junk';
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
    // preset-first ordering: base-sepolia ahead of the anvil settlement chain
    supportedChains: ['evm:base:84532', 'evm:anvil:31337'],
    chainRpcUrls: {
      'evm:base:84532': 'https://sepolia.base.org',
      'evm:anvil:31337': 'https://anvil.example',
    },
    preferredTokens: {
      'evm:base:84532': '0xBASEUSDC',
      'evm:anvil:31337': '0xANVILUSDC',
    },
    ...overrides,
  } as ToonClientConfig;
}

describe('ToonClient.getBalances — EVM chain selection', () => {
  beforeEach(() => readEvmTokenBalance.mockClear());

  it('reads the settlement chain, not the preset-first chain', async () => {
    const client = new ToonClient(
      baseConfig({ settlementAddresses: { 'evm:anvil:31337': '0xSETTLE' } })
    );
    await client.getBalances();
    expect(readEvmTokenBalance).toHaveBeenCalledTimes(1);
    expect(readEvmTokenBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        chainKey: 'evm:anvil:31337',
        tokenAddress: '0xANVILUSDC',
      })
    );
  });

  it('falls back to the first usable evm chain when no settlementAddresses', async () => {
    const client = new ToonClient(baseConfig({}));
    await client.getBalances();
    expect(readEvmTokenBalance).toHaveBeenCalledWith(
      expect.objectContaining({ chainKey: 'evm:base:84532' })
    );
  });
});
