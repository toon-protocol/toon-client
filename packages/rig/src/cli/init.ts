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
 *   4. when no relay is configured, prints the follow-up step (`--relay` /
 *      `git config toon.relay` until `rig remote add origin` lands in #249).
 *
 * Re-running updates and reports instead of erroring. `--json` emits a
 * machine-readable report. Free — nothing is published or paid.
 */

import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { describeError, NotAGitRepositoryError } from './errors.js';
import { readToonConfig, resolveRepoRoot, writeToonConfig } from './git-config.js';
import { resolveIdentity, type ResolvedIdentity } from './identity.js';
import type { CliIo } from './push.js';
import { renderIdentityLine } from './render.js';

export const INIT_USAGE = `Usage: rig init [options]

Set up the current git repository for rig (one-shot, idempotent, free):
resolves your identity (RIG_MNEMONIC env → project .env → ~/.toon-client
keystore/config), then writes toon.repoid and toon.owner to the repo's
LOCAL git config. Re-running updates and reports; it never errors on an
already-initialized repo. The seed phrase is never written anywhere.

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
  /** Configured `toon.relay` values (may be empty — see `relayConfigured`). */
  relays: string[];
  relayConfigured: boolean;
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

    // ── (d)+(e) Report ───────────────────────────────────────────────────────
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
        relayConfigured: existing.relays.length > 0,
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
    if (existing.relays.length > 0) {
      io.out(`  toon.relay  = ${existing.relays.join(', ')}`);
      io.out('Ready: `rig push` publishes this repo.');
    } else {
      io.out(
        'No relay configured yet — pass --relay <url> to `rig push`, or set a ' +
          'default once: `git config toon.relay <url>` ' +
          '(`rig remote add origin <relay-url>` arrives in toon-client#249).'
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
