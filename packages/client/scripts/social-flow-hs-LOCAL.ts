#!/usr/bin/env tsx
/**
 * Social-flow Hidden-Service E2E
 *
 * Real-world e2e demo against the running townhouse-hs stack:
 *   - Real ATOR (Anyone-network) routing via SOCKS5 proxy on 127.0.0.1:9052
 *   - Real ILP connector at the Anyone hidden service (BTP)
 *   - Real Nostr relay at a separate Anyone hidden service (WebSocket)
 *   - Real on-chain Mock USDC settlement attempt against Anvil
 *
 * Setup phase uses clearnet (faucet drip + balance reads). The actual
 * Nostr publish + subscribe phases route exclusively through the ATOR
 * SOCKS5 proxy — that's the whole point of the test.
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/social-flow-hs-e2e.ts
 *
 * Prereqs (already running in this stack):
 *   - docker-compose-townhouse-hs.yml: 8 containers + ator-test-proxy
 *   - SOCKS5 proxy at 127.0.0.1:9052 (Anyone-bootstrapped, separate from
 *     the ator-sidecar consumed by the connector)
 *   - HS endpoints (constants below) verified reachable via curl --socks5-hostname
 */

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  bytesToHex,
} from 'viem';
import type WebSocket from 'ws';

import { BtpRuntimeClient } from '../src/index.js';
import {
  resolveSettlement,
  resolveBtpTransport,
  resolveRelayTransport,
} from './lib/settlement-chain.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const SOCKS_PROXY =
  process.env['SOCKS_PROXY'] ?? 'socks5h://157.90.113.23:9052';

// Connector BTP HS endpoint (the apex connector reachable as a hidden service).
// Configurable so the ATOR/SOCKS path can target the CURRENT apex `.anon`
// (host.json hostname), mirroring the direct path's APEX_BTP_URL. Falls back to
// the historical fixed `.anon` for back-compat.
const CONNECTOR_BTP_HS =
  process.env['SOCKS_BTP_URL'] ??
  'ws://27kdlelaw7asdyqeg63sqz6l3po44y4dwa36mrj2jneejikoahypu3yd.anon:3000/btp';

// Relay HS endpoint — the town's Nostr relay reachable as a separate hidden
// service. Used ONLY by the SOCKS/ATOR read path (opt-in). The DEFAULT read
// path is now DIRECT: a plain ws://<relay-host>:7100 resolved by
// resolveRelayTransport (RELAY_WS_URL, default ws://127.0.0.1:7100). Reads are
// free, so direct is the default; SOCKS is opt-in via RELAY_SOCKS_PROXY (or a
// .anyone/.anon RELAY_WS_URL).
const RELAY_HS_SOCKS_FALLBACK =
  'ws://o7qefbfdcxsgh2h54dngvf43235vav3iniqi5nunusha7vi6z2whftyd.anyone:7100';

// Clearnet endpoints (setup + verification)
const FAUCET_URL = 'http://127.0.0.1:3500/api/request';
// Anvil RPC. Override via env to point at the Akash anvil
// (https://...ingress.akt.engineer) for cross-internet runs.
const ANVIL_RPC = process.env['ANVIL_RPC'] ?? 'http://127.0.0.1:8545';
const CONNECTOR_ADMIN = 'http://127.0.0.1:9401';
const MOCK_USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;

// ─── Test client EVM identity (FIXED — must match channel pre-opened by
//     scripts/townhouse-hs-open-channels.sh) ─────────────────────────────────
// The Nostr secretKey stays fresh each run (so kind:1 events are unique),
// but the EVM identity must be stable so the apex's pre-opened channel to
// `client` is usable. This is Anvil acct[6] — verified via:
//   docker exec townhouse-hs-anvil cast wallet address \
//     0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
//   → 0x976EA74026E726554dB657fA54763abd0C3a0aa9
// acct[3]=apex, [4]=town, [5]=mill, [6]=client (this script). Other accounts
// are deployer/faucet/spare.
const TEST_CLIENT_PRIVKEY =
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' as const;
const _TEST_CLIENT_EVM_ADDRESS =
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9' as const;

// EIP-712 domain for balance proofs — must match the apex connector's
// chainId + tokenNetwork. TokenNetwork is deterministic from
// contracts/evm/script/DeployLocal.s.sol (same as scripts/socialverse-e2e.ts:43).
const TOKEN_NETWORK_ADDRESS =
  '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' as const;

