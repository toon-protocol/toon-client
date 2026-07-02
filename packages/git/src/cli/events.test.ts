/**
 * `rig issue|comment|pr|status` command tests (#231).
 *
 * Same seams as the push tests: daemon mode is mocked at the HTTP layer (a
 * real in-process node:http server behind the loopback conventions),
 * standalone mode at the Publisher seam (injected StandaloneContext).
 * Covers: per-command wire payloads (kinds/tags), repo-address resolution
 * from the `toon.*` git config keys + the unconfigured error, confirm gating
 * with the quoted fee, `--json` shapes, real `git format-patch` integration
 * on a fixture repository, and the standalone single-relay refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { UnsignedEvent } from '../nip34-events.js';
import type { Publisher } from '../publisher.js';
import type { GitEventResponse } from '../routes.js';
import {
  extractPatchShas,
  runComment,
  runIssue,
  runPr,
  runStatus,
  type EventCommandDeps,
} from './events.js';
import { writeToonConfig } from './git-config.js';
import type { CliIo } from './push.js';
import type { StandaloneContext } from './standalone-context.js';

const OWNER = 'ab'.repeat(32);
const CONFIG_OWNER = 'cd'.repeat(32);
const ROOT_EVENT = '12'.repeat(32);
const EVENT_ID = 'ef'.repeat(32);

// ---------------------------------------------------------------------------
// Fixture repo
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
  const dir = mkdtempSync(join(tmpdir(), 'toon-rig-events-'));
  git(['init', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  return dir;
}

/** Add a second commit; returns [firstSha, secondSha]. */
function addSecondCommit(dir: string): [string, string] {
  const first = git(['rev-parse', 'HEAD'], dir);
  writeFileSync(join(dir, 'feature.txt'), 'the feature\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'second: add feature'], dir);
  const second = git(['rev-parse', 'HEAD'], dir);
  return [first, second];
}

// ---------------------------------------------------------------------------
// Fake daemon (real HTTP on loopback)
// ---------------------------------------------------------------------------

type RouteHandler = (body: unknown) => { status: number; body: unknown };
type Route = 'status' | 'issue' | 'comment' | 'patch' | 'gitstatus';

interface FakeDaemon {
  port: number;
  requests: { path: string; body: unknown }[];
  handlers: Partial<Record<Route, RouteHandler>>;
  close(): Promise<void>;
}

const HEALTHY_STATUS = {
  ready: true,
  identity: { nostrPubkey: OWNER },
  relay: { url: 'wss://relay.devnet.example' },
  feePerEvent: '7',
};

const ROUTE_BY_PATH: Record<string, Route> = {
  '/status': 'status',
  '/git/issue': 'issue',
  '/git/comment': 'comment',
  '/git/patch': 'patch',
  '/git/status': 'gitstatus',
};

function eventResponse(kind: number): GitEventResponse {
  return {
    eventId: EVENT_ID,
    feePaid: '7',
    kind,
    channelId: 'chan-1',
    nonce: 4,
    channelBalanceAfter: '993',
  };
}

function startFakeDaemon(): Promise<FakeDaemon> {
  const requests: FakeDaemon['requests'] = [];
  const handlers: FakeDaemon['handlers'] = {};
  let server: Server;
  const daemon: FakeDaemon = {
    port: 0,
    requests,
    handlers,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        requests.push({ path: req.url ?? '', body });
        const route = ROUTE_BY_PATH[req.url ?? ''];
        const handler = route ? handlers[route] : undefined;
        const result = handler
          ? handler(body)
          : route === 'status'
            ? { status: 200, body: HEALTHY_STATUS }
            : { status: 404, body: { error: 'not_found' } };
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      daemon.port = (server.address() as AddressInfo).port;
      resolve(daemon);
    });
  });
}

// ---------------------------------------------------------------------------
// Deps harness
// ---------------------------------------------------------------------------

interface Harness {
  deps: EventCommandDeps;
  out: string[];
  err: string[];
  confirms: string[];
}

