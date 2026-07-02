/**
 * The single-event `rig` subcommands (#231): issue / comment / pr, where
 * `pr` nests `create` and `status` (#250 moved the NIP-34 status publish
 * from top-level `rig status` to `rig pr status` — bare `rig status` now
 * passes through to `git status`).
 *
 * One shared pipeline behind four thin arg-parsers, mirroring `rig push`
 * (./push.ts) exactly: repo addressing from the `toon.*` git config keys
 * `rig init` writes (`--repo-id`/`--owner` override; actionable "run
 * `rig init`" error when unconfigured), a fee-quoting confirm gate (`--yes`
 * skips; a non-TTY session without it refuses; `--json` without `--yes` is a
 * pure estimate), and ONE transport: build the NIP-34 event locally
 * (../nip34-events.ts — the same builders the toon-clientd daemon uses) and
 * pay-to-publish through the embedded, nonce-guarded StandalonePublisher
 * (#248: the CLI is standalone-only; the daemon keeps its own toon_git_* MCP
 * surface). The relay resolves like `rig push` (#249): `--remote <name>`
 * (default: the `origin` git remote), `--relay <url>` as an ad-hoc override
 * that bypasses remotes, deprecated `git config toon.relay` as a nudged
 * fallback. Publishes go to a SINGLE relay; multiple configured relays and
 * multi-URL remotes are refused before anything is paid (same guard as push).
 *
 * `rig pr create --range` runs REAL `git format-patch --stdout <range>` in
 * the local repository and publishes its output as the kind:1617 content —
 * one event for the whole series (cover-letter threading is out of scope in
 * v1; see the usage text).
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  REPOSITORY_ANNOUNCEMENT_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
} from '@toon-protocol/core/nip34';
import {
  buildComment,
  buildIssue,
  buildPatch,
  buildStatus,
  type StatusKind,
  type UnsignedEvent,
} from '../nip34-events.js';
import { GitRepoReader } from '../repo-reader.js';
import {
  serializeEventReceipt,
  type GitEventResponse,
  type GitRepoAddr,
  type GitStatusValue,
} from '../routes.js';
import { emitCliError, UnconfiguredRepoAddressError } from './errors.js';
import { readToonConfig, resolveRepoRoot, type ToonRepoConfig } from './git-config.js';
import {
  defaultLoadStandalone,
  identityReport,
  type IdentityReport,
  type PushDeps,
} from './push.js';
import { resolveRelays, singleRelayRefusal } from './remote.js';
import { feeLabel, renderEventPlan, renderEventReceipt } from './render.js';
import type { StandaloneContext } from './standalone-context.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Push deps plus a stdin reader (issue-body fallback); tests inject both. */
export interface EventCommandDeps extends PushDeps {
  /** Read all of stdin as UTF-8 (default: the real process stdin). */
  readStdin?: () => Promise<string>;
}

