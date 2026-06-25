import { describe, it, expect } from 'vitest';
import {
  ATOMS,
  ATOM_IDS,
  buildKindRegistry,
  defaultAtomForKind,
  GENERIC_ATOM_ID,
} from './registry.js';
import { ATOM_CATALOG, CATALOG_ATOM_IDS } from '../catalog.js';

describe('atom registry / catalog sync', () => {
  it('registry ids exactly match the catalog (no drift)', () => {
    expect([...ATOM_IDS].sort()).toEqual([...CATALOG_ATOM_IDS].sort());
  });

  it('every catalog atom has a component', () => {
    for (const meta of ATOM_CATALOG) {
      expect(ATOMS.get(meta.id), `missing component for ${meta.id}`).toBeDefined();
    }
  });

  it('maps each catalog kind to a default atom', () => {
    for (const meta of ATOM_CATALOG) {
      for (const kind of meta.kinds ?? []) {
        // first-registered atom wins; just assert a real (non-fallback) atom resolves
        expect(defaultAtomForKind(kind).id).not.toBe(GENERIC_ATOM_ID);
      }
    }
  });

  it('falls back to generic for unknown kinds', () => {
    expect(defaultAtomForKind(999999).id).toBe(GENERIC_ATOM_ID);
  });

  it('registers the content primitives + client-status (kind-less, non-event)', () => {
    for (const id of ['heading', 'text', 'stat', 'key-value', 'badge', 'client-status']) {
      expect(ATOM_IDS.has(id), `missing atom ${id}`).toBe(true);
      // they declare no kinds, so they must never claim a default-kind slot
      expect(ATOMS.get(id)?.kinds).toBeUndefined();
    }
  });
});

describe('buildKindRegistry (branch-1 native registry for the render gradient)', () => {
  it('registers every catalog kind under its default atom', () => {
    const registry = buildKindRegistry();
    for (const meta of ATOM_CATALOG) {
      for (const kind of meta.kinds ?? []) {
        expect(registry.has(kind), `kind ${kind} should be registered`).toBe(true);
        // Same atom resolves here as via the kind-default map (no drift).
        expect(registry.lookup(kind)?.id).toBe(defaultAtomForKind(kind).id);
      }
    }
  });

  it('maps specific well-known kinds to the right atom', () => {
    const registry = buildKindRegistry();
    expect(registry.lookup(1)?.id).toBe('note-card');
    expect(registry.lookup(0)?.id).toBe('profile-header');
    expect(registry.lookup(7)?.id).toBe('reaction-bar');
    expect(registry.lookup(30617)?.id).toBe('repo-card');
    expect(registry.lookup(1621)?.id).toBe('issue-card');
    expect(registry.lookup(1617)?.id).toBe('pr-card');
    expect(registry.lookup(1622)?.id).toBe('comment-thread');
    // media-embed declares several kinds.
    for (const kind of [20, 21, 22, 1063]) {
      expect(registry.lookup(kind)?.id).toBe('media-embed');
    }
  });

  it('does NOT register the generic fallback — unknown kinds must miss', () => {
    const registry = buildKindRegistry();
    expect(registry.has(999999)).toBe(false);
    expect(registry.lookup(999999)).toBeUndefined();
    // The generic-event atom has no kinds, so it never claims a kind.
    for (const id of [...registry.kinds()].map((k) => registry.lookup(k)?.id)) {
      expect(id).not.toBe(GENERIC_ATOM_ID);
    }
  });
});
