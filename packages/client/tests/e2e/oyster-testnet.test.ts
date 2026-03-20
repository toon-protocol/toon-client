/**
 * E2E Test: ToonClient against Oyster CVM on Arbitrum Sepolia
 *
 * **Prerequisites:**
 * 1. Oyster CVM enclave running with a TOON peer node
 * 2. Client wallet funded on Arbitrum Sepolia (0.005 ETH + 1 USDC)
 *
 * **Environment variables (all optional, defaults to current Oyster deployment):**
 * - OYSTER_ENCLAVE_IP  — Enclave IP (default: 13.204.22.97)
 * - CLIENT_PRIVATE_KEY  — Funded wallet private key on Arb Sepolia
 *
 * **What this test verifies:**
 * - BLS health endpoint reachable from public internet
 * - Nostr relay WebSocket connection through Oyster CVM
 * - BTP WebSocket connection to embedded connector
 * - ToonClient bootstrap against a real testnet peer
 * - Event publishing via ILP with payment channel
 * - Payment channel creation on TokenNetwork (Arb Sepolia)
 *
 * Run:
 *   source ../../.env.oyster && cd packages/client && pnpm test:e2e -- oyster-testnet
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { ToonClient } from '../../src/ToonClient.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Configuration — env vars or defaults from current Oyster deployment
// ---------------------------------------------------------------------------

const ENCLAVE_IP = process.env['OYSTER_ENCLAVE_IP'] || '13.204.22.97';

const BLS_URL = `http://${ENCLAVE_IP}:3100`;
const RELAY_URL = `ws://${ENCLAVE_IP}:7100`;
const BTP_URL = `ws://${ENCLAVE_IP}:3000`;

// Arbitrum Sepolia (421614)
const CHAIN_RPC = process.env['SETTLEMENT_RPC_URL'] || 'https://sepolia-rollup.arbitrum.io/rpc';
const CHAIN_ID = 'evm:base:421614';
const TOKEN_ADDRESS = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'; // USDC on Arb Sepolia
const TOKEN_NETWORK_ADDRESS = '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa'; // TokenNetwork on Arb Sepolia

// Client wallet (funded on Arb Sepolia: 0.005 ETH + 1 USDC)
const CLIENT_PRIVATE_KEY =
  process.env['CLIENT_PRIVATE_KEY'] ||
  '0x2a4a97479b2fc81bda7df10ff4b5bb7b932154b27b8bd64fb794ee2c180138f5';
const CLIENT_ADDRESS = '0x81CD5201F973c522560a6Fa3bdA84baCD466bBb0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HealthResponse {
  status: string;
  nodeId: string;
  pubkey: string;
  ilpAddress: string;
  sdk: boolean;
  embedded: boolean;
  bootstrapPhase: string;
  peerCount: number;
}

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${BLS_URL}/health`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

function connectWebSocket(url: string, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeoutMs);

    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });

    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function waitForEventOnRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs = 15000
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const subId = `test-${Date.now()}`;
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
            const toonBytes = new TextEncoder().encode(msg[2]);
            const event = decodeEventFromToon(toonBytes);
            cleanup();
            resolve(event as unknown as Record<string, unknown>);
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('ToonClient against Oyster CVM (Arbitrum Sepolia)', () => {
  let health: HealthResponse | null = null;
  let servicesReady = false;

  beforeAll(async () => {
    console.log(`\nOyster CVM target: ${ENCLAVE_IP}`);
    console.log(`  BLS:   ${BLS_URL}`);
    console.log(`  Relay: ${RELAY_URL}`);
    console.log(`  BTP:   ${BTP_URL}`);
    console.log(`  Chain: Arbitrum Sepolia (421614)`);
    console.log(`  Client: ${CLIENT_ADDRESS}\n`);

    health = await fetchHealth();
    if (!health) {
      console.warn('Oyster CVM not reachable. Is the enclave running?');
      return;
    }

    servicesReady = true;
    console.log(`Node: ${health.nodeId} (${health.pubkey.slice(0, 16)}...)`);
    console.log(`ILP:  ${health.ilpAddress}`);
    console.log(`Phase: ${health.bootstrapPhase}, peers: ${health.peerCount}\n`);
  }, 20000);

  function skipIfNotReady(): boolean {
    if (!servicesReady) {
      if (process.env['CI']) {
        throw new Error('Oyster CVM not reachable — cannot run in CI.');
      }
      console.log('Skipping: Oyster CVM not reachable');
      return true;
    }
    return false;
  }

  // =========================================================================
  // 1. HEALTH CHECK
  // =========================================================================

  it('should return healthy BLS endpoint with SDK embedded connector', async () => {
    if (skipIfNotReady()) return;

    expect(health!.status).toBe('healthy');
    expect(health!.sdk).toBe(true);
    expect(health!.embedded).toBe(true);
    expect(health!.bootstrapPhase).toBe('ready');
    expect(health!.nodeId).toBe('oyster-node-1');
    expect(health!.ilpAddress).toBe('g.toon.oyster.node1');

    console.log('Health check passed');
  });

  // =========================================================================
  // 2. RELAY WEBSOCKET
  // =========================================================================

  it('should connect to Nostr relay WebSocket', async () => {
    if (skipIfNotReady()) return;

    const connected = await connectWebSocket(RELAY_URL);
    expect(connected).toBe(true);

    console.log('Relay WebSocket connected');
  }, 15000);

  // =========================================================================
  // 3. BTP WEBSOCKET
  // =========================================================================

  it('should connect to BTP WebSocket on embedded connector', async () => {
    if (skipIfNotReady()) return;

    const connected = await connectWebSocket(BTP_URL);
    expect(connected).toBe(true);

    console.log('BTP WebSocket connected');
  }, 15000);

  // =========================================================================
  // 4. BOOTSTRAP (sans payment channels)
  // =========================================================================

  it('should bootstrap ToonClient against Oyster peer', async () => {
    if (skipIfNotReady()) return;

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);

    console.log(`Client pubkey: ${pubkey.slice(0, 16)}...`);

    const client = new ToonClient({
      connectorUrl: BLS_URL,
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: `g.toon.test.${pubkey.slice(0, 8)}`,
        btpEndpoint: BTP_URL,
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      knownPeers: [
        {
          pubkey: health!.pubkey,
          relayUrl: RELAY_URL,
          btpEndpoint: BTP_URL,
        },
      ],
      // EVM config for Arb Sepolia with deployed TokenNetwork
      evmPrivateKey: CLIENT_PRIVATE_KEY,
      chainRpcUrls: {
        [CHAIN_ID]: CHAIN_RPC,
      },
      supportedChains: [CHAIN_ID],
      settlementAddresses: {
        [CHAIN_ID]: CLIENT_ADDRESS,
      },
      preferredTokens: {
        [CHAIN_ID]: TOKEN_ADDRESS,
      },
      tokenNetworks: {
        [CHAIN_ID]: TOKEN_NETWORK_ADDRESS,
      },
      btpUrl: BTP_URL,
      destinationAddress: health!.ilpAddress,
    });

    console.log('Starting bootstrap...');
    const startResult = await client.start();

    expect(startResult.mode).toBe('http');
    expect(client.isStarted()).toBe(true);

    console.log(`Bootstrap complete! Mode: ${startResult.mode}, peers: ${startResult.peersDiscovered}`);

    // With TokenNetwork deployed, a payment channel should be created
    const channels = client.getTrackedChannels();
    console.log(`Tracked channels: ${channels.length}`);
    expect(channels.length).toBeGreaterThan(0);

    await client.stop();
    expect(client.isStarted()).toBe(false);
    console.log('Client stopped cleanly');
  }, 120000);

  // =========================================================================
  // 5. PUBLISH EVENT (with payment channel)
  // =========================================================================

  it('should publish event via ILP with signed balance proof claim', async () => {
    if (skipIfNotReady()) return;

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);

    const client = new ToonClient({
      connectorUrl: BLS_URL,
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: `g.toon.test.${pubkey.slice(0, 8)}`,
        btpEndpoint: BTP_URL,
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      knownPeers: [
        {
          pubkey: health!.pubkey,
          relayUrl: RELAY_URL,
          btpEndpoint: BTP_URL,
        },
      ],
      evmPrivateKey: CLIENT_PRIVATE_KEY,
      chainRpcUrls: {
        [CHAIN_ID]: CHAIN_RPC,
      },
      supportedChains: [CHAIN_ID],
      settlementAddresses: {
        [CHAIN_ID]: CLIENT_ADDRESS,
      },
      preferredTokens: {
        [CHAIN_ID]: TOKEN_ADDRESS,
      },
      tokenNetworks: {
        [CHAIN_ID]: TOKEN_NETWORK_ADDRESS,
      },
      btpUrl: BTP_URL,
      destinationAddress: health!.ilpAddress,
    });

    await client.start();

    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;
    console.log(`Channel: ${channelId.slice(0, 18)}...`);

    // Create and sign a Nostr event
    const testContent = `Oyster CVM testnet E2E - ${Date.now()}`;
    const event = finalizeEvent(
      {
        kind: 1,
        content: testContent,
        tags: [['t', 'oyster-e2e']],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    // Sign balance proof for the payment amount
    // basePricePerByte=10, amount = 10 * toonData.length
    const toonData = encodeEventToToon(event);
    const paymentAmount = BigInt(10) * BigInt(toonData.length);
    const claim = await client.signBalanceProof(channelId, paymentAmount);
    console.log(`Claim: nonce=${claim.nonce}, amount=${claim.transferredAmount}`);

    console.log(`Publishing event ${event.id.slice(0, 16)}... with claim`);

    const publishResult = await client.publishEvent(event, { claim });
    console.log(`Result: ${publishResult.success ? 'success' : 'rejected'}`);
    if (publishResult.error) console.log(`Error: ${publishResult.error}`);
    expect(publishResult.success).toBe(true);
    console.log(`Fulfillment: ${publishResult.fulfillment?.slice(0, 32)}...`);

    // Verify event stored on relay
    console.log('Verifying event on relay...');
    const stored = await waitForEventOnRelay(RELAY_URL, event.id, 15000);
    expect(stored).not.toBeNull();
    expect(stored!['id']).toBe(event.id);
    expect(stored!['content']).toBe(testContent);
    console.log('Event verified on relay!');

    await client.stop();
    console.log('Client stopped cleanly');
  }, 120000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
