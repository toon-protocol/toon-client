import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The no-op merge guard (toon-client#706): fails a PR whose merge result changes zero files,
// passes one with a real diff. Builds the refs/pull/N/merge shape: base first parent, head second.
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../.github/scripts/no-op-merge-guard.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function runGuard(headChangesFile: boolean, baseAlreadyHasIt: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'noop-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), '1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-qb', 'head');
  writeFileSync(join(dir, 'a.txt'), '2\n');
  git(dir, 'commit', '-qam', 'change');
  // Without a change of its own, the branch still has commits: a change and its revert.
  if (!headChangesFile) git(dir, 'revert', '--no-edit', 'HEAD');
  const headSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  if (baseAlreadyHasIt) {
    writeFileSync(join(dir, 'a.txt'), '2\n');
    git(dir, 'commit', '-qam', 'same change landed elsewhere');
  }
  git(dir, 'checkout', '-q', '--detach', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', headSha);
  return spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      PR_HEAD_SHA: headSha,
      PR_BASE_REF: 'main',
      PR_NUMBER: '1',
      PR_CHANGED_FILES: headChangesFile ? '1' : '0',
    },
  });
}

describe('no-op merge guard', () => {
  it('passes a PR with a real diff', () => {
    const r = runGuard(true, false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('changes 1 file(s)');
  });

  it('fails a PR whose content already landed on the base', () => {
    const r = runGuard(true, true);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('EMPTY commit');
    expect(r.stdout).toContain('already on main');
  });

  it("fails a PR whose branch's own commits cancel out", () => {
    const r = runGuard(false, false);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('commits cancel out');
  });

  it('passes plainly on push', () => {
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'push' } });
    expect(r.status).toBe(0);
  });
});
