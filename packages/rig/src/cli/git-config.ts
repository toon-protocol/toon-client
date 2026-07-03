/**
 * Repo-local `rig` configuration, persisted in git's own storage:
 *
 *   toon.repoid   NIP-34 repository identifier (`d` tag)
 *   toon.owner    repository owner's Nostr pubkey (hex) — the identity that
 *                 signs kind:30617/30618 (`a`-tag `30617:<owner>:<repoId>`)
 *   toon.relay    relay URL(s), multi-valued — DEPRECATED since #249 (relays
 *                 live in real git remotes now; the key stays readable as a
 *                 fallback and is removed in v0.3)
 *
 * plus the REAL git remotes (`remote.<name>.url`) that #249 maps relays onto:
 * `rig remote add origin <relay-url>` is `git remote add`, so `git remote -v`
 * shows rig's relays and plain git tooling round-trips them.
 *
 * All access goes through `execFile git` with argument arrays (same
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

/**
 * `git init` in `dir` — create a fresh repository there (never a shell). Runs
 * ONLY in `dir` itself, never a parent, and is idempotent (git init on an
 * existing repo is a no-op). Used by `rig init` when it offers to create the
 * repo for the user (consent-gated), mirroring how it offers to mint an
 * identity on a cold start.
 */
export async function initGitRepository(dir: string): Promise<void> {
  await git(dir, ['init']);
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

/** One configured git remote: its name + (possibly multiple) fetch URLs. */
export interface GitRemoteInfo {
  name: string;
  urls: string[];
}

/**
 * URLs of the git remote `name` (`remote.<name>.url`, multi-valued when
 * `git remote set-url --add` was used). `[]` when the remote does not exist.
 */
export async function getGitRemoteUrls(
  repoPath: string,
  name: string
): Promise<string[]> {
  // exit 1 = key unset / invalid key — either way, no such remote.
  const { stdout } = await git(
    repoPath,
    ['config', '--get-all', `remote.${name}.url`],
    [1]
  );
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** All configured git remotes with their URLs (`git remote -v` data). */
export async function listGitRemotes(
  repoPath: string
): Promise<GitRemoteInfo[]> {
  const { stdout } = await git(repoPath, ['remote']);
  const names = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const remotes: GitRemoteInfo[] = [];
  for (const name of names) {
    remotes.push({ name, urls: await getGitRemoteUrls(repoPath, name) });
  }
  return remotes;
}

/** The repo-local git author identity (`user.name` + `user.email`). */
export interface GitAuthorConfig {
  name?: string;
  email?: string;
}

/**
 * Read the repository's LOCAL `user.name` / `user.email` (never `--global`).
 * A `--local --get` miss is exit 1 (tolerated) and yields `undefined` — so
 * this reports only what THIS repo overrides, not any inherited global value.
 */
export async function readGitAuthor(
  repoPath: string
): Promise<GitAuthorConfig> {
  const [name, email] = await Promise.all([
    git(repoPath, ['config', '--local', '--get', 'user.name'], [1]),
    git(repoPath, ['config', '--local', '--get', 'user.email'], [1]),
  ]);
  const config: GitAuthorConfig = {};
  const n = name.stdout.trim();
  if (name.exitCode === 0 && n) config.name = n;
  const e = email.stdout.trim();
  if (email.exitCode === 0 && e) config.email = e;
  return config;
}

/**
 * Set the repository's LOCAL git author identity — `git config --local`, so it
 * overrides any global `user.name`/`user.email` FOR THIS REPO ONLY and never
 * touches `~/.gitconfig`. On a rig repo the nostr key is the identity, so the
 * commit author == push signer == nostr identity (a coherent authorship chain
 * baked into the git objects on Arweave).
 */
export async function setGitAuthor(
  repoPath: string,
  author: { name: string; email: string }
): Promise<void> {
  await git(repoPath, ['config', '--local', 'user.name', author.name]);
  await git(repoPath, ['config', '--local', 'user.email', author.email]);
}

/** `git remote add <name> <url>` — real git remote storage, never a shell. */
export async function addGitRemote(
  repoPath: string,
  name: string,
  url: string
): Promise<void> {
  await git(repoPath, ['remote', 'add', name, url]);
}

/** `git remote remove <name>`. */
export async function removeGitRemote(
  repoPath: string,
  name: string
): Promise<void> {
  await git(repoPath, ['remote', 'remove', name]);
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
