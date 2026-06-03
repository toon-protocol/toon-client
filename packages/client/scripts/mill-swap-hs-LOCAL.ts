#!/usr/bin/env tsx
/**
 * Mill streamSwap over the HS — adapted from social-flow-hs-LOCAL.ts.
 * Client → public ATOR proxy → apex .anon → connector → mill (g.townhouse.mill).
 * EVM→EVM USDC swap (rate 1). Drives the SDK streamSwap with a BtpRuntimeClient
 * wrapped as a StreamSwapClient.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { privateKeyToAccount } from 'viem/accounts';
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { BtpRuntimeClient } from '../src/index.js';
import { EvmSigner } from '../src/signing/evm-signer.js';
import { OnChainChannelClient } from '../src/channel/OnChainChannelClient.js';
import { streamSwap } from '../../sdk/src/stream-swap.js';

const SOCKS_PROXY = process.env['SOCKS_PROXY'] ?? 'socks5h://157.90.113.23:9052';
const CONNECTOR_BTP_HS =
  'ws://27kdlelaw7asdyqeg63sqz6l3po44y4dwa36mrj2jneejikoahypu3yd.anon:3000/btp';
const ANVIL_RPC = process.env['ANVIL_RPC'] ?? 'http://127.0.0.1:28545';
const MOCK_USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
const ANVIL_CHAIN_ID = 31337;
const APEX_EVM = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const TEST_CLIENT_PRIVKEY =
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e';
const MILL_PUBKEY =
  process.env['MILL_PUBKEY'] ??
  '80ccf418cb3486670679c60941045e97022146d9e14514717b976ac555ef42a9';
const HS_TIMEOUT_MS = 60_000;

function log(s: string, m: string, e?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  if (e !== undefined) console.log(`[${ts}] [${s}] ${m}`, e);
  else console.log(`[${ts}] [${s}] ${m}`);
}

async function main() {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const evmAccount = privateKeyToAccount(TEST_CLIENT_PRIVKEY as `0x${string}`);
  log('INIT', `client nostr=${pubkey.slice(0, 12)}… evm=${evmAccount.address}`);
  log('INIT', `proxy=${SOCKS_PROXY} mill=${MILL_PUBKEY.slice(0, 12)}…`);

  // ── Open client→apex channel on-chain ───────────────────────────────────
  const evmSigner = new EvmSigner(TEST_CLIENT_PRIVKEY);
  const channelClient = new OnChainChannelClient({
    evmSigner,
    chainRpcUrls: { 'evm:base:31337': ANVIL_RPC },
  });
  const open = await channelClient.openChannel({
    peerId: 'apex',
    chain: 'evm:base:31337',
    tokenNetwork: TOKEN_NETWORK_ADDRESS,
    token: MOCK_USDC,
    peerAddress: APEX_EVM,
    initialDeposit: '100000000000000000000', // 100 USDC (18-dec)
    settlementTimeout: 86400,
  });
  const channelId = open.channelId;
  log('CHANNEL', `opened ${channelId.slice(0, 14)}… status=${open.status}`);

  // ── Sign the source-asset balance proof claim (covers the swap) ──────────
  const cumulative = 2_000_001n;
  const proof = await evmSigner.signBalanceProof({
    channelId,
    nonce: 1,
    transferredAmount: cumulative,
    lockedAmount: 0n,
    locksRoot: `0x${'00'.repeat(32)}`,
    chainId: ANVIL_CHAIN_ID,
    tokenNetworkAddress: TOKEN_NETWORK_ADDRESS,
    tokenAddress: MOCK_USDC,
  });
  const claim = EvmSigner.buildClaimMessage(proof, pubkey);
  log('CLAIM', `signed nonce=1 amt=${cumulative} signer=${proof.signerAddress}`);

  // ── BTP client over SOCKS5 → apex .anon ─────────────────────────────────
  const wsAgent = new SocksProxyAgent(SOCKS_PROXY);
  const createWebSocket = (url: string): WebSocket =>
    new WebSocket(url, {
      agent: wsAgent,
      handshakeTimeout: HS_TIMEOUT_MS,
    }) as unknown as WebSocket;
  const btpClient = new BtpRuntimeClient({
    btpUrl: CONNECTOR_BTP_HS,
    peerId: 'client',
    authToken: '',
    createWebSocket,
    maxRetries: 1,
    retryDelay: 2_000,
  });
  log('BTP', 'connecting to apex HS via SOCKS (circuit warm-up 30–60s)…');
  const t0 = Date.now();
  await btpClient.connect();
  log('BTP', `connected in ${Date.now() - t0}ms`);

  // ── Wrap BtpRuntimeClient as a StreamSwapClient ──────────────────────────
  const streamClient = {
    getPublicKey: () => pubkey,
    sendSwapPacket: async (p: {
      destination: string;
      amount: bigint;
      toonData: Uint8Array;
      timeout?: number;
      claim?: unknown;
    }) => {
      const res = await btpClient.sendIlpPacketWithClaim(
        {
          destination: p.destination,
          amount: p.amount.toString(),
          data: Buffer.from(p.toonData).toString('base64'),
          timeout: p.timeout ?? HS_TIMEOUT_MS,
        },
        (p.claim ?? claim) as Record<string, unknown>
      );
      log('SWAP-PKT', `dest=${p.destination} amt=${p.amount} → accepted=${res.accepted} code=${res.code ?? ''} msg=${res.message ?? ''}`);
      const d = res.data;
      log('SWAP-PKT', `FULFILL data: ${d === undefined ? 'undefined' : `len=${d.length} head=${d.slice(0, 80)}`}`);
      if (d) {
        try {
          const j = Buffer.from(d, 'base64').toString('utf8');
          log('SWAP-PKT', `data b64→utf8 head: ${j.slice(0, 120)}`);
        } catch (e) {
          log('SWAP-PKT', `b64 decode err: ${(e as Error).message}`);
        }
      }
      return {
        accepted: res.accepted,
        data: res.data,
        code: res.code,
        message: res.message,
      };
    },
  };

  // ── Drive the swap: EVM USDC → Solana USDC (cross-chain) ─────────────────
  const SOLANA_RECIPIENT =
    process.env['SOLANA_RECIPIENT'] ??
    'wyNtrAWDo7gtAjUA9mXcRcdK1v78K3unREsyy5chN5U';
  log('SWAP', `streamSwap EVM USDC→Solana USDC rate=1 amt=100000 → ${SOLANA_RECIPIENT.slice(0, 10)}…`);
  try {
    const result = await streamSwap({
      client: streamClient,
      millPubkey: MILL_PUBKEY,
      millIlpAddress: 'g.townhouse.mill',
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:31337' },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
        rate: '1',
      },
      senderSecretKey: secretKey,
      chainRecipient: SOLANA_RECIPIENT,
      totalAmount: 100_000n,
      packetCount: 1,
      claim,
      packetTimeoutMs: HS_TIMEOUT_MS,
    });
    log('SWAP', `state=${result.state} claims=${result.claims?.length ?? 0}`);
    console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `<${v.length}b>` : v), 2));
  } catch (err) {
    log('SWAP', `threw: ${(err as Error).message}`);
  }
  try {
    await btpClient.disconnect();
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
