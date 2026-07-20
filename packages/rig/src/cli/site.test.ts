/**
 * `rig site publish|url` tests (#368). The publisher is mocked at the
 * Publisher seam (an injected StandaloneContext) — NO real network, NO real
 * money. Covers: the estimate→confirm→execute discipline, the strict `--json`
 * contract, `--yes`/non-TTY gating, the manifest build (paths → txids,
 * index/fallback), `--force-reupload` (re-pay through the mime-typed
 * git-object path), and the free `site url` record lookup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Publisher, UploadReceipt } from '../publisher.js';
import type { RemoteState } from '../remote-state.js';
import { GitRepoReader } from '../repo-reader.js';
import { writeToonConfig } from './git-config.js';
import type { CliIo, PushDeps } from './push.js';
import { runSite } from './site.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const MANIFEST_TX = 'M'.repeat(43);
const RELAY = 'wss://relay.example';

// ---------------------------------------------------------------------------
// Fixture repo (index.html + a nested asset)
// ---------------------------------------------------------------------------

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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'toon-rig-site-'));
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>\n');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'site'], dir);
  return dir;
}

/** Fixture repo with NO index.html (#398 repro). */
function makeRepoNoIndex(): string {
  const dir = mkdtempSync(join(tmpdir(), 'toon-rig-site-noindex-'));
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'no index'], dir);
  return dir;
}

/** The repo's blob shas keyed by path (via the real reader). */
async function blobsOf(dir: string): Promise<Map<string, string>> {
  const reader = new GitRepoReader(dir);
  const blobs = await reader.listBlobs('refs/heads/main');
  return new Map(blobs.map((b) => [b.path, b.sha]));
}

/** A valid 43-char base64url txid derived from a sha (deterministic). */
function txFor(sha: string): string {
  return sha.padEnd(43, 'A');
}

// ---------------------------------------------------------------------------
// Deps + fake standalone (Publisher seam)
// ---------------------------------------------------------------------------

interface Harness {
  deps: PushDeps;
  out: string[];
  err: string[];
  uploadBlobBodies: Buffer[];
  gitUploads: { sha: string; path?: string }[];
}

function makeRemoteState(shaToTxId: Map<string, string>): RemoteState {
  return {
    announced: true,
    refs: new Map(),
    headSymref: null,
    shaToTxId,
    refsEvent: null,
    announceEvent: null,
    name: null,
    description: null,
    relays: [],
    maintainers: [],
    resolveMissing: async (shas) => {
      const out = new Map<string, string>();
      for (const s of shas) {
        const tx = shaToTxId.get(s);
        if (tx) out.set(s, tx);
      }
      return out;
    },
  };
}

function makeDeps(
  env: NodeJS.ProcessEnv,
  cwd: string,
  shaToTxId: Map<string, string>,
  opts: { interactive?: boolean; answer?: boolean; hasUploadBlob?: boolean } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const uploadBlobBodies: Buffer[] = [];
  const gitUploads: { sha: string; path?: string }[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    emitJson: (p) => out.push(JSON.stringify(p, null, 2)),
    isInteractive: opts.interactive ?? false,
    confirm: async () => opts.answer ?? false,
  };
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 1n }),
    uploadGitObject: async (u): Promise<UploadReceipt> => {
      gitUploads.push({ sha: u.sha, ...(u.path ? { path: u.path } : {}) });
      // A FRESH txid on re-upload (proves the manifest uses the new one).
      return { txId: u.sha.padEnd(43, 'N'), feePaid: BigInt(u.body.length) * 10n };
    },
    publishEvent: async () => ({ eventId: 'e'.repeat(64), feePaid: 1n }),
  };
  if (opts.hasUploadBlob !== false) {
    publisher.uploadBlob = async (u): Promise<UploadReceipt> => {
      uploadBlobBodies.push(u.body);
      return { txId: MANIFEST_TX, feePaid: BigInt(u.body.length) * 10n };
    };
  }
  const context: StandaloneContext = {
    ownerPubkey: OWNER,
    identitySource: 'env',
    identitySourceLabel: 'RIG_MNEMONIC env',
    publisher,
    defaultRelayUrls: [RELAY],
    fetchRemote: async () => makeRemoteState(shaToTxId),
    stop: async () => undefined,
  };
  const load: PushDeps['loadStandalone'] = async (_o: StandaloneLoadOptions) =>
    context;
  const deps: PushDeps = { io, env, cwd, loadStandalone: load };
  return { deps, out, err, uploadBlobBodies, gitUploads };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let repoDir: string;
let homeDir: string;
let env: NodeJS.ProcessEnv;
let shaByPath: Map<string, string>;
let fullMap: Map<string, string>;

