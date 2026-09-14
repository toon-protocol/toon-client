import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANON_ASSETS,
  ANON_VERSION,
  defaultCacheDir,
  ensureAnonBinary,
  renderTorrc,
  selectAnonAsset,
} from './anon-daemon.js';

describe('the pinned release', () => {
  it('pins a stable channel, not a beta', () => {
    // A payer should not be shipped a beta daemon by default.
    expect(ANON_VERSION).toBe('v0.4.10.2');
    for (const asset of Object.values(ANON_ASSETS)) {
      expect(asset.assetName).toContain('-live-');
      expect(asset.assetName).not.toContain('-beta-');
    }
  });

  it('pins a sha256 for every platform it offers', () => {
    // The gate is only real if there is something to check against.
    for (const [platform, asset] of Object.entries(ANON_ASSETS)) {
      expect(asset.sha256, `${platform} is unpinned`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('covers the platforms a person runs the CLI on, Windows included', () => {
    expect(Object.keys(ANON_ASSETS).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
  });
});

describe('selectAnonAsset', () => {
  it('finds the asset for a supported platform', () => {
    expect(selectAnonAsset('linux', 'x64').assetName).toBe('anon-live-linux-amd64.zip');
    expect(selectAnonAsset('darwin', 'arm64').assetName).toBe('anon-live-macos-arm64.zip');
  });

  it('names the alternative when a platform has no asset', () => {
    expect(() => selectAnonAsset('freebsd', 'x64')).toThrow(/No pinned anon binary for freebsd-x64/);
    expect(() => selectAnonAsset('freebsd', 'x64')).toThrow(/--socks/);
  });
});

describe('ensureAnonBinary', () => {
  it('fails closed on an unpinned asset rather than downloading it', async () => {
    const platform = `${process.platform}-${process.arch}`;
    const original = ANON_ASSETS[platform];
    if (original === undefined) return; // nothing to unpin on this platform
    ANON_ASSETS[platform] = { assetName: original.assetName, sha256: null };
    try {
      // The directory does not exist, so a download is the only way forward —
      // and it must not be taken.
      await expect(ensureAnonBinary('/nonexistent/toon-anon-test')).rejects.toThrow(
        /no pinned checksum, so it will not be downloaded/
      );
    } finally {
      ANON_ASSETS[platform] = original;
    }
  });
});

describe('renderTorrc', () => {
  it('agrees to the terms — without which anon exits immediately', () => {
    expect(renderTorrc('/cache', 9050)).toMatch(/^AgreeToTerms 1$/m);
  });

  it('binds SOCKS to loopback only, on the port it was given', () => {
    expect(renderTorrc('/cache', 9051)).toMatch(/^SOCKSPort 127\.0\.0\.1:9051$/m);
  });

  it('points the daemon at its own cache for data and geoip', () => {
    const torrc = renderTorrc('/cache', 9050);
    expect(torrc).toMatch(/^DataDirectory \/cache\/data$/m);
    expect(torrc).toMatch(/^GeoIPFile \/cache\/geoip$/m);
    expect(torrc).toMatch(/^GeoIPv6File \/cache\/geoip6$/m);
  });
});

describe('defaultCacheDir', () => {
  it('keys the cache by version, so a new pin never reuses an old binary', () => {
    expect(defaultCacheDir()).toContain(ANON_VERSION);
  });
});

describe('the cache', () => {
  it('reuses a binary that is already there, downloading nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toon-anon-cache-'));
    const binary = join(dir, process.platform === 'win32' ? 'anon.exe' : 'anon');
    writeFileSync(binary, '');
    const announced: string[] = [];

    try {
      await expect(ensureAnonBinary(dir, (message) => announced.push(message))).resolves.toBe(
        binary
      );
      // Nothing was announced because nothing was fetched: a second run is free.
      expect(announced).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
