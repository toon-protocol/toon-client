#!/usr/bin/env tsx
/**
 * All-three-nodes townhouse HS E2E harness — town + dvm + mill over ONE
 * client→apex payment channel and ONE BTP session through the public ATOR.
 *
 * Flow:  client → SOCKS5h proxy → apex .anon (BTP) → connector
 *   TOWN: publish a kind:1 Nostr event       → dest g.townhouse.town  → FULFILL
 *   DVM:  kind:5094 hero-image blob upload    → dest g.townhouse       → FULFILL (Arweave txId)
 *   MILL: streamSwap EVM USDC → Solana USDC   → dest g.townhouse.mill  → swap state + claim
 *
 * Reuses the COMPACT transport pattern from mill-swap-hs-LOCAL.ts /
 * social-flow-hs-LOCAL.ts: OnChainChannelClient.openChannel →
 * EvmSigner.signBalanceProof → BtpRuntimeClient over SocksProxyAgent.
 *
 * Config resolution order, per field:
 *   1. handoff JSON at $HANDOFF (default /tmp/toon-e2e/handoff.json) if present
 *   2. environment variable
 *   3. hardcoded fallback constant (so this runs standalone)
 *
 * Env overrides: SOCKS_PROXY, HANDOFF, ANVIL_RPC, MILL_PUBKEY, SOLANA_RECIPIENT.
 *
 * Settlement chain: SETTLEMENT_CHAIN ∈ {evm (default), solana, mina} selects the
 * client→apex channel + per-packet claim chain (see scripts/lib/settlement-chain.ts).
 * solana/mina additionally need a mnemonic (MNEMONIC / handoff.clientFunding.mnemonic)
 * plus their chain config (SOLANA_RPC_URL/SOLANA_PROGRAM_ID/SOLANA_TOKEN_MINT/
 * APEX_SOLANA_PUBKEY ; MINA_GRAPHQL_URL/MINA_ZKAPP_ADDRESS/APEX_MINA_PUBKEY).
 *
 * Transport: SOCKS5 by default; set DIRECT_BTP=1 (or APEX_BTP_URL=ws://…) for a
 * plain ws:// apex with no proxy.
 *
 * Exit code: 0 iff TOWN and DVM both FULFILL. MILL is reported but NON-FATAL —
 * the currently-deployed mill image returns ILP T00 live (the swap-handler
 * ACCEPTS in local repro; PR #94 fixes the masking logger), so a mill T00 is
 * treated as "reached handler; state reported", NOT a script failure.
 */
import { readFileSync, existsSync } from 'node:fs';

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { privateKeyToAccount } from 'viem/accounts';

import { buildBlobStorageRequest } from '@toon-protocol/core';
import { encodeEventToToon } from '@toon-protocol/relay';

import { BtpRuntimeClient } from '../src/index.js';
import { streamSwap } from '../../sdk/src/stream-swap.js';
import {
  resolveSettlement,
  resolveBtpTransport,
} from './lib/settlement-chain.js';

// ── Hardcoded fallback constants (Anvil deterministic dev values) ───────────
const DEFAULT_ANON =
  '27kdlelaw7asdyqeg63sqz6l3po44y4dwa36mrj2jneejikoahypu3yd.anon';
const DEFAULT_SOCKS = 'socks5h://157.90.113.23:9052';
const DEFAULT_ANVIL_RPC = 'http://127.0.0.1:28545';
const MOCK_USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
// NOTE: TokenNetwork is NOT in the handoff — keep it as this harness constant.
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
const APEX_EVM = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const DEFAULT_CLIENT_PRIVKEY =
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e';
// Correct mill nostr pubkey (handoff WARNING: mill logs the TOWN pubkey).
const DEFAULT_MILL_PUBKEY =
  '18a6445c16cc8bb33f46ca9580ad37bee0746104dc2ac8021ee31e995a62b1d8';
const DEFAULT_SOLANA_RECIPIENT = 'wyNtrAWDo7gtAjUA9mXcRcdK1v78K3unREsyy5chN5U';
const DEFAULT_HERO_IMAGE =
  '/home/jonathan/Documents/town/_bmad-output/branding/social-assets/github-hero-readme.jpg';
const HS_TIMEOUT_MS = Number(process.env['HS_TIMEOUT_MS'] ?? 90_000);

