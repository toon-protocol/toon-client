/**
 * Repo-local `rig` configuration, persisted as git config keys (the
 * `rig init`-lite behavior: written after the first successful push):
 *
 *   toon.repoid   NIP-34 repository identifier (`d` tag)
 *   toon.owner    repository owner's Nostr pubkey (hex) — the identity that
 *                 signs kind:30617/30618 (`a`-tag `30617:<owner>:<repoId>`)
 *   toon.relay    relay URL(s), multi-valued
 *
 * All access goes through `execFile git config` with argument arrays (same
 * injection posture as GitRepoReader — never a shell).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The rig-relevant git config keys of one repository. */
export interface ToonRepoConfig {
  repoId?: string;
  owner?: string;
  relays: string[];
}

async function git(
  repoPath: string,
  args: string[],
  allowExitCodes: number[] = []
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof e.code === 'number' ? e.code : undefined;
    if (exitCode !== undefined && allowExitCodes.includes(exitCode)) {
      return { stdout: e.stdout ?? '', exitCode };
    }
    throw new Error(
      `git ${args.join(' ')} failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}: ` +
        `${(e.stderr ?? e.message ?? '').trim()}`
    );
  }
}

/**
 * Resolve the repository worktree root for `cwd` via
 * `git rev-parse --show-toplevel`. Throws a clear error when `cwd` is not
 * inside a git repository.
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf-8' }
    );
    const root = stdout.trim();
    if (!root) throw new Error('empty rev-parse output');
    return root;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `not a git repository (run rig inside a repo): ${(e.stderr ?? e.message ?? '').trim()}`
    );
  }
}

/** Read the `toon.*` git config keys of the repository at `repoPath`. */
export async function readToonConfig(repoPath: string): Promise<ToonRepoConfig> {
  // exit 1 = key unset (git config --get convention) — tolerated everywhere.
  const [repoId, owner, relays] = await Promise.all([
    git(repoPath, ['config', '--get', 'toon.repoid'], [1]),
    git(repoPath, ['config', '--get', 'toon.owner'], [1]),
    git(repoPath, ['config', '--get-all', 'toon.relay'], [1]),
  ]);
  const config: ToonRepoConfig = {
    relays: relays.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  };
  const id = repoId.stdout.trim();
  if (repoId.exitCode === 0 && id) config.repoId = id;
  const own = owner.stdout.trim();
  if (owner.exitCode === 0 && own) config.owner = own;
  return config;
}

/**
 * Persist the `toon.*` keys (repo-local config). Only supplied fields are
 * written; `relays` replaces the whole multi-valued list.
 */
export async function writeToonConfig(
  repoPath: string,
  config: { repoId?: string; owner?: string; relays?: string[] }
): Promise<void> {
  if (config.repoId !== undefined) {
    await git(repoPath, ['config', 'toon.repoid', config.repoId]);
  }
  if (config.owner !== undefined) {
    await git(repoPath, ['config', 'toon.owner', config.owner]);
  }
  if (config.relays !== undefined && config.relays.length > 0) {
    // Replace the whole list: unset-all (exit 5 = key did not exist) + re-add.
    await git(repoPath, ['config', '--unset-all', 'toon.relay'], [5]);
    for (const relay of config.relays) {
      await git(repoPath, ['config', '--add', 'toon.relay', relay]);
    }
  }
}