// Apex's settlement EVM address — Anvil acct[3], matches the apex's connector
// config (docker/configs/townhouse-hs-connector.yaml). The client→apex channel
// opened by this test script funds claims that the apex can later settle via
// claimFromChannel().
const APEX_EVM = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const;

// Test wallet (fresh key each run — no stable state)
const HS_TIMEOUT_MS = 60_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(stage: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  if (extra !== undefined) {
    console.log(`[${ts}] [${stage}] ${msg}`, extra);
  } else {
    console.log(`[${ts}] [${stage}] ${msg}`);
  }
}

function banner(title: string) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(72)}\n`);
}

/**
 * Mock USDC has 18 decimals (per the localnet contract deployment).
 */
async function readUsdcBalance(address: string): Promise<bigint> {
  const client = createPublicClient({ transport: http(ANVIL_RPC) });
  const balance = (await client.readContract({
    address: MOCK_USDC,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
  })) as bigint;
  return balance;
}

async function fetchConnectorMetrics(): Promise<{
  packetsForwarded: number;
  packetsRejected: number;
  bytesSent: number;
} | null> {
  try {
    const res = await fetch(`${CONNECTOR_ADMIN}/admin/metrics.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      aggregate?: {
        packetsForwarded?: number;
        packetsRejected?: number;
        bytesSent?: number;
      };
    };
    return {
      packetsForwarded: body.aggregate?.packetsForwarded ?? 0,
      packetsRejected: body.aggregate?.packetsRejected ?? 0,
      bytesSent: body.aggregate?.bytesSent ?? 0,
    };
  } catch (err) {
    log('METRICS', `failed: ${(err as Error).message}`);
    return null;
  }
}

async function fetchConnectorPeers(): Promise<unknown> {
  try {
    const res = await fetch(`${CONNECTOR_ADMIN}/admin/peers`, {
      signal: AbortSignal.timeout(5_000),
    });
    return await res.json();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Publishes a Nostr event to the relay and waits for the OK message. Reads
 * (and this echo-publish) are FREE — the relay enforces its own fee policy via
 * x402 / kind-pricing, no ILP/BTP involved. Transport is supplied by the caller
 * via `createWs` (DIRECT plain ws:// by default; SOCKS5 → relay HS when opted
 * in). See `resolveRelayTransport`.
 */
function publishDirectToRelay(
  relayUrl: string,
  event: NostrEvent,
  createWs: (url: string, timeoutMs: number) => WebSocket,
  timeoutMs = HS_TIMEOUT_MS
): Promise<{
  ok: boolean;
  message?: string;
  rawOkFrame?: unknown[];
  echoed: boolean;
  echoedRaw?: unknown[];
  error?: string;
}> {
  return new Promise((resolve) => {
    const ws = createWs(relayUrl, timeoutMs);
    const subId = `hs-pub-${Date.now()}`;
    let okFrame: unknown[] | undefined;
    let echoedRaw: unknown[] | undefined;
    let resolved = false;

    const finish = (result: {
      ok: boolean;
      message?: string;
      rawOkFrame?: unknown[];
      echoed: boolean;
      echoedRaw?: unknown[];
      error?: string;
    }) => {
      if (resolved) return;
      resolved = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        echoed: !!echoedRaw,
        rawOkFrame: okFrame,
        echoedRaw,
        error: 'timeout',
      });
    }, timeoutMs);

    ws.on('open', () => {
      log('PUB', `relay open — sending EVENT and REQ ${subId}`);
      ws.send(JSON.stringify(['EVENT', event]));
      ws.send(JSON.stringify(['REQ', subId, { ids: [event.id], limit: 1 }]));
    });

    ws.on('message', (data: Buffer | string) => {
      const text = data.toString();
      let msg: unknown[];
      try {
        msg = JSON.parse(text) as unknown[];
      } catch {
        log('PUB', `non-JSON frame: ${text.slice(0, 80)}`);
        return;
      }
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
        okFrame = msg;
        log(
          'PUB',
          `OK frame: success=${msg[2]} reason=${String(msg[3] ?? '')}`
        );
      } else if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId) {
        echoedRaw = msg;
        log('PUB', `relay echoed event back via REQ`);
      } else if (Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === subId) {
        if (okFrame !== undefined) {
          clearTimeout(timer);
          finish({
            ok: okFrame[2] === true,
            message: String(okFrame[3] ?? ''),
            rawOkFrame: okFrame,
            echoed: !!echoedRaw,
            echoedRaw,
          });
        }
      } else if (Array.isArray(msg) && msg[0] === 'NOTICE') {
        log('PUB', `NOTICE: ${msg[1]}`);
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        echoed: !!echoedRaw,
        rawOkFrame: okFrame,
        echoedRaw,
        error: err.message,
      });
    });

    ws.on('close', () => {
      clearTimeout(timer);
      finish({
        ok: okFrame !== undefined && okFrame[2] === true,
        message: okFrame ? String(okFrame[3] ?? '') : undefined,
        rawOkFrame: okFrame,
        echoed: !!echoedRaw,
        echoedRaw,
      });
    });
  });
}