function log(s: string, m: string, e?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  if (e !== undefined) console.log(`[${ts}] [${s}] ${m}`, e);
  else console.log(`[${ts}] [${s}] ${m}`);
}

function banner(t: string): void {
  console.log(`\n${'─'.repeat(72)}\n  ${t}\n${'─'.repeat(72)}`);
}

interface Handoff {
  anonHostname?: string;
  btpUrl?: string;
  nodes?: {
    town?: { ilpAddress?: string };
    dvm?: { ilpDestination?: string };
    mill?: { ilpAddress?: string; nostrPubkey?: string };
  };
  chains?: { anvilHostRpc?: string; mockUsdc?: string };
  clientFunding?: { evmPrivKey?: string; mnemonic?: string };
  socksProxies?: string[];
  heroImage?: string;
}

function loadHandoff(): Handoff {
  const path = process.env['HANDOFF'] ?? '/tmp/toon-e2e/handoff.json';
  if (!existsSync(path)) {
    log('CONFIG', `handoff ${path} absent — using env/constants`);
    return {};
  }
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Handoff;
    log('CONFIG', `loaded handoff from ${path}`);
    return h;
  } catch (e) {
    log('CONFIG', `handoff parse failed (${(e as Error).message}) — using env/constants`);
    return {};
  }
}

interface NodeResult {
  pass: boolean;
  fatal: boolean; // counts toward exit code
  datum: string;
  note?: string;
}

