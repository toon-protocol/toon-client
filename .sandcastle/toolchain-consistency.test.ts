import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for toon-client#425: packageManager pinned a pnpm major
// that cannot open the committed lockfile's format (pnpm 8 writes
// lockfileVersion 6.x; pnpm 9 writes 9.x), so `--frozen-lockfile` was
// impossible under the pinned toolchain.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function pnpmMajorFromPackageManager(packageManager: string): number {
  const match = packageManager.match(/^pnpm@(\d+)\./);
  if (!match) {
    throw new Error(`Unrecognized packageManager field: ${packageManager}`);
  }
  return Number(match[1]);
}

function lockfileMajorFromLockfileVersion(lockfileVersion: string): number {
  return Number(lockfileVersion.split('.')[0]);
}

// pnpm major -> the lockfileVersion major it writes. Only the majors this
// repo has actually used are covered; extend if the pin moves further.
const PNPM_MAJOR_TO_LOCKFILE_MAJOR: Record<number, number> = {
  8: 6,
  9: 9,
  10: 9,
};

describe('pnpm toolchain / lockfile consistency', () => {
  it('packageManager pnpm major can open the committed lockfileVersion', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const lockfileHeader = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8').split('\n')[0];
    const lockfileVersion = lockfileHeader.match(/lockfileVersion:\s*'?([\d.]+)'?/)?.[1];
    expect(lockfileVersion, `could not parse lockfileVersion from: ${lockfileHeader}`).toBeDefined();

    const pnpmMajor = pnpmMajorFromPackageManager(pkg.packageManager);
    const expectedLockfileMajor = PNPM_MAJOR_TO_LOCKFILE_MAJOR[pnpmMajor];
    expect(expectedLockfileMajor, `no known lockfileVersion mapping for pnpm major ${pnpmMajor}`).toBeDefined();

    expect(lockfileMajorFromLockfileVersion(lockfileVersion!)).toBe(expectedLockfileMajor);
  });
});
