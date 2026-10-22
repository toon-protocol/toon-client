import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directFetch } from '../transport/rpc.js';
import { chainRoutes } from './chain-access.js';
import type { ResolvedConfig } from './config.js';

const edgeFetch = (() => Promise.resolve(new Response())) as typeof fetch;
const evmProxied = (() => Promise.resolve(new Response())) as typeof fetch;
const solanaProxied = (() => Promise.resolve(new Response())) as typeof fetch;

function config(over: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    fetch: edgeFetch,
    socksProxy: undefined,
    chainRpc: undefined,
    rpcUrls: { evm: 'http://evm.rpc', solana: 'http://sol.rpc' },
    ...over,
  } as ResolvedConfig;
}

describe('chainRoutes', () => {
  it('gives each chain its own proxied fetch when chain RPC rides the proxy', () => {
    const routes = chainRoutes(
      config({
        socksProxy: 'socks5h://127.0.0.1:9050',
        chainRpc: { evm: { fetch: evmProxied }, solana: { fetch: solanaProxied } },
      })
    );
    expect(routes.evm).toEqual({ url: 'http://evm.rpc', fetch: evmProxied, proxied: true });
    expect(routes.solana).toEqual({ url: 'http://sol.rpc', fetch: solanaProxied, proxied: true });
  });

  it('dials directly, never through the edge fetch, when a hidden payer opts RPC out', () => {
    const routes = chainRoutes(config({ socksProxy: 'socks5h://127.0.0.1:9050' }));
    expect(routes.evm.fetch).toBe(directFetch);
    expect(routes.solana.fetch).toBe(directFetch);
    expect(routes.solana.fetch).not.toBe(edgeFetch);
    expect(routes.evm.proxied).toBeUndefined();
  });

  it('uses the client’s fetch for Solana and the direct one for EVM with no proxy', () => {
    const routes = chainRoutes(config({}));
    expect(routes.solana.fetch).toBe(edgeFetch);
    expect(routes.evm.fetch).toBe(directFetch);
  });
});

describe('chain-access is the only reader of chainRpc', () => {
  it('no other source file reads it', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(root);
    // `config.ts` declares the field and `ToonClient.ts` is where it is built.
    const allowed = new Set(['client/chain-access.ts', 'client/config.ts', 'client/ToonClient.ts']);
    const readers = files
      .map((f) => relative(root, f))
      .filter((f) => !allowed.has(f))
      .filter((f) => /\bchainRpc\b/.test(readFileSync(join(root, f), 'utf8')))
      // Prose that names the field is not a read.
      .filter((f) => !f.endsWith('chain-access.types.ts'));
    expect(readers).toEqual([]);
  });
});
