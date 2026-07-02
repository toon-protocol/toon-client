/**
 * GitRepoReader — read a local repository via `execFile` git plumbing.
 *
 * Real git gives perfect fidelity (packfiles, delta chains, exotic history)
 * with zero new deps — no isomorphic-git. Everything here is read-only and
 * injection-safe:
 *
 *  - child processes are spawned with `execFile`/`spawn` and argument
 *    ARRAYS — never a shell, never string interpolation;
 *  - every caller-supplied revision/range is validated against strict
 *    regexes that (among other things) reject a leading `-`, so a value
 *    like `--upload-pack=…` can never be parsed as an option;
 *  - `--` terminators are appended where git supports them so nothing
 *    user-supplied can be re-interpreted as a pathspec.
 *
 * Push planning/publishing live in follow-up tickets of epic
 * toon-client#222 — this module only reads.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitObjectType } from './objects.js';

const execFileAsync = promisify(execFile);

/** Generous cap for plumbing stdout (rev-list on big repos, format-patch). */
const MAX_BUFFER = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single ref from `git for-each-ref` (branches + tags). */
export interface GitRef {
  /** Full refname, e.g. `refs/heads/main` or `refs/tags/v1.0.0`. */
  refname: string;
  /**
   * SHA the ref points at. For annotated tags this is the TAG object's SHA
   * (the peeled commit is in {@link peeledSha}); for branches and
   * lightweight tags it is the commit SHA.
   */
  sha: string;
  /** Type of the referenced object: `commit`, or `tag` for annotated tags. */
  type: GitObjectType;
  /** For annotated tags: the peeled (target) object SHA. */
  peeledSha?: string;
}

/** Result of {@link GitRepoReader.listRefs}. */
export interface RepoRefs {
  /**
   * Full refname HEAD points at (e.g. `refs/heads/main`), or `undefined`
   * when HEAD is detached.
   */
  head?: string;
  refs: GitRef[];
}

/** One object streamed out of `git cat-file --batch`. */
export interface ReadGitObject {
  /** Full 40-hex SHA-1. */
  sha: string;
  type: GitObjectType;
  /** Raw object body (content only, no envelope header). May be binary. */
  body: Buffer;
}

/** Result of {@link GitRepoReader.readObjects}. */
export interface ReadObjectsResult {
  /** Objects found, in input order (minus missing ones). */
  objects: ReadGitObject[];
  /** Requested SHAs not present in the repository. */
  missing: string[];
}

/** One object from `rev-list --objects`: SHA plus the path it was reached by. */
export interface ObjectWithPath {
  /** Full 40-hex SHA-1. */
  sha: string;
  /**
   * Path the object was first reached by (blobs and non-root trees);
   * `undefined` for commits, root trees, and tag objects.
   */
  path?: string;
}

/** One object's metadata from `cat-file --batch-check`. */
export interface ObjectStat {
  sha: string;
  type: GitObjectType;
  /** Object body size in bytes (content only, no envelope header). */
  size: number;
}

/** Result of {@link GitRepoReader.statObjects}. */
export interface StatObjectsResult {
  /** Stats found, in input order (minus missing ones). */
  objects: ObjectStat[];
  /** Requested SHAs not present in the repository. */
  missing: string[];
}

