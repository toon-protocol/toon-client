/**
 * Arweave path manifest builder (#368) — the rig mirror of rig-web's
 * deploy-manifest. Keeps the original format contract AND covers the added
 * SPA `fallback` field.
 */

import { describe, it, expect } from 'vitest';
import { buildArweaveManifest, type ManifestEntry } from './arweave-manifest.js';

const INDEX_TX = 'B'.repeat(43);
const JS_TX = 'C'.repeat(43);
const CSS_TX = 'D'.repeat(43);

const TYPICAL_ENTRIES: ManifestEntry[] = [
  { path: 'index.html', txId: INDEX_TX },
  { path: 'assets/main-abc123.js', txId: JS_TX },
  { path: 'assets/style-def456.css', txId: CSS_TX },
];

describe('buildArweaveManifest - format contract (mirrors rig-web)', () => {
  it('[P0] required top-level fields', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    expect(m.manifest).toBe('arweave/paths');
    expect(m.version).toBe('0.2.0');
    expect(m.index?.path).toBe('index.html');
  });

  it('[P0] maps every entry path to { id: txId }', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    expect(m.paths['index.html']).toEqual({ id: INDEX_TX });
    expect(m.paths['assets/main-abc123.js']).toEqual({ id: JS_TX });
    expect(m.paths['assets/style-def456.css']).toEqual({ id: CSS_TX });
    expect(Object.keys(m.paths).length).toBe(TYPICAL_ENTRIES.length);
  });

  it('[P0] accepts a custom index path', () => {
    const entries: ManifestEntry[] = [
      ...TYPICAL_ENTRIES,
      { path: 'app.html', txId: 'E'.repeat(43) },
    ];
    const m = buildArweaveManifest(entries, 'app.html');
    expect(m.index?.path).toBe('app.html');
  });

  it('[P1] empty entries → empty paths', () => {
    expect(buildArweaveManifest([]).paths).toEqual({});
  });

  it('[P2] last entry wins for duplicate paths', () => {
    const m = buildArweaveManifest([
      { path: 'index.html', txId: 'A'.repeat(43) },
      { path: 'index.html', txId: INDEX_TX },
    ]);
    expect(m.paths['index.html']).toEqual({ id: INDEX_TX });
  });
});

describe('buildArweaveManifest - dangling index (#398)', () => {
  it('omits index when the index path is not in the entries', () => {
    const m = buildArweaveManifest([
      { path: 'README.md', txId: 'A'.repeat(43) },
    ]);
    expect(m.index).toBeUndefined();
  });

  it('omits index for a custom --index path that is not in the entries', () => {
    const m = buildArweaveManifest(
      [{ path: 'README.md', txId: 'A'.repeat(43) }],
      'app.html'
    );
    expect(m.index).toBeUndefined();
  });

  it('empty entries omit index', () => {
    expect(buildArweaveManifest([]).index).toBeUndefined();
  });

  it('sets index when the path IS present', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES);
    expect(m.index).toEqual({ path: 'index.html' });
  });

  it('omits index for an --index value matching an Object.prototype member name', () => {
    const m = buildArweaveManifest(
      [{ path: 'README.md', txId: 'A'.repeat(43) }],
      'constructor'
    );
    expect(m.index).toBeUndefined();
  });
});

describe('buildArweaveManifest - SPA fallback (#368 addition)', () => {
  it('omits fallback by default', () => {
    expect(buildArweaveManifest(TYPICAL_ENTRIES).fallback).toBeUndefined();
  });

  it('sets fallback to { id } when a fallback txid is given', () => {
    const m = buildArweaveManifest(TYPICAL_ENTRIES, 'index.html', INDEX_TX);
    expect(m.fallback).toEqual({ id: INDEX_TX });
  });
});
