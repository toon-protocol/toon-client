/**
 * The job event, pinned against the verifier that actually reads it.
 *
 * Both apps run `nostr-tools`' `verifyEvent`, which recomputes the id from the
 * event's own fields and checks a BIP-340 signature over it. This package does
 * not depend on `nostr-tools`, so the pinned event below is how that agreement
 * is kept: it was produced by {@link buildJobEvent} with the fixed key and
 * timestamp used here, and `verifyEvent` accepted it. If the serialization ever
 * drifts — a reordered field, a number where a string belongs — this id stops
 * matching, and the drift is caught here rather than as a `422 Invalid event
 * signature` from a node that has already been paid.
 */

import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeUtf8, fromHex, toHex } from '../utils/binary.js';
import { buildJobEvent, jobEventParam } from './job-event.js';

/** 32 repeated bytes, so the event below is reproducible. */
const SECRET_KEY = new Uint8Array(32).fill(7);

describe('buildJobEvent', () => {
  it('reproduces an event nostr-tools verified', () => {
    const event = buildJobEvent({
      kind: 5096,
      params: { phase: 'quote', transaction: undefined },
      secretKey: SECRET_KEY,
      createdAt: 1_700_000_000,
    });

    // Everything a verifier recomputes is pinned. The signature is not: BIP-340
    // signing draws auxiliary randomness, so it differs run to run — which is
    // why `verifyEvent` checks the id it derives from these fields and then
    // checks a signature over THAT. The id is the deterministic half, and it is
    // the half a serialization drift would move.
    expect({ ...event, sig: undefined }).toEqual({
      pubkey: '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f',
      created_at: 1_700_000_000,
      kind: 5096,
      tags: [['param', 'phase', 'quote']],
      content: '',
      id: '19a8703bf3fa3e9ff4a9ba7436d150eadc2ccf75c98e0b9ecc45266ee5ad8337',
      sig: undefined,
    });
    expect(schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))).toBe(
      true
    );
  });

  it('signs the NIP-01 serialization, and the signature verifies', () => {
    const event = buildJobEvent({
      kind: 5095,
      params: { op: 'prepare', name: 'my-name' },
      secretKey: SECRET_KEY,
    });

    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
    ]);
    expect(event.id).toBe(toHex(sha256(encodeUtf8(serialized))));
    expect(schnorr.verify(fromHex(event.sig), fromHex(event.id), fromHex(event.pubkey))).toBe(
      true
    );
  });

  it('emits params in order, and omits the ones left unset', () => {
    const event = buildJobEvent({
      kind: 5095,
      params: { op: 'prepare', name: 'my-name', ticker: undefined, target: 'x' },
      secretKey: SECRET_KEY,
    });

    expect(event.tags).toEqual([
      ['param', 'op', 'prepare'],
      ['param', 'name', 'my-name'],
      ['param', 'target', 'x'],
    ]);
    expect(jobEventParam(event, 'ticker')).toBeUndefined();
    expect(jobEventParam(event, 'name')).toBe('my-name');
  });

  it('signs with a fresh key each time when given none', () => {
    // The signature is integrity, not identity: no app takes an event pubkey
    // for an authority, so there is no key here to derive, back up or rotate.
    const one = buildJobEvent({ kind: 5096, params: { phase: 'quote' } });
    const two = buildJobEvent({ kind: 5096, params: { phase: 'quote' } });
    expect(one.pubkey).not.toBe(two.pubkey);
  });

  it('stamps created_at in SECONDS', () => {
    const before = Math.floor(Date.now() / 1000);
    const event = buildJobEvent({ kind: 5096, params: { phase: 'quote' } });
    expect(event.created_at).toBeGreaterThanOrEqual(before);
    expect(event.created_at).toBeLessThan(before + 60);
  });
});
