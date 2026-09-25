/**
 * Sending and confirming a Solana transaction over an RPC that is sometimes slow,
 * sometimes rate-limited, and sometimes loses an answer in transit, which is what
 * a public RPC reached through `anon` is (connector ADR 0073, decision 5).
 *
 * The rule under test: a transaction that may have landed is never reported as a
 * bare error. The outcome is reported by signature: confirmed, failed on chain,
 * expired (it can no longer land), or unknown. A poll that failed in transit says
 * nothing about the transaction, so it never ends the wait.
 *
 * The RPC here is a scripted `fetch`, handed in through the RPC target the same
 * way a proxied `fetch` is. Nothing is mocked globally and nothing dials.
 */
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode, base58Encode } from '../../utils/base58.js';
import {
  SolanaRpcError,
  buildAndSendTransaction,
  solanaRpc,
  type RawInstruction,
  type Signer,
} from './payment-channel.js';
import { TransactionOutcomeError } from '../../client/errors.js';

const SEED = new Uint8Array(32).fill(7);
const PAYER: Signer = {
  publicKey: ed25519.getPublicKey(SEED),
  privateKey: SEED,
};
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(3));
const MEMO: RawInstruction = {
  programId: base58Encode(new Uint8Array(32).fill(4)),
  keys: [],
  data: new Uint8Array([1, 2, 3]),
};

type Answer =
  | { result: unknown }
  | { error: { code: number; message: string } }
  | { status: number; headers?: Record<string, string> }
  | { throws: Error };

/** A node that answers each method from a script, one entry per call, the last repeating. */
function scriptedRpc(script: Record<string, Answer[]>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
      id: number;
    };
    calls.push({ method: body.method, params: body.params });
    const n = seen.get(body.method) ?? 0;
    seen.set(body.method, n + 1);
    const answers = script[body.method] ?? [{ result: null }];
    const answer = answers[Math.min(n, answers.length - 1)] ?? { result: null };
    if ('throws' in answer) throw answer.throws;
    if ('status' in answer) {
      return new Response('<html>rate limited</html>', {
        status: answer.status,
        ...(answer.headers ? { headers: answer.headers } : {}),
      });
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  }) as typeof fetch;
  return {
    target: { url: 'http://rpc.test', fetchImpl },
    calls,
    count: (method: string) =>
      calls.filter((call) => call.method === method).length,
  };
}

const lost = (): Answer => ({ throws: new TypeError('fetch failed') });
const blockhash: Answer = {
  result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } },
};
const confirmed: Answer = {
  result: {
    value: [
      { slot: 1, confirmations: 0, err: null, confirmationStatus: 'confirmed' },
    ],
  },
};
const notYet: Answer = { result: { value: [null] } };
const FAST = { pollIntervalMs: 5 };

describe('solanaRpc in transit', () => {
  it('retries a rate-limited answer and returns the next one', async () => {
    const rpc = scriptedRpc({ getSlot: [{ status: 429 }, { result: 42 }] });
    await expect(solanaRpc(rpc.target, 'getSlot')).resolves.toBe(42);
    expect(rpc.count('getSlot')).toBe(2);
  });

  it('retries a 403, which a shared exit IP earns too', async () => {
    const rpc = scriptedRpc({ getSlot: [{ status: 403 }, { result: 42 }] });
    await expect(solanaRpc(rpc.target, 'getSlot')).resolves.toBe(42);
  });

  it('retries a request whose answer was lost', async () => {
    const rpc = scriptedRpc({ getSlot: [lost(), lost(), { result: 42 }] });
    await expect(solanaRpc(rpc.target, 'getSlot')).resolves.toBe(42);
    expect(rpc.count('getSlot')).toBe(3);
  });

  it('gives up after a bounded number of tries, naming the method', async () => {
    const rpc = scriptedRpc({ getSlot: [lost()] });
    await expect(solanaRpc(rpc.target, 'getSlot')).rejects.toThrow(
      /getSlot.*fetch failed/
    );
    expect(rpc.count('getSlot')).toBe(4);
  });

  it('never retries an answer: the node said no', async () => {
    const rpc = scriptedRpc({
      getSlot: [{ error: { code: -32601, message: 'Method not found' } }],
    });
    await expect(solanaRpc(rpc.target, 'getSlot')).rejects.toBeInstanceOf(
      SolanaRpcError
    );
    expect(rpc.count('getSlot')).toBe(1);
  });
});

