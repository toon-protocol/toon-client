/**
 * `rig remote` + relay-resolution tests (#249) — against REAL git remotes in
 * fixture repositories: add/remove/list round-trip through `git remote`,
 * relay-URL validation, and the `resolveRelays` order every paid command
 * shares (--relay > named remote > origin > deprecated toon.relay > error),
 * including the pre-payment multi-URL refusal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MultiUrlRemoteError,
  NoOriginConfiguredError,
  UnknownRemoteError,
} from './errors.js';
import { writeToonConfig } from './git-config.js';
import type { CliIo } from './push.js';
import {
  isRelayUrl,
  resolveRelays,
  runRemote,
  singleRelayRefusal,
} from './remote.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'toon-rig-remote-'));
  git(['init', '--initial-branch=main'], repoDir);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

interface Harness {
  deps: { io: CliIo; cwd: string };
  out: string[];
  err: string[];
}

function makeDeps(cwd = repoDir): Harness {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      io: {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        isInteractive: false,
        confirm: async () => false,
      },
      cwd,
    },
  };
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe('isRelayUrl', () => {
  it('accepts ws/wss/http/https and rejects everything else', () => {
    for (const good of [
      'ws://localhost:7100',
      'wss://relay.example',
      'http://relay.example:8080/path',
      'https://relay.example',
    ]) {
      expect(isRelayUrl(good), good).toBe(true);
    }
    for (const bad of [
      'ftp://relay.example',
      'git@github.com:toon-protocol/toon-client.git',
      'ssh://git@github.com/a/b.git',
      'relay.example',
      'not a url at all',
      '',
    ]) {
      expect(isRelayUrl(bad), bad).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// rig remote add / remove / list (real git remote storage)
// ---------------------------------------------------------------------------

describe('rig remote add', () => {
  it('adds a REAL git remote that `git remote -v` shows', async () => {
    const h = makeDeps();
    const code = await runRemote(
      ['add', 'origin', 'wss://relay.example'],
      h.deps
    );
    expect(code).toBe(0);
    // Round-trips through plain git tooling — no parallel config store.
    expect(git(['remote', 'get-url', 'origin'], repoDir)).toBe(
      'wss://relay.example'
    );
    expect(git(['remote', '-v'], repoDir)).toContain('wss://relay.example');
    const text = h.out.join('\n');
    expect(text).toContain('Added remote origin → wss://relay.example');
    expect(text).toContain('publish here by default');
  });

  it('rejects junk URLs with a clear message before touching git (exit 2)', async () => {
    for (const bad of ['ftp://x.example', 'not-a-url', 'git@github.com:a/b.git']) {
      const h = makeDeps();
      expect(await runRemote(['add', 'origin', bad], h.deps)).toBe(2);
      const text = h.err.join('\n');
      expect(text).toContain('not a relay URL');
      expect(text).toContain('ws://, wss://, http://, or https://');
    }
    // Nothing was written.
    expect(git(['remote'], repoDir)).toBe('');
  });

  it('warns and refuses when the name already exists (nothing changed)', async () => {
    git(['remote', 'add', 'origin', 'wss://old.example'], repoDir);
    const h = makeDeps();
    const code = await runRemote(['add', 'origin', 'wss://new.example'], h.deps);
    expect(code).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('already exists');
    expect(text).toContain('wss://old.example');
    expect(text).toContain('git remote set-url');
    expect(git(['remote', 'get-url', 'origin'], repoDir)).toBe('wss://old.example');
  });

  it('nudges about a shadowed toon.relay when adding origin', async () => {
    await writeToonConfig(repoDir, { relays: ['wss://legacy.example'] });
    const h = makeDeps();
    expect(
      await runRemote(['add', 'origin', 'wss://relay.example'], h.deps)
    ).toBe(0);
    const text = h.err.join('\n');
    expect(text).toContain('toon.relay');
    expect(text).toContain('deprecated');
    expect(text).toContain('git config --unset-all toon.relay');
  });

  it('requires exactly <name> <relay-url> (exit 2 + usage)', async () => {
    const h = makeDeps();
    expect(await runRemote(['add', 'origin'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('rig remote add <name> <relay-url>');
    expect(await runRemote(['add'], makeDeps().deps)).toBe(2);
    expect(await runRemote(['add', 'a', 'wss://x.example', 'extra'], makeDeps().deps)).toBe(2);
  });
});

describe('rig remote remove', () => {
  it('removes an existing remote', async () => {
    git(['remote', 'add', 'origin', 'wss://relay.example'], repoDir);
    const h = makeDeps();
    expect(await runRemote(['remove', 'origin'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('Removed remote origin');
    expect(git(['remote'], repoDir)).toBe('');
  });

  it('errors clearly for an unknown name (exit 1)', async () => {
    const h = makeDeps();
    expect(await runRemote(['remove', 'nope'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('no remote named "nope"');
  });
});

describe('rig remote list', () => {
  it('lists names + URLs (`-v`-equivalent) and is the default subcommand', async () => {
    git(['remote', 'add', 'origin', 'wss://relay.example'], repoDir);
    git(['remote', 'add', 'stage', 'https://stage.example'], repoDir);
    for (const args of [['list'], []]) {
      const h = makeDeps();
      expect(await runRemote(args, h.deps)).toBe(0);
      const text = h.out.join('\n');
      expect(text).toContain('origin\twss://relay.example');
      expect(text).toContain('stage\thttps://stage.example');
    }
  });

  it('marks non-relay URLs and warns on multi-URL remotes', async () => {
    git(['remote', 'add', 'github', 'git@github.com:a/b.git'], repoDir);
    git(['remote', 'add', 'origin', 'wss://one.example'], repoDir);
    git(['remote', 'set-url', '--add', 'origin', 'wss://two.example'], repoDir);
    const h = makeDeps();
    expect(await runRemote(['list'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('github\tgit@github.com:a/b.git\t(not a relay URL');
    expect(text).toContain('origin\twss://one.example');
    expect(text).toContain('origin\twss://two.example');
    expect(h.err.join('\n')).toContain('one relay URL per remote');
  });

  it('prints the setup hint when no remotes exist', async () => {
    const h = makeDeps();
    expect(await runRemote(['list'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('rig remote add origin <relay-url>');
  });

  it('--json emits the machine-readable remote list', async () => {
    git(['remote', 'add', 'origin', 'wss://relay.example'], repoDir);
    const h = makeDeps();
    expect(await runRemote(['list', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toEqual({
      command: 'remote',
      remotes: [{ name: 'origin', urls: ['wss://relay.example'] }],
    });
  });
});

describe('rig remote usage/errors', () => {
  it('rejects unknown subcommands and flags (exit 2 + usage)', async () => {
    const h = makeDeps();
    expect(await runRemote(['frobnicate'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('unknown rig remote subcommand');
    expect(await runRemote(['--frobnicate'], makeDeps().deps)).toBe(2);
  });

  it('--help prints usage and exits 0', async () => {
    const h = makeDeps();
    expect(await runRemote(['--help'], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Usage: rig remote');
    expect(text).toContain('git remote -v');
  });

  it('errors with the git init hint outside a repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'toon-rig-remote-norepo-'));
    try {
      const h = makeDeps(bare);
      expect(await runRemote(['list'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toContain('not a git repository');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveRelays (the shared paid-command resolution)
// ---------------------------------------------------------------------------

describe('resolveRelays', () => {
  it('--relay flags win and bypass remotes entirely', async () => {
    git(['remote', 'add', 'origin', 'wss://origin.example'], repoDir);
    const resolved = await resolveRelays({
      relayFlags: ['wss://adhoc.example'],
      repoRoot: repoDir,
      toonRelays: ['wss://legacy.example'],
    });
    expect(resolved).toEqual({
      relays: ['wss://adhoc.example'],
      source: 'relay-flag',
    });
  });

  it('resolves a named remote', async () => {
    git(['remote', 'add', 'stage', 'wss://stage.example'], repoDir);
    const resolved = await resolveRelays({
      relayFlags: [],
      remoteName: 'stage',
      repoRoot: repoDir,
      toonRelays: [],
    });
    expect(resolved).toEqual({
      relays: ['wss://stage.example'],
      source: 'remote',
      remoteName: 'stage',
    });
  });

  it('throws UnknownRemoteError for a missing named remote', async () => {
    await expect(
      resolveRelays({
        relayFlags: [],
        remoteName: 'nope',
        repoRoot: repoDir,
        toonRelays: [],
      })
    ).rejects.toThrow(UnknownRemoteError);
  });

  it('refuses a multi-URL named remote before any payment', async () => {
    git(['remote', 'add', 'stage', 'wss://one.example'], repoDir);
    git(['remote', 'set-url', '--add', 'stage', 'wss://two.example'], repoDir);
    const err = await resolveRelays({
      relayFlags: [],
      remoteName: 'stage',
      repoRoot: repoDir,
      toonRelays: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultiUrlRemoteError);
    expect((err as Error).message).toContain('one relay URL per remote');
    expect((err as Error).message).toContain('git remote set-url stage');
  });

  it('rejects a named remote whose URL is not a relay', async () => {
    git(['remote', 'add', 'github', 'git@github.com:a/b.git'], repoDir);
    await expect(
      resolveRelays({
        relayFlags: [],
        remoteName: 'github',
        repoRoot: repoDir,
        toonRelays: [],
      })
    ).rejects.toThrow(/not a relay URL/);
  });

  it('defaults to the origin remote', async () => {
    git(['remote', 'add', 'origin', 'wss://origin.example'], repoDir);
    const resolved = await resolveRelays({
      relayFlags: [],
      repoRoot: repoDir,
      toonRelays: ['wss://legacy.example'],
    });
    expect(resolved).toEqual({
      relays: ['wss://origin.example'],
      source: 'remote',
      remoteName: 'origin',
    });
  });

  it('refuses a multi-URL origin (all relay URLs)', async () => {
    git(['remote', 'add', 'origin', 'wss://one.example'], repoDir);
    git(['remote', 'set-url', '--add', 'origin', 'wss://two.example'], repoDir);
    await expect(
      resolveRelays({ relayFlags: [], repoRoot: repoDir, toonRelays: [] })
    ).rejects.toThrow(MultiUrlRemoteError);
  });

  it('falls back to deprecated toon.relay (with the migration nudge) when origin is absent', async () => {
    const resolved = await resolveRelays({
      relayFlags: [],
      repoRoot: repoDir,
      toonRelays: ['wss://legacy.example'],
    });
    expect(resolved.relays).toEqual(['wss://legacy.example']);
    expect(resolved.source).toBe('toon.relay');
    expect(resolved.nudge).toContain('deprecated');
    expect(resolved.nudge).toContain(
      'rig remote add origin wss://legacy.example'
    );
  });

  it('skips a non-relay origin (e.g. a GitHub clone) and uses toon.relay', async () => {
    git(['remote', 'add', 'origin', 'git@github.com:a/b.git'], repoDir);
    const resolved = await resolveRelays({
      relayFlags: [],
      repoRoot: repoDir,
      toonRelays: ['wss://legacy.example'],
    });
    expect(resolved.relays).toEqual(['wss://legacy.example']);
    expect(resolved.source).toBe('toon.relay');
  });

  it('errors "no origin configured" when nothing resolves', async () => {
    const err = await resolveRelays({
      relayFlags: [],
      repoRoot: repoDir,
      toonRelays: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoOriginConfiguredError);
    expect((err as Error).message).toContain(
      'rig remote add origin <relay-url>'
    );
  });

  it('mentions a non-relay origin in the no-origin error', async () => {
    git(['remote', 'add', 'origin', 'git@github.com:a/b.git'], repoDir);
    const err = await resolveRelays({
      relayFlags: [],
      repoRoot: repoDir,
      toonRelays: [],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoOriginConfiguredError);
    expect((err as Error).message).toContain('git@github.com:a/b.git');
    expect((err as Error).message).toContain('is not a relay URL');
  });

  it('errors "no origin configured" outside a git repository', async () => {
    await expect(
      resolveRelays({ relayFlags: [], toonRelays: [] })
    ).rejects.toThrow(NoOriginConfiguredError);
  });
});

describe('singleRelayRefusal', () => {
  it('names the relays, the fix, and what was not done', () => {
    const flagLine = singleRelayRefusal(
      { relays: ['wss://a.example', 'wss://b.example'], source: 'relay-flag' },
      'Nothing was uploaded or paid.'
    );
    expect(flagLine).toContain('single relay');
    expect(flagLine).toContain('wss://a.example');
    expect(flagLine).toContain('exactly one --relay');
    expect(flagLine).toContain('Nothing was uploaded or paid.');

    const configLine = singleRelayRefusal(
      { relays: ['wss://a.example', 'wss://b.example'], source: 'toon.relay' },
      'Nothing was published or paid.'
    );
    expect(configLine).toContain('toon.relay');
    expect(configLine).toContain('rig remote add origin');
    expect(configLine).toContain('Nothing was published or paid.');
  });
});
