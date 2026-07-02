/**
 * `rig push [remote] [refspecs...]` — estimate → confirm → execute (#229,
 * standalone since #248, git-like remote resolution since #249).
 *
 * The CLI is STANDALONE-ONLY: it plans locally (`planPush`) and executes
 * through the embedded, nonce-guarded StandalonePublisher (loaded via dynamic
 * import so runs that fail earlier never need `@toon-protocol/client`). The
 * identity comes from the RIG_MNEMONIC precedence chain (./identity.ts); the
 * nonce guard still refuses when a running toon-clientd holds the same
 * identity (cumulative-claim watermark protection) — drive the daemon through
 * its toon_git_* MCP tools instead.
 *
 * Repo addressing comes from the `toon.*` git config keys `rig init` writes
 * (`--repo-id` overrides); an unconfigured repo is a hard "run `rig init`
 * first" error — nothing is written as a side effect of pushing.
 *
 * The relay comes from the repo's git remotes (#249): when the first
 * positional matches a configured remote name it is the push target,
 * otherwise it is a refspec and the remote defaults to `origin`. `--relay`
 * is an ad-hoc override that bypasses remotes (all positionals are then
 * refspecs); the deprecated v0.1 `git config toon.relay` still works with a
 * migration nudge. See ./remote.ts for the full resolution order.
 *
 * Money is only spent after the confirm gate: `--yes`, or an interactive
 * y/N prompt (a non-TTY session without `--yes` refuses). `--json` emits the
 * wire-shaped plan/receipts for agent consumers; without `--yes` it becomes
 * a pure estimate (plan JSON, nothing executed, exit 0).
 */

import { parseArgs } from 'node:util';
import { planPush, executePush } from '../push.js';
import { GitRepoReader } from '../repo-reader.js';
import { renderIdentityLine, renderPlan, renderResult } from './render.js';
import {
  serializePushPlan,
  serializePushResult,
  type GitEstimateResponse,
  type GitPushResponse,
} from '../routes.js';
import { describeError, UnconfiguredRepoAddressError } from './errors.js';
import { listGitRemotes, readToonConfig, resolveRepoRoot } from './git-config.js';
import type { IdentitySourceKind } from './identity.js';
import { resolveRelays, singleRelayRefusal } from './remote.js';
import type { LoadStandalone, StandaloneContext } from './standalone-context.js';

// ---------------------------------------------------------------------------
// Dependency seam (real wiring in rig.ts; tests inject fakes)
// ---------------------------------------------------------------------------

/** Terminal I/O seam. */
export interface CliIo {
  /** Write one line to stdout. */
  out(line: string): void;
  /** Write one line to stderr. */
  err(line: string): void;
  /** True when stdin+stdout are TTYs (interactive confirm possible). */
  isInteractive: boolean;
  /** Ask a y/N question; resolves true on explicit yes. */
  confirm(question: string): Promise<boolean>;
}

export interface PushDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Standalone factory; defaults to the real dynamic-import loader. */
  loadStandalone?: LoadStandalone;
}

/**
 * Default standalone factory (shared by every paid command). Dynamic import:
 * `standalone-mode` (and its `@toon-protocol/client` dependency) only loads
 * once a command actually needs to sign or pay.
 */
export const defaultLoadStandalone: LoadStandalone = async (options) => {
  const mod = await import('./standalone-mode.js');
  return mod.createStandaloneContext(options);
};

/** Identity report shared by every paid command's `--json` envelope. */
export interface IdentityReport {
  /** Derived Nostr pubkey (hex) of the active identity. */
  pubkey: string;
  /** Which tier of the RIG_MNEMONIC precedence chain supplied it. */
  source: IdentitySourceKind;
  /** Human-facing source label, e.g. `RIG_MNEMONIC env` or a file path. */
  sourceLabel: string;
}

