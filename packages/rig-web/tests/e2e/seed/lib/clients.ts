/**
 * ToonClient factory for E2E seed scripts.
 *
 * Creates three ToonClient instances (Alice, Bob, Carol) using Anvil accounts #3/#4/#5,
 * each with distinct Nostr keypairs from AGENT_IDENTITIES. Bootstraps sequentially
 * to avoid nonce races.
 *
 * AC-1.1: ToonClient Factory
 * AC-1.7: Client Package Only — uses ToonClient, NOT SDK createNode
 */

import { ToonClient } from '@toon-protocol/client';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import {
  PEER1_BTP_URL,
  PEER1_BLS_URL,
  PEER1_RELAY_URL,
  PEER1_PUBKEY,
  ANVIL_RPC,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  AGENT_IDENTITIES,
  PEER1_DESTINATION,
} from './constants.js';

// ---------------------------------------------------------------------------
// Module-level client tracking for cleanup
// ---------------------------------------------------------------------------

let activeClients: ToonClient[] = [];

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Poll Peer1 BLS health endpoint until it responds 200 or timeout.
 * Must pass before creating clients.
 */
export async function healthCheck(timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${PEER1_BLS_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface SeedClients {
  alice: ToonClient;
  bob: ToonClient;
  carol: ToonClient;
}

/**
 * Create a single ToonClient for the given agent identity.
 */
function buildClient(name: 'alice' | 'bob' | 'carol'): ToonClient {
  const identity = AGENT_IDENTITIES[name];
  const secretKey = Uint8Array.from(Buffer.from(identity.secretKeyHex, 'hex'));

  return new ToonClient({
    connectorUrl: PEER1_BLS_URL,
    btpUrl: PEER1_BTP_URL,
    secretKey,
    evmPrivateKey: identity.evmKey,
    ilpInfo: {
      pubkey: identity.pubkey,
      ilpAddress: `g.toon.agent.${identity.pubkey.slice(0, 8)}`,
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
    supportedChains: ['evm:base:31337'],
    tokenNetworks: { 'evm:base:31337': TOKEN_NETWORK_ADDRESS },
    preferredTokens: { 'evm:base:31337': TOKEN_ADDRESS },
    chainRpcUrls: { 'evm:base:31337': ANVIL_RPC },
    settlementAddresses: { 'evm:base:31337': identity.evmAddress },
    initialDeposit: '1000000', // 1 USDC (6 decimals)
    destinationAddress: PEER1_DESTINATION,
    btpPeerId: name,
    btpAuthToken: '',
  });
}

/**
 * Create and bootstrap three ToonClient instances (Alice, Bob, Carol).
 *
 * Bootstraps sequentially (R10-002) to avoid EVM nonce races on Anvil.
 * Calls healthCheck() first to verify Peer1 BLS is reachable.
 */
export async function createSeedClients(): Promise<SeedClients> {
  // Stop any previously leaked clients before creating new ones
  if (activeClients.length > 0) {
    await stopAllClients();
  }

  const healthy = await healthCheck();
  if (!healthy) {
    throw new Error(
      'Peer1 BLS not healthy. Run: ./scripts/sdk-e2e-infra.sh up'
    );
  }

  // Bootstrap sequentially to avoid nonce races (R10-002)
  const alice = buildClient('alice');
  await alice.start();

  const bob = buildClient('bob');
  await bob.start();

  const carol = buildClient('carol');
  await carol.start();

  activeClients = [alice, bob, carol];
  return { alice, bob, carol };
}

/**
 * Stop all active seed clients and release resources.
 */
export async function stopAllClients(): Promise<void> {
  for (const client of activeClients) {
    try {
      await client.stop();
    } catch {
      // best-effort cleanup
    }
  }
  activeClients = [];
}
