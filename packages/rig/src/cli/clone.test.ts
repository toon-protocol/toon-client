/**
 * `rig clone` tests (#278): the full pipeline against a REAL source
 * repository served through a mock relay + mock Arweave gateway —
 * bit-identical clone (git fsck + rev-list comparison against the source),
 * integrity rejection (tampered object), the partial-availability error path
 * (honest lag message; temp-dir cleanup; no corrupt repo left behind), and
 * the immediately-push-capable configuration (toon.* + origin remote).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearShaCache } from '@toon-protocol/arweave';
import { hexToNpub } from '../npub.js';
import type { NostrEvent } from '../remote-state.js';
import { runClone } from './clone.js';
import type { CliIo } from './output.js';
import {
  filterEvents,
  gitText,
  makeMockGateway,
  makeMockRelayFactory,
  repoStateEvents,
  storeFromObjects,
  txFor,
} from './read-testkit.js';
import type { ReadCommandDeps } from './read-seams.js';

const OWNER = 'ab'.repeat(32);
const REPO = 'demo-repo';
const RELAY = 'wss://relay.test.example';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanups: string[] = [];
afterEach(() => {
  clearShaCache();
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

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

/** A source repo with two commits on main, a feature branch, and a tag. */
function makeSourceRepo(): string {
  const dir = makeTempDir('toon-rig-clone-src-');
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  writeFileSync(join(dir, 'code.txt'), 'v1\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  writeFileSync(join(dir, 'code.txt'), 'v2 — merged feature\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'second: merged feature'], dir);
  git(['tag', '-a', 'v1.0.0', '-m', 'release'], dir);
  git(['checkout', '-q', '-b', 'feature'], dir);
  writeFileSync(join(dir, 'extra.txt'), 'feature work\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'feature work'], dir);
  git(['checkout', '-q', 'main'], dir);
  return dir;
}

interface TestIo extends CliIo {
  outLines: string[];
  errLines: string[];
  jsonDocs: unknown[];
}

function makeTestIo(): TestIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const jsonDocs: unknown[] = [];
  return {
    outLines,
    errLines,
    jsonDocs,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    emitJson: (payload) => jsonDocs.push(payload),
    isInteractive: false,
    confirm: async () => false,
  };
}

interface CloneWorld {
  io: TestIo;
  deps: ReadCommandDeps;
  gateway: ReturnType<typeof makeMockGateway>;
  events: NostrEvent[];
  srcDir: string;
  cwd: string;
}

