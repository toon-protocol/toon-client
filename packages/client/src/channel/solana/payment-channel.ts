/**
 * Solana over raw JSON-RPC: the program-derived-address search, associated
 * token accounts, a legacy transaction compiler and sender, and the reads a
 * payer needs — balances, blockhashes, confirmation.
 *
 * Everything here is chain plumbing shared by the x402 `batch-settlement`
 * code (`../batch-settlement/`), the wallet's transfers and the ArNS jobs, and
 * none of it knows about any channel program. TOON's own `payment-channel`
 * program — which this module was named for — left with connector ADR 0075;
 * the channel program is solana-foundation's `payment-channels`, driven from
 * `../batch-settlement/svm.ts`. No `@solana/web3.js` / `@solana/kit` runtime
 * dependency: only `@noble/curves` and `@noble/hashes`.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode, base58Decode } from '../../utils/base58.js';
import {
  NetworkError,
  TransactionOutcomeError,
} from '../../client/errors.js';
import { RECEIPT_TIMEOUT_MS } from '../evm/receipt.js';

// ---------------------------------------------------------------------------
// Constants (must match the Rust program + connector SDK exactly)
// ---------------------------------------------------------------------------

/** Well-known Solana program addresses (base58). */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** On-chain channel-account discriminator: ASCII "pchannel". */

/** Left-pad / trim a byte array to exactly 32 bytes. */
export function padTo32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) return bytes.slice(bytes.length - 32);
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return padded;
}

/** Sort two 32-byte pubkeys lexicographically by raw bytes (matches Rust). */

// ---------------------------------------------------------------------------
// Ed25519 curve check + PDA derivation (matches Solana find_program_address)
// ---------------------------------------------------------------------------

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a: bigint, m: bigint): bigint {
  return modPow(((a % m) + m) % m, m - 2n, m);
}

/** True if 32 bytes lie on the Ed25519 curve. A valid PDA must NOT be on-curve. */
function isOnCurve(bytes: Uint8Array): boolean {
  const P = (1n << 255n) - 19n;
  const yBytes = new Uint8Array(32);
  yBytes.set(bytes);
  yBytes[31] = (yBytes[31] ?? 0) & 0x7f;

  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(yBytes[i] ?? 0) << BigInt(i * 8);
  }
  if (y >= P) return true;

  const y2 = (y * y) % P;
  const D = (P - ((121665n * modInverse(121666n, P)) % P) + P) % P;
  const numerator = (y2 - 1n + P) % P;
  const denominator = (D * y2 + 1n) % P;
  const x2 = (numerator * modInverse(denominator, P)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): { pda: Uint8Array; bump: number } {
  const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const allSeeds = [...seeds, new Uint8Array([bump])];
    let totalLen = programId.length + PDA_MARKER.length;
    for (const s of allSeeds) totalLen += s.length;

    const input = new Uint8Array(totalLen);
    let offset = 0;
    for (const s of allSeeds) {
      input.set(s, offset);
      offset += s.length;
    }
    input.set(programId, offset);
    offset += programId.length;
    input.set(PDA_MARKER, offset);

    const hash = sha256(input);
    if (!isOnCurve(hash)) return { pda: hash, bump };
  }
  throw new Error('Could not find a viable PDA bump seed');
}

/**
 * Derive the Associated Token Account (ATA) for an owner + SPL mint — the
 * standard SPL ATA PDA over seeds `[owner, TOKEN_PROGRAM_ID, mint]` under the
 * Associated-Token-Account program. Deterministic from `(owner, mint)`, so
 * callers (e.g. a Solana channel deposit) need not supply the funded token
 * account explicitly — it is always the owner's ATA for the channel's mint.
 *
 * @param owner - base58 wallet pubkey that owns the token account.
 * @param tokenMint - base58 SPL mint.
 * @returns base58 ATA address.
 */
