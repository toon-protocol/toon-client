/**
 * Gated live-HS integration test for the client-mcp daemon.
 *
 * Mirrors `@toon-protocol/client`'s `live-hs-paid-publish.integration.test.ts`
 * but drives the FULL daemon stack (Fastify control plane + ClientRunner + real
 * ToonClient + persistent RelaySubscription) through the HTTP control client —
 * the same path the MCP tools use.
 *
 * Verifies, against a live `.anyone` HS apex + town relay:
 *   1. `toon_publish` (POST /publish) FULFILLs a paid write,
 *   2. `toon_subscribe` + `toon_read` (POST /subscribe, GET /events) return the
 *      published event,
 *   3. `toon_channels` (GET /channels) shows the nonce advance,
 *   4. restarting the daemon preserves the channel nonce watermark.
 *
 * Run:
 *   RUN_LIVE_HS_E2E=1 \
 *   E2E_DEV_MNEMONIC="…" \
 *   LIVE_HS_BTP_URL="ws://<host>.anyone:3000/btp" \
 *   LIVE_HS_RELAY_URL="wss://<relay-host>.anyone/" \
 *   LIVE_HS_APEX_EVM="0x…" \
 *   LIVE_HS_SOCKS="socks5h://127.0.0.1:9050" \
 *   pnpm --filter @toon-protocol/client-mcp test:integration
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { ToonClient } from '@toon-protocol/client';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/core';
import type { ToonClientConfig } from '@toon-protocol/client';
import { deriveFullIdentity } from '@toon-protocol/client';
import { ClientRunner, type ToonClientLike } from '../daemon/client-runner.js';
import { registerRoutes } from '../daemon/routes.js';
import type { ResolvedDaemonConfig } from '../daemon/config.js';
import { ControlClient } from '../control-client.js';

const RUN = process.env['RUN_LIVE_HS_E2E'] === '1';
const describeLive = RUN ? describe : describe.skip;

const SOCKS = process.env['LIVE_HS_SOCKS'] ?? 'socks5h://127.0.0.1:9050';
const ACCT = Number(process.env['LIVE_HS_ACCOUNT_INDEX'] ?? '1');

interface Testnets {
  evm: {
    chainId: string;
    rpcUrl: string;
    tokenAddress: string;
    tokenNetworkAddress: string;
  };
}

function loadTestnets(): Testnets {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '../../../../e2e/testnets.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Testnets;
}

/** Start an in-process control plane over a runner; returns app + base URL. */
async function startControlPlane(
  runner: ClientRunner
): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const app = Fastify({ logger: false });
  registerRoutes(app, runner);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

