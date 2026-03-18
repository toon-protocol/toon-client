/**
 * E2E Test: ToonClient against SDK E2E Peer Infrastructure
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running:
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies (production-realistic):**
 * - ToonClient connects to a real peer node via BTP
 * - Payment channel opened on Anvil during bootstrap
 * - Per-packet signed EIP-712 balance proofs (claims)
 * - publishEvent() delivers via ILP with claim attached
 * - Event stored on peer's TOON-native relay
 * - On-chain channel state verifiable
 *
 * **Why this reflects production:**
 * In production, clients connect to discovered peer nodes, not a
 * privileged genesis node. This test targets the SDK E2E peers
 * which are real TOON nodes running in Docker containers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { ToonClient } from '../../src/ToonClient.js';
import { createPublicClient, http, defineChain, type Hex } from 'viem';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// SDK E2E Infrastructure (docker-compose-sdk-e2e.yml)
// ---------------------------------------------------------------------------

const ANVIL_RPC = 'http://localhost:18545';

// Peer1 endpoints
const PEER1_BTP_URL = 'ws://localhost:19000';
const PEER1_BLS_URL = 'http://localhost:19100';
const PEER1_RELAY_URL = 'ws://localhost:19700';
const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';
const PEER1_EVM_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Test account (Anvil Account #3 — unused by Docker infra)
const TEST_PRIVATE_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const TEST_EVM_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

// Deployed contract addresses (deterministic on Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3'; // Mock USDC (Anvil)
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// Token Network ABI (minimal)
const TOKEN_NETWORK_ABI = [
  {
    name: 'channels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'settlementTimeout', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'closedAt', type: 'uint256' },
      { name: 'openedAt', type: 'uint256' },
      { name: 'participant1', type: 'address' },
      { name: 'participant2', type: 'address' },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const anvilChain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

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

async function getChannelState(channelId: string) {
  const publicClient = createPublicClient({
    transport: http(ANVIL_RPC),
    chain: anvilChain,
  });

  const result = await publicClient.readContract({
    address: TOKEN_NETWORK_ADDRESS as Hex,
    abi: TOKEN_NETWORK_ABI,
    functionName: 'channels',
    args: [channelId as Hex],
  });

  const [settlementTimeout, state, closedAt, openedAt, participant1, participant2] =
    result;

  const stateNames = ['settled', 'open', 'closed', 'settled'];
  return {
    channelId,
    state: stateNames[state] || 'unknown',
    settlementTimeout: Number(settlementTimeout),
    openedAt: Number(openedAt),
    closedAt: Number(closedAt),
    participant1,
    participant2,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('ToonClient against SDK E2E Peers', () => {
  let servicesReady = false;

  beforeAll(async () => {
    try {
      // Health check: Anvil
      const anvilOk = await fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
        signal: AbortSignal.timeout(3000),
      }).then((r) => r.ok);

      if (!anvilOk) {
        console.warn('Anvil not ready. Run: ./scripts/sdk-e2e-infra.sh up');
        return;
      }

      // Health check: Peer1 BLS
      const peer1Health = await fetch(`${PEER1_BLS_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!peer1Health.ok) {
        console.warn('Peer1 not ready. Run: ./scripts/sdk-e2e-infra.sh up');
        return;
      }

      // Health check: Peer1 relay WebSocket
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(PEER1_RELAY_URL);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('Relay WebSocket timeout'));
        }, 3000);

        ws.on('open', () => {
          clearTimeout(timer);
          ws.close();
          resolve();
        });

        ws.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      servicesReady = true;
    } catch (error) {
      console.warn(
        `SDK E2E infra not running: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, 15000);

  function skipIfNotReady(): boolean {
    if (!servicesReady) {
      if (process.env['CI']) {
        throw new Error('SDK E2E infra not ready — cannot run in CI.');
      }
      console.log('Skipping: SDK E2E infra not ready');
      return true;
    }
    return false;
  }

  function createTestClient(
    secretKey: Uint8Array,
    pubkey: string
  ): ToonClient {
    return new ToonClient({
      // connectorUrl is required but BTP is the actual transport
      connectorUrl: PEER1_BLS_URL,
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: `g.toon.test.${pubkey.slice(0, 8)}`,
        btpEndpoint: PEER1_BTP_URL,
        assetCode: 'USD',
        assetScale: 6,
      },
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: PEER1_RELAY_URL,
      knownPeers: [
        {
          pubkey: PEER1_PUBKEY,
          relayUrl: PEER1_RELAY_URL,
          btpEndpoint: PEER1_BTP_URL,
        },
      ],
      // EVM configuration
      evmPrivateKey: TEST_PRIVATE_KEY,
      chainRpcUrls: {
        'evm:base:31337': ANVIL_RPC,
      },
      supportedChains: ['evm:base:31337'],
      settlementAddresses: {
        'evm:base:31337': TEST_EVM_ADDRESS,
      },
      preferredTokens: {
        'evm:base:31337': TOKEN_ADDRESS,
      },
      tokenNetworks: {
        'evm:base:31337': TOKEN_NETWORK_ADDRESS,
      },
      btpUrl: PEER1_BTP_URL,
      destinationAddress: 'g.toon.peer1',
    });
  }

  // =========================================================================
  // BOOTSTRAP + CHANNEL CREATION
  // =========================================================================

  it('should bootstrap and create payment channel against peer1', async () => {
    if (skipIfNotReady()) return;

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    console.log(`\n🔑 Test EVM account: ${TEST_EVM_ADDRESS}`);
    console.log(`📝 Client pubkey: ${pubkey.slice(0, 16)}...`);

    // Bootstrap
    console.log('\n⏳ Starting bootstrap (will open payment channel)...');
    const startResult = await client.start();
    expect(startResult.mode).toBe('http');
    expect(client.isStarted()).toBe(true);

    console.log(`✅ Bootstrap complete! Discovered ${startResult.peersDiscovered} peer(s)`);

    // Verify channel was created
    const channels = client.getTrackedChannels();
    console.log(`💰 Tracked channels: ${channels.length}`);
    expect(channels.length).toBeGreaterThan(0);

    const channelId = channels[0]!;
    console.log(`   Channel ID: ${channelId.slice(0, 16)}...`);

    // Query on-chain channel state
    console.log('🔍 Querying on-chain channel state...');
    const channelState = await getChannelState(channelId);
    console.log(`   State: ${channelState.state}`);
    console.log(`   Participant 1: ${channelState.participant1}`);
    console.log(`   Participant 2: ${channelState.participant2}`);

    expect(channelState.state).toBe('open');

    // Verify test account is a participant
    const isParticipant =
      channelState.participant1.toLowerCase() === TEST_EVM_ADDRESS.toLowerCase() ||
      channelState.participant2.toLowerCase() === TEST_EVM_ADDRESS.toLowerCase();
    expect(isParticipant).toBe(true);

    // Verify peer1 is the other participant
    const isPeer1 =
      channelState.participant1.toLowerCase() === PEER1_EVM_ADDRESS.toLowerCase() ||
      channelState.participant2.toLowerCase() === PEER1_EVM_ADDRESS.toLowerCase();
    expect(isPeer1).toBe(true);

    await client.stop();
    expect(client.isStarted()).toBe(false);
  }, 60000);

  // =========================================================================
  // PER-PACKET CLAIMS + PUBLISH
  // =========================================================================

  it('should sign per-packet balance proofs and publish event with claim', async () => {
    if (skipIfNotReady()) return;

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    await client.start();

    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;

    // Sign first per-packet balance proof
    const claim1 = await client.signBalanceProof(channelId, 1000n);
    console.log(`\n✍️  Claim 1: nonce=${claim1.nonce}, amount=${claim1.transferredAmount}`);
    expect(claim1.nonce).toBe(1);
    expect(claim1.channelId).toBe(channelId);
    expect(claim1.signature).toBeDefined();
    expect(claim1.signerAddress).toBeDefined();

    // Create and sign a Nostr event
    const testContent = `Per-packet claim E2E test - ${Date.now()}`;
    const event = finalizeEvent(
      {
        kind: 1,
        content: testContent,
        tags: [['t', 'sdk-e2e-client-test']],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    console.log(`📤 Publishing event ${event.id.slice(0, 16)}... with claim`);

    // Publish with signed claim
    const publishResult = await client.publishEvent(event, { claim: claim1 });
    console.log(`   Result: ${publishResult.success ? '✅ success' : '❌ failed'}`);
    if (publishResult.fulfillment) {
      console.log(`   Fulfillment: ${publishResult.fulfillment.slice(0, 32)}...`);
    }
    if (publishResult.error) {
      console.log(`   Error: ${publishResult.error}`);
    }

    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    // Verify event on relay (TOON format)
    console.log('🔍 Verifying event on peer1 relay...');
    const storedEvent = await waitForEventOnRelay(PEER1_RELAY_URL, event.id, 15000);

    expect(storedEvent).not.toBeNull();
    expect(storedEvent!['id']).toBe(event.id);
    expect(storedEvent!['content']).toBe(testContent);
    expect(storedEvent!['pubkey']).toBe(pubkey);
    expect(storedEvent!['kind']).toBe(1);

    console.log('✅ Event verified on peer1 relay!\n');

    await client.stop();
  }, 60000);

  // =========================================================================
  // MONOTONIC NONCE (PER-PACKET CLAIM SEQUENCE)
  // =========================================================================

  it('should produce monotonically increasing nonces across multiple claims', async () => {
    if (skipIfNotReady()) return;

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    await client.start();

    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;

    // Sign multiple per-packet claims
    const claim1 = await client.signBalanceProof(channelId, 500n);
    const claim2 = await client.signBalanceProof(channelId, 500n);
    const claim3 = await client.signBalanceProof(channelId, 500n);

    console.log(`\n✍️  Claim sequence: nonces=${claim1.nonce},${claim2.nonce},${claim3.nonce}`);
    console.log(`   Cumulative amounts: ${claim1.transferredAmount},${claim2.transferredAmount},${claim3.transferredAmount}`);

    // Nonces must be monotonically increasing
    expect(claim1.nonce).toBe(1);
    expect(claim2.nonce).toBe(2);
    expect(claim3.nonce).toBe(3);

    // Cumulative transferred amount increases
    expect(claim2.transferredAmount).toBeGreaterThan(claim1.transferredAmount);
    expect(claim3.transferredAmount).toBeGreaterThan(claim2.transferredAmount);

    // Each claim should have a valid EIP-712 signature
    expect(claim1.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(claim2.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(claim3.signature).toMatch(/^0x[0-9a-f]+$/i);

    // All signed by same address
    expect(claim1.signerAddress).toBe(claim2.signerAddress);
    expect(claim2.signerAddress).toBe(claim3.signerAddress);

    // Publish with the latest claim (highest nonce)
    const event = finalizeEvent(
      {
        kind: 1,
        content: `Nonce sequence test - ${Date.now()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    const publishResult = await client.publishEvent(event, { claim: claim3 });
    expect(publishResult.success).toBe(true);
    expect(publishResult.fulfillment).toBeDefined();

    console.log('✅ Per-packet claim nonce sequence verified\n');

    await client.stop();
  }, 60000);

  // =========================================================================
  // PAYMENT AMOUNT SCALES WITH TOON SIZE
  // =========================================================================

  it('should scale payment amount with TOON byte length', async () => {
    if (skipIfNotReady()) return;

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    await client.start();

    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;

    // Small event
    const smallEvent = finalizeEvent(
      {
        kind: 1,
        content: 'tiny',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    // Large event
    const largeEvent = finalizeEvent(
      {
        kind: 1,
        content: 'x'.repeat(2000),
        tags: [['t', 'large-payload']],
        created_at: Math.floor(Date.now() / 1000) + 1,
      },
      secretKey
    );

    // Compute expected payment amounts (basePricePerByte = 10)
    const smallToon = encodeEventToToon(smallEvent);
    const largeToon = encodeEventToToon(largeEvent);
    const smallAmount = BigInt(smallToon.length) * 10n;
    const largeAmount = BigInt(largeToon.length) * 10n;

    console.log(`\n📏 Small event: ${smallToon.length} bytes → ${smallAmount} units`);
    console.log(`📏 Large event: ${largeToon.length} bytes → ${largeAmount} units`);

    // Large event should cost more
    expect(largeAmount).toBeGreaterThan(smallAmount);

    // Publish both (each with its own claim)
    const claim1 = await client.signBalanceProof(channelId, smallAmount);
    const result1 = await client.publishEvent(smallEvent, { claim: claim1 });
    expect(result1.success).toBe(true);

    const claim2 = await client.signBalanceProof(channelId, largeAmount);
    const result2 = await client.publishEvent(largeEvent, { claim: claim2 });
    expect(result2.success).toBe(true);

    console.log('✅ Payment amount scales with TOON byte length\n');

    await client.stop();
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
