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
      // Native ETH read (`eth_getBalance`) — 1.5 ETH in wei.
      getBalance: vi.fn(async () => 1_500_000_000_000_000_000n),
    })),
  };
});

const {
  parseEvmChainId,
  readEvmTokenBalance,
  readEvmNativeBalance,
  readSolanaTokenBalance,
  readSolanaNativeBalance,
  readMinaBalance,
  readWalletBalances,
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

describe('readEvmNativeBalance', () => {
  it('reads native ETH (wei) via eth_getBalance as symbol ETH / 18 decimals', async () => {
    const bal = await readEvmNativeBalance({
      rpcUrl: 'http://localhost:8545',
      chainKey: 'evm:anvil:31337',
      owner: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    });
    expect(bal).toEqual({ symbol: 'ETH', amount: '1500000000000000000', decimals: 18 });
  });
});

describe('readSolanaNativeBalance', () => {
  it('reads native SOL (lamports) via getBalance as symbol SOL / 9 decimals', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 2_000_000_000 } }), {
        status: 200,
      })
    );
    const bal = await readSolanaNativeBalance({
      rpcUrl: 'http://localhost:8899',
      owner: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(bal).toEqual({ symbol: 'SOL', amount: '2000000000', decimals: 9 });
  });

  it('throws on a non-200 RPC response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));
    await expect(
      readSolanaNativeBalance({ rpcUrl: 'x', owner: 'o', fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/HTTP 502/);
  });
});

describe('readWalletBalances (grouped multi-chain view)', () => {
  // A Solana fetch that answers both the native getBalance and the SPL
  // getTokenAccountsByOwner calls off the same impl.
  const solanaFetch = () =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      if (body.method === 'getBalance') {
        return new Response(JSON.stringify({ result: { value: 2_000_000_000 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          result: {
            value: [
              { account: { data: { parsed: { info: { tokenAmount: { amount: '5000000', decimals: 6 } } } } } },
            ],
          },
        }),
        { status: 200 }
      );
    });

  it('groups native + USDC per chain across EVM, Solana, and Mina', async () => {
    const minaFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { account: { balance: { total: '3000000000' } } } }), {
        status: 200,
      })
    );
    // One fetch impl multiplexes Solana + Mina by URL.
    const sol = solanaFetch();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) =>
      url.includes('graphql') ? minaFetch(url, init) : sol(url, init)
    );

    const result = await readWalletBalances({
      evm: {
        chainKey: 'evm:31337',
        rpcUrl: 'http://localhost:8545',
        owner: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
        tokenAddress: '0x0000000000000000000000000000000000000001',
      },
      solana: {
        rpcUrl: 'http://localhost:8899',
        owner: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
        tokenMint: 'mint11111111111111111111111111111111111111',
      },
      mina: {
        graphqlUrl: 'http://localhost:3085/graphql',
        owner: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im4oG6',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual([
      {
        chain: 'evm',
        chainKey: 'evm:31337',
        address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
        native: { symbol: 'ETH', amount: '1500000000000000000', decimals: 18 },
        tokens: [
          {
            symbol: 'USDC',
            amount: '125500000',
            decimals: 6,
            address: '0x0000000000000000000000000000000000000001',
          },
        ],
      },
      {
        chain: 'solana',
        chainKey: 'solana',
        address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
        native: { symbol: 'SOL', amount: '2000000000', decimals: 9 },
        tokens: [
          {
            symbol: 'USDC',
            amount: '5000000',
            decimals: 6,
            address: 'mint11111111111111111111111111111111111111',
          },
        ],
      },
      {
        chain: 'mina',
        chainKey: 'mina',
        address: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im4oG6',
        native: { symbol: 'MINA', amount: '3000000000', decimals: 9 },
        tokens: [],
      },
    ]);
  });

  it('a chain with no token config still reports native', async () => {
    const sol = solanaFetch();
    const [chain] = await readWalletBalances({
      solana: {
        rpcUrl: 'http://localhost:8899',
        owner: 'SoLownerNoToken1111111111111111111111111111',
        // no tokenMint
      },
      fetchImpl: sol as unknown as typeof fetch,
    });
    expect(chain).toMatchObject({
      chain: 'solana',
      native: { symbol: 'SOL', amount: '2000000000', decimals: 9 },
      tokens: [],
    });
    expect(chain?.unreadable).toBeUndefined();
  });

  it('an unreachable RPC degrades that chain to unreadable without failing others', async () => {
    const evmOk = {
      chainKey: 'evm:31337',
      rpcUrl: 'http://localhost:8545',
      owner: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      tokenAddress: '0x0000000000000000000000000000000000000001',
    };
    // Solana RPC is down: every call rejects.
    const downFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await readWalletBalances({
      evm: evmOk,
      solana: {
        rpcUrl: 'http://down:8899',
        owner: 'SoLownerDown11111111111111111111111111111111',
        tokenMint: 'mint11111111111111111111111111111111111111',
      },
      fetchImpl: downFetch as unknown as typeof fetch,
    });
    const evm = result.find((c) => c.chain === 'evm');
    const solana = result.find((c) => c.chain === 'solana');
    expect(evm?.native?.symbol).toBe('ETH');
    expect(solana).toMatchObject({ chain: 'solana', unreadable: true, tokens: [] });
    expect(solana?.error).toMatch(/ECONNREFUSED/);
  });
});
