// Test IDs: 8.7-UNIT-001, 8.7-UNIT-002, 8.7-UNIT-003
// AC covered: #1 (Production build), #2 (CSP correctness), #3 (Relative asset paths)

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', '..', 'dist');

/**
 * These tests verify the Vite production build output for Arweave deployment.
 * They require `pnpm build` to have been run first in packages/rig.
 *
 * If dist/ does not exist, the build-dependent tests are skipped.
 */
const buildExists = existsSync(resolve(distDir, 'index.html'));

// Use describe.skipIf to skip the entire suite when dist/ is missing
// (avoids failing CI when build hasn't been run yet)
describe.skipIf(!buildExists)(
  'Build Verification - 8.7-UNIT-001: Production build output',
  () => {
    it('[P0] dist/index.html exists after build', () => {
      const indexPath = resolve(distDir, 'index.html');
      expect(existsSync(indexPath)).toBe(true);
    });

    it('[P0] dist/ contains hashed JS bundle(s)', () => {
      const assetsDir = resolve(distDir, 'assets');
      expect(existsSync(assetsDir)).toBe(true);

      const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
      expect(jsFiles.length).toBeGreaterThan(0);

      // Verify filenames contain hashes (e.g., main-abc123.js)
      const hashedFiles = jsFiles.filter((f) =>
        /\w+-[a-zA-Z0-9]+\.js$/.test(f)
      );
      expect(hashedFiles.length).toBeGreaterThan(0);
    });

    it('[P0] dist/ contains hashed CSS bundle(s)', () => {
      const assetsDir = resolve(distDir, 'assets');
      expect(existsSync(assetsDir)).toBe(true);

      const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
      expect(cssFiles.length).toBeGreaterThan(0);
    });

    it('[P1] build output is self-contained (no server-side imports)', () => {
      const assetsDir = resolve(distDir, 'assets');
      const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));

      for (const jsFile of jsFiles) {
        const content = readFileSync(resolve(assetsDir, jsFile), 'utf-8');
        // Node.js built-in modules should not be in browser bundles
        expect(content).not.toContain('node:fs');
        expect(content).not.toContain('node:path');
        expect(content).not.toContain('node:crypto');
      }
    });
  }
);

describe.skipIf(!buildExists)(
  'Build Verification - 8.7-UNIT-003: Relative asset paths',
  () => {
    it('[P0] index.html uses relative paths for JS assets (not absolute /assets/)', () => {
      const indexPath = resolve(distDir, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');

      // Should NOT have absolute paths like /assets/main-abc123.js
      const absoluteScripts = html.match(/src="\/assets\//g);
      expect(absoluteScripts).toBeNull();

      // Should have relative paths like ./assets/main-abc123.js
      const relativeScripts = html.match(/src="\.\/assets\//g);
      expect(relativeScripts).not.toBeNull();
      expect(relativeScripts!.length).toBeGreaterThan(0);
    });

    it('[P0] index.html uses relative paths for CSS assets (not absolute /assets/)', () => {
      const indexPath = resolve(distDir, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');

      // Should NOT have absolute paths like /assets/style-def456.css
      const absoluteLinks = html.match(/href="\/assets\//g);
      expect(absoluteLinks).toBeNull();

      // Should have relative paths like ./assets/style-def456.css
      const relativeLinks = html.match(/href="\.\/assets\//g);
      expect(relativeLinks).not.toBeNull();
      expect(relativeLinks!.length).toBeGreaterThan(0);
    });

    it('[P1] no asset references use absolute root paths in index.html', () => {
      const indexPath = resolve(distDir, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');

      // Find all src="..." and href="..." values
      const allRefs = [
        ...(html.matchAll(/src="([^"]+)"/g) || []),
        ...(html.matchAll(/href="([^"]+)"/g) || []),
      ].map((m) => m[1]);

      for (const ref of allRefs) {
        // Skip data: URIs, external URLs, and inline SVG
        if (
          ref.startsWith('data:') ||
          ref.startsWith('http') ||
          ref.startsWith('//')
        ) {
          continue;
        }
        // All local asset refs should be relative (start with ./)
        expect(ref).not.toMatch(/^\/[^/]/);
      }
    });
  }
);

describe.skipIf(!buildExists)(
  'Build Verification - 8.7-UNIT-002: CSP in production build',
  () => {
    it('[P1] built index.html preserves CSP connect-src with Arweave gateways', () => {
      const indexPath = resolve(distDir, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');

      const cspMatch = html.match(/content="([^"]*connect-src[^"]*)"/);
      expect(cspMatch).not.toBeNull();

      const csp = cspMatch![1];
      expect(csp).toContain('https://ar-io.dev');
      expect(csp).toContain('https://*.ar-io.dev');
      expect(csp).toContain('https://arweave.net');
      expect(csp).toContain('https://*.arweave.net');
      expect(csp).toContain('https://permagate.io');
      expect(csp).toContain('https://*.permagate.io');
      expect(csp).toContain('ws:');
      expect(csp).toContain('wss:');
    });

    it('[P1] built index.html CSP script-src is self only (no inline)', () => {
      const indexPath = resolve(distDir, 'index.html');
      const html = readFileSync(indexPath, 'utf-8');

      const cspMatch = html.match(/content="([^"]*script-src[^"]*)"/);
      expect(cspMatch).not.toBeNull();

      const csp = cspMatch![1];
      // Extract just the script-src directive (up to the next directive or end)
      const scriptSrcMatch = csp.match(/script-src\s+([^;]*)/);
      expect(scriptSrcMatch).not.toBeNull();

      const scriptSrc = scriptSrcMatch![1];
      expect(scriptSrc).toContain("'self'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
    });
  }
);
