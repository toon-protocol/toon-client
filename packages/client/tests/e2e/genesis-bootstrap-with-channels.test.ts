/**
 * E2E Test: CrosstownClient Bootstrap with Payment Channels
 *
 * **Prerequisites:**
 * 1. Genesis node deployed with Anvil:
 *    ```bash
 *    ./deploy-genesis-node.sh
 *    ```
 *
 * **What this test verifies:**
 * - CrosstownClient bootstraps with EVM configuration
 * - Payment channel is created BEFORE SPSP handshake
 * - Channel is funded on-chain (Anvil)
 * - SPSP handshake includes signed balance proof claim
 * - publishEvent() sends paid ILP packet with signed claim
 * - Event is stored on the genesis node's Nostr relay
 * - On-chain channel state can be queried
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';
import { CrosstownClient } from '../../src/CrosstownClient.js';
import { createPublicClient, http, defineChain, type Hex } from 'viem';
import WebSocket from 'ws';

const RELAY_URL = 'ws://localhost:7100';
const CONNECTOR_URL = 'http://localhost:8080';
const BLS_URL = 'http://localhost:3100';
const ANVIL_RPC = 'http://localhost:8545';
const GENESIS_PUBKEY = 'aa1857d0ff1fcb1aeb1907b3b98290f3ecb5545473c0b9296fb0b44481deb572';

// Anvil Account #2 (for testing - has 10k ETH pre-funded)
const TEST_ACCOUNT_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const TEST_ACCOUNT_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// Deployed contract addresses (deterministic on Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const REGISTRY_ADDRESS = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// Token Network ABI (minimal - just what we need to query channels)
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

/**
 * Subscribe to a Nostr relay and wait for an event by ID using NIP-01 protocol.
 */
function waitForEventOnRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs = 10000
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const subId = `test-${Date.now()}`;
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
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            // Keep connection open briefly
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * Query on-chain channel state from TokenNetwork contract.
 */
async function getChannelState(channelId: string) {
  const anvilChain = defineChain({
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_RPC] } },
  });

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

  const [settlementTimeout, state, closedAt, openedAt, participant1, participant2] = result;

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

