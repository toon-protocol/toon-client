/**
 * `rig site publish [ref]` + `rig site url [ref]` — a pushed repo as a
 * permaweb site (#368).
 *
 * Every `rig push` already stores a repo's raw blob bytes on Arweave and, with
 * #368's per-file Content-Type, a gateway serves each blob as its real media
 * type. `rig site publish` adds the last piece: it walks a ref's root tree,
 * joins each file path to the Arweave txId the cumulative kind:30618 `arweave`
 * map already records for that blob (no GraphQL, no re-upload), builds the
 * ar.io path manifest, and uploads THAT as one paid store write. The manifest
 * txId is the site's canonical URL: `https://<gateway>/<txid>/`. Point an ArNS
 * name at it (#367, `rig name set`) for a stable, human name.
 *
 * PAID DISCIPLINE (mirrors `rig push`): estimate → confirm → execute, strict
 * `--json` (one document on stdout), `--yes` required to spend in a non-TTY.
 * Without `--yes`, `--json` is a pure estimate (nothing uploaded, exit 0).
 *
 * `--force-reupload` re-pays to upload the ref's blobs THROUGH the #368
 * mime-typed path before building the manifest, for repos pushed before
 * per-file Content-Type existed (whose blobs would otherwise serve as
 * `application/octet-stream`). Content-addressed dedupe means a plain re-push
 * would skip them, so this is the explicit escape hatch.
 *
 * `rig site url [ref]` is FREE: it reads the manifest txId the last publish
 * recorded locally (../cli/site-record.ts) and prints the URL — no client
 * start, no relay query, no payment.
 */

import { parseArgs } from 'node:util';
import { buildArweaveManifest, type ManifestEntry } from '../arweave-manifest.js';
import { resolveConflictingPath } from '../mime.js';
import { flooredUploadFee } from '../publisher.js';
import { GitRepoReader } from '../repo-reader.js';
import type { RemoteState } from '../remote-state.js';
import {
  defaultLoadStandalone,
  identityReport,
  selectRefspecs,
  type IdentityReport,
  type PushDeps,
} from './push.js';
import { emitCliError, UnconfiguredRepoAddressError } from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import { renderIdentityLine } from './render.js';
import { resolveRelays, singleRelayRefusal } from './remote.js';
import { readSiteRecord, writeSiteRecord } from './site-record.js';
import type { StandaloneContext } from './standalone-context.js';

/** The ar.io path-manifest media type (spec-mandated `output` tag value). */
export const MANIFEST_CONTENT_TYPE = 'application/x.arweave-manifest+json';

/**
 * Default Arweave/ar.io gateway the printed site URL uses. `ar-io.dev`
 * because it serves the store's fresh uploads (currently ar.io testnet,
 * which mainnet `arweave.net` never indexes).
 */
export const DEFAULT_GATEWAY = 'https://ar-io.dev';

export const SITE_USAGE = `Usage: rig site <publish|url> [ref] [options]

Serve a pushed repo as a permanent, path-routed website. \`rig push\` already
stored the file bytes on Arweave; \`rig site publish\` builds the ar.io path
manifest (paths → Arweave txids, index → index.html) and uploads it as ONE
paid store write, printing the site URL. \`rig site url\` re-prints the URL of
the last publish for free.

The repo must be set up with \`rig init\`; the relay is the "origin" remote
(\`rig push\` reads the same). \`ref\` defaults to the current branch.

Commands:
  publish [ref]   build + upload the path manifest (paid); prints the URL and
                  a \`rig name set\` suggestion (#367)
  url [ref]       print the last-published site URL for a ref (free)

Options (publish):
  --index <path>       path served at / (default: index.html)
  --spa                single-page app: serve index for any unknown path
                       (sets the manifest \`fallback\` to the index txid)
  --fallback <path>    explicit fallback path for unknown routes (overrides
                       --spa); must be one of the site's files
  --force-reupload     re-pay to re-upload the ref's blobs with #368 per-file
                       Content-Type before building the manifest — for repos
                       pushed before mime-typing existed (else they serve as
                       application/octet-stream)
  --gateway <url>      gateway base for the printed URL (default: ${DEFAULT_GATEWAY};
                       env RIG_ARWEAVE_GATEWAY also sets it)
  --relay <url>        ad-hoc relay override (bypasses configured remotes)
  --repo-id <id>       repository id (default: git config toon.repoid)
  --yes                skip the fee confirmation (required when not a TTY)
  --json               machine-readable envelope; without --yes it is a pure
                       estimate (nothing uploaded)
  -h, --help           show this help`;

