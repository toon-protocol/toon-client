/**
 * Solana payment-channel primitives — parity with the deployed program.
 *
 * Pure, dependency-light helpers that reproduce the EXACT on-chain contract of
 * the connector's `payment-channel` program
 * (`toon-protocol/connector` `packages/solana-program/src/{instruction,state,processor}.rs`),
 * mirrored the same way the connector's own client half is
 * (`crates/connector-settlement-solana/src/wire.rs`). A mismatch anywhere below
 * makes the connector refuse the claim, or makes the chain refuse the
 * transaction — so every discriminator, account order and byte offset here is
 * cited to the Rust it was read from, and must move in lock-step with it.
 *
 *   1. PDA derivation — `[b"channel", min_pubkey, max_pubkey, token_mint]`,
 *      participants sorted lexicographically by raw 32-byte pubkey, derived
 *      against the program id (`processor.rs::derive_channel_pda`). This base58
 *      PDA is the claim's `channelAccount` and the channel-state account both
 *      the connector and the program read.
 *   2. The **96-byte** balance-proof message a claim's Ed25519 signature covers
 *      — see {@link buildBalanceProofMessage} for the layout and for why it
 *      grew from 48 bytes (connector ADR 0053).
 *   3. The six instructions the program implements: `01` initialize, `02`
 *      deposit, `03` close, `04` settle, `05` force-close-expired and `06`
 *      claim-from-channel — built and submitted over raw Solana JSON-RPC (no
 *      `@solana/web3.js` / `@solana/kit` runtime dependency: only
 *      `@noble/curves` + `@noble/hashes`, already client deps).
 *   4. The 178-byte `ChannelState` account (`state.rs`), decoded in full.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58Encode, base58Decode } from '../../utils/base58.js';
import { ChannelFundingError } from '../../client/errors.js';

// ---------------------------------------------------------------------------
// Constants (must match the Rust program + connector SDK exactly)
// ---------------------------------------------------------------------------

/** Well-known Solana program addresses (base58). */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';
const CLOCK_SYSVAR_ID = 'SysvarC1ock11111111111111111111111111111111';
const INSTRUCTIONS_SYSVAR_ID = 'Sysvar1nstructions1111111111111111111111111';
/** The Ed25519 signature-verification precompile (`ed25519_program::id()`). */
const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';

/**
 * Instruction discriminators — the first byte of an 8-byte LE tag
 * (`instruction.rs:7-12`). The program dispatches on all eight bytes, so the
 * seven zero bytes are as load-bearing as the first.
 */
