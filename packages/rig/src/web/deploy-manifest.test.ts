// Test IDs: 8.7-UNIT-004, 8.7-UNIT-005, 8.7-UNIT-006, 8.7-UNIT-007, 8.7-UNIT-008, 8.7-UNIT-009
// AC covered: #4 (Deploy script), #5 (Path manifest), #6 (Content-Type tagging),
//             #7 (Free tier support), #8 (Authenticated upload), #12 (Documentation)

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import {
  generateManifest,
  getMimeType,
  validateDevModeFileSizes,
  generateDeploymentSummary,
  collectFiles,
  parseCliArgs,
} from '../../../../scripts/deploy-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ManifestEntry {
  path: string;
  txId: string;
}

interface ArweaveManifest {
  manifest: string;
  version: string;
  index: { path: string };
  fallback?: { id: string };
  paths: Record<string, { id: string }>;
}

describe('Deploy Manifest - 8.7-UNIT-005: Arweave path manifest generation', () => {
  it('[P0] generates valid manifest with correct structure', () => {
    // Given: a list of uploaded files with their Arweave tx IDs
    const entries: ManifestEntry[] = [
      { path: 'index.html', txId: 'tx-index-001' },
      { path: 'assets/main-abc123.js', txId: 'tx-js-002' },
      { path: 'assets/style-def456.css', txId: 'tx-css-003' },
    ];

    // When: we generate the Arweave path manifest
    const manifest: ArweaveManifest = generateManifest(entries);

    // Then: the manifest has the correct Arweave manifest structure
    expect(manifest.manifest).toBe('arweave/paths');
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.index).toEqual({ path: 'index.html' });
  });

  it('[P0] manifest includes fallback pointing to index.html tx ID', () => {
    // Given: uploaded files including index.html
    const entries: ManifestEntry[] = [
      { path: 'index.html', txId: 'tx-index-001' },
      { path: 'assets/main-abc123.js', txId: 'tx-js-002' },
    ];

    // When: we generate the manifest
    const manifest: ArweaveManifest = generateManifest(entries);

    // Then: fallback points to the index.html transaction (SPA routing)
    expect(manifest.fallback).toEqual({ id: 'tx-index-001' });
  });

  it('[P0] manifest paths map each file to its tx ID', () => {
    // Given: uploaded files
    const entries: ManifestEntry[] = [
      { path: 'index.html', txId: 'tx-index-001' },
      { path: 'assets/main-abc123.js', txId: 'tx-js-002' },
      { path: 'assets/style-def456.css', txId: 'tx-css-003' },
    ];

    // When: we generate the manifest
    const manifest: ArweaveManifest = generateManifest(entries);

    // Then: each file path maps to its tx ID
    expect(manifest.paths['index.html']).toEqual({ id: 'tx-index-001' });
    expect(manifest.paths['assets/main-abc123.js']).toEqual({
      id: 'tx-js-002',
    });
    expect(manifest.paths['assets/style-def456.css']).toEqual({
      id: 'tx-css-003',
    });
  });

  it('[P1] manifest handles nested directory paths correctly', () => {
    // Given: files in nested directories
    const entries: ManifestEntry[] = [
      { path: 'index.html', txId: 'tx-001' },
      { path: 'assets/js/vendor-abc.js', txId: 'tx-002' },
      { path: 'assets/css/theme-def.css', txId: 'tx-003' },
      { path: 'assets/images/logo.svg', txId: 'tx-004' },
    ];

    // When: we generate the manifest
    const manifest: ArweaveManifest = generateManifest(entries);

    // Then: nested paths are preserved as-is (no path normalization)
    expect(manifest.paths['assets/js/vendor-abc.js']).toEqual({
      id: 'tx-002',
    });
    expect(manifest.paths['assets/css/theme-def.css']).toEqual({
      id: 'tx-003',
    });
    expect(manifest.paths['assets/images/logo.svg']).toEqual({
      id: 'tx-004',
    });
  });

  it('[P2] manifest with empty entries produces minimal valid manifest', () => {
    // Given: no files (edge case)
    const entries: ManifestEntry[] = [];

    // When: we generate the manifest
    const manifest: ArweaveManifest = generateManifest(entries);

    // Then: manifest is structurally valid but has no paths or fallback
    expect(manifest.manifest).toBe('arweave/paths');
    expect(manifest.version).toBe('0.2.0');
    expect(Object.keys(manifest.paths)).toHaveLength(0);
  });
});

