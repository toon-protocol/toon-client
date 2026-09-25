/**
 * Waiting for an EVM transaction to be mined, over an RPC that may fail a poll.
 *
 * viem's `waitForTransactionReceipt` rejects on the first receipt poll that
 * fails in transit once the transport's own retries are spent, and the
 * transaction may be mined a block later. Over a public RPC reached through
 * `anon`, where a circuit can drop a request and a shared exit IP earns a 429,
 * that turns a transaction that landed into an error, and an error invites a
 * retry (connector ADR 0073, decision 5). So this waits again, by hash, until
 * a receipt arrives or the deadline passes. Waiting by hash is always safe: it
 * repeats nothing.
 */
import { TransactionOutcomeError } from '../../client/errors.js';
import {
  WaitForTransactionReceiptTimeoutError,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';

/**
 * The overall deadline for a receipt: 180s, 90 Base blocks, as ADR 0073 gives
 * EVM confirmation. It is also viem's own default for one wait.
 */
export const RECEIPT_TIMEOUT_MS = 180_000;

/** Between a failed wait and the next one, ms. */
const RETRY_DELAY_MS = 1_000;

/** The one method this needs, so a test can hand in any client that has it. */
type ReceiptSource = Pick<PublicClient, 'waitForTransactionReceipt'>;

/**
 * The receipt for `hash`, however many polls fail on the way.
 *
 * @throws {TransactionOutcomeError} `unknown`: no receipt by the deadline. The
 *   transaction was sent and may still be mined.
 */
export async function waitForReceipt(
  client: ReceiptSource,
  hash: Hash,
  options: { timeoutMs?: number; retryDelayMs?: number } = {}
): Promise<TransactionReceipt> {
  const timeoutMs = options.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw pending(hash, timeoutMs, lastError);
    }
    try {
      return await client.waitForTransactionReceipt({
        hash,
        timeout: remaining,
      });
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) {
        throw pending(hash, timeoutMs, lastError);
      }
      lastError = err;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryDelayMs, deadline - Date.now()))
    );
  }
}

/** The deadline passed with no receipt: sent, and may still be mined. */
function pending(
  hash: string,
  timeoutMs: number,
  lastError: unknown
): TransactionOutcomeError {
  return new TransactionOutcomeError(
    `Transaction ${hash} was sent, but no receipt was seen within ${timeoutMs}ms. ` +
      'It may still be mined. Look the hash up before sending anything that ' +
      'would repeat it.' +
      (lastError instanceof Error
        ? ` Last RPC error: ${lastError.message}`
        : ''),
    'evm',
    hash,
    'unknown',
    lastError instanceof Error ? lastError : undefined
  );
}
