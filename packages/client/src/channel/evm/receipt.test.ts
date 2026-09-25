/**
 * Waiting for an EVM receipt over an RPC that sometimes fails a poll, which a
 * public RPC reached through `anon` does (connector ADR 0073, decision 5).
 *
 * viem's own wait rejects on the first receipt poll that fails in transit, once
 * the transport's retries are spent. The transaction may be mined a block later.
 * The rule under test is the same as on Solana: a failed poll says nothing
 * about the transaction, so only a receipt or the deadline ends the wait, and
 * the deadline's error names the hash to look up.
 *
 * The chain is a loopback JSON-RPC server. Nothing leaves the machine.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublicClient, http as viemHttp } from 'viem';
import { waitForReceipt } from './receipt.js';
import { TransactionOutcomeError } from '../../client/errors.js';

const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

const RECEIPT = {
  transactionHash: TX_HASH,
  transactionIndex: '0x0',
  blockHash: BLOCK_HASH,
  blockNumber: '0x10',
  from: `0x${'00'.repeat(20)}`,
  to: `0x${'22'.repeat(20)}`,
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x1',
  contractAddress: null,
  logs: [],
  logsBloom: `0x${'00'.repeat(256)}`,
  status: '0x1',
  type: '0x2',
};

const TRANSACTION = {
  hash: TX_HASH,
  nonce: '0x0',
  blockHash: null,
  blockNumber: null,
  transactionIndex: null,
  from: `0x${'00'.repeat(20)}`,
  to: `0x${'22'.repeat(20)}`,
  value: '0x0',
  gas: '0x5208',
  gasPrice: '0x1',
  maxFeePerGas: '0x1',
  maxPriorityFeePerGas: '0x1',
  input: '0x',
  type: '0x2',
  chainId: '0x14a34',
  v: '0x0',
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'11'.repeat(32)}`,
  yParity: '0x0',
  accessList: [],
};

let server: http.Server;
let url: string;
/** How many receipt polls fail with a 503 before one succeeds. `Infinity`: never. */
let failingReceiptPolls = 0;
/** Whether the chain has mined the transaction at all. */
let mined = true;
let receiptPolls = 0;

beforeEach(async () => {
  receiptPolls = 0;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: number;
        method: string;
      };
      const answer = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      };
      if (call.method === 'eth_getTransactionReceipt') {
        receiptPolls += 1;
        if (receiptPolls <= failingReceiptPolls) {
          res.writeHead(503);
          res.end('upstream unavailable');
          return;
        }
        answer(mined ? RECEIPT : null);
        return;
      }
      if (call.method === 'eth_blockNumber') return answer('0x10');
      // The node knows the transaction (it is in its mempool, or mined), which
      // is what viem's replacement check reads before it polls for a receipt.
      if (call.method === 'eth_getTransactionByHash')
        return answer(TRANSACTION);
      answer(null);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A client that retries fast and polls fast, so the test does not wait on viem's defaults. */
function client() {
  return createPublicClient({
    transport: viemHttp(url, { retryCount: 1, retryDelay: 1 }),
    pollingInterval: 10,
  });
}

describe('waitForReceipt', () => {
  it('returns the receipt once it is there', async () => {
    failingReceiptPolls = 0;
    mined = true;
    await expect(waitForReceipt(client(), TX_HASH)).resolves.toMatchObject({
      status: 'success',
    });
  });

  it('keeps waiting through receipt polls that fail in transit', async () => {
    // Enough failures to outlast the transport's own retry, for both the
    // first look and the first poll, so viem's wait gives up at least once.
    failingReceiptPolls = 6;
    mined = true;
    const receipt = await waitForReceipt(client(), TX_HASH, {
      retryDelayMs: 5,
    });
    expect(receipt.transactionHash).toBe(TX_HASH);
    expect(receiptPolls).toBeGreaterThan(6);
  });

  it('ends at the deadline with an error naming the hash, never a bare poll failure', async () => {
    failingReceiptPolls = Infinity;
    const error = await waitForReceipt(client(), TX_HASH, {
      timeoutMs: 300,
      retryDelayMs: 5,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionOutcomeError);
    expect(error).toMatchObject({
      chain: 'evm',
      txHash: TX_HASH,
      outcome: 'unknown',
    });
    expect(String(error)).toMatch(/may still be mined/);
  });

  it('ends at the deadline when the transaction is simply not mined yet', async () => {
    failingReceiptPolls = 0;
    mined = false;
    const error = await waitForReceipt(client(), TX_HASH, {
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionOutcomeError);
  });
});
