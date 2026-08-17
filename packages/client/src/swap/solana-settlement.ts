/**
 * Receive-side Solana settlement submission (toon-client#604).
 *
 * `buildSettlementTx` returns, for a `solana:*` bundle, a **compiled legacy
 * Message** — not a transaction, because a transaction needs signatures the SDK
 * cannot produce. Since toon#214 that Message is executable: the Ed25519
 * precompile verification sits at instruction 0 and the program's
 * `ClaimFromChannel` at instruction 1, with the recipient as account 0 (fee
 * payer, the only required signer) and an ALL-ZERO recent-blockhash placeholder.
 *
 * Before toon#214 nothing here was worth wiring — the emitted bundle could not
 * have executed on any validator. Nothing noticed, because the only checks on
 * the path were a closed loop: the SDK signed a digest, the SDK verified the same
 * digest, and the transaction was asserted to be non-empty. So the two functions
 * below are split deliberately:
 *
 * - {@link buildSolanaSettlementTransaction} is PURE. Given a bundle, a live
 *   blockhash and the recipient's seed it produces the exact bytes that go on
 *   the wire, so they can be asserted directly and, more importantly, replayed
 *   against a real validator.
 * - {@link submitSolanaSettlement} adds only the two network calls (fetch a
 *   blockhash, broadcast) and the confirmation wait.
 *
 * What this deliberately does NOT do is re-derive the message. The account list,
 * the instruction data, the precompile offsets and the signed 48-byte balance
 * proof are all the SDK's, verified against the deployed program. Rebuilding any
 * of it here would recreate exactly the signer/verifier drift toon#214 fixed.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@toon-protocol/core';
import type { SettlementBundle } from '@toon-protocol/sdk';
import { patchSolanaRecentBlockhash } from '@toon-protocol/sdk';

import {
  getLatestBlockhash,
  solanaRpc,
  waitForConfirmation,
} from '../channel/solana-payment-channel.js';

/** Stable, machine-readable failure reasons the daemon can surface verbatim. */
export type SolanaSettlementErrorCode =
  /** The bundle is not a `solana:*` bundle. */
  | 'WRONG_CHAIN_KIND'
  /** No Solana RPC url is configured, so nothing can be broadcast. */
  | 'NO_RPC_CONFIGURED'
  /** No Solana key material — the recipient cannot sign its own redemption. */
  | 'NO_SIGNER'
  /**
   * The configured Solana key is not the claim's recipient. The recipient is
   * account 0 of the compiled message (fee payer AND sole required signer), so
   * signing with any other key produces a transaction the chain rejects.
   */
  | 'RECIPIENT_MISMATCH'
  /** The compiled message is not the shape this submitter can sign. */
  | 'MALFORMED_BUNDLE'
  /** The node refused the transaction, or it landed with an execution error. */
  | 'SUBMISSION_FAILED';

export class SolanaSettlementError extends Error {
  constructor(
    readonly code: SolanaSettlementErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SolanaSettlementError';
  }
}

/** Byte offsets of the compiled legacy Message the SDK emits. */
const MESSAGE_HEADER_SIZE = 3;
const PUBKEY_SIZE = 32;
const SIGNATURE_SIZE = 64;

export interface SolanaSettlementTransaction {
  /** The signed transaction, base64 — ready for `sendTransaction`. */
  txBase64: string;
  /** The transaction signature (its id), base58. */
  signature: string;
  /** The blockhash that was patched in, base58. */
  recentBlockhash: string;
  /** Account 0 of the message: fee payer, sole required signer, base58. */
  feePayer: string;
}

/**
 * Read account 0 out of a compiled legacy Message — the fee payer and, for a
 * settlement bundle, the claim recipient.
 *
 * Layout: `header(3) || short_vec(numKeys) || numKeys*32 || blockhash(32) || …`.
 * The SDK only ever emits six accounts, so `numKeys` is a single short_vec byte;
 * anything else is a message this submitter was not built for and is refused
 * rather than mis-parsed.
 */
function readFeePayer(messageBytes: Uint8Array): Uint8Array {
  if (messageBytes.length < MESSAGE_HEADER_SIZE + 1) {
    throw new SolanaSettlementError(
      'MALFORMED_BUNDLE',
      'Solana settlement message is too short to carry a header + account keys'
    );
  }
  const requiredSignatures = messageBytes[0] as number;
  if (requiredSignatures !== 1) {
    throw new SolanaSettlementError(
      'MALFORMED_BUNDLE',
      `Solana settlement message requires ${requiredSignatures} signatures; this ` +
        `submitter signs the single fee-payer signature a claim redemption needs. ` +
        `A multi-signature message cannot be completed by the recipient alone.`
    );
  }
  const numKeys = messageBytes[MESSAGE_HEADER_SIZE] as number;
  if (numKeys < 1 || numKeys >= 0x80) {
    throw new SolanaSettlementError(
      'MALFORMED_BUNDLE',
      `Solana settlement message account count ${numKeys} is not a single-byte ` +
        `short_vec — refusing to guess the account-keys offset`
    );
  }
  const start = MESSAGE_HEADER_SIZE + 1;
  if (messageBytes.length < start + numKeys * PUBKEY_SIZE + PUBKEY_SIZE) {
    throw new SolanaSettlementError(
      'MALFORMED_BUNDLE',
      'Solana settlement message is truncated before its recent-blockhash field'
    );
  }
  return messageBytes.slice(start, start + PUBKEY_SIZE);
}

