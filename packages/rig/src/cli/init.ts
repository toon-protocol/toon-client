/**
 * `rig init` — one-shot, idempotent repo setup (#248).
 *
 * Replaces the old "config written as a side effect of the first push":
 *
 *   1. verifies the working directory is inside a git repository (hints at
 *      `git init` when not — never runs it);
 *   2. resolves the signing identity via the RIG_MNEMONIC precedence chain
 *      (./identity.ts) and reports the SOURCE + derived pubkey (never the
 *      phrase); a chain miss errors with all three remediation options;
 *   3. writes `toon.repoid` (default: repo directory basename; existing
 *      value kept on re-runs; `--repo-id` overrides) and `toon.owner` (the
 *      derived pubkey) to the repository's LOCAL git config — the mnemonic
 *      itself is never written to git config or any repo file;
 *   4. reports the relay setup (#249): when the deprecated v0.1
 *      `git config toon.relay` is set and no `origin` remote exists, it
 *      MIGRATES the value to a real `origin` git remote (the old key stays
 *      readable as a fallback and is removed in v0.3); when nothing is
 *      configured it suggests `rig remote add origin <relay-url>` as the
 *      follow-up step.
 *
 * Re-running updates and reports instead of erroring. `--json` emits a
 * machine-readable report. Free — nothing is published or paid.
 */

import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { describeError, NotAGitRepositoryError } from './errors.js';
import {
  addGitRemote,
  listGitRemotes,
  readToonConfig,
  resolveRepoRoot,
  writeToonConfig,
  type GitRemoteInfo,
} from './git-config.js';
import { resolveIdentity, type ResolvedIdentity } from './identity.js';
import type { CliIo } from './push.js';
import { isRelayUrl } from './remote.js';
import { renderIdentityLine } from './render.js';

export const INIT_USAGE = `Usage: rig init [options]

Set up the current git repository for rig (one-shot, idempotent, free):
resolves your identity (RIG_MNEMONIC env → project .env → ~/.toon-client
keystore/config), then writes toon.repoid and toon.owner to the repo's
LOCAL git config. Re-running updates and reports; it never errors on an
already-initialized repo. The seed phrase is never written anywhere.

The follow-up step is adding a relay: \`rig remote add origin <relay-url>\`
(a real git remote — \`git remote -v\` shows it). A deprecated v0.1
\`git config toon.relay\` is migrated to the origin remote automatically
when no origin exists (the old key stays readable and is removed in v0.3).

Options:
  --repo-id <id>     repository id / NIP-34 d-tag (default: the existing
                     toon.repoid, then the repo directory basename)
  --json             machine-readable report
  -h, --help         show this help`;

/** Deps subset `rig init` needs (no publisher — init is free). */
export interface InitDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Identity resolver seam (tests); defaults to the real chain. */
  resolveIdentityImpl?: typeof resolveIdentity;
}

interface InitFlags {
  repoId?: string;
  json: boolean;
  help: boolean;
}

