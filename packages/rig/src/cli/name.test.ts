/**
 * `rig name` tests (#367): the ArNS buy/set/status verbs.
 *
 * HARD SAFETY: every money- and state-moving path is exercised ONLY against an
 * injected `@ar.io/sdk` stub (the {@link LoadArns} seam). No real ar.io
 * registry call is ever made and no real $ARIO is ever spent — the stub records
 * calls and returns canned values. Identity/Solana-key derivation is REAL (a
 * fixed public test mnemonic), so the owner/payer address is the one the client
 * would use, but nothing is signed against a live network.
 *
 * Coverage: buy (estimate → confirm → execute, the strict `--json` contract,
 * and the load-bearing "mARIO on Solana, NOT ILP" messaging), set (base +
 * undername, mocked), and status (FREE, no confirm, mocked read).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from './output.js';
import {
  ArnsSdkUnavailableError,
  MARIO_PAYMENT_NOTE,
  runName,
  type ArnsAnt,
  type ArnsSdk,
  type LoadArns,
  type NameDeps,
} from './name.js';

/** Standard BIP-39 test vector phrase — deterministic, never funded. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** A plausible 43-char Arweave txId (path-manifest target). */
const TX_ID = 'x'.repeat(43);

interface StubCalls {
  getTokenCost: { intent: string; name: string; type: string; years?: number }[];
  buyRecord: { name: string; type: string; years?: number }[];
  getArNSRecord: { name: string }[];
  antFor: string[];
  setBaseNameRecord: { transactionId: string; ttlSeconds: number }[];
  setUndernameRecord: { undername: string; transactionId: string; ttlSeconds: number }[];
}

interface StubOptions {
  /** mARIO cost getTokenCost returns (default 1_000_000n = 1 ARIO). */
  cost?: bigint;
  /** Record getArNSRecord returns (default: a registered lease). */
  record?: Awaited<ReturnType<ArnsSdk['getArNSRecord']>>;
  /** ANT record targets getRecords returns. */
  targets?: Record<string, { transactionId: string; ttlSeconds: number }>;
  /** Make loadArns throw this (optional-dep-missing path). */
  loadError?: Error;
}

function makeStubSdk(options: StubOptions): { sdk: ArnsSdk; calls: StubCalls } {
  const calls: StubCalls = {
    getTokenCost: [],
    buyRecord: [],
    getArNSRecord: [],
    antFor: [],
    setBaseNameRecord: [],
    setUndernameRecord: [],
  };
  const ant: ArnsAnt = {
    getRecords: async () => options.targets ?? {},
    setBaseNameRecord: async (a) => {
      calls.setBaseNameRecord.push(a);
      return { id: 'msg-base' };
    },
    setUndernameRecord: async (a) => {
      calls.setUndernameRecord.push(a);
      return { id: 'msg-under' };
    },
  };
  const defaultRecord = {
    processId: 'ANT-PROCESS-ID',
    type: 'lease' as const,
    startTimestamp: 1_700_000_000_000,
    endTimestamp: 1_800_000_000_000,
    undernameLimit: 10,
  };
  const sdk: ArnsSdk = {
    getTokenCost: async (args) => {
      calls.getTokenCost.push(args);
      return options.cost ?? 1_000_000n;
    },
    buyRecord: async (args) => {
      calls.buyRecord.push(args);
      return { id: 'registry-tx-1', processId: 'ANT-PROCESS-ID' };
    },
    getArNSRecord: async (args) => {
      calls.getArNSRecord.push(args);
      return options.record === undefined ? defaultRecord : options.record;
    },
    ant: async (pid) => {
      calls.antFor.push(pid);
      return ant;
    },
  };
  return { sdk, calls };
}

interface Harness {
  deps: NameDeps;
  out: string[];
  err: string[];
  calls: StubCalls;
  loadArnsCalls: number;
}

function makeHarness(
  env: NodeJS.ProcessEnv,
  cwd: string,
  opts: { interactive?: boolean; confirm?: boolean; stub?: StubOptions } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
    isInteractive: opts.interactive ?? false,
    confirm: async () => opts.confirm ?? false,
  };
  const { sdk, calls } = makeStubSdk(opts.stub ?? {});
  let loadArnsCalls = 0;
  const loadArns: LoadArns = async (options) => {
    loadArnsCalls += 1;
    if (opts.stub?.loadError) throw opts.stub.loadError;
    // The Solana key MUST reach the SDK loader — names are owned/paid by it.
    expect(options.solanaSecretKey.length).toBe(64);
    expect(options.solanaPublicKey.length).toBeGreaterThan(0);
    return sdk;
  };
  const deps: NameDeps = { io, env, cwd, loadArns };
  return {
    deps,
    out,
    err,
    calls,
    get loadArnsCalls() {
      return loadArnsCalls;
    },
  };
}

