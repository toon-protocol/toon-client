/**
 * Nonce-ownership guard for the STANDALONE embedded Publisher (#228).
 *
 * Why this exists: a payment channel's balance proof is a CUMULATIVE
 * watermark — the ChannelManager auto-increments the nonce and cumulative
 * amount on every `signBalanceProof`. Two writers signing claims on the same
 * channel from separate processes (a running `toon-clientd` daemon plus a
 * standalone embedded client, or two standalone processes) each keep their
 * own cumulative counter, so their claims race: the connector sees
 * non-monotonic watermarks and a re-signed claim can double-charge (the
 * hazard documented in packages/rig-web/tests/e2e/seed/lib/publish.ts).
 *
 * Two independent defenses, both keyed by the Nostr pubkey (one identity =
 * one channel set):
 *
 *  1. Daemon detection — probe the toon-clientd loopback control API
 *     (`GET /status`) and REFUSE when it reports the SAME identity. A daemon
 *     on a different identity holds different channels and is harmless.
 *     Since #279 the CLI's paid WRITE commands never get here with a
 *     same-identity daemon up — they delegate to its `/git/*` routes first
 *     (`cli/daemon-session.ts`), which achieves the same one-writer goal by
 *     handing the watermark to the daemon. This guard remains the backstop
 *     for the probe→publish race window and for operations with no daemon
 *     route (channel close/settle, explicit open).
 *  2. Advisory lockfile — an exclusive per-pubkey lockfile under the shared
 *     `~/.toon-client` state dir so two STANDALONE processes can't race each
 *     other (the daemon check only covers the daemon). Stale locks (dead pid)
 *     are reclaimed.
 *
 * The daemon port and state-dir conventions are DUPLICATED from
 * `packages/client-mcp/src/daemon/config.ts` (default port 8787 /
 * `TOON_CLIENT_HTTP_PORT`; `~/.toon-client` / `TOON_CLIENT_HOME`).
 * `@toon-protocol/rig` must not depend on `@toon-protocol/client-mcp`
 * (the daemon package depends on this one for the #227 Publisher — the
 * import would be circular), so the constants live here with this note.
 * Keep them in sync.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared conventions (duplicated from client-mcp — see module doc)
// ---------------------------------------------------------------------------

/** Default toon-clientd loopback control API port (client-mcp `httpPort`). */
export const DEFAULT_DAEMON_PORT = 8787;

/** Daemon control API port: `TOON_CLIENT_HTTP_PORT` env, else 8787. */
export function defaultDaemonPort(): number {
  const env = process.env['TOON_CLIENT_HTTP_PORT'];
  const parsed = env ? Number(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_PORT;
}

/**
 * Shared client state dir: `TOON_CLIENT_HOME` env, else `~/.toon-client` —
 * the same dir the daemon keeps its config/channel stores in, so daemon and
 * standalone processes agree on where the advisory locks live.
 */
export function defaultLockDir(): string {
  return process.env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A running toon-clientd holds the same identity (channel watermark owner). */
export class DaemonIdentityConflictError extends Error {
  constructor(
    /** The shared Nostr pubkey (hex). */
    public readonly pubkey: string,
    /** The daemon control API URL that answered. */
    public readonly daemonUrl: string
  ) {
    super(
      `toon-clientd is running with this identity (${pubkey.slice(0, 8)}…) at ` +
        `${daemonUrl} — paid rig writes delegate to it automatically (#279), ` +
        `but this operation has no daemon route (or the daemon appeared ` +
        `mid-run): stop the daemon and re-run. Two writers on one identity ` +
        `would race the payment channel's cumulative-claim watermark ` +
        `(double-charge hazard).`
    );
    this.name = 'DaemonIdentityConflictError';
  }
}

/** Another standalone process already holds the per-identity lock. */
export class StandaloneLockError extends Error {
  constructor(
    public readonly pubkey: string,
    public readonly lockPath: string,
    public readonly holderPid: number
  ) {
    super(
      `another standalone process (pid ${holderPid}) already holds the ` +
        `payment-channel lock for identity ${pubkey.slice(0, 8)}… ` +
        `(${lockPath}) — wait for it to finish or stop it. Two writers on one ` +
        `identity would race the cumulative-claim watermark.`
    );
    this.name = 'StandaloneLockError';
  }
}

// ---------------------------------------------------------------------------
// Daemon detection
// ---------------------------------------------------------------------------

export interface CheckDaemonOptions {
  /** Control API port (default: `TOON_CLIENT_HTTP_PORT` env, else 8787). */
  port?: number;
  /** Probe timeout, ms (default 1500 — loopback, so fast). */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Probe the toon-clientd loopback control API and throw
 * {@link DaemonIdentityConflictError} when a daemon responds on `/status`
 * with `identity.nostrPubkey === pubkey`.
 *
 * Anything short of a positive identity match lets the caller proceed: no
 * listener, a timeout, a non-JSON response (some other local service on the
 * port), or a daemon on a DIFFERENT identity (its channels are keyed to its
 * own pubkey — no shared watermark).
 */
export async function checkDaemonIdentity(
  pubkey: string,
  options: CheckDaemonOptions = {}
): Promise<void> {
  const port = options.port ?? defaultDaemonPort();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `http://127.0.0.1:${port}/status`;

  let daemonPubkey: string | undefined;
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
    });
    if (!res.ok) return; // listening, but not a healthy daemon status
    const body = (await res.json()) as {
      identity?: { nostrPubkey?: unknown };
    };
    const candidate = body?.identity?.nostrPubkey;
    if (typeof candidate === 'string') daemonPubkey = candidate;
  } catch {
    // Unreachable / timed out / not JSON → no same-identity daemon detected.
    return;
  }

  if (daemonPubkey !== undefined && daemonPubkey === pubkey) {
    throw new DaemonIdentityConflictError(pubkey, url);
  }
}

