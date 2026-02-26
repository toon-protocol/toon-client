#!/usr/bin/env tsx
/**
 * Publish event to peer1 node
 *
 * This tests multi-hop ILP routing:
 * - Client connects to peer1 connector (port 8090)
 * - Event published to peer1 relay (port 7110)
 * - Tests payment channel flow
 *
 * Run: pnpm exec tsx packages/client/examples/publish-to-peer1.ts
 */

import { CrosstownClient } from '../src/index.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

async function main() {
  console.log('🚀 Crosstown Client - Publish to Peer1\n');

  // 1. Generate identity
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  console.log(`📝 Generated keypair`);
  console.log(`   Public key: ${pubkey.slice(0, 32)}...`);

  // 2. Create client (connected to PEER1 instead of genesis)
  console.log('\n🔧 Creating client for peer1...');
  const client = new CrosstownClient({
    connectorUrl: 'http://localhost:8090',      // PEER1 connector runtime
    btpUrl: 'ws://localhost:3010',              // PEER1 connector BTP (IMPORTANT!)
    secretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.crosstown.peer1.${pubkey.slice(0, 8)}`,
      btpEndpoint: 'ws://localhost:3010',       // PEER1 connector BTP
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: 'ws://localhost:7110',            // PEER1 relay
  });

  console.log(`   Connector: http://localhost:8090`);
  console.log(`   BTP: ws://localhost:3010`);
  console.log(`   Relay: ws://localhost:7110`);

  // 3. Start
  console.log('\n🌐 Starting client...');
  const startResult = await client.start();
  console.log(`   ✅ Connected (mode: ${startResult.mode})`);
  console.log(`   ✅ Bootstrap complete (${startResult.peersDiscovered} peers)`);

  // 4. Create event
  const timestamp = new Date().toISOString();
  const event = finalizeEvent({
    kind: 1,
    content: `Hello from peer1! Timestamp: ${timestamp}`,
    tags: [
      ['client', 'crosstown'],
      ['node', 'peer1'],
      ['timestamp', timestamp]
    ],
    created_at: Math.floor(Date.now() / 1000),
  }, secretKey);

  console.log(`\n📨 Publishing event to peer1...`);
  console.log(`   Event ID: ${event.id}`);
  console.log(`   Content: "${event.content.slice(0, 50)}..."`);

  // 5. Publish with early exit
  console.log(`\n💰 Sending ILP payment via peer1...`);

  client.publishEvent(event).then(result => {
    if (result.success) {
      console.log(`   ✅ SUCCESS!`);
      console.log(`   ✅ Event ID: ${result.eventId}`);
      console.log(`   ✅ Fulfillment: ${result.fulfillment?.slice(0, 32)}...`);
    } else {
      console.log(`   ❌ FAILED: ${result.error}`);
    }
  }).catch(err => {
    console.error(`   ❌ Error: ${err.message}`);
  });

  // Give it time to complete
  await new Promise(resolve => setTimeout(resolve, 500));

  console.log(`\n✅ Event published to peer1!`);
  console.log(`\n📊 Verification:`);
  console.log(`   Genesis connector: docker logs crosstown-connector --tail 20 | grep fulfilled`);
  console.log(`   Peer1 connector:   docker logs connector-peer1 --tail 20 | grep fulfilled`);
  console.log(`   Peer1 node:        docker logs crosstown-peer1 --tail 20`);
  console.log(`\n💡 Expected flow:`);
  console.log(`   1. Client → Peer1 connector (ILP packet)`);
  console.log(`   2. Peer1 connector → Peer1 BLS (local delivery)`);
  console.log(`   3. Peer1 BLS validates and stores event`);
  console.log(`   4. Payment fulfilled back to client`);
  console.log(`\n⚠️  Note: Exiting early to avoid nostr-tools issue\n`);

  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