/** Build the identity report of a loaded standalone context. */
export function identityReport(ctx: StandaloneContext): IdentityReport {
  return {
    pubkey: ctx.ownerPubkey,
    source: ctx.identitySource,
    sourceLabel: ctx.identitySourceLabel,
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const PUSH_USAGE = `Usage: rig push [remote] [refspecs...] [options]

Push local git refs to TOON: uploads the object delta to Arweave (paid) and
publishes the NIP-34 refs event (kind:30618; kind:30617 announce on first
push). Writes are permanent and non-refundable.

The repo must be set up once with \`rig init\` (writes toon.repoid/toon.owner
to the local git config); the identity comes from RIG_MNEMONIC (env or a
project .env), or the ~/.toon-client keystore/config.

The relay is a git remote: \`rig push\` publishes via "origin" (set up with
\`rig remote add origin <relay-url>\`); \`rig push <remote> [refspecs...]\`
publishes via a named remote. When the first positional matches a configured
remote name it is the remote; otherwise it is a refspec and the remote
defaults to origin. Refspecs are branch/tag names or full refnames; default
is the current branch.

Options:
  --force            allow non-fast-forward ref updates (overwrites remote history)
  --all              push all local branches
  --tags             push all local tags
  --yes              skip the fee confirmation (required when not a TTY)
  --json             machine-readable plan/receipts; without --yes it is a pure
                     estimate (nothing executed)
  --relay <url>      ad-hoc relay override (exactly one) — bypasses the
                     configured remotes; every positional is then a refspec.
                     The deprecated v0.1 \`git config toon.relay\` still works
                     as a fallback, with a migration nudge
  --repo-id <id>     repository id / NIP-34 d-tag (default: git config
                     toon.repoid — run \`rig init\` to set it)
  -h, --help         show this help`;

// ---------------------------------------------------------------------------
// Refspec selection
// ---------------------------------------------------------------------------

/**
 * Expand positional refspecs / `--all` / `--tags` into full refnames using
 * the local ref list; default (no selection) is the current branch.
 */
export async function selectRefspecs(
  reader: GitRepoReader,
  positionals: string[],
  all: boolean,
  tags: boolean
): Promise<string[]> {
  const { head, refs } = await reader.listRefs();
  const byName = new Set(refs.map((r) => r.refname));

  const selected: string[] = [];
  const add = (refname: string): void => {
    if (!selected.includes(refname)) selected.push(refname);
  };

  for (const spec of positionals) {
    if (byName.has(spec)) {
      add(spec);
    } else if (byName.has(`refs/heads/${spec}`)) {
      add(`refs/heads/${spec}`);
    } else if (byName.has(`refs/tags/${spec}`)) {
      add(`refs/tags/${spec}`);
    } else {
      throw new Error(
        `refspec ${JSON.stringify(spec)} matches no local branch or tag ` +
          '(ref deletion is out of scope in v1)'
      );
    }
  }
  if (all) {
    for (const ref of refs) {
      if (ref.refname.startsWith('refs/heads/')) add(ref.refname);
    }
  }
  if (tags) {
    for (const ref of refs) {
      if (ref.refname.startsWith('refs/tags/')) add(ref.refname);
    }
  }
  if (selected.length === 0) {
    if (!head) {
      throw new Error(
        'HEAD is detached and no refspec was given — pass a branch/tag name, --all, or --tags'
      );
    }
    add(head);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

interface PushFlags {
  force: boolean;
  all: boolean;
  tags: boolean;
  yes: boolean;
  json: boolean;
  relay: string[];
  repoId?: string;
  help: boolean;
  positionals: string[];
}

function parsePushArgs(args: string[]): PushFlags {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      tags: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      relay: { type: 'string', multiple: true },
      'repo-id': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  const flags: PushFlags = {
    force: values.force ?? false,
    all: values.all ?? false,
    tags: values.tags ?? false,
    yes: values.yes ?? false,
    json: values.json ?? false,
    relay: values.relay ?? [],
    help: values.help ?? false,
    positionals,
  };
  const repoId = values['repo-id'];
  if (repoId !== undefined) flags.repoId = repoId;
  return flags;
}

/** JSON envelope emitted by `--json` runs (agents consume this). */
interface PushJsonOutput {
  command: 'push';
  repoId: string;
  /** Active identity: source tier + derived pubkey (never the phrase). */
  identity: IdentityReport;
  /** True when the paid execute step ran. */
  executed: boolean;
  /** True when every selected ref already matched the remote (no-op). */
  upToDate: boolean;
  plan: GitEstimateResponse;
  result?: GitPushResponse;
  hint?: string;
}

/** Run `rig push`; returns the process exit code. */
export async function runPush(args: string[], deps: PushDeps): Promise<number> {
  const { io, env } = deps;

  let flags: PushFlags;
  try {
    flags = parsePushArgs(args);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(PUSH_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(PUSH_USAGE);
    return 0;
  }

  let standaloneCtx: StandaloneContext | undefined;
  try {
    // ── Repo + config resolution (rig init writes these) ────────────────────
    const repoRoot = await resolveRepoRoot(deps.cwd);
    const toonConfig = await readToonConfig(repoRoot);
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const reader = new GitRepoReader(repoRoot);

    // ── Remote-vs-refspec resolution (git-like: `rig push [remote] [refspecs…]`)
    // The first positional is the remote when it names a configured git
    // remote; with --relay the remotes are bypassed and every positional is
    // a refspec.
    let remoteName: string | undefined;
    let refspecArgs = flags.positionals;
    if (flags.relay.length === 0 && refspecArgs.length > 0) {
      const first = refspecArgs[0] as string;
      const remoteNames = new Set(
        (await listGitRemotes(repoRoot)).map((r) => r.name)
      );
      if (remoteNames.has(first)) {
        remoteName = first;
        refspecArgs = refspecArgs.slice(1);
      } else {
        // Not a remote, so it must be a refspec — distinguish a typo'd /
        // unconfigured remote from a bad refspec with one combined error.
        const { refs } = await reader.listRefs();
        const known = new Set(refs.map((r) => r.refname));
        if (
          !known.has(first) &&
          !known.has(`refs/heads/${first}`) &&
          !known.has(`refs/tags/${first}`)
        ) {
          throw new Error(
            `${JSON.stringify(first)} is neither a configured remote nor a ` +
              'local branch/tag — add the relay remote ' +
              `(\`rig remote add ${first} <relay-url>\`; \`rig remote list\` ` +
              'shows configured remotes) or fix the refspec'
          );
        }
      }
    }
    const refspecs = await selectRefspecs(
      reader,
      refspecArgs,
      flags.all,
      flags.tags
    );

    // ── Relay resolution (#249: --relay > named remote > origin > toon.relay)
    const resolved = await resolveRelays({
      relayFlags: flags.relay,
      remoteName,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    if (resolved.nudge !== undefined) io.err(resolved.nudge);
    const relaysUsed = resolved.relays;
    // StandalonePublisher publishes to exactly one relay (its publishEvent
    // throws on >1). Multiple relays can arrive here without explicit intent
    // (repeated --relay flags, an old multi-valued git config `toon.relay`).
    // Refuse up front, before anything is fetched, uploaded, or paid.
    if (relaysUsed.length > 1) {
      io.err(singleRelayRefusal(resolved, 'Nothing was uploaded or paid.'));
      return 1;
    }

    // ── Standalone context (identity chain + nonce guard) ───────────────────
    standaloneCtx = await (deps.loadStandalone ?? defaultLoadStandalone)({
      env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
    });
    const identity = identityReport(standaloneCtx);

    if (toonConfig.owner && toonConfig.owner !== identity.pubkey) {
      io.err(
        `warning: git config toon.owner (${toonConfig.owner.slice(0, 8)}…) differs from ` +
          `the active identity (${identity.pubkey.slice(0, 8)}…) — this push publishes ` +
          "under the ACTIVE identity's repo namespace, not the configured owner's. " +
          'Re-run `rig init` to adopt the active identity.'
      );
    }

    // ── Estimate (local plan) ───────────────────────────────────────────────
    const remoteState = await standaloneCtx.fetchRemote({
      ownerPubkey: standaloneCtx.ownerPubkey,
      repoId,
      relayUrls: relaysUsed,
    });
    const feeRates = await standaloneCtx.publisher.getFeeRates();
    const pushPlan = await planPush({
      repoReader: reader,
      remoteState,
      feeRates,
      repoId,
      refs: refspecs,
      force: flags.force,
    });
    const plan = serializePushPlan(pushPlan);

    // ── Up-to-date short-circuit (never publish a no-op refs event) ─────────
    const upToDate = plan.refUpdates.every((u) => u.kind === 'up-to-date');
    if (upToDate) {
      if (flags.json) {
        io.out(
          jsonOut({ command: 'push', repoId, identity, executed: false, upToDate: true, plan })
        );
      } else {
        io.out('Everything up-to-date — nothing to push (and nothing paid).');
      }
      return 0;
    }

    // ── Confirm gate ────────────────────────────────────────────────────────
    if (!flags.json) {
      for (const line of renderPlan(plan)) io.out(line);
      io.out(renderIdentityLine(identity));
    }
    if (!flags.yes) {
      if (flags.json) {
        io.out(
          jsonOut({
            command: 'push',
            repoId,
            identity,
            executed: false,
            upToDate: false,
            plan,
            hint: 'estimate only — re-run with --yes to upload and publish (permanent, non-refundable)',
          })
        );
        return 0;
      }
      if (!io.isInteractive) {
        io.err(
          'refusing to spend channel funds without confirmation in a non-interactive ' +
            'session — re-run with --yes (or use --json for an estimate)'
        );
        return 1;
      }
      const proceed = await io.confirm(
        `Proceed with paid push (total ${plan.estimate.totalFee} base units)? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was uploaded or published.');
        return 1;
      }
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    const pushResult = await executePush({
      plan: pushPlan,
      publisher: standaloneCtx.publisher,
      remoteState,
      repoReader: reader,
      relayUrls: relaysUsed,
    });
    const result = serializePushResult(pushPlan, pushResult);

    // ── Receipts ────────────────────────────────────────────────────────────
    if (flags.json) {
      io.out(
        jsonOut({ command: 'push', repoId, identity, executed: true, upToDate: false, plan, result })
      );
    } else {
      for (const line of renderResult(result)) io.out(line);
    }
    return 0;
  } catch (err) {
    const described = describeError(err);
    if (flags.json) {
      io.out(JSON.stringify({ command: 'push', ...described.json }, null, 2));
    } else {
      for (const line of described.lines) io.err(line);
    }
    return 1;
  } finally {
    if (standaloneCtx) {
      try {
        await standaloneCtx.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}

function jsonOut(output: PushJsonOutput): string {
  return JSON.stringify(output, null, 2);
}
