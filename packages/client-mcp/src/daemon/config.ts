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
  /** Transport: `direct` or a `socks5h://` proxy for `.anyone` hosts. */
  socksProxy?: string;
  /** Auto-manage the anon proxy for `.anyone` BTP hosts. Default true for HS. */
  managedAnonProxy?: boolean;
  /** Loopback SOCKS port the managed anon proxy binds (also used for reads). Default 9050. */
  managedAnonSocksPort?: number;
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
  socksProxy?: string;
  /**
   * When true the daemon must start its OWN managed `anon` proxy for free reads
   * — the btp-direct + relay-`.anyone` case the ToonClient does not cover (it
   * only auto-starts a proxy for a `.anyone` btpUrl). `readProxySocksPort` is the
   * loopback port to bind; `socksProxy` already points the relay at it.
   */
  manageReadProxy: boolean;
  /** Loopback SOCKS port for the daemon-managed read proxy (when `manageReadProxy`). */
  readProxySocksPort?: number;
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
 *   TOON_CLIENT_BTP_URL, TOON_CLIENT_RELAY_URL, TOON_CLIENT_SOCKS,
 *   TOON_CLIENT_HTTP_PORT, TOON_CLIENT_NETWORK.
 */
export function resolveConfig(file: DaemonConfigFile): ResolvedDaemonConfig {
  const mnemonic = resolveMnemonic(file);

  const btpUrl = process.env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl;
  if (!btpUrl) {
    throw new Error(
      'No btpUrl configured. Set TOON_CLIENT_BTP_URL or add `btpUrl` to the config file.'
    );
  }
  const relayUrl =
    process.env['TOON_CLIENT_RELAY_URL'] ??
    file.relayUrl ??
    'ws://localhost:7100';
  const explicitSocks = process.env['TOON_CLIENT_SOCKS'] ?? file.socksProxy;
  const httpPort = Number(
    process.env['TOON_CLIENT_HTTP_PORT'] ?? file.httpPort ?? 8787
  );
  const destination = file.destination ?? 'g.townhouse.town';
  const feePerEvent = BigInt(file.feePerEvent ?? '1');
  const network = (process.env['TOON_CLIENT_NETWORK'] ?? file.network) as
    | ToonClientConfig['network']
    | undefined;

  // Active settlement chain + the matching apex negotiation.
  const chain = (process.env['TOON_CLIENT_CHAIN'] ??
    file.chain ??
    'evm') as SettlementChain;
  const apex = file.apexChains?.[chain] ?? file.apex;

  // Transport / proxy resolution. The managed `anon` SOCKS5h proxy reaches
  // `.anyone` hidden services with zero setup, and TWO consumers need it
  // independently: the ToonClient (paid writes over BTP) and the daemon's
  // RelaySubscription (free reads). Crucially, the ToonClient only auto-starts
  // its own proxy when the *btpUrl* is `.anyone` — so the `.anyone`-ness of the
  // relay is inferred SEPARATELY here, and when the btp is direct but the relay
  // is a hidden service the daemon must start the read proxy itself.
  //  • explicit socksProxy → BTP + reads both route through it.
  //  • btp `.anyone` → the ToonClient spawns the anon daemon on a loopback SOCKS
  //    port; reads reuse that SAME port (covers a `.anyone` relay too).
  //  • btp direct + relay `.anyone` → the daemon starts the read proxy on that
  //    loopback port (`manageReadProxy`); BTP stays direct.
  //  • otherwise → direct, no proxy.
  const managedPort = Number(file.managedAnonSocksPort ?? 9050);
  // Explicit opt-out (`managedAnonProxy:false`) disables auto-start everywhere;
  // an explicit socksProxy takes the first branch regardless.
  const allowManaged = file.managedAnonProxy ?? true;
  const btpIsAnyone = isAnyoneHost(btpUrl);
  const relayIsAnyone = isAnyoneHost(relayUrl);

  let transport: ToonClientConfig['transport'];
  let managedAnonProxy: boolean;
  let managedAnonSocksPort: number | undefined;
  // The proxy the relay subscription uses for free reads (may differ from BTP).
  let readsSocksProxy: string | undefined;
  // Whether the DAEMON (not the ToonClient) must start the read proxy, for the
  // btp-direct + relay-`.anyone` case the ToonClient does not cover.
  let manageReadProxy = false;
  if (explicitSocks) {
    transport = { type: 'socks5', socksProxy: explicitSocks };
    managedAnonProxy = false;
    readsSocksProxy = explicitSocks;
  } else if (allowManaged && btpIsAnyone) {
    transport = { type: 'direct' };
    managedAnonProxy = true;
    managedAnonSocksPort = managedPort;
    readsSocksProxy = `socks5h://127.0.0.1:${managedPort}`;
  } else if (allowManaged && relayIsAnyone) {
    transport = { type: 'direct' };
    managedAnonProxy = false;
    manageReadProxy = true;
    managedAnonSocksPort = managedPort;
    readsSocksProxy = `socks5h://127.0.0.1:${managedPort}`;
  } else {
    transport = { type: 'direct' };
    managedAnonProxy = false;
  }

  const channelStorePath =
    file.channelStorePath ?? join(configDir(), 'channels.json');
  const apexChannelStorePath = join(configDir(), 'apex-channels.json');

  const toonClientConfig: ToonClientConfig = {
    // Required by validateConfig but unused at runtime (BTP transport is used).
    connectorUrl: 'http://127.0.0.1:1',
    mnemonic,
    mnemonicAccountIndex: file.mnemonicAccountIndex ?? 0,
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.client',
      btpEndpoint: btpUrl,
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    btpUrl,
    btpAuthToken: '',
    transport,
    managedAnonProxy,
    ...(managedAnonSocksPort !== undefined ? { managedAnonSocksPort } : {}),
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
    ...(readsSocksProxy !== undefined ? { socksProxy: readsSocksProxy } : {}),
    manageReadProxy,
    ...(manageReadProxy ? { readProxySocksPort: managedPort } : {}),
    destination,
    feePerEvent,
    apex,
    ...(file.apexChildPeers ? { apexChildPeers: file.apexChildPeers } : {}),
    chain,
    apexChannelStorePath,
    toonClientConfig,
    network,
  };
}

function isAnyoneHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.anyone');
  } catch {
    return false;
  }
}
