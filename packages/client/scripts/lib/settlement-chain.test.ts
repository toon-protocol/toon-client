/**
 * Unit tests for the harness-local settlement-chain + transport resolver.
 *
 * Infra-free: exercises chain DISPATCH (the right signer/config per chain), the
 * Mina-apex-pubkey-required GUARD, and the direct-vs-SOCKS transport branch. No
 * channel is opened and no network is touched — `openChannel()` is lazy, so
 * resolving never dials a chain. Run via:
 *
 *   pnpm --filter @toon-protocol/client exec vitest run scripts/lib/settlement-chain.test.ts
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import {
  resolveSettlement,
  resolveBtpTransport,
  resolveRelayTransport,
  generateMnemonic,
  type ResolveSettlementInput,
} from './settlement-chain.js';

const EVM_PRIVKEY =
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e';
const MOCK_USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
const APEX_EVM = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const APEX_SOLANA = 'GsbwXfJraMomNxBcpR3DBNxnKwAB3avDtawHcUMtX1XK';
const APEX_MINA = 'B62qksocUTe3wxR3uHB9oV7yWZi6JdkWLwNDvVoUkbXkmTGwHo3rDNc';

function baseInput(
  env: Record<string, string | undefined>
): ResolveSettlementInput {
  const sk = generateSecretKey();
  return {
    env,
    nostrPubkey: getPublicKey(sk),
    nostrSecretKey: sk,
    evmPrivKey: EVM_PRIVKEY,
    mnemonic: generateMnemonic(),
    anvilRpc: 'http://127.0.0.1:28545',
    mockUsdc: MOCK_USDC,
    tokenNetwork: TOKEN_NETWORK,
    apexEvm: APEX_EVM,
    deposit: '100000000000000000000',
  };
}

describe('resolveSettlement — chain dispatch', () => {
  it('defaults to evm when SETTLEMENT_CHAIN is unset', async () => {
    const r = await resolveSettlement(baseInput({}));
    expect(r.chain).toBe('evm');
    expect(r.chainKey).toBe('evm:base:31337');
    expect(r.apexSettlementAddress).toBe(APEX_EVM);
    // buildClaim before openChannel() must guard (lazy channel id).
    await expect(r.buildClaim(1n, 1)).rejects.toThrow(/openChannel/);
  });

  it('selects evm explicitly with a custom EVM_CHAIN_KEY', async () => {
    const r = await resolveSettlement(
      baseInput({ SETTLEMENT_CHAIN: 'evm', EVM_CHAIN_KEY: 'evm:anvil:31337' })
    );
    expect(r.chain).toBe('evm');
    expect(r.chainKey).toBe('evm:anvil:31337');
  });

  it('selects solana with full config', async () => {
    const r = await resolveSettlement(
      baseInput({
        SETTLEMENT_CHAIN: 'solana',
        SOLANA_RPC_URL: 'http://127.0.0.1:28899',
        SOLANA_PROGRAM_ID: 'GsbwXfJraMomNxBcpR3DBNxnKwAB3avDtawHcUMtX1XK',
        SOLANA_TOKEN_MINT: '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q',
        APEX_SOLANA_PUBKEY: APEX_SOLANA,
      })
    );
    expect(r.chain).toBe('solana');
    expect(r.chainKey).toBe('solana:devnet');
    expect(r.apexSettlementAddress).toBe(APEX_SOLANA);
  });

  it('selects mina with full config + apex pubkey', async () => {
    const r = await resolveSettlement(
      baseInput({
        SETTLEMENT_CHAIN: 'mina',
        MINA_GRAPHQL_URL: 'http://127.0.0.1:28085/graphql',
        MINA_ZKAPP_ADDRESS: APEX_MINA,
        APEX_MINA_PUBKEY: APEX_MINA,
      })
    );
    expect(r.chain).toBe('mina');
    expect(r.chainKey).toBe('mina:devnet');
    expect(r.apexSettlementAddress).toBe(APEX_MINA);
  });

  it('throws on an unknown SETTLEMENT_CHAIN', async () => {
    await expect(
      resolveSettlement(baseInput({ SETTLEMENT_CHAIN: 'bitcoin' }))
    ).rejects.toThrow(/Unknown SETTLEMENT_CHAIN/);
  });

  it('throws when a non-EVM chain is selected without a mnemonic', async () => {
    const input = baseInput({
      SETTLEMENT_CHAIN: 'solana',
      SOLANA_RPC_URL: 'http://x',
      SOLANA_PROGRAM_ID: 'p',
      SOLANA_TOKEN_MINT: 'm',
      APEX_SOLANA_PUBKEY: APEX_SOLANA,
    });
    delete (input as { mnemonic?: string }).mnemonic;
    await expect(resolveSettlement(input)).rejects.toThrow(
      /requires a mnemonic/
    );
  });
});

describe('resolveSettlement — solana config guards', () => {
  it('fails loudly without SOLANA_RPC_URL', async () => {
    await expect(
      resolveSettlement(
        baseInput({
          SETTLEMENT_CHAIN: 'solana',
          SOLANA_PROGRAM_ID: 'p',
          SOLANA_TOKEN_MINT: 'm',
          APEX_SOLANA_PUBKEY: APEX_SOLANA,
        })
      )
    ).rejects.toThrow(/SOLANA_RPC_URL/);
  });

  it('fails loudly without the apex Solana pubkey', async () => {
    await expect(
      resolveSettlement(
        baseInput({
          SETTLEMENT_CHAIN: 'solana',
          SOLANA_RPC_URL: 'http://x',
          SOLANA_PROGRAM_ID: 'p',
          SOLANA_TOKEN_MINT: 'm',
        })
      )
    ).rejects.toThrow(/apex Solana settlement pubkey/);
  });
});

describe('resolveSettlement — Mina apex-pubkey guard', () => {
  it('fails loudly when the apex Mina pubkey is absent (off-chain-only refusal)', async () => {
    await expect(
      resolveSettlement(
        baseInput({
          SETTLEMENT_CHAIN: 'mina',
          MINA_GRAPHQL_URL: 'http://x/graphql',
          MINA_ZKAPP_ADDRESS: APEX_MINA,
          // APEX_MINA_PUBKEY deliberately omitted
        })
      )
    ).rejects.toThrow(/apex Mina settlement pubkey/);
  });

  it('rejects a malformed (non-B62) apex Mina pubkey', async () => {
    await expect(
      resolveSettlement(
        baseInput({
          SETTLEMENT_CHAIN: 'mina',
          MINA_GRAPHQL_URL: 'http://x/graphql',
          MINA_ZKAPP_ADDRESS: APEX_MINA,
          APEX_MINA_PUBKEY: '0xnot-a-mina-address',
        })
      )
    ).rejects.toThrow(/not a valid B62/);
  });

  it('accepts TARGET_SETTLEMENT_ADDRESS_MINA as the apex pubkey alias', async () => {
    const r = await resolveSettlement(
      baseInput({
        SETTLEMENT_CHAIN: 'mina',
        MINA_GRAPHQL_URL: 'http://x/graphql',
        MINA_ZKAPP_ADDRESS: APEX_MINA,
        TARGET_SETTLEMENT_ADDRESS_MINA: APEX_MINA,
      })
    );
    expect(r.apexSettlementAddress).toBe(APEX_MINA);
  });
});

describe('resolveBtpTransport — direct vs SOCKS', () => {
  const common = {
    socksProxy: 'socks5h://157.90.113.23:9052',
    socksBtpUrl: 'ws://abc.anon:3000/btp',
    handshakeTimeoutMs: 60_000,
  };

  it('defaults to SOCKS (createWebSocket present)', () => {
    const t = resolveBtpTransport({ env: {}, ...common });
    expect(t.mode).toBe('socks');
    expect(t.btpUrl).toBe('ws://abc.anon:3000/btp');
    expect(typeof t.createWebSocket).toBe('function');
  });

  it('uses DIRECT when DIRECT_BTP=1 (no createWebSocket → native WS)', () => {
    const t = resolveBtpTransport({ env: { DIRECT_BTP: '1' }, ...common });
    expect(t.mode).toBe('direct');
    expect(t.createWebSocket).toBeUndefined();
    // No APEX_BTP_URL → falls back to the socks BTP url value, dialed directly.
    expect(t.btpUrl).toBe('ws://abc.anon:3000/btp');
  });

  it('uses DIRECT with an explicit APEX_BTP_URL', () => {
    const t = resolveBtpTransport({
      env: { APEX_BTP_URL: 'ws://127.0.0.1:3000/btp' },
      ...common,
    });
    expect(t.mode).toBe('direct');
    expect(t.btpUrl).toBe('ws://127.0.0.1:3000/btp');
    expect(t.createWebSocket).toBeUndefined();
  });
});

describe('resolveRelayTransport — direct (default) vs SOCKS (opt-in)', () => {
  const RELAY_HS =
    'ws://o7qefbfdcxsgh2h54dngvf43235vav3iniqi5nunusha7vi6z2whftyd.anyone:7100';
  const common = {
    socksRelayUrl: RELAY_HS,
    socksProxy: 'socks5h://157.90.113.23:9052',
  };

  it('defaults to DIRECT plain ws://127.0.0.1:7100 (reads are free)', () => {
    const t = resolveRelayTransport({ env: {}, ...common });
    expect(t.mode).toBe('direct');
    expect(t.relayUrl).toBe('ws://127.0.0.1:7100');
    expect(typeof t.createWebSocket).toBe('function');
  });

  it('honours a custom direct RELAY_WS_URL (host-bound or in-network)', () => {
    const t = resolveRelayTransport({
      env: { RELAY_WS_URL: 'ws://townhouse-direct-town:7100' },
      ...common,
    });
    expect(t.mode).toBe('direct');
    expect(t.relayUrl).toBe('ws://townhouse-direct-town:7100');
  });

  it('opts into SOCKS when RELAY_SOCKS_PROXY is set (→ relay HS fallback url)', () => {
    const t = resolveRelayTransport({
      env: { RELAY_SOCKS_PROXY: 'socks5h://127.0.0.1:28050' },
      ...common,
    });
    expect(t.mode).toBe('socks');
    expect(t.relayUrl).toBe(RELAY_HS);
    expect(t.describe).toContain('socks5h://127.0.0.1:28050');
  });

  it('auto-selects SOCKS when RELAY_WS_URL is a .anyone hidden service', () => {
    const t = resolveRelayTransport({
      env: { RELAY_WS_URL: RELAY_HS },
      ...common,
    });
    expect(t.mode).toBe('socks');
    expect(t.relayUrl).toBe(RELAY_HS);
    // No RELAY_SOCKS_PROXY → falls back to the legacy SOCKS_PROXY value.
    expect(t.describe).toContain('socks5h://157.90.113.23:9052');
  });

  it('auto-selects SOCKS when RELAY_WS_URL is a .anon hidden service', () => {
    const t = resolveRelayTransport({
      env: { RELAY_WS_URL: 'ws://abc.anon:7100' },
      ...common,
    });
    expect(t.mode).toBe('socks');
    expect(t.relayUrl).toBe('ws://abc.anon:7100');
  });

  it('RELAY_SOCKS_PROXY + custom RELAY_WS_URL: SOCKS to the given url via that proxy', () => {
    const t = resolveRelayTransport({
      env: {
        RELAY_SOCKS_PROXY: 'socks5h://127.0.0.1:28050',
        RELAY_WS_URL: 'ws://some-other.anyone:7100',
      },
      ...common,
    });
    expect(t.mode).toBe('socks');
    expect(t.relayUrl).toBe('ws://some-other.anyone:7100');
    expect(t.describe).toContain('socks5h://127.0.0.1:28050');
  });
});
