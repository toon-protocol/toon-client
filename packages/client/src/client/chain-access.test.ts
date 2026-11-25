import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directFetch } from '../transport/rpc.js';
import { chainRoutes, settlementNetworks } from './chain-access.js';
import { resolveConfig, type ResolvedConfig } from './config.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { EvmSettlementNetwork } from '../channel/batch-settlement/evm-network.js';
import { SolanaSettlementNetwork } from '../channel/batch-settlement/solana-network.js';

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

describe('settlementNetworks', () => {
  it('builds each network over the very fetch the canary proved for its chain', async () => {
    // `proveProxy` (ADR 0005) tests `chainRpc.evm.fetch` and `chainRpc.solana.fetch`.
    // Each network must dial through exactly that one, and so must everything
    // that asks the network for its RPC client.
    const dialled: string[] = [];
    const recorder =
      (chain: string, result: unknown): typeof fetch =>
      (_input, init) => {
        const { id } = JSON.parse(String(init?.body)) as { id: number };
        dialled.push(chain);
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
            headers: { 'content-type': 'application/json' },
          })
        );
      };
    const networks = settlementNetworks({
      ...resolveConfig({
        connector: 'http://connector.test',
        mnemonic: 'test test test test test test test test test test test junk',
        channelStore: new InMemoryChannelStore(),
        fetch: recorder('edge', null),
      }),
      socksProxy: 'socks5h://127.0.0.1:9050',
      chainRpc: {
        evm: { fetch: recorder('evm', '0x14a34') },
        solana: { fetch: recorder('solana', { value: 7 }) },
      },
    });
    const evm = networks.find((n) => n instanceof EvmSettlementNetwork);
    const solana = networks.find((n) => n instanceof SolanaSettlementNetwork);

    await expect(evm?.rpc?.reader().getChainId()).resolves.toBe(84532);
    expect(evm?.rpc?.proxied).toBe(true);
    await expect(solana?.rpc.getLamports('pubkey')).resolves.toBe(7n);
    expect(solana?.rpc.proxied).toBe(true);
    expect(dialled).toEqual(['evm', 'solana']);
  });
});

const root = join(__dirname, '..');

/** Every non-test source file, relative to `src/`. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(root);
  return files.map((f) => relative(root, f));
}

/** The source files whose text matches `pattern`, among `files`. */
function matching(files: string[], pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(readFileSync(join(root, f), 'utf8')));
}

describe('chain-access is the only reader of chainRpc', () => {
  it('no other source file reads it', () => {
    const files = sourceFiles();
    // `config.ts` declares the field and `ToonClient.ts` is where it is built.
    const allowed = new Set(['client/chain-access.ts', 'client/config.ts', 'client/ToonClient.ts']);
    const readers = matching(
      files.filter((f) => !allowed.has(f)),
      /\bchainRpc\b/
    );
    expect(readers).toEqual([]);
  });
});

describe('only a settlement network builds a chain client', () => {
  it('no module outside the EVM adapter builds a viem client', () => {
    expect(matching(sourceFiles(), /\bcreate(Public|Wallet)Client\b/)).toEqual([
      'channel/batch-settlement/evm-network.ts',
    ]);
  });

  it('no module outside the Solana adapter passes the Solana JSON-RPC plumbing a route', () => {
    // The functions of `solana/json-rpc.ts` that dial: each takes a route.
    const dialling = new Set([
      'solanaRpc',
      'solanaRpcClient',
      'getLamports',
      'getTokenAccountBalance',
      'getLatestBlockhash',
      'waitForConfirmation',
      'buildAndSendTransaction',
    ]);
    const importers = sourceFiles()
      .filter((f) => {
        const text = readFileSync(join(root, f), 'utf8');
        const imports = text.matchAll(/import \{([^}]*)\} from '[^']*solana\/json-rpc\.js'/g);
        return [...imports].some(([, names]) =>
          (names ?? '').split(',').some((n) => dialling.has(n.trim().replace(/^type\s+/, '')))
        );
      })
      .sort();
    // The adapter, and `svm.ts`, the program primitives it composes.
    expect(importers).toEqual([
      'channel/batch-settlement/solana-network.ts',
      'channel/batch-settlement/svm.ts',
    ]);
  });

  it('no module outside the adapters takes an RPC route', () => {
    // `chain-access.ts` decides the routes and `ToonClient.ts` hands each to its
    // adapter; `transport/` defines the route and the transport over it.
    const takers = matching(sourceFiles(), /\b(ChainRpcRoute|SolanaRpcTarget)\b/)
      .filter((f) => !f.startsWith('transport/'))
      .sort();
    expect(takers).toEqual([
      'channel/batch-settlement/evm-network.ts',
      'channel/batch-settlement/solana-network.ts',
      'channel/batch-settlement/svm.ts',
      'channel/solana/json-rpc.ts',
      'client/chain-access.ts',
    ]);
  });
});
