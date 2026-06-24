import { describe, it, expect } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
  type NostrEvent,
} from 'nostr-tools/pure';
// Importing these from the real published @toon-protocol/core (1.6.0) is itself
// part of the contract: if the package does not export the ui helpers, this file
// fails to compile.
import { UI_RENDERER_KIND, UI_TAG, buildUiCoordinate } from '@toon-protocol/core';
import { resolveUiCoordinate, resolveUiRenderer } from './resolveRenderer.js';
import { MIME_A2UI } from './constants.js';

const TARGET_KIND = 42;

/** Build a full `ui` coordinate string, asserting the inputs are valid. */
function coordOf(pubkey: string, targetKind: number): string {
  const coord = buildUiCoordinate({ pubkey, targetKind });
  if (coord === null) throw new Error('buildUiCoordinate returned null for valid inputs');
  return coord;
}

/** Sign an event template with the given secret key into a verifiable event. */
function sign(sk: Uint8Array, template: EventTemplate): NostrEvent {
  return finalizeEvent(template, sk);
}

/** A signed `kind:31036` A2UI renderer for `targetKind`, authored by `sk`. */
function signRenderer(sk: Uint8Array, createdAt: number, targetKind = TARGET_KIND): NostrEvent {
  return sign(sk, {
    kind: UI_RENDERER_KIND,
    created_at: createdAt,
    tags: [
      ['d', String(targetKind)],
      ['m', MIME_A2UI],
    ],
    content: '',
  });
}

/** A signed rendered event carrying a bare-target-kind `ui` tag. */
function signRendered(sk: Uint8Array, uiTagValue: string, kind = TARGET_KIND): NostrEvent {
  return sign(sk, {
    kind,
    created_at: 1_700_000_000,
    tags: [[UI_TAG, uiTagValue]],
    content: 'hello',
  });
}

describe('resolveUiCoordinate', () => {
  it('uses the EVENT AUTHOR pubkey, with a bare target-kind ui tag (toon#36)', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const event = signRendered(sk, String(TARGET_KIND));

    const coord = resolveUiCoordinate(event);
    expect(coord).toEqual({
      kind: UI_RENDERER_KIND,
      pubkey: pk, // author pubkey, NOT something off the tag
      targetKind: TARGET_KIND,
    });
  });

  it('accepts a full coordinate when its pubkey equals the event author', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const coordStr = coordOf(pk, TARGET_KIND);
    const event = signRendered(sk, coordStr);

    expect(resolveUiCoordinate(event)).toEqual({
      kind: UI_RENDERER_KIND,
      pubkey: pk,
      targetKind: TARGET_KIND,
    });
  });

  it('rejects a full coordinate naming a DIFFERENT author (no third-party renderers)', () => {
    const authorSk = generateSecretKey();
    const otherPk = getPublicKey(generateSecretKey());
    const coordStr = coordOf(otherPk, TARGET_KIND);
    const event = signRendered(authorSk, coordStr);

    expect(resolveUiCoordinate(event)).toBeNull();
  });

  it('returns null when there is no ui tag', () => {
    const sk = generateSecretKey();
    const event = sign(sk, {
      kind: TARGET_KIND,
      created_at: 1_700_000_000,
      tags: [],
      content: '',
    });
    expect(resolveUiCoordinate(event)).toBeNull();
  });
});

describe('resolveUiRenderer', () => {
  it('picks the LATEST addressable kind:31036 renderer (NIP-33 latest-wins)', () => {
    const sk = generateSecretKey();
    const event = signRendered(sk, String(TARGET_KIND));

    const older = signRenderer(sk, 1_000);
    const newer = signRenderer(sk, 2_000);

    const resolved = resolveUiRenderer(event, [older, newer]);
    expect(resolved?.id).toBe(newer.id);
    expect(resolved?.created_at).toBe(2_000);
  });

  it('matches on the event-author pubkey: a renderer from another author is ignored', () => {
    const authorSk = generateSecretKey();
    const event = signRendered(authorSk, String(TARGET_KIND));

    // Same target kind but authored by someone else → not a match.
    const foreign = signRenderer(generateSecretKey(), 2_000);
    expect(resolveUiRenderer(event, [foreign])).toBeUndefined();

    // The author's own renderer is selected even when a foreign one is newer.
    const own = signRenderer(authorSk, 1_500);
    const foreignNewer = signRenderer(generateSecretKey(), 9_999);
    expect(resolveUiRenderer(event, [foreignNewer, own])?.id).toBe(own.id);
  });

  it('ignores renderers targeting a different kind (d tag mismatch)', () => {
    const sk = generateSecretKey();
    const event = signRendered(sk, String(TARGET_KIND));
    const wrongKind = signRenderer(sk, 2_000, TARGET_KIND + 1);
    expect(resolveUiRenderer(event, [wrongKind])).toBeUndefined();
  });

  it('REJECTS a tampered renderer event (signature re-verification, toon#36)', () => {
    const sk = generateSecretKey();
    const event = signRendered(sk, String(TARGET_KIND));
    const good = signRenderer(sk, 2_000);

    // Tamper with the content after signing — id/sig no longer match. Build a
    // fresh plain object (as a wire-decoded event would be) rather than spreading
    // `good`, so the nostr-tools verified-cache symbol is not carried over.
    const tampered: NostrEvent = {
      id: good.id,
      pubkey: good.pubkey,
      created_at: good.created_at,
      kind: good.kind,
      tags: good.tags,
      content: 'malicious payload',
      sig: good.sig,
    };
    expect(resolveUiRenderer(event, [tampered])).toBeUndefined();

    // The untampered original still resolves, proving the rejection is the
    // signature check and not the filter.
    expect(resolveUiRenderer(event, [good])?.id).toBe(good.id);
  });

  it('returns undefined when no candidates are supplied', () => {
    const sk = generateSecretKey();
    const event = signRendered(sk, String(TARGET_KIND));
    expect(resolveUiRenderer(event, [])).toBeUndefined();
  });
});