export function deriveAssociatedTokenAccount(
  owner: string,
  tokenMint: string
): string {
  // Canonical mainnet/devnet SPL program ids (same on every cluster).
  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const ASSOCIATED_TOKEN_PROGRAM_ID =
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const seeds = [
    padTo32(base58Decode(owner)),
    padTo32(base58Decode(TOKEN_PROGRAM_ID)),
    padTo32(base58Decode(tokenMint)),
  ];
  const { pda } = findProgramAddress(
    seeds,
    padTo32(base58Decode(ASSOCIATED_TOKEN_PROGRAM_ID))
  );
  return base58Encode(pda);
}

// ---------------------------------------------------------------------------
// Balance-proof message + signing (connector-parity)
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// On-chain channel open (initialize_channel + deposit) over raw JSON-RPC
// ---------------------------------------------------------------------------

/** One account meta of an instruction, in the order the program reads them. */
export interface InstructionKey {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * An unsigned Solana instruction. Exported because
 * {@link buildClaimFromChannelInstructions} returns a PAIR that must be
 * submitted in one transaction, in order — so the builder cannot also be the
 * sender.
 */
export interface RawInstruction {
  programId: string;
  keys: InstructionKey[];
  data: Uint8Array;
}

export interface Signer {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

let rpcIdCounter = 1;

/**
 * A JSON-RPC-level error — the node answered, and said no. Distinct from a
 * TRANSPORT fault (DNS, timeout, 429, 5xx, malformed body), which surfaces as
 * whatever `fetch`/`json()` threw. Callers must not conflate the two: "the node
 * says this account does not exist" is a fact about the chain, while "the node
 * did not answer" is a fact about the network, and treating the latter as the
 * former turns a transient blip into a false accusation that the user's wallet
 * is unfunded.
 */
export class SolanaRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly rpcMessage: string
  ) {
    super(`Solana RPC error [${method}]: ${rpcMessage} (code ${code})`);
    this.name = 'SolanaRpcError';
  }
}

/**
 * True when `err` is the node reporting that the queried account does not
 * exist. Solana answers `getTokenAccountBalance` for an absent account with a
 * JSON-RPC error (`-32602 Invalid param: could not find account`) rather than a
 * zero balance, so absence is only ever observable as an error — which is
 * exactly why it must be told apart from transport faults by CONTENT, not by
 * "something threw".
 */
function isAccountNotFoundError(err: unknown): boolean {
  if (!(err instanceof SolanaRpcError)) return false;
  return /could not find account|account not found|account does not exist/i.test(
    err.rpcMessage
  );
}

/**
 * Raw Solana JSON-RPC call.
 *
 * Exported (with {@link getLatestBlockhash} and {@link waitForConfirmation}) for
 * `../swap/solana-settlement.js`, which submits a settlement Message the SDK has
 * ALREADY compiled and so cannot go through {@link buildAndSendTransaction} —
 * that builds its own message from instructions. Sharing the transport keeps one
 * definition of "the node answered and said no" (see {@link SolanaRpcError})
 * across the channel and settlement paths.
 */
/**
 * Where Solana JSON-RPC goes, and how it gets there.
 *
 * A bare URL is the ordinary case and dials the global `fetch`. The object form
 * carries a `fetch` to use instead — on a hidden-service client that is the
 * proxied one, so chain reads ride the overlay with the packets rather than
 * announcing this wallet on clearnet (ADR 0002). Every function in this module
 * that takes an RPC target passes it straight through to {@link solanaRpc}; only
 * that function ever looks inside.
 */
export type SolanaRpcTarget = string | { url: string; fetchImpl?: typeof fetch };

/** Split a target into the URL to dial and the `fetch` to dial it with. */
function resolveRpcTarget(target: SolanaRpcTarget): { url: string; fetchImpl: typeof fetch } {
  if (typeof target === 'string') return { url: target, fetchImpl: globalThis.fetch };
  return { url: target.url, fetchImpl: target.fetchImpl ?? globalThis.fetch };
}

