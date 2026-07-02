/**
 * `rig fetch` (#278) — the clone pipeline against an EXISTING repository:
 * fetch the remote refs + sha→txId map from the relay, download only the
 * objects the local repository is missing (SHA-1 verified), and update the
 * remote-tracking refs (refs/remotes/<remote>/*; tags to refs/tags/*),
 * reporting what moved like `git fetch` does. FREE — no payments anywhere.
 *
 * No merge: integrating fetched refs is `rig merge origin/main` (the git
 * passthrough), exactly like plain git. `rig fetch` shadows `git fetch` the
 * same way `rig push` shadows `git push`; plain-git fetches stay available
 * by running `git fetch` directly.
 */

import { parseArgs } from 'node:util';
import {
  isSafeRefname,
  runGit,
  updateRef,
  writeGitObjects,
} from '../materialize.js';
import { ownerToHex } from '../npub.js';
import { collectRepoObjects } from '../read-pipeline.js';
import { fetchRemoteState } from '../remote-state.js';
import { GitRepoReader } from '../repo-reader.js';
import {
  emitCliError,
  InvalidRelayUrlError,
  MultiUrlRemoteError,
  UnconfiguredRepoAddressError,
  UnknownRemoteError,
} from './errors.js';
import {
  readToonConfig,
  getGitRemoteUrls,
  resolveRepoRoot,
} from './git-config.js';
import { MissingRemoteObjectsError } from './clone.js';
import type { ReadCommandDeps } from './read-seams.js';

export const FETCH_USAGE = `Usage: rig fetch [remote] [options]

Fetch from a TOON remote — FREE (relay reads + Arweave gateway downloads; no
payments, no identity needed). Reads the kind:30618 repository state from the
remote's relay, downloads only the git objects this repository is missing
(SHA-1 verified), and updates the remote-tracking refs
(refs/remotes/<remote>/*; tags land at refs/tags/*), reporting what moved.

No merge happens: integrate with the git passthrough, e.g.
\`rig merge origin/main\`. \`rig fetch\` is the TOON transport and shadows
\`git fetch\` — plain-git fetches remain available via \`git fetch\` directly.

The repo address (toon.repoid/toon.owner) comes from the config \`rig init\`
or \`rig clone\` writes; --repo-id/--owner override.

Options:
  --repo-id <id>       repository id / NIP-34 d-tag (default: git config)
  --owner <pubkey>     repository owner (npub or 64-char hex; default: git config)
  --relay <url>        ad-hoc relay override — bypasses the remote's URL
  --concurrency <n>    parallel gateway downloads (default 8)
  --json               machine-readable result envelope
  -h, --help           show this help`;

/** One remote-tracking ref movement, `git fetch`-style. */
export interface RefUpdate {
  /** Remote refname (as announced), e.g. `refs/heads/main`. */
  refname: string;
  /** Local ref that was updated, e.g. `refs/remotes/origin/main`. */
  localRef: string;
  oldSha: string | null;
  newSha: string;
  kind: 'new' | 'fast-forward' | 'forced' | 'up-to-date';
}

const WS_URL_RE = /^wss?:\/\//i;

/** Map an announced refname to its local destination for `remote`. */
function localRefFor(refname: string, remote: string): string | null {
  if (refname.startsWith('refs/heads/')) {
    return `refs/remotes/${remote}/${refname.slice('refs/heads/'.length)}`;
  }
  if (refname.startsWith('refs/tags/')) return refname;
  return null; // exotic namespaces are skipped
}