describe('Deploy Manifest - 8.7-UNIT-006: MIME type detection', () => {
  it('[P0] detects text/html for .html files', () => {
    expect(getMimeType('index.html')).toBe('text/html');
    expect(getMimeType('pages/about.html')).toBe('text/html');
  });

  it('[P0] detects application/javascript for .js files', () => {
    expect(getMimeType('assets/main-abc123.js')).toBe('application/javascript');
  });

  it('[P0] detects text/css for .css files', () => {
    expect(getMimeType('assets/style-def456.css')).toBe('text/css');
  });

  it('[P1] detects application/json for .json files', () => {
    expect(getMimeType('manifest.json')).toBe('application/json');
  });

  it('[P1] detects image/svg+xml for .svg files', () => {
    expect(getMimeType('assets/logo.svg')).toBe('image/svg+xml');
  });

  it('[P1] detects image/png for .png files', () => {
    expect(getMimeType('assets/icon.png')).toBe('image/png');
  });

  it('[P1] detects image/x-icon for .ico files', () => {
    expect(getMimeType('favicon.ico')).toBe('image/x-icon');
  });

  it('[P1] detects font/woff2 for .woff2 files', () => {
    expect(getMimeType('fonts/inter.woff2')).toBe('font/woff2');
  });

  it('[P1] detects font/woff for .woff files', () => {
    expect(getMimeType('fonts/inter.woff')).toBe('font/woff');
  });

  it('[P1] detects application/json for .map files (source maps)', () => {
    expect(getMimeType('assets/main-abc123.js.map')).toBe('application/json');
  });

  it('[P2] returns application/octet-stream for unknown extensions', () => {
    expect(getMimeType('assets/data.bin')).toBe('application/octet-stream');
    expect(getMimeType('assets/archive.tar')).toBe('application/octet-stream');
  });

  it('[P2] handles files with no extension', () => {
    expect(getMimeType('LICENSE')).toBe('application/octet-stream');
    expect(getMimeType('Makefile')).toBe('application/octet-stream');
  });
});

describe('Deploy Manifest - 8.7-UNIT-007: Free tier file size check', () => {
  it('[P0] accepts files under 100KB in dev mode', () => {
    // Given: a list of files all under 100KB
    const files = [
      { path: 'index.html', size: 2048 },
      { path: 'assets/main.js', size: 98_000 },
      { path: 'assets/style.css', size: 15_000 },
    ];

    // When: we validate for dev mode (free tier)
    const result = validateDevModeFileSizes(files);

    // Then: validation passes
    expect(result.valid).toBe(true);
    expect(result.oversizedFiles).toHaveLength(0);
  });

  it('[P0] rejects files over 100KB in dev mode', () => {
    // Given: a list of files where some exceed 100KB
    const files = [
      { path: 'index.html', size: 2048 },
      { path: 'assets/main.js', size: 250_000 },
      { path: 'assets/vendor.js', size: 150_000 },
      { path: 'assets/style.css', size: 15_000 },
    ];

    // When: we validate for dev mode (free tier)
    const result = validateDevModeFileSizes(files);

    // Then: validation fails with the oversized files listed
    expect(result.valid).toBe(false);
    expect(result.oversizedFiles).toHaveLength(2);
    expect(result.oversizedFiles).toContain('assets/main.js');
    expect(result.oversizedFiles).toContain('assets/vendor.js');
  });

  it('[P1] threshold is exactly 100KB (102400 bytes)', () => {
    // Given: a file exactly at 100KB
    const filesAtLimit = [{ path: 'exact.js', size: 102_400 }];
    const filesOverLimit = [{ path: 'over.js', size: 102_401 }];

    // When: we validate for dev mode
    const atLimit = validateDevModeFileSizes(filesAtLimit);
    const overLimit = validateDevModeFileSizes(filesOverLimit);

    // Then: exactly 100KB passes, one byte over fails
    expect(atLimit.valid).toBe(true);
    expect(overLimit.valid).toBe(false);
  });
});

describe('Deploy Manifest - 8.7-UNIT-009: Deployment documentation output', () => {
  it('[P1] generates gateway URLs from manifest tx ID', () => {
    // Given: a manifest transaction ID
    const manifestTxId = 'abc123def456_manifest-tx-id';

    // When: we generate the deployment summary
    const summary = generateDeploymentSummary(manifestTxId);

    // Then: gateway URLs are included for all three gateways
    expect(summary).toContain(`https://ar-io.dev/${manifestTxId}/`);
    expect(summary).toContain(`https://arweave.net/${manifestTxId}/`);
    expect(summary).toContain(`https://permagate.io/${manifestTxId}/`);
  });

  it('[P1] includes relay configuration instructions', () => {
    // Given: a manifest transaction ID
    const manifestTxId = 'abc123def456_manifest-tx-id';

    // When: we generate the deployment summary
    const summary = generateDeploymentSummary(manifestTxId);

    // Then: relay configuration via hash fragment is documented
    expect(summary).toContain('#relay=');
    expect(summary).toContain('wss://');
  });

  it('[P2] includes dogfooding instructions', () => {
    // Given: a manifest transaction ID
    const manifestTxId = 'abc123def456_manifest-tx-id';

    // When: we generate the deployment summary
    const summary = generateDeploymentSummary(manifestTxId);

    // Then: seed script and dogfooding steps are mentioned
    expect(summary).toContain('seed-forge-data');
  });
});

