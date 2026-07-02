/**
 * `rig clone` (#278) — bootstrap a repository from TOON, no payments anywhere:
 *
 *   rig clone <relay-url> <owner-npub-or-hex>/<repo-id> [dir]
 *
 * Pipeline: fetch kind:30617/30618 from the relay (../remote-state.ts) →
 * download every object the refs need from Arweave gateways with SHA-1
 * verification (../read-pipeline.ts) → materialize a REAL git repository via
 * git plumbing (../materialize.ts): `git hash-object -w --stdin -t <type>`
 * per object (written SHA re-checked), `git update-ref` per ref, HEAD from
 * the 30618 symref, worktree checkout. The clone is immediately push/pull
 * capable: toon.repoid/toon.owner are configured and the relay is added as
 * the `origin` remote.
 *
 * ATOMICITY: everything lands in a temp dir next to the destination and is
 * renamed into place only on full success — a failed clone never leaves a
 * partial/corrupt repository. Missing objects (Arweave propagation lag) are
 * an honest error listing the SHAs; corrupt objects are an integrity error.
 */

import { mkdtemp, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  setHeadSymref,
  isSafeRefname,
  runGit,
  updateRef,
  writeGitObjects,
} from '../materialize.js';
import { npubToHex, ownerToHex } from '../npub.js';
import {
  collectRepoObjects,
  missingObjectsMessage,
  type MissingObject,
} from '../read-pipeline.js';
import { fetchRemoteState, type RemoteState } from '../remote-state.js';
import { emitCliError } from './errors.js';
import type { ReadCommandDeps } from './read-seams.js';

export const CLONE_USAGE = `Usage: rig clone <relay-url> <owner>/<repo-id> [dir] [options]

Clone a TOON repository — FREE (relay reads + Arweave gateway downloads; no
payments, no channel, no identity needed). <relay-url> is a ws:// or wss://
NIP-01 relay; <owner> is the repo owner's pubkey as npub1… or 64-char hex;
[dir] defaults to <repo-id>.

Fetches the kind:30617/30618 repository state, downloads every git object
the refs need from Arweave gateways (SHA-1 verified — corrupt content is
rejected), and materializes a real git repository: objects via git plumbing,
refs, HEAD, checked-out worktree, toon.* config, and the relay preconfigured
as the "origin" remote — so \`rig fetch\`, \`rig push\`, and the issue/pr
commands work immediately.

Note: recently pushed objects can take 10-20 minutes to become fetchable
from Arweave gateways. A clone right after a push may report missing
objects — retry after propagation.

Options:
  --concurrency <n>    parallel gateway downloads (default 8)
  --json               machine-readable result envelope
  -h, --help           show this help`;

/** Repo has no announcement AND no state on the relay. */
export class RepoNotFoundError extends Error {
  constructor(relay: string, owner: string, repoId: string) {
    super(
      `repository 30617:${owner}:${repoId} not found on ${relay} — ` +
        'no kind:30617 announcement or kind:30618 state event exists there. ' +
        'Check the relay URL, the owner pubkey (npub or hex), and the repo id.'
    );
    this.name = 'RepoNotFoundError';
  }
}

/** Reachable objects could not be downloaded (Arweave propagation lag). */
export class MissingRemoteObjectsError extends Error {
  constructor(
    public readonly missing: MissingObject[],
    context: string
  ) {
    super(missingObjectsMessage(missing, context));
    this.name = 'MissingRemoteObjectsError';
  }
}

const WS_URL_RE = /^wss?:\/\//i;

interface CloneArgs {
  relayUrl: string;
  owner: string;
  repoId: string;
  dir: string | undefined;
  concurrency: number | undefined;
  json: boolean;
}

function parseCloneArgs(args: string[]): CloneArgs | { help: true } {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });
  if (values.help) return { help: true };
  if (positionals.length < 2 || positionals.length > 3) {
    throw new Error('expected: rig clone <relay-url> <owner>/<repo-id> [dir]');
  }
  const [relayUrl, addr, dir] = positionals as [string, string, string?];
  if (!WS_URL_RE.test(relayUrl)) {
    throw new Error(
      `<relay-url> must be ws:// or wss:// (got ${JSON.stringify(relayUrl)})`
    );
  }
  const slash = addr.indexOf('/');
  if (slash <= 0 || slash === addr.length - 1) {
    throw new Error(
      `expected <owner>/<repo-id> (npub or 64-char hex owner), got ${JSON.stringify(addr)}`
    );
  }
  const owner = ownerToHex(addr.slice(0, slash));
  const repoId = addr.slice(slash + 1);
  let concurrency: number | undefined;
  if (values.concurrency !== undefined) {
    concurrency = Number.parseInt(values.concurrency, 10);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error(`--concurrency must be a positive integer`);
    }
  }
  return {
    relayUrl,
    owner,
    repoId,
    dir,
    concurrency,
    json: values.json === true,
  };
}

