/**
 * Route identity: **which key a payload to a destination must be sealed to**
 * (connector #1026), and how a client checks that the answer came from
 * whoever actually holds that key.
 *
 * ADR 0018 seals every packet's `data` to the identity of the connector that
 * TERMINATES the route. On a terminated route that is the connector this
 * client talks to, and `GET /ilp/identity`'s `publicKey` is it. On a
 * FORWARDED route (ADR 0028) it is some other connector, one or more hops
 * away — and before #1026 nothing on the wire could name it, so a client
 * sealed to the hop it could see and the far end rejected `F01`.
 *
 * Since #1026, `GET /ilp/identity?destination=<addr>` (and the x402
 * greeting's `extra.routeIdentity`) carries a **statement signed by the
 * terminating connector** over `(prefix, its own identity key)`, made with
 * that same key. A forwarding hop relays it verbatim; it cannot forge one
 * for a key it does not hold. So a client that verifies the signature
 * against the key the statement names, over the prefix it names, and checks
 * its destination lies under that prefix, knows the key came from whoever
 * holds it — however many hops relayed it.
 *
 * This module is the byte-for-byte twin of the Rust
 * `connector_signer::route_identity` (`crates/connector-signer/src/
 * route_identity.rs`): same domain tag, same preimage, same signature
 * layout. If that encoding changes, this file changes with it and nothing
 * else in this package does.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** The domain tag every route-identity digest begins with (versioned). */
export const ROUTE_IDENTITY_DOMAIN_TAG = 'toon-route-identity-v1';

/** An uncompressed secp256k1 public key: 65 bytes, leading `0x04`. */
const PUBLIC_KEY_BYTES = 65;
/** A route-identity signature on the wire: `r || s || v`, 65 bytes. */
const SIGNATURE_BYTES = 65;

/**
 * The statement as it appears on the wire — inside `GET /ilp/identity`'s
 * answer as `routeIdentity`, and inside an x402 greeting's
 * `extra.routeIdentity`. Both byte fields are `0x`-prefixed hex.
 */
export interface RouteIdentityWire {
  /** The ILP prefix the statement covers; the destination must be it or lie beneath it. */
  prefix: string;
  /** The terminating connector's identity, uncompressed secp256k1, `0x`-hex. */
  publicKey: string;
  /** That connector's signature over `(prefix, publicKey)`, `r||s||v`, `0x`-hex. */
  signature: string;
}

/**
 * The 32-byte digest a route-identity signature is made over:
 * `sha256(tag || u16_be(len(prefix)) || prefix || publicKey)`.
 */
export function routeIdentityDigest(
  prefix: string,
  publicKey: Uint8Array
): Uint8Array {
  const prefixBytes = new TextEncoder().encode(prefix);
  const tag = new TextEncoder().encode(ROUTE_IDENTITY_DOMAIN_TAG);
  const length = Math.min(prefixBytes.length, 0xffff);
  const preimage = new Uint8Array(tag.length + 2 + length + publicKey.length);
  let offset = 0;
  preimage.set(tag, offset);
  offset += tag.length;
  preimage[offset++] = (length >> 8) & 0xff;
  preimage[offset++] = length & 0xff;
  preimage.set(prefixBytes.subarray(0, length), offset);
  offset += length;
  preimage.set(publicKey, offset);
  return sha256(preimage);
}

/**
 * Whether `destination` is `prefix` itself or an address beneath it — the
 * same "prefix or prefix." rule ILP routing uses, so a statement for
 * `g.example.app` does not cover `g.example.apparel`.
 */
export function routeIdentityCovers(
  prefix: string,
  destination: string
): boolean {
  return (
    destination === prefix ||
    (destination.startsWith(prefix) && destination[prefix.length] === '.')
  );
}

/**
 * Whether `signature` is `publicKey`'s own statement that payloads to
 * `prefix` are sealed to it. Never throws: a malformed key or signature
 * fails to verify, exactly like a genuine one over a different prefix.
 */
export function verifyRouteIdentity(
  prefix: string,
  publicKey: Uint8Array,
  signature: Uint8Array
): boolean {
  if (
    publicKey.length !== PUBLIC_KEY_BYTES ||
    signature.length !== SIGNATURE_BYTES
  ) {
    return false;
  }
  try {
    // `v` (byte 64) is a recovery hint; verification against a known key
    // does not need it, so it is not read.
    return secp256k1.verify(
      signature.subarray(0, 64),
      routeIdentityDigest(prefix, publicKey),
      publicKey,
      { prehash: false, lowS: false }
    );
  } catch {
    return false;
  }
}

/**
 * Sign `prefix` under `identitySecret`, producing what a terminating
 * connector states. Here for tests and fakes: a client never signs one of
 * these, it only checks them.
 */
export function signRouteIdentity(
  identitySecret: Uint8Array,
  prefix: string
): { publicKey: Uint8Array; signature: Uint8Array } {
  const publicKey = secp256k1.getPublicKey(identitySecret, false);
  const digest = routeIdentityDigest(prefix, publicKey);
  const sig = secp256k1.sign(digest, identitySecret, {
    prehash: false,
    lowS: true,
    format: 'recovered',
  });
  // noble's recovered format is `v || r || s`; the wire is `r || s || v`.
  const signature = new Uint8Array(SIGNATURE_BYTES);
  signature.set(sig.subarray(1, 65), 0);
  signature[64] = sig[0] ?? 0;
  return { publicKey, signature };
}
