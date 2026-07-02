/**
 * `rig push [refspecs...]` — estimate → confirm → execute (#229).
 *
 * One flow, two publisher modes (see ./mode.ts):
 *   daemon      estimate/execute via toon-clientd `POST /git/estimate|push`
 *               (the daemon plans AND publishes; its key signs, so its
 *               identity is the repo owner);
 *   standalone  plan locally (`planPush`) and execute through the embedded,
 *               nonce-guarded StandalonePublisher (loaded via dynamic import
 *               so daemon-mode runs never need `@toon-protocol/client`).
 *
 * Money is only spent after the confirm gate: `--yes`, or an interactive
 * y/N prompt (a non-TTY session without `--yes` refuses). `--json` emits the
 * wire-shaped plan/receipts for agent consumers; without `--yes` it becomes
 * a pure estimate (plan JSON, nothing executed, exit 0).
 */

import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { planPush, executePush, type PushPlan } from '../push.js';
import type { RemoteState } from '../remote-state.js';
import { GitRepoReader } from '../repo-reader.js';
import { renderPlan, renderResult } from './render.js';
import {
  serializePushPlan,
  serializePushResult,
  type GitEstimateRequest,
  type GitEstimateResponse,
  type GitPushResponse,
} from '../routes.js';
import { DaemonGitClient } from './daemon.js';
import { describeError } from './errors.js';
import {
  readToonConfig,
  resolveRepoRoot,
  writeToonConfig,
} from './git-config.js';
import { selectMode, type PushMode } from './mode.js';
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
  fetchImpl: typeof fetch;
  /** Standalone factory; defaults to the real dynamic-import loader. */
  loadStandalone?: LoadStandalone;
}