/**
 * Delays before each retry of a Solana JSON-RPC call that failed in transit.
 *
 * Three retries, as viem does for EVM. The ADR 0073 hardening asks for this on
 * both chains: exit IPs are shared, so a public RPC reached through `anon` will
 * eventually answer 429 or 403, and a circuit can drop a request. Resending is
 * safe for every call this module makes. Reads are reads, and a resent
 * `sendTransaction` carries the same signed bytes, which the cluster
 * deduplicates by signature.
 */
const SOLANA_RPC_RETRY_DELAYS_MS = [250, 500, 1_000] as const;
/** HTTP statuses worth another try: viem's list, the same on both chains. */
const RETRYABLE_HTTP_STATUS = new Set([403, 408, 413, 429, 500, 502, 503, 504]);
/** A `Retry-After` longer than this is not waited on; the call fails instead. */
const MAX_RETRY_AFTER_MS = 10_000;
/** Per-request timeout, as the connector's Solana client has it (ADR 0073, decision 4). */
const SOLANA_RPC_TIMEOUT_MS = 30_000;

/**
 * A Solana JSON-RPC call that got no answer from the node: every try was lost in
 * transit, timed out, or was turned away at the HTTP layer.
 *
 * `mayHaveArrived` is `false` only when every try failed before a byte of the
 * request could have been written, because the connection or the proxy refused
 * it. That is the one case in which a failed `sendTransaction` is known not to
 * have been sent.
 */