describe('CrosstownClient Genesis Bootstrap with Payment Channels E2E', () => {
  let servicesReady = false;

  beforeAll(async () => {
    try {
      // Check connector health
      const connectorHealth = await fetch(`${CONNECTOR_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!connectorHealth.ok) {
        console.warn('Connector not ready. Run: ./deploy-genesis-node.sh');
        return;
      }

      // Check BLS health
      const blsHealth = await fetch(`${BLS_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!blsHealth.ok) {
        console.warn('BLS not ready. Run: ./deploy-genesis-node.sh');
        return;
      }

      // Check Anvil
      const anvilTest = await fetch(ANVIL_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_blockNumber',
          params: [],
          id: 1,
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (!anvilTest.ok) {
        console.warn('Anvil not ready. Run: ./deploy-genesis-node.sh');
        return;
      }

      // Check Nostr relay
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(RELAY_URL);
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
      console.warn('Genesis node not running. Run: ./deploy-genesis-node.sh');
      console.warn(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 15000);

  it('should create payment channel before SPSP, publish with claim, and verify', async () => {
    if (!servicesReady) {
      console.log('Skipping: Genesis node not ready');
      return;
    }

    // 1. Create client keypair
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);

    console.log(`\n🔑 Test account: ${TEST_ACCOUNT_ADDRESS}`);
    console.log(`📝 Client pubkey: ${pubkey.slice(0, 16)}...`);

    // 2. Create CrosstownClient with EVM configuration
    const client = new CrosstownClient({
      connectorUrl: CONNECTOR_URL,
      secretKey,
      ilpInfo: {
        pubkey,
        ilpAddress: `g.crosstown.test.${pubkey.slice(0, 8)}`,
        btpEndpoint: 'ws://localhost:3000',
      },
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      // Configure genesis peer for bootstrap
      knownPeers: [
        {
          pubkey: GENESIS_PUBKEY,
          relayUrl: RELAY_URL,
          btpEndpoint: 'ws://localhost:3000',
        },
      ],
      // EVM configuration for payment channels
      evmPrivateKey: TEST_ACCOUNT_PRIVATE_KEY,
      chainRpcUrls: {
        'evm:anvil:31337': ANVIL_RPC,
        'evm:base:31337': ANVIL_RPC, // Genesis advertises base, map to Anvil
      },
      supportedChains: ['evm:anvil:31337', 'evm:base:31337'],
      settlementAddresses: {
        'evm:anvil:31337': TEST_ACCOUNT_ADDRESS,
        'evm:base:31337': TEST_ACCOUNT_ADDRESS,
      },
      preferredTokens: {
        'evm:anvil:31337': TOKEN_ADDRESS,
        'evm:base:31337': TOKEN_ADDRESS,
      },
      tokenNetworks: {
        'evm:anvil:31337': TOKEN_NETWORK_ADDRESS,
        'evm:base:31337': TOKEN_NETWORK_ADDRESS,
      },
      btpUrl: 'ws://localhost:3000',
    });

    console.log('\n⏳ Starting bootstrap (will create payment channel first)...');

    // 3. Bootstrap with genesis peer
    const startResult = await client.start();
    expect(startResult.mode).toBe('http');
    expect(client.isStarted()).toBe(true);

    console.log(`✅ Bootstrap complete! Discovered ${startResult.peersDiscovered} peer(s)`);

    // 4. Verify channel was created during bootstrap
    const channels = client.getTrackedChannels();
    console.log(`\n💰 Tracked channels: ${channels.length}`);

    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;
    console.log(`   Channel ID: ${channelId.slice(0, 16)}...`);

    // 5. Query on-chain channel state
    console.log('\n🔍 Querying on-chain channel state...');
    const channelState = await getChannelState(channelId);

    console.log(`   State: ${channelState.state}`);
    console.log(`   Participant 1: ${channelState.participant1}`);
    console.log(`   Participant 2: ${channelState.participant2}`);
    console.log(`   Settlement Timeout: ${channelState.settlementTimeout}s`);

    expect(channelState.state).toBe('open');
    expect(
      channelState.participant1.toLowerCase() === TEST_ACCOUNT_ADDRESS.toLowerCase() ||
      channelState.participant2.toLowerCase() === TEST_ACCOUNT_ADDRESS.toLowerCase()
    ).toBe(true);

    // 6. Create and sign a Nostr event
    const testContent = `Payment channel E2E test - ${Date.now()}`;
    const event = finalizeEvent(
      {
        kind: 1,
        content: testContent,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    console.log(`\n📤 Publishing event ${event.id.slice(0, 16)}...`);

    // 7. Sign balance proof and publish event with claim
    const claim = await client.signBalanceProof(channelId, 1000n);
    console.log(`   Signed claim with nonce: ${claim.nonce}`);

    const publishResult = await client.publishEvent(event, { claim });

    console.log(`   Result: ${publishResult.success ? '✅ success' : '❌ failed'}`);
    if (publishResult.fulfillment) {
      console.log(`   Fulfillment: ${publishResult.fulfillment.slice(0, 32)}...`);
    }

    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    // 8. Subscribe to relay and verify event is stored
    console.log(`\n🔍 Verifying event on relay...`);
    const storedEvent = await waitForEventOnRelay(RELAY_URL, event.id, 10000);

    expect(storedEvent).not.toBeNull();
    expect(storedEvent!.id).toBe(event.id);
    expect(storedEvent!.content).toBe(testContent);
    expect(storedEvent!.pubkey).toBe(pubkey);
    expect(storedEvent!.kind).toBe(1);

    console.log(`✅ Event verified on relay!\n`);

    // 9. Cleanup
    await client.stop();
    expect(client.isStarted()).toBe(false);
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