/** Error from a git child process, carrying exit code and stderr. */
export class GitError extends Error {
  constructor(
    message: string,
    /** Process exit code (undefined when the process failed to spawn). */
    public readonly exitCode: number | undefined,
    /** Captured stderr, trimmed. */
    public readonly stderr: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

// ---------------------------------------------------------------------------
// Argument validation (injection defense)
// ---------------------------------------------------------------------------

/** Full 40-hex SHA-1. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * One revision token: a SHA prefix (4–40 hex) or a refname-ish word with an
 * optional `^`/`~<n>` ancestry suffix. Must start with an alphanumeric, so a
 * leading `-` (option injection) is impossible; `@{…}`, whitespace, and other
 * revspec exotica are deliberately rejected.
 */
const REV_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/;

function isValidRevision(rev: string): boolean {
  if (rev.length === 0 || rev.length > 1024) return false;
  if (!REV_TOKEN_RE.test(rev)) return false;
  // Refname rules git enforces that our charset alone doesn't:
  if (rev.includes('..')) return false; // range separator / invalid in refnames
  if (rev.endsWith('.lock') || rev.endsWith('/') || rev.endsWith('.')) return false;
  return true;
}

function assertRevision(rev: string, what: string): void {
  if (!isValidRevision(rev)) {
    throw new Error(
      `${what} is not a valid git revision (got ${JSON.stringify(rev)}); ` +
        'expected a SHA or simple refname — options/ranges are rejected'
    );
  }
}

function assertFullSha(sha: string, what: string): void {
  if (!FULL_SHA_RE.test(sha)) {
    throw new Error(
      `${what} is not a full 40-hex SHA-1 (got ${JSON.stringify(sha)})`
    );
  }
}

/**
 * A revision range for format-patch: `<rev>`, `<rev>..<rev>`, or
 * `<rev>...<rev>` where each side passes {@link isValidRevision}.
 */
function assertRange(range: string, what: string): void {
  const parts = range.split(/\.{2,3}/);
  const separators = range.match(/\.{2,3}/g) ?? [];
  const ok =
    parts.length <= 2 &&
    separators.length === parts.length - 1 &&
    parts.every((p) => isValidRevision(p));
  if (!ok) {
    throw new Error(
      `${what} is not a valid revision range (got ${JSON.stringify(range)}); ` +
        'expected <rev>, <rev>..<rev>, or <rev>...<rev>'
    );
  }
}

// ---------------------------------------------------------------------------
// cat-file --batch incremental parser
// ---------------------------------------------------------------------------

const OBJECT_TYPES: ReadonlySet<string> = new Set(['blob', 'tree', 'commit', 'tag']);

/**
 * Incremental parser for `git cat-file --batch` output:
 * `<sha> <type> <size>\n<body>\n` per found object, `<name> missing\n` for
 * absent ones. Bodies are raw bytes (possibly binary) and may be split
 * across arbitrary chunk boundaries, so parsing is strictly size-driven.
 */
class BatchParser {
  private buf: Buffer = Buffer.alloc(0);
  private pending: { sha: string; type: GitObjectType; size: number } | null = null;

  readonly objects: ReadGitObject[] = [];
  readonly missing: string[] = [];

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  /** True when no partially-parsed record remains. */
  isComplete(): boolean {
    return this.pending === null && this.buf.length === 0;
  }

  private drain(): void {
    for (;;) {
      if (this.pending) {
        // Need body + trailing LF before the record is complete.
        const needed = this.pending.size + 1;
        if (this.buf.length < needed) return;
        const body = Buffer.from(this.buf.subarray(0, this.pending.size));
        this.objects.push({ sha: this.pending.sha, type: this.pending.type, body });
        this.buf = this.buf.subarray(needed);
        this.pending = null;
        continue;
      }

      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) return;
      const header = this.buf.subarray(0, nl).toString('utf-8');
      this.buf = this.buf.subarray(nl + 1);

      const [name, second, third] = header.split(' ');
      if (name && second === 'missing' && third === undefined) {
        this.missing.push(name);
        continue;
      }
      if (name && second && third !== undefined && OBJECT_TYPES.has(second)) {
        const size = Number.parseInt(third, 10);
        if (Number.isSafeInteger(size) && size >= 0) {
          this.pending = { sha: name, type: second as GitObjectType, size };
          continue;
        }
      }
      throw new GitError(
        `unexpected cat-file --batch header: ${JSON.stringify(header)}`,
        undefined,
        ''
      );
    }
  }
}

// ---------------------------------------------------------------------------
// GitRepoReader
// ---------------------------------------------------------------------------

/**
 * Read-only view of a local git repository via git plumbing commands.
 *
 * All methods throw {@link GitError} when the underlying git process fails
 * unexpectedly, and plain `Error` when a caller-supplied argument fails
 * validation (before any process is spawned).
 */
export class GitRepoReader {
  constructor(
    /** Absolute or relative path to the repository worktree (or .git dir). */
    public readonly repoPath: string
  ) {}

