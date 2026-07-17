/**
 * `rig push [remote] [refspecs...]` — estimate → confirm → execute (#229,
 * standalone since #248, git-like remote resolution since #249,
 * daemon-as-accelerator since #279).
 *
 * STANDALONE is the default and the guarantee: plan locally (`planPush`) and
 * execute through the embedded, nonce-guarded StandalonePublisher (loaded
 * via dynamic import so runs that fail earlier never need
 * `@toon-protocol/client`). The identity comes from the RIG_MNEMONIC
 * precedence chain (./identity.ts).
 *
 * DAEMON FAST PATH (#279, ./daemon-session.ts): when a running toon-clientd
 * holds the SAME identity, the whole estimate→push pipeline is delegated to
 * its loopback `/git/estimate` + `/git/push` routes instead of refusing —
 * the daemon already owns the channel watermark and its bootstrap is warm,
 * so the command finishes in seconds. A daemon on a different identity, or
 * no daemon, runs standalone. The chosen path prints to stderr and lands in
 * the `--json` envelope as `path`.
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

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  DEFAULT_RIG_WEB_URL,
  RIG_WEB_URL_ENV,
  generateRigPointerHtml,
} from '../rig-pointer.js';
import { hexToNpub } from '../npub.js';
import { planPush, executePush } from '../push.js';
import { GitRepoReader } from '../repo-reader.js';
import { readRigPointerRecord, writeRigPointerRecord } from './rig-pointer-record.js';
import { renderIdentityLine, renderPlan, renderResult } from './render.js';
import {
  serializePushPlan,
  serializePushResult,
  type GitEstimateResponse,
  type GitPushResponse,
} from '../routes.js';
import {
  resolvePaidSession,
  type PaidSession,
  type ProbeDaemon,
  type SessionPath,
} from './daemon-session.js';
import { emitCliError, UnconfiguredRepoAddressError } from './errors.js';
import { listGitRemotes, readToonConfig, resolveRepoRoot } from './git-config.js';
import type { IdentitySourceKind } from './identity.js';
import { resolveRelays, singleRelayRefusal } from './remote.js';
import type { LoadStandalone, StandaloneContext } from './standalone-context.js';

// ---------------------------------------------------------------------------
// Dependency seam (real wiring in rig.ts; tests inject fakes)
// ---------------------------------------------------------------------------

/**
 * Terminal I/O seam — lives in ./output.ts since #265 (the strict `--json`
 * stdout layer); re-exported here because every command module historically
 * imports it from push.ts.
 */
export type { CliIo } from './output.js';
import type { CliIo } from './output.js';

export interface PushDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Standalone factory; defaults to the real dynamic-import loader. */
  loadStandalone?: LoadStandalone;
  /** Fetch for the daemon probe + delegated `/git/*` requests (tests). */
  fetchImpl?: typeof fetch;
  /** Daemon `/status` probe override (tests fake the loopback daemon). */
  probeDaemon?: ProbeDaemon;
}

/**
 * Resolve the paid session for a command from its deps (#279): probe for a
 * same-identity toon-clientd (→ delegate) before falling back to the
 * standalone loader. Shared by push and the single-event commands.
 */
