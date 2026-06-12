/**
 * Integration test: live HS-apex paid publish across chains (EVM / Solana / Mina).
 *
 * Exercises the full client → townhouse hidden-service pay-to-write loop against a
 * REAL operator apex: derive identity from a mnemonic, dial the apex BTP endpoint
 * over a SOCKS5h anon proxy, open an on-chain payment channel toward the apex's
 * per-chain receive address, sign a connector-format balance-proof claim, and
 * `publishEvent` — asserting the connector returns FULFILL.
 *
 * GATED: skipped unless `RUN_LIVE_HS_E2E=1`. It needs a live apex + a running
 * anon proxy + a funded testnet wallet, so it never runs in normal CI.
 *
 * Required env when enabled:
 *   RUN_LIVE_HS_E2E=1
 *   E2E_DEV_MNEMONIC          funded testnet wallet (12/24 BIP-39 words)
 *   LIVE_HS_BTP_URL           e.g. ws://<host>.anyone:3000/btp
 *   LIVE_HS_APEX_EVM          apex Base Sepolia receive address (0x…)
 *   LIVE_HS_APEX_SOLANA       apex Solana receive owner (base58)   — for solana
 *   LIVE_HS_APEX_MINA         apex Mina receive address (B62…)     — for mina
 * Optional:
 *   LIVE_HS_SOCKS             default socks5h://127.0.0.1:9050
 *   LIVE_HS_ACCOUNT_INDEX     BIP-44 account index, default 1
 *   LIVE_HS_CHAINS            csv of evm,solana,mina   (default evm)
 *   LIVE_HS_COUNT             publishes per chain, default 2 (raise to 12 to
 *                             cross the connector's settlement threshold)
 *
 * Deployed contract addresses (TokenNetwork / Solana program / Mina zkApp) are
 * read from the committed e2e/testnets.json.
 *
 * Example:
 *   RUN_LIVE_HS_E2E=1 \
 *   LIVE_HS_BTP_URL=ws://4kp3vgrtn7ivke65cicgxow2hjgpgdzcgg2lz7p3ifryeqmxehioftad.anyone:3000/btp \
 *   LIVE_HS_APEX_EVM=0xc2c3d7d82ee7e9cbdfd8eed11c04cae96e74f07e \
 *   LIVE_HS_APEX_SOLANA=GYEVd2uaec8sw2Gtfedgzw2qXduroof2vyEfz8HhqCFQ \
 *   LIVE_HS_APEX_MINA=B62qijqekj5o4YMDFNPjPLvQAYxYSMBxrvueyLBuyMowCCnzuxiT3ro \
 *   LIVE_HS_CHAINS=evm,solana,mina \
 *   pnpm --filter @toon-protocol/client test -- live-hs-paid-publish
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { describe, it, expect } from 'vitest';

import { deriveFullIdentity } from '../keys/KeyDerivation.js';
import { ToonClient } from '../ToonClient.js';
import type { PeerNegotiation } from '../channel/ChannelManager.js';

const RUN = process.env['RUN_LIVE_HS_E2E'] === '1';
const describeLive = RUN ? describe : describe.skip;

const SOCKS = process.env['LIVE_HS_SOCKS'] ?? 'socks5h://127.0.0.1:9050';
const ACCT = Number(process.env['LIVE_HS_ACCOUNT_INDEX'] ?? '1');
const COUNT = Number(process.env['LIVE_HS_COUNT'] ?? '2');
const CHAINS = (process.env['LIVE_HS_CHAINS'] ?? 'evm')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

type ChainKind = 'evm' | 'solana' | 'mina';

interface Testnets {
  evm: {
    chainId: string;
    rpcUrl: string;
    tokenAddress: string;
    tokenNetworkAddress: string;
  };
  solana: { rpcUrl: string; programId: string; tokenMint: string };
  mina: { graphqlUrl: string; zkAppAddress: string };
}

function loadTestnets(): Testnets {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/client/src/__integration__ → repo root
  const path = join(here, '../../../../e2e/testnets.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Testnets;
}

describeLive('live HS apex paid publish (RUN_LIVE_HS_E2E=1)', () => {
  const mnemonic = process.env['E2E_DEV_MNEMONIC'] ?? '';
  const btpUrl = process.env['LIVE_HS_BTP_URL'] ?? '';
  const apex = {
    evm: process.env['LIVE_HS_APEX_EVM'] ?? '',
    solana: process.env['LIVE_HS_APEX_SOLANA'] ?? '',
    mina: process.env['LIVE_HS_APEX_MINA'] ?? '',
  };
  const t = loadTestnets();
  const evmChainId = Number(t.evm.chainId.split(':')[1]);

  it('has the required env configured', () => {
    expect(mnemonic, 'E2E_DEV_MNEMONIC').not.toBe('');
    expect(btpUrl, 'LIVE_HS_BTP_URL').toMatch(
      /^wss?:\/\/.+\.anyone(:\d+)?\/btp$/
    );
  });

  for (const chain of CHAINS as ChainKind[]) {
    const perChainTimeout = chain === 'mina' ? 600_000 : 240_000;

    it(
      `${chain}: ${COUNT} paid publish(es) FULFILL against the apex`,
      async () => {
        expect(apex[chain], `LIVE_HS_APEX_${chain.toUpperCase()}`).not.toBe('');

        const id = await deriveFullIdentity(mnemonic, ACCT);
        const self = {
          evm: id.evm.address,
          solana: id.solana.publicKey,
          mina: id.mina.publicKey,
        };
        const ilpAddress = `g.toon.client.${self.evm.slice(2, 18).toLowerCase()}`;

        const chainCfg =
          chain === 'evm'
            ? {
                key: `evm:base:${evmChainId}`,
                supportedChains: [`evm:base:${evmChainId}`],
                chainRpcUrls: { [`evm:base:${evmChainId}`]: t.evm.rpcUrl },
                settlementAddresses: { [`evm:base:${evmChainId}`]: self.evm },
                preferredTokens: {
                  [`evm:base:${evmChainId}`]: t.evm.tokenAddress,
                },
                tokenNetworks: {
                  [`evm:base:${evmChainId}`]: t.evm.tokenNetworkAddress,
                },
                neg: {
                  chain: `evm:base:${evmChainId}`,
                  chainType: 'evm' as const,
                  chainId: evmChainId,
                  settlementAddress: apex.evm,
                  tokenAddress: t.evm.tokenAddress,
                  tokenNetwork: t.evm.tokenNetworkAddress,
                },
              }
            : chain === 'solana'
              ? {
                  key: 'solana:devnet',
                  supportedChains: ['solana:devnet'],
                  chainRpcUrls: { 'solana:devnet': t.solana.rpcUrl },
                  settlementAddresses: { 'solana:devnet': self.solana },
                  tokenNetworks: { 'solana:devnet': t.solana.programId },
                  solanaChannel: {
                    rpcUrl: t.solana.rpcUrl,
                    programId: t.solana.programId,
                    tokenMint: t.solana.tokenMint,
                    challengeDuration: 86400,
                  },
                  neg: {
                    chain: 'solana:devnet',
                    chainType: 'solana' as const,
                    chainId: 0,
                    settlementAddress: apex.solana,
                    tokenAddress: t.solana.tokenMint,
                    tokenNetwork: t.solana.programId,
                  },
                }
              : {
                  key: 'mina:devnet',
                  supportedChains: ['mina:devnet'],
                  chainRpcUrls: { 'mina:devnet': t.mina.graphqlUrl },
                  settlementAddresses: { 'mina:devnet': self.mina },
                  tokenNetworks: { 'mina:devnet': t.mina.zkAppAddress },
                  minaChannel: {
                    graphqlUrl: t.mina.graphqlUrl,
                    zkAppAddress: t.mina.zkAppAddress,
                  },
                  neg: {
                    chain: 'mina:devnet',
                    chainType: 'mina' as const,
                    chainId: 0,
                    settlementAddress: apex.mina,
                    tokenAddress: t.mina.zkAppAddress,
                    tokenNetwork: t.mina.zkAppAddress,
                  },
                };

        const { neg, key: _key, ...settlement } = chainCfg;
        void _key; // `key` is for readability only; not a ToonClient config field

        const client = new ToonClient({
          connectorUrl: 'http://127.0.0.1:1', // unused at runtime; satisfies validateConfig
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
          btpPeerId: self.evm,
          btpAuthToken: '',
          transport: { type: 'socks5', socksProxy: SOCKS },
          managedAnonProxy: false, // a proxy is already running at LIVE_HS_SOCKS
          destinationAddress: 'g.townhouse.town',
          knownPeers: [],
          relayUrl: '',
          ...settlement,
        });

        try {
          await client.start();

          // Bootstrap returns no peers for a bare apex dial, so inject the apex's
          // per-chain settlement metadata manually (mirrors the connector handshake).
          (
            client as unknown as {
              peerNegotiations: Map<string, PeerNegotiation>;
            }
          ).peerNegotiations.set('town', neg as PeerNegotiation);

          const channelId = await client.openChannel('g.townhouse.town');
          expect(channelId, 'on-chain channel id').toBeTruthy();

          const fee = 1n;
          for (let i = 1; i <= COUNT; i++) {
            const proof = await client.signBalanceProof(channelId, fee); // cumulative += fee
            const event = finalizeEvent(
              {
                kind: 1,
                content: `live-hs ${chain} publish #${i}`,
                tags: [],
                created_at: Math.floor(Date.now() / 1000),
              },
              generateSecretKey()
            );
            const res = await client.publishEvent(event, {
              claim: proof,
              ilpAmount: fee,
            });
            expect(
              res.success,
              `publish #${i} (${chain}): ${res.error ?? ''}`
            ).toBe(true);
            expect(res.eventId).toBeTruthy();
          }
        } finally {
          await client.stop();
        }
      },
      perChainTimeout
    );
  }
});
