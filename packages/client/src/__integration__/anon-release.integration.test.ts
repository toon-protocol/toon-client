/**
 * The real pinned `anon` release, downloaded, verified and extracted in process
 * by the CLI's own bootstrap, then run (#745).
 *
 * The unit tier proves the extractor against zips built in the test; this proves
 * it against the archive the CLI actually fetches. It downloads ~15 MB from
 * GitHub, so it is opt-in:
 *
 * ```bash
 * ANON_RELEASE=1 npx vitest run --config vitest.integration.config.ts \
 *   src/__integration__/anon-release.integration.test.ts
 * ```
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANON_VERSION, ensureAnonBinary } from '../cli/anon-daemon.js';

describe.skipIf(process.env['ANON_RELEASE'] !== '1')('the pinned anon release', () => {
  it('extracts to an anon binary that runs', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-release-'));
    try {
      const anonPath = await ensureAnonBinary(cacheDir);
      expect(fs.readdirSync(cacheDir).some((f) => f.endsWith('.zip'))).toBe(false);

      const run = spawnSync(anonPath, ['--version'], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`Anon version ${ANON_VERSION.slice(1)}`);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