export function loadPaidSession(
  deps: PushDeps,
  relayUrl: string | undefined
): Promise<PaidSession> {
  return resolvePaidSession({
    env: deps.env,
    cwd: deps.cwd,
    warn: (line) => deps.io.err(line),
    loadStandalone: deps.loadStandalone ?? defaultLoadStandalone,
    ...(relayUrl !== undefined ? { relayUrl } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.probeDaemon ? { probeDaemon: deps.probeDaemon } : {}),
  });
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

Every push also keeps the repo's RIG PAGE current: a tiny permanent
Arweave page that opens this repo in the Rig (rig-web) — the
repo's GitHub-Pages equivalent, served from any ar.io gateway. The pointer
is content-addressed, so it is paid for once and reused for free until the
relay or rig-web deployment changes. --no-rig-page skips it.

Options:
  --force            allow non-fast-forward ref updates (overwrites remote history)
  --all              push all local branches
  --tags             push all local tags
  --no-rig-page      skip the Rig-page pointer upload for this push
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
 * Build the "no such local ref" error: name the missing ref, then point at the
 * current branch (with a `did you mean` using the real branch name) or, when
 * HEAD is detached/unborn, list the local branches. This is deliberately NOT
 * the ref-deletion guard — a branch that simply doesn't exist is the common
 * case (e.g. the docs say `main` but the repo is on `master`), and mentioning
 * "ref deletion" there is a confusing red herring.
 */
function noSuchRefMessage(
  spec: string,
  head: string | undefined,
  refs: readonly { refname: string }[],
  remoteName: string
): string {
  const branches = refs
    .filter((r) => r.refname.startsWith('refs/heads/'))
    .map((r) => r.refname.slice('refs/heads/'.length));
  const current =
    head && head.startsWith('refs/heads/')
      ? head.slice('refs/heads/'.length)
      : undefined;
  let msg = `no local branch or tag ${JSON.stringify(spec)}`;
  if (current) {
    msg +=
      ` — your current branch is ${JSON.stringify(current)} ` +
      `(did you mean \`rig push ${remoteName} ${current}\`?)`;
  } else if (branches.length > 0) {
    msg += ` — local branches: ${branches.join(', ')}`;
  } else {
    msg += ' — this repository has no branches yet (make a commit first)';
  }
  return msg;
}

/**
 * Expand positional refspecs / `--all` / `--tags` into full refnames using
 * the local ref list; default (no selection) is the current branch.
 * `remoteName` (default `origin`) only shapes the `did you mean` hint on a
 * missing ref.
 */
export async function selectRefspecs(
  reader: GitRepoReader,
  positionals: string[],
  all: boolean,
  tags: boolean,
  remoteName = 'origin'
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
    } else if (spec.startsWith(':')) {
      // git deletion syntax (`rig push origin :branch`) — the one case where
      // "out of scope in v1" genuinely applies.
      throw new Error(
        `deleting remote refs (${JSON.stringify(spec)}) is out of scope in v1`
      );
    } else {
      throw new Error(noSuchRefMessage(spec, head, refs, remoteName));
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
  /** Deploy/refresh the per-repo Rig page (default; --no-rig-page skips). */
  rigPage: boolean;
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
      'no-rig-page': { type: 'boolean', default: false },
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
    rigPage: !(values['no-rig-page'] ?? false),
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

// ---------------------------------------------------------------------------
// Rig pointer (per-repo Rig page — see ../rig-pointer.ts)
// ---------------------------------------------------------------------------

/** The Rig-pointer step resolved for THIS push, before the confirm gate. */
interface RigPointerPlan {
  /** 'upload' pays for a (new/changed) pointer; 'unchanged' reuses for free. */
  action: 'upload' | 'unchanged';
  html: string;
  contentHash: string;
  bytes: number;
  /** Fee for the upload action, base units (0n when unchanged). */
  fee: bigint;
  /** Recorded txId (unchanged action only). */
  recordedTxId?: string;
}

/** Rig-page report in receipts / the `--json` envelope. */
export interface RigPageReport {
  /** What happened: fresh upload, free reuse, or skipped (flag/daemon path). */
  status: 'published' | 'unchanged' | 'skipped';
  txId?: string;
  /** Permanent pointer URL on the preferred ar.io gateway. */
  url?: string;
  feePaid?: string;
  detail?: string;
}

/**
 * Gateway for printed Rig-page URLs. A PRINTED URL is a single address with
 * no client-side fallback, so it must be the most RELIABLE gateway — the
 * flagship `arweave.net` (matching `rig site`'s DEFAULT_GATEWAY) — not the
 * first entry of the fetch-redundancy list (`ar-io.dev`, which the object
 * fetcher can afford to try first because it falls back; a browser can't).
 * `RIG_ARWEAVE_GATEWAY` overrides, same as `rig site`.
 */
function pointerGateway(env: NodeJS.ProcessEnv): string {
  return (env['RIG_ARWEAVE_GATEWAY'] ?? 'https://arweave.net').replace(
    /\/+$/,
    ''
  );
}

/** Build the Rig-pointer plan: deterministic pointer + content-addressed skip. */
function planRigPointer(args: {
  env: NodeJS.ProcessEnv;
  ownerPubkey: string;
  repoId: string;
  relay: string;
  uploadFeePerByte: bigint;
}): RigPointerPlan {
  const html = generateRigPointerHtml({
    rigWebUrl: args.env[RIG_WEB_URL_ENV] ?? DEFAULT_RIG_WEB_URL,
    relay: args.relay,
    ownerNpub: hexToNpub(args.ownerPubkey),
    repoId: args.repoId,
  });
  const contentHash = createHash('sha256').update(html).digest('hex');
  const bytes = Buffer.byteLength(html);
  const record = readRigPointerRecord(args.env, args.repoId);
  if (
    record &&
    record.contentHash === contentHash &&
    record.owner === args.ownerPubkey
  ) {
    return {
      action: 'unchanged',
      html,
      contentHash,
      bytes,
      fee: 0n,
      recordedTxId: record.pointerTxId,
    };
  }
  return {
    action: 'upload',
    html,
    contentHash,
    bytes,
    fee: BigInt(bytes) * args.uploadFeePerByte,
  };
}

/** JSON envelope emitted by `--json` runs (agents consume this). */
interface PushJsonOutput {
  command: 'push';
  repoId: string;
  /** Which transport paid: delegated daemon or embedded standalone (#279). */
  path: SessionPath;
  /** Active identity: source tier + derived pubkey (never the phrase). */
  identity: IdentityReport;
  /** True when the paid execute step ran. */
  executed: boolean;
  /** True when every selected ref already matched the remote (no-op). */
  upToDate: boolean;
  plan: GitEstimateResponse;
  result?: GitPushResponse;
  /** Per-repo Rig-page outcome (absent on estimates / early exits). */
  rigPage?: RigPageReport;
  hint?: string;
}

/** Run `rig push`; returns the process exit code. */
export async function runPush(args: string[], deps: PushDeps): Promise<number> {
  const { io } = deps;

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
      flags.tags,
      remoteName ?? 'origin'
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

    // ── Paid session (#279): same-identity daemon → delegate; else the
    // standalone context (identity chain + nonce guard).
    const session = await loadPaidSession(deps, relaysUsed[0]);
    const path = session.path;
    let identity: IdentityReport;
    if (session.path === 'standalone') {
      standaloneCtx = session.ctx;
      identity = identityReport(standaloneCtx);
    } else {
      identity = session.identity;
    }

    if (toonConfig.owner && toonConfig.owner !== identity.pubkey) {
      io.err(
        `warning: git config toon.owner (${toonConfig.owner.slice(0, 8)}…) differs from ` +
          `the active identity (${identity.pubkey.slice(0, 8)}…) — this push publishes ` +
          "under the ACTIVE identity's repo namespace, not the configured owner's. " +
          'Re-run `rig init` to adopt the active identity.'
      );
    }

    // ── Estimate ────────────────────────────────────────────────────────────
    // Standalone plans locally; the daemon path delegates the plan to
    // `POST /git/estimate` (same wire shape — ../routes.ts).
    let plan: GitEstimateResponse;
    let execute: () => Promise<GitPushResponse>;
    let pointerPlan: RigPointerPlan | undefined;
    let rigPageSkipDetail: string | undefined;
    if (session.path === 'standalone') {
      const ctx = session.ctx;
      const remoteState = await ctx.fetchRemote({
        ownerPubkey: ctx.ownerPubkey,
        repoId,
        relayUrls: relaysUsed,
      });
      const feeRates = await ctx.publisher.getFeeRates();
      const pushPlan = await planPush({
        repoReader: reader,
        remoteState,
        feeRates,
        repoId,
        refs: refspecs,
        force: flags.force,
      });
      plan = serializePushPlan(pushPlan);
      execute = async () =>
        serializePushResult(
          pushPlan,
          await executePush({
            plan: pushPlan,
            publisher: ctx.publisher,
            remoteState,
            repoReader: reader,
            relayUrls: relaysUsed,
          })
        );
      // ── Rig page (the repo's rig-web page) — planned BEFORE the
      // confirm gate so its fee is part of what the user approves.
      if (!flags.rigPage) {
        rigPageSkipDetail = 'skipped (--no-rig-page)';
      } else if (relaysUsed[0] === undefined) {
        rigPageSkipDetail = 'skipped (no relay resolved for the pointer)';
      } else if (!ctx.publisher.uploadBlob) {
        rigPageSkipDetail =
          'skipped (the active publisher cannot upload raw blobs)';
      } else {
        pointerPlan = planRigPointer({
          env: deps.env,
          ownerPubkey: ctx.ownerPubkey,
          repoId,
          relay: relaysUsed[0],
          uploadFeePerByte: feeRates.uploadFeePerByte,
        });
      }
    } else {
      const client = session.client;
      plan = await client.gitEstimate({
        repoPath: repoRoot,
        repoId,
        refspecs,
        force: flags.force,
        relayUrls: relaysUsed,
      });
      execute = () =>
        client.gitPush({
          repoPath: repoRoot,
          repoId,
          refspecs,
          force: flags.force,
          relayUrls: relaysUsed,
          confirm: true,
        });
      // The delegated daemon owns the paid pipeline but exposes no raw-blob
      // upload route yet — the pointer refreshes on the next standalone push.
      rigPageSkipDetail = 'skipped on the daemon path (refreshes on the next standalone push)';
    }

    // ── Up-to-date short-circuit (never publish a no-op refs event) ─────────
    const upToDate = plan.refUpdates.every((u) => u.kind === 'up-to-date');
    if (upToDate) {
      if (flags.json) {
        io.emitJson({
          command: 'push',
          repoId,
          path,
          identity,
          executed: false,
          upToDate: true,
          plan,
        } satisfies PushJsonOutput);
      } else {
        io.out('Everything up-to-date — nothing to push (and nothing paid).');
      }
      return 0;
    }

    // ── Confirm gate ────────────────────────────────────────────────────────
    // The confirmed total covers the push plan PLUS a (new/changed) Rig
    // pointer; an unchanged pointer is free and printed as such.
    const confirmTotal =
      BigInt(plan.estimate.totalFee) + (pointerPlan?.fee ?? 0n);
    if (!flags.json) {
      for (const line of renderPlan(plan)) io.out(line);
      if (pointerPlan?.action === 'upload') {
        io.out(
          `  rig page  ${pointerPlan.bytes} bytes   ${pointerPlan.fee}` +
            ` (repo page — paid once, reused until relay/rig-web changes)`
        );
        io.out(`  total with rig page     ${confirmTotal}`);
      }
      io.out(renderIdentityLine(identity));
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          command: 'push',
          repoId,
          path,
          identity,
          executed: false,
          upToDate: false,
          plan,
          hint: 'estimate only — re-run with --yes to upload and publish (permanent, non-refundable)',
        } satisfies PushJsonOutput);
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
        `Proceed with paid push (total ${confirmTotal} base units)? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was uploaded or published.');
        return 1;
      }
    }

    // ── Execute ─────────────────────────────────────────────────────────────
    const result = await execute();

    // ── Rig-page pointer publish (after the push succeeded; never fails it) ────
    const gateway = pointerGateway(deps.env);
    let rigPage: RigPageReport;
    if (!pointerPlan) {
      rigPage = { status: 'skipped', ...(rigPageSkipDetail ? { detail: rigPageSkipDetail } : {}) };
    } else if (pointerPlan.action === 'unchanged') {
      rigPage = {
        status: 'unchanged',
        txId: pointerPlan.recordedTxId as string,
        url: `${gateway}/${pointerPlan.recordedTxId}`,
      };
    } else {
      try {
        // Guarded above: pointerPlan only exists when uploadBlob is available.
        const ctx = standaloneCtx as StandaloneContext;
        const receipt = await (
          ctx.publisher.uploadBlob as NonNullable<
            typeof ctx.publisher.uploadBlob
          >
        )({
          body: Buffer.from(pointerPlan.html, 'utf8'),
          contentType: 'text/html',
          repoId,
        });
        writeRigPointerRecord(deps.env, {
          repoId,
          owner: identity.pubkey,
          pointerTxId: receipt.txId,
          contentHash: pointerPlan.contentHash,
          updatedAt: Date.now(),
        });
        rigPage = {
          status: 'published',
          txId: receipt.txId,
          url: `${gateway}/${receipt.txId}`,
          feePaid: receipt.feePaid.toString(),
        };
      } catch (err) {
        // The PUSH succeeded — a pointer failure must not turn it into a
        // failed command. The record was not updated, so the next push
        // retries the upload.
        rigPage = {
          status: 'skipped',
          detail: `pointer upload failed (push itself succeeded; the next push retries): ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    // ── Receipts ────────────────────────────────────────────────────────────
    if (flags.json) {
      io.emitJson({
        command: 'push',
        repoId,
        path,
        identity,
        executed: true,
        upToDate: false,
        plan,
        result,
        rigPage,
      } satisfies PushJsonOutput);
    } else {
      for (const line of renderResult(result)) io.out(line);
      if (rigPage.url) {
        io.out(
          `Rig page: ${rigPage.url}` +
            (rigPage.status === 'published' ? `  paid ${rigPage.feePaid}` : '') +
            '  (opens this repo in the Rig)'
        );
      } else if (rigPage.detail) {
        io.err(`rig page: ${rigPage.detail}`);
      }
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'push', err);
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