function makeDeps(
  env: NodeJS.ProcessEnv,
  cwd: string,
  options: {
    interactive?: boolean;
    answer?: boolean;
    fetchImpl?: typeof fetch;
    loadStandalone?: EventCommandDeps['loadStandalone'];
    stdin?: string;
  } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const confirms: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: options.interactive ?? false,
    confirm: async (question) => {
      confirms.push(question);
      return options.answer ?? false;
    },
  };
  const deps: EventCommandDeps = {
    io,
    env,
    cwd,
    fetchImpl: options.fetchImpl ?? fetch,
    readStdin: async () => options.stdin ?? '',
    ...(options.loadStandalone
      ? { loadStandalone: options.loadStandalone }
      : {}),
  };
  return { deps, out, err, confirms };
}

const rejectingFetch = (async () => {
  throw new TypeError('fetch failed: ECONNREFUSED');
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Standalone fakes (the Publisher seam)
// ---------------------------------------------------------------------------

interface FakeStandalone {
  context: StandaloneContext;
  published: { event: UnsignedEvent; relayUrls: string[] }[];
  stopped: boolean;
}

function makeStandalone(): FakeStandalone {
  const published: FakeStandalone['published'] = [];
  const publisher: Publisher = {
    getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 3n }),
    uploadGitObject: async () => {
      throw new Error('single-event commands never upload objects');
    },
    publishEvent: async (event, relayUrls) => {
      published.push({ event, relayUrls });
      return { eventId: EVENT_ID, feePaid: 3n };
    },
  };
  const fake: FakeStandalone = {
    published,
    stopped: false,
    context: {
      ownerPubkey: OWNER,
      publisher,
      defaultRelayUrls: ['wss://standalone-relay.example'],
      fetchRemote: async () => {
        throw new Error('single-event commands never read remote state');
      },
      stop: async () => {
        fake.stopped = true;
      },
    },
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let repoDir: string;
let homeDir: string;
let daemon: FakeDaemon;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  repoDir = makeRepo();
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-eventshome-'));
  daemon = await startFakeDaemon();
  env = {
    TOON_CLIENT_HOME: homeDir,
    TOON_CLIENT_HTTP_PORT: String(daemon.port),
  };
  await writeToonConfig(repoDir, { repoId: 'demo', owner: CONFIG_OWNER });
});