function makeWorld(
  options: {
    failHosts?: string[];
    dropShas?: string[];
    tamperSha?: string;
  } = {}
): CloneWorld {
  const srcDir = makeSourceRepo();
  const { announce, refsEvent, objects } = repoStateEvents({
    repoDir: srcDir,
    owner: OWNER,
    repoId: REPO,
  });
  const store = storeFromObjects(objects);
  for (const sha of options.dropShas ?? []) store.delete(txFor(sha));
  if (options.tamperSha) {
    const bytes = store.get(txFor(options.tamperSha)) as Uint8Array;
    const tampered = bytes.slice();
    tampered[0] = (tampered[0] as number) ^ 0xff;
    store.set(txFor(options.tamperSha), tampered);
  }
  const gateway = makeMockGateway(store, {
    failHosts: options.failHosts ?? [],
  });
  const events = [announce, refsEvent];
  const io = makeTestIo();
  const cwd = makeTempDir('toon-rig-clone-dst-');
  const deps: ReadCommandDeps = {
    io,
    env: {},
    cwd,
    webSocketFactory: makeMockRelayFactory((filter) =>
      filterEvents(events, filter)
    ),
    fetchFn: gateway.fetchFn,
    resolveSha: async () => null,
  };
  return { io, deps, gateway, events, srcDir, cwd };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('rig clone happy path', () => {
  it('materializes a bit-identical, fsck-clean, push-capable repository', async () => {
    const world = makeWorld();
    const code = await runClone([RELAY, `${OWNER}/${REPO}`], world.deps);
    expect(world.io.errLines.join('\n')).toBe('');
    expect(code).toBe(0);

    const dest = join(world.cwd, REPO);
    expect(existsSync(dest)).toBe(true);

    // A REAL git repo: fsck-clean, full history, all refs, checked-out tree.
    expect(gitText(dest, ['fsck', '--strict'])).toBe('');
    expect(gitText(dest, ['rev-list', '--all', '--objects'])).toBe(
      gitText(world.srcDir, ['rev-list', '--all', '--objects'])
    );
    expect(gitText(dest, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(gitText(dest, ['rev-parse', 'refs/heads/main'])).toBe(
      gitText(world.srcDir, ['rev-parse', 'refs/heads/main'])
    );
    expect(gitText(dest, ['rev-parse', 'refs/heads/feature'])).toBe(
      gitText(world.srcDir, ['rev-parse', 'refs/heads/feature'])
    );
    expect(gitText(dest, ['rev-parse', 'refs/tags/v1.0.0'])).toBe(
      gitText(world.srcDir, ['rev-parse', 'refs/tags/v1.0.0'])
    );
    // Worktree checked out with BOTH merged changes present.
    expect(readFileSync(join(dest, 'code.txt'), 'utf-8')).toBe(
      'v2 — merged feature\n'
    );
    expect(gitText(dest, ['status', '--porcelain'])).toBe('');

    // Immediately push/pull-capable: toon.* config + origin remote +
    // remote-tracking refs + upstream config, like `git clone`.
    expect(gitText(dest, ['config', 'toon.repoid'])).toBe(REPO);
    expect(gitText(dest, ['config', 'toon.owner'])).toBe(OWNER);
    expect(gitText(dest, ['config', 'remote.origin.url'])).toBe(RELAY);
    expect(gitText(dest, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      gitText(world.srcDir, ['rev-parse', 'refs/heads/main'])
    );
    expect(gitText(dest, ['config', 'branch.main.remote'])).toBe('origin');
    expect(gitText(dest, ['config', 'branch.main.merge'])).toBe(
      'refs/heads/main'
    );

    // No temp dirs left behind.
    expect(
      readdirSync(world.cwd).filter((name) => name.includes('.rig-clone-'))
    ).toEqual([]);
  });

  it('accepts an npub owner, a custom directory, and emits one --json envelope', async () => {
    const world = makeWorld();
    const code = await runClone(
      [RELAY, `${hexToNpub(OWNER)}/${REPO}`, 'my-dir', '--json'],
      world.deps
    );
    expect(code).toBe(0);
    expect(world.io.jsonDocs).toHaveLength(1);
    const doc = world.io.jsonDocs[0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      command: 'clone',
      repoAddr: { ownerPubkey: OWNER, repoId: REPO },
      relay: RELAY,
      head: 'refs/heads/main',
      executed: true,
    });
    expect(doc['directory']).toBe(join(world.cwd, 'my-dir'));
    expect(gitText(join(world.cwd, 'my-dir'), ['fsck', '--strict'])).toBe('');
  });

  it('walks the gateway fallback chain when the primary host fails', async () => {
    const world = makeWorld({ failHosts: ['ar-io.dev'] });
    const code = await runClone([RELAY, `${OWNER}/${REPO}`], world.deps);
    expect(code).toBe(0);
    // Primary was tried and failed over; secondary served the bytes.
    expect(world.gateway.requests.some((u) => u.includes('ar-io.dev'))).toBe(
      true
    );
    expect(world.gateway.requests.some((u) => u.includes('arweave.net'))).toBe(
      true
    );
    expect(gitText(join(world.cwd, REPO), ['fsck', '--strict'])).toBe('');
  });

  it('refuses a non-empty destination before any network call', async () => {
    const world = makeWorld();
    writeFileSync(join(world.cwd, 'occupied'), 'x');
    const code = await runClone([RELAY, `${OWNER}/${REPO}`, '.'], world.deps);
    expect(code).toBe(1);
    expect(world.io.errLines.join('\n')).toContain('not an empty directory');
    expect(world.gateway.requests).toEqual([]);
  });

  it('reports repo_not_found when the relay has no 30617/30618', async () => {
    const world = makeWorld();
    world.events.length = 0; // relay knows nothing
    const code = await runClone(
      [RELAY, `${OWNER}/${REPO}`, '--json'],
      world.deps
    );
    expect(code).toBe(1);
    expect(world.io.jsonDocs[0]).toMatchObject({
      command: 'clone',
      error: 'repo_not_found',
    });
    expect(existsSync(join(world.cwd, REPO))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integrity + partial availability
// ---------------------------------------------------------------------------

describe('rig clone failure modes', () => {
  it('rejects a tampered object and leaves nothing behind', async () => {
    const world = makeWorld();
    const blobSha = gitText(world.srcDir, ['rev-parse', 'main:README.md']);
    // Tamper AFTER world creation so only the gateway content changes.
    const bytes = world.gateway.store.get(txFor(blobSha)) as Uint8Array;
    const tampered = bytes.slice();
    tampered[0] = (tampered[0] as number) ^ 0xff;
    world.gateway.store.set(txFor(blobSha), tampered);

    const code = await runClone(
      [RELAY, `${OWNER}/${REPO}`, '--json'],
      world.deps
    );
    expect(code).toBe(1);
    expect(world.io.jsonDocs[0]).toMatchObject({
      command: 'clone',
      error: 'object_integrity',
    });
    expect(world.io.errLines.join('\n')).toContain(blobSha);
    expect(existsSync(join(world.cwd, REPO))).toBe(false);
    expect(
      readdirSync(world.cwd).filter((name) => name.includes('.rig-clone-'))
    ).toEqual([]);
  });

  it('reports missing objects honestly (SHAs + propagation-lag hint) and cleans up', async () => {
    const world = makeWorld();
    const blobSha = gitText(world.srcDir, ['rev-parse', 'main:code.txt']);
    world.gateway.store.delete(txFor(blobSha));

    const code = await runClone(
      [RELAY, `${OWNER}/${REPO}`, '--json'],
      world.deps
    );
    expect(code).toBe(1);
    const doc = world.io.jsonDocs[0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      command: 'clone',
      error: 'missing_remote_objects',
    });
    expect(JSON.stringify(doc['missing'])).toContain(blobSha);
    const stderr = world.io.errLines.join('\n');
    expect(stderr).toContain(blobSha);
    expect(stderr).toContain('10-20 minutes');
    expect(stderr).toContain('Nothing was written');
    expect(existsSync(join(world.cwd, REPO))).toBe(false);
    expect(
      readdirSync(world.cwd).filter((name) => name.includes('.rig-clone-'))
    ).toEqual([]);
  });

  it('resolves SHAs absent from the arweave map through the GraphQL fallback', async () => {
    const srcDir = makeSourceRepo();
    const { announce, refsEvent, objects } = repoStateEvents({
      repoDir: srcDir,
      owner: OWNER,
      repoId: REPO,
    });
    const store = storeFromObjects(objects);
    // Strip one object from the MAP (not the store): only GraphQL can find it.
    const victim = objects.find(
      (o) => o.type === 'blob'
    ) as (typeof objects)[number];
    refsEvent.tags = refsEvent.tags.filter(
      (t) => !(t[0] === 'arweave' && t[1] === victim.sha)
    );
    const resolved: string[] = [];
    const gateway = makeMockGateway(store);
    const io = makeTestIo();
    const cwd = makeTempDir('toon-rig-clone-dst-');
    const code = await runClone([RELAY, `${OWNER}/${REPO}`], {
      io,
      env: {},
      cwd,
      webSocketFactory: makeMockRelayFactory((filter) =>
        filterEvents([announce, refsEvent], filter)
      ),
      fetchFn: gateway.fetchFn,
      resolveSha: async (sha, repo) => {
        resolved.push(sha);
        expect(repo).toBe(REPO);
        return sha === victim.sha ? txFor(sha) : null;
      },
    });
    expect(code).toBe(0);
    expect(resolved).toContain(victim.sha);
    expect(gitText(join(cwd, REPO), ['fsck', '--strict'])).toBe('');
  });
});