describe('rig name', () => {
  let home: string;
  let cwd: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-name-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'rig-name-cwd-'));
    env = { RIG_MNEMONIC: MNEMONIC, TOON_CLIENT_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  // ── usage / arg validation ────────────────────────────────────────────────

  it('bare `rig name` prints usage (exit 2), no SDK load', async () => {
    const h = makeHarness(env, cwd);
    expect(await runName([], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('ArNS naming');
    expect(h.loadArnsCalls).toBe(0);
  });

  it('unknown subcommand is rejected (exit 2), no SDK load', async () => {
    const h = makeHarness(env, cwd);
    expect(await runName(['transfer', 'foo'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('unknown');
    expect(h.loadArnsCalls).toBe(0);
  });

  it('buy without a name errors (exit 2)', async () => {
    const h = makeHarness(env, cwd);
    expect(await runName(['buy'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('needs a <name>');
  });

  it('--years and --permabuy together is a usage error', async () => {
    const h = makeHarness(env, cwd);
    expect(await runName(['buy', 'foo', '--years', '2', '--permabuy'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('mutually exclusive');
  });

  // ── buy: estimate → confirm → execute ─────────────────────────────────────

  it('buy --json without --yes is a pure estimate — quote only, nothing bought', async () => {
    const h = makeHarness(env, cwd, { stub: { cost: 2_500_000n } });
    const code = await runName(['buy', 'mysite', '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({
      command: 'name',
      action: 'buy',
      name: 'mysite',
      type: 'lease',
      years: 1,
      executed: false,
    });
    expect(doc['quote']).toMatchObject({ mARIO: '2500000', ARIO: '2.5' });
    // The load-bearing distinction: mARIO on Solana, NOT ILP.
    expect(doc['payment']).toBe(MARIO_PAYMENT_NOTE);
    expect(String(doc['payment'])).toContain('NOT through TOON ILP payment channels');
    expect(doc['hint']).toContain('--yes');
    // Estimate quoted, but NOTHING was bought.
    expect(h.calls.getTokenCost).toHaveLength(1);
    expect(h.calls.buyRecord).toHaveLength(0);
  });

  it('buy --yes executes buyRecord and reports the registry tx + ANT process', async () => {
    const h = makeHarness(env, cwd, { stub: { cost: 1_000_000n } });
    const code = await runName(['buy', 'mysite', '--permabuy', '--yes', '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({ action: 'buy', type: 'permabuy', years: null, executed: true });
    expect(doc['result']).toMatchObject({
      registryTxId: 'registry-tx-1',
      antProcessId: 'ANT-PROCESS-ID',
    });
    expect(h.calls.getTokenCost).toEqual([
      { intent: 'Buy-Name', name: 'mysite', type: 'permabuy' },
    ]);
    expect(h.calls.buyRecord).toEqual([{ name: 'mysite', type: 'permabuy' }]);
  });

  it('buy (human) states mARIO-on-Solana, NOT ILP, before the confirm', async () => {
    const h = makeHarness(env, cwd, { interactive: true, confirm: true, stub: { cost: 1_000_000n } });
    const code = await runName(['buy', 'mysite', '--years', '3'], h.deps);
    expect(code).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('mARIO');
    expect(text).toContain('NOT through TOON ILP payment channels');
    expect(text).toContain('3 years');
    expect(h.calls.buyRecord).toEqual([{ name: 'mysite', type: 'lease', years: 3 }]);
  });

  it('buy (human, interactive) declining the confirm buys nothing (exit 1)', async () => {
    const h = makeHarness(env, cwd, { interactive: true, confirm: false });
    const code = await runName(['buy', 'mysite'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('aborted');
    expect(h.calls.buyRecord).toHaveLength(0);
  });

  it('buy in a non-TTY session without --yes refuses (exit 1), buys nothing', async () => {
    const h = makeHarness(env, cwd, { interactive: false });
    const code = await runName(['buy', 'mysite'], h.deps);
    expect(code).toBe(1);
    expect(h.err.join('\n')).toContain('non-interactive');
    expect(h.calls.buyRecord).toHaveLength(0);
  });

  // ── set: base + undername ─────────────────────────────────────────────────

  it('set --yes points the base name at a txId via setBaseNameRecord', async () => {
    const h = makeHarness(env, cwd);
    const code = await runName(['set', 'mysite', TX_ID, '--yes', '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({
      action: 'set',
      name: 'mysite',
      undername: null,
      txId: TX_ID,
      ttl: 3600,
      antProcessId: 'ANT-PROCESS-ID',
      executed: true,
    });
    expect(h.calls.setBaseNameRecord).toEqual([{ transactionId: TX_ID, ttlSeconds: 3600 }]);
    expect(h.calls.setUndernameRecord).toHaveLength(0);
  });

  it('set --undername --ttl targets the undername via setUndernameRecord', async () => {
    const h = makeHarness(env, cwd);
    const code = await runName(
      ['set', 'mysite', TX_ID, '--undername', 'app', '--ttl', '120', '--yes', '--json'],
      h.deps
    );
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({ undername: 'app', ttl: 120, executed: true });
    expect(h.calls.setUndernameRecord).toEqual([
      { undername: 'app', transactionId: TX_ID, ttlSeconds: 120 },
    ]);
    expect(h.calls.setBaseNameRecord).toHaveLength(0);
  });

  it('set --json without --yes previews without writing the record', async () => {
    const h = makeHarness(env, cwd);
    const code = await runName(['set', 'mysite', TX_ID, '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({ action: 'set', executed: false });
    expect(doc['hint']).toContain('--yes');
    expect(h.calls.setBaseNameRecord).toHaveLength(0);
  });

  it('set on an unregistered name errors (nothing written)', async () => {
    const h = makeHarness(env, cwd, { stub: { record: null } });
    const code = await runName(['set', 'ghost', TX_ID, '--yes', '--json'], h.deps);
    expect(code).toBe(1);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({ command: 'name', error: 'error' });
    expect(String(doc['detail'])).toContain('buy it first');
    expect(h.calls.setBaseNameRecord).toHaveLength(0);
  });

  it('set needs a txId (exit 2)', async () => {
    const h = makeHarness(env, cwd);
    expect(await runName(['set', 'mysite'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('needs a <txId>');
  });

  // ── status: FREE ──────────────────────────────────────────────────────────

  it('status is FREE — reads the record, never confirms or buys', async () => {
    const h = makeHarness(env, cwd, {
      interactive: false,
      stub: { targets: { '@': { transactionId: TX_ID, ttlSeconds: 3600 } } },
    });
    const code = await runName(['status', 'mysite', '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({
      command: 'name',
      action: 'status',
      name: 'mysite',
      registered: true,
    });
    expect(doc['record']).toMatchObject({ antProcessId: 'ANT-PROCESS-ID', type: 'lease' });
    expect(doc['targets']).toMatchObject({ '@': { transactionId: TX_ID, ttlSeconds: 3600 } });
    // FREE: no purchase, no write.
    expect(h.calls.buyRecord).toHaveLength(0);
    expect(h.calls.setBaseNameRecord).toHaveLength(0);
  });

  it('status of an unregistered name reports available (exit 0)', async () => {
    const h = makeHarness(env, cwd, { stub: { record: null } });
    const code = await runName(['status', 'ghost'], h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('not registered');
  });

  // ── network / registry selection ──────────────────────────────────────────

  it('rejects an invalid --network (exit 2)', async () => {
    const h = makeHarness(env, cwd);
    expect(await runName(['status', 'mysite', '--network', 'bogus'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--network must be one of');
  });

  it('--network devnet flows through to the JSON envelope', async () => {
    const h = makeHarness(env, cwd);
    const code = await runName(['status', 'mysite', '--network', 'devnet', '--json'], h.deps);
    expect(code).toBe(0);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({ network: 'devnet' });
  });

  // ── optional-dependency missing ───────────────────────────────────────────

  it('surfaces a clean error when @ar.io/sdk is missing', async () => {
    const h = makeHarness(env, cwd, {
      stub: { loadError: new ArnsSdkUnavailableError() },
    });
    const code = await runName(['status', 'mysite', '--json'], h.deps);
    expect(code).toBe(1);
    const doc = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(doc).toMatchObject({ command: 'name', error: 'arns_sdk_unavailable' });
    expect(String(doc['detail'])).toContain('@ar.io/sdk');
  });
});
