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

/* eslint-disable no-console */

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, parseAbi, formatUnits, bytesToHex } from 'viem';
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { BtpRuntimeClient } from '../src/index.js';
import { EvmSigner } from '../src/signing/evm-signer.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const SOCKS_PROXY = 'socks5h://127.0.0.1:9052';

// Connector BTP HS endpoint (the apex connector reachable as a hidden service)
const CONNECTOR_BTP_HS = 'ws://6p4bkdkskzwsh5mfs4qf65cxmwfmh2a5in3kgu5lv3idvnzp7nazsvid.anyone:3000/btp';

// Relay HS endpoint (the town's Nostr relay reachable as a separate hidden service)
const RELAY_HS = 'ws://o7qefbfdcxsgh2h54dngvf43235vav3iniqi5nunusha7vi6z2whftyd.anyone:7100';

// Clearnet endpoints (setup + verification)
const FAUCET_URL = 'http://127.0.0.1:3500/api/request';
const ANVIL_RPC = 'http://127.0.0.1:8545';
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
const TEST_CLIENT_EVM_ADDRESS =
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9' as const;

// EIP-712 domain for balance proofs — must match the apex connector's
// chainId + tokenNetwork. TokenNetwork is deterministic from
// contracts/evm/script/DeployLocal.s.sol (same as scripts/socialverse-e2e.ts:43).
const TOKEN_NETWORK_ADDRESS =
  '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' as const;
const ANVIL_CHAIN_ID = 31337;

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
 * Publishes a Nostr event directly to the relay over SOCKS5 and waits for
 * the OK message. This is the "social flow over HS" path — the relay enforces
 * its own fee policy via x402 / kind-pricing, no ILP/BTP involved.
 */