export class SolanaRpcTransportError extends NetworkError {
  constructor(
    readonly method: string,
    readonly attempts: number,
    readonly mayHaveArrived: boolean,
    cause: unknown
  ) {
    super(
      `Solana RPC [${method}] got no answer after ${attempts} tries: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      cause instanceof Error ? cause : undefined
    );
    this.name = 'SolanaRpcTransportError';
  }
}

/** An HTTP answer that is not a JSON-RPC one: a 429 page, a 5xx, a gateway's 403. */
class SolanaRpcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined
  ) {
    super(`HTTP ${status}`);
    this.name = 'SolanaRpcHttpError';
  }
}

/**
 * One JSON-RPC call, retried when it fails in transit.
 *
 * @throws {SolanaRpcError} the node answered and said no. Never retried.
 * @throws {SolanaRpcTransportError} no answer came back, after every retry.
 */
export async function solanaRpc(
  rpcUrl: SolanaRpcTarget,
  method: string,
  params: unknown[] = []
): Promise<unknown> {
  const { url, fetchImpl } = resolveRpcTarget(rpcUrl);
  let mayHaveArrived = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await solanaRpcOnce(url, fetchImpl, method, params);
    } catch (err) {
      if (err instanceof SolanaRpcError) throw err;
      mayHaveArrived ||= !failedBeforeSending(err);
      const retryable =
        !(err instanceof SolanaRpcHttpError) || RETRYABLE_HTTP_STATUS.has(err.status);
      const delay =
        err instanceof SolanaRpcHttpError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : SOLANA_RPC_RETRY_DELAYS_MS[attempt];
      if (
        !retryable ||
        attempt >= SOLANA_RPC_RETRY_DELAYS_MS.length ||
        delay === undefined ||
        delay > MAX_RETRY_AFTER_MS
      ) {
        throw new SolanaRpcTransportError(method, attempt + 1, mayHaveArrived, err);
      }
      await sleep(delay);
    }
  }
}

/** One try: the node's answer, a {@link SolanaRpcError}, or whatever the transport threw. */
async function solanaRpcOnce(
  url: string,
  fetchImpl: typeof fetch,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: rpcIdCounter++,
    }),
    signal: AbortSignal.timeout(SOLANA_RPC_TIMEOUT_MS),
  });
  if (res.ok === false) {
    throw new SolanaRpcHttpError(res.status, retryAfterMs(res.headers?.get('retry-after')));
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message: string; code: number };
  };
  if (json.error) {
    throw new SolanaRpcError(method, json.error.code, json.error.message);
  }
  return json.result;
}

/** `Retry-After` in whole seconds, as ms. The date form is not worth parsing here. */
function retryAfterMs(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined || !/^\d+$/.test(header.trim())) return undefined;
  return Number.parseInt(header.trim(), 10) * 1000;
}

/**
 * Connection-phase failures: nothing was written, so nothing can have arrived.
 * A SOCKS error always is one, because the proxy answers before any request
 * byte is sent. Anything else (a timeout, a reset, a lost answer) may have come
 * after the request went out.
 */
function failedBeforeSending(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (e.name === 'SocksClientError') return true;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
    if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
    e = e.cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Latest blockhash, base58 — what `patchSolanaRecentBlockhash` accepts as-is. */
export async function getLatestBlockhash(rpcUrl: SolanaRpcTarget): Promise<string> {
  return (await getLatestBlockhashWithExpiry(rpcUrl)).blockhash;
}

/**
 * The latest blockhash, and the last block height at which a transaction built
 * on it can still land. After that height, it never will.
 */
async function getLatestBlockhashWithExpiry(
  rpcUrl: SolanaRpcTarget
): Promise<{ blockhash: string; lastValidBlockHeight: number | undefined }> {
  const result = (await solanaRpc(rpcUrl, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])) as { value: { blockhash: string; lastValidBlockHeight?: number } };
  return {
    blockhash: result.value.blockhash,
    lastValidBlockHeight: result.value.lastValidBlockHeight,
  };
}


/**
 * Balance (base units) of an SPL token account, or `null` when the node reports
 * that the account does not exist (an owner who has never held the mint has no
 * ATA).
 *
 * ONLY that one answer becomes `null`. A transport fault — timeout, 429, 5xx,
 * DNS — propagates, because "the RPC is unreachable" is not evidence about the
 * user's balance, and swallowing it here would turn a transient blip into a
 * hard `ChannelFundingError` telling the user to fund an already-funded wallet.
 */
export async function getTokenAccountBalance(
  rpcUrl: SolanaRpcTarget,
  tokenAccount: string
): Promise<bigint | null> {
  try {
    const result = (await solanaRpc(rpcUrl, 'getTokenAccountBalance', [
      tokenAccount,
      { commitment: 'confirmed' },
    ])) as { value?: { amount?: string } } | null;
    const amount = result?.value?.amount;
    return amount === undefined ? null : BigInt(amount);
  } catch (err) {
    if (isAccountNotFoundError(err)) return null;
    throw err;
  }
}

/** Native SOL balance (lamports) of an account; 0 for an account that does not exist. */
export async function getLamports(rpcUrl: SolanaRpcTarget, pubkey: string): Promise<bigint> {
  const result = (await solanaRpc(rpcUrl, 'getBalance', [
    pubkey,
    { commitment: 'confirmed' },
  ])) as { value?: number | string } | null;
  return BigInt(result?.value ?? 0);
}

/** How {@link waitForConfirmation} waits. */
export interface ConfirmationOptions {
  /**
   * The blockhash's `lastValidBlockHeight`. With it, the wait ends when the
   * chain says the transaction can no longer land. Without it, only the clock
   * ends the wait.
   */
  lastValidBlockHeight?: number;
  /**
   * The wall-clock bound, ms, after which the outcome is `unknown`. Default
   * {@link CONFIRM_TIMEOUT_MS} with a `lastValidBlockHeight`, which the chain
   * normally ends well before; 30s without one.
   */
  timeoutMs?: number;
  /** Between polls, ms. Default 500. */
  pollIntervalMs?: number;
}

/**
 * The wall-clock bound on a confirmation that knows its blockhash's expiry.
 * A blockhash lives ~150 slots (60–90s), so the chain decides first unless the
 * RPC stops answering. 180s is the deadline ADR 0073 gives EVM confirmation.
 */
export const CONFIRM_TIMEOUT_MS = RECEIPT_TIMEOUT_MS;

/**
 * Poll until the transaction is `confirmed`/`finalized`, and report any other
 * ending as a {@link TransactionOutcomeError} naming the signature.
 *
 * A poll that fails in transit is not an outcome. It says nothing about the
 * transaction, so the loop keeps polling. Only the chain (confirmed, failed,
 * or past `lastValidBlockHeight`) or the wall clock ends it.
 */
export async function waitForConfirmation(
  rpcUrl: SolanaRpcTarget,
  signature: string,
  options: ConfirmationOptions = {}
): Promise<void> {
  const { lastValidBlockHeight, pollIntervalMs = 500 } = options;
  const timeoutMs =
    options.timeoutMs ?? (lastValidBlockHeight !== undefined ? CONFIRM_TIMEOUT_MS : 30_000);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let failedPolls = 0;

  for (;;) {
    try {
      if (await isConfirmed(rpcUrl, signature)) return;
      if (lastValidBlockHeight !== undefined) {
        const height = Number(
          await solanaRpc(rpcUrl, 'getBlockHeight', [{ commitment: 'confirmed' }])
        );
        // One last look once expiry is seen: it may have landed in the very
        // block that ended its blockhash's life.
        if (height > lastValidBlockHeight && !(await isConfirmed(rpcUrl, signature))) {
          throw new TransactionOutcomeError(
            `Transaction ${signature} expired: block height ${height} is past its ` +
              `blockhash's last valid height ${lastValidBlockHeight}, and it never ` +
              'appeared, so it cannot land. It is safe to build and send it again.',
            'solana',
            signature,
            'expired'
          );
        }
      }
    } catch (err) {
      if (err instanceof TransactionOutcomeError) throw err;
      lastError = err;
      failedPolls += 1;
    }
    if (Date.now() >= deadline) {
      throw new TransactionOutcomeError(
        `Transaction ${signature} was not seen confirmed within ${timeoutMs}ms, and ` +
          'the RPC could not say whether it can still land. Look the signature up ' +
          'before sending anything that would repeat it.' +
          (lastError instanceof Error ? ` Last RPC error: ${lastError.message}` : ''),
        'solana',
        signature,
        'unknown',
        lastError instanceof Error ? lastError : undefined
      );
    }
    // Back off while polls keep failing (to 8x, 4s at the default), so a
    // rate-limited RPC is not hammered; a poll that answers resets nothing
    // because the loop only continues while the answer is "not yet".
    await sleep(pollIntervalMs * 2 ** Math.min(failedPolls, 3));
  }
}