/** Deps for `rig site` — the same seam `rig push` uses (tests inject fakes). */
export type SiteDeps = PushDeps;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface SiteFlags {
  index: string;
  spa: boolean;
  fallback?: string;
  forceReupload: boolean;
  gateway?: string;
  relay: string[];
  repoId?: string;
  yes: boolean;
  json: boolean;
  help: boolean;
  positionals: string[];
}

function parseSiteArgs(args: string[]): SiteFlags {
  const { values, positionals } = parseArgs({
    args,
    options: {
      index: { type: 'string' },
      spa: { type: 'boolean', default: false },
      fallback: { type: 'string' },
      'force-reupload': { type: 'boolean', default: false },
      gateway: { type: 'string' },
      relay: { type: 'string', multiple: true },
      'repo-id': { type: 'string' },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  const flags: SiteFlags = {
    index: values.index ?? 'index.html',
    spa: values.spa ?? false,
    forceReupload: values['force-reupload'] ?? false,
    relay: values.relay ?? [],
    yes: values.yes ?? false,
    json: values.json ?? false,
    help: values.help ?? false,
    positionals,
  };
  if (values.fallback !== undefined) flags.fallback = values.fallback;
  if (values.gateway !== undefined) flags.gateway = values.gateway;
  if (values['repo-id'] !== undefined) flags.repoId = values['repo-id'];
  return flags;
}

// ---------------------------------------------------------------------------
// JSON envelopes
// ---------------------------------------------------------------------------

interface SitePublishJson {
  command: 'site publish';
  repoId: string;
  ref: string;
  identity: IdentityReport;
  executed: boolean;
  forceReupload: boolean;
  /** Number of files the manifest routes. */
  fileCount: number;
  index: string;
  fallback?: string;
  estimate: {
    manifestBytes: number;
    reuploadBytes: number;
    /** Total fee to spend, base units (string — bigint is not JSON-safe). */
    totalFee: string;
  };
  manifest?: { txId: string; url: string };
  nameHint?: string;
  hint?: string;
}

interface SiteUrlJson {
  command: 'site url';
  repoId: string;
  ref: string;
  found: boolean;
  manifestTxId?: string;
  url?: string;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeGateway(gateway: string): string {
  return gateway.replace(/\/+$/, '');
}

function siteUrl(gateway: string, manifestTxId: string): string {
  return `${normalizeGateway(gateway)}/${manifestTxId}/`;
}

/** A 43-char placeholder txId for accurate manifest-size estimation. */
const PLACEHOLDER_TX = 'A'.repeat(43);

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Route `rig site <sub>`; returns the process exit code. */
export async function runSite(args: string[], deps: SiteDeps): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;

  if (sub === 'publish') return runSitePublish(rest, deps);
  if (sub === 'url') return runSiteUrl(rest, deps);
  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    io.out(SITE_USAGE);
    return sub === undefined ? 2 : 0;
  }
  io.err(`unknown site subcommand ${JSON.stringify(sub)}`);
  io.err(SITE_USAGE);
  return 2;
}

// ---------------------------------------------------------------------------
// site publish
// ---------------------------------------------------------------------------

async function runSitePublish(
  args: string[],
  deps: SiteDeps
): Promise<number> {
  const { io } = deps;

  let flags: SiteFlags;
  try {
    flags = parseSiteArgs(args);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(SITE_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(SITE_USAGE);
    return 0;
  }

  let ctx: StandaloneContext | undefined;
  try {
    // ── Repo + config ──────────────────────────────────────────────────────
    const repoRoot = await resolveRepoRoot(deps.cwd);
    const toonConfig = await readToonConfig(repoRoot);
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const reader = new GitRepoReader(repoRoot);

    // ── Ref selection (single ref; default current branch) ─────────────────
    const selected = await selectRefspecs(reader, flags.positionals, false, false);
    if (selected.length !== 1) {
      throw new Error(
        `rig site publish builds ONE ref into a site — got ${selected.length} ` +
          `(${selected.join(', ')}); pass a single branch or tag`
      );
    }
    const ref = selected[0] as string;

    // ── Relay resolution (origin default; same path as push) ───────────────
    const resolved = await resolveRelays({
      relayFlags: flags.relay,
      remoteName: undefined,
      repoRoot,
      toonRelays: toonConfig.relays,
    });
    if (resolved.nudge !== undefined) io.err(resolved.nudge);
    const relaysUsed = resolved.relays;
    if (relaysUsed.length > 1) {
      io.err(singleRelayRefusal(resolved, 'Nothing was uploaded or paid.'));
      return 1;
    }

    // ── Standalone session (identity + publisher) ──────────────────────────
    ctx = await (deps.loadStandalone ?? defaultLoadStandalone)({
      env: deps.env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
      ...(relaysUsed[0] !== undefined ? { relayUrl: relaysUsed[0] } : {}),
    });
    const identity = identityReport(ctx);
    if (!ctx.publisher.uploadBlob) {
      throw new Error(
        'the active publisher cannot upload a raw manifest blob ' +
          '(uploadBlob unavailable) — `rig site` requires the standalone publisher'
      );
    }

    // ── Files + the known sha→txId map from the cumulative refs event ──────
    const blobs = await reader.listBlobs(ref);
    if (blobs.length === 0) {
      throw new Error(`ref ${JSON.stringify(ref)} has no files to serve`);
    }
    const shaToPaths = new Map<string, string[]>();
    for (const { path, sha } of blobs) {
      const paths = shaToPaths.get(sha) ?? [];
      paths.push(path);
      shaToPaths.set(sha, paths);
    }
    const uniqueShas = [...shaToPaths.keys()];

    const remoteState: RemoteState = await ctx.fetchRemote({
      ownerPubkey: ctx.ownerPubkey,
      repoId,
      relayUrls: relaysUsed,
    });
    const known = new Map(remoteState.shaToTxId);
    // Resolve any sha the refs event didn't carry (GraphQL fallback) — free.
    const gaps = uniqueShas.filter((sha) => !known.has(sha));
    if (gaps.length > 0) {
      const found = await remoteState.resolveMissing(gaps);
      for (const [sha, txId] of found) known.set(sha, txId);
    }

    // ── Fallback (SPA) path resolution ─────────────────────────────────────
    const fallbackPath = flags.fallback ?? (flags.spa ? flags.index : undefined);
    const pathSet = new Set(blobs.map((b) => b.path));
    if (fallbackPath !== undefined && !pathSet.has(fallbackPath)) {
      throw new Error(
        `fallback path ${JSON.stringify(fallbackPath)} is not one of the ` +
          "site's files — pick an existing path (or the --index file for --spa)"
      );
    }
    if (!pathSet.has(flags.index)) {
      io.err(
        `warning: no ${JSON.stringify(flags.index)} in this ref — the site ` +
          'will 404 at / until you add one (or pass --index <path>)'
      );
    }

    // ── Without --force-reupload every file must already be on Arweave ──────
    if (!flags.forceReupload) {
      const unpublished = uniqueShas.filter((sha) => !known.has(sha));
      if (unpublished.length > 0) {
        const paths = unpublished
          .flatMap((sha) => shaToPaths.get(sha) ?? [])
          .slice(0, 10);
        throw new Error(
          `${unpublished.length} file(s) in ${ref} are not on Arweave yet ` +
            `(e.g. ${paths.join(', ')}) — run \`rig push\` first, or ` +
            '`rig site publish --force-reupload` to upload them now (paid).'
        );
      }
    }

    // ── Fee estimate ───────────────────────────────────────────────────────
    // Per-upload fees are floored at the store route's announced price
    // (minUploadFee) — the same math the publisher claims per packet.
    const feeRates = await ctx.publisher.getFeeRates();
    const { uploadFeePerByte, minUploadFee } = feeRates;
    // Preview manifest with known/placeholder 43-char txids: byte-accurate for
    // the fee (every txid is 43 chars, so the real manifest is the same size).
    const previewEntries: ManifestEntry[] = blobs.map((b) => ({
      path: b.path,
      txId: known.get(b.sha) ?? PLACEHOLDER_TX,
    }));
    const previewManifest = buildArweaveManifest(
      previewEntries,
      flags.index,
      fallbackPath ? PLACEHOLDER_TX : undefined
    );
    const manifestBytes = Buffer.byteLength(JSON.stringify(previewManifest));

    let reuploadBytes = 0;
    let reuploadFee = 0n;
    if (flags.forceReupload) {
      const { objects } = await reader.statObjects(uniqueShas);
      reuploadBytes = objects.reduce((sum, o) => sum + o.size, 0);
      reuploadFee = objects.reduce(
        (sum, o) => sum + flooredUploadFee(o.size, uploadFeePerByte, minUploadFee),
        0n
      );
    }
    const manifestFee = flooredUploadFee(
      manifestBytes,
      uploadFeePerByte,
      minUploadFee
    );
    const totalFee = manifestFee + reuploadFee;

    const gateway = flags.gateway ?? deps.env['RIG_ARWEAVE_GATEWAY'] ?? DEFAULT_GATEWAY;

    const baseJson = (): Omit<SitePublishJson, 'executed'> => ({
      command: 'site publish',
      repoId,
      ref,
      identity,
      forceReupload: flags.forceReupload,
      fileCount: blobs.length,
      index: flags.index,
      ...(fallbackPath ? { fallback: fallbackPath } : {}),
      estimate: {
        manifestBytes,
        reuploadBytes,
        totalFee: totalFee.toString(),
      },
    });

    // ── Confirm gate ───────────────────────────────────────────────────────
    if (!flags.json) {
      io.out(`Site publish plan for ${ref} (repo ${repoId}):`);
      io.out(`  files:    ${blobs.length}`);
      io.out(`  index:    ${flags.index}${pathSet.has(flags.index) ? '' : ' (missing!)'}`);
      if (fallbackPath) io.out(`  fallback: ${fallbackPath}`);
      if (flags.forceReupload) {
        io.out(`  re-upload ${uniqueShas.length} blob(s), ${reuploadBytes} bytes (paid)`);
      }
      io.out(`  manifest: ${manifestBytes} bytes`);
      io.out(`  total fee: ${totalFee} base units`);
      io.out(renderIdentityLine(identity));
    }
    if (!flags.yes) {
      if (flags.json) {
        io.emitJson({
          ...baseJson(),
          executed: false,
          hint: 'estimate only — re-run with --yes to upload the manifest (permanent, non-refundable)',
        } satisfies SitePublishJson);
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
        `Proceed with paid site publish (total ${totalFee} base units)? [y/N] `
      );
      if (!proceed) {
        io.err('aborted — nothing was uploaded.');
        return 1;
      }
    }

    // ── Execute ────────────────────────────────────────────────────────────
    // #368 force-reupload: re-pay to upload each blob THROUGH the mime-typed
    // git-object path so the store tags it with the right Content-Type; the
    // returned (fresh) txids feed the manifest.
    if (flags.forceReupload) {
      const { objects, missing } = await reader.readObjects(uniqueShas);
      if (missing.length > 0) {
        throw new Error(
          `objects vanished from the local repository: ${missing.join(', ')}`
        );
      }
      const bodyBySha = new Map(objects.map((o) => [o.sha, o.body]));
      for (const sha of uniqueShas) {
        const body = bodyBySha.get(sha);
        if (!body) throw new Error(`internal: no body for ${sha}`);
        // A blob reached by conflicting-extension paths uploads as
        // octet-stream (deterministic, no arbitrary favoring); otherwise its
        // single content type.
        const uploadPath = resolveConflictingPath(shaToPaths.get(sha) ?? []);
        const receipt = await ctx.publisher.uploadGitObject({
          sha,
          type: 'blob',
          body,
          repoId,
          ...(uploadPath ? { path: uploadPath } : {}),
        });
        known.set(sha, receipt.txId);
      }
    }

    const entries: ManifestEntry[] = blobs.map((b) => {
      const txId = known.get(b.sha);
      if (!txId) {
        throw new Error(`internal: no Arweave txid for ${b.path} (${b.sha})`);
      }
      return { path: b.path, txId };
    });
    const fallbackTxId =
      fallbackPath !== undefined
        ? entries.find((e) => e.path === fallbackPath)?.txId
        : undefined;
    const manifest = buildArweaveManifest(entries, flags.index, fallbackTxId);
    const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8');

    const receipt = await ctx.publisher.uploadBlob({
      body: manifestBody,
      contentType: MANIFEST_CONTENT_TYPE,
      repoId,
    });
    const url = siteUrl(gateway, receipt.txId);
    writeSiteRecord(deps.env, {
      repoId,
      ref,
      owner: ctx.ownerPubkey,
      manifestTxId: receipt.txId,
      gateway: normalizeGateway(gateway),
      updatedAt: Date.now(),
    });

    const nameHint = `Point a name at it (see #367): rig name set <name> ${receipt.txId}`;
    if (flags.json) {
      io.emitJson({
        ...baseJson(),
        executed: true,
        manifest: { txId: receipt.txId, url },
        nameHint,
      } satisfies SitePublishJson);
    } else {
      io.out(`Site published: ${url}`);
      io.out(nameHint);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'site publish', err);
  } finally {
    if (ctx) {
      try {
        await ctx.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}

// ---------------------------------------------------------------------------
// site url (free)
// ---------------------------------------------------------------------------

async function runSiteUrl(args: string[], deps: SiteDeps): Promise<number> {
  const { io } = deps;

  let flags: SiteFlags;
  try {
    flags = parseSiteArgs(args);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(SITE_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(SITE_USAGE);
    return 0;
  }

  try {
    const repoRoot = await resolveRepoRoot(deps.cwd);
    const toonConfig = await readToonConfig(repoRoot);
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const reader = new GitRepoReader(repoRoot);

    const selected = await selectRefspecs(reader, flags.positionals, false, false);
    if (selected.length !== 1) {
      throw new Error(
        `rig site url takes ONE ref — got ${selected.length} (${selected.join(', ')})`
      );
    }
    const ref = selected[0] as string;

    const record = readSiteRecord(deps.env, repoId, ref);
    if (!record) {
      const detail =
        `no site published for ${ref} (repo ${repoId}) yet — run ` +
        '`rig site publish` first (the manifest txid is only known after a paid publish)';
      if (flags.json) {
        io.emitJson({
          command: 'site url',
          repoId,
          ref,
          found: false,
        } satisfies SiteUrlJson);
      }
      io.err(detail);
      return 1;
    }

    const url = siteUrl(record.gateway, record.manifestTxId);
    if (flags.json) {
      io.emitJson({
        command: 'site url',
        repoId,
        ref,
        found: true,
        manifestTxId: record.manifestTxId,
        url,
        updatedAt: record.updatedAt,
      } satisfies SiteUrlJson);
    } else {
      io.out(url);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, 'site url', err);
  }
}