describeLive(
  'live HS daemon paid publish + read-back (RUN_LIVE_HS_E2E=1)',
  () => {
    const mnemonic = process.env['E2E_DEV_MNEMONIC'] ?? '';
    const btpUrl = process.env['LIVE_HS_BTP_URL'] ?? '';
    const relayUrl = process.env['LIVE_HS_RELAY_URL'] ?? '';
    const apexEvm = process.env['LIVE_HS_APEX_EVM'] ?? '';
    const t = loadTestnets();
    const evmChainId = Number(t.evm.chainId.split(':')[1]);
    const chainKey = `evm:base:${evmChainId}`;

    // Shared channel store so the restart can prove the nonce watermark persists.
    const storeDir = RUN ? mkdtempSync(join(tmpdir(), 'toon-mcp-e2e-')) : '';
    const channelStorePath = RUN ? join(storeDir, 'channels.json') : '';

    it('has the required env configured', () => {
      expect(mnemonic, 'E2E_DEV_MNEMONIC').not.toBe('');
      expect(btpUrl, 'LIVE_HS_BTP_URL').toMatch(
        /^wss?:\/\/.+\.anyone(:\d+)?\/btp$/
      );
      expect(relayUrl, 'LIVE_HS_RELAY_URL').not.toBe('');
      expect(apexEvm, 'LIVE_HS_APEX_EVM').not.toBe('');
    });

    async function buildRunner(): Promise<{
      runner: ClientRunner;
      self: string;
    }> {
      const id = await deriveFullIdentity(mnemonic, ACCT);
      const self = id.evm.address;
      const ilpAddress = `g.toon.client.${self.slice(2, 18).toLowerCase()}`;

      const toonClientConfig: ToonClientConfig = {
        connectorUrl: 'http://127.0.0.1:1',
        mnemonic,
        mnemonicAccountIndex: ACCT,
        ilpInfo: {
          pubkey: '00'.repeat(32),
          ilpAddress,
          btpEndpoint: btpUrl,
          assetCode: 'USD',
          assetScale: 6,
        },
        toonEncoder: encodeEventToToon,
        toonDecoder: decodeEventFromToon,
        btpUrl,
        btpPeerId: self,
        btpAuthToken: '',
        transport: { type: 'socks5', socksProxy: SOCKS },
        managedAnonProxy: false,
        destinationAddress: 'g.townhouse.town',
        knownPeers: [],
        relayUrl: '',
        channelStorePath,
        supportedChains: [chainKey],
        chainRpcUrls: { [chainKey]: t.evm.rpcUrl },
        settlementAddresses: { [chainKey]: self },
        preferredTokens: { [chainKey]: t.evm.tokenAddress },
        tokenNetworks: { [chainKey]: t.evm.tokenNetworkAddress },
      };

      const config: ResolvedDaemonConfig = {
        httpPort: 0,
        relayUrl,
        socksProxy: SOCKS,
        destination: 'g.townhouse.town',
        feePerEvent: 1n,
        chain: 'evm',
        apexChannelStorePath: join(storeDir, 'apex-channels.json'),
        apex: {
          destination: 'g.townhouse.town',
          peerId: 'town',
          chain: 'evm',
          chainKey,
          chainId: evmChainId,
          settlementAddress: apexEvm,
          tokenAddress: t.evm.tokenAddress,
          tokenNetwork: t.evm.tokenNetworkAddress,
        },
        toonClientConfig,
      };

      const runner = new ClientRunner({
        config,
        createClient: () =>
          new ToonClient(toonClientConfig) as unknown as ToonClientLike,
      });
      return { runner, self };
    }

    it('publishes paid, reads it back, and persists the nonce across restart', async () => {
      // ── First daemon instance ────────────────────────────────────────────
      const { runner } = await buildRunner();
      runner.start();
      await runner.bootstrap();
      expect(
        runner.isReady(),
        runner.getStatus().lastError ?? 'not ready'
      ).toBe(true);

      const { app, baseUrl } = await startControlPlane(runner);
      const control = new ControlClient({ baseUrl });

      try {
        // Subscribe for our own author's kind:1 before publishing.
        const sk = generateSecretKey();
        const event = finalizeEvent(
          {
            kind: 1,
            content: `client-mcp live-hs ${Date.now()}`,
            tags: [],
            created_at: Math.floor(Date.now() / 1000),
          },
          sk
        );
        const { subId } = await control.subscribe({
          filters: { authors: [event.pubkey], kinds: [1] },
        });

        // Paid publish via POST /publish.
        const pub = await control.publish({ event });
        expect(pub.eventId).toBe(event.id);
        expect(pub.nonce).toBeGreaterThanOrEqual(1);

        // Channel nonce visible via GET /channels.
        const channels = await control.channels();
        expect(channels.channels.length).toBeGreaterThanOrEqual(1);
        const nonceAfterFirst = channels.channels[0]!.nonce;
        expect(nonceAfterFirst).toBeGreaterThanOrEqual(1);

        // Read it back via GET /events (poll: relay propagation is async).
        let found = false;
        for (let i = 0; i < 20 && !found; i++) {
          const { events } = await control.events({ subId });
          if (events.some((e) => e.id === event.id)) found = true;
          else await new Promise((r) => setTimeout(r, 1000));
        }
        expect(found, 'published event read back through subscription').toBe(
          true
        );

        // ── Restart: a fresh runner over the SAME channelStorePath ──────────
        await runner.stop();
        await app.close();

        const restarted = await buildRunner();
        restarted.runner.start();
        await restarted.runner.bootstrap();
        const after = restarted.runner.getChannels();
        expect(
          after.channels[0]?.nonce,
          'nonce watermark survives restart'
        ).toBeGreaterThanOrEqual(nonceAfterFirst);
        await restarted.runner.stop();
      } finally {
        try {
          await app.close();
        } catch {
          /* already closed */
        }
      }
    }, 240_000);
  }
);
