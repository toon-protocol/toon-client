/**
 * E2E Test: SDK-Based Relay Validation (Story 2.3)
 *
 * **Purpose:**
 * Verify that an SDK-based relay (packages/town) can replace the manually-wired
 * docker/src/entrypoint.ts while passing all existing E2E behaviors. This is the
 * proof that the SDK is feature-complete for relay use cases.
 *
 * **Prerequisites:**
 * 1. Genesis node deployed with the SDK-based relay (@crosstown/town):
 *    ```bash
 *    # Once packages/town exists and is built:
 *    # deploy-genesis-node.sh using @crosstown/town instead of docker/src/entrypoint.ts
 *    ```
 *
 * **Why this is RED phase (describe.skip):**
 * - @crosstown/town package does not exist yet
 * - @crosstown/sdk package does not exist yet
 * - The SDK handler registry, pricing pipeline, and SPSP handler are unimplemented
 * - No Docker image uses the SDK-based relay entrypoint
 *
 * **What this validates vs existing genesis-bootstrap-with-channels.test.ts:**
 * The existing test validates the manually-wired entrypoint.ts. This test validates
 * the SAME behaviors but running against a genesis node built with the SDK. If both
 * test files pass against the same infrastructure, the SDK is proven equivalent.
 *
 * **Additional SDK-specific assertions:**
 * - Self-write bypass (node's own pubkey writes without payment)
 * - SPSP handled through SDK handler (not manual BLS wiring)
 * - Entrypoint is < 100 lines of handler code
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';
import { CrosstownClient } from '../../src/CrosstownClient.js';
import { createPublicClient, http, defineChain, type Hex } from 'viem';
import WebSocket from 'ws';

// Infrastructure endpoints — same as existing E2E test.
// In the SDK-based deployment, these ports are unchanged; only the internal
// implementation (SDK handlers vs manual wiring) differs.
const RELAY_URL = 'ws://localhost:7100';
const CONNECTOR_URL = 'http://localhost:8080';
const BLS_URL = 'http://localhost:3100';
const ANVIL_RPC = 'http://localhost:8545';
const GENESIS_PUBKEY =
  'aa1857d0ff1fcb1aeb1907b3b98290f3ecb5545473c0b9296fb0b44481deb572';

// Anvil Account #2 (for testing — has 10k ETH pre-funded)
const TEST_ACCOUNT_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const TEST_ACCOUNT_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// Deployed contract addresses (deterministic on Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// Token Network ABI (minimal — just what we need to query channels)
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
 * The relay returns TOON strings in EVENT messages, which we decode.
 */
function waitForEventOnRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs = 10000
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
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            // Keep connection open briefly to allow late-arriving events
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

  const [
    settlementTimeout,
    state,
    closedAt,
    openedAt,
    participant1,
    participant2,
  ] = result;

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

/**
 * Create a CrosstownClient configured for E2E testing against the genesis node.
 * Extracted to reduce duplication across test cases.
 */
