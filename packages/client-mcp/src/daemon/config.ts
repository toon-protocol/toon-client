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
import { join, resolve } from 'node:path';
import { loadKeystore } from '@toon-protocol/client';
import {
  encodeEventToToon,
  decodeEventFromToon,
  GenesisPeerLoader,
} from '@toon-protocol/core';
import { ARWEAVE_GATEWAYS } from '@toon-protocol/arweave';
import type { ToonClientConfig } from '@toon-protocol/client';
import type { SettlementChain, SwapControllerParams } from '../control-api.js';

/** Apex/relay settlement parameters injected as a peer negotiation. */
export interface ApexNegotiationConfig {
  /** ILP destination address, e.g. `g.proxy`. */
  destination: string;
  /** Peer id key used in the negotiation map (last ILP segment, e.g. `proxy`). */
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
   * Send paid writes over the BTP session rather than the proxy's `POST /ilp`.
   *
   * Defaults to TRUE whenever a `btpUrl` is configured (issue #565). The
   * daemon opens that BTP socket regardless — every apex needs it for
   * server-initiated packets — and the live fleet's connectors answer a paid
   * write over HTTP with `402 requiredTransport: "btp"`, so the HTTP-first
   * default only ever bought an extra round trip before #563's retry moved the
   * same write onto BTP anyway. Riding BTP directly also gives strictly-ordered
   * claim dispatch, which matters because claims are nonce-ordered.
   * `BtpPaidWriteTransport` still falls back to the HTTP transport when the BTP
   * session's reconnect budget is exhausted, so this is not a hard dependency
   * on the socket. Set `false` to force the pre-#565 HTTP-first precedence.
   * Env override: `TOON_CLIENT_PREFER_BTP` (`true`/`false`).
   */
  preferBtpForPaidWrites?: boolean;
  /**
   * Devnet faucet base URL (e.g. `https://faucet.devnet.toonprotocol.dev`),
   * carried through to the ToonClient config for tooling/e2e funding. Env
   * override: `TOON_CLIENT_FAUCET_URL`.
   */
  faucetUrl?: string;
  /**
   * Faucet HTTP request timeout in milliseconds. When set it overrides the
   * chain-aware default (fast 30s for evm/solana, 120s for the slow-settling
   * mina faucet). Env override: `TOON_CLIENT_FAUCET_TIMEOUT_MS`.
   */
  faucetTimeoutMs?: number;
  /** Relay WS URL for FREE reads. */
  relayUrl?: string;
  /**
   * Apex CHANNEL ANCHOR (settlement peer). Defaults to the FIRST genesis peer's
   * ILP anchor (core's `genesis-peers.json`); its last segment becomes the apex
   * `peerId` the channel keys under. This is NOT a write route — see
   * `publishDestination`/`storeDestination`.
   */
  destination?: string;
  /**
   * ILP route for PUBLISHES (relay writes → `POST /write`). When unset it
   * defaults to the first genesis peer's address; when `destination` is set
   * EXPLICITLY it is instead DERIVED from that `….relay.store` anchor
   * (`g.proxy.relay.store` → `g.proxy.relay`) — never the bare anchor, which
   * the apex forwards to the store and which 404s a `/write`.
   * Env: `TOON_CLIENT_PUBLISH_DESTINATION`.
   */
  publishDestination?: string;
  /**
   * ILP route for UPLOADS (kind:5094 blob → `POST /store` → Arweave). When
   * unset it defaults to the genesis STORE peer's own address (issue #536);
   * when `destination` is set EXPLICITLY it is instead DERIVED from that
   * `….relay.store` anchor (`g.proxy.relay.store` → `g.proxy.store`).
   * Env: `TOON_CLIENT_STORE_DESTINATION`.
   */
  storeDestination?: string;
  /**
   * BTP endpoint of the connector that actually terminates `storeDestination`.
   * Since core@3.3.0's two-node genesis seed (issue #536) the relay and store
   * are INDEPENDENT boxes with no forwarding between them, so a client that
   * only ever connects to the relay's uplink can never reach the store no
   * matter what `storeDestination` string it sends — the packet has nowhere
   * to route. When set (or genesis-defaulted below), the runner opens a
   * SECOND uplink to this endpoint and sends store writes (blob uploads, git
   * objects, `getRoutePrice(storeDestination)`) through it, while publishes
   * keep using the default (relay) uplink. Unset unless it differs from the
   * default `btpUrl` — a single-connector topology (tests, custom/legacy
   * proxies where one box still forwards) needs no second uplink.
   * Env: `TOON_CLIENT_STORE_BTP_URL`.
   */
  storeBtpUrl?: string;
  /** Default fee per paid write, base units. Default `1`. */
  feePerEvent?: string;
  /** Channel nonce-watermark persistence file. Default `<dir>/channels.json`. */
  channelStorePath?: string;
  /**
   * Received swap-claim (chain-B) watermark persistence file (#352). Default
   * `<dir>/received-claims.json`. Verified claims harvested from `toon_swap`
   * survive a daemon restart here.
   */
  receivedClaimStorePath?: string;
  /** Localhost control API port. Default 8787. */
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
   * Additional apex CHILD peers (last ILP segment, e.g. `["store","swap"]`)
   * reachable via the SAME apex channel — used when publishing/swapping to
   * `g.proxy.store` / `g.proxy.swap`. The runner injects the apex
   * negotiation under each and points it at the open apex channel (no extra
   * on-chain channel). The apex `peerId` itself is always handled.
   */
  apexChildPeers?: string[];
  /** Extra settlement overrides passed straight through to ToonClient. */
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  /**
   * OPERATOR OVERRIDE for leg-B swap-claim verification (toon-client#583):
   * chain key → the maker's deployed `RollingSwapChannel` address (the EIP-712
   * `verifyingContract` a received balance-proof claim is checked under).
   *
   * Normally unset — the maker's own kind:10032 announce carries
   * `swapVerifyingContracts` (swap#134) and that is used. Set this to PIN a
   * contract regardless of what a counterparty announces. Distinct from
   * `tokenNetworks`, which is leg A (the `TokenNetwork` this daemon opens its
   * own payment channel against); the two are different contracts and one
   * must never stand in for the other.
   */
  swapVerifyingContracts?: Record<string, string>;
  chainRpcUrls?: Record<string, string>;
  /** Solana on-chain payment-channel params (required when `chain` is solana). */
  solanaChannel?: ToonClientConfig['solanaChannel'];
  /** Mina on-chain payment-channel params (required when `chain` is mina). */
  minaChannel?: ToonClientConfig['minaChannel'];
  /**
   * Ordered Arweave gateways (primary first) used to stamp uploaded-media URLs:
   * the primary becomes the `imeta` `url`, the rest become `fallback` mirrors.
   * Default: the shared `ARWEAVE_GATEWAYS` (ar.io → arweave.net → permagate.io).
   * Env override: `TOON_CLIENT_ARWEAVE_GATEWAYS` (comma-separated).
   */
  arweaveGateways?: string[];
  /**
   * Optional allowed-root for `toon_upload`'s `filePath` reads. When set, a
   * supplied `filePath` is resolved and rejected unless it lies inside this
   * directory — bounding which filesystem locations the daemon will read on an
   * agent's behalf. When unset, any absolute path is read (the path is still
   * resolved). Env override: `TOON_CLIENT_UPLOAD_ROOT`.
   */
  uploadAllowedRoot?: string;
  /**
   * Daemon-level defaults for the rolling-swap sender defenses (#351). A
   * per-request `SwapRequest` field always wins; these apply when the request
   * leaves the knob unset.
   */
  swapDefaults?: SwapDefaultsConfig;
}

/** Daemon-level swap-defense defaults (rolling-swap toon-meta#145, #351). */
export interface SwapDefaultsConfig {
  /**
   * Default floor tolerance in basis points: every swap gets
   * `minExchangeRate = pair.rate × (1 − floorBps/10000)` unless the request
   * supplies an explicit `minExchangeRate` or its own `floorBps`.
   */
  floorBps?: number;
  /** Default per-packet PREPARE expiry window, ms (rolling-swap R7). */
  packetExpiryMs?: number;
  /**
   * Engage the adaptive δ/W controller by default for swaps that don't pin an
   * explicit `packetCount` or supply their own `controller` params.
   * `advertisedSpread` is required (the sdk deliberately has no default).
   */
  controller?: SwapControllerParams;
}

export interface ResolvedDaemonConfig {
  httpPort: number;
  relayUrl: string;
  /**
   * Whether a write uplink (proxy or BTP) is configured. FREE reads work
   * without one; a write attempt with `hasUplink === false` is rejected at the
   * control API with a clear "configure an uplink" error (issue #69). Reads
   * (`subscribe`/`query`/`getEvents`) never consult this.
   */
  hasUplink: boolean;
  /** Connector-proxy base URL (devnet payment-proxy), when configured. */
  proxyUrl?: string;
  /** Devnet faucet base URL, when configured. */
  faucetUrl?: string;
  /**
   * Explicit faucet HTTP request timeout (ms), when configured. Overrides the
   * chain-aware default. When absent, {@link fundWallet} picks the per-chain
   * default (longer for mina).
   */
  faucetTimeoutMs?: number;
  destination: string;
  /** Resolved default destination for relay-write publishes (falls back to `destination`). */
  publishDestination: string;
  /** Resolved default destination for store/Arweave uploads (falls back to `destination`). */
  storeDestination: string;
  /**
   * BTP endpoint of the connector terminating `storeDestination`, when it is
   * a DIFFERENT box than the default uplink (issue #536). Absent means store
   * writes route through the default apex like everything else — the
   * single-connector case.
   */
  storeBtpUrl?: string;
  feePerEvent: bigint;
  apex?: ApexNegotiationConfig;
  /** Apex child peers reached via the same apex channel (e.g. store, swap). */
  apexChildPeers?: string[];
  /** The active settlement chain for paid writes. */
  chain: SettlementChain;
  /** File mapping (destination, chain) → on-chain channelId for restart resume. */
  apexChannelStorePath: string;
  /**
   * JSON file persisting per-(source chain, maker, pair) adaptive-controller
   * state (sdk `JsonFileSwapControllerStateStore`), beside the channel stores.
   * Optional only so manually-built configs (tests) may omit it — the runner
   * falls back to `<configDir>/swap-controller-state.json`.
   */
  swapControllerStatePath?: string;
  /** Daemon-level swap-defense defaults (#351), when configured. */
  swapDefaults?: SwapDefaultsConfig;
  /**
   * Durable store for verified RECEIVED swap claims (chain-B watermarks, #352).
   * Optional only so manually-built test configs may omit it (the runner then
   * falls back to an in-memory store); `resolveConfig` always sets it.
   */
  receivedClaimStorePath?: string;
  /** Fully-built config for the `ToonClient` constructor. */
  toonClientConfig: ToonClientConfig;
  network?: string;
  /**
   * Ordered Arweave gateways for stamping uploaded-media URLs (primary first).
   * Always populated by `resolveConfig` (default = shared `ARWEAVE_GATEWAYS`);
   * optional only so manually-built configs (tests) may omit it — consumers
   * fall back to the shared default when it is absent.
   */
  arweaveGateways?: string[];
  /**
   * Resolved allowed-root for `toon_upload` `filePath` reads, when configured.
   * Absent means no boundary (any absolute path is read, still resolved).
   */
  uploadAllowedRoot?: string;
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
/** Parse a `true`/`false` env value (anything else — including '' — is undefined). */
function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Parse a comma-separated env value into a trimmed, non-empty list (or undefined). */
function parseCsvEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Last ILP segment of the genesis STORE peer (`g.toon.ario` — the ar.io
 * gateway box). The genesis entries carry no role field, so the address suffix
 * is the only thing that tells the store node apart from the relay node.
 */
const STORE_ADDRESS_SUFFIX = '.ario';

/**
 * Derive the publish/upload ROUTES from the apex channel anchor. Behind the
 * devnet proxy the anchor follows `<base>.relay.store` (e.g. `g.proxy.relay.store`):
 * publishes terminate at the relay (`<base>.relay`) and uploads at the store
 * (`<base>.store`). Routing the bare anchor as a publish forwards the `/write`
 * to the store backend → HTTP 404. Anchors that don't match the convention fall
 * back to the anchor unchanged (back-compat for non-proxy / custom topologies).
 */
function deriveRouteDestinations(anchor: string): {
  publish: string;
  store: string;
} {
  const segs = anchor.split('.');
  if (segs.at(-1) === 'store' && segs.at(-2) === 'relay') {
    const base = segs.slice(0, -2).join('.'); // e.g. g.proxy
    return { publish: `${base}.relay`, store: `${base}.store` };
  }
  return { publish: anchor, store: anchor };
}

/**
 * The `connectorUrl`/`proxyUrl` fields to merge into the daemon's
 * `ToonClientConfig` for a given uplink (issue #462). Mirrors rig's
 * `connectorEdgeFields` (`packages/rig/src/cli/standalone-mode.ts`).
 *
 * `validateConfig` (packages/client) requires one of `connectorUrl`,
 * `proxyUrl`, or `btpUrl`:
 * - a proxy satisfies it directly, and the client derives the `POST /ilp`
 *   endpoint from it and routes writes over HTTP;
 * - a BTP-only uplink satisfies it via `btpUrl` alone — `applyDefaults`
 *   derives a REAL `connectorUrl`/`connectorHttpEndpoint` from it (connector
 *   PR #181 serves ILP-over-HTTP and BTP on the same port), so the daemon
 *   must NOT inject an inert `http://127.0.0.1:1` placeholder here: every
 *   paid write's `GET /ilp/identity` / `GET /ilp/routes/price` would dial it
 *   and fail to connect;
 * - with NEITHER (the free-read-only daemon, issue #69) there is nothing to
 *   derive an edge from, so the dummy `connectorUrl` still stands in. Nothing
 *   dials it: `assertApexReady` rejects a write on a `hasUplink === false`
 *   daemon before any packet is formed.
 */
function connectorEdgeFields(uplink: {
  proxyUrl: string | undefined;
  btpUrl: string | undefined;
}): Pick<ToonClientConfig, 'connectorUrl' | 'proxyUrl'> {
  if (uplink.proxyUrl) return { proxyUrl: uplink.proxyUrl };
  if (uplink.btpUrl) return {};
  return { connectorUrl: 'http://127.0.0.1:1' };
}

export function resolveConfig(file: DaemonConfigFile): ResolvedDaemonConfig {
  const mnemonic = resolveMnemonic(file);

  const proxyUrl = process.env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl;
  const faucetUrl = process.env['TOON_CLIENT_FAUCET_URL'] ?? file.faucetUrl;
  const faucetTimeoutEnv = process.env['TOON_CLIENT_FAUCET_TIMEOUT_MS'];
  const faucetTimeoutMs =
    faucetTimeoutEnv && Number.isFinite(Number(faucetTimeoutEnv))
      ? Number(faucetTimeoutEnv)
      : file.faucetTimeoutMs;
  const btpUrl = process.env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl;

  // A write uplink is OPTIONAL at resolve time: FREE relay reads need none.
  // A connector PROXY (devnet ILP-over-HTTP, no BTP socket) OR a BTP url enables
  // paid writes; with neither, the daemon still starts read-only and rejects a
  // write attempt at the control API (issue #69). When only a proxy is set,
  // paid writes route through `POST /ilp` via HttpIlpClient.
  const hasUplink = Boolean(btpUrl || proxyUrl);
  // Network defaults are bootstrapped from the committed genesis peer list
  // (`@toon-protocol/core` → discovery/genesis-peers.json) rather than
  // hardcoded per-network literals here. Since core@3.3.0 (issue #536) the
  // seed carries TWO independent entries — the relay box (`g.toon.relay`)
  // and the store box (`g.toon.ario`) — which do not forward for each other,
  // so neither address can be derived from the other. Each is a pointer;
  // every node's own kind:10032 announcement organically distributes the rest.
  // Env/file values still win; the trailing literals are last-resort
  // fallbacks for an empty genesis list.
  const genesisPeers = GenesisPeerLoader.loadGenesisPeers();
  const genesisSeed = genesisPeers[0];
  // The store's own genesis entry, independent of whichever entry `destination`
  // defaults to — NOT derived from it, since the two nodes no longer share an
  // address namespace to derive from (see deriveRouteDestinations below).
  const genesisStorePeer = genesisPeers.find((p) =>
    p.ilpAddress.endsWith(STORE_ADDRESS_SUFFIX)
  );
  const relayUrl =
    process.env['TOON_CLIENT_RELAY_URL'] ??
    file.relayUrl ??
    genesisSeed?.relayUrl ??
    'ws://localhost:7100';
  const httpPort = Number(
    process.env['TOON_CLIENT_HTTP_PORT'] ?? file.httpPort ?? 8787
  );
  const explicitDestination =
    process.env['TOON_CLIENT_DESTINATION'] ?? file.destination;
  const destination =
    explicitDestination ??
    genesisSeed?.ilpAddress ??
    // `g.proxy` was the retired TypeScript connector; the live apex answers to
    // `g.toon`. Only reachable with an empty genesis list, but a last-resort
    // fallback naming a decommissioned node is never the right guess.
    'g.toon';
  // Publishes (relay writes) and uploads (store/Arweave) terminate at DIFFERENT
  // backends and so route to different ILP destinations. An EXPLICIT
  // destination (old apex/proxy topologies) is still split via the
  // `<base>.relay.store` anchor convention (see deriveRouteDestinations) —
  // NOT reused verbatim, which would forward a `/write` to the store backend
  // and 404. Absent an explicit destination, the two genesis entries are used
  // directly instead of parsed out of one anchor, since the relay and store
  // boxes are independent and no longer share a common prefix to split.
  const routes = explicitDestination
    ? deriveRouteDestinations(explicitDestination)
    : {
        publish: genesisSeed?.ilpAddress ?? destination,
        store:
          genesisStorePeer?.ilpAddress ??
          genesisSeed?.ilpAddress ??
          destination,
      };
  const publishDestination =
    process.env['TOON_CLIENT_PUBLISH_DESTINATION'] ??
    file.publishDestination ??
    routes.publish;
  const storeDestination =
    process.env['TOON_CLIENT_STORE_DESTINATION'] ??
    file.storeDestination ??
    routes.store;
  // A renamed destination string is not a route: the store connector is a
  // SEPARATE box from the default uplink's, so reaching it needs its own BTP
  // endpoint (issue #536 correction). Only genesis-defaulted (not derived)
  // when no explicit `destination` is configured — an explicit anchor names a
  // single-connector topology (old apex/proxy) that this runner has always
  // reached through one uplink. Skip the genesis default when it is the same
  // endpoint as the default uplink (single-connector test/dev topologies) —
  // there is no second box to connect to.
  const genesisStoreBtpEndpoint =
    !explicitDestination && genesisStorePeer?.btpEndpoint !== btpUrl
      ? genesisStorePeer?.btpEndpoint
      : undefined;
  const storeBtpUrl =
    process.env['TOON_CLIENT_STORE_BTP_URL'] ??
    file.storeBtpUrl ??
    genesisStoreBtpEndpoint;
  const feePerEvent = BigInt(file.feePerEvent ?? '1');
  const arweaveGateways = parseCsvEnv(
    process.env['TOON_CLIENT_ARWEAVE_GATEWAYS']
  ) ??
    file.arweaveGateways ?? [...ARWEAVE_GATEWAYS];
  const uploadRoot =
    process.env['TOON_CLIENT_UPLOAD_ROOT'] ?? file.uploadAllowedRoot;
  const uploadAllowedRoot = uploadRoot ? resolve(uploadRoot) : undefined;
  const network = (process.env['TOON_CLIENT_NETWORK'] ?? file.network) as
    | ToonClientConfig['network']
    | undefined;

  // Active settlement chain + the matching apex negotiation. `explicitChain`
  // is undefined unless the user actually set TOON_CLIENT_CHAIN or `chain` —
  // it is threaded into `toonClientConfig.preferredChain` as-is (#485) so
  // ToonClient can tell "explicitly evm" apart from "defaulted to evm" and
  // only enforces/throws in the former case; `chain` keeps its silent
  // 'evm' default for the apex-negotiation selection below, which always
  // needs a concrete value.
  const explicitChain = (process.env['TOON_CLIENT_CHAIN'] ?? file.chain) as
    | SettlementChain
    | undefined;
  const chain = explicitChain ?? 'evm';
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
  const swapControllerStatePath = join(
    configDir(),
    'swap-controller-state.json'
  );
  const receivedClaimStorePath =
    file.receivedClaimStorePath ?? join(configDir(), 'received-claims.json');

  const toonClientConfig: ToonClientConfig = {
    ...connectorEdgeFields({ proxyUrl, btpUrl }),
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
    // BTP-first for paid writes whenever there IS a socket (issue #565). See
    // `DaemonConfigFile.preferBtpForPaidWrites` for why the HTTP-first library
    // default is wrong for this host specifically.
    ...(btpUrl
      ? {
          preferBtpForPaidWrites:
            parseBoolEnv(process.env['TOON_CLIENT_PREFER_BTP']) ??
            file.preferBtpForPaidWrites ??
            true,
        }
      : {}),
    destinationAddress: destination,
    // Free reads still route through our own RelaySubscription, not this.
    // ToonClient.start() separately uses `config.relayUrl` to feed its
    // discoveryTracker (toon-client#550) — pinning this to '' left every
    // paid write from a fully-started daemon client throwing
    // TERMINATOR_UNRESOLVED, since the tracker never discovered a peer for
    // the write destination.
    relayUrl,
    knownPeers: [],
    channelStorePath,
    ...(network ? { network } : {}),
    ...(explicitChain ? { preferredChain: explicitChain } : {}),
    ...(file.supportedChains ? { supportedChains: file.supportedChains } : {}),
    ...(file.settlementAddresses
      ? { settlementAddresses: file.settlementAddresses }
      : {}),
    ...(file.preferredTokens ? { preferredTokens: file.preferredTokens } : {}),
    ...(file.tokenNetworks ? { tokenNetworks: file.tokenNetworks } : {}),
    ...(file.swapVerifyingContracts
      ? { swapVerifyingContracts: file.swapVerifyingContracts }
      : {}),
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
    ...(faucetTimeoutMs !== undefined ? { faucetTimeoutMs } : {}),
    destination,
    publishDestination,
    storeDestination,
    ...(storeBtpUrl ? { storeBtpUrl } : {}),
    feePerEvent,
    ...(apex ? { apex } : {}),
    ...(file.apexChildPeers ? { apexChildPeers: file.apexChildPeers } : {}),
    chain,
    apexChannelStorePath,
    swapControllerStatePath,
    ...(file.swapDefaults ? { swapDefaults: file.swapDefaults } : {}),
    receivedClaimStorePath,
    toonClientConfig,
    network,
    arweaveGateways,
    ...(uploadAllowedRoot ? { uploadAllowedRoot } : {}),
  };
}

/**
 * Synthesize an apex negotiation for PROXY mode from the flat settlement config
 * (`settlementAddresses` / `tokenNetworks` / `preferredTokens`). Returns
 * undefined unless a proxy uplink AND the apex's settlement (receive) address
 * for the active chain are configured — the connector's on-chain counterparty
 * is REQUIRED to open a channel and is never fabricated (issue #69). When it
 * returns undefined the runner falls back to live kind:10032 discovery.
 *
 * The chainKey is the first key matching the chain family in `settlementAddresses`,
 * then `tokenNetworks`, then `preferredTokens`; absent that, returns undefined
 * rather than guessing one.
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
  // Deliberately no synthesized default here (#529): any such fallback would
  // have to invent a chain-key format, and the last one drifted to the stale
  // 3-part `evm:<network>:<chainId>` that toon#165 removed.
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
    chainKey,
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
