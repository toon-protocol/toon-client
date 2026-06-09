#!/usr/bin/env tsx
/**
 * Mill streamSwap over the HS — adapted from social-flow-hs-LOCAL.ts.
 * Client → public ATOR proxy → apex .anon → connector → mill (g.townhouse.mill).
 * Drives the SDK streamSwap with a BtpRuntimeClient wrapped as a StreamSwapClient.
 *
 * Swap SOURCE chain (the chain the per-packet source claim settles on) is gated
 * by MILL_SOURCE_CHAIN ∈ {evm (default), solana, mina}; it opens the client→apex
 * source channel on that chain and signs the source claim with that chain's
 * signer (see scripts/lib/settlement-chain.ts). The swap DEST (`pair.to`) +
 * `chainRecipient` are INDEPENDENTLY selectable (MILL_DEST_CHAIN / SWAP_RECIPIENT)
 * — so a Sol-source/EVM-dest (or any combo) is expressible.
 *
 * solana/mina source need a mnemonic (MNEMONIC) + their chain config env
 * (SOLANA_RPC_URL/SOLANA_PROGRAM_ID/SOLANA_TOKEN_MINT/APEX_SOLANA_PUBKEY ;
 * MINA_GRAPHQL_URL/MINA_ZKAPP_ADDRESS/APEX_MINA_PUBKEY).
 *
 * Transport: SOCKS5 by default; DIRECT_BTP=1 / APEX_BTP_URL → plain ws://, no proxy.
 *
 * NOTE: live mill settle is Phase 5 (shares the connector dependency). This
 * harness only CONSTRUCTS the source/dest combination correctly.
 */
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { privateKeyToAccount } from 'viem/accounts';

import { BtpRuntimeClient } from '../src/index.js';
import { streamSwap } from '../../sdk/src/stream-swap.js';
import {
  resolveSettlement,
  resolveBtpTransport,
} from './lib/settlement-chain.js';

const SOCKS_PROXY = process.env['SOCKS_PROXY'] ?? 'socks5h://157.90.113.23:9052';
const CONNECTOR_BTP_HS =
  'ws://27kdlelaw7asdyqeg63sqz6l3po44y4dwa36mrj2jneejikoahypu3yd.anon:3000/btp';
const ANVIL_RPC = process.env['ANVIL_RPC'] ?? 'http://127.0.0.1:28545';
const MOCK_USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
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

  // ── Open client→apex SOURCE channel on-chain (MILL_SOURCE_CHAIN) ─────────
  // Phase 4b: the swap SOURCE chain is independent of the swap DEST. We drive
  // the source channel + claim via resolveSettlement, overriding its
  // SETTLEMENT_CHAIN selector with MILL_SOURCE_CHAIN (default evm = legacy).
  const millSourceChain = process.env['MILL_SOURCE_CHAIN']?.trim() || 'evm';
  const sourceEnv = { ...process.env, SETTLEMENT_CHAIN: millSourceChain };
  const settlement = await resolveSettlement({
    env: sourceEnv,
    nostrPubkey: pubkey,
    nostrSecretKey: secretKey,
    evmPrivKey: TEST_CLIENT_PRIVKEY,
    mnemonic: process.env['MNEMONIC'],
    anvilRpc: ANVIL_RPC,
    mockUsdc: MOCK_USDC,
    tokenNetwork: TOKEN_NETWORK_ADDRESS,
    apexEvm: APEX_EVM,
    deposit: '100000000000000000000', // 100 USDC (18-dec)
  });
  log('CHANNEL', `mill source chain=${settlement.chain} key=${settlement.chainKey}`);
  const channelId = await settlement.openChannel();
  log('CHANNEL', `opened ${channelId.slice(0, 14)}… chain=${settlement.chain}`);

  // ── Sign the source-asset balance proof claim (covers the swap) ──────────
  const cumulative = 2_000_001n;
  const claim = (await settlement.buildClaim(cumulative, 1)) as unknown as Record<
    string,
    unknown
  >;
  log('CLAIM', `signed nonce=1 amt=${cumulative} chain=${settlement.chain}`);

  // ── BTP client — SOCKS5 (default) or DIRECT ws:// ────────────────────────
  const transport = resolveBtpTransport({
    env: process.env,
    socksProxy: SOCKS_PROXY,
    socksBtpUrl: CONNECTOR_BTP_HS,
    handshakeTimeoutMs: HS_TIMEOUT_MS,
  });
  const btpClient = new BtpRuntimeClient({
    btpUrl: transport.btpUrl,
    peerId: 'client',
    authToken: '',
    ...(transport.createWebSocket
      ? { createWebSocket: transport.createWebSocket }
      : {}),
    maxRetries: 1,
    retryDelay: 2_000,
  });
  log('BTP', `connecting to apex via ${transport.describe}…`);
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

  // ── Drive the swap: <source> USDC → <dest> USDC (cross-chain) ────────────
  // SOURCE chain follows the settlement resolver (MILL_SOURCE_CHAIN). DEST chain
  // + recipient are INDEPENDENT (MILL_DEST_CHAIN / SWAP_RECIPIENT) so any
  // source/dest combo (e.g. Sol-source/EVM-dest) is expressible.
  const destChain = process.env['MILL_DEST_CHAIN']?.trim() || 'solana:devnet';
  const chainRecipient =
    process.env['SWAP_RECIPIENT'] ??
    process.env['SOLANA_RECIPIENT'] ??
    'wyNtrAWDo7gtAjUA9mXcRcdK1v78K3unREsyy5chN5U';
  log(
    'SWAP',
    `streamSwap ${settlement.chainKey} USDC→${destChain} USDC rate=1 amt=100000 → ${chainRecipient.slice(0, 10)}…`
  );
  try {
    const result = await streamSwap({
      client: streamClient,
      millPubkey: MILL_PUBKEY,
      millIlpAddress: 'g.townhouse.mill',
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: settlement.chainKey },
        to: { assetCode: 'USDC', assetScale: 6, chain: destChain },
        rate: '1',
      },
      senderSecretKey: secretKey,
      chainRecipient,
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
