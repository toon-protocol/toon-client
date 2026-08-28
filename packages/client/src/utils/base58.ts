/**
 * Base58 (Bitcoin alphabet) — the encoding every Solana address, program id,
 * mint and signature-free pubkey arrives in.
 *
 * A thin wrapper over `@scure/base` rather than a hand-rolled implementation:
 * the same audited primitive already sits under `@scure/bip32`, so this adds no
 * install weight, and base58 decoding is exactly the kind of loop where a
 * hand-rolled version is wrong only for inputs you did not test.
 *
 * Replaces `@toon-protocol/core`'s `base58Encode`/`base58Decode`.
 */
import { base58 } from '@scure/base';

/** Encode raw bytes as base58. */
export function base58Encode(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

/**
 * Decode base58 text to raw bytes.
 *
 * Throws on any character outside the alphabet — a Solana pubkey that fails to
 * decode is a caller error worth surfacing, never something to coerce.
 */
export function base58Decode(text: string): Uint8Array {
  return base58.decode(text);
}
