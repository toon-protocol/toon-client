/**
 * ToonClient's own ADR 0018 sealing public key (toon-client#537,
 * toon-meta#266 §3.1/§7): a stable identity a seller publishes in a
 * `kind:31990` advertisement's `seal_pubkey` tag, so a buyer can seal a job
 * PREPARE's `data` to this client directly — without a `GET /identity` this
 * client cannot serve behind NAT (ADR 0022).
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { generateSecretKey } from 'nostr-tools/pure';
import { ToonClient } from './ToonClient.js';
import { toHex } from './utils/binary.js';
import type { ToonClientConfig } from './types.js';

const noopEncoder = (_e: NostrEvent): Uint8Array => new Uint8Array();
const noopDecoder = (_b: Uint8Array): NostrEvent => ({}) as NostrEvent;

function baseConfig(overrides: Partial<ToonClientConfig> = {}): ToonClientConfig {
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

describe('ToonClient.getSealingPublicKey', () => {
  it('derives the uncompressed secp256k1 public key for the configured secretKey', () => {
    const secretKey = generateSecretKey();
    const client = new ToonClient(baseConfig({ secretKey }));

    expect(client.getSealingPublicKey()).toEqual(
      secp256k1.getPublicKey(secretKey, false)
    );
  });

  it('is stable across calls and across daemon restarts for the same secretKey', () => {
    const secretKey = generateSecretKey();
    const first = new ToonClient(baseConfig({ secretKey }));
    const second = new ToonClient(baseConfig({ secretKey }));

    expect(first.getSealingPublicKey()).toEqual(second.getSealingPublicKey());
    expect(first.getSealingPublicKey()).toEqual(first.getSealingPublicKey());
  });

  it('differs for different secretKeys', () => {
    const a = new ToonClient(baseConfig({ secretKey: generateSecretKey() }));
    const b = new ToonClient(baseConfig({ secretKey: generateSecretKey() }));

    expect(a.getSealingPublicKey()).not.toEqual(b.getSealingPublicKey());
  });

  it('works before start() is called', () => {
    const client = new ToonClient(baseConfig());
    expect(() => client.getSealingPublicKey()).not.toThrow();
    expect(client.getSealingPublicKey()).toHaveLength(65);
  });
});

describe('ToonClient.getSealingPublicKeyHex', () => {
  it('hex-encodes getSealingPublicKey() — the exact seal_pubkey tag value', () => {
    const client = new ToonClient(baseConfig({ secretKey: generateSecretKey() }));

    expect(client.getSealingPublicKeyHex()).toBe(
      toHex(client.getSealingPublicKey())
    );
  });
});
