/**
 * GitRepoReader tests against a REAL fixture repository built with git
 * commands in a temp dir: two commits on main, a feature branch, an
 * annotated + a lightweight tag, a large binary file (forces the
 * cat-file --batch body across multiple stdout chunks), and nested dirs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GitError, GitRepoReader } from './repo-reader.js';

let repoDir: string;
let reader: GitRepoReader;
/** SHAs captured while building the fixture. */
let commit1 = '';
let commit2 = '';
let featureCommit = '';
let annotatedTagSha = '';
let binaryBlobSha = '';
let binaryContent: Buffer;

const NON_EXISTENT_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
      GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
      GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
    },
  }).trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-git-fixture-'));
  git(['init', '--initial-branch=main'], repoDir);

  // Commit 1: README + nested dirs.
  writeFileSync(join(repoDir, 'README.md'), '# fixture\n');
  mkdirSync(join(repoDir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(repoDir, 'src', 'deep', 'util.ts'), 'export const y = 2;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'first: readme + nested dirs'], repoDir);
  commit1 = git(['rev-parse', 'HEAD'], repoDir);

  // Commit 2: a large deterministic binary file (~300KB, includes NUL and LF
  // bytes) so `cat-file --batch` output spans multiple pipe chunks.
  const seed = createHash('sha256').update('toon-224').digest();
  const blocks: Buffer[] = [];
  let cur = seed;
  for (let i = 0; i < 300 * 1024 / 32; i++) {
    blocks.push(cur);
    cur = createHash('sha256').update(cur).digest();
  }
  binaryContent = Buffer.concat(blocks);
  writeFileSync(join(repoDir, 'blob.bin'), binaryContent);
  git(['add', 'blob.bin'], repoDir);
  git(['commit', '-m', 'second: binary blob'], repoDir);
  commit2 = git(['rev-parse', 'HEAD'], repoDir);
  binaryBlobSha = git(['rev-parse', 'HEAD:blob.bin'], repoDir);

  // Tags on commit 2: annotated + lightweight.
  git(['tag', '-a', 'v1.0.0', '-m', 'release one'], repoDir);
  annotatedTagSha = git(['rev-parse', 'refs/tags/v1.0.0'], repoDir);
  git(['tag', 'lightweight'], repoDir);

  // Feature branch ahead of main.
  git(['checkout', '-b', 'feature/reader'], repoDir);
  writeFileSync(join(repoDir, 'src', 'feature.ts'), 'export const f = 3;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'feature: add feature.ts'], repoDir);
  featureCommit = git(['rev-parse', 'HEAD'], repoDir);
  git(['checkout', 'main'], repoDir);

  reader = new GitRepoReader(repoDir);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('listRefs', () => {
  it('lists branches and tags with objectname/type, peeling annotated tags', async () => {
    const { head, refs } = await reader.listRefs();
    expect(head).toBe('refs/heads/main');

    const byName = new Map(refs.map((r) => [r.refname, r]));
    expect(byName.get('refs/heads/main')).toMatchObject({
      sha: commit2,
      type: 'commit',
    });
    expect(byName.get('refs/heads/main')?.peeledSha).toBeUndefined();
    expect(byName.get('refs/heads/feature/reader')).toMatchObject({
      sha: featureCommit,
      type: 'commit',
    });
    // Annotated tag: ref points at the TAG object, peeled at the commit.
    expect(byName.get('refs/tags/v1.0.0')).toMatchObject({
      sha: annotatedTagSha,
      type: 'tag',
      peeledSha: commit2,
    });
    expect(annotatedTagSha).not.toBe(commit2);
    // Lightweight tag: plain commit pointer, nothing to peel.
    expect(byName.get('refs/tags/lightweight')).toMatchObject({
      sha: commit2,
      type: 'commit',
    });
    expect(byName.get('refs/tags/lightweight')?.peeledSha).toBeUndefined();
  });

  it('tolerates a detached HEAD (head undefined)', async () => {
    git(['checkout', '--detach', commit1], repoDir);
    try {
      const { head, refs } = await reader.listRefs();
      expect(head).toBeUndefined();
      expect(refs.length).toBeGreaterThan(0);
    } finally {
      git(['checkout', 'main'], repoDir);
    }
  });
});

describe('objectsBetween', () => {
  it('returns the full closure for a first push (no haves)', async () => {
    const shas = await reader.objectsBetween([commit2], []);
    // 2 commits + root trees + src/deep trees + blobs, all unique 40-hex.
    expect(shas).toContain(commit2);
    expect(shas).toContain(commit1);
    expect(shas).toContain(binaryBlobSha);
    expect(new Set(shas).size).toBe(shas.length);
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('excludes objects reachable from haves (delta push)', async () => {
    const delta = await reader.objectsBetween([commit2], [commit1]);
    expect(delta).toContain(commit2);
    expect(delta).toContain(binaryBlobSha);
    expect(delta).not.toContain(commit1);
    // README blob is only reachable via commit1's tree — already had.
    const full = await reader.objectsBetween([commit2], []);
    expect(delta.length).toBeLessThan(full.length);
  });

  it('filters out haves that do not exist locally instead of failing', async () => {
    const withGhostHave = await reader.objectsBetween(
      [commit2],
      [NON_EXISTENT_SHA, commit1]
    );
    const withoutGhost = await reader.objectsBetween([commit2], [commit1]);
    expect(withGhostHave.sort()).toEqual(withoutGhost.sort());
  });

  it('accepts refnames as wants', async () => {
    const shas = await reader.objectsBetween(['feature/reader'], ['main']);
    expect(shas).toContain(featureCommit);
    expect(shas).not.toContain(commit2);
  });

  it('returns [] for empty wants', async () => {
    await expect(reader.objectsBetween([], [commit1])).resolves.toEqual([]);
  });

  it('fails when a want does not exist', async () => {
    await expect(
      reader.objectsBetween([NON_EXISTENT_SHA], [])
    ).rejects.toThrow(GitError);
  });
});

describe('objectsBetweenWithPaths', () => {
  it('keeps reach paths for blobs and trees, none for commits', async () => {
    const objects = await reader.objectsBetweenWithPaths([commit2], []);
    const bySha = new Map(objects.map((o) => [o.sha, o]));
    expect(bySha.get(commit1)?.path).toBeUndefined();
    expect(bySha.get(commit2)?.path).toBeUndefined();
    expect(bySha.get(binaryBlobSha)?.path).toBe('blob.bin');
    const deepBlob = objects.find((o) => o.path === 'src/deep/util.ts');
    expect(deepBlob).toBeDefined();
    // Same SHA set as the path-less variant.
    const shas = await reader.objectsBetween([commit2], []);
    expect(objects.map((o) => o.sha)).toEqual(shas);
  });
});

describe('statObjects (cat-file --batch-check)', () => {
  it('returns type + body size without reading bodies, reports missing', async () => {
    const { objects, missing } = await reader.statObjects([
      binaryBlobSha,
      commit2,
      NON_EXISTENT_SHA,
    ]);
    expect(missing).toEqual([NON_EXISTENT_SHA]);
    expect(objects).toHaveLength(2);
    expect(objects[0]).toEqual({
      sha: binaryBlobSha,
      type: 'blob',
      size: binaryContent.length,
    });
    expect(objects[1]?.sha).toBe(commit2);
    expect(objects[1]?.type).toBe('commit');
  });

  it('rejects non-full-SHA input before spawning git', async () => {
    await expect(reader.statObjects(['main'])).rejects.toThrow(
      /full 40-hex SHA-1/
    );
  });

  it('returns empty results for empty input', async () => {
    await expect(reader.statObjects([])).resolves.toEqual({
      objects: [],
      missing: [],
    });
  });
});

describe('readObjects (cat-file --batch)', () => {
  it('streams a binary body split across chunks, byte-identical', async () => {
    const { objects, missing } = await reader.readObjects([binaryBlobSha]);
    expect(missing).toEqual([]);
    expect(objects).toHaveLength(1);
    expect(objects[0].sha).toBe(binaryBlobSha);
    expect(objects[0].type).toBe('blob');
    expect(objects[0].body.length).toBe(binaryContent.length);
    expect(objects[0].body.equals(binaryContent)).toBe(true);
  });

  it('reads mixed types in input order and reports missing objects', async () => {
    const { objects, missing } = await reader.readObjects([
      commit1,
      NON_EXISTENT_SHA,
      annotatedTagSha,
      binaryBlobSha,
    ]);
    expect(missing).toEqual([NON_EXISTENT_SHA]);
    expect(objects.map((o) => o.sha)).toEqual([
      commit1,
      annotatedTagSha,
      binaryBlobSha,
    ]);
    expect(objects.map((o) => o.type)).toEqual(['commit', 'tag', 'blob']);
    expect(objects[0].body.toString('utf-8')).toContain(
      'first: readme + nested dirs'
    );
    expect(objects[1].body.toString('utf-8')).toContain('tag v1.0.0');
  });

  it('round-trips every object of the repo closure (incl. trees)', async () => {
    const shas = await reader.readObjects(
      await reader.objectsBetween([commit2], [])
    );
    expect(shas.missing).toEqual([]);
    const types = new Set(shas.objects.map((o) => o.type));
    expect(types).toContain('commit');
    expect(types).toContain('tree');
    expect(types).toContain('blob');
    // Each body re-hashes to its claimed SHA (git envelope).
    for (const obj of shas.objects) {
      const envelope = Buffer.concat([
        Buffer.from(`${obj.type} ${obj.body.length}\0`),
        obj.body,
      ]);
      expect(createHash('sha1').update(envelope).digest('hex')).toBe(obj.sha);
    }
  });

  it('returns empty results for empty input without spawning', async () => {
    await expect(reader.readObjects([])).resolves.toEqual({
      objects: [],
      missing: [],
    });
  });

  it('rejects non-full-SHA input (no revision names in the batch path)', async () => {
    await expect(reader.readObjects(['main'])).rejects.toThrow(/40-hex/);
  });
});

describe('isAncestor', () => {
  it('detects fast-forward (true) and divergence/reverse (false)', async () => {
    await expect(reader.isAncestor(commit1, commit2)).resolves.toBe(true);
    await expect(reader.isAncestor(commit2, commit1)).resolves.toBe(false);
    await expect(reader.isAncestor(commit2, featureCommit)).resolves.toBe(true);
    await expect(reader.isAncestor(featureCommit, commit2)).resolves.toBe(false);
    await expect(reader.isAncestor(commit1, commit1)).resolves.toBe(true);
  });

  it('throws GitError (not false) for unknown revisions', async () => {
    await expect(reader.isAncestor(NON_EXISTENT_SHA, commit1)).rejects.toThrow(
      GitError
    );
  });
});

describe('formatPatch', () => {
  it('produces mbox patch text for a range', async () => {
    const patch = await reader.formatPatch(`${commit1}..${commit2}`);
    expect(patch).toContain('Subject: [PATCH] second: binary blob');
    expect(patch).toContain('blob.bin');
    expect(patch).toContain('From ');
  });

  it('supports a single-rev range and branch names', async () => {
    const patch = await reader.formatPatch('main..feature/reader');
    expect(patch).toContain('feature: add feature.ts');
    expect(patch).toContain('+export const f = 3;');
  });

  it('returns empty string when the range selects no commits', async () => {
    await expect(reader.formatPatch(`${commit2}..${commit2}`)).resolves.toBe('');
  });
});

describe('commitParents', () => {
  it('maps commits to their parents (root commit → empty array)', async () => {
    const parents = await reader.commitParents([commit2, commit1]);
    expect(parents.get(commit2)).toEqual([commit1]);
    expect(parents.get(commit1)).toEqual([]);
  });

  it('returns an empty map for no input without spawning git', async () => {
    await expect(reader.commitParents([])).resolves.toEqual(new Map());
  });

  it('rejects non-full-SHA input before spawning git', async () => {
    await expect(reader.commitParents(['main'])).rejects.toThrow(/full 40-hex/);
  });
});

describe('resolveRef', () => {
  it('resolves branch, tag, HEAD, and full-ref names to SHAs', async () => {
    await expect(reader.resolveRef('main')).resolves.toBe(commit2);
    await expect(reader.resolveRef('refs/heads/main')).resolves.toBe(commit2);
    await expect(reader.resolveRef('HEAD')).resolves.toBe(commit2);
    // Annotated tag ref resolves to the tag object.
    await expect(reader.resolveRef('v1.0.0')).resolves.toBe(annotatedTagSha);
    await expect(reader.resolveRef('main~1')).resolves.toBe(commit1);
  });

  it('throws GitError for unknown refs', async () => {
    await expect(reader.resolveRef('no-such-branch')).rejects.toThrow(GitError);
  });
});

describe('injection safety', () => {
  const evil = [
    '--upload-pack=touch /tmp/pwned',
    '-v',
    '--output=/tmp/pwned',
    '--exec=sh',
    'refs/heads/ok; rm -rf /',
    'a b',
    '$(id)',
    '`id`',
    'ref@{0}',
  ];

  it('rejects option/shell-shaped revisions before spawning git', async () => {
    for (const bad of evil) {
      await expect(reader.resolveRef(bad)).rejects.toThrow(/not a valid git revision/);
      await expect(reader.objectsBetween([bad], [])).rejects.toThrow(/not a valid/);
      await expect(reader.objectsBetween(['main'], [bad])).rejects.toThrow(/not a valid/);
      await expect(reader.isAncestor(bad, 'main')).rejects.toThrow(/not a valid/);
      await expect(reader.isAncestor('main', bad)).rejects.toThrow(/not a valid/);
      await expect(reader.formatPatch(bad)).rejects.toThrow(/not a valid/);
      await expect(reader.formatPatch(`main..${bad}`)).rejects.toThrow(/not a valid/);
    }
  });

  it('rejects option-shaped SHAs in readObjects', async () => {
    await expect(
      reader.readObjects(['--textconv' as unknown as string])
    ).rejects.toThrow(/40-hex/);
  });

  it('never treats a validated arg as a pathspec (trailing -- guard)', async () => {
    // A file named like a branch must not be picked up as a pathspec.
    writeFileSync(join(repoDir, 'main'), 'decoy\n');
    try {
      const patch = await reader.formatPatch(`${commit1}..${commit2}`);
      expect(patch).toContain('Subject: [PATCH]');
    } finally {
      rmSync(join(repoDir, 'main'));
    }
  });
});
