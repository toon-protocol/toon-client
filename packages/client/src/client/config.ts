/**
 * Turning a {@link ToonClientConfig} into the settled facts the rest of the
 * client runs on: validated, defaulted, keys derived, store opened.
 *
 * Everything here happens **before** any network or chain access, and that is
 * the point. `ToonClient.create` must not touch a chain (a client that opened an
 * RPC connection to be constructed could not be constructed offline, and a CLI
 * that only wants to print an address should not pay for one), so every question
 * that can be answered from the configuration alone is answered here, once, and
 * the answers are immutable afterwards.
 *
 * Two questions deliberately are NOT answered here, because their answer belongs
 * to the connector rather than to the caller: **which chain** to settle on, and
 * **what a route costs**. Both come from the node's own `GET /ilp`
 * (`self-description-spec.md` ND-07 — the node proved each settlement fact
 * against a live chain at boot), so this module records a *preference* for the
 * chain and nothing at all for the price.
 */
import { deriveFullIdentity, evmIdentityFromKey } from '../keys/KeyDerivation.js';
import { base58Decode, base58Encode } from '../utils/base58.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { connectorEdgeBaseUrl } from '../connector/ConnectorEdgeClient.js';
import {
  InMemoryChannelStore,
  JsonFileChannelStore,
  type ChannelStore,
} from '../channel/ChannelStore.js';
import { DEVNET, defaultRpcUrl } from '../presets.js';
import { ConfigError } from './errors.js';
import type {
  ChainKind,
  KeyDerivationScheme,
  ToonClientConfig,
  TransportPreference,
} from './types.js';

/** Per-packet timeout when the caller sets none. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Collateral for the first channel, base units — 0.1 USDC at 6 decimals. */
export const DEFAULT_DEPOSIT = 100_000n;
/** Challenge period in seconds when the caller sets none. */
export const DEFAULT_SETTLEMENT_TIMEOUT = 86_400;

/** The keys this client holds, per chain. Absent means "no key for that chain". */
export interface ResolvedIdentity {
  evm?: { privateKey: Uint8Array; address: string };
  solana?: { secretKey: Uint8Array; publicKey: string };
}

/**
 * A configuration with every question answered that could be answered without
 * asking anybody. Frozen: a client's identity, store and endpoint do not change
 * under it after construction.
 */
export interface ResolvedConfig {
  /** The client-edge base URL, with any trailing `/ilp` normalised away. */
  connector: string;
  identity: ResolvedIdentity;
  /** The caller's chain preference, or `undefined` to take the node's first. */
  chain: ChainKind | undefined;
  /** RPC URL per chain: an explicit `rpcUrl` overrides both; else this package's preset. */
  rpcUrls: Record<ChainKind, string>;
  transport: TransportPreference;
  /** An explicit `senderId`, or `undefined` to use the selected chain's address. */
  senderId: string | undefined;
  deposit: bigint;
  settlementTimeout: number;
  autoOpenChannel: boolean;
  timeoutMs: number;
  channelStore: ChannelStore;
  /** True when the store is the in-memory fallback rather than one the caller chose. */
  channelStoreIsEphemeral: boolean;
  btp: {
    maxReconnectAttempts?: number;
    reconnectDelay?: number;
    declareChannel: boolean;
  };
  faucetUrl: string;
  fetch: typeof fetch;
  createWebSocket: ((url: string) => unknown) | undefined;
  keyDerivation: KeyDerivationScheme;
  accountIndex: number;
}

/**
 * Validate, derive and default.
 *
 * @throws {ConfigError} for anything a caller must fix: no connector, no key
 *   material, a connector that is not a URL, a negative deposit, key bytes of
 *   the wrong length. Every one of these would otherwise surface much later as
 *   an unexplained refusal or an unhandled exception mid-send.
 */
