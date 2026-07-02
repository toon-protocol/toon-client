/**
 * `rig fetch` tests (#278): the delta pipeline against an existing clone —
 * only missing objects are downloaded, remote-tracking refs move like
 * `git fetch` (new / fast-forward / forced / up-to-date), and failure modes
 * mirror clone's (missing objects are honest and nothing half-lands).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearShaCache } from '@toon-protocol/arweave';
import type { NostrEvent } from '../remote-state.js';
import { runClone } from './clone.js';
import { runFetch } from './fetch.js';
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
    },
  }).trim();
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

/** Source repo + mock relay/gateway whose state can be re-published. */
class World {
  readonly srcDir: string;
  readonly events: NostrEvent[] = [];
  readonly store = new Map<string, Uint8Array>();
  readonly gateway = makeMockGateway(this.store);
  private version = 0;

  constructor() {
    this.srcDir = makeTempDir('toon-rig-fetch-src-');
    git(['init', '--initial-branch=main'], this.srcDir);
    writeFileSync(join(this.srcDir, 'README.md'), '# demo\n');
    git(['add', '.'], this.srcDir);
    git(['commit', '-m', 'first'], this.srcDir);
    this.publish();
  }

  /** Re-derive the 30617/30618 events + gateway store from the source repo. */
  publish(): void {
    this.version += 1;
    const { announce, refsEvent, objects } = repoStateEvents({
      repoDir: this.srcDir,
      owner: OWNER,
      repoId: REPO,
      createdAt: 1000 + this.version,
    });
    this.events.length = 0;
    this.events.push(announce, refsEvent);
    for (const [txId, bytes] of storeFromObjects(objects)) {
      this.store.set(txId, bytes);
    }
  }

  deps(io: TestIo, cwd: string): ReadCommandDeps {
    return {
      io,
      env: {},
      cwd,
      webSocketFactory: makeMockRelayFactory((filter) =>
        filterEvents(this.events, filter)
      ),
      fetchFn: this.gateway.fetchFn,
      resolveSha: async () => null,
    };
  }

  /** Clone the current state; returns the clone directory. */
  async clone(): Promise<string> {
    const cwd = makeTempDir('toon-rig-fetch-dst-');
    const io = makeTestIo();
    const code = await runClone(
      [RELAY, `${OWNER}/${REPO}`],
      this.deps(io, cwd)
    );
    expect(code).toBe(0);
    return join(cwd, REPO);
  }
}

describe('rig fetch', () => {
  it('downloads only the delta and updates remote-tracking refs', async () => {
    const world = new World();
    const cloneDir = await world.clone();
    const oldMain = gitText(world.srcDir, ['rev-parse', 'main']);

    // Advance the source: one commit on main + a new branch, republished.
    writeFileSync(join(world.srcDir, 'new.txt'), 'delta\n');
    git(['add', '.'], world.srcDir);
    git(['commit', '-m', 'second'], world.srcDir);
    git(['branch', 'topic'], world.srcDir);
    world.publish();
    const newMain = gitText(world.srcDir, ['rev-parse', 'main']);

    world.gateway.requests.length = 0;
    const io = makeTestIo();
    const code = await runFetch(['--json'], world.deps(io, cloneDir));
    expect(code).toBe(0);

    const doc = io.jsonDocs[0] as {
      objectsDownloaded: number;
      updates: {
        refname: string;
        localRef: string;
        kind: string;
        newSha: string;
      }[];
    };
    // Delta only: 1 commit + 1 tree + 1 blob (README unchanged = reused).
    expect(doc.objectsDownloaded).toBe(3);
    expect(doc.updates).toContainEqual(
      expect.objectContaining({
        refname: 'refs/heads/main',
        localRef: 'refs/remotes/origin/main',
        kind: 'fast-forward',
        newSha: newMain,
      })
    );
    expect(doc.updates).toContainEqual(
      expect.objectContaining({
        refname: 'refs/heads/topic',
        localRef: 'refs/remotes/origin/topic',
        kind: 'new',
      })
    );

    // The tracking refs really moved; the local branch did NOT (no merge).
    expect(gitText(cloneDir, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      newMain
    );
    expect(gitText(cloneDir, ['rev-parse', 'refs/heads/main'])).toBe(oldMain);
    // Fetched objects are real: the new commit is readable.
    expect(gitText(cloneDir, ['cat-file', '-t', newMain])).toBe('commit');
    expect(gitText(cloneDir, ['fsck', '--strict'])).toBe('');
  });

  it('is idempotent: a second fetch reports up to date and downloads nothing', async () => {
    const world = new World();
    const cloneDir = await world.clone();

    const first = makeTestIo();
    expect(await runFetch([], world.deps(first, cloneDir))).toBe(0);

    world.gateway.requests.length = 0;
    const second = makeTestIo();
    expect(await runFetch([], world.deps(second, cloneDir))).toBe(0);
    expect(second.outLines.join('\n')).toContain('Already up to date.');
    expect(world.gateway.requests).toEqual([]);
  });

  it('reports missing delta objects honestly and updates no refs', async () => {
    const world = new World();
    const cloneDir = await world.clone();

    writeFileSync(join(world.srcDir, 'new.txt'), 'delta\n');
    git(['add', '.'], world.srcDir);
    git(['commit', '-m', 'second'], world.srcDir);
    world.publish();
    const newMain = gitText(world.srcDir, ['rev-parse', 'main']);
    world.store.delete(txFor(newMain)); // the new commit hasn't propagated

    const io = makeTestIo();
    const code = await runFetch(['--json'], world.deps(io, cloneDir));
    expect(code).toBe(1);
    expect(io.jsonDocs[0]).toMatchObject({
      command: 'fetch',
      error: 'missing_remote_objects',
    });
    expect(io.errLines.join('\n')).toContain('10-20 minutes');
    // No tracking ref moved.
    const tracking = gitText(cloneDir, [
      'rev-parse',
      'refs/remotes/origin/main',
    ]);
    expect(tracking).not.toBe(newMain);
  });

  it('fails clearly outside a configured repo / with an unknown remote', async () => {
    const world = new World();
    const cloneDir = await world.clone();

    const io = makeTestIo();
    const code = await runFetch(
      ['upstream', '--json'],
      world.deps(io, cloneDir)
    );
    expect(code).toBe(1);
    expect(io.jsonDocs[0]).toMatchObject({
      command: 'fetch',
      error: 'unknown_remote',
      remote: 'upstream',
    });
  });
});
