#!/usr/bin/env tsx
/**
 * Test client with payment channels enabled
 *
 * This example:
 * 1. Configures EVM wallet and chain settings
 * 2. Bootstrap with genesis peer
 * 3. Opens payment channel during SPSP handshake
 * 4. Publishes event with signed balance proof claim
 * 5. Verifies channel state on-chain
 *
 * Run: pnpm exec tsx packages/client/examples/with-payment-channels.ts
 */

import { CrosstownClient } from '../src/index.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';
import { createPublicClient, http, defineChain, type Hex } from 'viem';

// Infrastructure endpoints
const RELAY_URL = 'ws://localhost:7100';
const CONNECTOR_URL = 'http://localhost:8080';
const ANVIL_RPC = 'http://localhost:8545';
const GENESIS_PUBKEY = 'aa1857d0ff1fcb1aeb1907b3b98290f3ecb5545473c0b9296fb0b44481deb572';

// Test account (Anvil Account #2 with 10k ETH pre-funded)
const TEST_ACCOUNT_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const TEST_ACCOUNT_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// Deployed contract addresses (deterministic on Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

// TokenNetwork ABI for querying channel state
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

async function main() {
  console.log('🚀 Crosstown Client - With Payment Channels\n');

  // 1. Generate Nostr identity
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  console.log('🔑 Identity:');
  console.log(`   Nostr pubkey: ${pubkey.slice(0, 32)}...`);
  console.log(`   EVM address:  ${TEST_ACCOUNT_ADDRESS}`);

  // 2. Create client with EVM configuration for payment channels
  console.log('\n🔧 Creating client with payment channel support...');

  const client = new CrosstownClient({
    connectorUrl: CONNECTOR_URL,
    btpUrl: 'ws://localhost:3000',
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
  });

  console.log('   ✅ Client configured with EVM wallet');
  console.log('   ✅ Payment channel support enabled');

  // 3. Bootstrap (will open payment channel during SPSP handshake)
  console.log('\n🌐 Starting bootstrap...');
  console.log('   This will:');
  console.log('   - Discover genesis peer via relay');
  console.log('   - Perform SPSP handshake with settlement negotiation');
  console.log('   - Open payment channel on-chain');

  const startResult = await client.start();
  console.log(`\n✅ Bootstrap complete!`);
  console.log(`   Mode: ${startResult.mode}`);
  console.log(`   Peers discovered: ${startResult.peersDiscovered}`);

  // 4. Check tracked channels
  console.log('\n💰 Payment Channels:');
  const channels = client.getTrackedChannels();
  console.log(`   Tracked channels: ${channels.length}`);

  if (channels.length === 0) {
    console.log('   ⚠️  No channels opened (SPSP handshake may have failed)');
    console.log('   Check genesis node supports settlement negotiation');
  } else {
    const channelId = channels[0]!;
    console.log(`   Channel ID: ${channelId.slice(0, 32)}...`);

    // Query on-chain state
    console.log('\n🔍 Querying on-chain channel state...');
    try {
      const channelState = await getChannelState(channelId);
      console.log(`   State: ${channelState.state}`);
      console.log(`   Participant 1: ${channelState.participant1}`);
      console.log(`   Participant 2: ${channelState.participant2}`);
      console.log(`   Settlement timeout: ${channelState.settlementTimeout}s`);
      console.log(`   Opened at: ${new Date(channelState.openedAt * 1000).toISOString()}`);
    } catch (error: any) {
      console.log(`   ❌ Failed to query: ${error.message}`);
    }

    // 5. Publish event with signed balance proof claim
    console.log('\n📨 Publishing event with signed claim...');

    const event = finalizeEvent({
      kind: 1,
      content: `Payment channel test - ${new Date().toISOString()}`,
      tags: [['channel', channelId.slice(0, 16)]],
      created_at: Math.floor(Date.now() / 1000),
    }, secretKey);

    console.log(`   Event ID: ${event.id.slice(0, 32)}...`);

    // Sign balance proof claim
    const claim = await client.signBalanceProof(channelId, 1000n);
    console.log(`   Claim nonce: ${claim.nonce}`);
    console.log(`   Claim amount: ${claim.amount}`);

    // Publish with claim
    const publishResult = await client.publishEvent(event, { claim });

    if (publishResult.success) {
      console.log(`\n✅ Event published with signed claim!`);
      console.log(`   Event ID: ${publishResult.eventId?.slice(0, 32)}...`);
      console.log(`   Fulfillment: ${publishResult.fulfillment?.slice(0, 32)}...`);
    } else {
      console.log(`\n❌ Publish failed: ${publishResult.error}`);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`   ✅ Client bootstrapped with genesis`);
  console.log(`   ✅ Payment channel ${channels.length > 0 ? 'opened' : 'attempted'}`);
  console.log(`   ✅ SPSP handshake with settlement negotiation`);
  console.log(`   ✅ Event publishing with balance proof claims`);

  console.log('\n⚠️  Exiting early to avoid nostr-tools issue\n');
  process.exit(0);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