export function resolveConfig(config: ToonClientConfig): ResolvedConfig {
  const connector = resolveConnector(config.connector);
  const accountIndex = resolveAccountIndex(config.accountIndex);
  const keyDerivation = config.keyDerivation ?? 'standard';
  const identity = resolveIdentity(config, keyDerivation, accountIndex);

  if (config.chain !== undefined && config.chain !== 'evm' && config.chain !== 'solana') {
    throw new ConfigError(
      `chain must be 'evm' or 'solana'; got ${JSON.stringify(config.chain)}.`
    );
  }
  if (config.chain !== undefined && identity[config.chain] === undefined) {
    throw new ConfigError(
      `chain is set to '${config.chain}', but this client holds no ${config.chain} ` +
        'key. Supply a mnemonic (which derives both), or the raw key for that chain.'
    );
  }

  const transport = config.transport ?? 'auto';
  if (transport !== 'auto' && transport !== 'http' && transport !== 'btp') {
    throw new ConfigError(
      `transport must be 'auto', 'http' or 'btp'; got ${JSON.stringify(transport)}.`
    );
  }

  const deposit = resolveDeposit(config.deposit);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`timeoutMs must be a positive number; got ${String(timeoutMs)}.`);
  }

  const settlementTimeout = config.settlementTimeout ?? DEFAULT_SETTLEMENT_TIMEOUT;
  if (!Number.isInteger(settlementTimeout) || settlementTimeout <= 0) {
    throw new ConfigError(
      `settlementTimeout must be a positive whole number of seconds; got ${String(
        settlementTimeout
      )}.`
    );
  }

  const { channelStore, channelStoreIsEphemeral } = resolveChannelStore(config.channelStore);

  const rpcUrls: Record<ChainKind, string> = {
    evm: config.rpcUrl ?? defaultRpcUrl('evm'),
    solana: config.rpcUrl ?? defaultRpcUrl('solana'),
  };

  return {
    connector,
    identity,
    chain: config.chain,
    rpcUrls,
    transport,
    senderId: config.senderId,
    deposit,
    settlementTimeout,
    autoOpenChannel: config.autoOpenChannel ?? true,
    timeoutMs,
    channelStore,
    channelStoreIsEphemeral,
    btp: {
      ...(config.btp?.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: config.btp.maxReconnectAttempts }
        : {}),
      ...(config.btp?.reconnectDelay !== undefined
        ? { reconnectDelay: config.btp.reconnectDelay }
        : {}),
      declareChannel: config.btp?.declareChannel ?? true,
    },
    faucetUrl: config.faucetUrl ?? DEVNET.faucet,
    fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
    createWebSocket: config.createWebSocket,
    keyDerivation,
    accountIndex,
  };
}

