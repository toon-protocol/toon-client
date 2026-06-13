import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  isProcessAlive,
  readPid,
  releaseLock,
  isDaemonRunning,
} from './lifecycle.js';

describe('daemon lifecycle lock', () => {
  let dir: string;
  let pidPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-clientd-'));
    pidPath = join(dir, 'daemon.pid');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('isProcessAlive is true for the current process, false for a bogus pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_646)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('acquireLock writes the current pid and releaseLock removes it', () => {
    acquireLock(pidPath);
    expect(readPid(pidPath)).toBe(process.pid);
    expect(readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid));
    expect(isDaemonRunning(pidPath)).toBe(true);
    releaseLock(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('acquireLock reclaims a stale lock (dead pid)', () => {
    writeFileSync(pidPath, '2147483646'); // a pid that is not alive
    expect(() => acquireLock(pidPath)).not.toThrow();
    expect(readPid(pidPath)).toBe(process.pid);
  });

  it('acquireLock refuses when another live process holds the lock', () => {
    // Our own (alive) pid, but not equal to process.pid path — simulate via a
    // different live pid: use the parent process which is alive.
    const otherLivePid = process.ppid;
    if (
      otherLivePid &&
      otherLivePid !== process.pid &&
      isProcessAlive(otherLivePid)
    ) {
      writeFileSync(pidPath, String(otherLivePid));
      expect(() => acquireLock(pidPath)).toThrow(/already running/);
    }
  });

  it('readPid returns null for missing or garbage files', () => {
    expect(readPid(join(dir, 'nope.pid'))).toBeNull();
    writeFileSync(pidPath, 'not-a-number');
    expect(readPid(pidPath)).toBeNull();
  });

  it('releaseLock does not remove a lock owned by another pid', () => {
    writeFileSync(pidPath, '2147483646');
    releaseLock(pidPath);
    expect(existsSync(pidPath)).toBe(true);
  });
});
