/**
 * The embedded-client (standalone) publisher backing every paid `rig`
 * command: build a nonce-guarded {@link StandalonePublisher} from the
 * caller's own identity and config.
 *
 * Identity comes from the #248 precedence chain (`./identity.ts`:
 * RIG_MNEMONIC env → TOON_CLIENT_MNEMONIC env alias → project `.env` →
 * `~/.toon-client` keystore/config). The remaining config resolution
 * DUPLICATES the toon-clientd conventions
 * (`packages/client-mcp/src/daemon/config.ts`) the same way
 * `../standalone/nonce-guard.ts` does — this package must not import
 * `@toon-protocol/client-mcp` (circular; see that module's doc). Keep in sync:
 *
 *   - state dir: `TOON_CLIENT_HOME`, else `~/.toon-client`; config `config.json`
 *   - env overrides: `TOON_CLIENT_PROXY_URL`, `TOON_CLIENT_BTP_URL`,
 *     `TOON_CLIENT_RELAY_URL`, `TOON_CLIENT_DESTINATION`,
 *     `TOON_CLIENT_PUBLISH_DESTINATION`, `TOON_CLIENT_STORE_DESTINATION`,
 *     `TOON_CLIENT_NETWORK`
 *   - defaults bootstrap from the committed genesis peer seed
 *     (`@toon-protocol/core` GenesisPeerLoader)
 *
 * This module statically imports `@toon-protocol/client` (heavy: viem,
 * noble, nostr-tools), so it must only ever be reached through the dynamic
 * import in `push.ts` (see `./standalone-context.ts`).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToonClientConfig } from '@toon-protocol/client';
import {
  GenesisPeerLoader,
  decodeEventFromToon,
  encodeEventToToon,
} from '@toon-protocol/core';
import {
  ChannelMapStore,
  RIG_CHANNEL_MAP_FILENAME,
} from '../standalone/channel-map.js';
import { StandalonePublisher } from '../standalone/standalone-publisher.js';
import { fetchRemoteState } from '../remote-state.js';
import { resolveIdentity } from './identity.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

/** The subset of the shared client config file standalone mode consumes. */
interface ClientConfigFile {
  network?: 'mainnet' | 'testnet' | 'devnet' | 'custom';
  mnemonicAccountIndex?: number;
  btpUrl?: string;
  proxyUrl?: string;
  relayUrl?: string;
  destination?: string;
  publishDestination?: string;
  storeDestination?: string;
  feePerEvent?: string;
  channelStorePath?: string;
  supportedChains?: string[];
  settlementAddresses?: Record<string, string>;
  preferredTokens?: Record<string, string>;
  tokenNetworks?: Record<string, string>;
  chainRpcUrls?: Record<string, string>;
  solanaChannel?: ToonClientConfig['solanaChannel'];
  minaChannel?: ToonClientConfig['minaChannel'];
}

/** An identity was resolved, but there is no way to send paid writes. */
export class MissingUplinkError extends Error {
  constructor(configPath: string) {
    super(
      'no write uplink configured: set TOON_CLIENT_PROXY_URL ' +
        '(connector payment proxy) or TOON_CLIENT_BTP_URL, or add ' +
        `proxyUrl/btpUrl to ${configPath}`
    );
    this.name = 'MissingUplinkError';
  }
}

function configDir(env: NodeJS.ProcessEnv): string {
  return env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

function readClientConfig(path: string): ClientConfigFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClientConfigFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Assemble an embedded-client standalone context: resolved identity + config
 * → ToonClientConfig → nonce-guarded StandalonePublisher (guard + client
 * start + channel open happen lazily on the first paid call, or eagerly via
 * the publisher's own `start`).
 */
export async function createStandaloneContext(
  options: StandaloneLoadOptions
): Promise<StandaloneContext> {
  const { env } = options;
  const dir = configDir(env);
  const configPath = join(dir, 'config.json');
  const file = readClientConfig(configPath);
  const identity = await resolveIdentity(options);

  const proxyUrl = env['TOON_CLIENT_PROXY_URL'] ?? file.proxyUrl;
  const btpUrl = env['TOON_CLIENT_BTP_URL'] ?? file.btpUrl;
  if (!proxyUrl && !btpUrl) throw new MissingUplinkError(configPath);

  const genesisSeed = GenesisPeerLoader.loadGenesisPeers()[0];
  const relayUrl =
    env['TOON_CLIENT_RELAY_URL'] ??
    file.relayUrl ??
    genesisSeed?.relayUrl ??
    'ws://localhost:7100';
  const destination =
    env['TOON_CLIENT_DESTINATION'] ??
    file.destination ??
    genesisSeed?.ilpAddress ??
    'g.proxy';
  const publishDestination =
    env['TOON_CLIENT_PUBLISH_DESTINATION'] ?? file.publishDestination;
  const storeDestination =
    env['TOON_CLIENT_STORE_DESTINATION'] ?? file.storeDestination;
  const network = (env['TOON_CLIENT_NETWORK'] ?? file.network) as
    | ToonClientConfig['network']
    | undefined;
  const channelStorePath = file.channelStorePath ?? join(dir, 'channels.json');
  const eventFee = BigInt(file.feePerEvent ?? '1');

  const clientConfig: ToonClientConfig = {
    // validateConfig requires connectorUrl OR proxyUrl; with BTP-only config a
    // dummy connectorUrl satisfies it (unused at runtime — same convention as
    // the daemon).
    ...(proxyUrl ? { proxyUrl } : { connectorUrl: 'http://127.0.0.1:1' }),
    mnemonic: identity.mnemonic,
    mnemonicAccountIndex: identity.accountIndex,
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
    relayUrl: '', // remote state uses fetchRemoteState, not bootstrap discovery
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

  // Peer→channel persistence (#262): paid commands resume the channel
  // recorded for (identity, destination) and record fresh opens, so
  // sequential CLI invocations share ONE on-chain channel. The watermark
  // path is the SAME channels.json the embedded client persists nonces to.
  const channelMap = new ChannelMapStore({
    mapPath: join(dir, RIG_CHANNEL_MAP_FILENAME),
    watermarkPath: channelStorePath,
  });

  const publisher = new StandalonePublisher({
    clientConfig,
    eventFee,
    channelMap,
    warn: (line) => options.warn(line),
    ...(publishDestination ? { publishDestination } : {}),
    ...(storeDestination ? { storeDestination } : {}),
  });

  return {
    ownerPubkey: publisher.getPublicKey(),
    identitySource: identity.source,
    identitySourceLabel: identity.sourceLabel,
    publisher,
    defaultRelayUrls: [relayUrl],
    fetchRemote: (args) => fetchRemoteState(args),
    stop: () => publisher.stop(),
  };
}
