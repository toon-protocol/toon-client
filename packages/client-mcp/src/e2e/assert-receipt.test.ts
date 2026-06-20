import { describe, it, expect, vi } from 'vitest';
import {
  assertEvmUsdcSettle,
  assertSolanaReceipt,
  assertMinaReceipt,
  type EvmUsdcSettleOpts,
  type SolanaReceiptOpts,
  type MinaReceiptOpts,
} from './assert-receipt.js';

// ── EVM fixtures ─────────────────────────────────────────────────────────────

const EVM_TX = '0xabc123' as `0x${string}`;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as `0x${string}`;
const FROM = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const RECIPIENT_EVM = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const OTHER_ADDR = '0x3333333333333333333333333333333333333333' as `0x${string}`;
const AMOUNT = 1_000_000n;

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value) log
// topic[0] = keccak256("Transfer(address,address,uint256)")
// topic[1] = from (padded 32 bytes)
// topic[2] = to   (padded 32 bytes)
// data     = value as uint256 (1_000_000 = 0xF4240)
function makeTransferLog(to: `0x${string}`, value: bigint, addr = USDC) {
  const valuePadded = value.toString(16).padStart(64, '0');
  return {
    address: addr,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x000000000000000000000000${FROM.slice(2)}`,
      `0x000000000000000000000000${to.slice(2)}`,
    ] as [`0x${string}`, ...`0x${string}`[]],
    data: `0x${valuePadded}` as `0x${string}`,
  };
}

describe('assertEvmUsdcSettle', () => {
  it('resolves when Transfer log matches recipient and amount', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [makeTransferLog(RECIPIENT_EVM, AMOUNT)],
      }),
    } as unknown as EvmUsdcSettleOpts['client'];

    await expect(
      assertEvmUsdcSettle({ txHash: EVM_TX, usdcAddress: USDC, recipient: RECIPIENT_EVM, expectedAmount: AMOUNT, client })
    ).resolves.toBeUndefined();
  });

  it('throws when tx status is reverted', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted', logs: [] }),
    } as unknown as EvmUsdcSettleOpts['client'];

    await expect(
      assertEvmUsdcSettle({ txHash: EVM_TX, usdcAddress: USDC, recipient: RECIPIENT_EVM, expectedAmount: AMOUNT, client })
    ).rejects.toThrow(/"reverted"/);
  });

  it('throws when Transfer amount does not match', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [makeTransferLog(RECIPIENT_EVM, 500n)],
      }),
    } as unknown as EvmUsdcSettleOpts['client'];

    await expect(
      assertEvmUsdcSettle({ txHash: EVM_TX, usdcAddress: USDC, recipient: RECIPIENT_EVM, expectedAmount: AMOUNT, client })
    ).rejects.toThrow(/no Transfer log/);
  });

  it('resolves when a later Transfer log has the correct amount', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [makeTransferLog(RECIPIENT_EVM, 500n), makeTransferLog(RECIPIENT_EVM, AMOUNT)],
      }),
    } as unknown as EvmUsdcSettleOpts['client'];

    await expect(
      assertEvmUsdcSettle({ txHash: EVM_TX, usdcAddress: USDC, recipient: RECIPIENT_EVM, expectedAmount: AMOUNT, client })
    ).resolves.toBeUndefined();
  });

  it('throws when no Transfer to the expected recipient', async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [makeTransferLog(OTHER_ADDR, AMOUNT)],
      }),
    } as unknown as EvmUsdcSettleOpts['client'];

    await expect(
      assertEvmUsdcSettle({ txHash: EVM_TX, usdcAddress: USDC, recipient: RECIPIENT_EVM, expectedAmount: AMOUNT, client })
    ).rejects.toThrow(/no Transfer log/);
  });

  it('skips logs for other token contracts', async () => {
    const WRONG_TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
    const client = {
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [makeTransferLog(RECIPIENT_EVM, AMOUNT, WRONG_TOKEN)],
      }),
    } as unknown as EvmUsdcSettleOpts['client'];

    await expect(
      assertEvmUsdcSettle({ txHash: EVM_TX, usdcAddress: USDC, recipient: RECIPIENT_EVM, expectedAmount: AMOUNT, client })
    ).rejects.toThrow(/no Transfer log/);
  });
});

// ── Solana fixtures ───────────────────────────────────────────────────────────

const RECIPIENT_SOL = 'RecipientSolOwner11111111111111111111111111';
const SOL_SIG = 'solTxSignature111111111111111111111111111111';

function makeSolanaTx(
  recipientPostAmount: string,
  recipientPreAmount = '0',
  err: unknown = null
) {
  return {
    meta: {
      err,
      preTokenBalances: [
        { owner: RECIPIENT_SOL, uiTokenAmount: { amount: recipientPreAmount } },
      ],
      postTokenBalances: [
        { owner: RECIPIENT_SOL, uiTokenAmount: { amount: recipientPostAmount } },
      ],
    },
  };
}

function mockSolConnection(tx: ReturnType<typeof makeSolanaTx> | null) {
  return { getTransaction: vi.fn().mockResolvedValue(tx) } as SolanaReceiptOpts['connection'];
}

describe('assertSolanaReceipt', () => {
  it('resolves when SPL token delta matches expectedAmount', async () => {
    const connection = mockSolConnection(makeSolanaTx('1000000'));
    await expect(
      assertSolanaReceipt({ signature: SOL_SIG, recipient: RECIPIENT_SOL, expectedAmount: AMOUNT, connection })
    ).resolves.toBeUndefined();
  });

  it('throws when token delta does not match', async () => {
    const connection = mockSolConnection(makeSolanaTx('500000'));
    await expect(
      assertSolanaReceipt({ signature: SOL_SIG, recipient: RECIPIENT_SOL, expectedAmount: AMOUNT, connection })
    ).rejects.toThrow(/expected 1000000/);
  });

  it('throws when meta.err is set', async () => {
    const connection = mockSolConnection(makeSolanaTx('1000000', '0', { code: 1 }));
    await expect(
      assertSolanaReceipt({ signature: SOL_SIG, recipient: RECIPIENT_SOL, expectedAmount: AMOUNT, connection })
    ).rejects.toThrow(/failed/);
  });

  it('throws when transaction is not found', async () => {
    const connection = mockSolConnection(null);
    await expect(
      assertSolanaReceipt({ signature: SOL_SIG, recipient: RECIPIENT_SOL, expectedAmount: AMOUNT, connection })
    ).rejects.toThrow(/not found/);
  });

  it('treats missing pre-balance as zero', async () => {
    const connection = {
      getTransaction: vi.fn().mockResolvedValue({
        meta: {
          err: null,
          preTokenBalances: [],
          postTokenBalances: [{ owner: RECIPIENT_SOL, uiTokenAmount: { amount: '1000000' } }],
        },
      }),
    } as SolanaReceiptOpts['connection'];

    await expect(
      assertSolanaReceipt({ signature: SOL_SIG, recipient: RECIPIENT_SOL, expectedAmount: AMOUNT, connection })
    ).resolves.toBeUndefined();
  });
});

// ── Mina fixtures ─────────────────────────────────────────────────────────────

const RECIPIENT_MINA = 'B62qjBukhHFJKREuY7DMimhQJuGSh1e6UMJMbGe5hWQa5GXjUFu';
const ZKAPP_ADDR = 'B62qoLBeSGYeGHaVBqp1n5m5s1xFVPTPKLAkbfEQqhRv5BoEbPM';
const MINA_TX = 'CkZpeSomeMinaTxHash11111111111111111111111';

function mockFetch(data: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
  }) as unknown as typeof fetch;
}

describe('assertMinaReceipt', () => {
  it('resolves when tx is APPLIED and payment matches', async () => {
    const fetchFn = mockFetch({
      data: {
        transactionStatus: 'APPLIED',
        payment: { amount: '1000000', receiver: { publicKey: RECIPIENT_MINA } },
      },
    });

    await expect(
      assertMinaReceipt({
        txHash: MINA_TX,
        zkAppAddress: ZKAPP_ADDR,
        recipient: RECIPIENT_MINA,
        expectedAmount: AMOUNT,
        rpcUrl: 'http://mina-gql',
        fetchFn,
      })
    ).resolves.toBeUndefined();
  });

  it('throws when payment amount does not match expectedAmount', async () => {
    const fetchFn = mockFetch({
      data: {
        transactionStatus: 'APPLIED',
        payment: { amount: '500000', receiver: { publicKey: RECIPIENT_MINA } },
      },
    });

    await expect(
      assertMinaReceipt({
        txHash: MINA_TX,
        zkAppAddress: ZKAPP_ADDR,
        recipient: RECIPIENT_MINA,
        expectedAmount: AMOUNT,
        rpcUrl: 'http://mina-gql',
        fetchFn,
      })
    ).rejects.toThrow(/amount mismatch/);
  });

  it('throws when payment receiver does not match recipient', async () => {
    const fetchFn = mockFetch({
      data: {
        transactionStatus: 'APPLIED',
        payment: { amount: '1000000', receiver: { publicKey: 'B62qSomeOtherKey' } },
      },
    });

    await expect(
      assertMinaReceipt({
        txHash: MINA_TX,
        zkAppAddress: ZKAPP_ADDR,
        recipient: RECIPIENT_MINA,
        expectedAmount: AMOUNT,
        rpcUrl: 'http://mina-gql',
        fetchFn,
      })
    ).rejects.toThrow(/recipient mismatch/);
  });

  it('throws when transaction is not APPLIED', async () => {
    const fetchFn = mockFetch({
      data: {
        transactionStatus: 'FAILED',
        payment: { amount: '1000000', receiver: { publicKey: RECIPIENT_MINA } },
      },
    });

    await expect(
      assertMinaReceipt({
        txHash: MINA_TX,
        zkAppAddress: ZKAPP_ADDR,
        recipient: RECIPIENT_MINA,
        expectedAmount: AMOUNT,
        rpcUrl: 'http://mina-gql',
        fetchFn,
      })
    ).rejects.toThrow(/not APPLIED/);
  });

  it('throws when GraphQL HTTP request fails', async () => {
    const fetchFn = mockFetch({}, false);

    await expect(
      assertMinaReceipt({
        txHash: MINA_TX,
        zkAppAddress: ZKAPP_ADDR,
        recipient: RECIPIENT_MINA,
        expectedAmount: AMOUNT,
        rpcUrl: 'http://mina-gql',
        fetchFn,
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws when GraphQL returns errors', async () => {
    const fetchFn = mockFetch({ errors: [{ message: 'Unknown transaction' }] });

    await expect(
      assertMinaReceipt({
        txHash: MINA_TX,
        zkAppAddress: ZKAPP_ADDR,
        recipient: RECIPIENT_MINA,
        expectedAmount: AMOUNT,
        rpcUrl: 'http://mina-gql',
        fetchFn,
      })
    ).rejects.toThrow(/Unknown transaction/);
  });
});