afterEach(async () => {
  await daemon.close();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const issueRequest = (): unknown =>
  daemon.requests.find((r) => r.path === '/git/issue')?.body;

describe('rig issue create (daemon)', () => {
  beforeEach(() => {
    daemon.handlers.issue = () => ({ status: 200, body: eventResponse(1621) });
  });

  it('publishes via /git/issue with the config-resolved repo address', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runIssue(
      ['create', '--title', 'Fix the flux', '--body', 'It broke.', '--label', 'bug', '--label', 'ui', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    expect(issueRequest()).toEqual({
      repoAddr: { ownerPubkey: CONFIG_OWNER, repoId: 'demo' },
      title: 'Fix the flux',
      body: 'It broke.',
      labels: ['bug', 'ui'],
    });
    const text = h.out.join('\n');
    expect(text).toContain('kind:1621');
    expect(text).toContain('30617:' + CONFIG_OWNER + ':demo');
    expect(text).toContain('permanent and non-refundable');
    expect(text).toContain(`Published kind:1621 issue "Fix the flux": ${EVENT_ID}`);
    expect(text).toContain('paid 7 base units');
  });

  it('reads the body from --body-file', async () => {
    const bodyPath = join(repoDir, 'body.md');
    writeFileSync(bodyPath, '## from a file\n');
    const h = makeDeps(env, repoDir);
    const code = await runIssue(
      ['create', '--title', 't', '--body-file', bodyPath, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    expect(issueRequest()).toMatchObject({ body: '## from a file\n' });
  });

  it('reads the body from stdin when piped and no --body is given', async () => {
    const h = makeDeps(env, repoDir, { stdin: 'from stdin\n' });
    const code = await runIssue(['create', '--title', 't', '--yes'], h.deps);
    expect(code).toBe(0);
    expect(issueRequest()).toMatchObject({ body: 'from stdin\n' });
  });

  it('rejects an empty body (exit 2, nothing published)', async () => {
    const h = makeDeps(env, repoDir, { stdin: '  \n' });
    const code = await runIssue(['create', '--title', 't', '--yes'], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('body is empty');
    expect(issueRequest()).toBeUndefined();
  });

  it('requires --title and the create subcommand (exit 2 + usage)', async () => {
    const h = makeDeps(env, repoDir);
    expect(await runIssue(['create', '--body', 'b', '--yes'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--title is required');
    expect(await runIssue([], makeDeps(env, repoDir).deps)).toBe(2);
    expect(await runIssue(['open'], makeDeps(env, repoDir).deps)).toBe(2);
  });

  it('--repo-id and --owner override the git config address', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--yes', '--repo-id', 'other', '--owner', OWNER],
      h.deps
    );
    expect(code).toBe(0);
    expect(issueRequest()).toMatchObject({
      repoAddr: { ownerPubkey: OWNER, repoId: 'other' },
    });
  });

  it('rejects a non-hex --owner before doing anything (exit 2)', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--yes', '--owner', 'npub1notahexkey'],
      h.deps
    );
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('--owner');
    expect(daemon.requests).toHaveLength(0);
  });

  it('falls back to the daemon identity as owner when unconfigured', async () => {
    const bare = makeRepo(); // no toon.* config
    try {
      const h = makeDeps(env, bare);
      const code = await runIssue(
        ['create', '--title', 't', '--body', 'b', '--yes', '--repo-id', 'demo'],
        h.deps
      );
      expect(code).toBe(0);
      expect(issueRequest()).toMatchObject({
        repoAddr: { ownerPubkey: OWNER, repoId: 'demo' },
      });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('errors with remediation when no repo id is configured', async () => {
    const bare = makeRepo();
    try {
      const h = makeDeps(env, bare);
      const code = await runIssue(
        ['create', '--title', 't', '--body', 'b', '--yes'],
        h.deps
      );
      expect(code).toBe(1);
      const text = h.err.join('\n');
      expect(text).toContain('rig push');
      expect(text).toContain('--repo-id');
      expect(issueRequest()).toBeUndefined();

      const j = makeDeps(env, bare);
      expect(
        await runIssue(['create', '--title', 't', '--body', 'b', '--yes', '--json'], j.deps)
      ).toBe(1);
      expect(JSON.parse(j.out.join('\n'))).toMatchObject({
        command: 'issue',
        error: 'unconfigured_repo_address',
      });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('confirm gating', () => {
  beforeEach(() => {
    daemon.handlers.issue = () => ({ status: 200, body: eventResponse(1621) });
  });

  const args = ['create', '--title', 't', '--body', 'b'];

  it('refuses without --yes when not a TTY', async () => {
    const h = makeDeps(env, repoDir, { interactive: false });
    const code = await runIssue(args, h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('--yes');
    expect(issueRequest()).toBeUndefined();
  });

  it('aborts when the interactive prompt is declined (fee quoted)', async () => {
    const h = makeDeps(env, repoDir, { interactive: true, answer: false });
    const code = await runIssue(args, h.deps);
    expect(code).toBe(1);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain('7 base units');
    expect(h.err.join('\n')).toContain('aborted');
    expect(issueRequest()).toBeUndefined();
  });

  it('executes when the interactive prompt is accepted', async () => {
    const h = makeDeps(env, repoDir, { interactive: true, answer: true });
    const code = await runIssue(args, h.deps);
    expect(code).toBe(0);
    expect(issueRequest()).toBeDefined();
  });

  it('--json without --yes emits the estimate only and does not publish', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runIssue([...args, '--json'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'issue',
      mode: 'daemon',
      repoAddr: { ownerPubkey: CONFIG_OWNER, repoId: 'demo' },
      kind: 1621,
      executed: false,
      feeEstimate: '7',
    });
    expect(parsed['hint']).toContain('--yes');
    expect(issueRequest()).toBeUndefined();
  });

  it('--json --yes emits the receipt', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runIssue([...args, '--json', '--yes'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      executed: true,
      result: { eventId: EVENT_ID, feePaid: '7', kind: 1621 },
    });
  });
});

describe('rig comment (daemon)', () => {
  beforeEach(() => {
    daemon.handlers.comment = () => ({ status: 200, body: eventResponse(1622) });
  });

  it('publishes via /git/comment with the default root marker', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runComment([ROOT_EVENT, '--body', 'nice catch', '--yes'], h.deps);
    expect(code).toBe(0);
    expect(daemon.requests.find((r) => r.path === '/git/comment')?.body).toEqual({
      repoAddr: { ownerPubkey: CONFIG_OWNER, repoId: 'demo' },
      rootEventId: ROOT_EVENT,
      body: 'nice catch',
      marker: 'root',
    });
    expect(h.out.join('\n')).toContain('kind:1622');
  });

  it('passes --parent-author and --marker reply through', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runComment(
      [ROOT_EVENT, '--body', 'b', '--parent-author', OWNER, '--marker', 'reply', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    expect(daemon.requests.find((r) => r.path === '/git/comment')?.body).toMatchObject({
      parentAuthorPubkey: OWNER,
      marker: 'reply',
    });
  });

  it('validates the root event id, marker, and body (exit 2)', async () => {
    expect(await runComment(['not-hex', '--body', 'b'], makeDeps(env, repoDir).deps)).toBe(2);
    expect(
      await runComment([ROOT_EVENT, '--body', 'b', '--marker', 'sideways'], makeDeps(env, repoDir).deps)
    ).toBe(2);
    expect(await runComment([ROOT_EVENT], makeDeps(env, repoDir).deps)).toBe(2);
    expect(await runComment([], makeDeps(env, repoDir).deps)).toBe(2);
    expect(daemon.requests).toHaveLength(0);
  });
});

describe('rig pr create (daemon, real format-patch)', () => {
  beforeEach(() => {
    daemon.handlers.patch = () => ({ status: 200, body: eventResponse(1617) });
  });

  it('publishes real format-patch output for --range with commit tags', async () => {
    const [first, second] = addSecondCommit(repoDir);
    const h = makeDeps(env, repoDir);
    const code = await runPr(
      ['create', '--title', 'Add feature', '--range', `${first}..${second}`, '--branch', 'feature', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const body = daemon.requests.find((r) => r.path === '/git/patch')?.body as {
      repoAddr: unknown;
      title: string;
      patchText: string;
      commits: { sha: string; parentSha: string }[];
      branch: string;
    };
    expect(body.repoAddr).toEqual({ ownerPubkey: CONFIG_OWNER, repoId: 'demo' });
    expect(body.title).toBe('Add feature');
    expect(body.branch).toBe('feature');
    // REAL `git format-patch --stdout` output, not a placeholder.
    expect(body.patchText).toContain(`From ${second} `);
    expect(body.patchText).toContain('Subject: [PATCH] second: add feature');
    expect(body.patchText).toContain('+the feature');
    expect(body.commits).toEqual([{ sha: second, parentSha: first }]);
    expect(h.out.join('\n')).toContain('kind:1617');
  });

  it('carries every commit of a multi-commit range in one event', async () => {
    const [first] = addSecondCommit(repoDir);
    writeFileSync(join(repoDir, 'third.txt'), 'three\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'third'], repoDir);
    const h = makeDeps(env, repoDir);
    const code = await runPr(
      ['create', '--title', 'Series', '--range', `${first}..HEAD`, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const body = daemon.requests.find((r) => r.path === '/git/patch')?.body as {
      patchText: string;
      commits: unknown[];
    };
    expect(extractPatchShas(body.patchText)).toHaveLength(2);
    expect(body.patchText).toContain('Subject: [PATCH 1/2]');
    expect(body.patchText).toContain('Subject: [PATCH 2/2] third');
    expect(body.commits).toHaveLength(2);
  });

  it('publishes a --patch-file verbatim (no commit tags)', async () => {
    const patchPath = join(homeDir, 'my.patch');
    writeFileSync(patchPath, 'From 0000 fake\nSubject: [PATCH] literal\n');
    const h = makeDeps(env, repoDir);
    const code = await runPr(
      ['create', '--title', 'Literal', '--patch-file', patchPath, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const body = daemon.requests.find((r) => r.path === '/git/patch')?.body as Record<string, unknown>;
    expect(body['patchText']).toBe('From 0000 fake\nSubject: [PATCH] literal\n');
    expect(body).not.toHaveProperty('commits');
  });

  it('requires exactly one of --range | --patch-file (exit 2)', async () => {
    const h = makeDeps(env, repoDir);
    expect(await runPr(['create', '--title', 't'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('exactly one of --range or --patch-file');
    expect(
      await runPr(
        ['create', '--title', 't', '--range', 'a..b', '--patch-file', 'x'],
        makeDeps(env, repoDir).deps
      )
    ).toBe(2);
    expect(daemon.requests).toHaveLength(0);
  });

  it('errors when the range selects no commits (nothing published)', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runPr(
      ['create', '--title', 't', '--range', 'HEAD..HEAD', '--yes'],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('selects no commits');
    expect(daemon.requests.some((r) => r.path === '/git/patch')).toBe(false);
  });
});

describe('rig status (daemon)', () => {
  beforeEach(() => {
    daemon.handlers.gitstatus = () => ({ status: 200, body: eventResponse(1631) });
  });

  it('publishes via /git/status with the mapped wire value', async () => {
    const h = makeDeps(env, repoDir);
    const code = await runStatus([ROOT_EVENT, 'applied', '--yes'], h.deps);
    expect(code).toBe(0);
    expect(daemon.requests.find((r) => r.path === '/git/status')?.body).toEqual({
      repoAddr: { ownerPubkey: CONFIG_OWNER, repoId: 'demo' },
      targetEventId: ROOT_EVENT,
      status: 'applied',
    });
    const text = h.out.join('\n');
    expect(text).toContain('kind:1631');
    expect(text).toContain(EVENT_ID);
  });

  it('validates the state word and positional count (exit 2)', async () => {
    expect(await runStatus([ROOT_EVENT, 'merged'], makeDeps(env, repoDir).deps)).toBe(2);
    expect(await runStatus([ROOT_EVENT], makeDeps(env, repoDir).deps)).toBe(2);
    expect(await runStatus(['nothex', 'open'], makeDeps(env, repoDir).deps)).toBe(2);
    expect(daemon.requests).toHaveLength(0);
  });
});

describe('standalone mode (Publisher seam)', () => {
  it('builds and publishes the issue event locally (kind + tags)', async () => {
    const fake = makeStandalone();
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runIssue(
      ['create', '--title', 'Fix the flux', '--body', 'It broke.', '--label', 'bug', '--standalone', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
    const { event, relayUrls } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1621);
    expect(event.content).toBe('It broke.');
    expect(event.tags).toContainEqual(['a', `30617:${CONFIG_OWNER}:demo`]);
    expect(event.tags).toContainEqual(['subject', 'Fix the flux']);
    expect(event.tags).toContainEqual(['t', 'bug']);
    expect(relayUrls).toEqual(['wss://standalone-relay.example']);
    expect(fake.stopped).toBe(true);
    const text = h.out.join('\n');
    expect(text).toContain('standalone mode');
    expect(text).toContain(`Published kind:1621 issue "Fix the flux": ${EVENT_ID}`);
    expect(text).toContain('paid 3 base units');
  });

  it('quotes the standalone per-event fee in the confirm prompt', async () => {
    const fake = makeStandalone();
    const h = makeDeps(env, repoDir, {
      interactive: true,
      answer: false,
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--standalone'],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.confirms[0]).toContain('3 base units');
    expect(fake.published).toHaveLength(0);
  });

  it('appends the repo a-tag to standalone status events', async () => {
    const fake = makeStandalone();
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runStatus([ROOT_EVENT, 'closed', '--standalone', '--yes'], h.deps);
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1632);
    expect(event.tags).toContainEqual(['e', ROOT_EVENT]);
    expect(event.tags).toContainEqual(['a', `30617:${CONFIG_OWNER}:demo`]);
  });

  it('publishes the real patch text standalone with commit tags', async () => {
    const [first, second] = addSecondCommit(repoDir);
    const fake = makeStandalone();
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runPr(
      ['create', '--title', 'Add feature', '--range', `${first}..${second}`, '--standalone', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1617);
    expect(event.content).toContain('Subject: [PATCH] second: add feature');
    expect(event.tags).toContainEqual(['commit', second]);
    expect(event.tags).toContainEqual(['parent-commit', first]);
  });

  it('defaults the comment p-tag to the repo owner (daemon parity)', async () => {
    const fake = makeStandalone();
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runComment([ROOT_EVENT, '--body', 'b', '--standalone', '--yes'], h.deps);
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1622);
    expect(event.tags).toContainEqual(['e', ROOT_EVENT, '', 'root']);
    expect(event.tags).toContainEqual(['p', CONFIG_OWNER]);
  });

  it('refuses multi-relay configs before anything is paid', async () => {
    // A daemon-mode push can persist several relays; a later daemon outage +
    // mnemonic auto-selects standalone. The guard must fire pre-payment.
    await writeToonConfig(repoDir, {
      relays: ['wss://one.example', 'wss://two.example'],
    });
    const fake = makeStandalone();
    const h = makeDeps(
      { ...env, TOON_CLIENT_MNEMONIC: 'test test test' },
      repoDir,
      { fetchImpl: rejectingFetch, loadStandalone: async () => fake.context }
    );
    const code = await runIssue(['create', '--title', 't', '--body', 'b', '--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('single relay');
    expect(text).toContain('wss://one.example');
    expect(text).toContain('Nothing was published or paid');
    expect(fake.published).toHaveLength(0);
    expect(fake.stopped).toBe(true);
  });

  it('an explicit single --relay overrides the config default', async () => {
    const fake = makeStandalone();
    const h = makeDeps(env, repoDir, {
      fetchImpl: rejectingFetch,
      loadStandalone: async () => fake.context,
    });
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--standalone', '--yes', '--relay', 'wss://chosen.example'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.relayUrls).toEqual(['wss://chosen.example']);
  });
});

describe('error mapping', () => {
  it('402 insufficient_gas points at the funding flows and the command re-run', async () => {
    daemon.handlers.issue = () => ({
      status: 402,
      body: { error: 'insufficient_gas', detail: 'wallet has no gas', retryable: true },
    });
    const h = makeDeps(env, repoDir);
    const code = await runIssue(['create', '--title', 't', '--body', 'b', '--yes'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('toon_fund_wallet');
    expect(text).toContain('toon_open_channel');
    expect(text).toContain('re-run rig issue');
  });

  it('daemon-down with --daemon names the exact remediation', async () => {
    const h = makeDeps(env, repoDir, { fetchImpl: rejectingFetch });
    const code = await runComment(
      [ROOT_EVENT, '--body', 'b', '--daemon', '--yes'],
      h.deps
    );
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('toon-clientd');
    expect(text).toContain('--standalone');
  });

  it('--json emits a machine-readable error envelope', async () => {
    daemon.handlers.gitstatus = () => ({
      status: 503,
      body: { error: 'bootstrapping', detail: 'channel coming up', retryable: true },
    });
    const h = makeDeps(env, repoDir);
    const code = await runStatus([ROOT_EVENT, 'open', '--json', '--yes'], h.deps);
    expect(code).toBe(1);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      command: 'status',
      error: 'bootstrapping',
      status: 503,
    });
  });
});

describe('usage', () => {
  it('per-command --help prints usage and exits 0 without publishing', async () => {
    for (const [run, args, needle] of [
      [runIssue, ['create', '--help'], '--body-file'],
      [runIssue, ['--help'], '--body-file'],
      [runComment, ['--help'], '--parent-author'],
      [runPr, ['create', '--help'], '--patch-file'],
      [runPr, ['--help'], 'cover-letter'],
      [runStatus, ['--help'], 'open|applied|closed|draft'],
    ] as const) {
      const h = makeDeps(env, repoDir);
      expect(await run(args as unknown as string[], h.deps)).toBe(0);
      expect(h.out.join('\n')).toContain(needle);
    }
    expect(daemon.requests).toHaveLength(0);
  });

  it('rejects unknown flags with usage (exit 2)', async () => {
    const h = makeDeps(env, repoDir);
    expect(await runStatus([ROOT_EVENT, 'open', '--frobnicate'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig status');
  });
});