export interface BuildSolanaSettlementTransactionParams {
  /**
   * The claim recipient's 32-byte Ed25519 SEED (not the 64-byte expanded secret
   * key). `ToonClient` holds this as `solanaSeed`.
   */
  recipientSeed: Uint8Array;
  /** A live blockhash, base58 or raw 32 bytes. */
  recentBlockhash: string | Uint8Array;
}

/**
 * Turn a Solana settlement bundle into a signed, broadcastable transaction.
 *
 * PURE — no network. Patches the recent blockhash into the SDK's compiled
 * Message via the SDK's own `patchSolanaRecentBlockhash` (which derives the
 * offset from the message header rather than assuming it), signs the patched
 * bytes with the recipient key, and serializes
 * `short_vec(1) || signature(64) || message`.
 *
 * The signature MUST cover the message *after* patching: signing the placeholder
 * and then swapping the blockhash in would produce a signature over bytes that
 * are not the ones submitted, and the chain would reject it.
 */
export function buildSolanaSettlementTransaction(
  bundle: SettlementBundle,
  params: BuildSolanaSettlementTransactionParams
): SolanaSettlementTransaction {
  if (bundle.chainKind !== 'solana') {
    throw new SolanaSettlementError(
      'WRONG_CHAIN_KIND',
      `buildSolanaSettlementTransaction only handles solana bundles (got ` +
        `${bundle.chainKind} for ${bundle.chain})`
    );
  }
  if (params.recipientSeed.length !== 32) {
    throw new SolanaSettlementError(
      'NO_SIGNER',
      `Solana settlement needs the recipient's 32-byte Ed25519 seed (got ` +
        `${params.recipientSeed.length} bytes)`
    );
  }

  const feePayerBytes = readFeePayer(bundle.unsignedTxBytes);
  const signerPubkey = new Uint8Array(
    ed25519.getPublicKey(params.recipientSeed)
  );
  const feePayer = base58Encode(feePayerBytes);
  if (base58Encode(signerPubkey) !== feePayer) {
    // Fail here, loudly and locally. On chain this same mismatch surfaces as a
    // bare signature-verification failure with nothing naming the cause.
    throw new SolanaSettlementError(
      'RECIPIENT_MISMATCH',
      `Solana settlement for ${bundle.chain}/${bundle.channelId} must be signed by ` +
        `the claim recipient ${feePayer} — it is account 0 of the compiled message, ` +
        `the fee payer and the only required signer. The configured Solana key is ` +
        `${base58Encode(signerPubkey)}. This client is not the recipient of this claim.`
    );
  }

  const message = patchSolanaRecentBlockhash(
    bundle.unsignedTxBytes,
    params.recentBlockhash
  );
  const signature = new Uint8Array(ed25519.sign(message, params.recipientSeed));

  // short_vec(1) is a single 0x01 byte: exactly one signature, asserted above.
  const tx = new Uint8Array(1 + SIGNATURE_SIZE + message.length);
  tx[0] = 1;
  tx.set(signature, 1);
  tx.set(message, 1 + SIGNATURE_SIZE);

  return {
    txBase64: Buffer.from(tx).toString('base64'),
    signature: base58Encode(signature),
    recentBlockhash:
      typeof params.recentBlockhash === 'string'
        ? params.recentBlockhash
        : base58Encode(params.recentBlockhash),
    feePayer,
  };
}

/**
 * The network seam, injectable so the submit path can be exercised without a
 * validator (and so the validator test can assert on the exact calls made).
 */
export interface SolanaSettlementRpc {
  getLatestBlockhash(rpcUrl: string): Promise<string>;
  sendTransaction(rpcUrl: string, txBase64: string): Promise<string>;
  waitForConfirmation(
    rpcUrl: string,
    signature: string,
    timeoutMs?: number
  ): Promise<void>;
}

/** The real transport, shared with the channel-open path. */
export const defaultSolanaSettlementRpc: SolanaSettlementRpc = {
  getLatestBlockhash,
  async sendTransaction(rpcUrl, txBase64) {
    return (await solanaRpc(rpcUrl, 'sendTransaction', [
      txBase64,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      },
    ])) as string;
  },
  waitForConfirmation,
};