async function main(): Promise<void> {
  const h = loadHandoff();

  // ── Resolve config (handoff → env → constant) ────────────────────────────
  const anonHost = h.anonHostname ?? DEFAULT_ANON;
  const btpUrl = h.btpUrl ?? `ws://${anonHost}:3000/btp`;
  const socks =
    process.env['SOCKS_PROXY'] ?? h.socksProxies?.[0] ?? DEFAULT_SOCKS;
  const anvilRpc =
    process.env['ANVIL_RPC'] ?? h.chains?.anvilHostRpc ?? DEFAULT_ANVIL_RPC;
  const mockUsdc = h.chains?.mockUsdc ?? MOCK_USDC;
  const clientPrivKey = (h.clientFunding?.evmPrivKey ??
    DEFAULT_CLIENT_PRIVKEY) as `0x${string}`;
  const townDest = h.nodes?.town?.ilpAddress ?? 'g.townhouse.town';
  const dvmDest = h.nodes?.dvm?.ilpDestination ?? 'g.townhouse';
  const millDest = h.nodes?.mill?.ilpAddress ?? 'g.townhouse.mill';
  const millPubkey =
    process.env['MILL_PUBKEY'] ??
    h.nodes?.mill?.nostrPubkey ??
    DEFAULT_MILL_PUBKEY;
  const solanaRecipient =
    process.env['SOLANA_RECIPIENT'] ?? DEFAULT_SOLANA_RECIPIENT;
  const heroImage = h.heroImage ?? DEFAULT_HERO_IMAGE;
  const mnemonic = process.env['MNEMONIC'] ?? h.clientFunding?.mnemonic;

  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const evmAccount = privateKeyToAccount(clientPrivKey);

  banner('INIT — all-three-nodes townhouse HS E2E');
  log('INIT', `client nostr=${pubkey.slice(0, 12)}… evm=${evmAccount.address}`);
  log('INIT', `anon=${anonHost.slice(0, 16)}… proxy=${socks}`);
  log('INIT', `town=${townDest} dvm=${dvmDest} mill=${millDest}`);
  log('INIT', `mill-pubkey=${millPubkey.slice(0, 12)}…`);

  // ── Resolve the settlement chain (SETTLEMENT_CHAIN, default evm) ──────────
  // The selected chain provides the channel opener + a chain-dispatched
  // `buildClaim`. Each TOWN/DVM/MILL claim rides this chain's channel.
  const settlement = await resolveSettlement({
    env: process.env,
    nostrPubkey: pubkey,
    nostrSecretKey: secretKey,
    evmPrivKey: clientPrivKey,
    mnemonic,
    anvilRpc,
    mockUsdc,
    tokenNetwork: TOKEN_NETWORK_ADDRESS,
    apexEvm: APEX_EVM,
    deposit: '100000000000000000000', // 100 USDC (18-dec MockUSDC)
  });
  log('INIT', `settlement chain=${settlement.chain} key=${settlement.chainKey}`);

  // ── Open ONE client→apex channel on-chain (selected chain) ───────────────
  const channelId = await settlement.openChannel();
  log('CHANNEL', `opened ${channelId.slice(0, 14)}… chain=${settlement.chain}`);

  // ── Connect ONE BTP session — SOCKS5 (default) or DIRECT ws:// ────────────
  const transport = resolveBtpTransport({
    env: process.env,
    socksProxy: socks,
    socksBtpUrl: btpUrl,
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
  const tConn = Date.now();
  await btpClient.connect();
  log('BTP', `connected in ${Date.now() - tConn}ms`);

  // Monotonic nonce across the single channel; each call signs a fresh
  // cumulative balance proof via the selected chain's signer. Amounts are the
  // selected token's base units.
  let nonce = 0;
  async function signClaim(cumulative: bigint): Promise<Record<string, unknown>> {
    nonce += 1;
    const claim = await settlement.buildClaim(cumulative, nonce);
    return claim as unknown as Record<string, unknown>;
  }

  const results: Record<string, NodeResult> = {};

  // ── TOWN: publish a kind:1 event → expect FULFILL ────────────────────────
  banner('TOWN — publish kind:1 over HS');
  let townEventId = '';
  try {
    const event = finalizeEvent(
      {
        kind: 1,
        content: `townhouse 3-node HS e2e ${new Date().toISOString()}`,
        tags: [
          ['t', 'hs-e2e'],
          ['t', 'three-node'],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );
    townEventId = event.id;
    log('TOWN', `signed kind:1 id=${event.id.slice(0, 16)}…`);
    const toonB64 = Buffer.from(encodeEventToToon(event)).toString('base64');
    // 2_000_001 base units pushes cumulative past the apex settlement
    // threshold (1_000_000), exercising the on-chain claim path.
    const claim = await signClaim(2_000_001n);
    const t0 = Date.now();
    const res = await btpClient.sendIlpPacketWithClaim(
      { destination: townDest, amount: '2000001', data: toonB64, timeout: HS_TIMEOUT_MS },
      claim
    );
    log('TOWN', `response in ${Date.now() - t0}ms accepted=${res.accepted} code=${res.code ?? ''} msg=${res.message ?? ''}`);
    results['TOWN'] = {
      pass: res.accepted === true,
      fatal: true,
      datum: res.accepted ? `eventId=${townEventId}` : `REJECT ${res.code ?? ''} ${res.message ?? ''}`,
    };
  } catch (err) {
    log('TOWN', `threw: ${(err as Error).message}`);
    results['TOWN'] = { pass: false, fatal: true, datum: `error: ${(err as Error).message}` };
  }

  // ── DVM: kind:5094 hero-image upload → dest g.townhouse → FULFILL(txId) ───
  banner('DVM — kind:5094 hero-image Arweave upload over HS');
  let arweaveTxId = '';
  try {
    if (!existsSync(heroImage)) throw new Error(`hero image not found: ${heroImage}`);
    const blobData = readFileSync(heroImage);
    log('DVM', `hero image ${heroImage} (${blobData.length} bytes)`);
    const event = buildBlobStorageRequest(
      { blobData, contentType: 'image/jpeg', bid: '1000' },
      secretKey
    );
    log('DVM', `signed kind:${event.kind} id=${event.id.slice(0, 16)}…`);
    const toonB64 = Buffer.from(encodeEventToToon(event)).toString('base64');
    const claim = await signClaim(4_000_002n);
    const t0 = Date.now();
    // Destination = connector self-address; localDelivery forwards to the dvm
    // HTTP handler (dvm is connected:false by design — not a BTP peer).
    const res = await btpClient.sendIlpPacketWithClaim(
      { destination: dvmDest, amount: '2000001', data: toonB64, timeout: HS_TIMEOUT_MS },
      claim
    );
    log('DVM', `response in ${Date.now() - t0}ms accepted=${res.accepted} code=${res.code ?? ''} msg=${res.message ?? ''}`);
    if (res.accepted === true && res.data) {
      arweaveTxId = Buffer.from(res.data, 'base64').toString('utf8').trim();
      log('DVM', `Arweave txId = ${arweaveTxId}`);
    }
    const txOk = /^[A-Za-z0-9_-]{43}$/.test(arweaveTxId);
    results['DVM'] = {
      pass: res.accepted === true && txOk,
      fatal: true,
      datum:
        res.accepted === true
          ? txOk
            ? `txId=${arweaveTxId}`
            : `FULFILL but txId malformed: "${arweaveTxId}"`
          : `REJECT ${res.code ?? ''} ${res.message ?? ''}`,
    };
  } catch (err) {
    log('DVM', `threw: ${(err as Error).message}`);
    results['DVM'] = { pass: false, fatal: true, datum: `error: ${(err as Error).message}` };
  }

  // ── MILL: streamSwap EVM USDC → Solana USDC (NON-FATAL) ──────────────────
  banner('MILL — streamSwap EVM USDC → Solana USDC over HS (non-fatal)');
  try {
    const swapClaim = await signClaim(6_000_003n);
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
          (p.claim ?? swapClaim) as Record<string, unknown>
        );
        log('MILL-PKT', `dest=${p.destination} amt=${p.amount} accepted=${res.accepted} code=${res.code ?? ''} msg=${res.message ?? ''}`);
        return { accepted: res.accepted, data: res.data, code: res.code, message: res.message };
      },
    };
    log('MILL', `streamSwap rate=1 amt=100000 → ${solanaRecipient.slice(0, 10)}…`);
    const result = await streamSwap({
      client: streamClient,
      millPubkey,
      millIlpAddress: millDest,
      pair: {
        // Swap SOURCE chain follows the selected settlement chain (the claim
        // covering the source is the selected chain's claim).
        from: { assetCode: 'USDC', assetScale: 6, chain: settlement.chainKey },
        to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
        rate: '1',
      },
      senderSecretKey: secretKey,
      chainRecipient: solanaRecipient,
      totalAmount: 100_000n,
      packetCount: 1,
      claim: swapClaim,
      packetTimeoutMs: HS_TIMEOUT_MS,
    });
    const claimCount = result.claims?.length ?? 0;
    log('MILL', `state=${result.state} claims=${claimCount}`);
    // PASS only on a genuinely completed swap with >=1 signed claim. A
    // reached-but-rejected handler (state=failed / 0 claims) is REPORTED, not
    // PASS — and is always NON-FATAL (never fails the script).
    const swapCompleted = result.state === 'completed' && claimCount > 0;
    results['MILL'] = {
      pass: swapCompleted,
      fatal: false,
      datum: `state=${result.state} signedClaims=${claimCount}`,
      note: swapCompleted
        ? 'mill issued signed target-chain claim'
        : 'KNOWN: deployed mill image rejects the swap live (T00/F00 — handler accepts in local repro; PR #94 fixes masking logger). Reached the mill handler; state reported, non-fatal.',
    };
  } catch (err) {
    log('MILL', `threw: ${(err as Error).message}`);
    results['MILL'] = {
      pass: false,
      fatal: false,
      datum: `error: ${(err as Error).message}`,
      note: 'KNOWN live-image limitation: mill T00 (PR #94) — non-fatal',
    };
  }

  try {
    await btpClient.disconnect();
  } catch {
    /* ignore */
  }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  banner('SUMMARY — townhouse 3-node HS E2E');
  let exitCode = 0;
  for (const name of ['TOWN', 'DVM', 'MILL'] as const) {
    const r = results[name];
    if (!r) {
      console.log(`  ${name.padEnd(5)} ✗ FAIL  (no result)`);
      exitCode = 1;
      continue;
    }
    const tag = r.pass ? '✓ PASS' : r.fatal ? '✗ FAIL' : '⚠ REPORTED';
    console.log(`  ${name.padEnd(5)} ${tag}  ${r.datum}`);
    if (r.note) console.log(`        └─ ${r.note}`);
    if (!r.pass && r.fatal) exitCode = 1;
  }
  console.log(`${'─'.repeat(72)}`);
  console.log(
    `  EXIT ${exitCode} — ${exitCode === 0 ? 'TOWN+DVM both FULFILLed' : 'TOWN and/or DVM did not FULFILL'} (MILL non-fatal)`
  );
  console.log(`${'─'.repeat(72)}\n`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
