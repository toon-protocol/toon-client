import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  validateSocks5hUrl,
  createSocks5WebSocketFactory,
  createSocks5Fetch,
} from './socks5.js';

describe('validateSocks5hUrl', () => {
  it('accepts valid socks5h:// URL', () => {
    const result = validateSocks5hUrl('socks5h://127.0.0.1:9050');
    expect(result).toEqual({ host: '127.0.0.1', port: 9050 });
  });

  it('accepts socks5h:// with hostname', () => {
    const result = validateSocks5hUrl('socks5h://proxy.example.com:1080');
    expect(result).toEqual({ host: 'proxy.example.com', port: 1080 });
  });

  it('defaults to port 1080 when port omitted', () => {
    const result = validateSocks5hUrl('socks5h://localhost');
    expect(result).toEqual({ host: 'localhost', port: 1080 });
  });

  it('rejects socks5:// (missing h — DNS leak risk)', () => {
    expect(() => validateSocks5hUrl('socks5://127.0.0.1:9050')).toThrow(
      'socks5h://'
    );
  });

  it('rejects http:// scheme', () => {
    expect(() => validateSocks5hUrl('http://127.0.0.1:9050')).toThrow(
      'socks5h://'
    );
  });

  it('rejects empty string', () => {
    expect(() => validateSocks5hUrl('')).toThrow('socks5h://');
  });

  it('rejects malformed URL', () => {
    expect(() => validateSocks5hUrl('socks5h://:')).toThrow();
  });
});

describe('ESM-safe require (socks-proxy-agent / ws resolution)', () => {
  // Regression guard for the "Dynamic require of X is not supported" bug:
  // the module builds as ESM with socks-proxy-agent/ws external, so the
  // require(...) calls inside these factories must resolve via the
  // module-scoped createRequire(import.meta.url), NOT esbuild's throwing
  // __require shim. If the createRequire shim regresses, constructing the
  // factory throws while resolving the optional dep.
  it('createSocks5WebSocketFactory resolves socks-proxy-agent + ws without throwing', () => {
    expect(() =>
      createSocks5WebSocketFactory('socks5h://127.0.0.1:9050')
    ).not.toThrow();
  });

  it('createSocks5Fetch resolves socks-proxy-agent without throwing', () => {
    expect(() => createSocks5Fetch('socks5h://127.0.0.1:9050')).not.toThrow();
  });
});

describe('published ESM dist (pure node --input-type=module)', () => {
  // The decisive proof: import the BUILT dist under a pure-ESM Node process
  // (no CJS require in scope, mirroring an npm consumer) and construct the
  // SOCKS5 factory. Before the createRequire fix the dist contained esbuild's
  // __require shim, which threw "Dynamic require of \"socks-proxy-agent\" is
  // not supported" here. Skips gracefully if dist is not built.
  const here = dirname(fileURLToPath(import.meta.url));
  const distDir = resolve(here, '../../dist');
  // The transport lives in a hashed chunk (socks5-XXXX.js), not the package
  // entry — that chunk is where the require(...) calls were rewritten to the
  // throwing __require shim, so it is the right artifact to load under ESM.
  const chunk = existsSync(distDir)
    ? readdirSync(distDir).find(
        (f) => f.startsWith('socks5-') && f.endsWith('.js')
      )
    : undefined;

  it.skipIf(!chunk)(
    'loads built socks5 dist chunk and constructs SOCKS5 factory under pure ESM',
    () => {
      const chunkPath = resolve(distDir, chunk as string);
      const script = `
        import { createSocks5WebSocketFactory, createSocks5Fetch } from ${JSON.stringify(chunkPath)};
        createSocks5WebSocketFactory('socks5h://127.0.0.1:9050');
        createSocks5Fetch('socks5h://127.0.0.1:9050');
        console.log('ESM_OK');
      `;
      const out = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { encoding: 'utf8', cwd: distDir }
      );
      expect(out).toContain('ESM_OK');
    }
  );
});