const defaultLoadStandalone: LoadStandalone = async (env) => {
  // Dynamic import: `standalone-mode` (and its optional
  // `@toon-protocol/client` peer dependency) only loads when standalone mode
  // is actually selected.
  const mod = await import('./standalone-mode.js');
  return mod.createStandaloneContext(env);
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const PUSH_USAGE = `Usage: rig push [refspecs...] [options]

Push local git refs to TOON: uploads the object delta to Arweave (paid) and
publishes the NIP-34 refs event (kind:30618; kind:30617 announce on first
push). Writes are permanent and non-refundable.

Refspecs are branch/tag names or full refnames; default is the current branch.

Options:
  --force            allow non-fast-forward ref updates (overwrites remote history)
  --all              push all local branches
  --tags             push all local tags
  --yes              skip the fee confirmation (required when not a TTY)
  --json             machine-readable plan/receipts; without --yes it is a pure
                     estimate (nothing executed)
  --relay <url>      relay URL (repeatable in daemon mode; standalone mode
                     supports exactly one; default: git config toon.relay,
                     then the mode's default relay)
  --repo-id <id>     repository id / NIP-34 d-tag (default: git config
                     toon.repoid, then the repo directory name)
  --daemon           force daemon mode (toon-clientd control API)
  --standalone       force standalone mode (embedded client from TOON_CLIENT_MNEMONIC)
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
  daemon: boolean;
  standalone: boolean;
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
      daemon: { type: 'boolean', default: false },
      standalone: { type: 'boolean', default: false },
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
    daemon: values.daemon ?? false,
    standalone: values.standalone ?? false,
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
  mode: PushMode;
  repoId: string;
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
  const { io, env, fetchImpl } = deps;

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
  /** Rich standalone plan carried from estimate to execute within this run. */
  let standalonePlan:
    | {
        pushPlan: PushPlan;
        remoteState: RemoteState;
        reader: GitRepoReader;
        relaysUsed: string[];
      }
    | undefined;
  try {
    // ── Repo + config resolution ────────────────────────────────────────────
    const repoRoot = await resolveRepoRoot(deps.cwd);
    const toonConfig = await readToonConfig(repoRoot);
    const repoId = flags.repoId ?? toonConfig.repoId ?? basename(repoRoot);
    const reader = new GitRepoReader(repoRoot);
    const refspecs = await selectRefspecs(
      reader,
      flags.positionals,
      flags.all,
      flags.tags
    );
    /** Explicitly-known relays (flags → git config); undefined = mode default. */
    const explicitRelays =
      flags.relay.length > 0
        ? flags.relay
        : toonConfig.relays.length > 0
          ? toonConfig.relays
          : undefined;

    // ── Mode selection ──────────────────────────────────────────────────────
    const { mode, probe } = await selectMode({
      daemon: flags.daemon,
      standalone: flags.standalone,
      env,
      fetchImpl,
    });

    // ── Estimate ────────────────────────────────────────────────────────────
    let plan: GitEstimateResponse;
    let identity: string | undefined;
    let relaysUsed: string[] | undefined = explicitRelays;
    const daemonClient = new DaemonGitClient(probe.baseUrl, fetchImpl);
    const daemonRequest: GitEstimateRequest = {
      repoPath: repoRoot,
      repoId,
      refspecs,
      force: flags.force,
      ...(explicitRelays ? { relayUrls: explicitRelays } : {}),
    };

    if (mode === 'daemon') {
      identity = probe.identity;
      relaysUsed ??= probe.relayUrl ? [probe.relayUrl] : undefined;
      plan = await daemonClient.gitEstimate(daemonRequest);
    } else {
      standaloneCtx = await (deps.loadStandalone ?? defaultLoadStandalone)(env);
      identity = standaloneCtx.ownerPubkey;
      relaysUsed ??= standaloneCtx.defaultRelayUrls;
      // StandalonePublisher publishes to exactly one relay (its publishEvent
      // throws on >1). Multiple relays can arrive here without explicit
      // intent — e.g. a daemon-mode push persisted several into git config
      // `toon.relay`, and a later daemon outage auto-selected standalone.
      // Refuse up front, before anything is fetched, uploaded, or paid.
      if (relaysUsed && relaysUsed.length > 1) {
        io.err(
          `standalone mode publishes to a single relay, but ${relaysUsed.length} are ` +
            `configured (${relaysUsed.join(', ')}) — re-run with exactly one ` +
            '--relay <url> (or trim git config toon.relay). Nothing was uploaded or paid.'
        );
        return 1;
      }
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
      plan = serializePushPlan(pushPlan);
      // Keep the rich plan for executePush (avoids a re-plan).
      standalonePlan = { pushPlan, remoteState, reader, relaysUsed };
    }

    if (toonConfig.owner && identity && toonConfig.owner !== identity) {
      io.err(
        `warning: git config toon.owner (${toonConfig.owner.slice(0, 8)}…) differs from ` +
          `the active ${mode} identity (${identity.slice(0, 8)}…) — this push publishes ` +
          "under the ACTIVE identity's repo namespace, not the configured owner's"
      );
    }

    // ── Up-to-date short-circuit (never publish a no-op refs event) ─────────
    const upToDate = plan.refUpdates.every((u) => u.kind === 'up-to-date');
    if (upToDate) {
      if (flags.json) {
        io.out(jsonOut({ command: 'push', mode, repoId, executed: false, upToDate: true, plan }));
      } else {
        io.out('Everything up-to-date — nothing to push (and nothing paid).');
      }
      return 0;
    }

    // ── Confirm gate ────────────────────────────────────────────────────────
    if (!flags.json) {
      for (const line of renderPlan(plan, mode)) io.out(line);
    }
    if (!flags.yes) {
      if (flags.json) {
        io.out(
          jsonOut({
            command: 'push',
            mode,
            repoId,
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
    let result: GitPushResponse;
    if (mode === 'daemon') {
      result = await daemonClient.gitPush({ ...daemonRequest, confirm: true });
    } else {
      const cached = standalonePlan;
      if (!cached || !standaloneCtx) {
        throw new Error('internal: standalone plan cache missing');
      }
      const pushResult = await executePush({
        plan: cached.pushPlan,
        publisher: standaloneCtx.publisher,
        remoteState: cached.remoteState,
        repoReader: cached.reader,
        relayUrls: cached.relaysUsed,
      });
      result = serializePushResult(cached.pushPlan, pushResult);
    }

    // ── Receipts ────────────────────────────────────────────────────────────
    if (flags.json) {
      io.out(
        jsonOut({ command: 'push', mode, repoId, executed: true, upToDate: false, plan, result })
      );
    } else {
      for (const line of renderResult(result)) io.out(line);
    }

    // ── rig init-lite: persist repo addressing after a successful push ──────
    try {
      await writeToonConfig(repoRoot, {
        repoId,
        ...(identity ? { owner: identity } : {}),
        ...(relaysUsed ? { relays: relaysUsed } : {}),
      });
    } catch (err) {
      io.err(
        `warning: push succeeded but persisting git config failed: ${err instanceof Error ? err.message : String(err)}`
      );
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
