/**
 * Shared harness for socialverse AI agent scripts.
 *
 * Handles ToonClient bootstrap, funding, and publishing.
 * Each AI agent writes a handler that imports this and calls runAgent().
 */

import {
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { ToonClient } from '../../src/ToonClient.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Infrastructure constants
// ---------------------------------------------------------------------------

const PEER1_BTP_URL = 'ws://localhost:19000';
const PEER1_BLS_URL = 'http://localhost:19100';
const PEER1_RELAY_URL = 'ws://localhost:19700';
const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';
const ANVIL_RPC = 'http://localhost:18545';
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// Pre-generated agent identities (shared across all agents)
export const AGENT_IDENTITIES = {
  alice: {
    secretKeyHex: '086e4b7bee174cd223266fa9b6e4448d76ddbc7ff41591c890df05d6d06b1968',
    pubkey: '55c2a467881059a942fdc6908b041273885b8720bfa8fcf2f5f9c20a73b0964d',
    evmKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    evmAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  },
  bob: {
    secretKeyHex: 'dfb37a72e8b451322a743103fc0638c509d3b583aea83dd20d5078ce698bdb98',
    pubkey: '7937ffc0c5a0238768da798d26394a33b554926d739c445fd508e36642ebc286',
    evmKey: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    evmAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  },
  carol: {
    secretKeyHex: '6e1d84d1c6437e2002629bb22e5fe21a39a5ad4139ead1d00900e1f89b981964',
    pubkey: '7634b7c7d979145c526202407176832b05b71e06fd5b05f977c0a371dc9913b8',
    evmKey: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    evmAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  },
  dave: {
    secretKeyHex: 'd5383c80d6e1d86c32225ef860d7cfb417e2031e3ff812cd832165b2021e11f1',
    pubkey: 'ed2134accd2ea9a50b7be928f870c2c142921b5fcfa63982ef2eee79df9d28fa',
    evmKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    evmAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  },
} as const;

export type AgentName = keyof typeof AGENT_IDENTITIES;

export const RELAY_URL = PEER1_RELAY_URL;

// ---------------------------------------------------------------------------
// Agent context passed to handler
// ---------------------------------------------------------------------------

/** Nostr filter for relay queries */
export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  '#a'?: string[];
  '#e'?: string[];
  '#p'?: string[];
  '#d'?: string[];
  '#t'?: string[];
  ids?: string[];
  limit?: number;
  since?: number;
}

export interface AgentContext {
  name: AgentName;
  secretKey: Uint8Array;
  pubkey: string;
  client: ToonClient;
  channelId: string;
  /** Publish a signed event to peer1 via ILP */
  publish: (event: NostrEvent) => Promise<{ success: boolean; data?: string; error?: string }>;
  /** Create and sign a Nostr event */
  sign: (template: Omit<UnsignedEvent, 'pubkey'>) => NostrEvent;
  /** Build and publish a kind:5094 DVM blob storage request */
  publishBlob: (blob: Buffer, contentType: string) => Promise<{ success: boolean; txId?: string; error?: string }>;
  /** Query the relay for events matching a filter (free read, no ILP payment) */
  queryRelay: (filter: NostrFilter, timeoutMs?: number) => Promise<NostrEvent[]>;
  /** All other agents' pubkeys for cross-referencing */
  peers: Record<string, string>;
  /** Relay URL for tags */
  relayUrl: string;
}

export type AgentHandler = (ctx: AgentContext) => Promise<void>;

// ---------------------------------------------------------------------------
// queryRelay — free read from TOON relay via WebSocket
// ---------------------------------------------------------------------------

