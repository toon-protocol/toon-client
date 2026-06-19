// Structural guard: Arweave path manifest generation
// Ensures the deploy manifest format contract is upheld across refactors.

import { describe, it, expect } from 'vitest';
import { buildArweaveManifest } from './deploy-manifest.js';
import type { ManifestEntry } from './deploy-manifest.js';

const SAMPLE_TX = 'A'.repeat(43); // valid 43-char base64url stub
const INDEX_TX = 'B'.repeat(43);
const JS_TX = 'C'.repeat(43);
const CSS_TX = 'D'.repeat(43);

const TYPICAL_ENTRIES: ManifestEntry[] = [
  { path: 'index.html', txId: INDEX_TX },
  { path: 'assets/main-abc123.js', txId: JS_TX },
  { path: 'assets/style-def456.css', txId: CSS_TX },
];

describe('buildArweaveManifest - required top-level fields', () => {
  it('[P0] sets manifest type to "arweave/paths"', () => {
    const m = buildArweaveManifest([{ path: 'index.html', txId: SAMPLE_TX }]);
    expect(m.manifest).toBe('arweave/paths');
  });

  it('[P0] sets version to "0.2.0"', () => {
    const m = buildArweaveManifest([{ path: 'index.html', txId: SAMPLE_TX }]);
    expect(m.version).toBe('0.2.0');
  });

  it('[P0] includes index and paths properties', () => {
    const m = buildArweaveManifest([{ path: 'index.html', txId: SAMPLE_TX }]);
    expect(m).toHaveProperty('index');
    expect(m).toHaveProperty('paths');
  });
});

describe('buildArweaveManifest - index path', () => {
  it('[P0] defaults index path to "index.html"', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    expect(m.index.path).toBe('index.html');
  });

  it('[P0] accepts a custom index path', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES, 'app.html');
    expect(m.index.path).toBe('app.html');
  });
});

describe('buildArweaveManifest - paths map', () => {
  it('[P0] maps every entry path to its txId', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    expect(m.paths['index.html']).toEqual({ id: INDEX_TX });
    expect(m.paths['assets/main-abc123.js']).toEqual({ id: JS_TX });
    expect(m.paths['assets/style-def456.css']).toEqual({ id: CSS_TX });
  });

  it('[P0] path count matches entry count', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    expect(Object.keys(m.paths).length).toBe(TYPICAL_ENTRIES.length);
  });

  it('[P1] produces empty paths for empty entry list', () => {
    const m = buildArweaveManifest([]);
    expect(m.paths).toEqual({});
  });

  it('[P1] each path value has only the "id" field', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    for (const value of Object.values(m.paths)) {
      expect(Object.keys(value)).toEqual(['id']);
    }
  });

  it('[P2] last entry wins for duplicate paths', () => {
    const entries: ManifestEntry[] = [
      { path: 'index.html', txId: 'A'.repeat(43) },
      { path: 'index.html', txId: 'B'.repeat(43) },
    ];
    const m = buildArweaveManifest(entries);
    expect(m.paths['index.html']).toEqual({ id: 'B'.repeat(43) });
  });
});
