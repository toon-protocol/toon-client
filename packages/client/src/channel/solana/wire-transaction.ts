/**
 * Solana wire transactions this client did NOT build.
 *
 * {@link import('./payment-channel.js').buildAndSendTransaction} composes a
 * transaction from instructions and signs every slot it created. This module is
 * the other half: somebody else compiled the message, and the client's only job
 * is to fill in the signature slots that are its own — and, when a fee payer
 * hands back a blockhash of its choosing, to move those 32 bytes without
 * touching anything else.
 *
 * That is the shape of a brokered transaction. In the ANT spawn the store
 * composes (it is the only party with `@ar.io/sdk`), the client signs (it is
 * the only party that may own the ANT), and the gas station pays and broadcasts
 * (it is the only party with SOL). None of the three can do the other two's
 * work, and the transaction travels between them as base64 wire bytes.
 *
 * **NEVER RECOMPILE.** The signature slots are in the compiled header's account
 * order, and the message bytes are what every signature covers, so rebuilding
 * the message from a decoded view — even into something byte-identical by
 * intent — is how a transaction arrives with signatures over a message that no
 * longer exists. Everything here is an in-place overwrite at a computed offset,
 * and {@link parseSolanaWireTransaction} exists to compute those offsets, not to
 * be a step towards re-serialization.
 *
 * The wire format (`solana-sdk`'s `Transaction`):
 *
 * ```text
 *   compact-u16  signature count            ─┐ must equal the message's
 *   64 × count   signatures, slot order      │ numRequiredSignatures
 *   ── message ──────────────────────────────┘
 *   1 byte       0x80 | version              (VERSIONED MESSAGES ONLY)
 *   3 bytes      header
 *   compact-u16  static account count
 *   32 × count   static account keys         (slot i signs for key i)
 *   32 bytes     recent blockhash            ← what patching overwrites
 *   …            instructions, address-table lookups
 * ```
 *
 * A zero-filled 64-byte slot is how "not signed yet" is spelled: `@solana/kit`'s
 * decoder reads one back as `null`, and the gas station's inspector refuses such
 * a transaction as `missing_client_signature` — a diagnosis, rather than the
 * opaque signature-verification failure a stale signature would produce.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { base58Decode, base58Encode } from '../../utils/base58.js';
import { fromBase64, toBase64 } from '../../utils/binary.js';
import type { Signer } from './payment-channel.js';

/** Bytes in one Ed25519 signature slot. */
const SIGNATURE_LENGTH = 64;
/** Bytes in a pubkey, a blockhash, and an Ed25519 seed alike. */
const PUBKEY_LENGTH = 32;
/** An Ed25519 seed — the private half of a keypair, and all of it that is stored. */
const SEED_LENGTH = 32;
/** A stored `seed ‖ pubkey` secret key, the spelling most Solana tooling writes. */
const SECRET_KEY_LENGTH = 64;
/** High bit of a message's first byte: set ⇒ versioned, clear ⇒ legacy. */
const VERSION_PREFIX_MASK = 0x80;

/**
 * A wire transaction, read but not rebuilt.
 *
 * Every field is a view onto {@link bytes}, which is the caller's transaction
 * verbatim. Nothing here is enough to re-serialize the message, deliberately.
 */
export interface SolanaWireTransaction {
  /** The whole wire transaction, unmodified. */
  bytes: Uint8Array;
  /** `'legacy'` for a message with no version prefix, else the version number. */
  version: 'legacy' | number;
  /**
   * The signature slots in COMPILED ORDER — index `i` is the key whose
   * signature belongs in slot `i`. This is the order the header fixed when the
   * message was compiled; within a role it is address-sorted rather than
   * semantic, so map a signer to a slot by ADDRESS, never by position.
   */
  signers: string[];
  /** Base58 addresses of the slots that are still 64 zero bytes. */
  unsigned: string[];
  /** Every static account key, in compiled order. `signers` is its head. */
  staticAccounts: string[];
  /** The blockhash the message currently commits to, base58. */
  recentBlockhash: string;
  /** Byte offset of the first signature slot. */
  signaturesOffset: number;
  /** Byte offset of the message — the bytes a signature covers. */
  messageOffset: number;
  /** Byte offset of the 32 blockhash bytes inside {@link bytes}. */
  recentBlockhashOffset: number;
}

/** A compact-u16 read: the value, and where the next field starts. */
function readCompactU16(
  bytes: Uint8Array,
  offset: number
): { value: number; offset: number } {
  let value = 0;
  for (let shift = 0; shift < 3; shift++) {
    const byte = bytes[offset + shift];
    if (byte === undefined) {
      throw new Error('malformed Solana transaction: truncated compact-u16');
    }
    value |= (byte & 0x7f) << (shift * 7);
    if ((byte & 0x80) === 0) return { value, offset: offset + shift + 1 };
  }
  throw new Error('malformed Solana transaction: compact-u16 exceeds three bytes');
}

