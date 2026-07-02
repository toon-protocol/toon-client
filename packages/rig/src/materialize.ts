/**
 * Materialize downloaded git objects into a REAL repository (#278).
 *
 * Objects are written through git's own plumbing — `git hash-object -w
 * --stdin -t <type>` with the raw body on stdin — so git computes, validates
 * (syntax checks for trees/commits/tags), stores (loose object + zlib), and
 * RETURNS the SHA. The returned SHA is compared against the expected one:
 * a second, independent integrity gate after ./object-fetch.ts's envelope
 * verification. Refs land via `git update-ref`, HEAD via `git symbolic-ref`.
 *
 * Same injection posture as GitRepoReader: child processes use
 * `execFile`/`spawn` with argument ARRAYS (never a shell), and refnames are
 * validated with `git check-ref-format` semantics before use.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { FetchedObject } from './object-fetch.js';

const execFileAsync = promisify(execFile);

/** A written object's SHA disagreed with what `git hash-object` computed. */
export class ObjectWriteMismatchError extends Error {
  constructor(
    public readonly expectedSha: string,
    public readonly writtenSha: string
  ) {
    super(
      `git hash-object wrote ${writtenSha} where ${expectedSha} was expected — ` +
        'object content does not round-trip; aborting'
    );
    this.name = 'ObjectWriteMismatchError';
  }
}

/** Full 40-hex SHA-1. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Conservative refname validation (superset-safe subset of
 * `git check-ref-format`): must start `refs/`, no component may start with
 * `-` or `.`, no `..`, no control/space/git-special characters, no trailing
 * `/`, `.`, or `.lock`. Rejecting odd-but-legal names is fine — these
 * refnames come from relay events, and a hostile relay must not be able to
 * smuggle options or path traversal into git invocations.
 */
export function isSafeRefname(refname: string): boolean {
  if (!refname.startsWith('refs/') || refname.length > 1024) return false;
  // eslint-disable-next-line no-control-regex -- explicit control-char reject
  if (/[\u0000-\u0020~^:?*[\\\u007f]/.test(refname)) return false;
  if (refname.includes('..') || refname.includes('@{')) return false;
  if (refname.endsWith('/') || refname.endsWith('.')) return false;
  for (const part of refname.split('/')) {
    if (part === '' || part.startsWith('.') || part.startsWith('-'))
      return false;
    if (part.endsWith('.lock')) return false;
  }
  return true;
}

function assertSafeRefname(refname: string): void {
  if (!isSafeRefname(refname)) {
    throw new Error(
      `unsafe ref name from remote state: ${JSON.stringify(refname)} — refusing`
    );
  }
}

function assertFullSha(sha: string): void {
  if (!FULL_SHA_RE.test(sha)) {
    throw new Error(`not a full 40-hex SHA-1: ${JSON.stringify(sha)}`);
  }
}

/** Run git with argument-array safety in `repoPath`. */
export async function runGit(
  repoPath: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as {
      code?: number | string;
      stderr?: string;
      message?: string;
    };
    throw new Error(
      `git ${args[0]} failed${typeof e.code === 'number' ? ` (exit ${e.code})` : ''}: ` +
        `${(e.stderr ?? e.message ?? '').trim()}`
    );
  }
}

/**
 * Write one object via `git hash-object -w --stdin -t <type>` (binary-safe
 * stdin) and verify the SHA git computed matches the expected one.
 */
export async function writeGitObject(
  repoPath: string,
  object: FetchedObject
): Promise<void> {
  assertFullSha(object.sha);
  const written = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'git',
      ['hash-object', '-w', '--stdin', '-t', object.type],
      { cwd: repoPath, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      reject(new Error(`failed to spawn git hash-object: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(
          new Error(`git hash-object failed (exit ${code}): ${stderr.trim()}`)
        );
      }
      resolve(stdout.trim());
    });
    child.stdin.on('error', () => {
      // Child died before consuming stdin; 'close' surfaces the failure.
    });
    child.stdin.write(object.body);
    child.stdin.end();
  });
  if (written !== object.sha) {
    throw new ObjectWriteMismatchError(object.sha, written);
  }
}

/** Write a batch of verified objects into the repository (sequential). */
export async function writeGitObjects(
  repoPath: string,
  objects: Iterable<FetchedObject>
): Promise<number> {
  let count = 0;
  for (const object of objects) {
    await writeGitObject(repoPath, object);
    count += 1;
  }
  return count;
}

/** `git update-ref <refname> <sha>` with refname/SHA validation. */
export async function updateRef(
  repoPath: string,
  refname: string,
  sha: string
): Promise<void> {
  assertSafeRefname(refname);
  assertFullSha(sha);
  await runGit(repoPath, ['update-ref', refname, sha]);
}

/** Point HEAD at a branch via `git symbolic-ref HEAD <refname>`. */
export async function setHeadSymref(
  repoPath: string,
  refname: string
): Promise<void> {
  assertSafeRefname(refname);
  await runGit(repoPath, ['symbolic-ref', 'HEAD', refname]);
}
