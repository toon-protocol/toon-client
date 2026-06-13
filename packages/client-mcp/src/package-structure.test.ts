import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Publishability guard (mirrors @toon-protocol/townhouse's package-structure
 * test). The published package must be self-contained: its `@toon-protocol/*`
 * workspace deps are BUNDLED into dist at build time (see tsup.config.ts
 * `noExternal`), so they must NOT appear as runtime dependencies — those
 * packages are not on npm and would make `npm install` fail.
 */
const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../package.json'),
    'utf8'
  )
) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  publishConfig?: { access?: string };
};

describe('package structure (publishability)', () => {
  it('declares no @toon-protocol/* RUNTIME deps (they are bundled)', () => {
    const runtime = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    const leaked = Object.keys(runtime).filter((d) =>
      d.startsWith('@toon-protocol/')
    );
    expect(
      leaked,
      `bundle these instead of depending on them: ${leaked.join(', ')}`
    ).toEqual([]);
  });

  it('keeps the workspace deps as devDependencies (build-time only)', () => {
    const dev = pkg.devDependencies ?? {};
    expect(dev['@toon-protocol/client']).toBeDefined();
    expect(dev['@toon-protocol/core']).toBeDefined();
  });

  it('ships both bins and publishes publicly', () => {
    expect(pkg.bin?.['toon-clientd']).toBe('./dist/daemon.js');
    expect(pkg.bin?.['toon-mcp']).toBe('./dist/mcp.js');
    expect(pkg.publishConfig?.access).toBe('public');
  });
});
