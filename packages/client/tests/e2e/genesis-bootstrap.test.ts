/**
 * E2E Test: CrosstownClient Bootstrap with Genesis Peer
 *
 * **Prerequisites:**
 * 1. Genesis node deployed:
 *    ```bash
 *    ./deploy-genesis-node.sh
 *    ```
 *
 * **What this test verifies:**
 * - CrosstownClient bootstraps with the genesis peer
 * - publishEvent() sends a paid ILP packet with a Nostr event
 * - The event is stored on the genesis node's Nostr relay
 * - Subscribing to ws://localhost:7100 retrieves the stored event
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';
import { CrosstownClient } from '../../src/CrosstownClient.js';
import WebSocket from 'ws';

const RELAY_URL = 'ws://localhost:7100';
const CONNECTOR_URL = 'http://localhost:8080';
const BLS_URL = 'http://localhost:3100';
const GENESIS_PUBKEY = 'aa1857d0ff1fcb1aeb1907b3b98290f3ecb5545473c0b9296fb0b44481deb572';

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
      resolve(null); // timed out, event not found
    }, timeoutMs);

    ws.on('open', () => {
      // NIP-01: Send REQ with filter for specific event ID
      ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
            // Relay returns events in TOON format — decode the TOON string
            const toonBytes = new TextEncoder().encode(msg[2]);
            const event = decodeEventFromToon(toonBytes);
            cleanup();
            resolve(event as unknown as Record<string, unknown>);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            // End of stored events — event not found yet
            // Keep connection open briefly in case it arrives
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

describe('CrosstownClient Genesis Bootstrap E2E', () => {
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

      // Check Nostr relay via WebSocket
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

  it('should bootstrap, publish a paid event, and verify it on the relay', async () => {
    if (!servicesReady) {
      console.log('Skipping: Genesis node not ready');
      return;
    }

    // 1. Create client keypair
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);

    // 2. Create CrosstownClient
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
    });

    // 3. Bootstrap with genesis peer
    const startResult = await client.start();
    expect(startResult.mode).toBe('http');
    expect(client.isStarted()).toBe(true);

    // 4. Create and sign a Nostr event
    const testContent = `Genesis bootstrap E2E test - ${Date.now()}`;
    const event = finalizeEvent(
      {
        kind: 1,
        content: testContent,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    console.log(`Publishing event ${event.id} with content: "${testContent}"`);

    // 5. Publish event via ILP (paid packet)
    const publishResult = await client.publishEvent(event);

    console.log(`Publish result:`, JSON.stringify(publishResult));

    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    // 6. Subscribe to relay and verify event is stored
    console.log(`Subscribing to ${RELAY_URL} to verify event ${event.id}...`);

    const storedEvent = await waitForEventOnRelay(RELAY_URL, event.id, 10000);

    expect(storedEvent).not.toBeNull();
    expect(storedEvent!.id).toBe(event.id);
    expect(storedEvent!.content).toBe(testContent);
    expect(storedEvent!.pubkey).toBe(pubkey);
    expect(storedEvent!.kind).toBe(1);

    console.log('Event verified on relay!');

    // 7. Cleanup
    await client.stop();
    expect(client.isStarted()).toBe(false);
  }, 30000);

  afterAll(async () => {
    // Allow WebSocket connections to close
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});