/**
 * Whether `signature` is `confirmed`/`finalized`. Throws a `failed`
 * {@link TransactionOutcomeError} when it landed with an execution error: a
 * settled-but-failed transaction is not a success.
 */
async function isConfirmed(rpcUrl: SolanaRpcTarget, signature: string): Promise<boolean> {
  const result = (await solanaRpc(rpcUrl, 'getSignatureStatuses', [[signature]])) as {
    value: ({ confirmationStatus: string; err?: unknown } | null)[];
  };
  const status = result.value[0];
  if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') {
    return false;
  }
  if (status.err) {
    throw new TransactionOutcomeError(
      `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
      'solana',
      signature,
      'failed'
    );
  }
  return true;
}

/**
 * Whether a `sendTransaction` RPC error means the transaction is already on
 * chain: a resend of bytes the node took the first time. That happens exactly
 * when a first send's answer was lost and {@link solanaRpc} sent it again.
 */
function isAlreadyProcessed(err: SolanaRpcError): boolean {
  return /already been processed|AlreadyProcessed/i.test(err.rpcMessage);
}

function compactU16Size(value: number): number {
  if (value > 0xffff) {
    throw new RangeError(`compact-u16 value ${value} exceeds u16 max (0xFFFF)`);
  }
  return value < 0x80 ? 1 : value < 0x4000 ? 2 : 3;
}

function writeCompactU16(
  buf: Uint8Array,
  offset: number,
  value: number
): number {
  if (value < 0x80) {
    buf[offset++] = value;
  } else if (value < 0x4000) {
    buf[offset++] = (value & 0x7f) | 0x80;
    buf[offset++] = value >> 7;
  } else {
    buf[offset++] = (value & 0x7f) | 0x80;
    buf[offset++] = ((value >> 7) & 0x7f) | 0x80;
    buf[offset++] = value >> 14;
  }
  return offset;
}

interface AccountEntry {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * A compiled legacy message, and the signature slots it requires.
 *
 * `signers` is in slot order: slot `i` of a transaction over `message` carries
 * the signature of `signers[i]`, and `signers[0]` is always the fee payer.
 */
export interface CompiledLegacyMessage {
  message: Uint8Array;
  signers: string[];
}

/**
 * Compile a Solana legacy message: the fee payer first, then accounts ordered by
 * role (writable signers, read-only signers, writable, read-only), each account
 * once with the union of the privileges its instructions ask of it.
 *
 * Exported so a transaction whose fee payer is someone else — a sponsor who
 * co-signs later — is compiled by the same code {@link buildAndSendTransaction}
 * is connector-parity-tested on, rather than by a second copy of it.
 */
export function compileLegacyMessage(
  feePayer: string,
  instructions: RawInstruction[],
  recentBlockhash: string
): CompiledLegacyMessage {
  const accountMap = new Map<string, AccountEntry>();
  accountMap.set(feePayer, {
    pubkey: feePayer,
    isSigner: true,
    isWritable: true,
  });
  for (const ix of instructions) {
    for (const key of ix.keys) {
      const existing = accountMap.get(key.pubkey);
      if (existing) {
        existing.isSigner = existing.isSigner || key.isSigner;
        existing.isWritable = existing.isWritable || key.isWritable;
      } else {
        accountMap.set(key.pubkey, { ...key });
      }
    }
    if (!accountMap.has(ix.programId)) {
      accountMap.set(ix.programId, {
        pubkey: ix.programId,
        isSigner: false,
        isWritable: false,
      });
    }
  }

  const accounts = [...accountMap.values()].sort((a, b) => {
    if (a.pubkey === feePayer) return -1;
    if (b.pubkey === feePayer) return 1;
    const aScore = (a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0);
    const bScore = (b.isSigner ? 2 : 0) + (b.isWritable ? 1 : 0);
    return bScore - aScore;
  });

  const numSigners = accounts.filter((a) => a.isSigner).length;
  const numReadonlySigners = accounts.filter(
    (a) => a.isSigner && !a.isWritable
  ).length;
  const numReadonlyNonSigners = accounts.filter(
    (a) => !a.isSigner && !a.isWritable
  ).length;

  const accountIndexMap = new Map<string, number>();
  accounts.forEach((a, i) => accountIndexMap.set(a.pubkey, i));

  const compiled = instructions.map((ix) => ({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- programId added to accountMap above
    programIdIndex: accountIndexMap.get(ix.programId)!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- every key added to accountMap above
    accountIndices: ix.keys.map((k) => accountIndexMap.get(k.pubkey)!),
    data: ix.data,
  }));

  const blockhashBytes = base58Decode(recentBlockhash);

  let instructionSize = compactU16Size(compiled.length);
  for (const ix of compiled) {
    instructionSize += 1;
    instructionSize +=
      compactU16Size(ix.accountIndices.length) + ix.accountIndices.length;
    instructionSize += compactU16Size(ix.data.length) + ix.data.length;
  }

  const messageSize =
    3 +
    compactU16Size(accounts.length) +
    32 * accounts.length +
    32 +
    instructionSize;
  const message = new Uint8Array(messageSize);
  let offset = 0;

  message[offset++] = numSigners;
  message[offset++] = numReadonlySigners;
  message[offset++] = numReadonlyNonSigners;

  offset = writeCompactU16(message, offset, accounts.length);
  for (const acct of accounts) {
    message.set(padTo32(base58Decode(acct.pubkey)), offset);
    offset += 32;
  }

  message.set(padTo32(blockhashBytes), offset);
  offset += 32;

  offset = writeCompactU16(message, offset, compiled.length);
  for (const ix of compiled) {
    message[offset++] = ix.programIdIndex;
    offset = writeCompactU16(message, offset, ix.accountIndices.length);
    for (const idx of ix.accountIndices) message[offset++] = idx;
    offset = writeCompactU16(message, offset, ix.data.length);
    message.set(ix.data, offset);
    offset += ix.data.length;
  }

  return {
    message: message.slice(0, offset),
    signers: accounts.filter((a) => a.isSigner).map((a) => a.pubkey),
  };
}

/**
 * A wire transaction: the signature slots, then the message. A slot with no
 * signature yet is 64 zero bytes — how "not signed" is spelled on the wire.
 */
export function serializeLegacyTransaction(
  compiled: CompiledLegacyMessage,
  signatures: (Uint8Array | undefined)[]
): Uint8Array {
  const { message, signers } = compiled;
  const txSize =
    compactU16Size(signers.length) + signers.length * 64 + message.length;
  const tx = new Uint8Array(txSize);
  let txOffset = writeCompactU16(tx, 0, signers.length);
  for (let i = 0; i < signers.length; i++) {
    const sig = signatures[i];
    if (sig) tx.set(sig, txOffset);
    txOffset += 64;
  }
  tx.set(message, txOffset);
  return tx;
}

/**
 * Build, sign, and send a Solana legacy transaction over raw JSON-RPC, then wait
 * for confirmation. Mirrors the SDK reference E2E's `buildAndSendTransaction`.
 *
 * Exported (along with {@link getLamports} and {@link getTokenAccountBalance})
 * so `../transfer.js` can build plain System/SPL-Token instructions on the
 * SAME wire-format code this module already gets connector-parity-tested
 * against, rather than re-deriving Solana's compact transaction encoding a
 * second time.
 */
export async function buildAndSendTransaction(
  rpcUrl: SolanaRpcTarget,
  feePayer: Signer,
  instructions: RawInstruction[],
  additionalSigners: Signer[] = [],
  confirmation: Omit<ConfirmationOptions, 'lastValidBlockHeight'> = {}
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await getLatestBlockhashWithExpiry(rpcUrl);
  const compiled = compileLegacyMessage(
    base58Encode(feePayer.publicKey),
    instructions,
    blockhash
  );

  const allSigners = [feePayer, ...additionalSigners];
  const signatures = compiled.signers.map((signerPubkey) => {
    const signer = allSigners.find(
      (s) => base58Encode(s.publicKey) === signerPubkey
    );
    if (!signer) throw new Error(`Missing signer for ${signerPubkey}`);
    return ed25519.sign(compiled.message, signer.privateKey);
  });
  const tx = serializeLegacyTransaction(compiled, signatures);

  const txBase64 = Buffer.from(tx).toString('base64');
  let txSig: string;
  try {
    txSig = (await solanaRpc(rpcUrl, 'sendTransaction', [
      txBase64,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    ])) as string;
  } catch (err) {
    // An RPC error is the node's answer, and a send that never left was never sent. But a
    // send whose answer was lost, or a resend the node says it already has, may
    // be on chain: it is looked up by the signature it carries rather than
    // reported as a failure (ADR 0073, decision 5). The first signature on the
    // wire, the fee payer's, IS the transaction id.
    const alreadyOnChain = err instanceof SolanaRpcError && isAlreadyProcessed(err);
    const answerLost = err instanceof SolanaRpcTransportError && err.mayHaveArrived;
    if (!alreadyOnChain && !answerLost) throw err;
    const firstSignature = compactU16Size(signatures.length);
    txSig = base58Encode(tx.subarray(firstSignature, firstSignature + 64));
  }
  await waitForConfirmation(rpcUrl, txSig, {
    ...confirmation,
    ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
  });
  return txSig;
}

export const __testing = {
  padTo32,
  isOnCurve,
  TOKEN_PROGRAM_ID,
};
