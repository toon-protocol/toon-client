/**
 * E2E tests for Arweave DVM via ToonClient (client package)
 *
 * These tests verify the same Arweave DVM flow as
 * packages/sdk/tests/e2e/docker-arweave-dvm-e2e.test.ts, but exercise
 * the **client path**: ToonClient with claim-based auth, manual event
 * construction via buildBlobStorageRequest(), and BTP transport.
 *
 * Prerequisites:
 *   ./scripts/sdk-e2e-infra.sh up
 *
 * AC covered:
 * - AC #5: Single-packet upload (prepaid) via ToonClient
 * - AC #7: Arweave retrieval verification
 * - AC #8: Chunk splitting via ToonClient
 * - AC #9: Chunk accumulation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { ToonClient } from '../../src/ToonClient.js';

// ---------------------------------------------------------------------------
// SDK E2E Infrastructure (docker-compose-sdk-e2e.yml)
// ---------------------------------------------------------------------------

const ANVIL_RPC = 'http://localhost:18545';

const PEER1_BTP_URL = 'ws://localhost:19000';
const PEER1_BLS_URL = 'http://localhost:19100';
const PEER1_RELAY_URL = 'ws://localhost:19700';
const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';

// Test account (Anvil Account #3 — unused by Docker infra)
const TEST_PRIVATE_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const TEST_EVM_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

// Deployed contract addresses (deterministic on Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkInfraReady(): Promise<boolean> {
  try {
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

    if (!anvilOk) return false;

    const peer1Health = await fetch(`${PEER1_BLS_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return peer1Health.ok;
  } catch {
    return false;
  }
}

function createTestClient(
  secretKey: Uint8Array,
  pubkey: string
): ToonClient {
  return new ToonClient({
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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Arweave DVM E2E via ToonClient', () => {
  let servicesReady = false;
  let client: ToonClient;
  let secretKey: Uint8Array;
  let channelId: string;

  beforeAll(async () => {
    const ready = await checkInfraReady();
    if (!ready) {
      console.warn('SDK E2E infra not running. Run: ./scripts/sdk-e2e-infra.sh up');
      return;
    }

    secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    client = createTestClient(secretKey, pubkey);

    await client.start();

    const channels = client.getTrackedChannels();
    if (channels.length === 0) {
      console.warn('No payment channels opened during bootstrap');
      return;
    }
    channelId = channels[0]!;

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (client) await client.stop();
    await new Promise((r) => setTimeout(r, 500));
  });

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

  // ==========================================================================
  // Single-Packet Upload via ToonClient (AC #5, #7)
  // ==========================================================================

  it('client sends kind:5094 via ToonClient with claim -> provider uploads to Arweave -> client receives tx ID', async () => {
    if (skipIfNotReady()) return;

    const testPayload = `Hello from ToonClient Arweave DVM E2E! Timestamp: ${Date.now()}`;
    const blob = Buffer.from(testPayload, 'utf-8');
    const pricePerByte = 10n;
    const amount = BigInt(blob.length) * pricePerByte;

    // Build kind:5094 event manually (this is the client path)
    const event = buildBlobStorageRequest(
      {
        blobData: blob,
        contentType: 'text/plain',
        bid: amount.toString(),
      },
      secretKey
    );

    // Sign balance proof for this packet
    const claim = await client.signBalanceProof(channelId, amount);

    // Publish via ToonClient with claim
    const result = await client.publishEvent(event, {
      destination: 'g.toon.peer1',
      claim,
    });

    expect(result.success).toBe(true);
    expect(result.eventId).toBe(event.id);

    // The FULFILL data contains the Arweave tx ID
    expect(result.data).toBeTruthy();
    // Decode base64 FULFILL data to get the tx ID
    const txId = result.data ? Buffer.from(result.data, 'base64').toString('utf-8') : '';
    expect(txId).toBeTruthy();
    // Arweave tx IDs are 43 chars (base64url-encoded 32 bytes)
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 30000);

  // ==========================================================================
  // Chunked Upload via ToonClient (AC #8, #9)
  // ==========================================================================

  it('client sends chunked kind:5094 via ToonClient with claims -> provider assembles and uploads -> client receives tx ID', async () => {
    if (skipIfNotReady()) return;

    const chunkSize = 1024;
    const totalSize = chunkSize * 3 + 512; // 3.5 chunks -> 4 chunks
    const blob = Buffer.alloc(totalSize);
    for (let i = 0; i < totalSize; i++) {
      blob[i] = i % 256;
    }

    const pricePerByte = 10n;
    const uploadId = randomUUID();
    const totalChunks = Math.ceil(blob.length / chunkSize);
    let lastResult: Awaited<ReturnType<ToonClient['publishEvent']>> | undefined;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, blob.length);
      const chunkData = blob.subarray(start, end);
      const amount = BigInt(chunkData.length) * pricePerByte;

      const event = buildBlobStorageRequest(
        {
          blobData: Buffer.from(chunkData),
          contentType: 'application/octet-stream',
          bid: amount.toString(),
          params: [
            { key: 'uploadId', value: uploadId },
            { key: 'chunkIndex', value: String(i) },
            { key: 'totalChunks', value: String(totalChunks) },
          ],
        },
        secretKey
      );

      const claim = await client.signBalanceProof(channelId, amount);
      lastResult = await client.publishEvent(event, {
        destination: 'g.toon.peer1',
        claim,
      });

      expect(lastResult.success).toBe(true);
    }

    // The final chunk's FULFILL data contains the Arweave tx ID
    expect(lastResult).toBeDefined();
    expect(lastResult!.data).toBeTruthy();
    const txId = lastResult!.data
      ? Buffer.from(lastResult!.data, 'base64').toString('utf-8')
      : '';
    expect(txId).toBeTruthy();
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 60000);
});
