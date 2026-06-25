/**
 * Daemon configuration: resolved from a JSON config file and/or environment
 * variables, then expanded into a `ToonClientConfig` (BTP + channels + signer)
 * plus daemon-only settings (HTTP port, relay URL, apex negotiation).
 *
 * The mnemonic is sourced from (in precedence order):
 *   1. `TOON_CLIENT_MNEMONIC` env var,
 *   2. an encrypted keystore (#207) at `keystorePath`, decrypted with
 *      `TOON_CLIENT_KEYSTORE_PASSWORD`,
 *   3. the `mnemonic` field of the config file (discouraged — plaintext on disk).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadKeystore } from '@toon-protocol/client';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/core';
import type { ToonClientConfig } from '@toon-protocol/client';
import type { SettlementChain } from '../control-api.js';

/** Apex/town settlement parameters injected as a peer negotiation. */
export interface ApexNegotiationConfig {
  /** ILP destination address, e.g. `g.townhouse.town`. */
  destination: string;
  /** Peer id key used in the negotiation map (last ILP segment, e.g. `town`). */
  peerId: string;
  /** Settlement chain family. */
  chain: SettlementChain;
  /** Negotiated chain key, e.g. `evm:base:84532`. */
  chainKey: string;
  /** Numeric chain id (EVM only; 0 for solana/mina). */
  chainId: number;
  /** The apex's settlement (receive) address on `chain`. */
  settlementAddress: string;
  /** Token contract / mint / zkApp address. */
  tokenAddress?: string;
  /** EVM TokenNetwork / Solana programId / Mina zkApp address. */
  tokenNetwork?: string;
}

export interface DaemonConfigFile {
  /** Named network tier (drives settlement presets, #209). */
  network?: 'mainnet' | 'testnet' | 'devnet' | 'custom';
  mnemonic?: string;
  mnemonicAccountIndex?: number;
  keystorePath?: string;
  /**
   * Set when the daemon auto-generated the keystore (#251 first-run onboarding).
   * Such a keystore is encrypted with a default password so the identity reloads
   * across restarts without `TOON_CLIENT_KEYSTORE_PASSWORD`. A user-imported
   * keystore leaves this unset and still requires the env password.
   */
  keystoreAutoPassword?: boolean;
  /** Human-facing onboarding notes written by first-run scaffolding (ignored at runtime). */
  _help?: Record<string, string>;
  /** BTP WebSocket URL of the apex/connector. */
  btpUrl?: string;
  /**
   * Connector-PROXY base URL (devnet payment-proxy, e.g.
   * `https://proxy.devnet.toonprotocol.dev`). When set, the daemon routes paid
   * writes through the proxy's `POST /ilp` (ILP-over-HTTP) WITHOUT a BTP socket;
   * `btpUrl` then becomes optional. Env override: `TOON_CLIENT_PROXY_URL`.
   */
  proxyUrl?: string;
  /**
   * Devnet faucet base URL (e.g. `https://faucet.devnet.toonprotocol.dev`),
   * carried through to the ToonClient config for tooling/e2e funding. Env
   * override: `TOON_CLIENT_FAUCET_URL`.
   */
  faucetUrl?: string;
  /** Town relay WS URL for FREE reads. */
  relayUrl?: string;
  /** Default ILP publish destination. Default `g.townhouse.town`. */
  destination?: string;
  /** Default fee per paid write, base units. Default `1`. */
  feePerEvent?: string;
  /** Channel nonce-watermark persistence file. Default `<dir>/channels.json`. */
  channelStorePath?: string;
  /** Localhost control-plane port. Default 8787. */
  httpPort?: number;
  /**
   * Active settlement chain for paid writes to the apex. A single daemon settles
   * to a given peer on ONE chain (the `ChannelManager` keys channels per peer +
   * each `ToonClient` owns one BTP session). Default `evm`. Override with
   * `TOON_CLIENT_CHAIN`. For simultaneous multi-chain, run one daemon per chain
   * (distinct `httpPort` + `channelStorePath`).
   */
  chain?: SettlementChain;
  /** Manual apex negotiation (HS / direct-apex mode where bootstrap finds 0 peers). */
  apex?: ApexNegotiationConfig;
  /**
   * Per-chain apex negotiations. The entry for the active `chain` is used; the
   * others are retained so switching chains needs only a `chain`/restart change.
   */
  apexChains?: Partial<Record<SettlementChain, ApexNegotiationConfig>>;
  /**
   * Additional apex CHILD peers (last ILP segment, e.g. `["dvm","mill"]`)
   * reachable via the SAME apex channel — used when publishing/swapping to
   * `g.townhouse.dvm` / `g.townhouse.mill`. The runner injects the apex
   * negotiation under each and points it at the open apex channel (no extra
   * on-chain channel). The apex `peerId` itself is always handled.
   */
  apexChildPeers?: string[];
  /** Extra settlement overrides passed straight through to ToonClient. */
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  chainRpcUrls?: Record<string, string>;
  /** Solana on-chain payment-channel params (required when `chain` is solana). */
  solanaChannel?: ToonClientConfig['solanaChannel'];
  /** Mina on-chain payment-channel params (required when `chain` is mina). */
  minaChannel?: ToonClientConfig['minaChannel'];
}

