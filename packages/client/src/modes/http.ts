import { BootstrapService, createDiscoveryTracker } from '@toon-protocol/core';
import type { BootstrapServiceConfig } from '@toon-protocol/core';
import { HttpRuntimeClient } from '../adapters/HttpRuntimeClient.js';
import { BtpRuntimeClient } from '../adapters/BtpRuntimeClient.js';
import { HttpIlpClient } from '../adapters/HttpIlpClient.js';
import {
  selectIlpTransport,
  readDiscoveredIlpPeer,
} from '../adapters/selectIlpTransport.js';
import { OnChainChannelClient } from '../channel/OnChainChannelClient.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { buildSettlementInfo } from '../config.js';
import type { ResolvedConfig } from '../config.js';
import type { HttpModeInitialization } from './types.js';

/**
 * Initializes HTTP mode for ToonClient.
 *
 * HTTP mode uses external connector service via HTTP/WebSocket.
 * This function creates all necessary clients and services for operating in HTTP mode.
 *
 * @param config - ToonClient configuration (must have connectorUrl)
 * @returns Initialized HTTP mode components
 */
export async function initializeHttpMode(
  config: ResolvedConfig
): Promise<HttpModeInitialization> {
  const effectiveBtpUrl = config.btpUrl;
  const effectiveConnectorUrl = config.connectorUrl;

  // Build settlement info from config
  const settlementInfo = buildSettlementInfo(config);

  // Select the ILP transport for the uplink connector.
  //
  // The connector serves ILP-over-HTTP (`POST /ilp`) and BTP on the SAME port
  // (connector PR #181). A peer advertises the `POST /ilp` URL in discovery via
  // `IlpPeerInfo.httpEndpoint` (+ `supportsUpgrade`) added in toon PR #29.
  //
  // The client SDK's only "peer" at init time is its uplink connector, so we
  // build a DiscoveredIlpPeer from the connector endpoints we know: the derived
  // BTP WebSocket URL plus an optional explicit `connectorHttpEndpoint` (which
  // mirrors the on-wire `httpEndpoint`). `readDiscoveredIlpPeer` reads those
  // fields defensively so this stays compatible with the installed
  // @toon-protocol/core 1.4.2 (pre-PR-#29).
  //
  // NOTE(dep): once a @toon-protocol/core release with the PR-#29
  // `httpEndpoint`/`supportsUpgrade` IlpPeerInfo fields is published (latest on
  // npm is still 1.4.2), bump the dep and feed real discovered peer info here
  // instead of (or in addition to) the explicit config field.
  //
  // FALLBACK GUARANTEE: when no `httpEndpoint` is present (the default — no
  // connector advertises one yet, and `connectorHttpEndpoint` is unset),
  // `selectIlpTransport` returns `{ kind: 'btp' }`, which is exactly the prior
  // behavior. Existing BTP-only flows are unchanged.
  const discoveredPeer = readDiscoveredIlpPeer({
    btpEndpoint: effectiveBtpUrl,
    httpEndpoint: config.connectorHttpEndpoint,
    supportsUpgrade: config.connectorSupportsUpgrade,
  });

  // The client SDK's runtime client is a one-shot consumer (it sends ILP
  // packets and reads the synchronous FULFILL/REJECT). It does not need a duplex
  // session at the transport-selection layer, so `needsDuplex` stays false and
  // HTTP is preferred when advertised. A `btpEndpoint` is always present when
  // `btpUrl` is configured, so HTTP is only ever selected when an httpEndpoint
  // is explicitly available.
  const transportChoice =
    discoveredPeer.httpEndpoint || discoveredPeer.btpEndpoint
      ? selectIlpTransport(discoveredPeer, { needsDuplex: false })
      : null;

  // Create BTP runtime client — the duplex transport for the client SDK.
  // The client connects to the connector via BTP WebSocket to send ILP packets
  // AND to receive server-initiated packets / act as a peer. We always open it
  // when a btpUrl is configured (publishing, swaps and payments require it), so
  // ToonClient's `btpClient`-gated paths keep working even when one-shot writes
  // go over HTTP.
  let btpClient: BtpRuntimeClient | null = null;
  if (effectiveBtpUrl) {
    btpClient = new BtpRuntimeClient({
      btpUrl: effectiveBtpUrl,
      peerId: config.btpPeerId ?? `client`,
      authToken: config.btpAuthToken ?? '',
    });
    await btpClient.connect();
  }

  // Build the HTTP one-shot client when the transport policy selected it.
  let httpIlpClient: HttpIlpClient | null = null;
  if (
    transportChoice &&
    (transportChoice.kind === 'http' ||
      transportChoice.kind === 'http-upgradable')
  ) {
    httpIlpClient = new HttpIlpClient({
      httpEndpoint: transportChoice.httpEndpoint,
      ...(config.btpPeerId !== undefined ? { peerId: config.btpPeerId } : {}),
      ...(config.btpAuthToken !== undefined
        ? { authToken: config.btpAuthToken }
        : {}),
      timeout: config.queryTimeout,
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay,
    });
  }

  // Runtime client precedence for sending ILP packets:
  //   1. HttpIlpClient  — when the connector advertises an httpEndpoint (PR #29).
  //   2. BtpRuntimeClient — the BTP WebSocket (existing default; FALLBACK).
  //   3. HttpRuntimeClient — connector-admin-style HTTP when no btpUrl at all.
  const runtimeClient =
    httpIlpClient ??
    btpClient ??
    new HttpRuntimeClient({
      connectorUrl: effectiveConnectorUrl,
      timeout: config.queryTimeout,
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay,
    });

  // Create on-chain channel client when chain RPC URLs are configured.
  // evmPrivateKey is always present (derived from secretKey by default).
  let onChainChannelClient: OnChainChannelClient | null = null;
  if (config.chainRpcUrls) {
    const evmSigner = new EvmSigner(config.evmPrivateKey);
    onChainChannelClient = new OnChainChannelClient({
      evmSigner,
      chainRpcUrls: config.chainRpcUrls,
    });
  }

  // Create BootstrapService
  const bootstrapConfig: BootstrapServiceConfig = {
    knownPeers: (config.knownPeers || []).map((p) => ({
      pubkey: p.pubkey,
      relayUrl: p.relayUrl,
      btpEndpoint: p.btpEndpoint ?? '',
    })),
    queryTimeout: config.queryTimeout,
    ardriveEnabled: true,
    defaultRelayUrl: config.relayUrl,
    settlementInfo,
    ownIlpAddress: config.ilpInfo.ilpAddress,
    toonEncoder: config.toonEncoder,
    toonDecoder: config.toonDecoder,
    basePricePerByte: 10n, // Match network default (10 micro-USDC per byte)
  };

  const bootstrapService = new BootstrapService(
    bootstrapConfig,
    config.secretKey,
    config.ilpInfo
  );

  // Wire ILP client into bootstrap service
  bootstrapService.setIlpClient(runtimeClient);

  // Wire on-chain channel client if available
  if (onChainChannelClient) {
    bootstrapService.setChannelClient(onChainChannelClient);
  }

  // Do NOT wire ConnectorAdmin — addPeer() at line 472 is skipped when connectorAdmin is null
  // This is intentional: the client is a standalone peer, not an admin interface

  // Create DiscoveryTracker
  const discoveryTracker = createDiscoveryTracker({
    secretKey: config.secretKey,
    settlementInfo,
  });

  return {
    bootstrapService,
    discoveryTracker,
    runtimeClient,
    adminClient: null,
    btpClient,
    onChainChannelClient,
  };
}
