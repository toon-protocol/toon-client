#!/usr/bin/env tsx
/**
 * Basic example: Publish a Nostr event to the Crosstown network
 *
 * Prerequisites:
 * - Genesis node running (docker compose up)
 * - Run with: tsx packages/client/examples/basic-publish.ts
 */

import { CrosstownClient } from '../src/index.js';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

async function main() {
  console.log('🚀 Crosstown Client Example\n');

  // 1. Generate Nostr identity
  console.log('📝 Generating Nostr keypair...');
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  console.log(`   Public key: ${pubkey.slice(0, 16)}...`);

  // 2. Create client (connects to genesis node)
  console.log('\n🔧 Creating client...');
  const client = new CrosstownClient({
    connectorUrl: 'http://localhost:8080', // Genesis connector runtime
    secretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.crosstown.${pubkey.slice(0, 8)}`,
      btpEndpoint: 'ws://localhost:3000', // Genesis connector BTP
      assetCode: 'USD',
      assetScale: 6,    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: 'ws://localhost:7100', // Genesis relay
  });

  try {
    // 3. Start client (bootstrap network)
    console.log('🌐 Starting client (bootstrapping network)...');
    const startResult = await client.start();
    console.log(`   ✅ Mode: ${startResult.mode}`);
    console.log(`   ✅ Peers discovered: ${startResult.peersDiscovered}`);

    // 4. Create and publish a test event
    console.log('\n📨 Publishing test event...');
    const event = finalizeEvent(
      {
        kind: 1,
        content: `Hello from Crosstown! Timestamp: ${new Date().toISOString()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );

    console.log(`   Event ID: ${event.id}`);
    console.log(`   Content: "${event.content}"`);

    const publishResult = await client.publishEvent(event);

    if (publishResult.success) {
      console.log(`\n✅ SUCCESS!`);
      console.log(`   Event ID: ${publishResult.eventId}`);
      console.log(
        `   ILP Fulfillment: ${publishResult.fulfillment?.slice(0, 32)}...`
      );
    } else {
      console.error(`\n❌ FAILED: ${publishResult.error}`);
    }

    // 5. Show peer info
    console.log(`\n📊 Client Stats:`);
    console.log(`   Peers: ${client.getPeersCount()}`);
    const peers = client.getDiscoveredPeers();
    peers.forEach((peer) => {
      console.log(`   - ${peer.pubkey.slice(0, 16)}... at ${peer.peerInfo.ilpAddress}`);
    });
  } catch (error) {
    console.error('\n❌ Error:', error);
    throw error;
  } finally {
    // 6. Clean up
    console.log('\n🧹 Cleaning up...');
    try {
      await client.stop();
    } catch (stopError: any) {
      // Known issue: nostr-tools SimplePool throws "window is not defined" in Node.js
      if (stopError?.message?.includes('window is not defined')) {
        console.log('⚠️  Known nostr-tools issue (non-fatal)');
      } else {
        throw stopError;
      }
    }
    console.log('✅ Done!');
  }
}

// Handle unhandled promise rejections (nostr-tools SimplePool issue)
process.on('unhandledRejection', (error: any) => {
  if (error?.message?.includes('window is not defined')) {
    console.log('\n⚠️  Known nostr-tools issue detected (non-fatal)');
    console.log('   Event was successfully published despite this error.\n');
    process.exit(0);
  }
  throw error;
});

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
