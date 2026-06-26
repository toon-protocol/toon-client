import { describe, it, expect, vi } from 'vitest';
import type * as ViemModule from 'viem';

// Mock viem's createPublicClient so the EVM reader resolves balanceOf/decimals/
// symbol deterministically without a live RPC. Mirrors OnChainChannelClient.test.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof ViemModule>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'balanceOf') return 125_500_000n;
        if (functionName === 'decimals') return 6;
        if (functionName === 'symbol') return 'USDC';
        throw new Error(`unexpected fn ${functionName}`);
      }),
    })),
  };
});

const {
  parseEvmChainId,
  readEvmTokenBalance,
  readSolanaTokenBalance,
  readMinaBalance,
} = await import('./WalletBalanceReader.js');

describe('parseEvmChainId', () => {
  it('handles 3-part and 2-part chain keys', () => {
    expect(parseEvmChainId('evm:anvil:31337')).toBe(31337);
    expect(parseEvmChainId('evm:8453')).toBe(8453);
  });
  it('throws on a malformed key', () => {
    expect(() => parseEvmChainId('evm:')).toThrow();
  });
});

describe('readEvmTokenBalance', () => {
  it('reads balanceOf + decimals + symbol', async () => {
    const bal = await readEvmTokenBalance({
      rpcUrl: 'http://localhost:8545',
      chainKey: 'evm:anvil:31337',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      owner: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    });
    expect(bal).toEqual({
      chain: 'evm',
      address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      amount: '125500000',
      asset: 'USDC',
      assetScale: 6,
    });
  });
});

describe('readSolanaTokenBalance', () => {
  it('sums SPL token-account balances for the mint', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { amount: '48000000', decimals: 6 } } } } } },
              { account: { data: { parsed: { info: { tokenAmount: { amount: '200000', decimals: 6 } } } } } },
            ],
          },
        }),
        { status: 200 }
      )
    );
    const bal = await readSolanaTokenBalance({
      rpcUrl: 'http://localhost:8899',
      mint: 'mint11111111111111111111111111111111111111',
      owner: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(bal).toEqual({
      chain: 'solana',
      address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
      amount: '48200000',
      assetScale: 6,
    });
  });

  it('throws on an RPC error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 200 })
    );
    await expect(
      readSolanaTokenBalance({ rpcUrl: 'x', mint: 'm', owner: 'o', fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/boom/);
  });
});

describe('readMinaBalance', () => {
  it('reads native balance.total as nanomina (scale 9)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { account: { balance: { total: '3000000000' } } } }), { status: 200 })
    );
    const bal = await readMinaBalance({
      graphqlUrl: 'http://localhost:3085/graphql',
      owner: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im4oG6',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(bal).toEqual({
      chain: 'mina',
      address: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im4oG6',
      amount: '3000000000',
      asset: 'MINA',
      assetScale: 9,
    });
  });

  it('surfaces a GraphQL error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: 'no account' }] }), { status: 200 })
    );
    await expect(
      readMinaBalance({ graphqlUrl: 'x', owner: 'o', fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/no account/);
  });
});