beforeEach(async () => {
  repoDir = makeRepo();
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-sitehome-'));
  env = { TOON_CLIENT_HOME: homeDir };
  await writeToonConfig(repoDir, { repoId: 'demo', owner: OWNER });
  shaByPath = await blobsOf(repoDir);
  // The "already pushed" arweave map: every blob has a txid.
  fullMap = new Map(
    [...shaByPath.values()].map((sha) => [sha, txFor(sha)] as const)
  );
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('site publish — estimate → confirm gate', () => {
  it('--json without --yes is a pure estimate (nothing uploaded)', async () => {
    const h = makeDeps(env, repoDir, fullMap);
    const code = await runSite(['publish', '--relay', RELAY, '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n'));
    expect(doc).toMatchObject({
      command: 'site publish',
      repoId: 'demo',
      executed: false,
      fileCount: 2,
      index: 'index.html',
    });
    expect(doc.estimate.manifestBytes).toBeGreaterThan(0);
    expect(doc.estimate.totalFee).toMatch(/^\d+$/);
    expect(h.uploadBlobBodies).toHaveLength(0);
  });

  it('non-TTY without --yes refuses to spend (exit 1, nothing uploaded)', async () => {
    const h = makeDeps(env, repoDir, fullMap, { interactive: false });
    const code = await runSite(['publish', '--relay', RELAY], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('--yes');
    expect(h.uploadBlobBodies).toHaveLength(0);
  });

  it('interactive confirm (answer yes) uploads the manifest', async () => {
    const h = makeDeps(env, repoDir, fullMap, {
      interactive: true,
      answer: true,
    });
    const code = await runSite(['publish', '--relay', RELAY], h.deps);
    expect(code).toBe(0);
    expect(h.uploadBlobBodies).toHaveLength(1);
    expect(h.out.join('\n')).toContain(`/${MANIFEST_TX}/`);
  });
});

describe('site publish — execute', () => {
  it('--yes uploads ONE manifest blob and prints the URL + name hint', async () => {
    const h = makeDeps(env, repoDir, fullMap);
    const code = await runSite(
      ['publish', '--relay', RELAY, '--yes', '--json'],
      h.deps
    );
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n'));
    expect(doc).toMatchObject({
      command: 'site publish',
      executed: true,
      manifest: { txId: MANIFEST_TX, url: `https://arweave.net/${MANIFEST_TX}/` },
    });
    expect(doc.nameHint).toContain(`rig name set <name> ${MANIFEST_TX}`);
    expect(h.uploadBlobBodies).toHaveLength(1);
    expect(h.gitUploads).toHaveLength(0); // no re-upload without the flag

    // The manifest content: correct type, index, and path→known-txid join.
    const manifest = JSON.parse(h.uploadBlobBodies[0]!.toString('utf8'));
    expect(manifest.manifest).toBe('arweave/paths');
    expect(manifest.index).toEqual({ path: 'index.html' });
    expect(manifest.paths['index.html']).toEqual({
      id: txFor(shaByPath.get('index.html')!),
    });
    expect(manifest.paths['assets/app.js']).toEqual({
      id: txFor(shaByPath.get('assets/app.js')!),
    });
    expect(manifest.fallback).toBeUndefined();
  });

  it('--spa sets the manifest fallback to the index txid', async () => {
    const h = makeDeps(env, repoDir, fullMap);
    await runSite(['publish', '--relay', RELAY, '--spa', '--yes'], h.deps);
    const manifest = JSON.parse(h.uploadBlobBodies[0]!.toString('utf8'));
    expect(manifest.fallback).toEqual({
      id: txFor(shaByPath.get('index.html')!),
    });
  });

  it('--gateway overrides the printed URL host', async () => {
    const h = makeDeps(env, repoDir, fullMap);
    await runSite(
      ['publish', '--relay', RELAY, '--gateway', 'https://ar-io.dev/', '--yes'],
      h.deps
    );
    expect(h.out.join('\n')).toContain(`https://ar-io.dev/${MANIFEST_TX}/`);
  });
});

describe('site publish — pre-existing blobs / --force-reupload', () => {
  it('errors when a file is not yet on Arweave (no --force-reupload)', async () => {
    const h = makeDeps(env, repoDir, new Map()); // empty arweave map
    const code = await runSite(
      ['publish', '--relay', RELAY, '--yes', '--json'],
      h.deps
    );
    expect(code).toBe(1);
    const doc = JSON.parse(h.out.join('\n'));
    expect(doc).toMatchObject({ command: 'site publish', error: 'error' });
    expect(h.err.join('\n')).toMatch(/not on Arweave yet|rig push/);
    expect(h.uploadBlobBodies).toHaveLength(0);
  });

  it('--force-reupload re-uploads blobs (mime-typed) and uses the fresh txids', async () => {
    const h = makeDeps(env, repoDir, new Map()); // nothing pre-published
    const code = await runSite(
      ['publish', '--relay', RELAY, '--force-reupload', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    // Both blobs re-uploaded, index.html carried its path (→ text/html).
    expect(h.gitUploads).toHaveLength(2);
    const indexUpload = h.gitUploads.find((u) => u.path === 'index.html');
    expect(indexUpload).toBeDefined();
    // The manifest references the FRESH re-upload txids (…N-padded), not the
    // (absent) old map.
    const manifest = JSON.parse(h.uploadBlobBodies[0]!.toString('utf8'));
    expect(manifest.paths['index.html'].id).toBe(
      shaByPath.get('index.html')!.padEnd(43, 'N')
    );
  });
});

describe('site publish — missing index (#398)', () => {
  it('omits the manifest index and warns loudly when no index.html exists', async () => {
    const dir = makeRepoNoIndex();
    try {
      await writeToonConfig(dir, { repoId: 'demo', owner: OWNER });
      const shas = await blobsOf(dir);
      const map = new Map(
        [...shas.values()].map((sha) => [sha, txFor(sha)] as const)
      );
      const h = makeDeps(env, dir, map);
      const code = await runSite(
        ['publish', '--relay', RELAY, '--yes', '--json'],
        h.deps
      );
      expect(code).toBe(0);
      expect(h.err.join('\n')).toMatch(/no "index\.html".*404|no index\.html/i);

      const manifest = JSON.parse(h.uploadBlobBodies[0]!.toString('utf8'));
      expect(manifest.index).toBeUndefined();
      expect(manifest.paths['README.md']).toEqual({
        id: txFor(shas.get('README.md')!),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--index <path> sets a present path as the manifest index', async () => {
    const dir = makeRepoNoIndex();
    try {
      await writeToonConfig(dir, { repoId: 'demo', owner: OWNER });
      const shas = await blobsOf(dir);
      const map = new Map(
        [...shas.values()].map((sha) => [sha, txFor(sha)] as const)
      );
      const h = makeDeps(env, dir, map);
      const code = await runSite(
        ['publish', '--relay', RELAY, '--index', 'README.md', '--yes'],
        h.deps
      );
      expect(code).toBe(0);
      expect(h.err.join('\n')).not.toMatch(/no.*index/i);

      const manifest = JSON.parse(h.uploadBlobBodies[0]!.toString('utf8'));
      expect(manifest.index).toEqual({ path: 'README.md' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('site url (free lookup)', () => {
  it('errors before any publish, then returns the URL after publishing', async () => {
    // Nothing recorded yet.
    const miss = makeDeps(env, repoDir, fullMap);
    const code1 = await runSite(['url', '--json'], miss.deps);
    expect(code1).toBe(1);
    expect(JSON.parse(miss.out.join('\n'))).toMatchObject({
      command: 'site url',
      found: false,
    });

    // Publish, then look up.
    const pub = makeDeps(env, repoDir, fullMap);
    await runSite(['publish', '--relay', RELAY, '--yes'], pub.deps);

    const hit = makeDeps(env, repoDir, fullMap);
    const code2 = await runSite(['url', '--json'], hit.deps);
    expect(code2).toBe(0);
    expect(JSON.parse(hit.out.join('\n'))).toMatchObject({
      command: 'site url',
      found: true,
      manifestTxId: MANIFEST_TX,
      url: `https://arweave.net/${MANIFEST_TX}/`,
    });
  });

  it('plain (non-json) url prints just the URL', async () => {
    const pub = makeDeps(env, repoDir, fullMap);
    await runSite(['publish', '--relay', RELAY, '--yes'], pub.deps);
    const hit = makeDeps(env, repoDir, fullMap);
    await runSite(['url'], hit.deps);
    expect(hit.out).toEqual([`https://arweave.net/${MANIFEST_TX}/`]);
  });
});

describe('site — usage + errors', () => {
  it('unknown subcommand exits 2 with usage', async () => {
    const h = makeDeps(env, repoDir, fullMap);
    expect(await runSite(['bogus'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig site');
  });

  it('unconfigured repo errors with the rig init remediation', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'toon-rig-site-bare-'));
    git(['init', '--initial-branch=main'], bare);
    writeFileSync(join(bare, 'index.html'), 'x\n');
    git(['add', '.'], bare);
    git(['commit', '-m', 'c'], bare);
    try {
      const h = makeDeps(env, bare, fullMap);
      const code = await runSite(['publish', '--relay', RELAY, '--json'], h.deps);
      expect(code).toBe(1);
      expect(JSON.parse(h.out.join('\n'))).toMatchObject({
        error: 'unconfigured_repo_address',
      });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
