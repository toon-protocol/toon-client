/**
 * MIME derivation for permaweb blob uploads (#368): path extension → the
 * Content-Type the store forwards to the gateway, with an octet-stream
 * fallback and deterministic handling of blobs reached by multiple paths.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTENT_TYPE,
  contentTypeForPath,
  resolveConflictingPath,
} from './mime.js';

describe('contentTypeForPath', () => {
  it('maps common static-site extensions', () => {
    expect(contentTypeForPath('index.html')).toBe('text/html');
    expect(contentTypeForPath('assets/app.css')).toBe('text/css');
    expect(contentTypeForPath('assets/main-abc123.js')).toBe('text/javascript');
    expect(contentTypeForPath('data.json')).toBe('application/json');
    expect(contentTypeForPath('img/logo.svg')).toBe('image/svg+xml');
    expect(contentTypeForPath('img/photo.JPG')).toBe('image/jpeg'); // case-insensitive
    expect(contentTypeForPath('fonts/inter.woff2')).toBe('font/woff2');
    expect(contentTypeForPath('shiki.wasm')).toBe('application/wasm');
  });

  it('falls back to octet-stream for unknown/absent/dotfile extensions', () => {
    expect(contentTypeForPath('bin/tool')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('archive.xyz')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('.gitignore')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('README')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath(undefined)).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForPath('')).toBe(DEFAULT_CONTENT_TYPE);
  });

  it('uses the last extension of a multi-dot filename', () => {
    expect(contentTypeForPath('main.min.js')).toBe('text/javascript');
    expect(contentTypeForPath('style.abc123.css')).toBe('text/css');
  });
});

describe('resolveConflictingPath (multi-path blob → one Content-Type)', () => {
  it('returns the lexicographically-first path when all agree on a type', () => {
    // Same bytes committed as two .js names → one, deterministic, .js content.
    expect(resolveConflictingPath(['b.js', 'a.js'])).toBe('a.js');
    expect(contentTypeForPath(resolveConflictingPath(['b.js', 'a.js']) ?? '')).toBe(
      'text/javascript'
    );
  });

  it('returns undefined (→ octet-stream) when extensions disagree', () => {
    // Identical bytes reachable as .js and .txt: pick neither, serve raw.
    expect(resolveConflictingPath(['a.js', 'a.txt'])).toBeUndefined();
  });

  it('returns undefined for an empty path list', () => {
    expect(resolveConflictingPath([])).toBeUndefined();
  });

  it('treats two unknown-extension paths as agreeing (both octet-stream)', () => {
    // Both octet-stream → no conflict → a deterministic representative path.
    expect(resolveConflictingPath(['z.bin', 'a.bin'])).toBe('a.bin');
  });
});
