import { describe, it, expect } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  verifyRendererTrust,
  isTrustDowngrade,
  RendererPinStore,
} from './swap-defense.js';
import { guardedRenderDispatch } from './dispatch.js';
import { KindRegistry } from './KindRegistry.js';
import { MIME_A2UI, MIME_MCP_APP, UI_RENDERER_KIND, UI_TAG } from './constants.js';
// `selectLatestAddressable` now lives in `@toon-protocol/core@1.6.0` (#97 dropped
// the local mirror).
import { selectLatestAddressable } from '@toon-protocol/core';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A stand-in native component type — the registry is generic over it. */
interface FakeComponent {
  name: string;
}

const authorSk = generateSecretKey();
const authorPk = getPublicKey(authorSk);

const attackerSk = generateSecretKey();
const attackerPk = getPublicKey(attackerSk);

/** Build + sign a `kind:31036` renderer for `targetKind` with the given mime. */
function signRenderer(opts: {
  sk?: Uint8Array;
  mime?: string;
  targetKind?: number;
  createdAt?: number;
}): NostrEvent {
  const {
    sk = authorSk,
    mime = MIME_A2UI,
    targetKind = 42,
    createdAt = 1_700_000_000,
  } = opts;
  const tags: string[][] = [['d', String(targetKind)]];
  if (mime !== undefined) tags.push(['m', mime]);
  return finalizeEvent(
    { kind: UI_RENDERER_KIND, created_at: createdAt, tags, content: '' },
    sk
  );
}

/**
 * Re-wrap an event into a *fresh* plain object carrying only the wire fields.
 *
 * nostr-tools' `verifyEvent` memoises its result on the event object via a
 * non-enumerable Symbol; a spread (`{ ...ev }`) copies that cached flag, so a
 * post-verification mutation would wrongly read as "valid". Events arriving from
 * a relay never carry that Symbol (it is not serialisable), so this models a true
 * wire-delivered (potentially tampered) event.
 */
function rewire(
  ev: NostrEvent,
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
    ...overrides,
  };
}

/** A (signed) event that points at a renderer coordinate via its `ui` tag. */
function signEvent(opts: {
  sk?: Uint8Array;
  pubkey?: string;
  kind?: number;
  coordAuthor?: string;
  targetKind?: number;
}): NostrEvent {
  const {
    sk = authorSk,
    kind = 42,
    coordAuthor = authorPk,
    targetKind = 42,
  } = opts;
  const tags = [[UI_TAG, `${UI_RENDERER_KIND}:${coordAuthor}:${targetKind}`]];
  return finalizeEvent(
    { kind, created_at: 1_700_000_500, tags, content: 'hi' },
    sk
  );
}

const baseInput = () => ({
  registry: new KindRegistry<FakeComponent>(),
  pins: new RendererPinStore(),
});

// ── author binding (closes V1: cross-author substitution) ──────────────────────

