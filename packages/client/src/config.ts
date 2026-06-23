import { generateSecretKey } from 'nostr-tools/pure';
import {
  resolveClientNetwork,
  type NetworkFamilyStatus,
} from '@toon-protocol/core';
import { ValidationError } from './errors.js';
import {
  validateMnemonic,
  deriveNostrKeyFromMnemonic,
} from './keys/KeyDerivation.js';
import type { ToonClientConfig } from './types.js';

/**
 * Settlement info produced by buildSettlementInfo().
 * Extends the core SettlementConfig shape with ilpAddress for client use.
 */
export interface ClientSettlementInfo {
  ilpAddress?: string;
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
}

/**
 * Applies named-network preset defaults to a client config.
 *
 * When `config.network` is set and != `'custom'`, the settlement-related
 * fields are defaulted from the shared core presets (`resolveClientNetwork`):
 * RPC/GraphQL URLs, supported chain identifiers, preferred tokens, EVM
 * TokenNetwork addresses, and the Solana/Mina channel params. Any explicit
 * per-chain field on `config` OVERRIDES the preset (explicit always wins).
 *
 * `'custom'` and the unset case both pass `config` through untouched, keeping
 * the fully-manual path and full backward compatibility.
 *
 * @returns A shallow copy with preset defaults merged in (never mutates input).
 */
export function applyNetworkPresets(
  config: ToonClientConfig
): ToonClientConfig {
  const { network } = config;
  if (!network || network === 'custom') return config;

  const presets = resolveClientNetwork(network);

  // Merge a preset record under an explicit one (explicit keys win).
  const mergeRecord = (
    explicit: Record<string, string> | undefined,
    preset: Record<string, string>
  ): Record<string, string> => ({ ...preset, ...explicit });

  // supportedChains: union (preset first), preserving any explicit extras.
  const supportedChains = config.supportedChains
    ? Array.from(
        new Set([...presets.supportedChains, ...config.supportedChains])
      )
    : presets.supportedChains;

  return {
    ...config,
    supportedChains,
    chainRpcUrls: mergeRecord(config.chainRpcUrls, presets.chainRpcUrls),
    preferredTokens: mergeRecord(
      config.preferredTokens,
      presets.preferredTokens
    ),
    tokenNetworks: mergeRecord(config.tokenNetworks, presets.tokenNetworks),
    // settlementAddresses are identity-derived (per-client), so they have no
    // preset; pass any explicit value through unchanged.
    ...(config.settlementAddresses && {
      settlementAddresses: config.settlementAddresses,
    }),
    // Channel params: preset fills the deployed programId/zkApp + URLs unless
    // the caller supplied their own (explicit object wins wholesale).
    ...(presets.solanaChannel && {
      solanaChannel: config.solanaChannel ?? presets.solanaChannel,
    }),
    ...(presets.minaChannel && {
      minaChannel: config.minaChannel ?? presets.minaChannel,
    }),
  };
}

/**
 * Returns per-chain settlement readiness for the configured `network` tier,
 * mirroring the townhouse node's status. Returns `undefined` when `network` is
 * unset or `'custom'` (no preset tier to report on).
 */
export function getNetworkStatus(
  config: ToonClientConfig
): NetworkFamilyStatus | undefined {
  const { network } = config;
  if (!network || network === 'custom') return undefined;
  return resolveClientNetwork(network).status;
}

/**
 * Validates ToonClient configuration.
 *
 * This story implements HTTP mode only. Embedded mode validation will be added in a future epic.
 *
 * @throws {ValidationError} If configuration is invalid
 */
