/**
 * `rig issue|comment|pr|status` command tests (#231; standalone-only since
 * #248).
 *
 * Same seam as the push tests: the publisher is mocked at the Publisher seam
 * (injected StandaloneContext). Covers: per-command event payloads
 * (kinds/tags), repo-address resolution from the `toon.*` git config keys
 * `rig init` writes + the "run rig init" unconfigured error, confirm gating
 * with the quoted fee, `--json` shapes (incl. the identity report), real
 * `git format-patch` integration on a fixture repository, and the
 * single-relay refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnsignedEvent } from '../nip34-events.js';
import type { Publisher } from '../publisher.js';
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
    readStdin: async () => options.stdin ?? '',
    ...(options.loadStandalone
      ? { loadStandalone: options.loadStandalone }
      : {}),
  };
  return { deps, out, err, confirms };
}

// ---------------------------------------------------------------------------
// Standalone fakes (the Publisher seam)
// ---------------------------------------------------------------------------

interface FakeStandalone {
  context: StandaloneContext;
  published: { event: UnsignedEvent; relayUrls: string[] }[];
  stopped: boolean;
  load: EventCommandDeps['loadStandalone'];
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
    load: async () => fake.context,
    context: {
      ownerPubkey: OWNER,
      identitySource: 'dotenv',
      identitySourceLabel: '/repo/.env',
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
let env: NodeJS.ProcessEnv;
let fake: FakeStandalone;

beforeEach(async () => {
  repoDir = makeRepo();
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-eventshome-'));
  env = { TOON_CLIENT_HOME: homeDir };
  fake = makeStandalone();
  await writeToonConfig(repoDir, { repoId: 'demo', owner: CONFIG_OWNER });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

const deps = (options: Parameters<typeof makeDeps>[2] = {}): Harness =>
  makeDeps(env, repoDir, { loadStandalone: fake.load, ...options });

describe('rig issue create', () => {
  it('publishes the issue event with the config-resolved repo address', async () => {
    const h = deps();
    const code = await runIssue(
      ['create', '--title', 'Fix the flux', '--body', 'It broke.', '--label', 'bug', '--label', 'ui', '--yes'],
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
    expect(event.tags).toContainEqual(['t', 'ui']);
    expect(relayUrls).toEqual(['wss://standalone-relay.example']);
    expect(fake.stopped).toBe(true);

    const text = h.out.join('\n');
    expect(text).toContain('kind:1621');
    expect(text).toContain('30617:' + CONFIG_OWNER + ':demo');
    expect(text).toContain(`Identity: ${OWNER} (from /repo/.env)`);
    expect(text).toContain('permanent and non-refundable');
    expect(text).toContain(`Published kind:1621 issue "Fix the flux": ${EVENT_ID}`);
    expect(text).toContain('paid 3 base units');
  });

  it('reads the body from --body-file', async () => {
    const bodyPath = join(repoDir, 'body.md');
    writeFileSync(bodyPath, '## from a file\n');
    const h = deps();
    const code = await runIssue(
      ['create', '--title', 't', '--body-file', bodyPath, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.event.content).toBe('## from a file\n');
  });

  it('reads the body from stdin when piped and no --body is given', async () => {
    const h = deps({ stdin: 'from stdin\n' });
    const code = await runIssue(['create', '--title', 't', '--yes'], h.deps);
    expect(code).toBe(0);
    expect(fake.published[0]?.event.content).toBe('from stdin\n');
  });

  it('rejects an empty body (exit 2, nothing published)', async () => {
    const h = deps({ stdin: '  \n' });
    const code = await runIssue(['create', '--title', 't', '--yes'], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('body is empty');
    expect(fake.published).toHaveLength(0);
  });

  it('requires --title and the create subcommand (exit 2 + usage)', async () => {
    const h = deps();
    expect(await runIssue(['create', '--body', 'b', '--yes'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--title is required');
    expect(await runIssue([], deps().deps)).toBe(2);
    expect(await runIssue(['open'], deps().deps)).toBe(2);
    expect(fake.published).toHaveLength(0);
  });

  it('--repo-id and --owner override the git config address', async () => {
    const h = deps();
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--yes', '--repo-id', 'other', '--owner', OWNER],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.event.tags).toContainEqual([
      'a',
      `30617:${OWNER}:other`,
    ]);
  });

  it('rejects a non-hex --owner before doing anything (exit 2)', async () => {
    const h = deps();
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--yes', '--owner', 'npub1notahexkey'],
      h.deps
    );
    expect(code).toBe(2);
    expect(h.err.join('\n')).toContain('--owner');
    expect(fake.published).toHaveLength(0);
  });

  it('falls back to the active identity as owner when unconfigured', async () => {
    const bare = makeRepo(); // no toon.* config
    try {
      const h = makeDeps(env, bare, { loadStandalone: fake.load });
      const code = await runIssue(
        ['create', '--title', 't', '--body', 'b', '--yes', '--repo-id', 'demo'],
        h.deps
      );
      expect(code).toBe(0);
      expect(fake.published[0]?.event.tags).toContainEqual([
        'a',
        `30617:${OWNER}:demo`,
      ]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('errors with the rig init remediation when no repo id is configured', async () => {
    const bare = makeRepo();
    try {
      const h = makeDeps(env, bare, { loadStandalone: fake.load });
      const code = await runIssue(
        ['create', '--title', 't', '--body', 'b', '--yes'],
        h.deps
      );
      expect(code).toBe(1);
      const text = h.err.join('\n');
      expect(text).toContain('rig init');
      expect(text).toContain('--repo-id');
      expect(fake.published).toHaveLength(0);

      const j = makeDeps(env, bare, { loadStandalone: fake.load });
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
  const args = ['create', '--title', 't', '--body', 'b'];

  it('refuses without --yes when not a TTY', async () => {
    const h = deps({ interactive: false });
    const code = await runIssue(args, h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('--yes');
    expect(fake.published).toHaveLength(0);
  });

  it('aborts when the interactive prompt is declined (fee quoted)', async () => {
    const h = deps({ interactive: true, answer: false });
    const code = await runIssue(args, h.deps);
    expect(code).toBe(1);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain('3 base units');
    expect(h.err.join('\n')).toContain('aborted');
    expect(fake.published).toHaveLength(0);
  });

  it('executes when the interactive prompt is accepted', async () => {
    const h = deps({ interactive: true, answer: true });
    const code = await runIssue(args, h.deps);
    expect(code).toBe(0);
    expect(fake.published).toHaveLength(1);
  });

  it('--json without --yes emits the estimate (with identity) and does not publish', async () => {
    const h = deps();
    const code = await runIssue([...args, '--json'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'issue',
      repoAddr: { ownerPubkey: CONFIG_OWNER, repoId: 'demo' },
      identity: { pubkey: OWNER, source: 'dotenv', sourceLabel: '/repo/.env' },
      kind: 1621,
      executed: false,
      feeEstimate: '3',
    });
    expect(parsed['hint']).toContain('--yes');
    expect(fake.published).toHaveLength(0);
  });

  it('--json --yes emits the receipt', async () => {
    const h = deps();
    const code = await runIssue([...args, '--json', '--yes'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      executed: true,
      result: { eventId: EVENT_ID, feePaid: '3', kind: 1621 },
    });
  });
});

describe('rig comment', () => {
  it('publishes kind:1622 with the default root marker and owner p-tag', async () => {
    const h = deps();
    const code = await runComment([ROOT_EVENT, '--body', 'nice catch', '--yes'], h.deps);
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1622);
    expect(event.content).toBe('nice catch');
    expect(event.tags).toContainEqual(['e', ROOT_EVENT, '', 'root']);
    expect(event.tags).toContainEqual(['p', CONFIG_OWNER]);
    expect(event.tags).toContainEqual(['a', `30617:${CONFIG_OWNER}:demo`]);
    expect(h.out.join('\n')).toContain('kind:1622');
  });

  it('passes --parent-author and --marker reply through', async () => {
    const h = deps();
    const code = await runComment(
      [ROOT_EVENT, '--body', 'b', '--parent-author', OWNER, '--marker', 'reply', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.tags).toContainEqual(['e', ROOT_EVENT, '', 'reply']);
    expect(event.tags).toContainEqual(['p', OWNER]);
  });

  it('validates the root event id, marker, and body (exit 2)', async () => {
    expect(await runComment(['not-hex', '--body', 'b'], deps().deps)).toBe(2);
    expect(
      await runComment([ROOT_EVENT, '--body', 'b', '--marker', 'sideways'], deps().deps)
    ).toBe(2);
    expect(await runComment([ROOT_EVENT], deps().deps)).toBe(2);
    expect(await runComment([], deps().deps)).toBe(2);
    expect(fake.published).toHaveLength(0);
  });
});

describe('rig pr create (real format-patch)', () => {
  it('publishes real format-patch output for --range with commit tags', async () => {
    const [first, second] = addSecondCommit(repoDir);
    const h = deps();
    const code = await runPr(
      ['create', '--title', 'Add feature', '--range', `${first}..${second}`, '--branch', 'feature', '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1617);
    // REAL `git format-patch --stdout` output, not a placeholder.
    expect(event.content).toContain(`From ${second} `);
    expect(event.content).toContain('Subject: [PATCH] second: add feature');
    expect(event.content).toContain('+the feature');
    expect(event.tags).toContainEqual(['commit', second]);
    expect(event.tags).toContainEqual(['parent-commit', first]);
    expect(event.tags).toContainEqual(['t', 'feature']);
    expect(h.out.join('\n')).toContain('kind:1617');
  });

  it('carries every commit of a multi-commit range in one event', async () => {
    const [first] = addSecondCommit(repoDir);
    writeFileSync(join(repoDir, 'third.txt'), 'three\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'third'], repoDir);
    const h = deps();
    const code = await runPr(
      ['create', '--title', 'Series', '--range', `${first}..HEAD`, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(extractPatchShas(event.content)).toHaveLength(2);
    expect(event.content).toContain('Subject: [PATCH 1/2]');
    expect(event.content).toContain('Subject: [PATCH 2/2] third');
    expect(event.tags.filter((t) => t[0] === 'commit')).toHaveLength(2);
  });

  it('publishes a --patch-file verbatim (no commit tags)', async () => {
    const patchPath = join(homeDir, 'my.patch');
    writeFileSync(patchPath, 'From 0000 fake\nSubject: [PATCH] literal\n');
    const h = deps();
    const code = await runPr(
      ['create', '--title', 'Literal', '--patch-file', patchPath, '--yes'],
      h.deps
    );
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.content).toBe('From 0000 fake\nSubject: [PATCH] literal\n');
    expect(event.tags.filter((t) => t[0] === 'commit')).toHaveLength(0);
  });

  it('requires exactly one of --range | --patch-file (exit 2)', async () => {
    const h = deps();
    expect(await runPr(['create', '--title', 't'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('exactly one of --range or --patch-file');
    expect(
      await runPr(
        ['create', '--title', 't', '--range', 'a..b', '--patch-file', 'x'],
        deps().deps
      )
    ).toBe(2);
    expect(fake.published).toHaveLength(0);
  });

  it('errors when the range selects no commits (nothing published)', async () => {
    const h = deps();
    const code = await runPr(
      ['create', '--title', 't', '--range', 'HEAD..HEAD', '--yes'],
      h.deps
    );
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('selects no commits');
    expect(fake.published).toHaveLength(0);
  });
});

describe('rig status', () => {
  it('publishes the mapped status kind with the repo a-tag', async () => {
    const h = deps();
    const code = await runStatus([ROOT_EVENT, 'applied', '--yes'], h.deps);
    expect(code).toBe(0);
    const { event } = fake.published[0] as FakeStandalone['published'][0];
    expect(event.kind).toBe(1631);
    expect(event.tags).toContainEqual(['e', ROOT_EVENT]);
    expect(event.tags).toContainEqual(['a', `30617:${CONFIG_OWNER}:demo`]);
    const text = h.out.join('\n');
    expect(text).toContain('kind:1631');
    expect(text).toContain(EVENT_ID);
  });

  it('maps closed to kind:1632', async () => {
    const h = deps();
    const code = await runStatus([ROOT_EVENT, 'closed', '--yes'], h.deps);
    expect(code).toBe(0);
    expect(fake.published[0]?.event.kind).toBe(1632);
  });

  it('validates the state word and positional count (exit 2)', async () => {
    expect(await runStatus([ROOT_EVENT, 'merged'], deps().deps)).toBe(2);
    expect(await runStatus([ROOT_EVENT], deps().deps)).toBe(2);
    expect(await runStatus(['nothex', 'open'], deps().deps)).toBe(2);
    expect(fake.published).toHaveLength(0);
  });
});

describe('relay selection', () => {
  it('refuses multi-relay configs before anything is paid', async () => {
    await writeToonConfig(repoDir, {
      relays: ['wss://one.example', 'wss://two.example'],
    });
    const h = deps();
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
    const h = deps();
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--yes', '--relay', 'wss://chosen.example'],
      h.deps
    );
    expect(code).toBe(0);
    expect(fake.published[0]?.relayUrls).toEqual(['wss://chosen.example']);
  });
});

describe('error mapping', () => {
  it('surfaces the missing-identity remediation from the loader', async () => {
    const { MissingIdentityError } = await import('./identity.js');
    const h = makeDeps(env, repoDir, {
      loadStandalone: async () => {
        throw new MissingIdentityError(join(homeDir, 'config.json'));
      },
    });
    const code = await runIssue(
      ['create', '--title', 't', '--body', 'b', '--yes'],
      h.deps
    );
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('RIG_MNEMONIC environment variable');
    expect(text).toContain('.env');
  });

  it('--json emits a machine-readable error envelope', async () => {
    const h = makeDeps(env, repoDir, {
      loadStandalone: async () => {
        throw new Error('publish exploded');
      },
    });
    const code = await runStatus([ROOT_EVENT, 'open', '--json', '--yes'], h.deps);
    expect(code).toBe(1);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      command: 'status',
      error: 'error',
      detail: 'publish exploded',
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
      const h = deps();
      expect(await run(args as unknown as string[], h.deps)).toBe(0);
      const text = h.out.join('\n');
      expect(text).toContain(needle);
      expect(text).not.toContain('--daemon');
      expect(text).not.toContain('--standalone');
    }
    expect(fake.published).toHaveLength(0);
  });

  it('rejects unknown flags (incl. the removed mode flags) with usage (exit 2)', async () => {
    const h = deps();
    expect(await runStatus([ROOT_EVENT, 'open', '--frobnicate'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig status');
    expect(
      await runIssue(['create', '--title', 't', '--body', 'b', '--daemon'], deps().deps)
    ).toBe(2);
    expect(
      await runIssue(['create', '--title', 't', '--body', 'b', '--standalone'], deps().deps)
    ).toBe(2);
    expect(fake.published).toHaveLength(0);
  });
});
