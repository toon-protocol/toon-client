/**
 * Solana payment-channel primitives — connector-parity.
 *
 * Pure, dependency-light helpers that reproduce the EXACT on-chain contract the
 * connector's `SolanaPaymentChannelSDK` (`@toon-protocol/connector`
 * `settlement/solana-payment-channel-sdk.ts`) implements, so a client-issued
 * Solana payment-channel claim is accepted by connector 3.9.0's
 * `verifySolanaClaim` path:
 *
 *   1. PDA derivation — `[b"channel", min_pubkey, max_pubkey, token_mint]` sorted
 *      lexicographically by raw 32-byte pubkey, derived against the program id.
 *      This base58 PDA is the claim's `channelAccount` and the channel-state
 *      account the connector reads via `provider.getChannelState`.
 *   2. The 48-byte balance-proof message the connector verifies the Ed25519
 *      signature over: `channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)`.
 *      NOTE: this is NOT the swap-claim `balanceProofHashSolana` shape used by the
 *      swap peer ↔ sender wire / SDK `verifyEd25519Signature`; the connector's on-chain
 *      payment-channel verifier (`solana-payment-channel-provider.verifyBalanceProof`)
 *      verifies this raw 48-byte message, un-hashed.
 *   3. The `initialize_channel` (+ `deposit`) instructions, built and submitted
 *      over raw Solana JSON-RPC (no `@solana/web3.js` / `@solana/kit` runtime
 *      dependency — only `@noble/curves` + `@noble/hashes`, already client deps).
 *
 * Every byte layout / discriminator / account-meta order here is mirrored from
 * the connector SDK and the SDK reference E2E
 * (`packages/sdk/tests/e2e/docker-solana-settlement-e2e.test.ts`). Keep them in
 * lock-step; a mismatch makes the connector reject the claim (ON_CHAIN_VERIFICATION_FAILED
 * or INVALID_SIGNATURE).
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode, base58Decode } from '@toon-protocol/core';
import { ChannelFundingError } from '../errors.js';

// ---------------------------------------------------------------------------
// Constants (must match the Rust program + connector SDK exactly)
// ---------------------------------------------------------------------------

/** Well-known Solana program addresses (base58). */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';

/** Instruction discriminators — first byte of an 8-byte LE tag. */
const IX_INITIALIZE_CHANNEL = new Uint8Array([0x01, 0, 0, 0, 0, 0, 0, 0]);
const IX_DEPOSIT = new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0]);

/** On-chain channel-account discriminator: ASCII "pchannel". */
const CHANNEL_DISCRIMINATOR = new Uint8Array([
  0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c,
]);

/** Channel-state account size in bytes. */
const CHANNEL_ACCOUNT_SIZE = 178;

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const MAX_U64 = (1n << 64n) - 1n;

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
  if (value < 0n || value > MAX_U64) {
    throw new RangeError(`Value ${value} outside u64 range [0, 2^64-1]`);
  }
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

/** Left-pad / trim a byte array to exactly 32 bytes. */
function padTo32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) return bytes.slice(bytes.length - 32);
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return padded;
}

/** Sort two 32-byte pubkeys lexicographically by raw bytes (matches Rust). */
function sortPubkeys(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  for (let i = 0; i < 32; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return [a, b];
    if (ai > bi) return [b, a];
  }
  return [a, b];
}

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

