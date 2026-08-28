/**
 * One BIP-39 phrase → an EVM key and a Solana key.
 *
 * ## Which path an EVM key comes from
 *
 * There are two, and the difference is historical rather than cryptographic.
 *
 * - **`standard`** — `m/44'/60'/0'/0/{accountIndex}`, BIP-44's registered coin
 *   type for Ethereum. This is what every wallet derives, so the same phrase
 *   typed into MetaMask or a hardware wallet produces the same address: the
 *   channel wallet can be inspected, topped up or swept without this package.
 *   New keystores use it.
 *
 * - **`legacy`** — `m/44'/1237'/0'/0/{accountIndex}`, Nostr's coin type. Before
 *   1.0 this client derived one secp256k1 key and used it for both a Nostr
 *   identity and an EVM account, so the EVM key sat on Nostr's path. The Nostr
 *   half is gone, but the addresses are not: they hold channels with real
 *   collateral. A keystore written before 1.0 records no scheme and is read as
 *   `legacy`, so nothing moves under an existing deployment.
 *
 * Solana is unaffected — `m/44'/501'/{accountIndex}'/0'`, SLIP-0010, all
 * hardened, which is what Phantom and the Solana CLI derive.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import {
  generateMnemonic as _genMnemonic,
  validateMnemonic as _validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58Encode } from '../utils/base58.js';
import type { DerivedIdentity } from './types.js';

/** How a mnemonic becomes an EVM key. See this module's own docs. */
export type KeyDerivationScheme = 'standard' | 'legacy';

/** BIP-44 coin type 60: Ethereum, and every EVM chain by convention. */
const EVM_COIN_TYPE_STANDARD = 60;
/** BIP-44 coin type 1237: Nostr. What this client used before 1.0. */
const EVM_COIN_TYPE_LEGACY = 1237;

/** Generate a new 12-word BIP-39 mnemonic. */
export function generateMnemonic(): string {
  return _genMnemonic(english, 128);
}

/** Is this a well-formed BIP-39 phrase with a valid checksum? */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, english);
}

/** Maximum valid BIP-32 non-hardened child index (2^31 − 1). */
const MAX_BIP32_INDEX = 0x7fffffff;

function assertValidAccountIndex(accountIndex: number): void {
  if (
    !Number.isInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_BIP32_INDEX
  ) {
    throw new Error(
      `accountIndex must be an integer in [0, ${MAX_BIP32_INDEX}]; got ${String(accountIndex)}`
    );
  }
}

/** The BIP-44 path an EVM key is derived at, under a given scheme. */
export function evmDerivationPath(
  scheme: KeyDerivationScheme,
  accountIndex = 0
): string {
  const coinType =
    scheme === 'legacy' ? EVM_COIN_TYPE_LEGACY : EVM_COIN_TYPE_STANDARD;
  return `m/44'/${String(coinType)}'/0'/0/${String(accountIndex)}`;
}

function deriveEvmKey(
  seed: Uint8Array,
  scheme: KeyDerivationScheme,
  accountIndex: number
): DerivedIdentity['evm'] {
  const child = HDKey.fromMasterSeed(seed).derive(
    evmDerivationPath(scheme, accountIndex)
  );
  if (!child.privateKey) {
    throw new Error('Failed to derive an EVM private key from the seed');
  }
  return evmIdentityFromKey(new Uint8Array(child.privateKey));
}

/** The account an existing secp256k1 secret belongs to. */
export function evmIdentityFromKey(
  privateKey: Uint8Array
): DerivedIdentity['evm'] {
  const account = privateKeyToAccount(toHex(privateKey));
  return { privateKey, address: account.address };
}

/**
 * SLIP-0010 Ed25519 derivation at `m/44'/501'/{accountIndex}'/0'`.
 *
 * Ed25519 has no non-hardened derivation, so every level is hardened and the
 * chain code is carried by hand rather than through `HDKey` (which implements
 * BIP-32 for secp256k1).
 */
function deriveSolanaKey(
  seed: Uint8Array,
  accountIndex: number
): DerivedIdentity['solana'] {
  const encoder = new TextEncoder();
  let I = hmac(sha512, encoder.encode('ed25519 seed'), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

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
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;

    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  const publicKeyBytes = ed25519.getPublicKey(key);
  // A Solana secret key is the 32-byte seed followed by its public key.
  const keypair = new Uint8Array(64);
  keypair.set(key, 0);
  keypair.set(publicKeyBytes, 32);

  return { secretKey: keypair, publicKey: base58Encode(publicKeyBytes) };
}

export interface DeriveIdentityOptions {
  accountIndex?: number;
  /** Default `'standard'`. */
  scheme?: KeyDerivationScheme;
}

/**
 * Derive both chain keys from a mnemonic.
 *
 * The seed is zeroed before returning; the derived keys are not, because they
 * are the return value.
 */
export function deriveFullIdentity(
  mnemonic: string,
  options: DeriveIdentityOptions | number = {}
): DerivedIdentity {
  // `deriveFullIdentity(mnemonic, 3)` used to mean account index 3.
  const opts: DeriveIdentityOptions =
    typeof options === 'number' ? { accountIndex: options } : options;
  const accountIndex = opts.accountIndex ?? 0;
  const scheme = opts.scheme ?? 'standard';
  assertValidAccountIndex(accountIndex);

  const seed = mnemonicToSeedSync(mnemonic);
  try {
    return {
      evm: deriveEvmKey(seed, scheme, accountIndex),
      solana: deriveSolanaKey(seed, accountIndex),
    };
  } finally {
    seed.fill(0);
  }
}

/**
 * A random identity, for tests and ephemeral use. The keys are unrelated to
 * each other and to any mnemonic, so nothing here can be recovered from a
 * phrase — generate a mnemonic instead if the keys need to outlive the process.
 */
export function generateRandomIdentity(): DerivedIdentity {
  const evmKey = secp256k1.utils.randomSecretKey();
  const solanaSeed = ed25519.utils.randomSecretKey();
  const solanaPublic = ed25519.getPublicKey(solanaSeed);
  const keypair = new Uint8Array(64);
  keypair.set(solanaSeed, 0);
  keypair.set(solanaPublic, 32);
  return {
    evm: evmIdentityFromKey(evmKey),
    solana: { secretKey: keypair, publicKey: base58Encode(solanaPublic) },
  };
}