// ---------------------------------------------------------------------------
// 8.7-UNIT-004: Deploy script file collection and structure
// AC: #4 (Deploy script reads all files from dist/)
// ---------------------------------------------------------------------------

describe('Deploy Script - 8.7-UNIT-004: File collection', () => {
  it('[P0] collectFiles recursively finds files in a directory', () => {
    // Given: the packages/rig/src/web directory (known to contain files)
    const webDir = resolve(__dirname, '.');

    // When: we collect files from this directory
    const files = collectFiles(webDir, webDir);

    // Then: we find at least one .ts file with correct structure
    expect(files.length).toBeGreaterThan(0);
    const tsFile = files.find(
      (f: { relativePath: string }) => f.relativePath === 'router.ts'
    );
    expect(tsFile).toBeDefined();
    expect(tsFile.absolutePath).toContain('router.ts');
    expect(tsFile.size).toBeGreaterThan(0);
  });

  it('[P1] collectFiles returns relative paths without leading slashes', () => {
    const webDir = resolve(__dirname, '.');
    const files = collectFiles(webDir, webDir);

    for (const f of files) {
      expect(f.relativePath).not.toMatch(/^\//);
      expect(f.relativePath).not.toMatch(/^\.\//);
    }
  });

  it('[P1] collectFiles includes files in subdirectories', () => {
    // Use the packages/rig/src directory which has web/ subdirectory
    const srcDir = resolve(__dirname, '..');
    const files = collectFiles(srcDir, srcDir);

    // Should find files with path separators (nested)
    const nestedFiles = files.filter((f: { relativePath: string }) =>
      f.relativePath.includes('/')
    );
    expect(nestedFiles.length).toBeGreaterThan(0);
  });

  it('[P2] collectFiles returns empty array for empty directory', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'forge-test-'));
    try {
      const files = collectFiles(tmp, tmp);
      expect(files).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8.7-UNIT-008: CLI argument parsing and authenticated upload mode
// AC: #8 (Authenticated upload with --wallet)
// ---------------------------------------------------------------------------

describe('Deploy Script - 8.7-UNIT-008: CLI argument parsing', () => {
  it('[P0] --dev mode is recognized', () => {
    const result = parseCliArgs(['--dev']);
    expect(result.isDev).toBe(true);
    expect(result.walletPath).toBeNull();
    expect(result.error).toBeNull();
  });

  it('[P0] --wallet <path> is recognized', () => {
    const result = parseCliArgs(['--wallet', '/path/to/wallet.json']);
    expect(result.walletPath).toBe('/path/to/wallet.json');
    expect(result.isDev).toBe(false);
    expect(result.error).toBeNull();
  });

  it('[P0] --dry-run mode is recognized', () => {
    const result = parseCliArgs(['--dry-run']);
    expect(result.isDryRun).toBe(true);
    expect(result.error).toBeNull();
  });

  it('[P0] --confirm flag is recognized with --wallet', () => {
    const result = parseCliArgs(['--wallet', 'wallet.json', '--confirm']);
    expect(result.isConfirm).toBe(true);
    expect(result.walletPath).toBe('wallet.json');
    expect(result.error).toBeNull();
  });

  it('[P1] --dev and --wallet are mutually exclusive', () => {
    const result = parseCliArgs(['--dev', '--wallet', 'wallet.json']);
    expect(result.error).toContain('mutually exclusive');
  });

  it('[P1] no mode specified produces an error', () => {
    const result = parseCliArgs([]);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('--dev');
  });

  it('[P1] --wallet without path produces an error', () => {
    const result = parseCliArgs(['--wallet']);
    expect(result.error).toContain('--wallet requires');
  });

  it('[P1] --help flag is recognized and suppresses errors', () => {
    const result = parseCliArgs(['--help']);
    expect(result.showHelp).toBe(true);
    expect(result.error).toBeNull();
  });

  it('[P2] --wallet with --confirm but no --dev is valid', () => {
    const result = parseCliArgs(['--wallet', 'my-wallet.json', '--confirm']);
    expect(result.error).toBeNull();
    expect(result.isConfirm).toBe(true);
    expect(result.walletPath).toBe('my-wallet.json');
  });

  it('[P2] wallet path cost estimate requires --confirm to proceed', () => {
    // Without --confirm, the script prints cost estimate and exits
    const result = parseCliArgs(['--wallet', 'wallet.json']);
    expect(result.error).toBeNull();
    expect(result.isConfirm).toBe(false);
    // The deploy script checks isConfirm separately — no error from parseCliArgs
  });
});