/** This client's address on `chain`, or `undefined` when it holds no key there. */
export function addressFor(
  identity: ResolvedIdentity,
  chain: ChainKind
): string | undefined {
  return chain === 'evm' ? identity.evm?.address : identity.solana?.publicKey;
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

function resolveConnector(connector: string | undefined): string {
  if (typeof connector !== 'string' || connector.trim().length === 0) {
    throw new ConfigError(
      'connector is required: the client-edge URL of the node to pay, e.g. ' +
        `'${DEVNET.store.url}'. One free GET on it returns every other fact ` +
        'needed to transact (self-description-spec.md, connector ADR 0050).'
    );
  }
  let base: string;
  try {
    base = connectorEdgeBaseUrl(connector.trim());
  } catch (error) {
    throw new ConfigError(
      `connector ${JSON.stringify(connector)} is not a URL.`,
      error instanceof Error ? error : undefined
    );
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new ConfigError(
      `connector ${JSON.stringify(connector)} must be an http(s) URL; got ${JSON.stringify(base)}.`
    );
  }
  return base;
}

function resolveAccountIndex(accountIndex: number | undefined): number {
  const index = accountIndex ?? 0;
  if (!Number.isInteger(index) || index < 0) {
    throw new ConfigError(
      `accountIndex must be a non-negative whole number; got ${String(accountIndex)}.`
    );
  }
  return index;
}

function resolveDeposit(deposit: bigint | string | undefined): bigint {
  if (deposit === undefined) return DEFAULT_DEPOSIT;
  let value: bigint;
  try {
    value = typeof deposit === 'bigint' ? deposit : BigInt(deposit);
  } catch {
    throw new ConfigError(
      `deposit must be a whole number of base units; got ${JSON.stringify(deposit)}.`
    );
  }
  if (value < 0n) throw new ConfigError('deposit cannot be negative.');
  return value;
}

/**
 * Derive both chain keys from the mnemonic, or take whichever raw keys were
 * supplied. A raw key WINS over the mnemonic's for its own chain, so a caller
 * can hold a phrase for one chain and a hardware-exported key for the other.
 */
function resolveIdentity(
  config: ToonClientConfig,
  scheme: KeyDerivationScheme,
  accountIndex: number
): ResolvedIdentity {
  const identity: ResolvedIdentity = {};

  if (config.mnemonic !== undefined) {
    if (typeof config.mnemonic !== 'string' || config.mnemonic.trim().length === 0) {
      throw new ConfigError('mnemonic must be a non-empty BIP-39 phrase.');
    }
    let derived;
    try {
      derived = deriveFullIdentity(config.mnemonic.trim(), { accountIndex, scheme });
    } catch (error) {
      throw new ConfigError(
        'mnemonic is not a valid BIP-39 phrase (check the word list and the ' +
          'checksum — a single mistyped word fails it).',
        error instanceof Error ? error : undefined
      );
    }
    identity.evm = derived.evm;
    identity.solana = derived.solana;
  }

  if (config.evmPrivateKey !== undefined) {
    identity.evm = evmIdentityFromKey(readEvmKey(config.evmPrivateKey));
  }
  if (config.solanaSecretKey !== undefined) {
    identity.solana = readSolanaKey(config.solanaSecretKey);
  }

  if (identity.evm === undefined && identity.solana === undefined) {
    throw new ConfigError(
      'No key material: supply a `mnemonic` (which derives both an EVM and a ' +
        'Solana key), or a raw `evmPrivateKey` / `solanaSecretKey`. A claim is ' +
        'authorised by its signature against the channel\'s on-chain counterparty ' +
        'and by nothing else (connector ADR 0052), so there is no unauthenticated ' +
        'way to pay.'
    );
  }
  return identity;
}

/** A 32-byte secp256k1 secret, from bytes or `0x`-prefixed hex. */
function readEvmKey(key: string | Uint8Array): Uint8Array {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) {
      throw new ConfigError(
        `evmPrivateKey must be 32 bytes; got ${key.length}.`
      );
    }
    return key;
  }
  const hex = key.startsWith('0x') || key.startsWith('0X') ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ConfigError(
      'evmPrivateKey must be 32 bytes of hex (64 characters, optionally 0x-prefixed).'
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * A Solana keypair from a 32-byte seed or a 64-byte `seed ‖ pubkey` secret key,
 * as bytes or base58.
 *
 * Both lengths are accepted because both are in circulation: `solana-keygen`
 * writes the 64-byte form, while a BIP-39 derivation yields the 32-byte seed the
 * public half is computed from. Either way the seed is the first 32 bytes and the
 * public key is DERIVED rather than trusted — a 64-byte input whose trailing half
 * disagrees with its own seed is a corrupt file, and honouring it would produce
 * claims signed by one key and addressed to another.
 */
function readSolanaKey(key: string | Uint8Array): {
  secretKey: Uint8Array;
  publicKey: string;
} {
  let bytes: Uint8Array;
  if (key instanceof Uint8Array) {
    bytes = key;
  } else {
    try {
      bytes = base58Decode(key.trim());
    } catch (error) {
      throw new ConfigError(
        'solanaSecretKey is not valid base58.',
        error instanceof Error ? error : undefined
      );
    }
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new ConfigError(
      `solanaSecretKey must be a 32-byte seed or a 64-byte secret key; got ${bytes.length} bytes.`
    );
  }
  const seed = bytes.slice(0, 32);
  const publicKeyBytes = new Uint8Array(ed25519.getPublicKey(seed));
  const secretKey = new Uint8Array(64);
  secretKey.set(seed, 0);
  secretKey.set(publicKeyBytes, 32);
  return { secretKey, publicKey: base58Encode(publicKeyBytes) };
}

/**
 * Open the channel store.
 *
 * A string is a file path; a store object is used as given; and **nothing at all
 * gets an in-memory store and a warning**. The warning is not boilerplate: the
 * store holds the channel's nonce watermark, a claim must strictly advance the
 * nonce the connector has already banked (`client-edge-spec.md` §1.3 step 2), and
 * an in-memory watermark dies with the process. A restarted client re-signs from
 * nonce 1 on a channel the connector has banked hundreds of claims on, and every
 * one of those claims is refused `F01` — with the collateral still locked. The
 * default exists so a first script runs without ceremony, not because it is safe
 * to keep.
 */
function resolveChannelStore(store: string | ChannelStore | undefined): {
  channelStore: ChannelStore;
  channelStoreIsEphemeral: boolean;
} {
  if (typeof store === 'string') {
    if (store.trim().length === 0) {
      throw new ConfigError('channelStore path cannot be empty.');
    }
    return { channelStore: new JsonFileChannelStore(store), channelStoreIsEphemeral: false };
  }
  if (store !== undefined) {
    return { channelStore: store, channelStoreIsEphemeral: false };
  }
  console.warn(
    '[toon] No `channelStore` configured — the claim watermark will be held in ' +
      'memory and lost when this process exits. A restarted client re-signs at ' +
      'nonces the connector has already banked, and the connector refuses every ' +
      'one of them while the channel\'s collateral stays locked. Pass a file path ' +
      '(e.g. `channelStore: "~/.toon/channels.json"`) for anything that outlives ' +
      'one run.'
  );
  return { channelStore: new InMemoryChannelStore(), channelStoreIsEphemeral: true };
}
