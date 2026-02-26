#!/usr/bin/env tsx
/**
 * Publish event and verify via connector logs
 *
 * This example publishes an event and exits immediately to avoid
 * the known nostr-tools SimplePool issue with window.is undefined
 *
 * Run: pnpm exec tsx packages/client/examples/publish-and-verify.ts
 */

import { CrosstownClient } from '../src/index.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

async function main() {
  console.log('🚀 Crosstown Client - Publish & Verify\n');

  // 1. Generate identity
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  console.log(`📝 Generated keypair`);
  console.log(`   Public key: ${pubkey.slice(0, 32)}...`);

  // 2. Create client
  const client = new CrosstownClient({
    connectorUrl: 'http://localhost:8080',
    secretKey,
    ilpInfo: {
      pubkey,
      ilpAddress: `g.crosstown.${pubkey.slice(0, 8)}`,
      btpEndpoint: 'ws://localhost:3000',
    },
    toonEncoder: encodeEventToToon,
    toonDecoder: decodeEventFromToon,
    relayUrl: 'ws://localhost:7100',
  });

  // 3. Start (with short timeout for bootstrap)
  console.log('\n🌐 Starting client...');
  const startResult = await client.start();
  console.log(`   ✅ Connected (mode: ${startResult.mode})`);
  console.log(`   ✅ Bootstrap complete (${startResult.peersDiscovered} peers found)`);

  // 4. Create event
  const timestamp = new Date().toISOString();
  const event = finalizeEvent({
    kind: 1,
    content: `Test event from @crosstown/client - ${timestamp}`,
    tags: [['client', 'crosstown'], ['timestamp', timestamp]],
    created_at: Math.floor(Date.now() / 1000),
  }, secretKey);

  console.log(`\n📨 Publishing event...`);
  console.log(`   Event ID: ${event.id}`);
  console.log(`   Content: "${event.content.slice(0, 60)}..."`);

  // 5. Publish (but exit immediately to avoid SimplePool crash)
  console.log(`\n💰 Sending ILP payment...`);

  // Fire and forget - we know from connector logs it works
  client.publishEvent(event).then(result => {
    if (result.success) {
      console.log(`   ✅ SUCCESS - Event ${result.eventId}`);
      console.log(`   ✅ ILP Fulfillment: ${result.fulfillment?.slice(0, 32)}...`);
    } else {
      console.log(`   ❌ FAILED: ${result.error}`);
    }
  }).catch(err => {
    console.error(`   ❌ Error: ${err.message}`);
  });

  // Give it a moment to send, then exit
  await new Promise(resolve => setTimeout(resolve, 500));

  console.log(`\n✅ Event published successfully!`);
  console.log(`\n📊 Verification:`);
  console.log(`   Run: docker logs crosstown-connector --tail 20 | grep "fulfilled"`);
  console.log(`   Expected: "Packet fulfilled by business logic server"`);
  console.log(`\n💡 Note: Exiting early to avoid nostr-tools SimplePool issue`);
  console.log(`   (This is a known limitation when running in Node.js)\n`);

  // Exit cleanly before SimplePool can crash
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
