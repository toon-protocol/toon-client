import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectAnonAsset,
  renderTorrc,
  waitForAnonSocks,
  ensureAnonBinary,
  defaultCacheDir,
  ANON_ASSETS,
  ANON_VERSION,
} from './anon-proxy.js';

describe('selectAnonAsset (platform → asset-name mapping)', () => {
  it('maps darwin-arm64 to anon-beta-macos-arm64.zip with a pinned checksum', () => {
    const asset = selectAnonAsset('darwin', 'arm64');
    expect(asset.assetName).toBe('anon-beta-macos-arm64.zip');
    expect(asset.sha256).toBe(
      '3b8724afc56354aa93d2fe804d6b8a685d3bff65dac0ca3384cae1ef010977b2'
    );
  });

  it('maps darwin-x64 to anon-beta-macos-amd64.zip', () => {
    expect(selectAnonAsset('darwin', 'x64').assetName).toBe(
      'anon-beta-macos-amd64.zip'
    );
  });

  it('maps linux-x64 to anon-beta-linux-amd64.zip', () => {
    expect(selectAnonAsset('linux', 'x64').assetName).toBe(
      'anon-beta-linux-amd64.zip'
    );
  });

  it('maps linux-arm64 to anon-beta-linux-arm64.zip', () => {
    expect(selectAnonAsset('linux', 'arm64').assetName).toBe(
      'anon-beta-linux-arm64.zip'
    );
  });

  it('throws for an unsupported platform/arch combination', () => {
    expect(() => selectAnonAsset('win32', 'x64')).toThrow(
      /No managed anon binary available/
    );
  });

  it('uses the pinned beta version slug', () => {
    expect(ANON_VERSION).toBe('v0.4.10.0-beta');
    // Every asset name carries the "beta" channel slug.
    for (const key of Object.keys(ANON_ASSETS)) {
      expect(ANON_ASSETS[key].assetName).toContain('anon-beta-');
    }
  });
});

describe('renderTorrc', () => {
  const torrc = renderTorrc('/cache/anon', 9050);

  it('includes AgreeToTerms 1 (REQUIRED — anon exits without it)', () => {
    expect(torrc).toContain('AgreeToTerms 1');
  });

  it('binds SOCKS to loopback on the requested port', () => {
    expect(torrc).toContain('SOCKSPort 127.0.0.1:9050');
    expect(torrc).toContain('SOCKSPolicy accept *');
  });

  it('points DataDirectory + GeoIP files into the cache dir', () => {
    expect(torrc).toContain('DataDirectory /cache/anon/data');
    expect(torrc).toContain('GeoIPFile /cache/anon/geoip');
    expect(torrc).toContain('GeoIPv6File /cache/anon/geoip6');
  });

  it('runs in the foreground (RunAsDaemon 0) and logs to stdout', () => {
    expect(torrc).toContain('RunAsDaemon 0');
    expect(torrc).toContain('Log notice stdout');
  });

  it('honours a custom SOCKS port', () => {
    expect(renderTorrc('/c', 19050)).toContain('SOCKSPort 127.0.0.1:19050');
  });
});

