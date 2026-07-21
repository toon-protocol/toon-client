/**
 * `rig chain` tests: show/set/unset of the settlement-chain (== which USDC)
 * preference, persisted to `~/.toon-client/config.json`'s `chain` field. Covers
 * the alias/full-id normalization, read-merge-write (other config fields
 * preserved), precedence warnings (TOON_CLIENT_CHAIN env / supportedChains),
 * the `--json` envelope, and usage errors. The config file is a real temp file
 * under an isolated TOON_CLIENT_HOME.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAIN_USAGE, runChain, type ChainDeps } from './chain.js';
import type { CliIo } from './output.js';

interface Harness {
  deps: ChainDeps;
  out: string[];
  err: string[];
}

function makeHarness(env: NodeJS.ProcessEnv): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    emitJson: (p) => out.push(JSON.stringify(p, null, 2)),
    isInteractive: false,
    confirm: async () => false,
  };
  return { deps: { io, env }, out, err };
}

describe('rig chain', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-chain-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TOON_CLIENT_HOME: home,
    ...extra,
  });

  const configPath = (): string => join(home, 'config.json');
  function writeConfig(o: Record<string, unknown>): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(o));
  }
  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  }

  // ── show ────────────────────────────────────────────────────────────────

  it('show with no config reports auto-selection', async () => {
    const h = makeHarness(env());
    expect(await runChain([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/\(auto\)/);
  });

  it('show reports the configured chain + which USDC it spends', async () => {
    writeConfig({ chain: 'solana' });
    const h = makeHarness(env());
    expect(await runChain([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/solana/);
    expect(text).toMatch(/Solana USDC/);
    expect(text).toMatch(/config `chain`/);
  });

  it('show prefers TOON_CLIENT_CHAIN env over the config field', async () => {
    writeConfig({ chain: 'solana' });
    const h = makeHarness(env({ TOON_CLIENT_CHAIN: 'evm' }));
    expect(await runChain(['--json'], h.deps)).toBe(0);
    const doc = JSON.parse(h.out.join('\n'));
    expect(doc).toMatchObject({ command: 'chain', chain: 'evm', source: 'env' });
    expect(doc.usdc).toMatch(/EVM USDC/);
  });

  // ── set ─────────────────────────────────────────────────────────────────

  it('set evm writes chain=evm and names the EVM USDC', async () => {
    const h = makeHarness(env());
    expect(await runChain(['set', 'evm'], h.deps)).toBe(0);
    expect(readConfig()).toMatchObject({ chain: 'evm' });
    expect(h.out.join('\n')).toMatch(/EVM USDC/);
  });

  it('set sol / mina normalize to canonical families', async () => {
    const h1 = makeHarness(env());
    expect(await runChain(['set', 'sol'], h1.deps)).toBe(0);
    expect(readConfig().chain).toBe('solana');

    const h2 = makeHarness(env());
    expect(await runChain(['set', 'mina'], h2.deps)).toBe(0);
    expect(readConfig().chain).toBe('mina');
  });

  it('set accepts a full chain id verbatim', async () => {
    const h = makeHarness(env());
    expect(await runChain(['set', 'evm:base:84532'], h.deps)).toBe(0);
    expect(readConfig().chain).toBe('evm:base:84532');
    expect(h.out.join('\n')).toMatch(/EVM USDC/);
  });

  it('set preserves every other config field (read-merge-write)', async () => {
    writeConfig({ network: 'devnet', relayUrl: 'wss://x', preferredTokens: { a: 'b' } });
    const h = makeHarness(env());
    expect(await runChain(['set', 'mina'], h.deps)).toBe(0);
    expect(readConfig()).toEqual({
      network: 'devnet',
      relayUrl: 'wss://x',
      preferredTokens: { a: 'b' },
      chain: 'mina',
    });
  });

  it('set warns when TOON_CLIENT_CHAIN env would override the write', async () => {
    const h = makeHarness(env({ TOON_CLIENT_CHAIN: 'evm' }));
    expect(await runChain(['set', 'solana'], h.deps)).toBe(0);
    expect(readConfig().chain).toBe('solana'); // still written
    expect(h.err.join('\n')).toMatch(/TOON_CLIENT_CHAIN.*overrides/);
  });

  it('set warns when supportedChains takes precedence', async () => {
    writeConfig({ supportedChains: ['evm:base:84532', 'solana:devnet'] });
    const h = makeHarness(env());
    expect(await runChain(['set', 'mina'], h.deps)).toBe(0);
    expect(h.err.join('\n')).toMatch(/supportedChains.*precedence/);
  });

  it('set --json returns the envelope with wrote + usdc', async () => {
    const h = makeHarness(env());
    expect(await runChain(['set', 'sol', '--json'], h.deps)).toBe(0);
    const doc = JSON.parse(h.out.join('\n'));
    expect(doc).toMatchObject({
      command: 'chain',
      chain: 'solana',
      source: 'config',
      wrote: 'solana',
    });
    expect(doc.usdc).toMatch(/Solana USDC/);
  });

  // ── unset ─────────────────────────────────────────────────────────────────

  it('unset removes the chain field, reverting to auto', async () => {
    writeConfig({ chain: 'solana', network: 'devnet' });
    const h = makeHarness(env());
    expect(await runChain(['unset'], h.deps)).toBe(0);
    expect(readConfig()).toEqual({ network: 'devnet' });
    expect(h.out.join('\n')).toMatch(/automatic selection/);
  });

  it('unset notes when env still pins the chain', async () => {
    writeConfig({ chain: 'solana' });
    const h = makeHarness(env({ TOON_CLIENT_CHAIN: 'evm' }));
    expect(await runChain(['unset'], h.deps)).toBe(0);
    expect(readConfig().chain).toBeUndefined();
    expect(h.out.join('\n')).toMatch(/Still pinned to evm.*TOON_CLIENT_CHAIN/);
  });

  // ── usage errors ────────────────────────────────────────────────────────

  it('set with an unknown chain is a usage error (exit 2, nothing written)', async () => {
    const h = makeHarness(env());
    expect(await runChain(['set', 'dogecoin'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toMatch(/chain must be one of/);
  });

  it('set with no chain argument is a usage error (exit 2)', async () => {
    const h = makeHarness(env());
    expect(await runChain(['set'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toMatch(/needs a chain/);
  });

  it('an unknown subcommand is a usage error (exit 2)', async () => {
    const h = makeHarness(env());
    expect(await runChain(['wat'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toMatch(/unknown subcommand/);
  });

  it('--help prints usage', async () => {
    const h = makeHarness(env());
    expect(await runChain(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toBe(CHAIN_USAGE);
  });
});