/** Coerce the two spellings a wire transaction travels in to bytes. */
function toWireBytes(wire: string | Uint8Array): Uint8Array {
  return typeof wire === 'string' ? fromBase64(wire) : wire;
}

/** Answer in whatever spelling the caller handed in. */
function likeInput(wire: string | Uint8Array, bytes: Uint8Array): string | Uint8Array {
  return typeof wire === 'string' ? toBase64(bytes) : bytes;
}

/**
 * Read a base64 (or raw) wire transaction far enough to locate its signature
 * slots and its blockhash. Legacy and v0 messages both parse; the address-table
 * lookups a v0 message may carry sit AFTER everything this needs and are not
 * decoded.
 *
 * @throws {Error} when the bytes are not a transaction of the shape above —
 *   truncated, or claiming a signature count the header does not agree with.
 */
export function parseSolanaWireTransaction(
  wire: string | Uint8Array
): SolanaWireTransaction {
  const bytes = toWireBytes(wire);

  const count = readCompactU16(bytes, 0);
  const signaturesOffset = count.offset;
  const messageOffset = signaturesOffset + count.value * SIGNATURE_LENGTH;
  if (messageOffset > bytes.length) {
    throw new Error(
      `malformed Solana transaction: ${count.value} signature slots do not fit in ${bytes.length} bytes`
    );
  }

  const prefix = bytes[messageOffset];
  if (prefix === undefined) {
    throw new Error('malformed Solana transaction: no message after the signatures');
  }
  const versioned = (prefix & VERSION_PREFIX_MASK) !== 0;
  const version = versioned ? prefix & ~VERSION_PREFIX_MASK : 'legacy';
  const headerOffset = messageOffset + (versioned ? 1 : 0);

  const numRequiredSignatures = bytes[headerOffset];
  if (numRequiredSignatures === undefined) {
    throw new Error('malformed Solana transaction: truncated message header');
  }
  if (numRequiredSignatures !== count.value) {
    throw new Error(
      `malformed Solana transaction: ${count.value} signature slots but the header requires ${numRequiredSignatures}`
    );
  }

  const accountCount = readCompactU16(bytes, headerOffset + 3);
  const keysOffset = accountCount.offset;
  const recentBlockhashOffset = keysOffset + accountCount.value * PUBKEY_LENGTH;
  if (recentBlockhashOffset + PUBKEY_LENGTH > bytes.length) {
    throw new Error(
      `malformed Solana transaction: ${accountCount.value} account keys and a blockhash do not fit in ${bytes.length} bytes`
    );
  }
  if (numRequiredSignatures > accountCount.value) {
    throw new Error(
      `malformed Solana transaction: header requires ${numRequiredSignatures} signatures but the message names only ${accountCount.value} accounts`
    );
  }

  const staticAccounts: string[] = [];
  for (let i = 0; i < accountCount.value; i++) {
    const start = keysOffset + i * PUBKEY_LENGTH;
    staticAccounts.push(base58Encode(bytes.slice(start, start + PUBKEY_LENGTH)));
  }

  const signers = staticAccounts.slice(0, numRequiredSignatures);
  const unsigned = signers.filter((_signer, slot) => {
    const start = signaturesOffset + slot * SIGNATURE_LENGTH;
    return bytes
      .subarray(start, start + SIGNATURE_LENGTH)
      .every((byte) => byte === 0);
  });

  return {
    bytes,
    version,
    signers,
    unsigned,
    staticAccounts,
    recentBlockhash: base58Encode(
      bytes.slice(recentBlockhashOffset, recentBlockhashOffset + PUBKEY_LENGTH)
    ),
    signaturesOffset,
    messageOffset,
    recentBlockhashOffset,
  };
}

/**
 * Overwrite a compiled message's recent blockhash in place, and **clear every
 * signature slot**.
 *
 * The gas station quotes a blockhash of its own and then refuses any execute
 * whose transaction does not carry it (`blockhash_mismatch`), so a client that
 * has already been handed a draft has two ways to comply: ask the composer to
 * prepare the same transaction again against the quoted blockhash, or move the
 * 32 bytes itself. This is the second, and it makes step 5 of the ceremony
 * local — one round trip fewer inside a 60-second quote TTL.
 *
 * Clearing the signatures is not a side effect, it is the point. Those 32 bytes
 * are inside the message every signature covers, so a signature made before the
 * patch is now a signature over a message that no longer exists. Left in place
 * it would fail signature verification at the validator with nothing pointing at
 * the cause; zeroed, the slot means exactly what an unsigned slot means
 * everywhere else on this path, and the gas station names it
 * (`missing_client_signature`) before spending anything. **Sign after patching,
 * never before.**
 *
 * @param wire - The transaction, base64 or raw bytes.
 * @param recentBlockhash - Base58, exactly as the quote returned it.
 * @returns The patched transaction, in the spelling `wire` arrived in.
 * @throws {Error} when `recentBlockhash` is not 32 bytes of base58.
 */