const IX_INITIALIZE_CHANNEL = new Uint8Array([0x01, 0, 0, 0, 0, 0, 0, 0]);
const IX_DEPOSIT = new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0]);
const IX_CLOSE_CHANNEL = new Uint8Array([0x03, 0, 0, 0, 0, 0, 0, 0]);
const IX_SETTLE_CHANNEL = new Uint8Array([0x04, 0, 0, 0, 0, 0, 0, 0]);
const IX_FORCE_CLOSE_EXPIRED = new Uint8Array([0x05, 0, 0, 0, 0, 0, 0, 0]);
const IX_CLAIM_FROM_CHANNEL = new Uint8Array([0x06, 0, 0, 0, 0, 0, 0, 0]);

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
 * The 16-byte domain tag every balance-proof message begins with (connector
 * ADR 0053, issue #1082). Byte-identical to `connector_signer::
 * SOLANA_BALANCE_PROOF_DOMAIN_TAG`, to `connector-settlement-solana`'s
 * `wire.rs::BALANCE_PROOF_DOMAIN_TAG`, and to the on-chain program's own
 * `processor.rs::BALANCE_PROOF_DOMAIN_TAG` — four copies of one constant, kept
 * in step by the committed `peer_carriage.claim_solana` wire vector, which all
 * four are checked against (see `src/wire/wire-vectors.test.ts`).
 */
const BALANCE_PROOF_DOMAIN_TAG = new TextEncoder().encode('TOON-BALPROOF-V2');

/** The v2 balance-proof message length. Fixed — every field is fixed-size. */
const BALANCE_PROOF_MESSAGE_SIZE = 96;

/**
 * Build the 96-byte balance-proof message a Solana claim's Ed25519 signature
 * covers:
 *
 * | bytes    | field                                              |
 * | -------- | -------------------------------------------------- |
 * | `0..16`  | `"TOON-BALPROOF-V2"`                               |
 * | `16..48` | `programId` — the settlement program, raw 32 bytes |
 * | `48..80` | `channelAccount` (the channel PDA), raw 32 bytes   |
 * | `80..88` | `nonce`, u64 little-endian                         |
 * | `88..96` | `transferredAmount`, u64 little-endian             |
 *
 * ## Why it grew from 48 bytes to 96
 *
 * Before ADR 0053 this message was `channel_pda || nonce || amount` — 48 bytes
 * that bound **nothing about which deployment the channel lives on**. An EVM
 * claim has bound its chain id and its `TokenNetwork` since ADR 0024, through
 * the EIP-712 domain separator; the Solana side had no equivalent. So a
 * signature was valid for its channel account on **any** cluster where an
 * account of that address existed, and the only separation between deployments
 * came from their program ids happening to differ — a deployment accident
 * standing in for a cryptographic guarantee. Putting the program id in the
 * signed bytes closes that replay: a proof signed for one deployment cannot be
 * redeemed at another, because the other program rebuilds the message with its
 * own id and the signature no longer verifies.
 *
 * The cluster is deliberately NOT in here. A Solana program knows its own id
 * and nothing about which cluster it runs on, so it could never rebuild a
 * message containing one — a cluster string would be unverifiable on chain. A
 * claim's declared `cluster` therefore stays what it always was, a routing hint
 * the connector cross-checks off chain against its own `[settlement.solana]
 * rpc_url`, never a security boundary.
 *
 * ## Why a domain tag rather than an appended field
 *
 * An appended field is silently truncatable by a verifier that expects the old
 * length. Prefixing a tag means the first 48 bytes of a v2 message are not a
 * valid message under either scheme, so a verifier written against the old
 * layout rejects it outright instead of reading a prefix of it as complete —
 * and the deployed program refuses a 96-byte message's 48-byte ancestor on
 * length before it ever compares bytes (`processor.rs::verify_ed25519_precompile`).
 *
 * @param programId - base58 settlement program id. The claim's `programId`
 *   field must name this same program: a claim naming another names a program
 *   no channel of the payer's lives under.
 * @param channelPDA - base58 channel PDA — the claim's `channelAccount`.
 */
export function buildBalanceProofMessage(
  programId: string,
  channelPDA: string,
  nonce: bigint,
  transferredAmount: bigint
): Uint8Array {
  const message = new Uint8Array(BALANCE_PROOF_MESSAGE_SIZE);
  message.set(BALANCE_PROOF_DOMAIN_TAG, 0);
  message.set(padTo32(base58Decode(programId)), 16);
  message.set(padTo32(base58Decode(channelPDA)), 48);
  writeU64LE(message, 80, nonce);
  writeU64LE(message, 88, transferredAmount);
  return message;
}

/**
 * Sign the 96-byte balance-proof message with a 32-byte Ed25519 seed — the raw
 * 64-byte signature a claim carries (base64) and the on-chain Ed25519
 * precompile verifies.
 */
export function signBalanceProofMessage(
  programId: string,
  channelPDA: string,
  nonce: bigint,
  transferredAmount: bigint,
  seed: Uint8Array
): Uint8Array {
  const message = buildBalanceProofMessage(
    programId,
    channelPDA,
    nonce,
    transferredAmount
  );
  return ed25519.sign(message, seed);
}

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
export async function solanaRpc(
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

/** Latest blockhash, base58 — what `patchSolanaRecentBlockhash` accepts as-is. */
export async function getLatestBlockhash(rpcUrl: string): Promise<string> {
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

/**
 * Poll until the transaction is `confirmed`/`finalized`, THROWING if it landed
 * with an execution error. A settled-but-failed transaction is not a success.
 */
export async function waitForConfirmation(
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

/**
 * The 178-byte `ChannelState` account, decoded in full.
 *
 * Field offsets are `packages/solana-program/src/state.rs`'s own constants:
 * `[0..8]` discriminator, `[8..40]` participant_a, `[40..72]` participant_b,
 * `[72..104]` token_mint, `[104..112]` deposit_a, `[112..120]` deposit_b,
 * `[120..128]` transferred_amount_a, `[128..136]` transferred_amount_b,
 * `[136..144]` nonce_a, `[144..152]` nonce_b, `[152..160]` challenge_duration,
 * `[160]` state, `[161..169]` close_timestamp (**i64**, signed), `[169]` bump,
 * `[170..178]` reserved padding.
 *
 * Participants are stored SORTED — the program writes `min(a, b)` into
 * `participant_a` regardless of the order `initialize_channel` was handed them
 * (`processor.rs::sort_participants`) — so which of the two is "us" is a
 * lexicographic fact about the keys, never about who opened the channel.
 */
export interface SolanaChannelAccountState {
  exists: boolean;
  /** 'opened' | 'closed' | 'settled' when the account exists with valid data. */
  state?: 'opened' | 'closed' | 'settled';
  participantA?: string;
  participantB?: string;
  /** The SPL mint this channel settles in — what the vault holds. */
  tokenMint?: string;
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
  /**
   * The highest cumulative amount each participant's redeemed claims have
   * moved. Settlement pays `deposit_x - transferred_x + transferred_y`, so
   * these are the figures a close/settle actually divides on.
   */
  transferredAmountA?: bigint;
  transferredAmountB?: bigint;
  /**
   * The on-chain nonce watermark per participant. `ClaimFromChannel` demands
   * `nonce > stored`, so a claim at or below either of these is already spent —
   * this is the authoritative answer to "what nonce must I sign next", and the
   * reason a replayed nonce cannot be redeemed twice.
   */
  nonceA?: bigint;
  nonceB?: bigint;
  /** Seconds after `closeTimestamp` before `settle` is permitted. */
  challengeDuration?: bigint;
  /**
   * Unix seconds the channel was closed, `0` while it is open. **Signed** on
   * chain (`i64`), so it is decoded as such rather than as a u64 that would
   * read a negative clock as ~1.8e19.
   */
  closeTimestamp?: bigint;
  /** The PDA bump seed the program stored when it derived this account. */
  bump?: number;
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
 * Read a little-endian **i64** at `offset` — two's complement, so a negative
 * on-chain `close_timestamp` decodes as negative rather than as an enormous
 * positive. `settleableAt` arithmetic is only sound if this sign survives.
 */
function readI64LE(data: Uint8Array, offset: number): bigint {
  const unsigned = readU64LE(data, offset);
  return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
}

/** Decode a 178-byte `ChannelState` account's raw bytes. */
export function decodeChannelAccount(
  data: Uint8Array
): SolanaChannelAccountState {
  if (data.length < CHANNEL_ACCOUNT_SIZE) return { exists: false };
  for (let i = 0; i < 8; i++) {
    if (data[i] !== CHANNEL_DISCRIMINATOR[i]) return { exists: false };
  }
  return {
    exists: true,
    state: STATE_MAP[data[160] ?? 0] ?? 'opened',
    participantA: base58Encode(data.slice(8, 40)),
    participantB: base58Encode(data.slice(40, 72)),
    tokenMint: base58Encode(data.slice(72, 104)),
    depositA: readU64LE(data, 104),
    depositB: readU64LE(data, 112),
    transferredAmountA: readU64LE(data, 120),
    transferredAmountB: readU64LE(data, 128),
    nonceA: readU64LE(data, 136),
    nonceB: readU64LE(data, 144),
    challengeDuration: readU64LE(data, 152),
    closeTimestamp: readI64LE(data, 161),
    bump: data[169] ?? 0,
  };
}

/**
 * Fetch + decode the on-chain channel account at a PDA.
 *
 * A SETTLED channel is indistinguishable from one that never existed: the
 * program zeroes the account's data and lamports on settle
 * (`processor.rs::process_settlement`), so this reports `{ exists: false }` for
 * it. Callers that must tell the two apart keep their own record of what they
 * settled.
 */
export async function getChannelAccountState(
  rpcUrl: string,
  channelPDA: string
): Promise<SolanaChannelAccountState> {
  const info = await getAccountInfo(rpcUrl, channelPDA);
  if (!info) return { exists: false };
  return decodeChannelAccount(new Uint8Array(Buffer.from(info.data[0], 'base64')));
}

/**
 * The earliest unix second `settle` will succeed on a CLOSED channel:
 * `close_timestamp + challenge_duration`, the deadline
 * `processor.rs::process_settlement` compares `Clock::unix_timestamp` against.
 *
 * `undefined` for a channel that is not closed — an open channel has no
 * settlement deadline, and reporting one derived from a zero
 * `close_timestamp` would claim it is settleable now, which it is not.
 */
export function settleableAt(
  account: SolanaChannelAccountState
): bigint | undefined {
  if (account.state !== 'closed') return undefined;
  return (account.closeTimestamp ?? 0n) + (account.challengeDuration ?? 0n);
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

// ---------------------------------------------------------------------------
// close (03) / settle (04) / force-close-expired (05)
// ---------------------------------------------------------------------------

export interface CloseSolanaChannelParams {
  rpcUrl: string;
  programId: string;
  /** The channel PDA (base58) — the Solana channel id. */
  channelPDA: string;
  /** Ed25519 signing seed (32 bytes) of the closer. */
  closerSeed: Uint8Array;
  /** Closer's base58 pubkey. MUST be one of the channel's two participants. */
  closerPubkey: string;
}

/**
 * Close a channel — instruction `03`, which stamps `close_timestamp` from the
 * Clock sysvar and moves the state to `Closed`, starting the challenge period.
 *
 * Accounts, in the order `processor.rs::process_close_channel` reads them with
 * `next_account_info`:
 *
 *   0. `[signer]`   closer — must be `participant_a` or `participant_b`
 *   1. `[writable]` channel PDA
 *   2. `[]`         Clock sysvar
 *
 * The clock sysvar is passed but not read by key: the program takes the time
 * from `Clock::get()`. It is still required, because the account list is
 * positional — omitting it makes `next_account_info` fail rather than default.
 *
 * A closed channel can still be claimed against (`ClaimFromChannel` accepts
 * `Opened` and `Closed`), which is the point of the challenge period: a
 * counterparty holding a newer balance proof has `challenge_duration` seconds
 * to redeem it before {@link settleSolanaChannel} pays out on the state as it
 * then stands.
 */
export async function closeSolanaChannel(
  params: CloseSolanaChannelParams
): Promise<{ closeTxSignature: string }> {
  const { rpcUrl, programId, channelPDA, closerSeed, closerPubkey } = params;
  const closer: Signer = {
    publicKey: padTo32(base58Decode(closerPubkey)),
    privateKey: closerSeed,
  };

  const closeTxSignature = await buildAndSendTransaction(rpcUrl, closer, [
    {
      programId,
      keys: [
        { pubkey: closerPubkey, isSigner: true, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: CLOCK_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data: IX_CLOSE_CHANNEL.slice(),
    },
  ]);
  return { closeTxSignature };
}

export interface SettleSolanaChannelParams {
  rpcUrl: string;
  programId: string;
  channelPDA: string;
  /** Ed25519 signing seed (32 bytes) of whoever pays for the settle tx. */
  callerSeed: Uint8Array;
  /** Caller's base58 pubkey. Need NOT be a participant — see below. */
  callerPubkey: string;
  /** SPL token account owned by `participant_a`, holding the channel's mint. */
  participantATokenAccount: string;
  /** SPL token account owned by `participant_b`, holding the channel's mint. */
  participantBTokenAccount: string;
  /**
   * Where the vault's and channel account's reclaimed rent lamports land.
   * Defaults to the caller — the party that is about to pay the tx fee.
   */
  rentRecipient?: string;
  /**
   * Send instruction `05` force-close-expired instead of `04` settle. The
   * program routes BOTH to the same `process_settlement`, so this changes only
   * the discriminator; it is offered because the two names mean different
   * things to an operator reading a transaction log, not because the chain
   * behaves differently.
   */
  force?: boolean;
}

/**
 * Settle a CLOSED channel whose challenge period has elapsed — instruction
 * `04` (or `05`, see `force`).
 *
 * Accounts, in `processor.rs::process_settlement`'s `next_account_info` order:
 *
 *   0. `[signer]`   caller
 *   1. `[writable]` channel PDA
 *   2. `[writable]` vault token account
 *   3. `[writable]` participant_a's token account
 *   4. `[writable]` participant_b's token account
 *   5. `[writable]` rent recipient
 *   6. `[]`         SPL Token program
 *   7. `[]`         Clock sysvar
 *
 * The caller is deliberately unconstrained — **any** signer may settle once the
 * challenge period is over. That is a safety property, not an oversight: it
 * stops a counterparty stranding the vault by simply refusing to act, and it is
 * safe because the payout destinations are pinned. The program checks each
 * destination it actually pays into is an initialized SPL Token account holding
 * the channel's mint and owned by that leg's participant, so a caller cannot
 * redirect either payout.
 *
 * Payouts are `deposit_x - transferred_x + transferred_y` per side; a
 * participant owed nothing need not have a token account in existence at all,
 * but the account list is positional, so an address must still be supplied for
 * both slots.
 */
export async function settleSolanaChannel(
  params: SettleSolanaChannelParams
): Promise<{ settleTxSignature: string }> {
  const {
    rpcUrl,
    programId,
    channelPDA,
    callerSeed,
    callerPubkey,
    participantATokenAccount,
    participantBTokenAccount,
  } = params;
  const rentRecipient = params.rentRecipient ?? callerPubkey;
  const caller: Signer = {
    publicKey: padTo32(base58Decode(callerPubkey)),
    privateKey: callerSeed,
  };
  const { pda: vaultPDA } = deriveVaultPDA(channelPDA, programId);

  const settleTxSignature = await buildAndSendTransaction(rpcUrl, caller, [
    {
      programId,
      keys: [
        { pubkey: callerPubkey, isSigner: true, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        {
          pubkey: participantATokenAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: participantBTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: rentRecipient, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: CLOCK_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data: (params.force
        ? IX_FORCE_CLOSE_EXPIRED
        : IX_SETTLE_CHANNEL
      ).slice(),
    },
  ]);
  return { settleTxSignature };
}

// ---------------------------------------------------------------------------
// claim-from-channel (06) + the Ed25519 precompile instruction it requires
// ---------------------------------------------------------------------------

/** `solana_sdk::ed25519_instruction`'s fixed-layout constants. */
const ED25519_PUBKEY_SIZE = 32;
const ED25519_SIGNATURE_SIZE = 64;
const ED25519_OFFSETS_SIZE = 14;
const ED25519_OFFSETS_START = 2;
const ED25519_DATA_START = ED25519_OFFSETS_SIZE + ED25519_OFFSETS_START;
/** `u16::MAX` — "this offset points inside THIS instruction's own data". */
const ED25519_THIS_INSTRUCTION = 0xffff;

/**
 * Build the Ed25519-precompile instruction the program requires at index **0**
 * of a `ClaimFromChannel` transaction.
 *
 * This mirrors `solana_sdk::ed25519_instruction::new_ed25519_instruction`'s
 * data layout byte-for-byte — as the connector's own
 * `wire.rs::ed25519_verify_instruction` does, and for the same reason: that
 * helper takes a keypair and signs the message itself, but a redeemer holds
 * only the counterparty's ALREADY-PRODUCED signature, never its signing key.
 *
 * ```text
 * 0        num_signatures = 1
 * 1        padding, unread
 * 2..4     signature_offset            u16 LE = 48
 * 4..6     signature_instruction_index u16 LE = 0xFFFF
 * 6..8     public_key_offset           u16 LE = 16
 * 8..10    public_key_instruction_index       = 0xFFFF
 * 10..12   message_data_offset         u16 LE = 112
 * 12..14   message_data_size           u16 LE = message.length
 * 14..16   message_instruction_index          = 0xFFFF
 * 16..48   public key
 * 48..112  signature
 * 112..    message
 * ```
 *
 * All three `*_instruction_index` fields are `0xFFFF` on purpose. The program
 * REFUSES any other value (`processor.rs::verify_ed25519_precompile`): letting
 * an offset point into a different instruction of the same transaction would
 * let a redeemer have the precompile verify one blob while the program reads
 * another as the message.
 *
 * @throws {RangeError} `signature` is not 64 bytes — a short signature would
 *   silently shift the message offset and verify a different span of bytes.
 */
export function buildEd25519VerifyInstruction(
  signerPubkey: string,
  signature: Uint8Array,
  message: Uint8Array
): RawInstruction {
  if (signature.length !== ED25519_SIGNATURE_SIZE) {
    throw new RangeError(
      `Ed25519 signature must be exactly ${ED25519_SIGNATURE_SIZE} bytes, got ${signature.length}`
    );
  }
  const publicKeyOffset = ED25519_DATA_START;
  const signatureOffset = publicKeyOffset + ED25519_PUBKEY_SIZE;
  const messageOffset = signatureOffset + ED25519_SIGNATURE_SIZE;

  const data = new Uint8Array(messageOffset + message.length);
  const view = new DataView(data.buffer);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, ED25519_THIS_INSTRUCTION, true);
  view.setUint16(6, publicKeyOffset, true);
  view.setUint16(8, ED25519_THIS_INSTRUCTION, true);
  view.setUint16(10, messageOffset, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, ED25519_THIS_INSTRUCTION, true);
  data.set(padTo32(base58Decode(signerPubkey)), publicKeyOffset);
  data.set(signature, signatureOffset);
  data.set(message, messageOffset);

  return { programId: ED25519_PROGRAM_ID, keys: [], data };
}

export interface ClaimFromSolanaChannelParams {
  programId: string;
  channelPDA: string;
  /**
   * The participant being credited — whose Ed25519 key signed the balance
   * proof. NOT a transaction signer: its authorization IS the signature the
   * precompile checks.
   */
  claimerPubkey: string;
  /** Whoever signs and pays for the transaction. May be anyone. */
  feePayerPubkey: string;
  nonce: bigint;
  transferredAmount: bigint;
  /** The claimer's 64-byte signature over the 96-byte v2 message. */
  signature: Uint8Array;
}

/**
 * The two instructions that redeem a balance proof on chain, **in the order
 * they must appear in the transaction**: the Ed25519 precompile first (the
 * program loads instruction index 0 and refuses anything else there), then
 * `ClaimFromChannel` itself.
 *
 * `ClaimFromChannel` accounts, in `processor.rs::process_claim_from_channel`'s
 * `next_account_info` order:
 *
 *   0. `[signer]`   fee payer — the submitter
 *   1. `[]`         claimer — credited participant, NOT a tx signer
 *   2. `[writable]` channel PDA
 *   3. `[]`         Instructions sysvar
 *
 * Data: `06 00 00 00 00 00 00 00 || nonce u64 LE || transferredAmount u64 LE`.
 *
 * Separating the fee payer from the claimer is what lets a connector redeem an
 * inbound peer's proof unilaterally: the peer authorized this exact
 * `(nonce, transferredAmount)` by signing the balance proof, so it never has to
 * co-sign the redemption. The program independently rebuilds the 96-byte
 * message from ITS OWN program id, the channel PDA it was handed and the
 * `(nonce, amount)` in this instruction's data, and requires the precompile's
 * message to equal it byte-for-byte — so the numbers in the data cannot differ
 * from the numbers that were signed.
 */
export function buildClaimFromChannelInstructions(
  params: ClaimFromSolanaChannelParams
): RawInstruction[] {
  const {
    programId,
    channelPDA,
    claimerPubkey,
    feePayerPubkey,
    nonce,
    transferredAmount,
    signature,
  } = params;

  const message = buildBalanceProofMessage(
    programId,
    channelPDA,
    nonce,
    transferredAmount
  );

  // 06 discriminator(8) + nonce(8 LE) + transferred_amount(8 LE)
  const data = new Uint8Array(24);
  data.set(IX_CLAIM_FROM_CHANNEL, 0);
  writeU64LE(data, 8, nonce);
  writeU64LE(data, 16, transferredAmount);

  return [
    buildEd25519VerifyInstruction(claimerPubkey, signature, message),
    {
      programId,
      keys: [
        { pubkey: feePayerPubkey, isSigner: true, isWritable: false },
        { pubkey: claimerPubkey, isSigner: false, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data,
    },
  ];
}

/**
 * Submit a balance proof for redemption — {@link buildClaimFromChannelInstructions}
 * sent as one transaction, paid for by `feePayerSeed`.
 *
 * On success the channel's `nonce_x` and `transferred_amount_x` for the CLAIMER
 * have advanced to the redeemed values; a nonce at or below the stored
 * watermark is refused by the program (`NonceNotMonotonic`), which is what
 * makes a captured claim unreplayable on chain.
 */
export async function claimFromSolanaChannel(
  params: ClaimFromSolanaChannelParams & {
    rpcUrl: string;
    /** Ed25519 seed of `feePayerPubkey`. */
    feePayerSeed: Uint8Array;
  }
): Promise<{ claimTxSignature: string }> {
  const feePayer: Signer = {
    publicKey: padTo32(base58Decode(params.feePayerPubkey)),
    privateKey: params.feePayerSeed,
  };
  const claimTxSignature = await buildAndSendTransaction(
    params.rpcUrl,
    feePayer,
    buildClaimFromChannelInstructions(params)
  );
  return { claimTxSignature };
}

// Internal helpers exported for unit tests (parity assertions).
export const __testing = {
  padTo32,
  sortPubkeys,
  isOnCurve,
  readI64LE,
  CLOCK_SYSVAR_ID,
  INSTRUCTIONS_SYSVAR_ID,
  ED25519_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
};