export interface ResolvedDaemonConfig {
  httpPort: number;
  relayUrl: string;
  /**
   * Whether a write uplink (proxy or BTP) is configured. FREE reads work
   * without one; a write attempt with `hasUplink === false` is rejected at the
   * control plane with a clear "configure an uplink" error (issue #69). Reads
   * (`subscribe`/`query`/`getEvents`) never consult this.
   */
  hasUplink: boolean;
  /** Connector-proxy base URL (devnet payment-proxy), when configured. */
  proxyUrl?: string;
  /** Devnet faucet base URL, when configured. */
  faucetUrl?: string;
  destination: string;
  feePerEvent: bigint;
  apex?: ApexNegotiationConfig;
  /** Apex child peers reached via the same apex channel (e.g. dvm, mill). */
  apexChildPeers?: string[];
  /** The active settlement chain for paid writes. */
  chain: SettlementChain;
  /** File mapping (destination, chain) → on-chain channelId for restart resume. */
  apexChannelStorePath: string;
  /** Fully-built config for the `ToonClient` constructor. */
  toonClientConfig: ToonClientConfig;
  network?: string;
}

/**
 * Password used to encrypt an auto-generated keystore (#251 first-run
 * onboarding) when `TOON_CLIENT_KEYSTORE_PASSWORD` is unset. At-rest
 * obfuscation only — its purpose is letting the daemon reload the identity
 * across restarts with no env var. Users wanting a real password re-import the
 * keystore and set the env var.
 */
export const DEFAULT_KEYSTORE_PASSWORD = 'toon-client-default';