describe('defaultCacheDir', () => {
  const prev = process.env['XDG_CACHE_HOME'];
  afterEach(() => {
    if (prev === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = prev;
  });

  it('honours XDG_CACHE_HOME and pins the version', () => {
    process.env['XDG_CACHE_HOME'] = '/xdg';
    const dir = defaultCacheDir();
    expect(dir).toBe(`/xdg/toon-client/anon/${ANON_VERSION}`);
  });

  it('falls back to ~/.toon-client/anon when XDG unset', () => {
    delete process.env['XDG_CACHE_HOME'];
    const dir = defaultCacheDir();
    expect(dir).toContain(`/.toon-client/anon/${ANON_VERSION}`);
  });
});

describe('waitForAnonSocks (bootstrap / SOCKS-bind wait + timeout)', () => {
  const noop = (): void => {};

  it('resolves once the SOCKS probe succeeds', async () => {
    let calls = 0;
    await expect(
      waitForAnonSocks({
        port: 9050,
        deadlineMs: Date.now() + 10_000,
        childExited: () => false,
        log: noop,
        // Fail twice, then succeed.
        probe: async () => {
          calls += 1;
          if (calls < 3) throw new Error('ECONNREFUSED');
        },
        sleep: async () => {},
      })
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('rejects when the deadline passes without a bind', async () => {
    await expect(
      waitForAnonSocks({
        port: 9050,
        deadlineMs: Date.now() - 1, // already past
        childExited: () => false,
        log: noop,
        probe: async () => {
          throw new Error('ECONNREFUSED');
        },
        sleep: async () => {},
      })
    ).rejects.toThrow(/never bound/);
  });

  it('fails fast if the anon process exits before binding', async () => {
    await expect(
      waitForAnonSocks({
        port: 9050,
        deadlineMs: Date.now() + 10_000,
        childExited: () => true,
        log: noop,
        probe: async () => {
          throw new Error('ECONNREFUSED');
        },
        sleep: async () => {},
      })
    ).rejects.toThrow(/exited before SOCKS5 port bound/);
  });
});

describe('ensureAnonBinary (download + checksum gate)', () => {
  let cacheDir: string;
  afterEach(() => {
    if (cacheDir && existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('rejects when the downloaded zip checksum does not match', async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'anon-test-'));
    // Mock download: write bytes whose sha256 will NOT match the pinned hash.
    const download = async (_url: string, dest: string): Promise<void> => {
      writeFileSync(dest, 'not-a-real-anon-binary');
    };
    let extractCalled = false;
    const extract = async (): Promise<void> => {
      extractCalled = true;
    };

    await expect(
      ensureAnonBinary({
        cacheDir,
        platform: 'darwin',
        arch: 'arm64',
        download,
        extract,
      })
    ).rejects.toThrow(/Checksum mismatch/);
    // A failed checksum must NOT proceed to extraction.
    expect(extractCalled).toBe(false);
    // The bad artifact is cleaned up so a retry re-downloads.
    expect(existsSync(join(cacheDir, 'anon-beta-macos-arm64.zip'))).toBe(false);
  });

  it('has a pinned sha256 for every supported platform (issue #204)', () => {
    for (const [key, asset] of Object.entries(ANON_ASSETS)) {
      expect(
        asset.sha256,
        `${key} (${asset.assetName}) must have a pinned sha256`
      ).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a platform whose checksum is not pinned (defensive guard, issue #204)', async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'anon-test-'));
    // All real platforms are now pinned (#204), so exercise the defensive
    // null-checksum guard by temporarily un-pinning one and restoring after.
    const entry = ANON_ASSETS['linux-x64'];
    if (!entry) throw new Error('test setup: linux-x64 asset missing');
    const original = entry.sha256;
    entry.sha256 = null;
    let downloadCalled = false;
    try {
      await expect(
        ensureAnonBinary({
          cacheDir,
          platform: 'linux',
          arch: 'x64',
          download: async () => {
            downloadCalled = true;
          },
          extract: async () => {},
        })
      ).rejects.toThrow(/no pinned checksum/);
      expect(downloadCalled).toBe(false);
    } finally {
      entry.sha256 = original;
    }
  });

  it('skips re-download when an extracted anon binary already exists', async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'anon-test-'));
    writeFileSync(join(cacheDir, 'anon'), '#!/bin/sh\n');
    let downloadCalled = false;
    const anonPath = await ensureAnonBinary({
      cacheDir,
      platform: 'darwin',
      arch: 'arm64',
      download: async () => {
        downloadCalled = true;
      },
      extract: async () => {},
    });
    expect(anonPath).toBe(join(cacheDir, 'anon'));
    expect(downloadCalled).toBe(false);
  });
});
