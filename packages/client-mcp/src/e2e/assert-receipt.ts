import {
  createPublicClient,
  http,
  decodeEventLog,
  parseAbiItem,
  type PublicClient,
} from 'viem';

// ── EVM (USDC / ERC-20) ─────────────────────────────────────────────────────

export interface EvmUsdcSettleOpts {
  txHash: `0x${string}`;
  usdcAddress: `0x${string}`;
  recipient: `0x${string}`;
  expectedAmount: bigint;
  /** Provide a client OR an rpcUrl (rpcUrl builds one via createPublicClient+http). */
  client?: PublicClient;
  rpcUrl?: string;
}

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);

export async function assertEvmUsdcSettle(opts: EvmUsdcSettleOpts): Promise<void> {
  const { txHash, usdcAddress, recipient, expectedAmount, rpcUrl } = opts;
  const client: PublicClient =
    opts.client ?? createPublicClient({ transport: http(rpcUrl) });

  const receipt = await client.getTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    throw new Error(
      `assertEvmUsdcSettle: tx ${txHash} status is "${receipt.status}", expected "success"`
    );
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdcAddress.toLowerCase()) continue;
    let decoded: { to: `0x${string}`; value: bigint } | null = null;
    try {
      const result = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
      const args = result.args as Record<string, unknown>;
      decoded = { to: args['to'] as `0x${string}`, value: args['value'] as bigint };
    } catch {
      continue;
    }
    if (!decoded || decoded.to.toLowerCase() !== recipient.toLowerCase()) continue;
    if (decoded.value !== expectedAmount) continue;
    return;
  }

  throw new Error(
    `assertEvmUsdcSettle: no Transfer log to recipient ${recipient} found in tx ${txHash}`
  );
}

// ── Solana (SPL token) ───────────────────────────────────────────────────────

/** Minimal structural interface satisfied by @solana/web3.js Connection. */
interface SolanaConnection {
  getTransaction(
    signature: string,
    config: { maxSupportedTransactionVersion: number }
  ): Promise<SolanaTx | null>;
}

interface SolanaTx {
  meta: {
    err: unknown;
    preTokenBalances?: Array<SolanaTokenBalance> | null;
    postTokenBalances?: Array<SolanaTokenBalance> | null;
  } | null;
}

interface SolanaTokenBalance {
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface SolanaReceiptOpts {
  signature: string;
  recipient: string;
  expectedAmount: bigint;
  connection?: SolanaConnection;
  rpcUrl?: string;
}

export async function assertSolanaReceipt(opts: SolanaReceiptOpts): Promise<void> {
  const { signature, recipient, expectedAmount, rpcUrl } = opts;

  let connection: SolanaConnection;
  if (opts.connection) {
    connection = opts.connection;
  } else {
    // Lazy import — @solana/web3.js is an optionalDependency
    if (!rpcUrl) throw new Error('assertSolanaReceipt: rpcUrl is required when connection is not provided');
    const { Connection } = (await import('@solana/web3.js')) as {
      Connection: new (url: string, commitment: string) => SolanaConnection;
    };
    connection = new Connection(rpcUrl, 'confirmed');
  }

  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });

  if (!tx) {
    throw new Error(`assertSolanaReceipt: transaction ${signature} not found`);
  }
  if (!tx.meta) {
    throw new Error(`assertSolanaReceipt: transaction ${signature} has no metadata`);
  }
  if (tx.meta.err != null) {
    throw new Error(
      `assertSolanaReceipt: transaction ${signature} failed: ${JSON.stringify(tx.meta.err)}`
    );
  }

  const pre = (tx.meta.preTokenBalances ?? []).find((b) => b.owner === recipient);
  const post = (tx.meta.postTokenBalances ?? []).find((b) => b.owner === recipient);

  const preAmount = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
  const postAmount = post ? BigInt(post.uiTokenAmount.amount) : 0n;
  const delta = postAmount - preAmount;

  if (delta !== expectedAmount) {
    throw new Error(
      `assertSolanaReceipt: SPL token delta for ${recipient} in tx ${signature}: expected ${expectedAmount}, got ${delta}`
    );
  }
}

// ── Mina (zkApp / GraphQL) ───────────────────────────────────────────────────

export interface MinaReceiptOpts {
  txHash: string;
  /** The settlement zkApp's base58 public key — passed for future live assertions. */
  zkAppAddress: string;
  recipient: string;
  expectedAmount: bigint;
  /** Mina GraphQL/archive endpoint. */
  rpcUrl?: string;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

// GraphQL query used to verify a Mina settlement receipt:
//   transactionStatus — must be "APPLIED"
//   payment.amount — must equal expectedAmount (nanomina / custom token units)
//   payment.receiver.publicKey — must equal recipient
const MINA_VERIFY_QUERY = `
  query VerifySettlement($txHash: String!) {
    transactionStatus(payment: $txHash)
    payment(paymentId: $txHash) {
      amount
      receiver { publicKey }
    }
  }
`;

export async function assertMinaReceipt(opts: MinaReceiptOpts): Promise<void> {
  const { txHash, recipient, expectedAmount, rpcUrl } = opts;
  const ff = opts.fetchFn ?? fetch;

  if (!rpcUrl && !opts.fetchFn) {
    throw new Error('assertMinaReceipt: rpcUrl is required when fetchFn is not provided');
  }

  const url = rpcUrl ?? '';
  const resp = await ff(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: MINA_VERIFY_QUERY,
      variables: { txHash },
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `assertMinaReceipt: GraphQL request to ${url} failed with HTTP ${resp.status}`
    );
  }

  const json = (await resp.json()) as {
    data?: {
      transactionStatus?: string;
      payment?: { amount?: string; receiver?: { publicKey?: string } };
    };
    errors?: Array<{ message: string }>;
  };

  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `assertMinaReceipt: GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`
    );
  }

  const status = json.data?.transactionStatus;
  if (status !== 'APPLIED') {
    throw new Error(
      `assertMinaReceipt: transaction ${txHash} is not APPLIED (got "${status ?? 'null'}")`
    );
  }

  const payment = json.data?.payment;
  if (!payment) {
    throw new Error(`assertMinaReceipt: payment ${txHash} not found`);
  }

  const actualReceiver = payment.receiver?.publicKey;
  if (actualReceiver !== recipient) {
    throw new Error(
      `assertMinaReceipt: payment ${txHash} recipient mismatch: expected ${recipient}, got ${actualReceiver ?? 'null'}`
    );
  }

  const amountStr = payment.amount;
  if (amountStr == null) {
    throw new Error(`assertMinaReceipt: payment ${txHash} has no amount`);
  }

  const actual = BigInt(amountStr);
  if (actual !== expectedAmount) {
    throw new Error(
      `assertMinaReceipt: payment ${txHash} amount mismatch: expected ${expectedAmount}, got ${actual}`
    );
  }
}
