/**
 * `rig entry` tests: show/switch of the network entry node (payment ingress +
 * relay), persisted to `~/.toon-client/config.json`'s `btpUrl`/`relayUrl`.
 * Covers the named entries (apex = clear-to-genesis-seed, sandbox = baked
 * devnet endpoints), explicit URLs (+ --relay), read-merge-write (other
 * config fields preserved), the legacy `proxyUrl` removal, topology-cache
 * deletion, env-precedence + per-entry-channel + sandbox-specific warnings,
 * the `--json` envelope, and usage errors. The config file is a real temp
 * file under an isolated TOON_CLIENT_HOME; the genesis seed is injected.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENTRY_USAGE,
  runEntry,
  SANDBOX_BTP_URL,
  SANDBOX_RELAY_URL,
  type EntryDeps,
} from './entry.js';
import type { CliIo } from './output.js';
import { TOPOLOGY_CACHE_FILENAME } from '../standalone/topology-cache.js';

const SEED_BTP = 'wss://proxy.devnet.toonprotocol.dev:443';
const SEED_RELAY = 'wss://relay-ws.devnet.toonprotocol.dev';

interface Harness {
  deps: EntryDeps;
  out: string[];
  err: string[];
}

function makeHarness(
  env: NodeJS.ProcessEnv,
  // `null` = "no seed available" (an explicit `undefined` would take the
  // default parameter).
  seedArg: { relayUrl?: string; btpEndpoint?: string } | null = {
    relayUrl: SEED_RELAY,
    btpEndpoint: SEED_BTP,
  }
): Harness {
  const seed = seedArg ?? undefined;
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    emitJson: (p) => out.push(JSON.stringify(p, null, 2)),
    isInteractive: false,
    confirm: async () => false,
  };
  return {
    deps: { io, env, loadGenesisSeed: async () => seed },
    out,
    err,
  };
}

describe('rig entry', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rig-entry-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TOON_CLIENT_HOME: home,
    ...extra,
  });

  const configPath = (): string => join(home, 'config.json');
  const cachePath = (): string => join(home, TOPOLOGY_CACHE_FILENAME);
  function writeConfig(o: Record<string, unknown>): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(), JSON.stringify(o));
  }
  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  }
  function writeCache(): void {
    mkdirSync(home, { recursive: true });
    writeFileSync(cachePath(), '{}');
  }
  function parseJson(h: Harness): Record<string, unknown> {
    return JSON.parse(h.out.join('\n')) as Record<string, unknown>;
  }

  // ── show ────────────────────────────────────────────────────────────────

  it('bare `rig entry` with no config shows the genesis-seed apex', async () => {
    const h = makeHarness(env());
    expect(await runEntry([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('Entry: apex');
    expect(text).toContain(SEED_BTP);
    expect(text).toContain(SEED_RELAY);
    expect(text).toContain('genesis seed');
    // Show never writes.
    expect(existsSync(configPath())).toBe(false);
  });

  it('show reports a configured sandbox entry with its source', async () => {
    writeConfig({ btpUrl: SANDBOX_BTP_URL, relayUrl: SANDBOX_RELAY_URL });
    const h = makeHarness(env());
    expect(await runEntry(['--json'], h.deps)).toBe(0);
    expect(parseJson(h)).toMatchObject({
      command: 'entry',
      entry: 'sandbox',
      btpUrl: SANDBOX_BTP_URL,
      btpSource: 'config',
      relayUrl: SANDBOX_RELAY_URL,
      relaySource: 'config',
    });
  });

  it('show: env endpoints outrank config; a custom URL classifies as custom', async () => {
    writeConfig({ btpUrl: SANDBOX_BTP_URL });
    const h = makeHarness(
      env({ TOON_CLIENT_BTP_URL: 'wss://my-node.example:443' })
    );
    expect(await runEntry(['--json'], h.deps)).toBe(0);
    expect(parseJson(h)).toMatchObject({
      entry: 'custom',
      btpUrl: 'wss://my-node.example:443',
      btpSource: 'env',
    });
  });

  it('show without a seed and without config reports nothing configured', async () => {
    const h = makeHarness(env(), null);
    expect(await runEntry(['--json'], h.deps)).toBe(0);
    expect(parseJson(h)).toMatchObject({
      entry: null,
      btpUrl: null,
      btpSource: null,
      relayUrl: null,
      relaySource: null,
    });
  });

  // ── sandbox ─────────────────────────────────────────────────────────────

  it('entry sandbox writes the baked endpoints and preserves other fields', async () => {
    writeConfig({ network: 'devnet', chain: 'mina', keystorePath: '/k.json' });
    const h = makeHarness(env());
    expect(await runEntry(['sandbox'], h.deps)).toBe(0);
    expect(readConfig()).toMatchObject({
      network: 'devnet',
      chain: 'mina',
      keystorePath: '/k.json',
      btpUrl: SANDBOX_BTP_URL,
      relayUrl: SANDBOX_RELAY_URL,
    });
    const text = h.out.join('\n');
    expect(text).toContain('sandbox');
    expect(text).toContain('Mina USDC only');
    // Channels-are-per-entry warning always fires on a switch.
    expect(h.err.join('\n')).toContain('per-entry-peer');
    // Repo git-origin relay precedence warning (sandbox-specific).
    expect(h.err.join('\n')).toContain('rig remote add origin');
  });

  it('entry sandbox with a non-mina chain pinned suggests `rig chain set mina`', async () => {
    writeConfig({ chain: 'evm' });
    const h = makeHarness(env());
    expect(await runEntry(['sandbox'], h.deps)).toBe(0);
    const warnings = h.err.join('\n');
    expect(warnings).toContain('rig chain set mina');
    expect(warnings).toContain('currently evm');
  });

  it('entry sandbox with mina pinned does NOT nag about the chain', async () => {
    writeConfig({ chain: 'mina' });
    const h = makeHarness(env());
    expect(await runEntry(['sandbox'], h.deps)).toBe(0);
    expect(h.err.join('\n')).not.toContain('rig chain set mina');
  });

  it('a mutation deletes the topology cache and reports it', async () => {
    writeCache();
    const h = makeHarness(env());
    expect(await runEntry(['sandbox', '--json'], h.deps)).toBe(0);
    expect(existsSync(cachePath())).toBe(false);
    expect(parseJson(h)).toMatchObject({ clearedTopologyCache: true });
  });

  it('no cache present: the mutation still succeeds (best-effort)', async () => {
    const h = makeHarness(env());
    expect(await runEntry(['sandbox', '--json'], h.deps)).toBe(0);
    expect(parseJson(h)).toMatchObject({ clearedTopologyCache: false });
  });

  it('a mutation removes the legacy proxyUrl (it outranks btpUrl) and warns', async () => {
    writeConfig({ proxyUrl: 'wss://old-proxy.example:443' });
    const h = makeHarness(env());
    expect(await runEntry(['sandbox'], h.deps)).toBe(0);
    expect(readConfig()['proxyUrl']).toBeUndefined();
    expect(h.err.join('\n')).toContain('proxyUrl');
  });

  it('env endpoint vars trigger a precedence warning on write', async () => {
    const h = makeHarness(env({ TOON_CLIENT_BTP_URL: 'wss://elsewhere:443' }));
    expect(await runEntry(['sandbox'], h.deps)).toBe(0);
    expect(h.err.join('\n')).toContain('TOON_CLIENT_BTP_URL');
    expect(h.err.join('\n')).toContain('overrides');
  });

  // ── apex ────────────────────────────────────────────────────────────────

  it('entry apex clears btpUrl/relayUrl/proxyUrl and falls back to the seed', async () => {
    writeConfig({
      btpUrl: SANDBOX_BTP_URL,
      relayUrl: SANDBOX_RELAY_URL,
      proxyUrl: 'wss://old:443',
      network: 'devnet',
    });
    const h = makeHarness(env());
    expect(await runEntry(['apex', '--json'], h.deps)).toBe(0);
    const config = readConfig();
    expect(config['btpUrl']).toBeUndefined();
    expect(config['relayUrl']).toBeUndefined();
    expect(config['proxyUrl']).toBeUndefined();
    expect(config['network']).toBe('devnet');
    expect(parseJson(h)).toMatchObject({
      entry: 'apex',
      btpUrl: SEED_BTP,
      btpSource: 'genesis-seed',
      relayUrl: SEED_RELAY,
      relaySource: 'genesis-seed',
      wrote: { btpUrl: null, relayUrl: null },
    });
  });

  // ── explicit URL ────────────────────────────────────────────────────────

  it('an explicit wss URL writes btpUrl only; --relay also sets relayUrl', async () => {
    writeConfig({ relayUrl: 'wss://keep-me.example' });
    const h = makeHarness(env());
    expect(await runEntry(['wss://my-node.example:443'], h.deps)).toBe(0);
    expect(readConfig()).toMatchObject({
      btpUrl: 'wss://my-node.example:443',
      relayUrl: 'wss://keep-me.example',
    });

    const j = makeHarness(env());
    expect(
      await runEntry(
        ['wss://my-node.example:443', '--relay', 'wss://my-relay.example', '--json'],
        j.deps
      )
    ).toBe(0);
    expect(readConfig()).toMatchObject({
      btpUrl: 'wss://my-node.example:443',
      relayUrl: 'wss://my-relay.example',
    });
    expect(parseJson(j)).toMatchObject({
      entry: 'custom',
      wrote: {
        btpUrl: 'wss://my-node.example:443',
        relayUrl: 'wss://my-relay.example',
      },
    });
  });

  // ── usage errors (exit 2) ───────────────────────────────────────────────

  it('an unknown entry name is a usage error', async () => {
    const h = makeHarness(env());
    expect(await runEntry(['bogus'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('unknown entry');
    expect(h.err.join('\n')).toContain('Usage: rig entry');
  });

  it('a non-ws URL is a usage error', async () => {
    const h = makeHarness(env());
    expect(await runEntry(['https://not-a-relay.example'], h.deps)).toBe(2);
  });

  it('--relay with a named entry is a usage error', async () => {
    const h = makeHarness(env());
    expect(await runEntry(['sandbox', '--relay', 'wss://x.example'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--relay only applies');
  });

  it('--relay with a non-ws value is a usage error', async () => {
    const h = makeHarness(env());
    expect(
      await runEntry(['wss://ok.example', '--relay', 'http://nope.example'], h.deps)
    ).toBe(2);
  });

  it('more than one positional is a usage error', async () => {
    const h = makeHarness(env());
    expect(await runEntry(['apex', 'sandbox'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('at most one argument');
  });

  it('--help prints usage (exit 0) and never writes', async () => {
    const h = makeHarness(env());
    expect(await runEntry(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toBe(ENTRY_USAGE);
    expect(existsSync(configPath())).toBe(false);
  });
});
