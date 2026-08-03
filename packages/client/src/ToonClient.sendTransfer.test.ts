/**
 * ToonClient.sendTransfer — wiring only (#491).
 *
 * The actual per-chain send/confirm logic is unit-tested in transfer.test.ts;
 * this file verifies ToonClient assembles the right `TransferConfig` from its
 * resolved config + (mnemonic-derived, on-demand) signing keys — mirroring
 * how ToonClient.getWalletBalances.test.ts pins the same chain-selection
 * logic for balance reads.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import type { ToonClientConfig } from './types.js';
import type { TransferConfig, SendTransferParams } from './transfer.js';

const { sendTransfer } = vi.hoisted(() => ({
  sendTransfer: vi.fn(
    async (_config: unknown, params: SendTransferParams) => ({
      chain: params.chain,
      asset: params.asset,
      to: params.to,
      amount: String(params.amount),
      txHash: 'stub-tx',
      balanceBefore: '0',
      balanceAfter: String(params.amount),
    })
  ),
}));

vi.mock('./transfer.js', () => ({ sendTransfer }));

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

describe('ToonClient.sendTransfer', () => {
  it('builds the settlement-EVM config and delegates to sendTransfer', async () => {
    sendTransfer.mockClear();
    const client = new ToonClient(baseConfig({}));
    await client.sendTransfer({
      chain: 'evm',
      asset: 'token',
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amount: '1000',
    });

    expect(sendTransfer).toHaveBeenCalledTimes(1);
    const config = sendTransfer.mock.calls[0]![0] as TransferConfig;
    expect(config.evm).toMatchObject({
      chainKey: 'evm:anvil:31337', // settlement chain, not the preset-first base chain
      rpcUrl: 'https://anvil.example',
      tokenAddress: '0xANVILUSDC',
    });
    expect(config.evm?.signer).toBeDefined();
  });

  it('derives the Solana keypair from the mnemonic on an UNSTARTED client', async () => {
    sendTransfer.mockClear();
    const client = new ToonClient(baseConfig({}));
    await client.sendTransfer({
      chain: 'solana',
      asset: 'native',
      to: 'So11111111111111111111111111111111111111112',
      amount: '1000',
    });
    const config = sendTransfer.mock.calls[0]![0] as TransferConfig;
    expect(config.solana).toMatchObject({
      rpcUrl: 'https://solana.example',
      tokenMint: 'Mint1111111111111111111111111111111111111111',
    });
    expect(config.solana?.keypair).toBeInstanceOf(Uint8Array);
    expect(config.solana?.keypair.length).toBe(32);
  });

  it('derives the Mina private key from the mnemonic on an UNSTARTED client', async () => {
    sendTransfer.mockClear();
    const client = new ToonClient(baseConfig({}));
    await client.sendTransfer({
      chain: 'mina',
      asset: 'native',
      to: 'B62qktYjkc9HQQEFwlsdyQECCnQjMKLDDxntn6ZBQXt7XPjZ9hRJ7q',
      amount: '1000',
    });
    const config = sendTransfer.mock.calls[0]![0] as TransferConfig;
    expect(config.mina).toMatchObject({
      graphqlUrl: 'https://mina.example/graphql',
    });
    expect(config.mina?.privateKey).toBeTruthy();
  });

  it('omits the solana/mina config when unconfigured', async () => {
    sendTransfer.mockClear();
    const client = new ToonClient(
      baseConfig({ solanaChannel: undefined, minaChannel: undefined })
    );
    await client.sendTransfer({
      chain: 'evm',
      asset: 'native',
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amount: '1000',
    });
    const config = sendTransfer.mock.calls[0]![0] as TransferConfig;
    expect(config.solana).toBeUndefined();
    expect(config.mina).toBeUndefined();
  });

  it('returns the sendTransfer result unchanged', async () => {
    const client = new ToonClient(baseConfig({}));
    const result = await client.sendTransfer({
      chain: 'evm',
      asset: 'native',
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amount: '42',
    });
    expect(result.txHash).toBe('stub-tx');
    expect(result.amount).toBe('42');
  });
});