function findProgramAddress(
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
 * Derive the channel PDA — connector-parity.
 * Seeds: `[b"channel", min_pubkey, max_pubkey, token_mint]` (participants sorted).
 *
 * @returns base58 PDA + bump.
 */
export function deriveChannelPDA(
  participantA: string,
  participantB: string,
  tokenMint: string,
  programId: string
): { pda: string; bump: number } {
  const a = padTo32(base58Decode(participantA));
  const b = padTo32(base58Decode(participantB));
  const mint = padTo32(base58Decode(tokenMint));
  const program = padTo32(base58Decode(programId));
  const [min, max] = sortPubkeys(a, b);
  const seeds = [new TextEncoder().encode('channel'), min, max, mint];
  const { pda, bump } = findProgramAddress(seeds, program);
  return { pda: base58Encode(pda), bump };
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

/**
 * Derive the vault PDA for a channel — connector-parity.
 * Seeds: `[b"vault", channel_pda]`.
 */
export function deriveVaultPDA(
  channelPDA: string,
  programId: string
): { pda: string; bump: number } {
  const channel = padTo32(base58Decode(channelPDA));
  const program = padTo32(base58Decode(programId));
  const seeds = [new TextEncoder().encode('vault'), channel];
  const { pda, bump } = findProgramAddress(seeds, program);
  return { pda: base58Encode(pda), bump };
}

// ---------------------------------------------------------------------------
// Balance-proof message + signing (connector-parity)
// ---------------------------------------------------------------------------

/**
 * Build the connector's canonical 48-byte balance-proof message:
 *   `channel_pda(32) || nonce(8 LE) || transferredAmount(8 LE)`.
 *
 * Mirrors `SolanaPaymentChannelSDK._buildBalanceProofMessage`. This is the EXACT
 * message the connector's `solana-payment-channel-provider.verifyBalanceProof`
 * reconstructs and Ed25519-verifies (un-hashed).
 */
export function buildBalanceProofMessage(
  channelPDA: string,
  nonce: bigint,
  transferredAmount: bigint
): Uint8Array {
  const message = new Uint8Array(48);
  message.set(padTo32(base58Decode(channelPDA)), 0);
  writeU64LE(message, 32, nonce);
  writeU64LE(message, 40, transferredAmount);
  return message;
}

/** Sign the 48-byte balance-proof message with a 32-byte Ed25519 seed. */
export function signBalanceProofMessage(
  channelPDA: string,
  nonce: bigint,
  transferredAmount: bigint,
  seed: Uint8Array
): Uint8Array {
  const message = buildBalanceProofMessage(
    channelPDA,
    nonce,
    transferredAmount
  );
  return ed25519.sign(message, seed);
}

// ---------------------------------------------------------------------------
// On-chain channel open (initialize_channel + deposit) over raw JSON-RPC
// ---------------------------------------------------------------------------

interface InstructionKey {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

interface RawInstruction {
  programId: string;
  keys: InstructionKey[];
  data: Uint8Array;
}

interface Signer {
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

async function solanaRpc(
  rpcUrl: string,
  method: string,
  params: unknown[] = []
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: rpcIdCounter++,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message: string; code: number };
  };
  if (json.error) {
    throw new SolanaRpcError(method, json.error.code, json.error.message);
  }
  return json.result;
}

async function getLatestBlockhash(rpcUrl: string): Promise<string> {
  const result = (await solanaRpc(rpcUrl, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])) as { value: { blockhash: string } };
  return result.value.blockhash;
}

interface AccountInfo {
  data: [string, string];
  owner: string;
  lamports: number;
}

async function getAccountInfo(
  rpcUrl: string,
  pubkey: string
): Promise<AccountInfo | null> {
  const result = (await solanaRpc(rpcUrl, 'getAccountInfo', [
    pubkey,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value: AccountInfo | null };
  return result.value;
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
  rpcUrl: string,
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
export async function getLamports(rpcUrl: string, pubkey: string): Promise<bigint> {
  const result = (await solanaRpc(rpcUrl, 'getBalance', [
    pubkey,
    { commitment: 'confirmed' },
  ])) as { value?: number | string } | null;
  return BigInt(result?.value ?? 0);
}

/** Base fee per signature (lamports). Each of our txs carries exactly one. */
const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Native SOL (lamports) a FRESH channel open must be able to SPEND, computed
 * rather than guessed:
 *
 *   rent-exempt(178-byte channel account) = (128 + 178) × 6960 = 2_129_760
 *   rent-exempt(165-byte SPL vault)       = (128 + 165) × 6960 = 2_039_280
 *   2 signatures (initialize_channel, deposit) × 5_000        =    10_000
 *                                                              ──────────
 *                                                               4_179_040
 *
 * (6960 lamports/byte-year × 2 years is Solana's rent-exemption rate, and 128
 * bytes is the fixed per-account overhead.) The devnet open behind
 * connector#646 spent ≈0.0042 SOL end to end, which matches.
 *
 * This bounds the SPEND, which is not quite the chain's whole requirement:
 * Solana additionally rejects a transaction that leaves the fee payer
 * rent-paying rather than rent-exempt (`RentState::transition_allowed`), so a
 * payer must really end at either 0 or ≥ the 890_880-lamport minimum. A payer
 * holding somewhere in [4_179_040, 5_069_920) therefore passes this preflight
 * and is still rejected on-chain with `InsufficientFundsForRent`.
 *
 * That window is left deliberately un-padded. Adding 890_880 here would reject
 * the payer who spends down to exactly 0 — which the chain permits — and this
 * preflight exists to REPLACE opaque failures with actionable ones, not to
 * invent refusals of its own. A payer inside the window still gets the chain's
 * error, exactly as it did before this preflight existed; everyone below the
 * floor gets a message naming the wallet and the shortfall.
 */
export const MIN_LAMPORTS_FOR_CHANNEL_OPEN = 4_179_040n;

/**
 * Native SOL (lamports) a standalone top-up of an EXISTING channel must be able
 * to spend: one signature, no rent — both accounts already exist and are
 * already rent-exempt. The same rent-state caveat as
 * {@link MIN_LAMPORTS_FOR_CHANNEL_OPEN} applies, over [5_000, 895_880).
 */
export const MIN_LAMPORTS_FOR_DEPOSIT = LAMPORTS_PER_SIGNATURE;

/**
 * Fail an on-chain open BEFORE spending anything when the payer cannot fund it.
 *
 * Two distinct assets are required and neither implies the other: native SOL
 * pays the rent for the channel + vault accounts and the signature fees, while
 * the SPL settlement token is what the `deposit` instruction moves into the
 * vault. A wallet holding USDC but no SOL fails partway through the open; a
 * wallet holding SOL but no USDC aborts the deposit AFTER `initialize_channel`
 * has already created a (rent-paying, 0-collateral) channel — exactly the state
 * connector#646 observed. Reading both up front turns either case into an
 * actionable {@link ChannelFundingError}.
 */
async function assertOpenFunding(opts: {
  rpcUrl: string;
  payerPubkey: string;
  tokenMint: string;
  /** Lamport floor for the transactions about to be sent. */
  minLamports: bigint;
  deposit?: { amount: bigint; payerTokenAccount: string };
}): Promise<void> {
  const { rpcUrl, payerPubkey, tokenMint, minLamports, deposit } = opts;

  const lamports = await getLamports(rpcUrl, payerPubkey);
  if (lamports < minLamports) {
    throw new ChannelFundingError(
      `Solana settlement wallet ${payerPubkey} holds ${lamports} lamports, below the ` +
        `${minLamports} needed here (rent for the channel + vault accounts, plus ` +
        `signature fees). Native SOL is separate from the settlement token: holding ` +
        `the SPL token is not enough. Airdrop/fund SOL to that address and retry.`
    );
  }

  if (!deposit || deposit.amount <= 0n) return;

  const held = await getTokenAccountBalance(rpcUrl, deposit.payerTokenAccount);
  if (held === null) {
    throw new ChannelFundingError(
      `Solana token account ${deposit.payerTokenAccount} does not exist, so the ` +
        `${deposit.amount} base-unit channel deposit of mint ${tokenMint} cannot ` +
        `be funded. Fund the settlement wallet with that token (which creates the ` +
        `associated token account) and retry.`
    );
  }
  if (held < deposit.amount) {
    throw new ChannelFundingError(
      `Solana token account ${deposit.payerTokenAccount} holds ${held} base units ` +
        `of mint ${tokenMint}, short of the ${deposit.amount} base-unit channel ` +
        `deposit. Fund the settlement wallet, or lower the deposit ` +
        `(\`solanaChannel.deposit.amount\` / \`initialDeposit\`), and retry.`
    );
  }
}

async function waitForConfirmation(
  rpcUrl: string,
  signature: string,
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = (await solanaRpc(rpcUrl, 'getSignatureStatuses', [
      [signature],
    ])) as {
      value: ({ confirmationStatus: string; err?: unknown } | null)[];
    };
    const status = result.value[0];
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      if (status.err) {
        throw new Error(
          `Transaction ${signature} failed: ${JSON.stringify(status.err)}`
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Transaction ${signature} not confirmed within ${timeoutMs}ms`
  );
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
  rpcUrl: string,
  feePayer: Signer,
  instructions: RawInstruction[],
  additionalSigners: Signer[] = []
): Promise<string> {
  const blockhash = await getLatestBlockhash(rpcUrl);
  const feePayerPubkey = base58Encode(feePayer.publicKey);

  const accountMap = new Map<string, AccountEntry>();
  accountMap.set(feePayerPubkey, {
    pubkey: feePayerPubkey,
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
    if (a.pubkey === feePayerPubkey) return -1;
    if (b.pubkey === feePayerPubkey) return 1;
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

  const blockhashBytes = base58Decode(blockhash);

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

  const finalMessage = message.slice(0, offset);

  const allSigners = [feePayer, ...additionalSigners];
  const signerPubkeys = accounts.filter((a) => a.isSigner).map((a) => a.pubkey);
  const signatures: Uint8Array[] = [];
  for (const signerPubkey of signerPubkeys) {
    const signer = allSigners.find(
      (s) => base58Encode(s.publicKey) === signerPubkey
    );
    if (!signer) throw new Error(`Missing signer for ${signerPubkey}`);
    signatures.push(ed25519.sign(finalMessage, signer.privateKey));
  }

  const txSize =
    compactU16Size(signatures.length) +
    signatures.length * 64 +
    finalMessage.length;
  const tx = new Uint8Array(txSize);
  let txOffset = 0;
  txOffset = writeCompactU16(tx, txOffset, signatures.length);
  for (const sig of signatures) {
    tx.set(sig, txOffset);
    txOffset += 64;
  }
  tx.set(finalMessage, txOffset);

  const txBase64 = Buffer.from(tx).toString('base64');
  const txSig = (await solanaRpc(rpcUrl, 'sendTransaction', [
    txBase64,
    {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    },
  ])) as string;
  await waitForConfirmation(rpcUrl, txSig);
  return txSig;
}

/** Parsed status of an on-chain channel account. */
export interface SolanaChannelAccountState {
  exists: boolean;
  /** 'opened' | 'closed' | 'settled' when the account exists with valid data. */
  state?: 'opened' | 'closed' | 'settled';
  participantA?: string;
  participantB?: string;
  /**
   * PER-PARTICIPANT collateral (base units), as the program tracks it.
   *
   * These are what bound redeemability, NOT the vault's token balance: the
   * vault holds `deposit_a + deposit_b`, but `Claim` rejects a claim whose
   * `transferred_amount` exceeds the CLAIMER'S OWN deposit
   * (`TransferredAmountExceedsDeposit`). A peer-funded vault can therefore look
   * amply funded while this client's own collateral is still 0.
   */
  depositA?: bigint;
  depositB?: bigint;
}

const STATE_MAP = ['opened', 'closed', 'settled'] as const;

/** Read a little-endian u64 at `offset`. */
function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i] ?? 0);
  }
  return value;
}

/**
 * Fetch + minimally parse the on-chain channel account at a PDA.
 *
 * Offsets mirror the program's `state.rs` layout (178-byte account):
 * `[8..40]` participant_a, `[40..72]` participant_b, `[104..112]` deposit_a,
 * `[112..120]` deposit_b, `[160]` state.
 */
export async function getChannelAccountState(
  rpcUrl: string,
  channelPDA: string
): Promise<SolanaChannelAccountState> {
  const info = await getAccountInfo(rpcUrl, channelPDA);
  if (!info) return { exists: false };
  const data = new Uint8Array(Buffer.from(info.data[0], 'base64'));
  if (data.length < CHANNEL_ACCOUNT_SIZE) return { exists: false };
  for (let i = 0; i < 8; i++) {
    if (data[i] !== CHANNEL_DISCRIMINATOR[i]) return { exists: false };
  }
  return {
    exists: true,
    state: STATE_MAP[data[160] ?? 0] ?? 'opened',
    participantA: base58Encode(data.slice(8, 40)),
    participantB: base58Encode(data.slice(40, 72)),
    depositA: readU64LE(data, 104),
    depositB: readU64LE(data, 112),
  };
}

/**
 * This payer's OWN recorded collateral on an existing channel — the quantity
 * that bounds what its claims can redeem.
 *
 * @throws when the payer is neither participant. Unreachable via the normal
 *   path (the channel PDA is derived from `[b"channel", min(payer,peer),
 *   max(payer,peer), mint]`, so membership is structural), which is exactly why
 *   a mismatch must be surfaced rather than silently skipped: it means the
 *   account we parsed is not the channel we think it is.
 */
function ownDeposit(
  account: SolanaChannelAccountState,
  payerPubkey: string
): bigint {
  if (account.participantA === payerPubkey) return account.depositA ?? 0n;
  if (account.participantB === payerPubkey) return account.depositB ?? 0n;
  throw new Error(
    `Solana channel participants (${account.participantA}, ${account.participantB}) ` +
      `do not include the payer ${payerPubkey} — refusing to reason about its collateral.`
  );
}

export interface OpenSolanaChannelParams {
  rpcUrl: string;
  programId: string;
  tokenMint: string;
  /** Client's 32-byte Ed25519 seed (participant A + fee payer). */
  payerSeed: Uint8Array;
  /** Client's base58 pubkey (participant A). */
  payerPubkey: string;
  /** Apex's base58 settlement pubkey (participant B). */
  peerPubkey: string;
  /** Challenge-period duration in seconds. */
  challengeDuration: bigint;
  /** Optional deposit amount + funded SPL token account (ATA) of the payer. */
  deposit?: { amount: bigint; payerTokenAccount: string };
}

export interface OpenSolanaChannelResult {
  channelPDA: string;
  /** True if a fresh on-chain initialize_channel tx was submitted. */
  opened: boolean;
  initTxSignature?: string;
  depositTxSignature?: string;
  /**
   * Collateral in the channel vault (base units) after this call. Present
   * whenever it was established here — read from chain on the existing-channel
   * path, known by construction on the fresh-open path. REPORTING only: nothing
   * gates spending on it (the Solana balance-proof signer never reads it), it
   * exists so callers can show and log real collateral instead of 0.
   */
  depositTotal?: bigint;
}

/**
 * Bring an ALREADY-OPEN channel up to the target collateral, depositing only
 * the shortfall. A no-op when no deposit is requested or when the payer's own
 * collateral already meets the target.
 *
 * Measures the PAYER'S OWN `deposit_a`/`deposit_b`, never the vault's token
 * balance. The vault holds BOTH participants' collateral, but `Claim` bounds a
 * claim by the claimer's own deposit alone — so a vault funded by the peer can
 * read at or above target while this client's collateral is still 0, and
 * comparing against it would no-op in exactly the case a top-up is needed. The
 * figure is read from the channel account already fetched for the idempotency
 * check, so this costs no extra RPC.
 *
 * This is what makes the fix reach channels that already exist: the connector#646
 * devnet channel is open with 0 collateral, and a client that merely skipped it
 * would go on signing claims that cannot be redeemed.
 */
async function topUpExistingChannel(opts: {
  rpcUrl: string;
  programId: string;
  tokenMint: string;
  channelPDA: string;
  payerSeed: Uint8Array;
  payerPubkey: string;
  /** The channel account already read for the idempotency check. */
  existing: SolanaChannelAccountState;
  deposit?: { amount: bigint; payerTokenAccount: string };
}): Promise<{ depositTxSignature?: string; depositTotal?: bigint }> {
  const {
    rpcUrl,
    programId,
    tokenMint,
    channelPDA,
    payerPubkey,
    existing,
    deposit,
  } = opts;
  if (!deposit || deposit.amount <= 0n) return {};

  const own = ownDeposit(existing, payerPubkey);
  if (own >= deposit.amount) return { depositTotal: own };

  const shortfall = deposit.amount - own;
  // No rent here — both accounts already exist — so only the signature fee.
  await assertOpenFunding({
    rpcUrl,
    payerPubkey,
    tokenMint,
    minLamports: MIN_LAMPORTS_FOR_DEPOSIT,
    deposit: {
      amount: shortfall,
      payerTokenAccount: deposit.payerTokenAccount,
    },
  });

  const { depositTxSignature } = await depositSolanaChannel({
    rpcUrl,
    programId,
    channelPDA,
    payerSeed: opts.payerSeed,
    payerPubkey,
    payerTokenAccount: deposit.payerTokenAccount,
    amount: shortfall,
  });
  return { depositTxSignature, depositTotal: own + shortfall };
}

/**
 * Open (initialize) and collateralize a real on-chain Solana payment channel at
 * the connector-parity PDA. Idempotent in the only sense that matters: an
 * existing channel is never re-initialized, but its vault IS topped up to the
 * requested collateral, so the outcome — "an open channel holding `deposit`" —
 * is the same whether or not the channel existed beforehand.
 *
 * The Ed25519 keypair derives both the participant-A identity and the fee
 * payer; the apex pubkey is participant B. The returned `channelPDA` (base58) is
 * the value carried in the claim's `channelAccount`.
 */
export async function openSolanaChannel(
  params: OpenSolanaChannelParams
): Promise<OpenSolanaChannelResult> {
  const {
    rpcUrl,
    programId,
    tokenMint,
    payerSeed,
    payerPubkey,
    peerPubkey,
    challengeDuration,
  } = params;

  const { pda: channelPDA } = deriveChannelPDA(
    payerPubkey,
    peerPubkey,
    tokenMint,
    programId
  );

  // Idempotent: skip initialize if the channel account already exists — but do
  // NOT skip the collateral. A channel opened before connector#646 was fixed
  // exists on-chain with a 0-balance vault, and returning here would let the
  // client keep signing uncollateralized claims against it forever, which is
  // the very defect this path is meant to close. Top it up to the target
  // instead; already-collateralized channels are a no-op.
  const existing = await getChannelAccountState(rpcUrl, channelPDA);
  if (existing.exists) {
    // …but ONLY an `Opened` channel can take a deposit: the program rejects
    // `Deposit` on a closed/settled channel (`ChannelNotOpened`). Resuming a
    // channel this client has CLOSED is a supported, persisted state (the
    // withdraw flow), so returning it unchanged is the correct answer — firing
    // a doomed deposit would turn that flow into an opaque `custom program
    // error`. Collateral is a question for a channel that can still spend.
    if (existing.state !== 'opened') {
      return { channelPDA, opened: false };
    }
    const topUp = await topUpExistingChannel({
      rpcUrl,
      programId,
      tokenMint,
      channelPDA,
      payerSeed,
      payerPubkey,
      existing,
      deposit: params.deposit,
    });
    return { channelPDA, opened: false, ...topUp };
  }

  // Only a FRESH open pays rent, so the full rent+fee floor is required here.
  await assertOpenFunding({
    rpcUrl,
    payerPubkey,
    tokenMint,
    minLamports: MIN_LAMPORTS_FOR_CHANNEL_OPEN,
    deposit: params.deposit,
  });

  const payerPublicKey = padTo32(base58Decode(payerPubkey));
  const payer: Signer = { publicKey: payerPublicKey, privateKey: payerSeed };

  const { pda: vaultPDA } = deriveVaultPDA(channelPDA, programId);

  // initialize_channel: discriminator(8) + challenge_duration(8 LE)
  const initData = new Uint8Array(16);
  initData.set(IX_INITIALIZE_CHANNEL, 0);
  writeU64LE(initData, 8, challengeDuration);

  const initTxSignature = await buildAndSendTransaction(rpcUrl, payer, [
    {
      programId,
      keys: [
        { pubkey: payerPubkey, isSigner: true, isWritable: true },
        { pubkey: payerPubkey, isSigner: false, isWritable: false }, // participant A
        { pubkey: peerPubkey, isSigner: false, isWritable: false }, // participant B
        { pubkey: tokenMint, isSigner: false, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: RENT_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data: initData,
    },
  ]);

  let depositTxSignature: string | undefined;
  if (params.deposit && params.deposit.amount > 0n) {
    ({ depositTxSignature } = await depositSolanaChannel({
      rpcUrl,
      programId,
      channelPDA,
      payerSeed,
      payerPubkey,
      payerTokenAccount: params.deposit.payerTokenAccount,
      amount: params.deposit.amount,
    }));
  }

  return {
    channelPDA,
    opened: true,
    initTxSignature,
    depositTxSignature,
    ...(depositTxSignature ? { depositTotal: params.deposit?.amount } : {}),
  };
}

export interface DepositSolanaChannelParams {
  rpcUrl: string;
  programId: string;
  /** The channel PDA (base58) — the Solana channel id. */
  channelPDA: string;
  /** Ed25519 signing seed (32 bytes) of the payer. */
  payerSeed: Uint8Array;
  /** Payer public key (base58). */
  payerPubkey: string;
  /** Funded SPL token account (ATA, base58) the collateral is pulled from. */
  payerTokenAccount: string;
  /** Delta to deposit (base units). The on-chain `deposit` ix adds this amount. */
  amount: bigint;
}

/**
 * Deposit additional collateral into an existing on-chain Solana channel — the
 * standalone `deposit` instruction (discriminator + amount LE), the same one the
 * open flow fires post-init. Incremental: the program adds `amount` to the
 * channel vault. Returns the deposit tx signature.
 */
export async function depositSolanaChannel(
  params: DepositSolanaChannelParams
): Promise<{ depositTxSignature: string }> {
  const {
    rpcUrl,
    programId,
    channelPDA,
    payerSeed,
    payerPubkey,
    payerTokenAccount,
    amount,
  } = params;
  if (amount <= 0n) throw new Error('Solana deposit amount must be positive.');

  const payer: Signer = {
    publicKey: padTo32(base58Decode(payerPubkey)),
    privateKey: payerSeed,
  };
  const { pda: vaultPDA } = deriveVaultPDA(channelPDA, programId);

  // deposit: discriminator(8) + amount(8 LE)
  const depositData = new Uint8Array(16);
  depositData.set(IX_DEPOSIT, 0);
  writeU64LE(depositData, 8, amount);

  const depositTxSignature = await buildAndSendTransaction(rpcUrl, payer, [
    {
      programId,
      keys: [
        { pubkey: payerPubkey, isSigner: true, isWritable: false },
        { pubkey: payerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: depositData,
    },
  ]);
  return { depositTxSignature };
}

// Internal helpers exported for unit tests (parity assertions).
export const __testing = { padTo32, sortPubkeys, isOnCurve };
