/**
 * sendTransfer — plain token/native-gas transfer (issue #491).
 *
 * Covers: chain/asset dispatch and validation (unknown chain, malformed
 * address, non-positive amount), EVM native+token sends over a mocked viem,
 * Solana native+SPL sends over a mocked raw JSON-RPC (mirroring
 * OnChainChannelClient.test.ts's `fetchMock` pattern)
 * over a mocked GraphQL fetch. Every chain gets an explicit "accepted
 * on-chain but delivers nothing" (zero-delta) case — the connector#691 shape
 * the issue calls out by name for Solana.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '../utils/base58.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { deriveAssociatedTokenAccount } from '../channel/solana/payment-channel.js';
import {
  InsufficientBalanceError,
  InvalidAddressError,
  TransferNotDeliveredError,
  TransferUnsupportedError,
  UnknownChainError,
  ValidationError,
} from '../client/errors.js';
import { sendTransfer, type TransferConfig } from './transfer.js';

// ---------------------------------------------------------------------------
// viem mock (mirrors OnChainChannelClient.test.ts)
// ---------------------------------------------------------------------------

const mockGetBalance = vi.fn();
const mockReadContract = vi.fn();
const mockWriteContract = vi.fn();
const mockSendTransaction = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBalance: mockGetBalance,
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    })),
    createWalletClient: vi.fn(() => ({
      sendTransaction: mockSendTransaction,
      writeContract: mockWriteContract,
    })),
  };
});

const EVM_CHAIN_KEY = 'evm:anvil:31337';
const EVM_TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const EVM_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function evmConfig({ withToken = true } = {}): TransferConfig {
  return {
    evm: {
      chainKey: EVM_CHAIN_KEY,
      rpcUrl: 'http://localhost:8545',
      signer: new EvmSigner(generatePrivateKey()),
      ...(withToken ? { tokenAddress: EVM_TOKEN } : {}),
    },
  };
}

describe('sendTransfer — dispatch & validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a non-positive amount', async () => {
    await expect(
      sendTransfer(evmConfig(), {
        chain: 'evm',
        asset: 'native',
        to: EVM_TO,
        amount: '0',
      })
    ).rejects.toThrow(ValidationError);
  });

  it('throws UnknownChainError when the chain is not configured', async () => {
    await expect(
      sendTransfer(
        {},
        { chain: 'evm', asset: 'native', to: EVM_TO, amount: '1' }
      )
    ).rejects.toThrow(UnknownChainError);
    await expect(
      sendTransfer(
        {},
        {
          chain: 'solana',
          asset: 'native',
          to: 'So11111111111111111111111111111111111111112',
          amount: '1',
        }
      )
    ).rejects.toThrow(UnknownChainError);
  });

  it('throws UnknownChainError for an unrecognized chain identifier', async () => {
    await expect(
      sendTransfer(evmConfig(), {
        // @ts-expect-error - deliberately invalid for the runtime-guard test
        chain: 'bitcoin',
        asset: 'native',
        to: EVM_TO,
        amount: '1',
      })
    ).rejects.toThrow(UnknownChainError);
  });

  it('throws InvalidAddressError for a malformed EVM address', async () => {
    await expect(
      sendTransfer(evmConfig(), {
        chain: 'evm',
        asset: 'native',
        to: 'not-an-address',
        amount: '1',
      })
    ).rejects.toThrow(InvalidAddressError);
  });

  it('throws InvalidAddressError for a malformed Solana address', async () => {
    await expect(
      sendTransfer(
        { solana: { rpcUrl: 'http://x', keypair: new Uint8Array(32).fill(1) } },
        { chain: 'solana', asset: 'native', to: '0xnotbase58!!', amount: '1' }
      )
    ).rejects.toThrow(InvalidAddressError);
  });

});

describe('sendTransfer — EVM', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends native ETH and confirms by destination balance delta', async () => {
    mockGetBalance
      .mockResolvedValueOnce(10_000_000_000_000_000_000n) // sender balance (preflight)
      .mockResolvedValueOnce(0n) // dest balance before
      .mockResolvedValueOnce(1_000n); // dest balance after (delta observed)
    mockSendTransaction.mockResolvedValueOnce('0xtxhash');
    mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

    const result = await sendTransfer(evmConfig(), {
      chain: 'evm',
      asset: 'native',
      to: EVM_TO,
      amount: '1000',
    });

    expect(result.txHash).toBe('0xtxhash');
    expect(result.balanceBefore).toBe('0');
    expect(result.balanceAfter).toBe('1000');
    expect(mockSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: EVM_TO, value: 1000n })
    );
  });

  it('throws InsufficientBalanceError before sending when the sender is short', async () => {
    mockGetBalance.mockResolvedValueOnce(500n); // sender balance < amount
    await expect(
      sendTransfer(evmConfig(), {
        chain: 'evm',
        asset: 'native',
        to: EVM_TO,
        amount: '1000',
      })
    ).rejects.toThrow(InsufficientBalanceError);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('throws TransferNotDeliveredError on a reverted receipt', async () => {
    mockGetBalance
      .mockResolvedValueOnce(10_000_000_000_000_000_000n)
      .mockResolvedValueOnce(0n);
    mockSendTransaction.mockResolvedValueOnce('0xtxhash');
    mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });

    await expect(
      sendTransfer(evmConfig(), {
        chain: 'evm',
        asset: 'native',
        to: EVM_TO,
        amount: '1000',
      })
    ).rejects.toThrow(TransferNotDeliveredError);
  });

  it('throws TransferNotDeliveredError when confirmed on-chain but the balance never moves (zero-delta)', async () => {
    mockGetBalance
      .mockResolvedValueOnce(10_000_000_000_000_000_000n) // sender preflight
      .mockResolvedValue(0n); // dest balance: before AND every poll — never rises
    mockSendTransaction.mockResolvedValueOnce('0xtxhash');
    mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

    await expect(
      sendTransfer(evmConfig(), {
        chain: 'evm',
        asset: 'native',
        to: EVM_TO,
        amount: '1000',
        confirmTimeoutMs: 20,
        confirmPollIntervalMs: 5,
      })
    ).rejects.toThrow(TransferNotDeliveredError);
  });

  it('sends the settlement token via ERC-20 transfer', async () => {
    mockReadContract
      .mockResolvedValueOnce(5_000_000n) // sender balanceOf
      .mockResolvedValueOnce(0n) // dest balanceOf before
      .mockResolvedValueOnce(2_000_000n); // dest balanceOf after
    mockWriteContract.mockResolvedValueOnce('0xtokentx');
    mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'success' });

    const result = await sendTransfer(evmConfig(), {
      chain: 'evm',
      asset: 'token',
      to: EVM_TO,
      amount: '2000000',
    });

    expect(result.txHash).toBe('0xtokentx');
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'transfer',
        args: [EVM_TO, 2000000n],
      })
    );
  });

  it('throws TransferUnsupportedError when no settlement token is configured', async () => {
    await expect(
      sendTransfer(evmConfig({ withToken: false }), {
        chain: 'evm',
        asset: 'token',
        to: EVM_TO,
        amount: '1000',
      })
    ).rejects.toThrow(TransferUnsupportedError);
  });
});

describe('sendTransfer — Solana', () => {
  const SEED = new Uint8Array(32).fill(7);
  const PAYER_PUBKEY = base58Encode(
    new Uint8Array(ed25519.getPublicKey(SEED))
  );
  const TOKEN_MINT = '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q';
  const DEST = 'So11111111111111111111111111111111111111112';

  let fetchMock: ReturnType<typeof vi.fn>;
  const origFetch = globalThis.fetch;

  interface RpcOpts {
    lamports?: number;
    /** Sequence of getBalance/getLamports responses for the DEST address, in order. */
    destLamportsSequence?: number[];
    tokenBalanceFor?: (account: string) => string | null;
  }

  function mockRpc(opts: RpcOpts = {}): void {
    const lamports = opts.lamports ?? 1_000_000_000;
    let destSeqIdx = 0;
    const destSeq = opts.destLamportsSequence;
    const tokenBalanceFor = opts.tokenBalanceFor ?? (() => '1000000000');

    fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        method: string;
        params: unknown[];
      };
      let result: unknown;
      switch (body.method) {
        case 'getBalance': {
          const pubkey = body.params[0] as string;
          if (destSeq && pubkey === DEST) {
            const v = destSeq[Math.min(destSeqIdx, destSeq.length - 1)];
            destSeqIdx++;
            result = { value: v };
          } else {
            result = { value: lamports };
          }
          break;
        }
        case 'getTokenAccountBalance': {
          const balance = tokenBalanceFor(body.params[0] as string);
          if (balance === null) {
            return {
              ok: true,
              json: async () => ({
                jsonrpc: '2.0',
                id: 1,
                error: {
                  code: -32602,
                  message: 'Invalid param: could not find account',
                },
              }),
            } as unknown as Response;
          }
          result = { value: { amount: balance, decimals: 6 } };
          break;
        }
        case 'getLatestBlockhash':
          result = { value: { blockhash: 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm' } };
          break;
        case 'sendTransaction':
          result = 'solana-tx-signature-stub';
          break;
        case 'getSignatureStatuses':
          result = { value: [{ confirmationStatus: 'confirmed' }] };
          break;
        default:
          result = null;
      }
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result }),
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('sends native SOL and confirms by destination balance delta', async () => {
    mockRpc({ destLamportsSequence: [0, 2000] });

    const result = await sendTransfer(
      { solana: { rpcUrl: 'http://rpc', keypair: SEED } },
      { chain: 'solana', asset: 'native', to: DEST, amount: '2000' }
    );

    expect(result.txHash).toBe('solana-tx-signature-stub');
    expect(result.balanceBefore).toBe('0');
    expect(result.balanceAfter).toBe('2000');
  });

  it('throws InsufficientBalanceError when native SOL is short (before sending)', async () => {
    mockRpc({ lamports: 100 });
    await expect(
      sendTransfer(
        { solana: { rpcUrl: 'http://rpc', keypair: SEED } },
        { chain: 'solana', asset: 'native', to: DEST, amount: '2000' }
      )
    ).rejects.toThrow(InsufficientBalanceError);
    const sent = fetchMock.mock.calls.some((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return body.method === 'sendTransaction';
    });
    expect(sent).toBe(false);
  });

  it('throws TransferNotDeliveredError when the tx confirms but the destination balance never moves (connector#691 shape)', async () => {
    // Destination balance stays at 0 across every poll — a real tx signature,
    // no lamports actually delivered (exactly the devnet faucet Solana bug).
    mockRpc({ destLamportsSequence: [0, 0, 0, 0, 0, 0] });

    await expect(
      sendTransfer(
        { solana: { rpcUrl: 'http://rpc', keypair: SEED } },
        {
          chain: 'solana',
          asset: 'native',
          to: DEST,
          amount: '2000',
          confirmTimeoutMs: 20,
          confirmPollIntervalMs: 5,
        }
      )
    ).rejects.toThrow(TransferNotDeliveredError);
  });

  it('sends the SPL settlement token, creating the destination ATA idempotently', async () => {
    const destAta = deriveAssociatedTokenAccount(DEST, TOKEN_MINT);
    const senderAta = deriveAssociatedTokenAccount(PAYER_PUBKEY, TOKEN_MINT);
    let destAtaCalls = 0;
    mockRpc({
      tokenBalanceFor: (account) => {
        if (account === senderAta) return '5000000';
        if (account === destAta) {
          destAtaCalls++;
          return destAtaCalls === 1 ? null : '3000000';
        }
        return '0';
      },
    });

    const result = await sendTransfer(
      {
        solana: {
          rpcUrl: 'http://rpc',
          keypair: SEED,
          tokenMint: TOKEN_MINT,
        },
      },
      { chain: 'solana', asset: 'token', to: DEST, amount: '3000000' }
    );

    expect(result.balanceBefore).toBe('0');
    expect(result.balanceAfter).toBe('3000000');
    const sentTx = fetchMock.mock.calls
      .map((call) => JSON.parse((call[1] as RequestInit).body as string))
      .find((b) => b.method === 'sendTransaction');
    expect(sentTx).toBeDefined();
  });

  it('throws InsufficientBalanceError when the SPL token balance is short', async () => {
    const senderAta = deriveAssociatedTokenAccount(PAYER_PUBKEY, TOKEN_MINT);
    mockRpc({
      tokenBalanceFor: (account) => (account === senderAta ? '100' : '0'),
    });
    await expect(
      sendTransfer(
        {
          solana: { rpcUrl: 'http://rpc', keypair: SEED, tokenMint: TOKEN_MINT },
        },
        { chain: 'solana', asset: 'token', to: DEST, amount: '3000000' }
      )
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('throws TransferUnsupportedError when no settlement mint is configured', async () => {
    mockRpc();
    await expect(
      sendTransfer(
        { solana: { rpcUrl: 'http://rpc', keypair: SEED } },
        { chain: 'solana', asset: 'token', to: DEST, amount: '1000' }
      )
    ).rejects.toThrow(TransferUnsupportedError);
  });
});