/** rev-parse a ref, null when it doesn't exist. */
async function resolveLocalRef(
  repoRoot: string,
  refname: string
): Promise<string | null> {
  try {
    const out = await runGit(repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      refname,
    ]);
    const sha = out.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Run `rig fetch …`; returns the process exit code. */
export async function runFetch(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  const { io } = deps;

  let json = false;
  let remote = 'origin';
  let relayFlag: string | undefined;
  let repoIdFlag: string | undefined;
  let ownerFlag: string | undefined;
  let concurrency: number | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        json: { type: 'boolean', default: false },
        relay: { type: 'string' },
        'repo-id': { type: 'string' },
        owner: { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      io.out(FETCH_USAGE);
      return 0;
    }
    json = values.json === true;
    if (positionals.length > 1) {
      throw new Error(
        `expected at most one [remote] argument, got ${positionals.length}`
      );
    }
    if (positionals[0] !== undefined) remote = positionals[0];
    relayFlag = values.relay;
    repoIdFlag = values['repo-id'];
    ownerFlag =
      values.owner !== undefined ? ownerToHex(values.owner) : undefined;
    if (values.concurrency !== undefined) {
      concurrency = Number.parseInt(values.concurrency, 10);
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new Error('--concurrency must be a positive integer');
      }
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(FETCH_USAGE);
    return 2;
  }

  try {
    // ── Repo addressing + relay resolution ─────────────────────────────────
    const repoRoot = await resolveRepoRoot(deps.cwd);
    const toonConfig = await readToonConfig(repoRoot);
    const repoId = repoIdFlag ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const owner = ownerFlag ?? toonConfig.owner;
    if (!owner) throw new UnconfiguredRepoAddressError('repository owner');

    let relayUrl: string;
    if (relayFlag !== undefined) {
      relayUrl = relayFlag;
    } else {
      const urls = await getGitRemoteUrls(repoRoot, remote);
      if (urls.length === 0) throw new UnknownRemoteError(remote);
      if (urls.length > 1) throw new MultiUrlRemoteError(remote, urls);
      relayUrl = urls[0] as string;
    }
    if (!WS_URL_RE.test(relayUrl)) {
      throw new InvalidRelayUrlError(
        relayUrl,
        `remote ${JSON.stringify(remote)}`
      );
    }

    // ── Remote state ────────────────────────────────────────────────────────
    const remoteState = await fetchRemoteState({
      relayUrls: [relayUrl],
      ownerPubkey: owner,
      repoId,
      ...(deps.webSocketFactory
        ? { webSocketFactory: deps.webSocketFactory }
        : {}),
      ...(deps.resolveSha ? { resolveSha: deps.resolveSha } : {}),
    });

    // Plan the tracking-ref updates (hostile-relay refname gate included).
    const planned: { refname: string; localRef: string; newSha: string }[] = [];
    for (const [refname, sha] of remoteState.refs) {
      if (!isSafeRefname(refname)) {
        io.err(
          `warning: skipping unsafe ref name from relay: ${JSON.stringify(refname)}`
        );
        continue;
      }
      const localRef = localRefFor(refname, remote);
      if (localRef === null) {
        io.err(
          `warning: skipping ref outside refs/heads and refs/tags: ${refname}`
        );
        continue;
      }
      planned.push({ refname, localRef, newSha: sha });
    }

    // ── Delta: download only what the local repository is missing ──────────
    const reader = new GitRepoReader(repoRoot);
    const tips = [...new Set(planned.map((p) => p.newSha))];
    const candidates = [...new Set([...remoteState.shaToTxId.keys(), ...tips])];
    const { missing: absent } = await reader.statObjects(candidates);
    const absentSet = new Set(absent);
    const presentLocally = new Set(
      candidates.filter((sha) => !absentSet.has(sha))
    );

    const collected = await collectRepoObjects({
      tips,
      shaToTxId: remoteState.shaToTxId,
      resolveMissing: (shas) => remoteState.resolveMissing(shas),
      presentLocally,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    });
    if (collected.missing.length > 0) {
      throw new MissingRemoteObjectsError(
        collected.missing,
        `cannot fetch from ${relayUrl}`
      );
    }
    const written = await writeGitObjects(repoRoot, collected.objects.values());

    // ── Update tracking refs + report movements ─────────────────────────────
    const updates: RefUpdate[] = [];
    for (const { refname, localRef, newSha } of planned) {
      const oldSha = await resolveLocalRef(repoRoot, localRef);
      if (oldSha === newSha) {
        updates.push({ refname, localRef, oldSha, newSha, kind: 'up-to-date' });
        continue;
      }
      let kind: RefUpdate['kind'];
      if (oldSha === null) {
        kind = 'new';
      } else {
        kind = (await reader.isAncestor(oldSha, newSha))
          ? 'fast-forward'
          : 'forced';
      }
      await updateRef(repoRoot, localRef, newSha);
      updates.push({ refname, localRef, oldSha, newSha, kind });
    }

    // ── Report ──────────────────────────────────────────────────────────────
    const moved = updates.filter((u) => u.kind !== 'up-to-date');
    if (json) {
      io.emitJson({
        command: 'fetch',
        repoAddr: { ownerPubkey: owner, repoId },
        remote,
        relay: relayUrl,
        objectsDownloaded: written,
        updates,
        executed: true,
      });
      return 0;
    }
    if (moved.length === 0) {
      io.out('Already up to date.');
      return 0;
    }
    io.out(`From ${relayUrl}`);
    for (const u of moved) {
      const short = (refname: string): string =>
        refname
          .replace(/^refs\/heads\//, '')
          .replace(/^refs\/tags\//, '')
          .replace(/^refs\/remotes\//, '');
      const src = short(u.refname);
      const dst = short(u.localRef);
      if (u.kind === 'new') {
        const label = u.refname.startsWith('refs/tags/')
          ? '[new tag]'
          : '[new branch]';
        io.out(` * ${label.padEnd(17)} ${src.padEnd(14)} -> ${dst}`);
      } else if (u.kind === 'forced') {
        io.out(
          ` + ${(u.oldSha as string).slice(0, 7)}...${u.newSha.slice(0, 7)} ${src.padEnd(14)} -> ${dst}  (forced update)`
        );
      } else {
        io.out(
          `   ${(u.oldSha as string).slice(0, 7)}..${u.newSha.slice(0, 7)}  ${src.padEnd(14)} -> ${dst}`
        );
      }
    }
    io.out(`Downloaded ${written} object(s) (SHA-1 verified).`);
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'fetch', err);
  }
}