function parseInitArgs(args: string[]): InitFlags {
  const { values, positionals } = parseArgs({
    args,
    options: {
      'repo-id': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (positionals.length > 0) {
    throw new Error(`rig init takes no positional arguments`);
  }
  const flags: InitFlags = {
    json: values.json ?? false,
    help: values.help ?? false,
  };
  const repoId = values['repo-id'];
  if (repoId !== undefined) {
    if (repoId.trim() === '') throw new Error('--repo-id must not be empty');
    flags.repoId = repoId;
  }
  return flags;
}

/** JSON envelope emitted by `rig init --json`. */
interface InitJsonOutput {
  command: 'init';
  repoRoot: string;
  repoId: string;
  /** `toon.owner` — the derived pubkey of the active identity. */
  owner: string;
  identity: {
    source: ResolvedIdentity['source'];
    sourceLabel: string;
    pubkey: string;
  };
  /** Deprecated `git config toon.relay` values (kept readable until v0.3). */
  relays: string[];
  /** True when any relay source is configured (origin remote or toon.relay). */
  relayConfigured: boolean;
  /** Configured git remotes (post-migration). */
  remotes: GitRemoteInfo[];
  /** The single relay URL of the `origin` remote, when it is one. */
  origin: string | null;
  /** True when this run migrated toon.relay to a new `origin` remote. */
  migratedToonRelay: boolean;
  /** What this run changed in git config (false = already up to date). */
  changed: { repoId: boolean; owner: boolean };
}

/** Run `rig init`; returns the process exit code. */
export async function runInit(args: string[], deps: InitDeps): Promise<number> {
  const { io, env } = deps;

  let flags: InitFlags;
  try {
    flags = parseInitArgs(args);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(INIT_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(INIT_USAGE);
    return 0;
  }

  try {
    // ── (a) Must be a git repository — hint, never auto-run git init ────────
    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRoot(deps.cwd);
    } catch {
      throw new NotAGitRepositoryError(deps.cwd);
    }

    // ── (b) Identity chain: source + derived pubkey (never the phrase) ──────
    const identity = await (deps.resolveIdentityImpl ?? resolveIdentity)({
      env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
    });

    // ── (c) Write toon.repoid / toon.owner to LOCAL git config ──────────────
    const existing = await readToonConfig(repoRoot);
    const repoId = flags.repoId ?? existing.repoId ?? basename(repoRoot);
    const changed = {
      repoId: existing.repoId !== repoId,
      owner: existing.owner !== identity.pubkey,
    };
    await writeToonConfig(repoRoot, { repoId, owner: identity.pubkey });

    // ── (d) Relay setup (#249): migrate toon.relay → origin remote ──────────
    // toon.relay is the deprecated v0.1 key. When it is set, single-valued,
    // relay-shaped, and no `origin` remote exists, adopt it as a real git
    // remote. The old key stays readable (paid commands still fall back to
    // it, with a nudge) and is removed in v0.3.
    let remotes = await listGitRemotes(repoRoot);
    let migratedToonRelay = false;
    const legacyRelay = existing.relays[0];
    if (
      !remotes.some((r) => r.name === 'origin') &&
      existing.relays.length === 1 &&
      legacyRelay !== undefined &&
      isRelayUrl(legacyRelay)
    ) {
      await addGitRemote(repoRoot, 'origin', legacyRelay);
      migratedToonRelay = true;
      remotes = await listGitRemotes(repoRoot);
    }
    const origin = remotes.find((r) => r.name === 'origin');
    const originRelay =
      origin !== undefined &&
      origin.urls.length === 1 &&
      isRelayUrl(origin.urls[0] as string)
        ? (origin.urls[0] as string)
        : undefined;

    // ── (e) Report ───────────────────────────────────────────────────────────
    if (flags.json) {
      const output: InitJsonOutput = {
        command: 'init',
        repoRoot,
        repoId,
        owner: identity.pubkey,
        identity: {
          source: identity.source,
          sourceLabel: identity.sourceLabel,
          pubkey: identity.pubkey,
        },
        relays: existing.relays,
        relayConfigured: originRelay !== undefined || existing.relays.length > 0,
        remotes,
        origin: originRelay ?? null,
        migratedToonRelay,
        changed,
      };
      io.out(JSON.stringify(output, null, 2));
      return 0;
    }

    io.out(`Initialized rig for ${repoRoot}`);
    io.out(renderIdentityLine(identity));
    io.out(
      `  toon.repoid = ${repoId}` +
        (changed.repoId ? '' : ' (unchanged)') +
        (existing.repoId && changed.repoId ? ` (was ${existing.repoId})` : '')
    );
    io.out(
      `  toon.owner  = ${identity.pubkey}` +
        (changed.owner ? '' : ' (unchanged)') +
        (existing.owner && changed.owner ? ` (was ${existing.owner})` : '')
    );
    if (originRelay !== undefined) {
      io.out(
        `  origin      = ${originRelay}` +
          (migratedToonRelay ? ' (migrated from git config toon.relay)' : '')
      );
      if (migratedToonRelay) {
        io.out(
          'note: toon.relay is deprecated — it stays readable as a fallback ' +
            'and is removed in v0.3; drop it now with ' +
            '`git config --unset-all toon.relay`.'
        );
      }
      io.out('Ready: `rig push` publishes this repo via remote "origin".');
    } else if (existing.relays.length > 0) {
      // toon.relay is set but could not be migrated (multi-valued, junk URL,
      // or a non-relay `origin` remote already occupies the name).
      io.out(`  toon.relay  = ${existing.relays.join(', ')} (deprecated)`);
      io.out(
        origin !== undefined
          ? `The "origin" remote (${origin.urls.join(', ')}) is not a single ` +
              'relay URL, so toon.relay stays the fallback — add the relay ' +
              'under another name (`rig remote add toon <relay-url>`) and ' +
              'push with `rig push toon`.'
          : existing.relays.length > 1
            ? `toon.relay has ${existing.relays.length} values and rig ` +
              'publishes to one relay — migrate the right one: ' +
              '`rig remote add origin <relay-url>`.'
            : 'This value is not a relay URL (ws://, wss://, http://, or ' +
              'https://) — set a real one: `rig remote add origin <relay-url>`.'
      );
    } else if (origin !== undefined) {
      // The origin name is occupied by a non-relay remote (e.g. a GitHub
      // clone) and no legacy toon.relay exists.
      io.out(
        `No relay configured yet — "origin" (${origin.urls.join(', ')}) is ` +
          'not a relay URL, so add the relay under another name: ' +
          '`rig remote add toon <relay-url>`, then `rig push toon`.'
      );
    } else {
      io.out(
        'No relay configured yet — add one as the follow-up step: ' +
          '`rig remote add origin <relay-url>` (a real git remote; ' +
          '`git remote -v` shows it). One-off pushes can pass --relay <url>.'
      );
    }
    return 0;
  } catch (err) {
    const described = describeError(err, 'init');
    if (flags.json) {
      io.out(JSON.stringify({ command: 'init', ...described.json }, null, 2));
    } else {
      for (const line of described.lines) io.err(line);
    }
    return 1;
  }
}