  /** Run git with argument-array safety; resolves stdout as UTF-8. */
  private async git(
    args: string[],
    opts: { allowExitCodes?: number[] } = {}
  ): Promise<{ stdout: string; exitCode: number }> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: this.repoPath,
        maxBuffer: MAX_BUFFER,
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
      if (exitCode !== undefined && opts.allowExitCodes?.includes(exitCode)) {
        return { stdout: e.stdout ?? '', exitCode };
      }
      throw new GitError(
        `git ${args[0]} failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}: ` +
          `${(e.stderr ?? e.message ?? '').trim()}`,
        exitCode,
        (e.stderr ?? '').trim()
      );
    }
  }

  /**
   * List all branches and tags plus the symbolic HEAD.
   *
   * Annotated tags report the tag object's SHA/type with the peeled target
   * in `peeledSha`. A detached HEAD is tolerated (`head` is `undefined`).
   */
  async listRefs(): Promise<RepoRefs> {
    const format = '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)';
    const [refsRes, headRes] = await Promise.all([
      this.git(['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/tags']),
      // Exit 1 = detached HEAD (or unborn branch pointer oddities) — tolerated.
      this.git(['symbolic-ref', '--quiet', 'HEAD'], { allowExitCodes: [1] }),
    ]);

    const refs: GitRef[] = [];
    for (const line of refsRes.stdout.split('\n')) {
      if (!line) continue;
      const [refname, sha, objecttype, peeled] = line.split('\0');
      if (!refname || !sha || !objecttype || !OBJECT_TYPES.has(objecttype)) {
        throw new GitError(`unexpected for-each-ref line: ${JSON.stringify(line)}`, undefined, '');
      }
      refs.push({
        refname,
        sha,
        type: objecttype as GitObjectType,
        ...(peeled ? { peeledSha: peeled } : {}),
      });
    }

    const head = headRes.exitCode === 0 ? headRes.stdout.trim() || undefined : undefined;
    return { head, refs };
  }

  /**
   * SHAs of every object reachable from `want` but not from `have`
   * (`git rev-list --objects <want…> --not <have…>`), i.e. the push delta.
   *
   * Haves that don't exist locally (e.g. remote tips we never fetched) are
   * filtered out first via one `cat-file --batch-check` pass — rev-list
   * would otherwise die on them.
   */
  async objectsBetween(want: string[], have: string[]): Promise<string[]> {
    const objects = await this.objectsBetweenWithPaths(want, have);
    return objects.map((o) => o.sha);
  }

  /**
   * Like {@link objectsBetween} but keeps the path each object was reached
   * by (`rev-list --objects` emits `<sha> <path>` for blobs and non-root
   * trees) — used by push planning to report actionable oversize errors.
   */
  async objectsBetweenWithPaths(
    want: string[],
    have: string[]
  ): Promise<ObjectWithPath[]> {
    for (const w of want) assertRevision(w, 'want');
    for (const h of have) assertRevision(h, 'have');
    if (want.length === 0) return [];

    const knownHaves = await this.filterExisting(have);

    const args = ['rev-list', '--objects', ...want];
    if (knownHaves.length > 0) args.push('--not', ...knownHaves);
    args.push('--'); // nothing user-supplied can become a pathspec
    const { stdout } = await this.git(args);

    const objects: ObjectWithPath[] = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      // `--objects` lines are `<sha>` or `<sha> <path>`.
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) {
        objects.push({ sha: line });
      } else {
        const path = line.slice(spaceIdx + 1);
        objects.push({
          sha: line.slice(0, spaceIdx),
          ...(path ? { path } : {}),
        });
      }
    }
    return objects;
  }

  /** Run git feeding `input` on stdin; resolves collected stdout bytes. */
  private runWithStdin(args: string[], input: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (err) => {
        reject(new GitError(`failed to spawn git ${args[0]}: ${err.message}`, undefined, ''));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          return reject(
            new GitError(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`, code ?? undefined, stderr.trim())
          );
        }
        resolve(Buffer.concat(out));
      });
      child.stdin.on('error', () => {
        // Child died before consuming stdin; 'close' surfaces the failure.
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  /** Of the given revisions, keep only those resolvable locally. */
  private async filterExisting(revs: string[]): Promise<string[]> {
    if (revs.length === 0) return [];
    const { missing } = await this.batchCheck(revs);
    const missingSet = new Set(missing);
    return revs.filter((r) => !missingSet.has(r));
  }

  /** One `cat-file --batch-check` pass; returns names reported missing. */
  private async batchCheck(names: string[]): Promise<{ missing: string[] }> {
    const stdout = await this.runWithStdin(
      ['cat-file', '--batch-check'],
      names.join('\n') + '\n'
    );
    const missing: string[] = [];
    for (const line of stdout.toString('utf-8').split('\n')) {
      if (line.endsWith(' missing')) missing.push(line.slice(0, -' missing'.length));
    }
    return { missing };
  }

  /**
   * Object metadata (type + body size) for a batch of SHAs via one
   * `cat-file --batch-check` pass — no bodies are read. Missing objects are
   * reported, not thrown.
   */
  async statObjects(shas: string[]): Promise<StatObjectsResult> {
    for (const sha of shas) assertFullSha(sha, 'sha');
    if (shas.length === 0) return { objects: [], missing: [] };

    const stdout = await this.runWithStdin(
      ['cat-file', '--batch-check'],
      shas.join('\n') + '\n'
    );

    const objects: ObjectStat[] = [];
    const missing: string[] = [];
    for (const line of stdout.toString('utf-8').split('\n')) {
      if (!line) continue;
      if (line.endsWith(' missing')) {
        missing.push(line.slice(0, -' missing'.length));
        continue;
      }
      const [sha, type, sizeStr] = line.split(' ');
      const size = Number.parseInt(sizeStr ?? '', 10);
      if (
        !sha ||
        !type ||
        !OBJECT_TYPES.has(type) ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        throw new GitError(
          `unexpected cat-file --batch-check line: ${JSON.stringify(line)}`,
          undefined,
          ''
        );
      }
      objects.push({ sha, type: type as GitObjectType, size });
    }
    return { objects, missing };
  }

  /**
   * Read raw object bodies via a single streaming `git cat-file --batch`
   * child process. Bodies may be binary and are parsed size-driven across
   * chunk boundaries. Missing objects are reported, not thrown.
   */
  async readObjects(shas: string[]): Promise<ReadObjectsResult> {
    for (const sha of shas) assertFullSha(sha, 'sha');
    if (shas.length === 0) return { objects: [], missing: [] };

    const parser = new BatchParser();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['cat-file', '--batch'], {
        cwd: this.repoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      let parseError: Error | null = null;

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (parseError) return;
        try {
          parser.push(chunk);
        } catch (err) {
          parseError = err as Error;
          child.kill();
        }
      });
      child.on('error', (err) => {
        reject(new GitError(`failed to spawn git cat-file: ${err.message}`, undefined, ''));
      });
      child.on('close', (code) => {
        if (parseError) return reject(parseError);
        if (code !== 0) {
          return reject(
            new GitError(`git cat-file --batch failed (exit ${code}): ${stderr.trim()}`, code ?? undefined, stderr.trim())
          );
        }
        if (!parser.isComplete()) {
          return reject(
            new GitError('git cat-file --batch output ended mid-record', code ?? undefined, stderr.trim())
          );
        }
        resolve();
      });

      child.stdin.on('error', () => {
        // Child died before consuming stdin; 'close' will surface the error.
      });
      child.stdin.write(shas.join('\n') + '\n');
      child.stdin.end();
    });

    return { objects: parser.objects, missing: parser.missing };
  }

  /**
   * `git merge-base --is-ancestor <a> <b>` — true when `a` is an ancestor
   * of `b` (fast-forward check / force detection). Exit codes other than
   * 0/1 (e.g. unknown revisions) throw.
   */
  async isAncestor(a: string, b: string): Promise<boolean> {
    assertRevision(a, 'ancestor candidate');
    assertRevision(b, 'descendant candidate');
    const { exitCode } = await this.git(
      ['merge-base', '--is-ancestor', a, b],
      { allowExitCodes: [1] }
    );
    return exitCode === 0;
  }

  /**
   * `git format-patch --stdout <range>` — the full mbox-formatted patch
   * series text (empty string when the range selects no commits).
   */
  async formatPatch(range: string): Promise<string> {
    assertRange(range, 'range');
    const { stdout } = await this.git(['format-patch', '--stdout', range, '--']);
    return stdout;
  }

  /**
   * Parent SHAs for a batch of commit SHAs via one
   * `git rev-list --no-walk=unsorted --parents` pass. Root commits map to an
   * empty array. Used to derive the kind:1617 `commit`/`parent-commit` tag
   * pairs for exactly the commits a format-patch series carries.
   */
  async commitParents(shas: string[]): Promise<Map<string, string[]>> {
    for (const sha of shas) assertFullSha(sha, 'sha');
    if (shas.length === 0) return new Map();
    const { stdout } = await this.git([
      'rev-list',
      '--no-walk=unsorted',
      '--parents',
      ...shas,
      '--',
    ]);
    const parents = new Map<string, string[]>();
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [sha, ...rest] = line.split(' ');
      if (!sha || !FULL_SHA_RE.test(sha) || rest.some((p) => !FULL_SHA_RE.test(p))) {
        throw new GitError(
          `unexpected rev-list --parents line: ${JSON.stringify(line)}`,
          undefined,
          ''
        );
      }
      parents.set(sha, rest);
    }
    return parents;
  }

  /**
   * Resolve a ref/revision to a full SHA via `git rev-parse --verify`.
   * Throws {@link GitError} when the name doesn't resolve.
   */
  async resolveRef(name: string): Promise<string> {
    assertRevision(name, 'ref name');
    const { stdout } = await this.git(['rev-parse', '--verify', '--quiet', name]);
    const sha = stdout.trim();
    if (!FULL_SHA_RE.test(sha)) {
      throw new GitError(
        `rev-parse --verify returned unexpected output for ${JSON.stringify(name)}: ${JSON.stringify(sha)}`,
        undefined,
        ''
      );
    }
    return sha;
  }
}
