import { describe, it, expect, vi } from 'vitest';
import type { EvmRpc } from '../channel/batch-settlement/evm-network.js';
import { solanaRpcClient } from '../channel/solana/json-rpc.js';
import {
  parseEvmChainId,
  readEvmTokenBalance,
  readEvmNativeBalance,
  readSolanaTokenBalance,
  readSolanaNativeBalance,
  readWalletBalances,
  type EvmBalanceReader,
} from './balances.js';

/** An EVM read client that answers balanceOf/decimals/symbol and eth_getBalance. */
function evmClient(): EvmBalanceReader {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'balanceOf') return 125_500_000n;
      if (functionName === 'decimals') return 6;
      if (functionName === 'symbol') return 'USDC';
      throw new Error(`unexpected fn ${functionName}`);
    }),
    // Native ETH read (`eth_getBalance`) — 1.5 ETH in wei.
    getBalance: vi.fn(async () => 1_500_000_000_000_000_000n),
  } as unknown as EvmBalanceReader;
}

/** The EVM settlement network's RPC, as far as a balance read uses it. */
function evmRpc(client: EvmBalanceReader = evmClient()): EvmRpc {
  return { proxied: false, reader: () => client } as unknown as EvmRpc;
}

/** The Solana settlement network's RPC over `fetchImpl`. */
function solanaRpc(fetchImpl: unknown) {
  return solanaRpcClient({ url: 'http://localhost:8899', fetch: fetchImpl as typeof fetch });
}

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
      client: evmClient(),
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
      rpc: solanaRpc(fetchImpl),
      mint: 'mint11111111111111111111111111111111111111',
      owner: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
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
      readSolanaTokenBalance({ rpc: solanaRpc(fetchImpl), mint: 'm', owner: 'o' })
    ).rejects.toThrow(/boom/);
  });
});

describe('readEvmNativeBalance', () => {
  it('reads native ETH (wei) via eth_getBalance as symbol ETH / 18 decimals', async () => {
    const bal = await readEvmNativeBalance({
      client: evmClient(),
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
      rpc: solanaRpc(fetchImpl),
      owner: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    });
    expect(bal).toEqual({ symbol: 'SOL', amount: '2000000000', decimals: 9 });
  });

  it('throws on a non-200 RPC response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));
    await expect(
      readSolanaNativeBalance({ rpc: solanaRpc(fetchImpl), owner: 'o' })
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

  it('groups native + USDC per chain across EVM and Solana', async () => {
    const sol = solanaFetch();

    const result = await readWalletBalances({
      evm: {
        chainKey: 'evm:31337',
        owner: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        rpc: evmRpc(),
      },
      solana: {
        owner: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
        tokenMint: 'mint11111111111111111111111111111111111111',
        rpc: solanaRpc(sol),
      },
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
    ]);
  });

  it('a chain with no token config still reports native', async () => {
    const sol = solanaFetch();
    const [chain] = await readWalletBalances({
      solana: {
        owner: 'SoLownerNoToken1111111111111111111111111111',
        // no tokenMint
        rpc: solanaRpc(sol),
      },
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
      owner: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      rpc: evmRpc(),
    };
    // Solana RPC is down: every call rejects.
    const downFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await readWalletBalances({
      evm: evmOk,
      solana: {
        owner: 'SoLownerDown11111111111111111111111111111111',
        tokenMint: 'mint11111111111111111111111111111111111111',
        rpc: solanaRpc(downFetch),
      },
    });
    const evm = result.find((c) => c.chain === 'evm');
    const solana = result.find((c) => c.chain === 'solana');
    expect(evm?.native?.symbol).toBe('ETH');
    expect(solana).toMatchObject({ chain: 'solana', unreadable: true, tokens: [] });
    expect(solana?.error).toMatch(/ECONNREFUSED/);
  });
});
