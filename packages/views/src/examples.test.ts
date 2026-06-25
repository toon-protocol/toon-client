import { describe, it, expect } from 'vitest';
import { EXAMPLE_VIEWSPECS } from './examples.js';
import { validateViewSpec } from './spec.js';
import { CATALOG_ATOM_IDS } from './catalog.js';
import { WRITE_TOOLS } from './tool-names.js';

describe('example ViewSpecs', () => {
  it('every example validates against the atom + tool allowlists', () => {
    for (const ex of EXAMPLE_VIEWSPECS) {
      const res = validateViewSpec(ex.spec, {
        allowedAtoms: CATALOG_ATOM_IDS,
        allowedTools: WRITE_TOOLS,
      });
      expect(res.ok, res.ok ? '' : `${ex.name}: ${res.errors.join(', ')}`).toBe(true);
    }
  });

  it('covers the headline journeys', () => {
    expect(EXAMPLE_VIEWSPECS.map((e) => e.name)).toEqual(
      expect.arrayContaining(['feed', 'profile', 'thread', 'forge', 'media', 'swap'])
    );
  });

  it('includes the non-event render examples (status dashboard + generic info)', () => {
    const names = EXAMPLE_VIEWSPECS.map((e) => e.name);
    expect(names).toContain('client-status');
    expect(names).toContain('info');
  });
});
