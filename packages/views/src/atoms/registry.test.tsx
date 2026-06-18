import { describe, it, expect } from 'vitest';
import { ATOMS, ATOM_IDS, defaultAtomForKind, GENERIC_ATOM_ID } from './registry.js';
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
});