/**
 * Subscribes to the relay (free read) and waits for an event matching the
 * filter (or for EOSE + a few seconds of grace) before resolving. Transport is
 * supplied by the caller via `createWs` (DIRECT plain ws:// by default; SOCKS5 →
 * relay HS when opted in). See `resolveRelayTransport`.
 */
function subscribeToRelay(
  relayUrl: string,
  filter: Record<string, unknown>,
  createWs: (url: string, timeoutMs: number) => WebSocket,
  timeoutMs = HS_TIMEOUT_MS
): Promise<{
  echoed: boolean;
  events: NostrEvent[];
  raw: unknown[];
  error?: string;
  eoseSeen: boolean;
}> {
  return new Promise((resolve) => {
    const ws = createWs(relayUrl, timeoutMs);
    const subId = `hs-e2e-${Date.now()}`;
    const events: NostrEvent[] = [];
    const raw: unknown[] = [];
    let eoseSeen = false;
    let resolved = false;

    const finish = (result: {
      echoed: boolean;
      events: NostrEvent[];
      raw: unknown[];
      error?: string;
      eoseSeen: boolean;
    }) => {
      if (resolved) return;
      resolved = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        echoed: events.length > 0,
        events,
        raw,
        error: 'timeout',
        eoseSeen,
      });
    }, timeoutMs);

    ws.on('open', () => {
      log('SUB', `relay open — sending REQ ${subId}`);
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });

    ws.on('message', (data: Buffer | string) => {
      const text = data.toString();
      let msg: unknown[];
      try {
        msg = JSON.parse(text) as unknown[];
      } catch {
        log('SUB', `non-JSON frame: ${text.slice(0, 80)}`);
        return;
      }
      raw.push(msg);

      if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId) {
        const payload = msg[2];
        try {
          let ev: NostrEvent;
          if (typeof payload === 'string') {
            // TOON string format → decode via core decoder
            ev = decodeEventFromToon(new TextEncoder().encode(payload));
          } else {
            ev = payload as NostrEvent;
          }
          events.push(ev);
          log(
            'SUB',
            `received EVENT kind=${ev.kind} id=${ev.id.slice(0, 12)}…`
          );
        } catch (err) {
          log('SUB', `decode failed: ${(err as Error).message}`);
        }
      } else if (Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === subId) {
        log('SUB', 'EOSE — relay finished initial replay');
        eoseSeen = true;
        // Hold the sub open for a few more seconds to catch live notifications
        setTimeout(() => {
          clearTimeout(timer);
          finish({ echoed: events.length > 0, events, raw, eoseSeen });
        }, 5_000);
      } else if (Array.isArray(msg) && msg[0] === 'NOTICE') {
        log('SUB', `NOTICE: ${msg[1]}`);
      }
    });

    ws.on('error', (err: Error) => {
      log('SUB', `ws error: ${err.message}`);
      clearTimeout(timer);
      finish({
        echoed: events.length > 0,
        events,
        raw,
        error: err.message,
        eoseSeen,
      });
    });

    ws.on('close', () => {
      clearTimeout(timer);
      finish({ echoed: events.length > 0, events, raw, eoseSeen });
    });
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  banner('Social-flow Hidden-Service E2E');

  // ─── Generate identity ───────────────────────────────────────────────────
  // Nostr key is fresh-each-run (so the kind:1 event is unique).
  // EVM key is FIXED to TEST_CLIENT_PRIVKEY so the apex's pre-opened payment
  // channel (opened by scripts/townhouse-hs-open-channels.sh) is reusable.
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  // bytesToHex retained for parity with prior version — surfaces the Nostr
  // key as a hex string for debugging if needed.
  void bytesToHex;
  const evmPrivateKeyHex = TEST_CLIENT_PRIVKEY as `0x${string}`;
  const evmAccount = privateKeyToAccount(evmPrivateKeyHex);
  const evmAddress = evmAccount.address;

  // Relay READ/SUBSCRIBE transport: DIRECT plain ws://<relay-host>:7100 by
  // default (reads are free); SOCKS/ATOR → relay HS is opt-in (RELAY_SOCKS_PROXY
  // or a .anyone/.anon RELAY_WS_URL). Both Phase 3a (publish) and Phase 3b
  // (subscribe) share this one decision.
  const relayTransport = resolveRelayTransport({
    env: process.env,
    socksRelayUrl: RELAY_HS_SOCKS_FALLBACK,
    socksProxy: SOCKS_PROXY,
  });

  log('INIT', `Nostr pubkey   = ${pubkey}`);
  log(
    'INIT',
    `EVM  address   = ${evmAddress} (fixed test-client = Anvil acct[6])`
  );
  log('INIT', `SOCKS proxy    = ${SOCKS_PROXY}`);
  log('INIT', `Connector HS   = ${CONNECTOR_BTP_HS}`);
  log('INIT', `Relay read     = ${relayTransport.describe}`);

  // ─── Setup phase (clearnet) ──────────────────────────────────────────────
  banner('Phase 1 — Setup (clearnet faucet + balance check)');

  // The settlement chain (SETTLEMENT_CHAIN ∈ {evm (default), solana, mina})
  // determines whether Phase 1's EVM faucet + USDC balance reads apply. The
  // faucet, readUsdcBalance(), and the apex on-chain settlement diff (Phase 5)
  // are ALL EVM-specific (ANVIL_RPC + MockUSDC). On a solana/mina run ANVIL_RPC
  // may be absent, so doing them unconditionally crashes the run before the
  // channel even opens. Gate them on isEvm; the actual Sol/Mina client funding
  // is handled by infra elsewhere (see CONTRIBUTING § Solana swap redeemability).
  const settlementChain = (
    process.env['SETTLEMENT_CHAIN']?.trim() || 'evm'
  ).toLowerCase();
  const isEvm = settlementChain === 'evm';

  let faucetOk = false;
  let balanceBefore = 0n;
  let apexBalanceBefore = 0n;

  if (isEvm) {
    log('FAUCET', 'requesting eth=1, usdc=1000');
    try {
      const res = await fetch(FAUCET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: evmAddress, eth: 1, usdc: 1000 }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      faucetOk = res.ok && body.success === true;
      log('FAUCET', `response ok=${faucetOk}`, body);
    } catch (err) {
      log('FAUCET', `failed: ${(err as Error).message}`);
    }

    // Give Anvil a moment to mine the txs
    await new Promise((r) => setTimeout(r, 1_500));

    balanceBefore = await readUsdcBalance(evmAddress);
    log(
      'BALANCE',
      `USDC before publish = ${balanceBefore} raw = ${formatUnits(balanceBefore, 18)} USDC`
    );

    // ─── Apex balance snapshot (pre-claim) ─────────────────────────────────
    // After SettlementExecutor calls claimFromChannel() on-chain, USDC moves
    // from the TokenNetwork escrow into the apex's settlement address. We
    // diff this against the post-test balance to prove on-chain settlement.
    apexBalanceBefore = await readUsdcBalance(APEX_EVM);
    log(
      'BALANCE',
      `Apex USDC before = ${apexBalanceBefore} raw (${formatUnits(apexBalanceBefore, 18)} USDC)`
    );
  } else {
    log(
      'FAUCET',
      `SETTLEMENT_CHAIN=${settlementChain} — skipping EVM faucet + USDC balance reads ` +
        '(non-EVM client funding is handled by infra; the on-chain apex-balance ' +
        'settlement diff in Phase 5 is EVM-only)'
    );
  }

  // Snapshot connector state
  const peersBefore = await fetchConnectorPeers();
  const metricsBefore = await fetchConnectorMetrics();
  log('CONN', 'peers (before)', peersBefore);
  log('CONN', 'metrics (before)', metricsBefore);

  // ─── Open client→apex channel on-chain ───────────────────────────────────
  // The apex→client channel from townhouse-hs-open-channels.sh handles apex
  // outflows. For the test client to send a *signed claim* the apex can
  // later submit via claimFromChannel(), we need a SEPARATE channel where
  // the test client is participant1 (depositor) and the apex is participant2.
  //
  // 100 USDC deposit (18-decimal MockERC20 → 100e18 base units) is large
  // enough to cover a 2_000_001 base-unit cumulative claim with margin.
  banner('Phase 1b — Open client→apex channel on-chain');
  // Settlement chain: SETTLEMENT_CHAIN ∈ {evm (default), solana, mina}. The
  // resolver supplies the channel opener + the chain-dispatched claim builder.
  // solana/mina need a mnemonic (MNEMONIC) + their chain config env.
  const settlement = await resolveSettlement({
    env: process.env,
    nostrPubkey: pubkey,
    nostrSecretKey: secretKey,
    evmPrivKey: TEST_CLIENT_PRIVKEY,
    mnemonic: process.env['MNEMONIC'],
    anvilRpc: ANVIL_RPC,
    mockUsdc: MOCK_USDC,
    tokenNetwork: TOKEN_NETWORK_ADDRESS,
    apexEvm: APEX_EVM,
    deposit: '100000000000000000000', // 100 USDC at 18 decimals
  });
  log(
    'CHANNEL',
    `settlement chain=${settlement.chain} key=${settlement.chainKey}`
  );
  let clientChannelId: string;
  try {
    log('CHANNEL', 'opening client→apex channel via OnChainChannelClient…');
    clientChannelId = await settlement.openChannel();
    log(
      'CHANNEL',
      `opened channelId=${clientChannelId} chain=${settlement.chain}`
    );
  } catch (err) {
    console.error(
      `\n[FATAL] Failed to open client→apex channel: ${(err as Error).message}\n` +
        '        Check that Anvil is reachable on 127.0.0.1:8545 and that\n' +
        '        the test client (acct[6]) has ETH for gas + 100+ USDC.\n' +
        '        Re-run scripts/townhouse-hs-open-channels.sh if needed.'
    );
    process.exit(2);
  }

  // ─── Phase 2 — Publish via HS through SOCKS ──────────────────────────────
  banner('Phase 2 — Publish via SOCKS over Anyone HS');

  // Build + sign the event. JOB_KIND=5094 builds a NIP-90 DVM job request
  // (paid publish to the relay; the DVM subscribes and picks it up).
  const jobKind = process.env['JOB_KIND'] ? Number(process.env['JOB_KIND']) : 1;
  const event =
    jobKind === 1
      ? finalizeEvent(
          {
            kind: 1,
            content: 'hello townhouse over HS',
            tags: [
              ['t', 'hs-e2e'],
              ['t', 'anyone'],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          secretKey
        )
      : finalizeEvent(
          {
            kind: jobKind, // 5094 = Arweave blob storage DVM
            content: '',
            tags: [
              ['i', 'aGVsbG8gZHZtIG92ZXIgSFM=', 'blob'],
              ['bid', '1000', 'usdc'],
              ['output', 'text/plain'],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          secretKey
        );
  log(
    'EVENT',
    `signed kind:${event.kind} id=${event.id.slice(0, 16)}… size=${JSON.stringify(event).length}b`
  );

  // BTP transport: SOCKS5 (default) or DIRECT plain ws:// (DIRECT_BTP=1 /
  // APEX_BTP_URL). The SOCKS path mirrors what the SDK's resolveTransport()
  // would build, but stand-alone (we deliberately bypass the full ToonClient
  // bootstrap because BootstrapService.queryPeerInfo() uses raw `ws` and would
  // try to dial the relay HS without the SOCKS agent — a separate gap from this
  // test's scope, captured in the final report).
  const transport = resolveBtpTransport({
    env: process.env,
    socksProxy: SOCKS_PROXY,
    socksBtpUrl: CONNECTOR_BTP_HS,
    handshakeTimeoutMs: HS_TIMEOUT_MS,
  });

  const btpClient = new BtpRuntimeClient({
    btpUrl: transport.btpUrl,
    // Must match the static peerId in docker/configs/townhouse-hs-connector.yaml.
    // The apex's BTP_ALLOW_NOAUTH path routes inbound BTP sessions by peerId,
    // and the channel was opened against this same peerId.
    peerId: 'client',
    authToken: '',
    ...(transport.createWebSocket
      ? { createWebSocket: transport.createWebSocket }
      : {}),
    maxRetries: 1, // don't retry-storm on a slow circuit
    retryDelay: 2_000,
  });

  let btpConnected = false;
  let publishOk = false;
  let publishCode: string | undefined;
  let publishMsg: string | undefined;
  let publishData: string | undefined;

  try {
    log('BTP', `connecting to connector via ${transport.describe}…`);
    const btpStart = Date.now();
    await btpClient.connect();
    btpConnected = true;
    log('BTP', `connected in ${Date.now() - btpStart}ms`);
  } catch (err) {
    const msg = (err as Error).message;
    log('BTP', `connect failed: ${msg}`);
    publishMsg = `connect failed: ${msg}`;
  }

  if (btpConnected) {
    // Encode the event to TOON binary, then base64 for the BTP packet payload
    const toonBytes = encodeEventToToon(event);
    const toonBase64 = Buffer.from(toonBytes).toString('base64');
    // amount=2_000_001 base units — chosen to push the cumulative claim
    // PAST the SettlementMonitor default threshold (1_000_000 base units),
    // so the apex's SettlementExecutor fires `claimFromChannel` on-chain.
    // The apex's PerPacketClaimService validates the inbound balance proof,
    // then signs an outbound claim (apex→town) using its own EVM key before
    // forwarding the PREPARE.
    const amountBigInt = 2_000_001n;
    const amount = amountBigInt.toString();
    log('BTP', `event encoded toonBytes=${toonBytes.length} amount=${amount}`);

    // Build + sign the cumulative balance proof via the selected chain's signer.
    // nonce monotonically increases across packets per channel; transferredAmount
    // is cumulative. For this single-packet test, transferredAmount == amountBigInt.
    const nonce = 1;
    const cumulative = amountBigInt;
    const claim = await settlement.buildClaim(cumulative, nonce);
    log(
      'BTP',
      `signed claim channelId=${clientChannelId.slice(0, 14)}… nonce=${nonce} amt=${cumulative} chain=${settlement.chain}`
    );

    const destination = process.env['DEST'] ?? 'g.townhouse.town'; // apex→child route to the relay-bearing town
    try {
      log('BTP', `sending PREPARE+claim → ${destination}`);
      const t0 = Date.now();
      const result = await btpClient.sendIlpPacketWithClaim(
        {
          destination,
          amount,
          data: toonBase64,
          timeout: HS_TIMEOUT_MS,
        },
        claim as unknown as Record<string, unknown>
      );
      const elapsed = Date.now() - t0;
      log('BTP', `response in ${elapsed}ms`, result);
      publishOk = result.accepted === true;
      publishCode = result.code;
      publishMsg = result.message;
      publishData = result.data;
    } catch (err) {
      const msg = (err as Error).message;
      log('BTP', `sendIlpPacketWithClaim threw: ${msg}`);
      publishMsg = msg;
    }

    // Send a SEPARATE `payment-channel-claim` BTP MESSAGE so the apex's
    // ClaimReceiver fires CLAIM_RECEIVED → SettlementMonitor sees the
    // cumulative claim cross threshold → SettlementExecutor calls
    // claimFromChannel() on-chain. This is fire-and-forget; we hold the
    // socket open briefly so the connector finishes processing before
    // disconnect tears down the session.
    if (publishOk) {
      try {
        await btpClient.sendClaimMessage(
          claim as unknown as Record<string, unknown>
        );
        log('CLAIM', 'payment-channel-claim BTP MESSAGE sent (standalone)');
      } catch (err) {
        log('CLAIM', `sendClaimMessage threw: ${(err as Error).message}`);
      }
      // Give the connector a moment to process the claim + kick off the
      // on-chain settlement transaction before we disconnect.
      await new Promise((r) => setTimeout(r, 5_000));
    }

    try {
      await btpClient.disconnect();
    } catch {
      /* ignore */
    }
  }

  // ─── Phase 3a — Publish straight to the relay (no ILP/BTP) ───────────────
  banner(`Phase 3a — Publish to relay (${relayTransport.mode}) Nostr WS`);

  const directResult = await publishDirectToRelay(
    relayTransport.relayUrl,
    event,
    relayTransport.createWebSocket,
    HS_TIMEOUT_MS
  );
  log(
    'PUB',
    `direct result ok=${directResult.ok} echoed=${directResult.echoed}${directResult.error ? ` err=${directResult.error}` : ''}${directResult.message ? ` msg=${directResult.message}` : ''}`
  );

  // ─── Phase 3b — Subscribe to the relay (free read) ───────────────────────
  banner(
    `Phase 3b — Subscribe to relay (${relayTransport.mode}) verify persistence`
  );

  const subResult = await subscribeToRelay(
    relayTransport.relayUrl,
    { kinds: [1], authors: [pubkey], limit: 5 },
    relayTransport.createWebSocket,
    HS_TIMEOUT_MS
  );
  log(
    'SUB',
    `result echoed=${subResult.echoed} events=${subResult.events.length} eose=${subResult.eoseSeen}${subResult.error ? ` err=${subResult.error}` : ''}`
  );

  // ─── Phase 4 — Verify (post-state) ───────────────────────────────────────
  banner('Phase 4 — Verify post-state');

  // EVM-only balance diff (mirror of the Phase 1 gate). On solana/mina the
  // client/apex balances live on the other chain, so leave the before/after at
  // their 0n sentinels and skip the read.
  let balanceAfter = 0n;
  let apexBalanceAfter = 0n;
  if (isEvm) {
    balanceAfter = await readUsdcBalance(evmAddress);
    const balanceDelta = balanceBefore - balanceAfter;
    log(
      'BALANCE',
      `USDC after  publish = ${balanceAfter} raw = ${formatUnits(balanceAfter, 18)} USDC`
    );
    log('BALANCE', `delta = ${balanceDelta} raw (USDC) [positive = paid out]`);
  } else {
    log(
      'BALANCE',
      `SETTLEMENT_CHAIN=${settlementChain} — EVM USDC balance diff skipped`
    );
  }
  const balanceDelta = balanceBefore - balanceAfter;

  const peersAfter = await fetchConnectorPeers();
  const metricsAfter = await fetchConnectorMetrics();
  log('CONN', 'peers (after)', peersAfter);
  log('CONN', 'metrics (after)', metricsAfter);

  // ─── Phase 5 — Verify on-chain settlement (apex balance delta) ───────────
  banner('Phase 5 — Verify on-chain settlement');

  if (isEvm) {
    apexBalanceAfter = await readUsdcBalance(APEX_EVM);
    log(
      'APEX',
      `USDC before = ${apexBalanceBefore} (${formatUnits(apexBalanceBefore, 18)})`
    );
    log(
      'APEX',
      `USDC after  = ${apexBalanceAfter} (${formatUnits(apexBalanceAfter, 18)})`
    );
    log(
      'APEX',
      `delta = ${apexBalanceAfter - apexBalanceBefore} raw [positive = on-chain claim succeeded]`
    );
  } else {
    log(
      'APEX',
      `SETTLEMENT_CHAIN=${settlementChain} — EVM on-chain apex-balance settlement diff skipped`
    );
  }
  const apexDelta = apexBalanceAfter - apexBalanceBefore;

  // ─── Summary ─────────────────────────────────────────────────────────────
  banner('Summary');
  console.log(
    JSON.stringify(
      {
        identity: { pubkey, evmAddress },
        faucet: { ok: faucetOk },
        btp: {
          connected: btpConnected,
          publishOk,
          code: publishCode,
          message: publishMsg,
          data: publishData,
        },
        eventId: event.id,
        directRelayPublish: {
          ok: directResult.ok,
          message: directResult.message,
          echoed: directResult.echoed,
          error: directResult.error,
        },
        relaySubscription: {
          echoed: subResult.echoed,
          events: subResult.events.length,
          eoseSeen: subResult.eoseSeen,
          error: subResult.error,
        },
        balance: {
          before: balanceBefore.toString(),
          after: balanceAfter.toString(),
          delta: balanceDelta.toString(),
          beforeHuman: formatUnits(balanceBefore, 18),
          afterHuman: formatUnits(balanceAfter, 18),
        },
        apexBalance: {
          before: apexBalanceBefore.toString(),
          after: apexBalanceAfter.toString(),
          delta: apexDelta.toString(),
          beforeHuman: formatUnits(apexBalanceBefore, 18),
          afterHuman: formatUnits(apexBalanceAfter, 18),
          onChainSettlementSucceeded: apexDelta > 0n,
        },
        channel: {
          clientChannelId,
        },
        connector: {
          peersBefore,
          peersAfter,
          metricsBefore,
          metricsAfter,
        },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
