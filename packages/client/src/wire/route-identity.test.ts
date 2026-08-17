import { describe, it, expect } from 'vitest';
import {
  routeIdentityCovers,
  routeIdentityDigest,
  signRouteIdentity,
  verifyRouteIdentity,
} from './route-identity.js';

const hex = (s: string) =>
  Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));

/**
 * Produced by the Rust reference (`connector_signer::route_identity`,
 * connector #1026) for `LocalSigner::from_secret_bytes([11u8; 32])` and
 * prefix `g.example.beta.app`. Pinned here so the two implementations
 * cannot drift apart without one of them noticing: this file must verify
 * what Rust signed, and — since both sign deterministically (RFC 6979) —
 * must sign the identical bytes.
 */
const RUST_VECTOR = {
  secret: new Uint8Array(32).fill(11),
  prefix: 'g.example.beta.app',
  publicKey:
    '0x04552c630b64b54bf50210c9e253d38bd4949c72e22873500f6285c2bede312a84e3ca35a0c8c0cf4c40398e720377e1ee09c7a6b0fd05683d5fe02d8f68231466',
  signature:
    '0xf9c73f793cde0da232082f29888fb42c3081359b8b33259ba0b3e05e2fd99e2535b167a591ecc36dbc1fb2b0d5fa6f9d03f5a75fe5301714100d251a9ab58e9100',
};

describe('route identity (connector #1026)', () => {
  it('verifies the statement the Rust connector signs', () => {
    expect(
      verifyRouteIdentity(
        RUST_VECTOR.prefix,
        hex(RUST_VECTOR.publicKey),
        hex(RUST_VECTOR.signature)
      )
    ).toBe(true);
  });

  it('signs the identical bytes the Rust connector signs', () => {
    const { publicKey, signature } = signRouteIdentity(
      RUST_VECTOR.secret,
      RUST_VECTOR.prefix
    );
    expect(Buffer.from(publicKey).toString('hex')).toBe(
      RUST_VECTOR.publicKey.slice(2)
    );
    expect(Buffer.from(signature).toString('hex')).toBe(
      RUST_VECTOR.signature.slice(2)
    );
  });

  it('a statement for one prefix is not a statement for another', () => {
    const key = hex(RUST_VECTOR.publicKey);
    const sig = hex(RUST_VECTOR.signature);
    expect(verifyRouteIdentity('g.example.beta.other', key, sig)).toBe(false);
    expect(verifyRouteIdentity('g.example.beta', key, sig)).toBe(false);
    // The length word keeps ("g.a","b") and ("g.","ab") apart.
    const a = signRouteIdentity(RUST_VECTOR.secret, 'g.a');
    expect(verifyRouteIdentity('g.', a.publicKey, a.signature)).toBe(false);
  });

  it('a hop cannot relabel a statement with its own key', () => {
    const farEnd = signRouteIdentity(RUST_VECTOR.secret, 'g.example.beta.app');
    const hop = signRouteIdentity(
      new Uint8Array(32).fill(12),
      'g.example.beta.app'
    );
    // Far end's signature under the hop's key: no.
    expect(
      verifyRouteIdentity('g.example.beta.app', hop.publicKey, farEnd.signature)
    ).toBe(false);
    // Hop's signature naming the far end's key: no.
    expect(
      verifyRouteIdentity('g.example.beta.app', farEnd.publicKey, hop.signature)
    ).toBe(false);
  });

  it('a malformed key or signature fails to verify rather than throwing', () => {
    const key = hex(RUST_VECTOR.publicKey);
    expect(verifyRouteIdentity('g.x', key, new Uint8Array(65))).toBe(false);
    expect(verifyRouteIdentity('g.x', key, new Uint8Array(64))).toBe(false);
    expect(
      verifyRouteIdentity('g.x', new Uint8Array(65), hex(RUST_VECTOR.signature))
    ).toBe(false);
  });

  it('digest is domain-tagged and length-prefixed', () => {
    const key = hex(RUST_VECTOR.publicKey);
    expect(routeIdentityDigest('g.a', key)).not.toEqual(
      routeIdentityDigest('g.b', key)
    );
    expect(routeIdentityDigest('g.a', key)).toHaveLength(32);
  });

  it('covers a prefix and what lies beneath it, not a sibling sharing characters', () => {
    expect(routeIdentityCovers('g.example.app', 'g.example.app')).toBe(true);
    expect(routeIdentityCovers('g.example.app', 'g.example.app.deeper')).toBe(
      true
    );
    expect(routeIdentityCovers('g.example.app', 'g.example.apparel')).toBe(
      false
    );
    expect(routeIdentityCovers('g.example.app', 'g.example')).toBe(false);
  });
});
