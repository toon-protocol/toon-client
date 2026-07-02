/**
 * Mode-selection matrix: explicit flags win; default probes the daemon
 * `/status` and falls back to standalone when a mnemonic source exists;
 * neither ⇒ a hard error naming both remediations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NoPublisherError,
  daemonBaseUrl,
  probeDaemon,
  selectMode,
  standaloneAvailability,
} from './mode.js';

const IDENTITY = 'ab'.repeat(32);

/** fetch stub answering /status with the given body (or failing). */
function statusFetch(
  body: unknown,
  opts: { status?: number; reject?: boolean } = {}
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (opts.reject) throw new TypeError('fetch failed: ECONNREFUSED');
    expect(String(input)).toMatch(/\/status$/);
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const healthyStatus = {
  ready: true,
  identity: { nostrPubkey: IDENTITY },
  relay: { url: 'wss://relay.devnet.example' },
};

let homeDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-home-'));
  env = { TOON_CLIENT_HOME: homeDir };
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('daemonBaseUrl', () => {
  it('defaults to port 8787 and honors TOON_CLIENT_HTTP_PORT', () => {
    expect(daemonBaseUrl({})).toBe('http://127.0.0.1:8787');
    expect(daemonBaseUrl({ TOON_CLIENT_HTTP_PORT: '9999' })).toBe(
      'http://127.0.0.1:9999'
    );
    expect(daemonBaseUrl({ TOON_CLIENT_HTTP_PORT: 'nope' })).toBe(
      'http://127.0.0.1:8787'
    );
  });
});

describe('probeDaemon', () => {
  it('reports identity + relay from a healthy status', async () => {
    const probe = await probeDaemon(env, statusFetch(healthyStatus));
    expect(probe.reachable).toBe(true);
    expect(probe.identity).toBe(IDENTITY);
    expect(probe.ready).toBe(true);
    expect(probe.relayUrl).toBe('wss://relay.devnet.example');
  });

  it('reports unreachable on connection failure and non-200', async () => {
    expect(
      (await probeDaemon(env, statusFetch({}, { reject: true }))).reachable
    ).toBe(false);
    expect(
      (await probeDaemon(env, statusFetch({}, { status: 500 }))).reachable
    ).toBe(false);
  });

  it('omits identity when the daemon reports an empty pubkey', async () => {
    const probe = await probeDaemon(
      env,
      statusFetch({ identity: { nostrPubkey: '' } })
    );
    expect(probe.reachable).toBe(true);
    expect(probe.identity).toBeUndefined();
  });
});

describe('standaloneAvailability', () => {
  it('is available via TOON_CLIENT_MNEMONIC', () => {
    const result = standaloneAvailability({
      ...env,
      TOON_CLIENT_MNEMONIC: 'test test test',
    });
    expect(result).toMatchObject({ available: true, source: 'env' });
  });

  it('is available via a config-file mnemonic or keystorePath', () => {
    writeFileSync(
      join(homeDir, 'config.json'),
      JSON.stringify({ mnemonic: 'test test test' })
    );
    expect(standaloneAvailability(env)).toMatchObject({
      available: true,
      source: 'config',
    });
    writeFileSync(
      join(homeDir, 'config.json'),
      JSON.stringify({ keystorePath: '/keys/store.json' })
    );
    expect(standaloneAvailability(env)).toMatchObject({
      available: true,
      source: 'config',
    });
  });

  it('is unavailable with no env and no config file', () => {
    expect(standaloneAvailability(env).available).toBe(false);
  });
});

describe('selectMode', () => {
  const flags = { daemon: false, standalone: false };

  it('rejects --daemon together with --standalone', async () => {
    await expect(
      selectMode({
        daemon: true,
        standalone: true,
        env,
        fetchImpl: statusFetch(healthyStatus),
      })
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('explicit --standalone wins without probing', async () => {
    const fetchImpl = (async () => {
      throw new Error('should not probe');
    }) as typeof fetch;
    const { mode } = await selectMode({
      daemon: false,
      standalone: true,
      env,
      fetchImpl,
    });
    expect(mode).toBe('standalone');
  });

  it('explicit --daemon selects daemon even when unreachable', async () => {
    const { mode, probe } = await selectMode({
      daemon: true,
      standalone: false,
      env,
      fetchImpl: statusFetch({}, { reject: true }),
    });
    expect(mode).toBe('daemon');
    expect(probe.reachable).toBe(false);
  });

  it('defaults to daemon when the probe finds a healthy identity', async () => {
    const { mode, probe } = await selectMode({
      ...flags,
      env,
      fetchImpl: statusFetch(healthyStatus),
    });
    expect(mode).toBe('daemon');
    expect(probe.identity).toBe(IDENTITY);
  });

  it('falls back to standalone when the daemon is down but a mnemonic exists', async () => {
    const { mode } = await selectMode({
      ...flags,
      env: { ...env, TOON_CLIENT_MNEMONIC: 'test test test' },
      fetchImpl: statusFetch({}, { reject: true }),
    });
    expect(mode).toBe('standalone');
  });

  it('falls back to standalone when the daemon has no identity yet', async () => {
    const { mode } = await selectMode({
      ...flags,
      env: { ...env, TOON_CLIENT_MNEMONIC: 'test test test' },
      fetchImpl: statusFetch({ identity: { nostrPubkey: '' } }),
    });
    expect(mode).toBe('standalone');
  });

  it('errors with BOTH remediations when neither mode is usable', async () => {
    const promise = selectMode({
      ...flags,
      env,
      fetchImpl: statusFetch({}, { reject: true }),
    });
    await expect(promise).rejects.toBeInstanceOf(NoPublisherError);
    await expect(promise).rejects.toThrow(/toon-clientd/);
    await expect(promise).rejects.toThrow(/TOON_CLIENT_MNEMONIC/);
  });
});
