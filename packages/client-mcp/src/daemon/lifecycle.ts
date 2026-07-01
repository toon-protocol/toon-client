/**
 * Daemon process lifecycle: a single-instance PID lock, a detached spawn helper
 * (used by the MCP server to auto-start the daemon), and a readiness probe.
 *
 * Why single-instance matters: two daemons would open two BTP sessions against
 * the same channel and race the nonce watermark — corrupting the payment proof.
 * The lock is a PID file; a stale file (process gone) is reclaimed.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.js';
import { ControlClient } from '../control-client.js';

/** Default PID file path. */
export function pidFilePath(): string {
  return join(configDir(), 'daemon.pid');
}

/** Whether a process with `pid` is currently alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the recorded daemon PID, or null when absent/invalid. */
export function readPid(path = pidFilePath()): number | null {
  try {
    const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the single-instance lock for the current process. Throws if another
 * live daemon already holds it. Reclaims a stale lock (dead PID).
 */
export function acquireLock(path = pidFilePath()): void {
  const existing = readPid(path);
  if (
    existing !== null &&
    existing !== process.pid &&
    isProcessAlive(existing)
  ) {
    throw new Error(
      `Another toon-clientd is already running (pid ${existing}). ` +
        `Stop it first or remove ${path} if it is stale.`
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(process.pid), { mode: 0o600 });
}

/** Release the lock if it belongs to this process. */
export function releaseLock(path = pidFilePath()): void {
  const pid = readPid(path);
  if (pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

/** Whether a daemon is currently running per the PID lock. */
export function isDaemonRunning(path = pidFilePath()): boolean {
  const pid = readPid(path);
  return pid !== null && isProcessAlive(pid);
}

export interface SpawnDaemonOptions {
  /** Path to the `toon-clientd` bin (defaults to this package's daemon entry). */
  daemonEntry?: string;
  /** Extra env for the spawned process. */
  env?: NodeJS.ProcessEnv;
  /** Directory for the detached stdout/stderr log. */
  logDir?: string;
}

/**
 * Spawn the daemon as a detached, fully background process (survives the
 * parent — e.g. the ephemeral MCP/agent session — exiting). Returns the child
 * PID. The caller should poll {@link waitForReady} before issuing requests.
 */
export function spawnDaemonDetached(opts: SpawnDaemonOptions = {}): number {
  const entry = opts.daemonEntry ?? defaultDaemonEntry();
  const logDir = opts.logDir ?? configDir();
  mkdirSync(logDir, { recursive: true });
  // A single appended log file; the detached child writes here so the parent
  // can close its handles and exit.
  const logPath = join(logDir, 'daemon.log');
  // Use 'a' so restarts append rather than truncate the operator's log.
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [entry, 'run'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...opts.env },
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('Failed to spawn toon-clientd (no pid)');
  }
  return child.pid;
}

/** Resolve the path to this package's built daemon entry (`dist/daemon.js`). */
export function defaultDaemonEntry(): string {
  // When running from the built bin, the daemon entry sits next to this module.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'daemon.js');
}

/**
 * Poll the control API until the daemon answers `GET /status`, up to
 * `timeoutMs`. Resolves true once reachable (NOT necessarily done
 * bootstrapping — the BTP session can take a moment; callers surface
 * `bootstrapping`).
 */
export async function waitForReady(
  baseUrl: string,
  timeoutMs = 15_000,
  intervalMs = 300
): Promise<boolean> {
  const client = new ControlClient({ baseUrl, timeoutMs: intervalMs * 3 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.ping()) return true;
    await delay(intervalMs);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Whether the daemon entry file exists (used for friendlier error messages). */
export function daemonEntryExists(entry = defaultDaemonEntry()): boolean {
  return existsSync(entry);
}
