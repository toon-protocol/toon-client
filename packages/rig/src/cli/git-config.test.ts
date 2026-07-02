/**
 * `toon.*` git-config persistence tests against a real fixture repository.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readToonConfig,
  resolveRepoRoot,
  writeToonConfig,
} from './git-config.js';

let repoDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-rig-config-'));
  git(['init', '--initial-branch=main'], repoDir);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('resolveRepoRoot', () => {
  it('resolves the worktree root from a nested cwd', async () => {
    const nested = join(repoDir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    // Realpath both sides: on macOS/tmpfs the repo dir may be a symlink.
    const root = await resolveRepoRoot(nested);
    expect(git(['rev-parse', '--show-toplevel'], nested)).toBe(root);
  });

  it('throws a clear error outside a repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'toon-rig-notrepo-'));
    try {
      await expect(resolveRepoRoot(outside)).rejects.toThrow(
        /not a git repository/
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('read/write toon config', () => {
  it('reads empty config as undefined fields + empty relay list', async () => {
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBeUndefined();
    expect(config.owner).toBeUndefined();
    expect(config.relays).toEqual([]);
  });

  it('round-trips repoId, owner, and a multi-valued relay list', async () => {
    await writeToonConfig(repoDir, {
      repoId: 'demo-repo',
      owner: 'ab'.repeat(32),
      relays: ['wss://relay-one.example', 'wss://relay-two.example'],
    });
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('demo-repo');
    expect(config.owner).toBe('ab'.repeat(32));
    expect(config.relays).toEqual([
      'wss://relay-one.example',
      'wss://relay-two.example',
    ]);
  });

  it('replaces the relay list wholesale on rewrite', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://only.example'] });
    const config = await readToonConfig(repoDir);
    expect(config.relays).toEqual(['wss://only.example']);
    // Other keys untouched.
    expect(config.repoId).toBe('demo-repo');
  });

  it('leaves omitted fields alone', async () => {
    await writeToonConfig(repoDir, { repoId: 'renamed' });
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('renamed');
    expect(config.owner).toBe('ab'.repeat(32));
    expect(config.relays).toEqual(['wss://only.example']);
  });

  it('stores the keys under the file-visible toon.* section', () => {
    const raw = git(['config', '--get', 'toon.repoid'], repoDir);
    expect(raw).toBe('renamed');
  });
});