export function validateConfig(config: ToonClientConfig): void {
  // Reject embedded mode (not implemented in this story)
  if (config.connector !== undefined) {
    throw new ValidationError(
      'Embedded mode not yet implemented in ToonClient. Use connectorUrl for HTTP mode.'
    );
  }

  // Require connectorUrl for HTTP mode
  if (!config.connectorUrl) {
    throw new ValidationError(
      'connectorUrl is required for HTTP mode. Example: "http://localhost:8080"'
    );
  }

  // Validate connectorUrl format
  try {
    const url = new URL(config.connectorUrl);
    if (!url.protocol.startsWith('http')) {
      throw new Error('Must be HTTP or HTTPS');
    }
  } catch (error) {
    throw new ValidationError(
      `Invalid connectorUrl: must be a valid HTTP/HTTPS URL (e.g., "http://localhost:8080"). ` +
        `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Validate secretKey only when provided
  if (config.secretKey !== undefined) {
    if (!config.secretKey || config.secretKey.length !== 32) {
      throw new ValidationError(
        'secretKey must be 32 bytes (Nostr private key)'
      );
    }
  }

  // Validate mnemonic when provided. The mnemonic derives the Nostr/EVM +
  // Solana/Mina identity, so it cannot coexist with an explicit secretKey
  // (that would split the Nostr identity from the Solana/Mina identity). An
  // explicit evmPrivateKey override IS allowed (documented hardware-wallet case).
  if (config.mnemonic !== undefined) {
    if (config.secretKey !== undefined) {
      throw new ValidationError(
        'Provide either `mnemonic` or `secretKey`, not both — the mnemonic ' +
          'derives the Nostr key, so a separate secretKey would yield an ' +
          'inconsistent cross-chain identity. (An `evmPrivateKey` override is allowed.)'
      );
    }
    if (
      typeof config.mnemonic !== 'string' ||
      !validateMnemonic(config.mnemonic)
    ) {
      throw new ValidationError('mnemonic must be a valid BIP-39 phrase');
    }
  }

  // Validate mnemonicAccountIndex when provided (must be a non-negative
  // integer within the BIP-32 non-hardened range, matching the SDK guard).
  if (config.mnemonicAccountIndex !== undefined) {
    const idx = config.mnemonicAccountIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx > 0x7fffffff) {
      throw new ValidationError(
        'mnemonicAccountIndex must be a non-negative integer (0 to 2147483647)'
      );
    }
  }

  if (!config.ilpInfo?.ilpAddress) {
    throw new ValidationError('ilpInfo.ilpAddress is required');
  }

  if (!config.toonEncoder || typeof config.toonEncoder !== 'function') {
    throw new ValidationError('toonEncoder function is required');
  }

  if (!config.toonDecoder || typeof config.toonDecoder !== 'function') {
    throw new ValidationError('toonDecoder function is required');
  }

  // Validate evmPrivateKey format when provided
  if (config.evmPrivateKey !== undefined) {
    if (config.evmPrivateKey instanceof Uint8Array) {
      if (config.evmPrivateKey.length !== 32) {
        throw new ValidationError('evmPrivateKey must be 32 bytes');
      }
    } else if (typeof config.evmPrivateKey === 'string') {
      const hex = config.evmPrivateKey.startsWith('0x')
        ? config.evmPrivateKey.slice(2)
        : config.evmPrivateKey;
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new ValidationError('evmPrivateKey must be a 32-byte hex string');
      }
    } else {
      throw new ValidationError(
        'evmPrivateKey must be a hex string or Uint8Array'
      );
    }
  }

  // Validate btpUrl when provided
  if (config.btpUrl !== undefined) {
    try {
      const url = new URL(config.btpUrl);
      if (!url.protocol.startsWith('ws')) {
        throw new Error('Must be WS or WSS');
      }
    } catch (error) {
      throw new ValidationError(
        `Invalid btpUrl: must be a valid WebSocket URL (e.g., "ws://localhost:3000"). ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Validate chainRpcUrls keys match supportedChains when both present
  if (config.chainRpcUrls && config.supportedChains) {
    for (const chain of Object.keys(config.chainRpcUrls)) {
      if (!config.supportedChains.includes(chain)) {
        throw new ValidationError(
          `chainRpcUrls key "${chain}" is not in supportedChains`
        );
      }
    }
  }
}

/**
 * The resolved config type after defaults are applied.
 * secretKey is guaranteed to be present (auto-generated if omitted).
 */
export type ResolvedConfig = Required<
  Omit<
    ToonClientConfig,
    | 'connector'
    | 'mnemonic'
    | 'mnemonicAccountIndex'
    | 'evmPrivateKey'
    | 'network'
    | 'supportedChains'
    | 'settlementAddresses'
    | 'preferredTokens'
    | 'tokenNetworks'
    | 'btpUrl'
    | 'btpAuthToken'
    | 'btpPeerId'
    | 'connectorHttpEndpoint'
    | 'connectorSupportsUpgrade'
    | 'chainRpcUrls'
    | 'initialDeposit'
    | 'settlementTimeout'
    | 'solanaChannel'
    | 'minaChannel'
    | 'channelStorePath'
    | 'knownPeers'
    | 'destinationAddress'
  >
> & {
  connector?: unknown;
  /** Always present after applyDefaults() — derived from secretKey if not explicitly provided */
  evmPrivateKey: string | Uint8Array;
  /**
   * BIP-39 phrase retained so `ToonClient.start()` can derive the Solana/Mina
   * keys asynchronously and register the corresponding signers. The Nostr/EVM
   * keys are already resolved synchronously into `secretKey`/`evmPrivateKey`.
   */
  mnemonic?: string;
  /**
   * BIP-44 account index for mnemonic-based derivation (defaults to 0).
   * Retained so `ToonClient.start()` derives the Solana/Mina signers at the
   * same index as the synchronously-resolved Nostr/EVM keys.
   */
  mnemonicAccountIndex?: number;
  /** Named network tier, retained for `getNetworkStatus()`. */
  network?: ToonClientConfig['network'];
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  btpUrl?: string;
  btpAuthToken?: string;
  btpPeerId?: string;
  connectorHttpEndpoint?: string;
  connectorSupportsUpgrade?: boolean;
  chainRpcUrls?: Record<string, string>;
  initialDeposit?: string;
  settlementTimeout?: number;
  solanaChannel?: ToonClientConfig['solanaChannel'];
  minaChannel?: ToonClientConfig['minaChannel'];
  channelStorePath?: string;
  knownPeers?: {
    pubkey: string;
    relayUrl: string;
    btpEndpoint?: string;
  }[];
  destinationAddress: string;
};

/**
 * Applies default values to optional configuration fields.
 * Auto-generates a Nostr keypair when secretKey is omitted.
 * Derives btpUrl from connectorUrl when not provided.
 */
export function applyDefaults(rawConfig: ToonClientConfig): ResolvedConfig {
  // Fill settlement-related defaults from the named-network presets first
  // (explicit per-chain fields always win). No-op for unset/`custom`.
  const config = applyNetworkPresets(rawConfig);

  // Resolve the Nostr secret key. Precedence:
  //   1. explicit secretKey
  //   2. derived from mnemonic (Nostr/EVM only — Solana/Mina are derived
  //      asynchronously in start(), which is why the mnemonic is retained)
  //   3. auto-generated ephemeral key
  const secretKey =
    config.secretKey ??
    (config.mnemonic
      ? deriveNostrKeyFromMnemonic(
          config.mnemonic,
          config.mnemonicAccountIndex ?? 0
        ).secretKey
      : generateSecretKey());

  // Derive btpUrl from connectorUrl when not explicitly provided
  // http://host:8080 → ws://host:3000
  let btpUrl = config.btpUrl;
  if (!btpUrl && config.connectorUrl) {
    try {
      const url = new URL(config.connectorUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      btpUrl = `${wsProtocol}//${url.hostname}:3000`;
    } catch {
      // connectorUrl already validated, this shouldn't happen
    }
  }

  // Derive destinationAddress from connectorUrl port when not explicitly provided
  // This provides sensible defaults for local development:
  // - http://localhost:8080 → g.toon.genesis (genesis node)
  // - http://localhost:8090 → g.toon.peer1 (peer1 node)
  // For production, explicitly set destinationAddress in config
  let destinationAddress = config.destinationAddress;
  if (!destinationAddress && config.connectorUrl) {
    try {
      const url = new URL(config.connectorUrl);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        // Map common local ports to known nodes
        if (url.port === '8080') {
          destinationAddress = 'g.toon.genesis';
        } else if (url.port === '8090') {
          destinationAddress = 'g.toon.peer1';
        } else if (url.port === '8100') {
          destinationAddress = 'g.toon.peer2';
        } else {
          // Fallback: use ilpInfo.ilpAddress if available
          destinationAddress = config.ilpInfo?.ilpAddress || 'g.toon.relay';
        }
      } else {
        // Production: default to ilpInfo.ilpAddress
        destinationAddress = config.ilpInfo?.ilpAddress || 'g.toon.relay';
      }
    } catch {
      destinationAddress = config.ilpInfo?.ilpAddress || 'g.toon.relay';
    }
  }

  // Derive EVM private key from Nostr secret key when not explicitly provided.
  // Both Nostr and EVM use secp256k1, so a single 32-byte key works for both.
  const evmPrivateKey = config.evmPrivateKey ?? secretKey;

  return {
    ...config,
    secretKey,
    evmPrivateKey,
    connectorUrl: config.connectorUrl as string, // Already validated as required
    relayUrl: config.relayUrl ?? 'ws://localhost:7100',
    queryTimeout: config.queryTimeout ?? 30000,
    maxRetries: config.maxRetries ?? 3,
    retryDelay: config.retryDelay ?? 1000,
    btpUrl,
    destinationAddress: destinationAddress as string, // Always set by logic above
  };
}

/**
 * Builds SettlementConfig from client config.
 * Returns undefined if no settlement-related config is present.
 */
export function buildSettlementInfo(
  rawConfig: ToonClientConfig
): ClientSettlementInfo | undefined {
  // Resolve named-network preset defaults so a `network`-only config still
  // produces settlement info (explicit fields win; no-op for unset/`custom`).
  const config = applyNetworkPresets(rawConfig);

  if (
    !config.supportedChains?.length &&
    !config.settlementAddresses &&
    !config.preferredTokens &&
    !config.tokenNetworks
  ) {
    return undefined;
  }

  return {
    ilpAddress: config.ilpInfo?.ilpAddress,
    supportedChains: config.supportedChains,
    settlementAddresses: config.settlementAddresses,
    preferredTokens: config.preferredTokens,
    tokenNetworks: config.tokenNetworks,
  };
}
