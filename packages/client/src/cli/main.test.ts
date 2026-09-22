import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEntryPoint } from './main.js';

/**
 * A directory the entry-point tests can hang real files and real symlinks off.
 * The bug in #640 only exists on a filesystem — no amount of string fixtures
 * reproduces it, because the two paths differ *only* by a link.
 */
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'toon-entry-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isEntryPoint', () => {
  it('recognises the module invoked by its own real path', () => {
    const real = join(dir, 'own-path.js');
    writeFileSync(real, '');
    expect(isEntryPoint(pathToFileURL(real).href, real)).toBe(true);
  });

  it('recognises the module invoked through a symlink — how npm installs the bin', () => {
    const real = join(dir, 'linked.js');
    const link = join(dir, 'toon');
    writeFileSync(real, '');
    symlinkSync(real, link);
    expect(isEntryPoint(pathToFileURL(real).href, link)).toBe(true);
  });

  it('does not claim a different file that happens to be the entry', () => {
    const real = join(dir, 'me.js');
    const other = join(dir, 'someone-else.js');
    writeFileSync(real, '');
    writeFileSync(other, '');
    expect(isEntryPoint(pathToFileURL(real).href, other)).toBe(false);
  });

  it('is false when nothing was invoked at all', () => {
    const real = join(dir, 'no-argv.js');
    writeFileSync(real, '');
    expect(isEntryPoint(pathToFileURL(real).href, undefined)).toBe(false);
  });

  it('answers rather than throwing when the entry does not exist', () => {
    const real = join(dir, 'present.js');
    writeFileSync(real, '');
    expect(isEntryPoint(pathToFileURL(real).href, join(dir, 'gone.js'))).toBe(false);
  });
});
