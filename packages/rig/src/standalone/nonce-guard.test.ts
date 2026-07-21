/**
 * Nonce-guard tests (#228): daemon-identity detection and the per-identity
 * advisory lockfile. No real network — every probe injects a fetch mock, and
 * locks live in a per-test temp dir.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonIdentityConflictError,
  NonceLock,
  StandaloneLockError,
  checkDaemonIdentity,
  standaloneForced,
} from './nonce-guard.js';

const PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);

/** fetch mock returning a daemon /status body with the given pubkey. */
function statusFetch(nostrPubkey: string, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ uptimeMs: 1, identity: { nostrPubkey } }),
      { status }
    )
  ) as unknown as typeof fetch;
}

/** A pid that is guaranteed dead: spawn a short-lived process and reap it. */
function deadPid(): number {
  const child = spawnSync('true');
  if (typeof child.pid !== 'number') throw new Error('spawnSync gave no pid');
  return child.pid;
}

describe('standaloneForced', () => {
  it('is true for the accepted truthy spellings (case/space-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' on ', 'On']) {
      expect(standaloneForced({ RIG_STANDALONE: v })).toBe(true);
    }
  });

  it('is false when unset or set to a non-truthy value', () => {
    expect(standaloneForced({})).toBe(false);
    for (const v of ['0', 'false', 'no', 'off', '']) {
      expect(standaloneForced({ RIG_STANDALONE: v })).toBe(false);
    }
  });
});

describe('checkDaemonIdentity', () => {
  it('refuses when a daemon responds with the SAME pubkey', async () => {
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: statusFetch(PUBKEY) })
    ).rejects.toThrow(DaemonIdentityConflictError);
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: statusFetch(PUBKEY) })
    ).rejects.toThrow(/toon-clientd is running with this identity/);
  });

  it('proceeds when the daemon holds a DIFFERENT identity', async () => {
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: statusFetch(OTHER_PUBKEY) })
    ).resolves.toBeUndefined();
  });

  it('proceeds when no daemon is listening (fetch rejects)', async () => {
    const refused = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
    }) as unknown as typeof fetch;
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: refused })
    ).resolves.toBeUndefined();
  });

  it('proceeds on a non-2xx response (listener that is not a healthy daemon)', async () => {
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: statusFetch(PUBKEY, 500) })
    ).resolves.toBeUndefined();
  });

  it('proceeds when the listener returns non-daemon JSON or non-JSON', async () => {
    const nonDaemon = vi.fn(
      async () => new Response('{"hello":"world"}', { status: 200 })
    ) as unknown as typeof fetch;
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: nonDaemon })
    ).resolves.toBeUndefined();

    const notJson = vi.fn(
      async () => new Response('<html></html>', { status: 200 })
    ) as unknown as typeof fetch;
    await expect(
      checkDaemonIdentity(PUBKEY, { fetchImpl: notJson })
    ).resolves.toBeUndefined();
  });

  it('probes the configured port', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    await checkDaemonIdentity(PUBKEY, { fetchImpl, port: 9999 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/status',
      expect.anything()
    );
  });
});

describe('NonceLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nonce-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a pid-stamped lockfile keyed by pubkey and removes it on release', async () => {
    const lock = await NonceLock.acquire(PUBKEY, { dir });
    const path = join(dir, `standalone-${PUBKEY}.lock`);
    expect(lock.lockPath).toBe(path);
    const contents = JSON.parse(readFileSync(path, 'utf8')) as {
      pid: number;
      pubkey: string;
    };
    expect(contents.pid).toBe(process.pid);
    expect(contents.pubkey).toBe(PUBKEY);

    lock.release();
    expect(existsSync(path)).toBe(false);
    // Idempotent.
    lock.release();
  });

  it('refuses while another LIVE process holds the lock', async () => {
    // process.ppid (the test runner's parent) is alive and is not us.
    writeFileSync(
      join(dir, `standalone-${PUBKEY}.lock`),
      JSON.stringify({ pid: process.ppid, pubkey: PUBKEY, createdAt: 'x' })
    );
    await expect(NonceLock.acquire(PUBKEY, { dir })).rejects.toThrow(
      StandaloneLockError
    );
    await expect(NonceLock.acquire(PUBKEY, { dir })).rejects.toThrow(
      /already holds the payment-channel lock/
    );
  });

  it('reclaims a STALE lock whose pid is dead', async () => {
    writeFileSync(
      join(dir, `standalone-${PUBKEY}.lock`),
      JSON.stringify({ pid: deadPid(), pubkey: PUBKEY, createdAt: 'x' })
    );
    const lock = await NonceLock.acquire(PUBKEY, { dir });
    const contents = JSON.parse(readFileSync(lock.lockPath, 'utf8')) as {
      pid: number;
    };
    expect(contents.pid).toBe(process.pid);
    lock.release();
  });

  it('reclaims a corrupt lockfile', async () => {
    writeFileSync(join(dir, `standalone-${PUBKEY}.lock`), 'not json at all');
    const lock = await NonceLock.acquire(PUBKEY, { dir });
    lock.release();
  });

  it('re-acquire by the SAME pid succeeds (in-process retry, shared watermark)', async () => {
    const first = await NonceLock.acquire(PUBKEY, { dir });
    const second = await NonceLock.acquire(PUBKEY, { dir });
    expect(second.lockPath).toBe(first.lockPath);
    second.release();
    first.release();
  });

  it('locks are per-identity — different pubkeys coexist', async () => {
    const a = await NonceLock.acquire(PUBKEY, { dir });
    const b = await NonceLock.acquire(OTHER_PUBKEY, { dir });
    expect(a.lockPath).not.toBe(b.lockPath);
    a.release();
    b.release();
  });

  it('a second instance with a distinct (live) pid refuses', async () => {
    const lock = await NonceLock.acquire(PUBKEY, { dir });
    await expect(
      NonceLock.acquire(PUBKEY, { dir, pid: process.ppid })
    ).rejects.toThrow(StandaloneLockError);
    lock.release();
  });
});