function createTestClient(
  secretKey: Uint8Array,
  pubkey: string
): InstanceType<typeof CrosstownClient> {
  return new CrosstownClient({
    connectorUrl: CONNECTOR_URL,
    secretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.crosstown.test.${pubkey.slice(0, 8)}`,
      btpEndpoint: 'ws://localhost:3000',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: RELAY_URL,
    knownPeers: [
      {
        pubkey: GENESIS_PUBKEY,
        relayUrl: RELAY_URL,
        btpEndpoint: 'ws://localhost:3000',
      },
    ],
    evmPrivateKey: TEST_ACCOUNT_PRIVATE_KEY,
    chainRpcUrls: {
      'evm:anvil:31337': ANVIL_RPC,
      'evm:base:31337': ANVIL_RPC,
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
}

// ============================================================================
// describe.skip() — RED PHASE
//
// WILL FAIL because: The SDK-based relay (@crosstown/town) does not exist yet.
// These tests must be run against a genesis node deployed with @crosstown/town
// instead of docker/src/entrypoint.ts. Until Epic 2 (Stories 2.1-2.2) is
// complete, there is no SDK-based relay to test against.
// ============================================================================

describe.skip('SDK-Based Relay Validation (Story 2.3)', () => {
  let servicesReady = false;

  beforeAll(async () => {
    try {
      // Health check: connector
      const connectorHealth = await fetch(`${CONNECTOR_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!connectorHealth.ok) {
        console.warn(
          'Connector not ready. Deploy SDK-based genesis node first.'
        );
        return;
      }

      // Health check: BLS (served by SDK relay in town mode)
      const blsHealth = await fetch(`${BLS_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!blsHealth.ok) {
        console.warn('BLS not ready. Deploy SDK-based genesis node first.');
        return;
      }

      // Verify this is an SDK-based relay (not the old entrypoint.ts)
      // The SDK-based relay health endpoint should include an "sdk" field
      // WILL FAIL: The old entrypoint.ts health response lacks this field
      const blsHealthBody = (await blsHealth.json()) as Record<string, unknown>;
      if (!blsHealthBody['sdk']) {
        console.warn(
          'Genesis node is not SDK-based. Redeploy with @crosstown/town.'
        );
        return;
      }

      // Health check: Anvil blockchain
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
        console.warn('Anvil not ready. Deploy SDK-based genesis node first.');
        return;
      }

      // Health check: Nostr relay WebSocket
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
      console.warn('SDK-based genesis node not running.');
      console.warn(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, 15000);

  // ---------------------------------------------------------------------------
  // P0: Core relay behaviors that must be identical to entrypoint.ts
  // ---------------------------------------------------------------------------

  it('should bootstrap with payment channel creation against SDK-based relay', async () => {
    // WILL FAIL: No SDK-based relay deployed. The SDK handler registry,
    // SPSP handler, and pricing pipeline do not exist in @crosstown/sdk yet.
    if (!servicesReady) {
      console.log('Skipping: SDK-based genesis node not ready');
      return;
    }

    // 1. Create client keypair
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    // 2. Bootstrap with genesis peer (creates payment channel)
    const startResult = await client.start();
    expect(startResult.mode).toBe('http');
    expect(client.isStarted()).toBe(true);
    expect(startResult.peersDiscovered).toBeGreaterThanOrEqual(1);

    // 3. Verify channel was created during bootstrap
    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);

    // 4. Query on-chain channel state
    const channelId = channels[0]!;
    const channelState = await getChannelState(channelId);
    expect(channelState.state).toBe('open');

    // Verify test account is a participant
    expect(
      channelState.participant1.toLowerCase() ===
        TEST_ACCOUNT_ADDRESS.toLowerCase() ||
        channelState.participant2.toLowerCase() ===
          TEST_ACCOUNT_ADDRESS.toLowerCase()
    ).toBe(true);

    await client.stop();
    expect(client.isStarted()).toBe(false);
  }, 60000);

  it('should publish event with ILP payment and verify on relay', async () => {
    // WILL FAIL: The SDK-based relay's handle-packet endpoint does not exist.
    // The SDK handler registry that routes kind:1 events to the event store
    // handler has not been implemented yet.
    if (!servicesReady) {
      console.log('Skipping: SDK-based genesis node not ready');
      return;
    }

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    // Bootstrap and get channel
    await client.start();
    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;

    // Create and sign a Nostr event
    const testContent = `SDK relay validation test - ${Date.now()}`;
    const event = finalizeEvent(
      {
        kind: 1,
        content: testContent,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    // Sign balance proof and publish
    const claim = await client.signBalanceProof(channelId, 1000n);
    expect(claim.nonce).toBeGreaterThan(0);

    const publishResult = await client.publishEvent(event, { claim });
    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    // Verify event is retrievable from the relay
    const storedEvent = await waitForEventOnRelay(RELAY_URL, event.id, 10000);
    expect(storedEvent).not.toBeNull();
    expect(storedEvent!['id']).toBe(event.id);
    expect(storedEvent!['content']).toBe(testContent);
    expect(storedEvent!['pubkey']).toBe(pubkey);
    expect(storedEvent!['kind']).toBe(1);

    await client.stop();
  }, 60000);

  it('should verify on-chain channel state (open, correct participants)', async () => {
    // WILL FAIL: SDK-based relay must handle SPSP requests (kind:23194) through
    // the SDK handler registry to negotiate and open payment channels. This
    // handler does not exist yet.
    if (!servicesReady) {
      console.log('Skipping: SDK-based genesis node not ready');
      return;
    }

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    await client.start();

    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);

    // Query each tracked channel's on-chain state
    for (const channelId of channels) {
      const channelState = await getChannelState(channelId);

      // Channel must be in 'open' state
      expect(channelState.state).toBe('open');

      // One participant must be the test account
      const participants = [
        channelState.participant1.toLowerCase(),
        channelState.participant2.toLowerCase(),
      ];
      expect(participants).toContain(TEST_ACCOUNT_ADDRESS.toLowerCase());

      // Settlement timeout must be positive
      expect(channelState.settlementTimeout).toBeGreaterThan(0);

      // openedAt must be nonzero (channel was opened on-chain)
      expect(channelState.openedAt).toBeGreaterThan(0);

      // closedAt must be zero (channel is not closed)
      expect(channelState.closedAt).toBe(0);
    }

    await client.stop();
  }, 60000);

  it('should verify signed balance proof generation', async () => {
    // WILL FAIL: The SDK-based relay must correctly process ILP packets containing
    // signed balance proof claims. The SDK pricing pipeline and claim verification
    // do not exist yet.
    if (!servicesReady) {
      console.log('Skipping: SDK-based genesis node not ready');
      return;
    }

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    await client.start();

    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);
    const channelId = channels[0]!;

    // Sign first balance proof
    const claim1 = await client.signBalanceProof(channelId, 500n);
    expect(claim1.nonce).toBe(1);
    expect(claim1.channelId).toBe(channelId);

    // Sign second balance proof (cumulative amount should increase)
    const claim2 = await client.signBalanceProof(channelId, 500n);
    expect(claim2.nonce).toBe(2);
    expect(claim2.channelId).toBe(channelId);

    // Publish an event using the second claim to verify the relay accepts it
    const event = finalizeEvent(
      {
        kind: 1,
        content: `Balance proof test - ${Date.now()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    const publishResult = await client.publishEvent(event, { claim: claim2 });
    expect(publishResult.success).toBe(true);
    expect(publishResult.fulfillment).toBeDefined();

    await client.stop();
  }, 60000);

  // ---------------------------------------------------------------------------
  // P1: SDK-specific behaviors that differ from entrypoint.ts
  // ---------------------------------------------------------------------------

  it('should accept events from node own pubkey without payment (self-write)', async () => {
    // WILL FAIL: The SDK pricing pipeline with self-write bypass (FR-SDK-5) does
    // not exist yet. In the current entrypoint.ts, self-write bypass is implemented
    // manually in the /handle-packet route. The SDK must internalize this logic
    // in its pricing validation layer.
    if (!servicesReady) {
      console.log('Skipping: SDK-based genesis node not ready');
      return;
    }

    // Connect directly to the relay WebSocket as the genesis node's own pubkey
    // to verify that the node can write events without ILP payment
    const ws = new WebSocket(RELAY_URL);
    const subId = `self-write-test-${Date.now()}`;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Query the relay for a kind:10032 event authored by the genesis pubkey.
    // This event was published during bootstrap without ILP payment (self-write bypass).
    const selfWriteEvent = await new Promise<Record<string, unknown> | null>(
      (resolve) => {
        const timer = setTimeout(() => {
          ws.close();
          resolve(null);
        }, 10000);

        ws.send(
          JSON.stringify([
            'REQ',
            subId,
            { kinds: [10032], authors: [GENESIS_PUBKEY], limit: 1 },
          ])
        );

        ws.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (
              Array.isArray(msg) &&
              msg[0] === 'EVENT' &&
              msg[1] === subId &&
              msg[2]
            ) {
              const toonBytes = new TextEncoder().encode(msg[2]);
              const event = decodeEventFromToon(toonBytes);
              clearTimeout(timer);
              ws.close();
              resolve(event as unknown as Record<string, unknown>);
            } else if (msg[0] === 'EOSE' && msg[1] === subId) {
              // Wait a bit after EOSE for late arrivals, then resolve null
            }
          } catch {
            // ignore parse errors
          }
        });
      }
    );

    // The genesis node's own kind:10032 event should be stored (self-write bypass)
    expect(selfWriteEvent).not.toBeNull();
    expect(selfWriteEvent!['pubkey']).toBe(GENESIS_PUBKEY);
    expect(selfWriteEvent!['kind']).toBe(10032);

    // Verify the event contains valid ILP peer info
    const content = selfWriteEvent!['content'] as string;
    expect(content).toBeDefined();
    const peerInfo = JSON.parse(content);
    expect(peerInfo.ilpAddress).toBeDefined();
    expect(peerInfo.btpEndpoint).toBeDefined();
  }, 60000);

  it('should handle SPSP handshake through SDK handler (not manual BLS wiring)', async () => {
    // WILL FAIL: The SDK handler registry for kind:23194 (SPSP request) does not
    // exist. In the current entrypoint.ts, SPSP handling is ~150 lines of manual
    // wiring inside the /handle-packet POST route. The SDK must route kind:23194
    // events to a registered SPSP handler via the handler registry.
    if (!servicesReady) {
      console.log('Skipping: SDK-based genesis node not ready');
      return;
    }

    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const client = createTestClient(secretKey, pubkey);

    // Bootstrap should trigger SPSP handshake (kind:23194 request/response)
    const startResult = await client.start();
    expect(startResult.peersDiscovered).toBeGreaterThanOrEqual(1);

    // Verify the BLS health endpoint reports SDK mode
    const healthResp = await fetch(`${BLS_URL}/health`);
    const health = (await healthResp.json()) as Record<string, unknown>;

    // SDK-based relay should advertise itself
    // WILL FAIL: The old entrypoint.ts does not include 'sdk' in health response
    expect(health['sdk']).toBe(true);

    // Verify channel was opened during SPSP (settlement negotiation works through SDK handler)
    const channels = client.getTrackedChannels();
    expect(channels.length).toBeGreaterThan(0);

    await client.stop();
  }, 60000);

  // ---------------------------------------------------------------------------
  // P2: SDK ergonomics validation
  // ---------------------------------------------------------------------------

  it('SDK relay entrypoint should be < 100 lines of handler code', async () => {
    // WILL FAIL: @crosstown/town package does not exist yet. Once it does,
    // this test reads the entrypoint source and counts non-comment, non-blank
    // lines of handler registration code, asserting < 100 lines vs the ~300
    // lines in docker/src/entrypoint.ts. This is an architectural constraint
    // validation (NFR-SDK-4), not a runtime test.
    //
    // NOTE: This test does not require services to be running. It reads source
    // files directly to verify the code complexity constraint.

    // Import the town package entrypoint source
    // WILL FAIL: @crosstown/town does not exist
    const fs = await import('fs');
    const path = await import('path');

    // Read the SDK-based relay entrypoint
    const townEntrypointPath = path.resolve(
      import.meta.dirname,
      '../../../../town/src/index.ts'
    );

    let source: string;
    try {
      source = fs.readFileSync(townEntrypointPath, 'utf-8');
    } catch {
      // If the file doesn't exist, that's the RED phase signal
      expect.fail(
        '@crosstown/town package does not exist yet. ' +
          'Create packages/town/src/index.ts with startTown() function.'
      );
      return;
    }

    // Count non-blank, non-comment lines that constitute "handler code"
    // Handler code = lines inside .on() handler registrations and startTown() body
    const lines = source.split('\n');
    const handlerLines = lines.filter((line) => {
      const trimmed = line.trim();
      // Skip empty lines
      if (trimmed === '') return false;
      // Skip single-line comments
      if (trimmed.startsWith('//')) return false;
      // Skip import statements
      if (trimmed.startsWith('import ')) return false;
      // Skip export type/interface declarations
      if (
        trimmed.startsWith('export type') ||
        trimmed.startsWith('export interface')
      )
        return false;
      // Skip closing braces only (formatting lines)
      if (trimmed === '}' || trimmed === '};' || trimmed === '},') return false;
      return true;
    });

    // The SDK-based relay entrypoint should be < 100 lines of actual handler code
    // The current docker/src/entrypoint.ts is ~300 lines of handler logic
    expect(handlerLines.length).toBeLessThan(100);

    // For reference, compare against the existing entrypoint
    const oldEntrypointPath = path.resolve(
      import.meta.dirname,
      '../../../../docker/src/entrypoint.ts'
    );
    const oldSource = fs.readFileSync(oldEntrypointPath, 'utf-8');
    const oldLines = oldSource.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '') return false;
      if (trimmed.startsWith('//')) return false;
      if (trimmed.startsWith('import ')) return false;
      return true;
    });

    // The SDK entrypoint should be significantly smaller than the old one
    expect(handlerLines.length).toBeLessThan(oldLines.length * 0.5);
  }, 10000);

  afterAll(async () => {
    // Allow pending WebSocket connections to drain
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