export function patchSolanaRecentBlockhash(wire: string, recentBlockhash: string): string;
export function patchSolanaRecentBlockhash(
  wire: Uint8Array,
  recentBlockhash: string
): Uint8Array;
export function patchSolanaRecentBlockhash(
  wire: string | Uint8Array,
  recentBlockhash: string
): string | Uint8Array {
  const blockhash = base58Decode(recentBlockhash);
  if (blockhash.length !== PUBKEY_LENGTH) {
    throw new Error(
      `recentBlockhash must decode to ${PUBKEY_LENGTH} bytes, got ${blockhash.length} from ${JSON.stringify(recentBlockhash)}`
    );
  }

  const parsed = parseSolanaWireTransaction(wire);
  const patched = new Uint8Array(parsed.bytes);
  patched.set(blockhash, parsed.recentBlockhashOffset);
  patched.fill(
    0,
    parsed.signaturesOffset,
    parsed.signaturesOffset + parsed.signers.length * SIGNATURE_LENGTH
  );

  return likeInput(wire, patched);
}

/**
 * Sign a supplied wire transaction in place: for each key in `signers` that the
 * compiled header names, write its Ed25519 signature over the message bytes
 * into that key's own slot. Slots belonging to nobody in `signers` — the fee
 * payer's, above all — are left exactly as they were.
 *
 * Slots are matched by ADDRESS. A receipt's `requiredSigners` is address-sorted
 * within a role and carries no semantics, so "the mint is second" is a fact
 * about one particular pair of keys and not about the transaction shape.
 *
 * @param wire - The transaction, base64 or raw bytes.
 * @param signers - Keypairs to sign with; each `privateKey` is a 32-byte seed.
 * @returns The signed transaction, in the spelling `wire` arrived in.
 * @throws {Error} when a supplied signer is not one of the message's required
 *   signers — signing with a key the transaction never asked for means the
 *   caller built or patched the wrong thing, and silently doing nothing would
 *   surface much later as `missing_client_signature`.
 */
export function signSolanaWireTransaction(wire: string, signers: Signer[]): string;
export function signSolanaWireTransaction(
  wire: Uint8Array,
  signers: Signer[]
): Uint8Array;
export function signSolanaWireTransaction(
  wire: string | Uint8Array,
  signers: Signer[]
): string | Uint8Array {
  const parsed = parseSolanaWireTransaction(wire);
  const signed = new Uint8Array(parsed.bytes);
  const message = signed.subarray(parsed.messageOffset);

  for (const signer of signers) {
    const address = base58Encode(signer.publicKey);
    const slot = parsed.signers.indexOf(address);
    if (slot === -1) {
      throw new Error(
        `${address} is not a required signer of this transaction (slots: ${parsed.signers.join(', ')})`
      );
    }
    signed.set(
      ed25519.sign(message, signer.privateKey),
      parsed.signaturesOffset + slot * SIGNATURE_LENGTH
    );
  }

  return likeInput(wire, signed);
}

/**
 * A fresh Ed25519 keypair.
 *
 * The ANT spawn needs one per attempt: its public half goes to the store as the
 * MPL Core asset address — which becomes the ANT's address, and the `processId`
 * the follow-up name purchase wants — and its private half signs one slot of one
 * transaction. Nothing needs it afterwards, so it is generated, used, and
 * dropped rather than derived from the user's phrase, where it would be one more
 * key to keep and to lose.
 */
export function generateSolanaKeypair(): Signer & { address: string } {
  return keypairFromSeed(randomBytes(SEED_LENGTH));
}

/**
 * The keypair a stored or derived Solana secret represents — a 32-byte seed or
 * a 64-byte `seed ‖ pubkey` secret key, as bytes or base58.
 *
 * The public half is DERIVED, never read out of the trailing 32 bytes: a
 * 64-byte input whose tail disagrees with its own seed is a corrupt file, and
 * honouring it would fill a signature slot addressed to a key that did not sign
 * it. Mirrors the rule `ToonClient`'s own config applies to `solanaSecretKey`.
 */
export function solanaKeypair(
  key: string | Uint8Array
): Signer & { address: string } {
  const bytes = typeof key === 'string' ? base58Decode(key.trim()) : key;
  if (bytes.length !== SEED_LENGTH && bytes.length !== SECRET_KEY_LENGTH) {
    throw new Error(
      `a Solana secret must be a ${SEED_LENGTH}-byte seed or a ${SECRET_KEY_LENGTH}-byte ` +
        `secret key; got ${bytes.length} bytes`
    );
  }
  return keypairFromSeed(bytes.slice(0, SEED_LENGTH));
}

/** The one place a seed becomes a keypair, so both entry points agree. */
function keypairFromSeed(seed: Uint8Array): Signer & { address: string } {
  const publicKey = new Uint8Array(ed25519.getPublicKey(seed));
  return { privateKey: seed, publicKey, address: base58Encode(publicKey) };
}