describe('verifyRendererTrust — author binding', () => {
  it('rejects a renderer authored by someone other than the event author', () => {
    const event = signEvent({}); // coordinate author = authorPk
    // Attacker publishes a renderer for the same target kind under THEIR key.
    const attackerRenderer = signRenderer({ sk: attackerSk });
    const out = verifyRendererTrust({
      event,
      candidates: [attackerRenderer],
      ...baseInput(),
    });
    expect(out.ok).toBe(false);
    // The attacker's renderer doesn't match the (author-bound) coordinate at all.
    if (!out.ok) expect(out.reason).toBe('no-renderer');
  });

  it('rejects a ui coordinate that names a third-party author', () => {
    // Event author is authorPk, but its ui coordinate points at the attacker.
    const event = signEvent({ coordAuthor: attackerPk });
    const renderer = signRenderer({ sk: attackerSk });
    const out = verifyRendererTrust({
      event,
      candidates: [renderer],
      ...baseInput(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('coordinate-author-mismatch');
  });

  it('approves a correctly author-bound renderer', () => {
    const event = signEvent({});
    const renderer = signRenderer({});
    const out = verifyRendererTrust({
      event,
      candidates: [renderer],
      ...baseInput(),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.renderer.id).toBe(renderer.id);
      expect(out.pinned).toBe(true);
    }
  });
});

// ── signature verification (closes V2: forged / tampered renderer) ─────────────

describe('verifyRendererTrust — signature verification', () => {
  it('rejects a renderer whose signature does not verify (tampered content)', () => {
    const event = signEvent({});
    const renderer = signRenderer({});
    // Tamper after signing: same id/pubkey, mutated content → sig no longer valid.
    const tampered = rewire(renderer, { content: 'evil-html' });
    expect(verifyEvent(tampered)).toBe(false); // sanity: really invalid
    const out = verifyRendererTrust({
      event,
      candidates: [tampered],
      ...baseInput(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad-signature');
  });

  it('rejects an unsigned renderer (empty sig)', () => {
    const event = signEvent({});
    const renderer = signRenderer({});
    const unsigned = rewire(renderer, { sig: '0'.repeat(128) });
    const out = verifyRendererTrust({
      event,
      candidates: [unsigned],
      ...baseInput(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad-signature');
  });

  it('fails closed if the verifier throws', () => {
    const event = signEvent({});
    const renderer = signRenderer({});
    const out = verifyRendererTrust({
      event,
      candidates: [renderer],
      ...baseInput(),
      verify: () => {
        throw new Error('boom');
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad-signature');
  });
});

// ── deterministic selection (closes V3: resolution race) ───────────────────────

describe('verifyRendererTrust — deterministic selection', () => {
  it('selects the latest created_at regardless of candidate order', () => {
    const event = signEvent({});
    const older = signRenderer({ createdAt: 1_700_000_000 });
    const newer = signRenderer({ createdAt: 1_700_000_900 });

    const a = verifyRendererTrust({
      event,
      candidates: [older, newer],
      ...baseInput(),
    });
    const b = verifyRendererTrust({
      event,
      candidates: [newer, older],
      ...baseInput(),
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.renderer.id).toBe(newer.id);
      expect(b.renderer.id).toBe(newer.id); // order-independent
    }
  });

  it('breaks created_at ties by lowest id (NIP-01), order-independent', () => {
    const event = signEvent({});
    // Two renderers at the SAME created_at → different ids (different sig nonce
    // is not enough; vary content commitment is in the id). Use distinct mimes
    // to force different ids while keeping both author-bound + valid.
    const r1 = signRenderer({ createdAt: 1_700_000_000, mime: MIME_A2UI });
    const r2 = signRenderer({ createdAt: 1_700_000_000, mime: MIME_MCP_APP });
    const expected = [r1, r2].sort((x, y) => (x.id < y.id ? -1 : 1))[0];

    const a = selectLatestAddressable([r1, r2]);
    const b = selectLatestAddressable([r2, r1]);
    expect(a?.id).toBe(expected.id);
    expect(b?.id).toBe(expected.id);

    const out = verifyRendererTrust({
      event,
      candidates: [r2, r1],
      ...baseInput(),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.renderer.id).toBe(expected.id);
  });

  it('ignores foreign-author and wrong-target candidates when selecting', () => {
    const event = signEvent({ targetKind: 42 });
    const good = signRenderer({ targetKind: 42, createdAt: 1_700_000_100 });
    // Newer, but authored by attacker → must NOT be selected.
    const attackerNewer = signRenderer({
      sk: attackerSk,
      createdAt: 1_700_009_999,
    });
    // Newer, but wrong target kind → must NOT be selected.
    const wrongTarget = signRenderer({
      targetKind: 99,
      createdAt: 1_700_009_999,
    });
    const out = verifyRendererTrust({
      event,
      candidates: [attackerNewer, wrongTarget, good],
      ...baseInput(),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.renderer.id).toBe(good.id);
  });
});

// ── anti-swap pinning + downgrade detection (closes V4: silent swap) ───────────

describe('verifyRendererTrust — anti-swap pinning', () => {
  it('keeps the same decision when the pinned id is re-seen (stable)', () => {
    const event = signEvent({});
    const renderer = signRenderer({});
    const { registry, pins } = baseInput();
    const first = verifyRendererTrust({
      event,
      candidates: [renderer],
      registry,
      pins,
    });
    const second = verifyRendererTrust({
      event,
      candidates: [renderer],
      registry,
      pins,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.pinned).toBe(true);
      expect(second.pinned).toBe(false);
      expect(second.renderer.id).toBe(renderer.id);
    }
  });

  it('REFUSES a trust-downgrading swap (medium → low) — fails closed', () => {
    const event = signEvent({});
    const { registry, pins } = baseInput();
    // First resolution pins a medium-trust A2UI renderer.
    const medium = signRenderer({ mime: MIME_A2UI, createdAt: 1_700_000_000 });
    const first = verifyRendererTrust({
      event,
      candidates: [medium],
      registry,
      pins,
    });
    expect(first.ok).toBe(true);

    // Attacker publishes a NEWER low-trust (sandboxed) renderer for the same coord.
    const lowNewer = signRenderer({
      mime: MIME_MCP_APP,
      createdAt: 1_700_009_999,
    });
    const second = verifyRendererTrust({
      event,
      candidates: [lowNewer],
      registry,
      pins,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('trust-downgrade');
    // The pin is unchanged after a refused downgrade.
    const third = verifyRendererTrust({
      event,
      candidates: [medium],
      registry,
      pins,
    });
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.renderer.id).toBe(medium.id);
  });

  it('allows a non-downgrading swap but flags swapObserved', () => {
    const event = signEvent({});
    const { registry, pins } = baseInput();
    const a = signRenderer({ mime: MIME_MCP_APP, createdAt: 1_700_000_000 }); // low
    verifyRendererTrust({ event, candidates: [a], registry, pins });
    // Newer renderer, same low trust → allowed, re-pinned, flagged.
    const b = signRenderer({ mime: MIME_MCP_APP, createdAt: 1_700_009_999 });
    const out = verifyRendererTrust({ event, candidates: [b], registry, pins });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.renderer.id).toBe(b.id);
      expect(out.swapObserved).toBe(true);
    }
  });

  it('REFUSES any id change for a high-trust (branch-1 known) kind', () => {
    // Register kind 42 natively → it is a high-trust kind.
    const registry = new KindRegistry<FakeComponent>().register(42, {
      name: 'NoteCard',
    });
    const pins = new RendererPinStore();
    const event = signEvent({ kind: 42, targetKind: 42 });
    const v1 = signRenderer({ targetKind: 42, createdAt: 1_700_000_000 });
    const first = verifyRendererTrust({
      event,
      candidates: [v1],
      registry,
      pins,
    });
    expect(first.ok).toBe(true);

    // A newer revision of the SAME author/coord (not even a downgrade) → refused.
    const v2 = signRenderer({ targetKind: 42, createdAt: 1_700_009_999 });
    const second = verifyRendererTrust({
      event,
      candidates: [v2],
      registry,
      pins,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('high-trust-id-changed');
  });

  it('honours a host-seeded pin (config allowlist by event id)', () => {
    const event = signEvent({});
    const renderer = signRenderer({ mime: MIME_A2UI });
    const registry = new KindRegistry<FakeComponent>();
    const pins = new RendererPinStore();
    // Host seeds the EXPECTED id; a different resolved id is a swap.
    pins.pin(
      { kind: UI_RENDERER_KIND, pubkey: authorPk, targetKind: 42 },
      { id: 'a'.repeat(64), trust: 'full' }
    );
    const out = verifyRendererTrust({
      event,
      candidates: [renderer],
      registry,
      pins,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('trust-downgrade'); // full → medium
  });
});

describe('isTrustDowngrade', () => {
  it('ranks full > medium > low', () => {
    expect(isTrustDowngrade('full', 'medium')).toBe(true);
    expect(isTrustDowngrade('medium', 'low')).toBe(true);
    expect(isTrustDowngrade('full', 'low')).toBe(true);
    expect(isTrustDowngrade('low', 'medium')).toBe(false);
    expect(isTrustDowngrade('medium', 'medium')).toBe(false);
  });
});

// ── guardedRenderDispatch — the fail-closed wiring around dispatch ──────────────

describe('guardedRenderDispatch', () => {
  it('unknown kind + approved A2UI renderer → branch 2', () => {
    const event = signEvent({ kind: 42 });
    const renderer = signRenderer({ mime: MIME_A2UI });
    const registry = new KindRegistry<FakeComponent>();
    const { decision, guard } = guardedRenderDispatch(
      { event, candidates: [renderer] },
      registry,
      new RendererPinStore()
    );
    expect(decision.branch).toBe('a2ui');
    expect(guard).toBeUndefined();
    if (decision.branch === 'a2ui')
      expect(decision.renderer.id).toBe(renderer.id);
  });

  it('unknown kind + wrong-author renderer → fails closed to generative', () => {
    const event = signEvent({ kind: 42 });
    const attackerRenderer = signRenderer({ sk: attackerSk });
    const { decision, guard } = guardedRenderDispatch(
      { event, candidates: [attackerRenderer] },
      new KindRegistry<FakeComponent>(),
      new RendererPinStore()
    );
    expect(decision.branch).toBe('generative'); // safe fallback, NOT a2ui
    expect(guard?.rejected.reason).toBe('no-renderer');
  });

  it('unknown kind + tampered renderer → fails closed to generative', () => {
    const event = signEvent({ kind: 42 });
    const renderer = signRenderer({});
    const tampered = rewire(renderer, { content: 'evil' });
    const { decision, guard } = guardedRenderDispatch(
      { event, candidates: [tampered] },
      new KindRegistry<FakeComponent>(),
      new RendererPinStore()
    );
    expect(decision.branch).toBe('generative');
    expect(guard?.rejected.reason).toBe('bad-signature');
  });

  it('high-trust kind + swapped renderer → falls back to native (branch 1)', () => {
    const registry = new KindRegistry<FakeComponent>().register(42, {
      name: 'NoteCard',
    });
    const pins = new RendererPinStore();
    const event = signEvent({ kind: 42, targetKind: 42 });
    const v1 = signRenderer({ targetKind: 42, createdAt: 1_700_000_000 });
    guardedRenderDispatch({ event, candidates: [v1] }, registry, pins);

    const v2 = signRenderer({ targetKind: 42, createdAt: 1_700_009_999 });
    const { decision, guard } = guardedRenderDispatch(
      { event, candidates: [v2] },
      registry,
      pins
    );
    expect(decision.branch).toBe('native'); // safe: the known native component
    expect(guard?.rejected.reason).toBe('high-trust-id-changed');
  });

  it('unknown kind + no candidates → generative, no guard info', () => {
    const event = signEvent({ kind: 42 });
    const { decision, guard } = guardedRenderDispatch(
      { event },
      new KindRegistry<FakeComponent>(),
      new RendererPinStore()
    );
    expect(decision.branch).toBe('generative');
    expect(guard).toBeUndefined();
  });
});
