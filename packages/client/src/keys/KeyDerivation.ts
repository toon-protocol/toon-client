import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import {
  generateMnemonic as _genMnemonic,
  validateMnemonic as _validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { hexToMinaBase58PrivateKey } from '@toon-protocol/core';
import type { ToonIdentity } from './types.js';

/**
 * Generate a new 12-word BIP-39 mnemonic.
 */
export function generateMnemonic(): string {
  return _genMnemonic(english, 128);
}

/**
 * Validate a BIP-39 mnemonic phrase.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, english);
}

/**
 * Maximum valid BIP-32 non-hardened child index (2^31 - 1).
 * Values at or above 2^31 are reserved for hardened derivation.
 */
const MAX_BIP32_INDEX = 0x7fffffff;

/**
 * Validate a BIP-44 account index. Mirrors the SDK's `fromMnemonic` guard so
 * the client and SDK reject the same out-of-range indices.
 */
function assertValidAccountIndex(accountIndex: number): void {
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_BIP32_INDEX
  ) {
    throw new Error(
      `Invalid accountIndex: expected a non-negative integer (0 to ${MAX_BIP32_INDEX}), got ${String(accountIndex)}`
    );
  }
}

/**
 * Derive the Nostr secp256k1 key from mnemonic using NIP-06 path:
 * m/44'/1237'/0'/0/{accountIndex}. At accountIndex 0 this is the canonical
 * m/44'/1237'/0'/0/0, matching the SDK's `fromMnemonic`/`fromMnemonicFull`.
 */
function deriveNostrKey(
  seed: Uint8Array,
  accountIndex = 0
): {
  secretKey: Uint8Array;
  pubkey: string;
} {
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(`m/44'/1237'/0'/0/${accountIndex}`);
  if (!child.privateKey) {
    throw new Error('Failed to derive Nostr private key from seed');
  }
  const secretKey = new Uint8Array(child.privateKey);
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey };
}

/**
 * Derive the EVM address from the same secp256k1 key (shares curve with Nostr).
 */
function deriveEvmIdentity(secretKey: Uint8Array): {
  privateKey: Uint8Array;
  address: string;
} {
  const account = privateKeyToAccount(toHex(secretKey));
  return {
    privateKey: secretKey,
    address: account.address,
  };
}

/**
 * Derive Solana Ed25519 keypair using SLIP-0010 path:
 * m/44'/501'/{accountIndex}'/0' (all hardened). At accountIndex 0 this is the
 * canonical m/44'/501'/0'/0', matching the SDK's `deriveSolanaIdentity`.
 * Dynamically imports @noble/curves for Ed25519 operations.
 */