// ---------------------------------------------------------------------------
// Advisory per-identity lockfile
// ---------------------------------------------------------------------------

interface LockFileContents {
  pid: number;
  pubkey: string;
  createdAt: string;
}

export interface AcquireLockOptions {
  /** Directory the lockfile lives in (default: {@link defaultLockDir}). */
  dir?: string;
  /** Override the recorded pid (tests). Defaults to `process.pid`. */
  pid?: number;
}

/** True when `pid` refers to a live process we can see. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; ESRCH (and anything else) = not running.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Exclusive advisory lock for one identity's payment-channel watermark.
 *
 * Acquired with an atomic `wx` create of `standalone-<pubkey>.lock` (JSON:
 * pid + pubkey + timestamp) under the shared state dir. A pre-existing lock
 * whose pid is dead (or whose contents are unreadable) is STALE and gets
 * reclaimed; a live holder throws {@link StandaloneLockError}. Released
 * explicitly via {@link release} and best-effort on process exit.
 */
export class NonceLock {
  private released = false;
  private readonly exitHandler: () => void;

  private constructor(
    public readonly pubkey: string,
    public readonly lockPath: string
  ) {
    this.exitHandler = () => {
      try {
        unlinkSync(this.lockPath);
      } catch {
        // best-effort — the pid check makes a leftover lock reclaimable anyway
      }
    };
    process.once('exit', this.exitHandler);
  }

  static async acquire(
    pubkey: string,
    options: AcquireLockOptions = {}
  ): Promise<NonceLock> {
    const dir = options.dir ?? defaultLockDir();
    const pid = options.pid ?? process.pid;
    const lockPath = join(dir, `standalone-${pubkey}.lock`);
    mkdirSync(dir, { recursive: true });

    const payload = JSON.stringify(
      {
        pid,
        pubkey,
        createdAt: new Date().toISOString(),
      } satisfies LockFileContents,
      null,
      2
    );

    // Two attempts: initial exclusive create, then one retry after reclaiming
    // a stale lock. A live holder on either attempt is a hard refusal.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(lockPath, payload, { flag: 'wx' });
        return new NonceLock(pubkey, lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

        let holderPid: number | undefined;
        try {
          const parsed = JSON.parse(
            readFileSync(lockPath, 'utf8')
          ) as Partial<LockFileContents>;
          if (typeof parsed.pid === 'number') holderPid = parsed.pid;
        } catch {
          // Unreadable/corrupt lock → treat as stale.
        }

        // Same process re-acquiring (e.g. a retried push in one CLI run) is
        // not a race — the ChannelManager watermark is shared in-process.
        if (
          holderPid !== undefined &&
          holderPid !== pid &&
          pidAlive(holderPid)
        ) {
          throw new StandaloneLockError(pubkey, lockPath, holderPid);
        }

        // Stale (dead pid / corrupt / our own pid): reclaim and retry.
        try {
          unlinkSync(lockPath);
        } catch {
          // Lost a reclaim race with another process — the retry's exclusive
          // create settles the winner.
        }
      }
    }
    // Both attempts hit EEXIST → another process is actively (re)creating it.
    throw new StandaloneLockError(pubkey, lockPath, -1);
  }

  /** Remove the lockfile and detach the exit hook. Idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    process.removeListener('exit', this.exitHandler);
    try {
      unlinkSync(this.lockPath);
    } catch {
      // already gone — fine
    }
  }
}
