/**
 * `rig init` tests (#248, #249): happy path, idempotent re-run, --repo-id
 * override, missing-identity remediation, not-a-git-repo hint, the
 * toon.relay → origin-remote migration, and the --json report — against a
 * real fixture repository and the real identity chain (RIG_MNEMONIC / .env /
 * shared config).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { deriveNostrKeyFromMnemonic } from '@toon-protocol/client';
import { hexToNpub } from '../npub.js';
import { resolveGitAuthor } from './git-author.js';
import { readGitAuthor, readToonConfig, writeToonConfig } from './git-config.js';
import { runInit, type InitDeps } from './init.js';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PUBKEY = deriveNostrKeyFromMnemonic(PHRASE).pubkey;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let repoDir: string;
let homeDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-rig-init-'));
  git(['init', '--initial-branch=main'], repoDir);
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-inithome-'));
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

interface Harness {
  deps: InitDeps;
  out: string[];
  err: string[];
}

/**
 * Default git-author seam: an OFFLINE npub-fallback resolver (relayUrl forced
 * out) so the broad init suite never reaches a relay. The dedicated
 * git-author tests below pass their own `resolveGitAuthorImpl`/relay to
 * exercise the kind:0 profile path.
 */
const offlineGitAuthor: NonNullable<InitDeps['resolveGitAuthorImpl']> = (opts) =>
  resolveGitAuthor({ pubkey: opts.pubkey });

function makeDeps(
  env: Record<string, string>,
  cwd = repoDir,
  overrides: Partial<InitDeps> = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      io: {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        // The machine document lands in the same `out` stream the pre-#265
        // assertions read (production routes it to the real stdout).
        emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
        isInteractive: false,
        confirm: async () => false,
      },
      env: { TOON_CLIENT_HOME: homeDir, ...env },
      cwd,
      resolveGitAuthorImpl: offlineGitAuthor,
      ...overrides,
    },
  };
}