async function deriveSolanaKey(
  seed: Uint8Array,
  accountIndex = 0
): Promise<{
  secretKey: Uint8Array;
  publicKey: string;
}> {
  // SLIP-0010 Ed25519 derivation (hardened only)
  // Uses HMAC-SHA512 with "ed25519 seed" as key
  const { hmac } = await import('@noble/hashes/hmac');
  const { sha512 } = await import('@noble/hashes/sha512');
  const { ed25519 } = await import('@noble/curves/ed25519.js');

  // SLIP-0010 master key derivation for ed25519
  const encoder = new TextEncoder();
  let I = hmac(sha512, encoder.encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  // Derive path: m/44'/501'/{accountIndex}'/0' (all hardened)
  const indices = [
    0x8000002c, // 44'
    0x800001f5, // 501'
    (0x80000000 + accountIndex) >>> 0, // {accountIndex}'
    0x80000000, // 0'
  ];

  for (const index of indices) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    // Write index as big-endian uint32
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;

    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  const publicKeyBytes: Uint8Array = ed25519.getPublicKey(key);

  // Solana keypair = 32-byte private key + 32-byte public key = 64 bytes
  const keypair = new Uint8Array(64);
  keypair.set(key, 0);
  keypair.set(publicKeyBytes, 32);

  // Base58 encode the public key
  const publicKey = toBase58(publicKeyBytes);

  return { secretKey: keypair, publicKey };
}

/**
 * Derive Mina Pallas key using path: m/44'/12586'/{accountIndex}'/0/0. At
 * accountIndex 0 this is the canonical m/44'/12586'/0'/0/0, matching the SDK's
 * `deriveMinaIdentity`.
 * Dynamically imports mina-signer.
 */
async function deriveMinaKey(
  seed: Uint8Array,
  accountIndex = 0
): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const master = HDKey.fromMasterSeed(seed);
  // Mina coin type = 12586 (0x312A)
  const child = master.derive(`m/44'/12586'/${accountIndex}'/0/0`);
  if (!child.privateKey) {
    throw new Error('Failed to derive Mina private key from seed');
  }
  const keyBytes = new Uint8Array(child.privateKey);

  // Clamp the top 2 bits so the scalar is within the Pallas base-field order
  // (matches @toon-protocol/mill's `deriveMillKeys`). Without this, the raw
  // BIP-32 child scalar can exceed the field order and mina-signer rejects it.
  keyBytes[0] = (keyBytes[0] ?? 0) & 0x3f;

  // mina-signer needs the Mina base58check (`EK…`) private-key format, NOT a
  // raw hex scalar (raw hex fails with "invalid checksum"). Convert via the
  // shared @toon-protocol/core helper before deriving the public key.
  try {
    const MinaSignerLib = await import('mina-signer');
    const Client =
      'default' in MinaSignerLib ? MinaSignerLib.default : MinaSignerLib;
    const client = new Client({ network: 'mainnet' });

    const hexKey = Array.from(keyBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const minaPrivateKey = hexToMinaBase58PrivateKey(hexKey);
    const publicKey = client.derivePublicKey(minaPrivateKey);
    return {
      // Store the clamped big-endian hex scalar; consumers (e.g. the client's
      // MinaSigner) re-convert to base58check via hexToMinaBase58PrivateKey.
      privateKey: hexKey,
      publicKey,
    };
  } catch {
    throw new Error(
      'mina-signer is required for Mina key derivation. Install it as an optional dependency.'
    );
  }
}

/**
 * Synchronously derive ONLY the Nostr secp256k1 key (NIP-06) from a mnemonic.
 *
 * The EVM key shares this same secp256k1 key. Solana (Ed25519) and Mina
 * (Pallas) require async dynamic imports — use {@link deriveFullIdentity} for
 * those. This sync subset exists so `ToonClient`'s synchronous constructor can
 * resolve the Nostr/EVM identity from a `mnemonic` config field without an
 * async factory; the client derives Solana/Mina lazily in `start()`.
 */
export function deriveNostrKeyFromMnemonic(
  mnemonic: string,
  accountIndex = 0
): {
  secretKey: Uint8Array;
  pubkey: string;
} {
  assertValidAccountIndex(accountIndex);
  const seed = mnemonicToSeedSync(mnemonic);
  const result = deriveNostrKey(seed, accountIndex);
  seed.fill(0); // Zero seed after derivation (F7 fix)
  return result;
}

/**
 * Derive a full multi-chain ToonIdentity from a BIP-39 mnemonic.
 *
 * All four chains vary by `accountIndex` (default 0), matching the SDK's
 * {@link https://www.npmjs.com/package/@toon-protocol/sdk `fromMnemonicFull`}
 * path-per-index scheme so a non-zero index produces the SAME addresses as
 * `fromMnemonicFull(mnemonic, { accountIndex })`. Index 0 is unchanged from the
 * historical fixed paths (back-compat).
 *
 * Chains derived:
 * - Nostr (secp256k1): m/44'/1237'/0'/0/{accountIndex}
 * - EVM (secp256k1): same key as Nostr
 * - Solana (Ed25519): m/44'/501'/{accountIndex}'/0' (SLIP-0010)
 * - Mina (Pallas): m/44'/12586'/{accountIndex}'/0/0
 *
 * @param mnemonic - A valid BIP-39 mnemonic (12 or 24 words).
 * @param accountIndex - BIP-44 account index (default 0).
 */
export async function deriveFullIdentity(
  mnemonic: string,
  accountIndex = 0
): Promise<ToonIdentity> {
  assertValidAccountIndex(accountIndex);
  const seed = mnemonicToSeedSync(mnemonic);

  const nostr = deriveNostrKey(seed, accountIndex);
  const evm = deriveEvmIdentity(nostr.secretKey);

  // Solana and Mina can fail if optional deps are missing — derive independently
  let solana: ToonIdentity['solana'];
  try {
    solana = await deriveSolanaKey(seed, accountIndex);
  } catch {
    solana = { secretKey: new Uint8Array(64), publicKey: '' };
  }

  let mina: ToonIdentity['mina'];
  try {
    mina = await deriveMinaKey(seed, accountIndex);
  } catch {
    mina = { privateKey: '', publicKey: '' };
  }

  // Zero seed after derivation (F7 fix)
  seed.fill(0);

  return { nostr, evm, solana, mina };
}

/**
 * Derive a partial identity from an nsec (Nostr-only private key).
 * Nostr + EVM share the same secp256k1 key.
 * Solana and Mina get empty placeholders (not deterministically linked).
 */
export function deriveFromNsec(secretKey: Uint8Array): ToonIdentity {
  // Copy input to avoid caller mutation corrupting identity keys
  const keyCopy = new Uint8Array(secretKey);
  const pubkey = getPublicKey(keyCopy);
  const evm = deriveEvmIdentity(keyCopy);

  return {
    nostr: { secretKey: keyCopy, pubkey },
    evm,
    solana: { secretKey: new Uint8Array(64), publicKey: '' },
    mina: { privateKey: '', publicKey: '' },
  };
}

/**
 * Generate a random identity (no mnemonic — for testing or ephemeral use).
 */
export function generateRandomIdentity(): ToonIdentity {
  const secretKey = generateSecretKey();
  return deriveFromNsec(secretKey);
}

// --- Utility ---

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) num = num * 256n + BigInt(b);
  let result = '';
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = '1' + result;
    else break;
  }
  return result;
}