function queryRelayEvents(
  relayUrl: string,
  filter: NostrFilter,
  timeoutMs = 10000
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const subId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const events: NostrEvent[] = [];
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
    };

    timer = setTimeout(() => { cleanup(); resolve(events); }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          // TOON relay returns events in TOON format — decode
          const toonBytes = new TextEncoder().encode(msg[2]);
          const event = decodeEventFromToon(toonBytes);
          events.push(event);
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          cleanup();
          resolve(events);
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => { cleanup(); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// runAgent — bootstrap + execute handler + cleanup
// ---------------------------------------------------------------------------

export async function runAgent(
  name: AgentName,
  handler: AgentHandler
): Promise<void> {
  const identity = AGENT_IDENTITIES[name];
  const secretKey = Uint8Array.from(Buffer.from(identity.secretKeyHex, 'hex'));
  const pubkey = getPublicKey(secretKey);

  console.log(`[${name}] Starting...`);

  const client = new ToonClient({
    connectorUrl: PEER1_BLS_URL,
    secretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.toon.agent.${pubkey.slice(0, 8)}`,
      btpEndpoint: PEER1_BTP_URL,
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: PEER1_RELAY_URL,
    knownPeers: [{ pubkey: PEER1_PUBKEY, relayUrl: PEER1_RELAY_URL, btpEndpoint: PEER1_BTP_URL }],
    evmPrivateKey: identity.evmKey,
    chainRpcUrls: { 'evm:base:31337': ANVIL_RPC },
    supportedChains: ['evm:base:31337'],
    settlementAddresses: { 'evm:base:31337': identity.evmAddress },
    preferredTokens: { 'evm:base:31337': TOKEN_ADDRESS },
    tokenNetworks: { 'evm:base:31337': TOKEN_NETWORK_ADDRESS },
    btpUrl: PEER1_BTP_URL,
    btpPeerId: name,
    btpAuthToken: '',
    destinationAddress: 'g.toon.peer1',
  });

  await client.start();
  const channels = client.getTrackedChannels();
  if (channels.length === 0) {
    console.error(`[${name}] No payment channels opened!`);
    await client.stop();
    return;
  }
  const channelId = channels[0]!;
  console.log(`[${name}] Bootstrapped. Channel: ${channelId.slice(0, 16)}...`);

  // Build peer map (everyone except self)
  const peers: Record<string, string> = {};
  for (const [n, id] of Object.entries(AGENT_IDENTITIES)) {
    if (n !== name) peers[n] = id.pubkey;
  }

  const ctx: AgentContext = {
    name,
    secretKey,
    pubkey,
    client,
    channelId,
    relayUrl: PEER1_RELAY_URL,
    peers,
    queryRelay: (filter, timeoutMs) => queryRelayEvents(PEER1_RELAY_URL, filter, timeoutMs),
    sign: (template) => finalizeEvent(template, secretKey),
    publish: async (event) => {
      const toonBytes = encodeEventToToon(event);
      const amount = BigInt(toonBytes.length) * 10n;
      const claim = await client.signBalanceProof(channelId, amount);
      const result = await client.publishEvent(event, { destination: 'g.toon.peer1', claim });
      if (result.success) {
        console.log(`[${name}] Published kind:${event.kind} (${event.id.slice(0, 12)}...) [${toonBytes.length}B]`);
      } else {
        console.log(`[${name}] FAILED kind:${event.kind}: ${result.error}`);
      }
      return { success: result.success, data: result.data, error: result.error };
    },
    publishBlob: async (blob, contentType) => {
      const amount = BigInt(blob.length) * 10n;
      const event = buildBlobStorageRequest(
        { blobData: blob, contentType, bid: amount.toString() },
        secretKey
      );
      const claim = await client.signBalanceProof(channelId, amount);
      const result = await client.publishEvent(event, { destination: 'g.toon.peer1', claim });
      const txId = result.data ? Buffer.from(result.data, 'base64').toString('utf-8') : undefined;
      if (result.success) {
        console.log(`[${name}] DVM upload: ${txId ?? 'no txId'}`);
      } else {
        console.log(`[${name}] DVM FAILED: ${result.error}`);
      }
      return { success: result.success, txId, error: result.error };
    },
  };

  try {
    await handler(ctx);
  } catch (err) {
    console.error(`[${name}] Handler error:`, err);
  } finally {
    await client.stop();
    console.log(`[${name}] Done.`);
  }
}