export interface SubmitSolanaSettlementParams {
  /**
   * Solana JSON-RPC endpoint. The daemon threads `solanaChannel.rpcUrl` — the
   * node the channel was opened on, which is where its PDA lives — falling back
   * to `chainRpcUrls[bundle.chain]`.
   */
  rpcUrl: string;
  /** The claim recipient's 32-byte Ed25519 seed. It pays the signature fee. */
  recipientSeed: Uint8Array;
  /** Confirmation wait bound, ms (default 30_000). */
  timeoutMs?: number;
  /** Transport override (tests). */
  rpc?: SolanaSettlementRpc;
}

export interface SubmitSolanaSettlementResult {
  /** The transaction signature, base58. */
  txHash: string;
}

/**
 * Submit a Solana settlement bundle: fetch a live blockhash, sign, broadcast,
 * and wait for confirmation.
 *
 * Throws {@link SolanaSettlementError} on every failure, including a transaction
 * that landed with an execution error — a confirmed-but-failed redemption did not
 * move the channel, and reporting it as submitted would be the same silent gap
 * this path had before.
 */
export async function submitSolanaSettlement(
  bundle: SettlementBundle,
  params: SubmitSolanaSettlementParams
): Promise<SubmitSolanaSettlementResult> {
  const rpc = params.rpc ?? defaultSolanaSettlementRpc;
  if (!params.rpcUrl) {
    throw new SolanaSettlementError(
      'NO_RPC_CONFIGURED',
      `No Solana RPC url for ${bundle.chain} — set solanaChannel.rpcUrl (or ` +
        `chainRpcUrls["${bundle.chain}"]) to enable settlement submission.`
    );
  }

  let recentBlockhash: string;
  try {
    recentBlockhash = await rpc.getLatestBlockhash(params.rpcUrl);
  } catch (err) {
    throw new SolanaSettlementError(
      'SUBMISSION_FAILED',
      `Could not read a recent blockhash from ${params.rpcUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err }
    );
  }

  const tx = buildSolanaSettlementTransaction(bundle, {
    recipientSeed: params.recipientSeed,
    recentBlockhash,
  });

  let txHash: string;
  try {
    txHash = await rpc.sendTransaction(params.rpcUrl, tx.txBase64);
  } catch (err) {
    throw new SolanaSettlementError(
      'SUBMISSION_FAILED',
      `Solana settlement for ${bundle.chain}/${bundle.channelId} (nonce ` +
        `${bundle.nonce}) was refused by ${params.rpcUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      { cause: err }
    );
  }

  try {
    await rpc.waitForConfirmation(
      params.rpcUrl,
      txHash,
      params.timeoutMs ?? 30_000
    );
  } catch (err) {
    throw new SolanaSettlementError(
      'SUBMISSION_FAILED',
      `Solana settlement ${txHash} for ${bundle.chain}/${bundle.channelId} did not ` +
        `confirm successfully: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  return { txHash };
}

/**
 * Decode the settlement instruction's `(nonce, transferredAmount)` back out of a
 * compiled bundle — the two u64s the program writes into the channel account.
 *
 * For assertions and diagnostics: it lets a test state what the transaction
 * claims to do in the program's own terms, independently of `bundle.nonce` /
 * `bundle.cumulativeAmount`, so a builder that dropped or reordered them cannot
 * pass by agreeing with itself.
 */
export function decodeSolanaSettlementClaimAmounts(bundle: SettlementBundle): {
  nonce: bigint;
  transferredAmount: bigint;
} {
  if (bundle.chainKind !== 'solana') {
    throw new SolanaSettlementError(
      'WRONG_CHAIN_KIND',
      `not a solana bundle (${bundle.chainKind})`
    );
  }
  const bytes = bundle.unsignedTxBytes;
  // The claim instruction's 24-byte data is the tail of the message:
  // `[6,0,0,0,0,0,0,0] || nonce(8 LE) || transferred_amount(8 LE)`.
  const CLAIM_DATA_SIZE = 24;
  if (bytes.length < CLAIM_DATA_SIZE) {
    throw new SolanaSettlementError(
      'MALFORMED_BUNDLE',
      'Solana settlement message is shorter than one claim instruction'
    );
  }
  const data = bytes.slice(bytes.length - CLAIM_DATA_SIZE);
  const readU64LE = (offset: number): bigint => {
    let out = 0n;
    for (let i = 0; i < 8; i++) {
      out |= BigInt(data[offset + i] as number) << BigInt(i * 8);
    }
    return out;
  };
  const discriminator = readU64LE(0);
  if (discriminator !== 6n) {
    throw new SolanaSettlementError(
      'MALFORMED_BUNDLE',
      `Solana settlement message does not end in a ClaimFromChannel instruction ` +
        `(discriminator ${discriminator}, expected 6)`
    );
  }
  return { nonce: readU64LE(8), transferredAmount: readU64LE(16) };
}