describe('buildAndSendTransaction: the outcome is reported by signature', () => {
  it('confirms a transaction whose status poll failed in transit', async () => {
    // Four lost answers in a row outlast solanaRpc's own retries, so it is the
    // confirmation loop itself that has to survive the failed poll.
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [{ result: 'sig-from-node' }],
      getSignatureStatuses: [lost(), lost(), lost(), lost(), confirmed],
      getBlockHeight: [{ result: 50 }],
    });
    await expect(
      buildAndSendTransaction(rpc.target, PAYER, [MEMO], [], FAST)
    ).resolves.toBe('sig-from-node');
    expect(rpc.count('getSignatureStatuses')).toBe(5);
  });

  it('looks a transaction up by its own signature when the send’s answer is lost', async () => {
    // The node may have accepted it. Reporting an error here would invite a
    // retry, and on Solana a retried deposit deposits twice.
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [lost()],
      getSignatureStatuses: [confirmed],
    });
    const signature = await buildAndSendTransaction(
      rpc.target,
      PAYER,
      [MEMO],
      [],
      FAST
    );

    expect(base58Decode(signature)).toHaveLength(64);
    const asked = rpc.calls.find(
      (call) => call.method === 'getSignatureStatuses'
    );
    expect(asked?.params[0]).toEqual([signature]);
  });

  it('treats "already processed" as sent, not as a failure', async () => {
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [
        {
          error: {
            code: -32002,
            message:
              'Transaction simulation failed: This transaction has already been processed',
          },
        },
      ],
      getSignatureStatuses: [confirmed],
    });
    await expect(
      buildAndSendTransaction(rpc.target, PAYER, [MEMO], [], FAST)
    ).resolves.toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('still reports a transaction the node refused outright, without waiting', async () => {
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [
        {
          error: {
            code: -32002,
            message:
              'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1',
          },
        },
      ],
    });
    await expect(
      buildAndSendTransaction(rpc.target, PAYER, [MEMO], [], FAST)
    ).rejects.toBeInstanceOf(SolanaRpcError);
    expect(rpc.count('getSignatureStatuses')).toBe(0);
  });

  it('reports a transaction that can no longer land as expired', async () => {
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [{ result: 'sig-from-node' }],
      getSignatureStatuses: [notYet],
      getBlockHeight: [{ result: 99 }, { result: 101 }],
    });
    const error = await buildAndSendTransaction(
      rpc.target,
      PAYER,
      [MEMO],
      [],
      FAST
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionOutcomeError);
    expect(error).toMatchObject({
      outcome: 'expired',
      txHash: 'sig-from-node',
      chain: 'solana',
    });
    expect(String(error)).toMatch(/cannot land/);
  });

  it('reports a transaction that landed and failed as failed', async () => {
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [{ result: 'sig-from-node' }],
      getSignatureStatuses: [
        {
          result: {
            value: [
              {
                slot: 1,
                err: { InstructionError: [0, 'Custom'] },
                confirmationStatus: 'confirmed',
              },
            ],
          },
        },
      ],
    });
    const error = await buildAndSendTransaction(
      rpc.target,
      PAYER,
      [MEMO],
      [],
      FAST
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      outcome: 'failed',
      txHash: 'sig-from-node',
      chain: 'solana',
    });
  });

  it('reports "unknown", with the signature, when the RPC never answers again', async () => {
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [{ result: 'sig-from-node' }],
      getSignatureStatuses: [lost()],
      getBlockHeight: [lost()],
    });
    const error = await buildAndSendTransaction(rpc.target, PAYER, [MEMO], [], {
      ...FAST,
      timeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      outcome: 'unknown',
      txHash: 'sig-from-node',
      chain: 'solana',
    });
  }, 20_000);

  it('fails at once when the send never left: nothing can have landed', async () => {
    // A proxy that refuses the connection received no transaction. Waiting out
    // a blockhash for it would only delay a failure that is already certain.
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9050'), {
        code: 'ECONNREFUSED',
      }),
    });
    const rpc = scriptedRpc({
      getLatestBlockhash: [blockhash],
      sendTransaction: [{ throws: refused }],
    });
    await expect(
      buildAndSendTransaction(rpc.target, PAYER, [MEMO], [], FAST)
    ).rejects.toThrow(/sendTransaction/);
    expect(rpc.count('getSignatureStatuses')).toBe(0);
  });
});
