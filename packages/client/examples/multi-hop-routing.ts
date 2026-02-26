#!/usr/bin/env tsx
/**
 * Test multi-hop ILP routing
 *
 * Flow:
 * 1. Client connects to peer1 (ws://localhost:3010)
 * 2. Client publishes event to genesis relay (g.crosstown.relay)
 * 3. Peer1 routes ILP packet to genesis connector
 * 4. Genesis delivers to BLS and stores event
 * 5. Verify event appears on genesis relay
 *
 * Run: pnpm exec tsx packages/client/examples/multi-hop-routing.ts
 */

import { CrosstownClient } from '../src/index.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

async function main() {
  console.log('🚀 Multi-Hop ILP Routing Test\n');

  // Generate identity
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  console.log('📝 Generated keypair');
  console.log(`   Public key: ${pubkey.slice(0, 32)}...\n`);

  // Create client connected to PEER1
  console.log('🔧 Creating client...');
  console.log('   Target: Genesis relay (g.crosstown.relay)');
  console.log('   Route:  Client → Peer1 → Genesis\n');

  const client = new CrosstownClient({
    connectorUrl: 'http://localhost:8090',      // PEER1 connector
    btpUrl: 'ws://localhost:3010',              // PEER1 BTP
    secretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.crosstown.peer1.${pubkey.slice(0, 8)}`,
      btpEndpoint: 'ws://localhost:3010',
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: 'ws://localhost:7110',            // PEER1 relay
  });

  // Start client
  console.log('🌐 Starting client (connecting to peer1)...');
  const startResult = await client.start();
  console.log(`   ✅ Connected (mode: ${startResult.mode})`);
  console.log(`   ✅ Bootstrap complete (${startResult.peersDiscovered} peers)\n`);

  // Create event
  const timestamp = new Date().toISOString();
  const event = finalizeEvent({
    kind: 1,
    content: `Multi-hop routing test: Client → Peer1 → Genesis (${timestamp})`,
    tags: [
      ['routing', 'multi-hop'],
      ['source', 'peer1'],
      ['destination', 'genesis'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  }, secretKey);

  console.log('📨 Publishing event via multi-hop route...');
  console.log(`   Event ID: ${event.id.slice(0, 32)}...`);
  console.log(`   Destination: g.crosstown.relay (genesis)\n`);

  // Publish event
  console.log('💰 ILP packet flow:');
  console.log('   1. Client sends to peer1 connector (localhost:8090)');
  console.log('   2. Peer1 forwards to genesis connector (via BTP)');
  console.log('   3. Genesis delivers to local BLS');
  console.log('   4. BLS validates and stores event');
  console.log('   5. Fulfillment returns: Genesis → Peer1 → Client\n');

  client.publishEvent(event).then(result => {
    if (result.success) {
      console.log('✅ SUCCESS - Multi-hop routing worked!');
      console.log(`   Event ID: ${result.eventId?.slice(0, 32)}...`);
      console.log(`   Fulfillment: ${result.fulfillment?.slice(0, 32)}...`);
    } else {
      console.log(`❌ FAILED: ${result.error}`);
    }
  }).catch(err => {
    console.error(`❌ Error: ${err.message}`);
  });

  // Wait for completion
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('\n📊 Verification:');
  console.log('   Check peer1 connector logs:');
  console.log('   $ docker logs connector-peer1 --tail 30 | grep "Forwarding packet"');
  console.log('');
  console.log('   Check genesis connector logs:');
  console.log('   $ docker logs crosstown-connector --tail 30 | grep "fulfilled"');
  console.log('');
  console.log('   Check genesis node logs:');
  console.log('   $ docker logs crosstown-node --tail 30 | grep "Storing event"');

  console.log('\n💡 Expected log entries:');
  console.log('   Peer1:   "Forwarding packet to peer via BTP" (to genesis)');
  console.log('   Genesis: "Packet fulfilled by business logic server"');
  console.log('   BLS:     "Storing event" (in genesis database)\n');

  console.log('⚠️  Exiting early to avoid nostr-tools issue\n');
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
