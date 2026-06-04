/**
 * Mnemonic-based identity construction for ToonClient.
 *
 * Verifies that a `mnemonic` config field resolves the Nostr/EVM identity
 * synchronously (matching `deriveFullIdentity`) and that the mnemonic↔secretKey
 * precedence guard is enforced.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { ToonClient } from './ToonClient.js';
import { validateConfig } from './config.js';
import { deriveFullIdentity } from './keys/KeyDerivation.js';
import { generateSecretKey } from 'nostr-tools/pure';
import type { ToonClientConfig } from './types.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

const noopEncoder = (_e: NostrEvent): Uint8Array => new Uint8Array();
const noopDecoder = (_b: Uint8Array): NostrEvent => ({}) as NostrEvent;

function baseConfig(overrides: Partial<ToonClientConfig>): ToonClientConfig {
  return {
    connectorUrl: 'http://localhost:8080',
    ilpInfo: {
      pubkey: '00'.repeat(32),
      ilpAddress: 'g.toon.test',
      btpEndpoint: 'ws://localhost:3000',
      assetCode: 'USD',
      assetScale: 6,
    },
    toonEncoder: noopEncoder,
    toonDecoder: noopDecoder,
    ...overrides,
  };
}

describe('ToonClient — mnemonic identity', () => {
  it('derives the same Nostr pubkey + EVM address as deriveFullIdentity', async () => {
    const identity = await deriveFullIdentity(MNEMONIC);
    const client = new ToonClient(baseConfig({ mnemonic: MNEMONIC }));

    expect(client.getPublicKey()).toBe(identity.nostr.pubkey);
    expect(client.getEvmAddress()?.toLowerCase()).toBe(
      identity.evm.address.toLowerCase()
    );
  });

  it('lets an explicit evmPrivateKey override the mnemonic-derived EVM key', () => {
    // Distinct EVM key (all 0x11…) — must NOT equal the Nostr-derived address.
    const evmPrivateKey = '0x' + '11'.repeat(32);
    const client = new ToonClient(
      baseConfig({ mnemonic: MNEMONIC, evmPrivateKey })
    );
    // 0x11..11 → known viem address
    expect(client.getEvmAddress()?.toLowerCase()).toBe(
      '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
    );
  });

  it('Solana/Mina addresses are undefined before start()', () => {
    const client = new ToonClient(baseConfig({ mnemonic: MNEMONIC }));
    expect(client.getSolanaAddress()).toBeUndefined();
    expect(client.getMinaAddress()).toBeUndefined();
  });
});

describe('validateConfig — mnemonic guards', () => {
  it('rejects mnemonic + secretKey together', () => {
    expect(() =>
      validateConfig(
        baseConfig({ mnemonic: MNEMONIC, secretKey: generateSecretKey() })
      )
    ).toThrow(/either .mnemonic. or .secretKey./i);
  });

  it('rejects an invalid mnemonic phrase', () => {
    expect(() =>
      validateConfig(baseConfig({ mnemonic: 'not a valid bip39 phrase' }))
    ).toThrow(/valid BIP-39/i);
  });

  it('accepts a valid mnemonic alone', () => {
    expect(() =>
      validateConfig(baseConfig({ mnemonic: MNEMONIC }))
    ).not.toThrow();
  });
});