/** Default config directory: `~/.toon-client`. Overridable via env. */
export function configDir(): string {
  return process.env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

/** Default config file path. */
export function defaultConfigPath(): string {
  return join(configDir(), 'config.json');
}

/** Read + parse the JSON config file, returning `{}` when absent. */
export function readConfigFile(path: string): DaemonConfigFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `Failed to read daemon config at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Resolve the mnemonic from env / keystore / config (in precedence order). */
export function resolveMnemonic(file: DaemonConfigFile): string {
  const envMnemonic = process.env['TOON_CLIENT_MNEMONIC'];
  if (envMnemonic) return envMnemonic.trim();

  if (file.keystorePath) {
    // An auto-provisioned keystore (#251) falls back to the default password so
    // the identity reloads with no env var; a user-imported one still requires
    // TOON_CLIENT_KEYSTORE_PASSWORD.
    const password =
      process.env['TOON_CLIENT_KEYSTORE_PASSWORD'] ??
      (file.keystoreAutoPassword ? DEFAULT_KEYSTORE_PASSWORD : undefined);
    if (!password) {
      throw new Error(
        'keystorePath is set but TOON_CLIENT_KEYSTORE_PASSWORD is not provided'
      );
    }
    return loadKeystore(file.keystorePath, password);
  }

  if (file.mnemonic) return file.mnemonic.trim();

  throw new Error(
    'No mnemonic configured. Set TOON_CLIENT_MNEMONIC, configure a keystorePath ' +
      '(+ TOON_CLIENT_KEYSTORE_PASSWORD), or add `mnemonic` to the config file.'
  );
}

/**
 * Build the full resolved daemon config (file overlaid with env, mnemonic
 * resolved, ToonClientConfig assembled). Env overrides supported:
 *   TOON_CLIENT_BTP_URL, TOON_CLIENT_PROXY_URL, TOON_CLIENT_FAUCET_URL,
 *   TOON_CLIENT_RELAY_URL, TOON_CLIENT_HTTP_PORT, TOON_CLIENT_NETWORK,
 *   TOON_CLIENT_DESTINATION.
 */
export function resolveConfig(file: DaemonConfigFile): ResolvedDaemonConfig {
  const mnemonic = resolveMnemonic(file);

  const proxyUrl = process.env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl;
  const faucetUrl = process.env['TOON_CLIENT_FAUCET_URL'] ?? file.faucetUrl;
  const btpUrl = process.env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl;

  // A write uplink is OPTIONAL at resolve time: FREE relay reads need none.
  // A connector PROXY (devnet ILP-over-HTTP, no BTP socket) OR a BTP url enables
  // paid writes; with neither, the daemon still starts read-only and rejects a
  // write attempt at the control plane (issue #69). When only a proxy is set,
  // paid writes route through `POST /ilp` via HttpIlpClient.
  const hasUplink = Boolean(btpUrl || proxyUrl);
  const relayUrl =
    process.env['TOON_CLIENT_RELAY_URL'] ??
    file.relayUrl ??
    'ws://localhost:7100';
  const httpPort = Number(
    process.env['TOON_CLIENT_HTTP_PORT'] ?? file.httpPort ?? 8787
  );
  const destination =
    process.env['TOON_CLIENT_DESTINATION'] ??
    file.destination ??
    'g.townhouse.town';
  const feePerEvent = BigInt(file.feePerEvent ?? '1');
  const network = (process.env['TOON_CLIENT_NETWORK'] ?? file.network) as
    | ToonClientConfig['network']
    | undefined;

  // Active settlement chain + the matching apex negotiation.
  const chain = (process.env['TOON_CLIENT_CHAIN'] ??
    file.chain ??
    'evm') as SettlementChain;
  // Negotiation precedence: explicit per-chain → explicit single apex → a
  // proxy-mode negotiation synthesized from the flat settlement config. The last
  // one lets a proxy-only daemon settle paid writes WITHOUT a manual `apex`
  // block or a relay kind:10032 announcement (issue #69) — the runner falls back
  // to live kind:10032 discovery when this returns undefined.
  const apex =
    file.apexChains?.[chain] ??
    file.apex ??
    buildProxyApexNegotiation(file, chain, destination);

  const channelStorePath =
    file.channelStorePath ?? join(configDir(), 'channels.json');
  const apexChannelStorePath = join(configDir(), 'apex-channels.json');

  const toonClientConfig: ToonClientConfig = {
    // validateConfig requires connectorUrl OR proxyUrl. When only BTP is set
    // we pass a dummy connectorUrl (unused at runtime — BTP transport is used);
    // when a proxy is configured, `proxyUrl` satisfies the requirement and the
    // client derives the `POST /ilp` endpoint + routes writes over HTTP.
    ...(proxyUrl ? { proxyUrl } : { connectorUrl: 'http://127.0.0.1:1' }),
    ...(faucetUrl ? { faucetUrl } : {}),
    mnemonic,
    mnemonicAccountIndex: file.mnemonicAccountIndex ?? 0,
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.client',
      btpEndpoint: btpUrl ?? '',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    ...(btpUrl ? { btpUrl, btpAuthToken: '' } : {}),
    destinationAddress: destination,
    relayUrl: '', // reads use our own RelaySubscription, not bootstrap discovery
    knownPeers: [],
    channelStorePath,
    ...(network ? { network } : {}),
    ...(file.supportedChains ? { supportedChains: file.supportedChains } : {}),
    ...(file.settlementAddresses
      ? { settlementAddresses: file.settlementAddresses }
      : {}),
    ...(file.preferredTokens ? { preferredTokens: file.preferredTokens } : {}),
    ...(file.tokenNetworks ? { tokenNetworks: file.tokenNetworks } : {}),
    ...(file.chainRpcUrls ? { chainRpcUrls: file.chainRpcUrls } : {}),
    ...(file.solanaChannel ? { solanaChannel: file.solanaChannel } : {}),
    ...(file.minaChannel ? { minaChannel: file.minaChannel } : {}),
  };

  return {
    httpPort,
    relayUrl,
    hasUplink,
    ...(proxyUrl ? { proxyUrl } : {}),
    ...(faucetUrl ? { faucetUrl } : {}),
    destination,
    feePerEvent,
    ...(apex ? { apex } : {}),
    ...(file.apexChildPeers ? { apexChildPeers: file.apexChildPeers } : {}),
    chain,
    apexChannelStorePath,
    toonClientConfig,
    network,
  };
}

/**
 * Default negotiated chain-key for a settlement family when none is configured
 * and none can be discovered. EVM carries `evm:<network>:<chainId>`; the devnet
 * Anvil chain is 31337. Solana/Mina carry no numeric id.
 */
function defaultChainKey(chain: SettlementChain, chainId: number): string {
  switch (chain) {
    case 'evm':
      return `evm:devnet:${chainId}`;
    case 'solana':
      return 'solana:devnet';
    case 'mina':
      return 'mina:devnet';
  }
}

/**
 * Synthesize an apex negotiation for PROXY mode from the flat settlement config
 * (`settlementAddresses` / `tokenNetworks` / `preferredTokens`). Returns
 * undefined unless a proxy uplink AND the apex's settlement (receive) address
 * for the active chain are configured — the connector's on-chain counterparty
 * is REQUIRED to open a channel and is never fabricated (issue #69). When it
 * returns undefined the runner falls back to live kind:10032 discovery.
 *
 * The chainKey is taken from the first key in `settlementAddresses`/`tokenNetworks`
 * matching the chain family, else a sensible devnet default.
 */
function buildProxyApexNegotiation(
  file: DaemonConfigFile,
  chain: SettlementChain,
  destination: string
): ApexNegotiationConfig | undefined {
  const proxyUrl = process.env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl;
  if (!proxyUrl) return undefined;

  const settlementAddresses = file.settlementAddresses ?? {};
  // Prefer a chainKey that already carries settlement info for this family.
  const familyKeys = (rec: Record<string, string>): string[] =>
    Object.keys(rec).filter((k) => k.split(':')[0] === chain);
  const chainKey =
    familyKeys(settlementAddresses)[0] ??
    familyKeys(file.tokenNetworks ?? {})[0] ??
    familyKeys(file.preferredTokens ?? {})[0];

  // Without an explicit settlementAddress entry there is no on-chain
  // counterparty to open against — defer to relay discovery rather than guess.
  if (!chainKey) return undefined;
  const settlementAddress = settlementAddresses[chainKey];
  if (!settlementAddress) return undefined;

  const parts = chainKey.split(':');
  // Accept both 3-part `evm:{network}:{chainId}` and 2-part `evm:{chainId}`.
  const chainId =
    chain === 'evm' && parts.length >= 2
      ? Number(parts[2] ?? parts[1] ?? 0)
      : 0;
  const peerId = destination.split('.').at(-1) ?? destination;

  return {
    destination,
    peerId,
    chain,
    chainKey: chainKey || defaultChainKey(chain, chainId),
    chainId,
    settlementAddress,
    ...(file.preferredTokens?.[chainKey]
      ? { tokenAddress: file.preferredTokens[chainKey] }
      : {}),
    ...(file.tokenNetworks?.[chainKey]
      ? { tokenNetwork: file.tokenNetworks[chainKey] }
      : {}),
  };
}