/** True when `dir` does not exist or is an empty directory. */
async function isUsableDestination(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Pick the branch `git init --initial-branch` should use. */
function initialBranch(headSymref: string | null): string {
  if (headSymref?.startsWith('refs/heads/')) {
    const name = headSymref.slice('refs/heads/'.length);
    if (name && isSafeRefname(headSymref)) return name;
  }
  return 'main';
}

/** Run `rig clone …`; returns the process exit code. */
export async function runClone(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  const { io } = deps;

  let parsed: CloneArgs;
  try {
    const result = parseCloneArgs(args);
    if ('help' in result) {
      io.out(CLONE_USAGE);
      return 0;
    }
    parsed = result;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CLONE_USAGE);
    return 2;
  }

  const { relayUrl, owner, repoId, json } = parsed;
  const dest = resolve(deps.cwd, parsed.dir ?? repoId);
  let tempDir: string | undefined;

  try {
    if (!(await isUsableDestination(dest))) {
      throw new Error(
        `destination path ${JSON.stringify(dest)} already exists and is not an empty directory`
      );
    }

    if (!json) io.out(`Cloning into '${basename(dest)}'...`);

    // ── Remote state (kind:30617 + 30618) ───────────────────────────────────
    const remoteState: RemoteState = await fetchRemoteState({
      relayUrls: [relayUrl],
      ownerPubkey: owner,
      repoId,
      ...(deps.webSocketFactory
        ? { webSocketFactory: deps.webSocketFactory }
        : {}),
      ...(deps.resolveSha ? { resolveSha: deps.resolveSha } : {}),
    });
    if (!remoteState.announced && remoteState.refsEvent === null) {
      throw new RepoNotFoundError(relayUrl, owner, repoId);
    }

    // Refs from the 30618, filtered through the hostile-relay refname gate.
    const refs = new Map<string, string>();
    for (const [refname, sha] of remoteState.refs) {
      if (!isSafeRefname(refname)) {
        io.err(
          `warning: skipping unsafe ref name from relay: ${JSON.stringify(refname)}`
        );
        continue;
      }
      refs.set(refname, sha);
    }
    if (refs.size === 0) {
      io.err(
        'warning: the repository has no refs yet (announced but never pushed) — ' +
          'cloning an empty repository'
      );
    }

    // ── Download + verify the object closure (FREE) ─────────────────────────
    const tips = [...new Set(refs.values())];
    const collected = await collectRepoObjects({
      tips,
      shaToTxId: remoteState.shaToTxId,
      resolveMissing: (shas) => remoteState.resolveMissing(shas),
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(parsed.concurrency !== undefined
        ? { concurrency: parsed.concurrency }
        : {}),
    });
    if (collected.missing.length > 0) {
      throw new MissingRemoteObjectsError(
        collected.missing,
        `cannot clone ${owner.slice(0, 8)}…/${repoId}`
      );
    }
    for (const { sha, txId } of collected.skippedUnavailable) {
      io.err(
        `warning: unreachable object ${sha} (tx ${txId}) could not be downloaded — ` +
          'not needed by any ref, continuing'
      );
    }

    // ── Materialize into a temp dir, move into place on success ────────────
    const parent = dirname(dest);
    await mkdir(parent, { recursive: true });
    tempDir = await mkdtemp(join(parent, `.${basename(dest)}.rig-clone-`));

    await runGit(tempDir, [
      'init',
      '--quiet',
      `--initial-branch=${initialBranch(remoteState.headSymref)}`,
    ]);
    const written = await writeGitObjects(tempDir, collected.objects.values());
    for (const [refname, sha] of refs) {
      await updateRef(tempDir, refname, sha);
      // Remote-tracking refs, exactly like `git clone` — so `rig fetch`
      // reports honest deltas and `rig merge origin/<branch>` works.
      if (refname.startsWith('refs/heads/')) {
        const branch = refname.slice('refs/heads/'.length);
        await updateRef(tempDir, `refs/remotes/origin/${branch}`, sha);
      }
    }
    const head =
      remoteState.headSymref !== null &&
      isSafeRefname(remoteState.headSymref) &&
      refs.has(remoteState.headSymref)
        ? remoteState.headSymref
        : ([...refs.keys()].find((r) => r.startsWith('refs/heads/')) ?? null);
    if (head !== null) {
      await setHeadSymref(tempDir, head);
      await runGit(tempDir, ['reset', '--hard', '--quiet']);
    }

    // toon.* config + origin remote: immediately push/pull-capable.
    await runGit(tempDir, ['config', 'toon.repoid', repoId]);
    await runGit(tempDir, ['config', 'toon.owner', owner]);
    await runGit(tempDir, ['remote', 'add', 'origin', relayUrl]);
    if (head !== null) {
      // Upstream config for the checked-out branch, like `git clone`.
      const branch = head.slice('refs/heads/'.length);
      await runGit(tempDir, ['config', `branch.${branch}.remote`, 'origin']);
      await runGit(tempDir, ['config', `branch.${branch}.merge`, head]);
    }

    // Atomic move into place (destination may exist as an empty directory).
    try {
      await rmdir(dest);
    } catch {
      // ENOENT — the destination does not exist yet; rename creates it.
    }
    await rename(tempDir, dest);
    tempDir = undefined;

    // ── Report ──────────────────────────────────────────────────────────────
    if (json) {
      io.emitJson({
        command: 'clone',
        repoAddr: { ownerPubkey: owner, repoId },
        relay: relayUrl,
        directory: dest,
        head,
        refs: Object.fromEntries(refs),
        name: remoteState.name,
        objectsDownloaded: written,
        executed: true,
      });
    } else {
      io.out(`Downloaded ${written} object(s) from Arweave (SHA-1 verified).`);
      for (const [refname, sha] of refs) {
        io.out(`  ${sha.slice(0, 7)}  ${refname}`);
      }
      if (head !== null) io.out(`HEAD is now at ${head}`);
      io.out(
        `Configured toon.repoid=${repoId}, toon.owner=${owner.slice(0, 8)}…, ` +
          `origin → ${relayUrl}`
      );
      io.out('Done.');
    }
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'clone', err);
  } finally {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

// Re-exported for the acceptance flow + tests (owner column rendering).
export { npubToHex };