const defaultReadStdin = async (): Promise<string> => {
  // Never block waiting for keyboard input (e.g. stdout piped but stdin a
  // TTY): an interactive stdin yields no body, which surfaces as the clear
  // "body is empty" error instead of a hang.
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Flags every single-event subcommand shares (mirrors `rig push`). */
const COMMON_FLAGS_USAGE = `  --repo-id <id>       repository id / NIP-34 d-tag (default: git config
                       toon.repoid — run \`rig init\` to set it)
  --owner <pubkey>     repository owner pubkey, 64-char hex (default: git config
                       toon.owner, then the active identity)
  --remote <name>      publish via this configured git remote (default: the
                       "origin" remote — \`rig remote add origin <relay-url>\`)
  --relay <url>        ad-hoc relay override (exactly one) — bypasses the
                       configured remotes. The deprecated v0.1 \`git config
                       toon.relay\` still works as a fallback, with a nudge
  --yes                skip the fee confirmation (required when not a TTY)
  --json               machine-readable receipt; without --yes it is a pure
                       estimate (nothing published, exit 0)
  -h, --help           show this help`;

export const ISSUE_USAGE = `Usage: rig issue create --title <title> [options]

File an issue (kind:1621) against a TOON repo — a paid publish; writes are
permanent and non-refundable. The repo address (30617:<owner>:<repoId>) comes
from the toon.* git config keys \`rig init\` writes.

Body source (exactly one): --body, --body-file, or piped stdin.

Options:
  --title <title>      issue title (subject tag) [required]
  --body <text>        issue body (Markdown)
  --body-file <path>   read the issue body from a file
  --label <label>      label (t tag); repeatable
${COMMON_FLAGS_USAGE}`;

export const COMMENT_USAGE = `Usage: rig comment <root-event-id> --body <text> [options]

Comment (kind:1622) on an issue or patch — a paid publish; writes are
permanent and non-refundable. <root-event-id> is the 64-char hex id of the
kind:1621 issue / kind:1617 patch being commented on.

Options:
  --body <text>            comment body (Markdown) [required]
  --parent-author <pubkey> pubkey of the TARGET event's author (p threading
                           tag; default: the repo owner)
  --marker <root|reply>    e-tag marker (default: root — commenting directly
                           on the issue/patch)
${COMMON_FLAGS_USAGE}`;

export const PR_CREATE_USAGE = `Usage: rig pr create --title <title> (--range <range> | --patch-file <path>) [options]

Publish a patch (kind:1617) whose content is REAL \`git format-patch\` output —
a paid publish; writes are permanent and non-refundable. --range runs
\`git format-patch --stdout <range>\` in the local repository and derives the
commit/parent-commit tags; --patch-file publishes a pre-generated patch
verbatim. A multi-commit range publishes ONE kind:1617 event carrying the
full series text — cover-letter threading (one event per commit) is out of
scope in v1.

Options:
  --title <title>      patch/PR title (subject tag) [required]
  --range <range>      revision range for format-patch: <rev>, <rev>..<rev>,
                       or <rev>...<rev> (mutually exclusive with --patch-file)
  --patch-file <path>  literal patch text to publish
  --branch <name>      branch name (t tag)
${COMMON_FLAGS_USAGE}`;

export const PR_STATUS_USAGE = `Usage: rig pr status <target-event-id> <open|applied|closed|draft> [options]

Set the status of an issue or patch — a paid publish; writes are permanent
and non-refundable. Publishes kind:1630 (open), 1631 (applied), 1632
(closed), or 1633 (draft) against the 64-char hex id of the target event,
with the repo a-tag attached so readers can scope a status stream to the
repository. (This command was \`rig status\` before v2 — bare \`rig status\`
now passes through to \`git status\`.)

Options:
${COMMON_FLAGS_USAGE}`;

export const PR_USAGE = `${PR_CREATE_USAGE}

${PR_STATUS_USAGE}`;

// ---------------------------------------------------------------------------
// Shared flag parsing
// ---------------------------------------------------------------------------

const HEX64_RE = /^[0-9a-f]{64}$/;

function assertHex64(value: string, what: string): void {
  if (!HEX64_RE.test(value)) {
    throw new Error(
      `${what} must be a 64-char lowercase hex id (got ${JSON.stringify(value)})`
    );
  }
}

/** parseArgs options every subcommand accepts (mirrors `rig push`). */
const COMMON_OPTIONS = {
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  relay: { type: 'string', multiple: true },
  remote: { type: 'string' },
  'repo-id': { type: 'string' },
  owner: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

interface CommonFlags {
  yes: boolean;
  json: boolean;
  relay: string[];
  remote?: string;
  repoId?: string;
  owner?: string;
  help: boolean;
}

function pickCommon(values: Record<string, unknown>): CommonFlags {
  const flags: CommonFlags = {
    yes: values['yes'] === true,
    json: values['json'] === true,
    relay: Array.isArray(values['relay']) ? (values['relay'] as string[]) : [],
    help: values['help'] === true,
  };
  const remote = values['remote'];
  if (typeof remote === 'string') flags.remote = remote;
  const repoId = values['repo-id'];
  if (typeof repoId === 'string') flags.repoId = repoId;
  const owner = values['owner'];
  if (typeof owner === 'string') {
    assertHex64(owner, '--owner');
    flags.owner = owner;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Shared publish pipeline
// ---------------------------------------------------------------------------

type EventCommand = 'issue' | 'comment' | 'pr' | 'pr status';

interface RunEventOptions {
  command: EventCommand;
  flags: CommonFlags;
  deps: EventCommandDeps;
  /** Human action label WITHOUT the kind, e.g. `issue "Fix the flux"`. */
  actionLabel: string;
  /**
   * Build the unsigned NIP-34 event for the resolved repo address — the
   * publish payload, and the source of truth for the kind. May do real work
   * (pr runs format-patch here), so failures land in the normal error path.
   */
  buildEvent: (addr: GitRepoAddr) => Promise<UnsignedEvent>;
}

/** JSON envelope emitted by `--json` runs (agents consume this). */
interface EventJsonOutput {
  command: EventCommand;
  repoAddr: GitRepoAddr;
  /** Active identity: source tier + derived pubkey (never the phrase). */
  identity: IdentityReport;
  /** NIP-34 kind this command publishes. */
  kind: number;
  /** True when the paid publish ran. */
  executed: boolean;
  /** Per-event fee (base units, decimal string). */
  feeEstimate: string | null;
  result?: GitEventResponse;
  hint?: string;
}

/**
 * The estimate → confirm → execute flow shared by all four subcommands.
 * Money moves only after the confirm gate and the single-relay guard.
 */
async function runEvent(opts: RunEventOptions): Promise<number> {
  const { command, flags, deps, actionLabel } = opts;
  const { io, env } = deps;

  let standaloneCtx: StandaloneContext | undefined;
  try {
    // ── Repo addressing (best-effort git config; flags can stand alone) ─────
    let repoRoot: string | undefined;
    let toonConfig: ToonRepoConfig = { relays: [] };
    try {
      repoRoot = await resolveRepoRoot(deps.cwd);
      toonConfig = await readToonConfig(repoRoot);
    } catch {
      // Not inside a git repository — --repo-id/--owner must carry the address.
    }
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');

    // ── Relay resolution (#249: --relay > --remote > origin > toon.relay) ───
    const resolved = await resolveRelays({
      relayFlags: flags.relay,
      remoteName: flags.remote,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    if (resolved.nudge !== undefined) io.err(resolved.nudge);
    const relaysUsed = resolved.relays;
    // Same pre-pay guard as push: StandalonePublisher publishes to exactly
    // one relay, and multiple can arrive without explicit intent (repeated
    // --relay flags, an old multi-valued git config `toon.relay`). Refuse
    // before anything is paid.
    if (relaysUsed.length > 1) {
      io.err(singleRelayRefusal(resolved, 'Nothing was published or paid.'));
      return 1;
    }

    // ── Standalone context (identity chain + nonce guard) + per-event fee ───
    standaloneCtx = await (deps.loadStandalone ?? defaultLoadStandalone)({
      env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
      // Relay-origin for #264 network bootstrap (announce discovery).
      ...(relaysUsed[0] !== undefined ? { relayUrl: relaysUsed[0] } : {}),
    });
    const identity = identityReport(standaloneCtx);
    const fee = (await standaloneCtx.publisher.getFeeRates()).eventFee.toString();

    const owner = flags.owner ?? toonConfig.owner ?? identity.pubkey;
    const addr: GitRepoAddr = { ownerPubkey: owner, repoId };

    // Built once: the publish payload AND the kind for rendering.
    const event = await opts.buildEvent(addr);
    const action = `kind:${event.kind} ${actionLabel}`;

    // ── Confirm gate (identical semantics to `rig push`) ────────────────────
    if (!flags.json) {
      for (const line of renderEventPlan({ action, addr, identity, fee })) {
        io.out(line);
      }
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          command,
          repoAddr: addr,
          identity,
          kind: event.kind,
          executed: false,
          feeEstimate: fee,
          hint: 'estimate only — re-run with --yes to publish (permanent, non-refundable)',
        } satisfies EventJsonOutput);
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
        `Proceed with paid publish (${feeLabel(fee)})? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was published.');
        return 1;
      }
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    const receipt = await standaloneCtx.publisher.publishEvent(event, relaysUsed);
    const result = serializeEventReceipt(event.kind, receipt);

    // ── Receipts ────────────────────────────────────────────────────────────
    if (flags.json) {
      io.emitJson({
        command,
        repoAddr: addr,
        identity,
        kind: result.kind,
        executed: true,
        feeEstimate: fee,
        result,
      } satisfies EventJsonOutput);
    } else {
      for (const line of renderEventReceipt(action, result)) io.out(line);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, command, err);
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

// ---------------------------------------------------------------------------
// rig issue create
// ---------------------------------------------------------------------------

/** Run `rig issue …`; returns the process exit code. */
export async function runIssue(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    io.out(ISSUE_USAGE);
    return 0;
  }
  if (sub !== 'create') {
    io.err(
      sub === undefined
        ? 'missing subcommand: rig issue create'
        : `unknown rig issue subcommand: ${sub}`
    );
    io.err(ISSUE_USAGE);
    return 2;
  }

  let flags: CommonFlags;
  let title: string;
  let bodyFlag: string | undefined;
  let bodyFile: string | undefined;
  let labels: string[];
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        ...COMMON_OPTIONS,
        title: { type: 'string' },
        body: { type: 'string' },
        'body-file': { type: 'string' },
        label: { type: 'string', multiple: true },
      },
      allowPositionals: false,
    });
    flags = pickCommon(values);
    if (!flags.help && (values.title === undefined || values.title === '')) {
      throw new Error('--title is required');
    }
    if (values.body !== undefined && values['body-file'] !== undefined) {
      throw new Error('--body and --body-file are mutually exclusive');
    }
    title = values.title ?? '';
    bodyFlag = values.body;
    bodyFile = values['body-file'];
    labels = values.label ?? [];
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(ISSUE_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(ISSUE_USAGE);
    return 0;
  }

  // Body source: --body → --body-file → piped stdin.
  let body: string;
  if (bodyFlag !== undefined) {
    body = bodyFlag;
  } else if (bodyFile !== undefined) {
    try {
      body = await readFile(bodyFile, 'utf-8');
    } catch (err) {
      io.err(
        `cannot read --body-file ${bodyFile}: ${err instanceof Error ? err.message : String(err)}`
      );
      return 2;
    }
  } else if (!io.isInteractive) {
    body = await (deps.readStdin ?? defaultReadStdin)();
  } else {
    io.err('an issue body is required: pass --body/--body-file or pipe stdin');
    io.err(ISSUE_USAGE);
    return 2;
  }
  if (body.trim() === '') {
    io.err('the issue body is empty — nothing to publish');
    return 2;
  }

  return runEvent({
    command: 'issue',
    flags,
    deps,
    actionLabel: `issue ${JSON.stringify(title)}`,
    buildEvent: async (addr) =>
      buildIssue(addr.ownerPubkey, addr.repoId, title, body, labels),
  });
}

// ---------------------------------------------------------------------------
// rig comment
// ---------------------------------------------------------------------------

/** Run `rig comment …`; returns the process exit code. */
export async function runComment(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;

  let flags: CommonFlags;
  let rootEventId: string;
  let body: string;
  let parentAuthor: string | undefined;
  let marker: 'root' | 'reply';
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        ...COMMON_OPTIONS,
        body: { type: 'string' },
        'parent-author': { type: 'string' },
        marker: { type: 'string' },
      },
      allowPositionals: true,
    });
    flags = pickCommon(values);
    if (flags.help) {
      io.out(COMMENT_USAGE);
      return 0;
    }
    if (positionals.length !== 1) {
      throw new Error(
        positionals.length === 0
          ? '<root-event-id> is required'
          : `expected exactly one <root-event-id>, got ${positionals.length} positionals`
      );
    }
    rootEventId = positionals[0] as string;
    assertHex64(rootEventId, '<root-event-id>');
    if (values.body === undefined || values.body === '') {
      throw new Error('--body is required');
    }
    body = values.body;
    parentAuthor = values['parent-author'];
    if (parentAuthor !== undefined) assertHex64(parentAuthor, '--parent-author');
    const rawMarker = values.marker ?? 'root';
    if (rawMarker !== 'root' && rawMarker !== 'reply') {
      throw new Error(`--marker must be root or reply (got ${JSON.stringify(rawMarker)})`);
    }
    marker = rawMarker;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(COMMENT_USAGE);
    return 2;
  }

  return runEvent({
    command: 'comment',
    flags,
    deps,
    actionLabel: `comment on ${rootEventId.slice(0, 8)}…`,
    buildEvent: async (addr) =>
      buildComment(
        addr.ownerPubkey,
        addr.repoId,
        rootEventId,
        parentAuthor ?? addr.ownerPubkey,
        body,
        marker
      ),
  });
}

// ---------------------------------------------------------------------------
// rig pr create
// ---------------------------------------------------------------------------

/** `From <sha> <date>` separator lines of `git format-patch --stdout` output. */
const PATCH_FROM_RE = /^From ([0-9a-f]{40}) /gm;

/** Commit SHAs of a format-patch series, in patch (oldest-first) order. */
export function extractPatchShas(patchText: string): string[] {
  return [...patchText.matchAll(PATCH_FROM_RE)].map((m) => m[1] as string);
}

/** Run `rig pr …` (nested dispatch: create | status); returns the exit code. */
export async function runPr(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  switch (sub) {
    case 'create':
      return runPrCreate(rest, deps);
    case 'status':
      return runPrStatus(rest, deps);
    case '--help':
    case '-h':
    case 'help':
      io.out(PR_USAGE);
      return 0;
    default:
      io.err(
        sub === undefined
          ? 'missing subcommand: rig pr <create|status>'
          : `unknown rig pr subcommand: ${sub}`
      );
      io.err(PR_USAGE);
      return 2;
  }
}

/** `rig pr create` — kind:1617 patch publish. */
async function runPrCreate(
  rest: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;

  let flags: CommonFlags;
  let title: string;
  let range: string | undefined;
  let patchFile: string | undefined;
  let branch: string | undefined;
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        ...COMMON_OPTIONS,
        title: { type: 'string' },
        range: { type: 'string' },
        'patch-file': { type: 'string' },
        branch: { type: 'string' },
      },
      allowPositionals: false,
    });
    flags = pickCommon(values);
    if (flags.help) {
      io.out(PR_CREATE_USAGE);
      return 0;
    }
    if (values.title === undefined || values.title === '') {
      throw new Error('--title is required');
    }
    if ((values.range === undefined) === (values['patch-file'] === undefined)) {
      throw new Error('exactly one of --range or --patch-file is required');
    }
    title = values.title;
    range = values.range;
    patchFile = values['patch-file'];
    branch = values.branch;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(PR_CREATE_USAGE);
    return 2;
  }

  return runEvent({
    command: 'pr',
    flags,
    deps,
    actionLabel: `patch ${JSON.stringify(title)}`,
    buildEvent: async (addr) => {
      let patchText: string;
      let commits: { sha: string; parentSha: string }[];
      if (range !== undefined) {
        // REAL format-patch output from the local repository (v1 publishes
        // the whole series as ONE event; see PR_USAGE).
        const reader = new GitRepoReader(await resolveRepoRoot(deps.cwd));
        patchText = await reader.formatPatch(range);
        if (patchText === '') {
          throw new Error(
            `range ${JSON.stringify(range)} selects no commits — nothing to publish`
          );
        }
        // commit/parent-commit tags for exactly the commits the series
        // carries (parsed from the patch itself, so the tags can never drift
        // from the content). Root commits have no parent and contribute no
        // tag pair.
        const shas = extractPatchShas(patchText);
        const parents = await reader.commitParents(shas);
        commits = shas.flatMap((sha) => {
          const parentSha = parents.get(sha)?.[0];
          return parentSha ? [{ sha, parentSha }] : [];
        });
      } else {
        patchText = await readFile(patchFile as string, 'utf-8');
        if (patchText.trim() === '') {
          throw new Error(`--patch-file ${patchFile} is empty — nothing to publish`);
        }
        commits = [];
      }
      return buildPatch(
        addr.ownerPubkey,
        addr.repoId,
        title,
        commits,
        branch,
        patchText
      );
    },
  });
}

// ---------------------------------------------------------------------------
// rig pr status (top-level `rig status` before #250 — now git's)
// ---------------------------------------------------------------------------

/** NIP-34 status kinds by wire value (mirrors the daemon's mapping). */
const STATUS_KIND_BY_VALUE: Record<GitStatusValue, StatusKind> = {
  open: STATUS_OPEN_KIND,
  applied: STATUS_APPLIED_KIND,
  closed: STATUS_CLOSED_KIND,
  draft: STATUS_DRAFT_KIND,
};

function isStatusValue(value: string): value is GitStatusValue {
  return Object.hasOwn(STATUS_KIND_BY_VALUE, value);
}

/** `rig pr status` — kind:1630-1633 status publish. */
async function runPrStatus(
  args: string[],
  deps: EventCommandDeps
): Promise<number> {
  const { io } = deps;

  let flags: CommonFlags;
  let targetEventId: string;
  let status: GitStatusValue;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: COMMON_OPTIONS,
      allowPositionals: true,
    });
    flags = pickCommon(values);
    if (flags.help) {
      io.out(PR_STATUS_USAGE);
      return 0;
    }
    if (positionals.length !== 2) {
      throw new Error(
        'expected exactly two arguments: <target-event-id> <open|applied|closed|draft>'
      );
    }
    targetEventId = positionals[0] as string;
    assertHex64(targetEventId, '<target-event-id>');
    const rawStatus = positionals[1] as string;
    if (!isStatusValue(rawStatus)) {
      throw new Error(
        `status must be one of open | applied | closed | draft (got ${JSON.stringify(rawStatus)})`
      );
    }
    status = rawStatus;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(PR_STATUS_USAGE);
    return 2;
  }

  return runEvent({
    command: 'pr status',
    flags,
    deps,
    actionLabel: `status ${status} on ${targetEventId.slice(0, 8)}…`,
    buildEvent: async (addr) => {
      const event = buildStatus(targetEventId, STATUS_KIND_BY_VALUE[status]);
      // NIP-34 status events also carry the repo `a` tag so readers can scope
      // a status stream to the repository without resolving the target first
      // (mirrors the daemon's gitStatus).
      event.tags.push([
        'a',
        `${REPOSITORY_ANNOUNCEMENT_KIND}:${addr.ownerPubkey}:${addr.repoId}`,
      ]);
      return event;
    },
  });
}