function publishDirectViaSocks(
  relayUrl: string,
  event: NostrEvent,
  socksProxy: string,
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
    const agent = new SocksProxyAgent(socksProxy);
    const ws = new WebSocket(relayUrl, { agent, handshakeTimeout: timeoutMs });
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
      log('PUB', `relay HS open — sending EVENT and REQ ${subId}`);
      ws.send(JSON.stringify(['EVENT', event]));
      ws.send(
        JSON.stringify(['REQ', subId, { ids: [event.id], limit: 1 }])
      );
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
      } else if (
        Array.isArray(msg) &&
        msg[0] === 'EVENT' &&
        msg[1] === subId
      ) {
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
 * Subscribes to the relay over SOCKS5 and waits for an event matching the filter
 * (or for EOSE + a few seconds of grace) before resolving.
 */
function subscribeViaSocks(
  relayUrl: string,
  filter: Record<string, unknown>,
  socksProxy: string,
  timeoutMs = HS_TIMEOUT_MS
): Promise<{
  echoed: boolean;
  events: NostrEvent[];
  raw: unknown[];
  error?: string;
  eoseSeen: boolean;
}> {
  return new Promise((resolve) => {
    const agent = new SocksProxyAgent(socksProxy);
    const ws = new WebSocket(relayUrl, { agent, handshakeTimeout: timeoutMs });
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
      finish({ echoed: events.length > 0, events, raw, error: 'timeout', eoseSeen });
    }, timeoutMs);

    ws.on('open', () => {
      log('SUB', `relay HS open — sending REQ ${subId}`);
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
          log('SUB', `received EVENT kind=${ev.kind} id=${ev.id.slice(0, 12)}…`);
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
      finish({ echoed: events.length > 0, events, raw, error: err.message, eoseSeen });
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

  log('INIT', `Nostr pubkey   = ${pubkey}`);
  log('INIT', `EVM  address   = ${evmAddress} (fixed test-client = Anvil acct[6])`);
  log('INIT', `SOCKS proxy    = ${SOCKS_PROXY}`);
  log('INIT', `Connector HS   = ${CONNECTOR_BTP_HS}`);
  log('INIT', `Relay HS       = ${RELAY_HS}`);

  // ─── Setup phase (clearnet) ──────────────────────────────────────────────
  banner('Phase 1 — Setup (clearnet faucet + balance check)');

  log('FAUCET', 'requesting eth=1, usdc=1000');
  let faucetOk = false;
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

  const balanceBefore = await readUsdcBalance(evmAddress);
  log('BALANCE', `USDC before publish = ${balanceBefore} raw = ${formatUnits(balanceBefore, 18)} USDC`);

  // Snapshot connector state
  const peersBefore = await fetchConnectorPeers();
  const metricsBefore = await fetchConnectorMetrics();
  log('CONN', 'peers (before)', peersBefore);
  log('CONN', 'metrics (before)', metricsBefore);

  // ─── Pre-flight: confirm apex has an open channel to `client` peer ───────
  // The admin /channels endpoint exposes peerId + status; the participant
  // address is implicit (apex peers config maps client → TEST_CLIENT_EVM_ADDRESS).
  log('CHANNEL', 'pre-flight: GET /admin/channels');
  let clientChannelId: string | null = null;
  try {
    const res = await fetch(`${CONNECTOR_ADMIN}/admin/channels`, {
      signal: AbortSignal.timeout(5_000),
    });
    const channels = (await res.json()) as Array<{
      channelId: string;
      peerId: string;
      status: string;
    }>;
    const clientChan = channels.find(
      (c) => c.peerId === 'client' && c.status === 'open'
    );
    if (!clientChan) {
      console.error(
        '\n[FATAL] No open channel found for peerId=client.\n' +
          '        Run scripts/townhouse-hs-open-channels.sh first.\n' +
          `        Current channels: ${JSON.stringify(channels)}`
      );
      process.exit(2);
    }
    clientChannelId = clientChan.channelId;
    log('CHANNEL', `found channelId=${clientChannelId}`);
  } catch (err) {
    console.error(
      `\n[FATAL] Failed to query /admin/channels: ${(err as Error).message}\n` +
        '        Is the apex connector reachable on 127.0.0.1:9401?'
    );
    process.exit(2);
  }

  // ─── Phase 2 — Publish via HS through SOCKS ──────────────────────────────
  banner('Phase 2 — Publish via SOCKS over Anyone HS');

  // Build + sign the kind:1 event
  const event = finalizeEvent(
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
  );
  log('EVENT', `signed kind:1 id=${event.id.slice(0, 16)}… size=${JSON.stringify(event).length}b`);

  // BTP via SOCKS5 — mirror what the SDK's resolveTransport() would build,
  // but stand-alone (we deliberately bypass the full ToonClient bootstrap
  // because BootstrapService.queryPeerInfo() uses raw `ws` and would try to
  // dial the relay HS without the SOCKS agent — that is a separate gap from
  // this test's scope and is captured in the final report).
  const wsAgent = new SocksProxyAgent(SOCKS_PROXY);
  const createWebSocket = (url: string): WebSocket =>
    new WebSocket(url, { agent: wsAgent, handshakeTimeout: HS_TIMEOUT_MS }) as unknown as WebSocket;

  const btpClient = new BtpRuntimeClient({
    btpUrl: CONNECTOR_BTP_HS,
    // Must match the static peerId in docker/configs/townhouse-hs-connector.yaml.
    // The apex's BTP_ALLOW_NOAUTH path routes inbound BTP sessions by peerId,
    // and the channel was opened against this same peerId.
    peerId: 'client',
    authToken: '',
    createWebSocket,
    maxRetries: 1, // don't retry-storm on a slow circuit
    retryDelay: 2_000,
  });

  let btpConnected = false;
  let publishOk = false;
  let publishCode: string | undefined;
  let publishMsg: string | undefined;
  let publishData: string | undefined;

  try {
    log('BTP', 'connecting to connector HS via SOCKS (Anyone circuit warm-up may take 30–60s)…');
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
    // amount=1 base unit (smallest non-zero) — minimal claim that exercises
    // the apex's forwarded-claim path. The apex's PerPacketClaimService
    // validates the inbound balance proof, then signs an outbound claim
    // (apex→town) using its own EVM key before forwarding the PREPARE.
    const amountBigInt = 1n;
    const amount = amountBigInt.toString();
    log('BTP', `event encoded toonBytes=${toonBytes.length} amount=${amount}`);

    // Build + sign the cumulative balance proof. nonce monotonically
    // increases across packets per channel; transferredAmount is cumulative.
    // For a single-packet test we use nonce=1 and transferredAmount=1.
    const evmSigner = new EvmSigner(TEST_CLIENT_PRIVKEY);
    const nonce = 1;
    const cumulative = amountBigInt;
    const proof = await evmSigner.signBalanceProof({
      channelId: clientChannelId as string,
      nonce,
      transferredAmount: cumulative,
      lockedAmount: 0n,
      locksRoot: `0x${'00'.repeat(32)}`,
      chainId: ANVIL_CHAIN_ID,
      tokenNetworkAddress: TOKEN_NETWORK_ADDRESS,
      tokenAddress: MOCK_USDC,
    });
    const claim = EvmSigner.buildClaimMessage(proof, pubkey);
    log(
      'BTP',
      `signed claim channelId=${clientChannelId?.slice(0, 14)}… nonce=${nonce} amt=${cumulative} signer=${proof.signerAddress}`
    );

    const destination = 'g.townhouse.town'; // apex→child route to the relay-bearing town
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

    try {
      await btpClient.disconnect();
    } catch {
      /* ignore */
    }
  }

  // ─── Phase 3a — Direct publish to relay HS (no ILP/BTP) ──────────────────
  banner('Phase 3a — Direct publish to relay HS via SOCKS (Nostr WS)');

  const directResult = await publishDirectViaSocks(
    RELAY_HS,
    event,
    SOCKS_PROXY,
    HS_TIMEOUT_MS
  );
  log(
    'PUB',
    `direct result ok=${directResult.ok} echoed=${directResult.echoed}${directResult.error ? ` err=${directResult.error}` : ''}${directResult.message ? ` msg=${directResult.message}` : ''}`
  );

  // ─── Phase 3b — Subscribe to relay HS via SOCKS ──────────────────────────
  banner('Phase 3b — Subscribe to relay HS via SOCKS (verify persistence)');

  const subResult = await subscribeViaSocks(
    RELAY_HS,
    { kinds: [1], authors: [pubkey], limit: 5 },
    SOCKS_PROXY,
    HS_TIMEOUT_MS
  );
  log('SUB', `result echoed=${subResult.echoed} events=${subResult.events.length} eose=${subResult.eoseSeen}${subResult.error ? ` err=${subResult.error}` : ''}`);

  // ─── Phase 4 — Verify (post-state) ───────────────────────────────────────
  banner('Phase 4 — Verify post-state');

  const balanceAfter = await readUsdcBalance(evmAddress);
  const balanceDelta = balanceBefore - balanceAfter;
  log('BALANCE', `USDC after  publish = ${balanceAfter} raw = ${formatUnits(balanceAfter, 18)} USDC`);
  log('BALANCE', `delta = ${balanceDelta} raw (USDC) [positive = paid out]`);

  const peersAfter = await fetchConnectorPeers();
  const metricsAfter = await fetchConnectorMetrics();
  log('CONN', 'peers (after)', peersAfter);
  log('CONN', 'metrics (after)', metricsAfter);

  // ─── Summary ─────────────────────────────────────────────────────────────
  banner('Summary');
  console.log(JSON.stringify(
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
      connector: {
        peersBefore,
        peersAfter,
        metricsBefore,
        metricsAfter,
      },
    },
    null,
    2
  ));
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