describe('rig init', () => {
  it('writes toon.repoid (dir basename) + toon.owner and reports the source', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    const code = await runInit([], h.deps);
    expect(code).toBe(0);

    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe(basename(repoDir));
    expect(config.owner).toBe(PUBKEY);

    const text = h.out.join('\n');
    expect(text).toContain(`Initialized rig for ${repoDir}`);
    expect(text).toContain(`Identity: ${PUBKEY} (from RIG_MNEMONIC env)`);
    expect(text).toContain(`toon.repoid = ${basename(repoDir)}`);
    expect(text).toContain(`toon.owner  = ${PUBKEY}`);
    // No relay yet → the origins follow-up step.
    expect(text).toContain('No relay configured');
    expect(text).toContain('rig remote add origin <relay-url>');
    // The phrase itself never appears anywhere.
    expect(text).not.toContain('abandon');
    expect(h.err.join('\n')).not.toContain('abandon');
  });

  it('writes to the repo-LOCAL git config only', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    expect(git(['config', '--local', 'toon.owner'], repoDir)).toBe(PUBKEY);
    // Nothing rig-related lands in any repo FILE (mnemonic stays out of the
    // worktree; .git/config is where git config --local lives).
    expect(git(['status', '--porcelain'], repoDir)).toBe('');
  });

  it('--repo-id overrides the basename default', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--repo-id', 'custom-id'], h.deps)).toBe(0);
    expect((await readToonConfig(repoDir)).repoId).toBe('custom-id');
  });

  it('is idempotent: re-running keeps the configured repoid and reports', async () => {
    const h1 = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--repo-id', 'kept'], h1.deps)).toBe(0);

    const h2 = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h2.deps)).toBe(0);
    const config = await readToonConfig(repoDir);
    expect(config.repoId).toBe('kept'); // NOT clobbered back to the basename
    expect(config.owner).toBe(PUBKEY);
    const text = h2.out.join('\n');
    expect(text).toContain('toon.repoid = kept (unchanged)');
    expect(text).toContain('(unchanged)');
  });

  it('updates a stale owner to the active identity and notes the change', async () => {
    await writeToonConfig(repoDir, { owner: 'cd'.repeat(32) });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    expect((await readToonConfig(repoDir)).owner).toBe(PUBKEY);
    expect(h.out.join('\n')).toContain(`(was ${'cd'.repeat(32)})`);
  });

  it('migrates a v0.1 toon.relay to a real origin remote (key kept readable)', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://relay.example'] });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    // A REAL git remote was created from the deprecated key…
    expect(git(['remote', 'get-url', 'origin'], repoDir)).toBe(
      'wss://relay.example'
    );
    // …and the old key stays readable (fallback until v0.3).
    expect(git(['config', '--get-all', 'toon.relay'], repoDir)).toBe(
      'wss://relay.example'
    );
    const text = h.out.join('\n');
    expect(text).toContain('origin      = wss://relay.example');
    expect(text).toContain('migrated from git config toon.relay');
    expect(text).toContain('removed in v0.3');
    expect(text).toContain('Ready: `rig push`');
    expect(text).not.toContain('No relay configured');
  });

  it('reports an existing relay origin without migrating anything', async () => {
    git(['remote', 'add', 'origin', 'wss://relay.example'], repoDir);
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('origin      = wss://relay.example');
    expect(text).not.toContain('migrated');
    expect(text).toContain('Ready: `rig push`');
    expect(text).not.toContain('No relay configured');
  });

  it('does not migrate onto an existing non-relay origin (guides instead)', async () => {
    git(['remote', 'add', 'origin', 'git@github.com:a/b.git'], repoDir);
    await writeToonConfig(repoDir, { relays: ['wss://relay.example'] });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    // The GitHub origin was NOT clobbered.
    expect(git(['remote', 'get-url', 'origin'], repoDir)).toBe(
      'git@github.com:a/b.git'
    );
    const text = h.out.join('\n');
    expect(text).toContain('toon.relay  = wss://relay.example (deprecated)');
    expect(text).toContain('rig remote add toon');
  });

  it('does not auto-migrate a multi-valued toon.relay (asks the user to pick)', async () => {
    await writeToonConfig(repoDir, {
      relays: ['wss://one.example', 'wss://two.example'],
    });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit([], h.deps)).toBe(0);
    expect(git(['remote'], repoDir)).toBe('');
    const text = h.out.join('\n');
    expect(text).toContain('2 values');
    expect(text).toContain('rig remote add origin <relay-url>');
  });

  it('resolves the identity from a project .env (source reported)', async () => {
    writeFileSync(join(repoDir, '.env'), `RIG_MNEMONIC="${PHRASE}"\n`);
    const h = makeDeps({});
    expect(await runInit([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(
      `Identity: ${PUBKEY} (from ${join(repoDir, '.env')})`
    );
    expect((await readToonConfig(repoDir)).owner).toBe(PUBKEY);
  });

  it('errors with the remediation (now naming `rig identity create`) when no identity exists', async () => {
    const h = makeDeps({});
    expect(await runInit([], h.deps)).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('no identity found');
    // The cold-start fix: generation is the FIRST option now (#294).
    expect(text).toContain('rig identity create');
    expect(text).toContain('RIG_MNEMONIC environment variable');
    expect(text).toContain('.env');
    expect(text).toContain(join(homeDir, 'config.json'));
    // Nothing was written (no consent, non-interactive).
    expect((await readToonConfig(repoDir)).owner).toBeUndefined();
  });

  it('refuses (non-TTY, no flag) outside a git repo, leading with --git-init', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'toon-rig-norepo-'));
    try {
      const h = makeDeps({ RIG_MNEMONIC: PHRASE }, bare);
      expect(await runInit([], h.deps)).toBe(1);
      const text = h.err.join('\n');
      expect(text).toContain('not a git repository');
      // Remediation now leads with the new flag, still mentions plain git init.
      expect(text).toContain('rig init --git-init');
      expect(text).toContain('git init');
      // Nothing created without consent.
      expect(execFileSync('ls', ['-A', bare], { encoding: 'utf-8' }).trim()).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('--json emits the machine-readable report', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json', '--repo-id', 'demo'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'init',
      repoRoot: repoDir,
      repoId: 'demo',
      owner: PUBKEY,
      identity: { source: 'env', sourceLabel: 'RIG_MNEMONIC env', pubkey: PUBKEY },
      relays: [],
      relayConfigured: false,
      remotes: [],
      origin: null,
      migratedToonRelay: false,
      changed: { repoId: true, owner: true },
    });
    expect(JSON.stringify(parsed)).not.toContain('abandon');

    // Idempotent re-run reports no changes.
    const h2 = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json'], h2.deps)).toBe(0);
    expect(JSON.parse(h2.out.join('\n'))).toMatchObject({
      repoId: 'demo',
      changed: { repoId: false, owner: false },
    });
  });

  it('--json reports the toon.relay migration', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://relay.example'] });
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      relays: ['wss://relay.example'],
      relayConfigured: true,
      remotes: [{ name: 'origin', urls: ['wss://relay.example'] }],
      origin: 'wss://relay.example',
      migratedToonRelay: true,
    });
  });

  it('--json emits an error envelope on failure', async () => {
    const h = makeDeps({});
    expect(await runInit(['--json'], h.deps)).toBe(1);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      command: 'init',
      error: 'missing_identity',
    });
  });

  it('rejects unknown flags with usage (exit 2)', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--frobnicate'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('Usage: rig init');
  });

  it('--help prints usage and exits 0 without writing anything', async () => {
    const h = makeDeps({});
    expect(await runInit(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('--repo-id');
    expect((await readToonConfig(repoDir)).owner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #294: identity generation on first run (consent-gated)
// ---------------------------------------------------------------------------

describe('rig init identity generation (#294)', () => {
  /** A deps harness with tunable TTY + confirm (init.test's default is off). */
  function makeGenDeps(
    env: Record<string, string>,
    tty: { isInteractive: boolean; confirm: () => boolean }
  ) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        io: {
          out: (line) => out.push(line),
          err: (line) => err.push(line),
          emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
          isInteractive: tty.isInteractive,
          confirm: async () => tty.confirm(),
        },
        env: { TOON_CLIENT_HOME: homeDir, ...env },
        cwd: repoDir,
        resolveGitAuthorImpl: offlineGitAuthor,
      },
    };
  }

  it('--generate-identity mints an identity and writes toon.owner (no prompt)', async () => {
    const h = makeGenDeps({}, { isInteractive: false, confirm: () => false });
    expect(await runInit(['--generate-identity'], h.deps)).toBe(0);

    // A keystore was written and toon.owner is the fresh pubkey.
    const config = await readToonConfig(repoDir);
    expect(config.owner).toMatch(/^[0-9a-f]{64}$/);
    const banner = h.out.join('\n');
    expect(banner).toContain('generated a new identity');
    expect(banner).toContain('shown ONCE');
    // A later run resolves the SAME identity from the keystore (no re-gen).
    const again = makeGenDeps({}, { isInteractive: false, confirm: () => false });
    expect(await runInit([], again.deps)).toBe(0);
    expect(again.out.join('\n')).toContain(`from ${join(homeDir, 'keystore.json')}`);
    expect(again.out.join('\n')).not.toContain('generated a new identity');
  });

  it('interactive: a `y` at the prompt generates; a `n` errors', async () => {
    const yes = makeGenDeps({}, { isInteractive: true, confirm: () => true });
    expect(await runInit([], yes.deps)).toBe(0);
    expect((await readToonConfig(repoDir)).owner).toMatch(/^[0-9a-f]{64}$/);

    // Fresh repo + home for the `n` case.
    const noRepo = mkdtempSync(join(tmpdir(), 'toon-rig-init-no-'));
    git(['init', '--initial-branch=main'], noRepo);
    const noHome = mkdtempSync(join(tmpdir(), 'toon-rig-inithome-no-'));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runInit([], {
        io: {
          out: (l) => out.push(l),
          err: (l) => err.push(l),
          emitJson: (p) => out.push(JSON.stringify(p)),
          isInteractive: true,
          confirm: async () => false,
        },
        env: { TOON_CLIENT_HOME: noHome },
        cwd: noRepo,
      });
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('rig identity create');
      expect((await readToonConfig(noRepo)).owner).toBeUndefined();
    } finally {
      rmSync(noRepo, { recursive: true, force: true });
      rmSync(noHome, { recursive: true, force: true });
    }
  });

  it('--generate-identity --json embeds the seed phrase for the scripted path', async () => {
    const h = makeGenDeps({}, { isInteractive: false, confirm: () => false });
    expect(await runInit(['--generate-identity', '--json'], h.deps)).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    const gen = doc['generatedIdentity'] as Record<string, unknown>;
    expect(gen).toBeDefined();
    expect(typeof gen['mnemonic']).toBe('string');
    expect((gen['mnemonic'] as string).split(' ').length).toBe(12);
    expect(doc['owner']).toBe(gen['pubkey']);
    // The SECRET warning lands on stderr, not the machine stream.
    expect(h.err.join('\n')).toContain('SECRET');
  });

  // ── Git commit-author from the nostr identity (#302) ─────────────────────
  describe('git commit-author', () => {
    const NPUB = hexToNpub(PUBKEY);
    const EMAIL = `${NPUB}@nostr`;

    it('sets the repo-LOCAL git author to the npub identity (fixes the trap)', async () => {
      const h = makeDeps({ RIG_MNEMONIC: PHRASE });
      expect(await runInit([], h.deps)).toBe(0);

      // Repo-local user.name / user.email are set → `git commit` works.
      const author = await readGitAuthor(repoDir);
      expect(author.name).toBe(NPUB);
      expect(author.email).toBe(EMAIL);
      expect(h.out.join('\n')).toContain(
        `Git author: ${NPUB} <${EMAIL}> (from npub)`
      );

      // A real commit succeeds — no "empty ident name not allowed".
      git(['commit', '--allow-empty', '-m', 'first'], repoDir);
      expect(git(['log', '--format=%an <%ae>', '-1'], repoDir)).toBe(
        `${NPUB} <${EMAIL}>`
      );
    });

    it('--json carries the gitAuthor {name, email, source} shape', async () => {
      const h = makeDeps({ RIG_MNEMONIC: PHRASE });
      expect(await runInit(['--json'], h.deps)).toBe(0);
      const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
      expect(doc['gitAuthor']).toEqual({
        name: NPUB,
        email: EMAIL,
        source: 'npub',
      });
    });

    it('overrides a global user.name for THIS repo only (repo-local wins)', async () => {
      // A mocked global git identity that must NOT win over the rig identity.
      const globalCfg = join(homeDir, 'globalgitconfig');
      writeFileSync(
        globalCfg,
        '[user]\n\tname = Global Person\n\temail = global@example.com\n'
      );
      const prev = process.env['GIT_CONFIG_GLOBAL'];
      process.env['GIT_CONFIG_GLOBAL'] = globalCfg;
      try {
        const h = makeDeps({ RIG_MNEMONIC: PHRASE });
        expect(await runInit([], h.deps)).toBe(0);
        // The effective author (local shadows global) is the npub identity.
        expect(git(['config', 'user.name'], repoDir)).toBe(NPUB);
        expect(git(['config', 'user.email'], repoDir)).toBe(EMAIL);
        // The global config file itself is untouched.
        expect(git(['config', '--global', 'user.name'], repoDir)).toBe(
          'Global Person'
        );
      } finally {
        if (prev === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
        else process.env['GIT_CONFIG_GLOBAL'] = prev;
      }
    });

    it('reads the kind:0 profile from the --relay flag (relay-at-init-time)', async () => {
      let seenRelay: string | undefined;
      const h = makeDeps({ RIG_MNEMONIC: PHRASE }, repoDir, {
        resolveGitAuthorImpl: (opts) => {
          seenRelay = opts.relayUrl;
          return Promise.resolve({
            name: 'Alice',
            email: EMAIL,
            npub: NPUB,
            source: 'profile',
          });
        },
      });
      expect(
        await runInit(['--relay', 'wss://relay.example'], h.deps)
      ).toBe(0);
      // The --relay flag is the profile relay handed to the resolver.
      expect(seenRelay).toBe('wss://relay.example');
      // The profile display name becomes user.name (source: profile).
      expect((await readGitAuthor(repoDir)).name).toBe('Alice');
      expect(h.out.join('\n')).toContain('(from nostr profile)');
    });

    it('falls back to the genesis-seed relay when none is configured', async () => {
      let seenRelay: string | undefined;
      const h = makeDeps({ RIG_MNEMONIC: PHRASE }, repoDir, {
        resolveGitAuthorImpl: (opts) => {
          seenRelay = opts.relayUrl;
          return resolveGitAuthor({ pubkey: opts.pubkey });
        },
      });
      expect(await runInit([], h.deps)).toBe(0);
      // No origin/toon.relay/flag → the committed genesis apex relay is used
      // for the kind:0 read (resolved offline from core's seed).
      expect(seenRelay).toBe('wss://relay-ws.devnet.toonprotocol.dev');
    });

    it('a re-run refreshes user.name from a now-readable profile', async () => {
      // First run: npub fallback (no profile / no relay).
      const first = makeDeps({ RIG_MNEMONIC: PHRASE });
      expect(await runInit([], first.deps)).toBe(0);
      expect((await readGitAuthor(repoDir)).name).toBe(NPUB);

      // Second run: a profile is now readable → user.name refreshes to it.
      const second = makeDeps({ RIG_MNEMONIC: PHRASE }, repoDir, {
        resolveGitAuthorImpl: (opts) =>
          Promise.resolve({
            name: 'Alice Display',
            email: `${hexToNpub(opts.pubkey)}@nostr`,
            npub: hexToNpub(opts.pubkey),
            source: 'profile',
          }),
      });
      expect(await runInit([], second.deps)).toBe(0);
      const author = await readGitAuthor(repoDir);
      expect(author.name).toBe('Alice Display');
      expect(author.email).toBe(EMAIL);
    });
  });
});

// ---------------------------------------------------------------------------
// #300: git repo creation on first run (consent-gated), mirroring #294
// ---------------------------------------------------------------------------

describe('rig init git-init (#300)', () => {
  /** A deps harness rooted at a NON-repo directory, with tunable TTY. */
  function makeAt(
    dir: string,
    env: Record<string, string>,
    tty: { isInteractive: boolean; confirm: () => boolean }
  ) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        io: {
          out: (line) => out.push(line),
          err: (line) => err.push(line),
          emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
          isInteractive: tty.isInteractive,
          confirm: async () => tty.confirm(),
        },
        env: { TOON_CLIENT_HOME: homeDir, ...env },
        cwd: dir,
      },
    };
  }

  let bare: string;
  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'toon-rig-norepo-'));
  });
  afterEach(() => {
    rmSync(bare, { recursive: true, force: true });
  });

  it('--git-init (non-interactive) creates the repo and completes init', async () => {
    const h = makeAt(bare, { RIG_MNEMONIC: PHRASE }, {
      isInteractive: false,
      confirm: () => false,
    });
    expect(await runInit(['--git-init'], h.deps)).toBe(0);
    // A real git repo now exists and init wrote toon config against it.
    expect(git(['rev-parse', '--is-inside-work-tree'], bare)).toBe('true');
    // ...and it lands on `main` (what every rig doc/quickstart assumes), not
    // whatever the machine's init.defaultBranch would have produced (#master).
    expect(git(['symbolic-ref', 'HEAD'], bare)).toBe('refs/heads/main');
    const config = await readToonConfig(bare);
    expect(config.repoId).toBe(basename(bare));
    expect(config.owner).toBe(PUBKEY);
    expect(h.out.join('\n')).toContain('Created a git repository at');
  });

  it('interactive: a `y` at the prompt runs git init; a `n` refuses', async () => {
    const yes = makeAt(bare, { RIG_MNEMONIC: PHRASE }, {
      isInteractive: true,
      confirm: () => true,
    });
    expect(await runInit([], yes.deps)).toBe(0);
    expect((await readToonConfig(bare)).owner).toBe(PUBKEY);
    expect(yes.err.join('\n')).toContain('Not a git repository');

    // Fresh non-repo dir for the `n` case.
    const bare2 = mkdtempSync(join(tmpdir(), 'toon-rig-norepo-no-'));
    try {
      const no = makeAt(bare2, { RIG_MNEMONIC: PHRASE }, {
        isInteractive: true,
        confirm: () => false,
      });
      expect(await runInit([], no.deps)).toBe(1);
      expect(no.err.join('\n')).toContain('not a git repository');
      // Nothing was created on refusal.
      expect(execFileSync('ls', ['-A', bare2], { encoding: 'utf-8' }).trim()).toBe('');
    } finally {
      rmSync(bare2, { recursive: true, force: true });
    }
  });

  it('does NOT create a repo in --json mode without the flag (refuses)', async () => {
    const h = makeAt(bare, { RIG_MNEMONIC: PHRASE }, {
      // Even a "yes"-answering TTY is bypassed in --json mode (no prompt).
      isInteractive: true,
      confirm: () => true,
    });
    expect(await runInit(['--json'], h.deps)).toBe(1);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      command: 'init',
      error: 'not_a_git_repository',
    });
    expect(execFileSync('ls', ['-A', bare], { encoding: 'utf-8' }).trim()).toBe('');
  });

  it('--git-init --generate-identity: empty dir → rig-ready in one command', async () => {
    const h = makeAt(bare, {}, { isInteractive: false, confirm: () => false });
    expect(
      await runInit(['--git-init', '--generate-identity', '--json'], h.deps)
    ).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc['initializedGitRepo']).toBe(true);
    expect(doc['owner']).toMatch(/^[0-9a-f]{64}$/);
    const gen = doc['generatedIdentity'] as Record<string, unknown>;
    expect((gen['mnemonic'] as string).split(' ').length).toBe(12);
    // The repo, config, and identity all landed in one run — on `main`.
    expect(git(['symbolic-ref', 'HEAD'], bare)).toBe('refs/heads/main');
    expect(git(['remote'], bare)).toBe(''); // no relay yet (follow-up step)
    expect((await readToonConfig(bare)).owner).toBe(doc['owner']);
  });

  it('--json reports initializedGitRepo: false inside an existing repo', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE });
    expect(await runInit(['--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({
      initializedGitRepo: false,
    });
  });
});
