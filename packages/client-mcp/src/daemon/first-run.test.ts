import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scaffoldFirstRun,
  hasConfiguredIdentity,
  defaultKeystorePath,
} from './first-run.js';
import {
  readConfigFile,
  resolveMnemonic,
  resolveConfig,
  configDir,
} from './config.js';

const ENV_KEYS = [
  'TOON_CLIENT_HOME',
  'TOON_CLIENT_CONFIG',
  'TOON_CLIENT_MNEMONIC',
  'TOON_CLIENT_KEYSTORE_PASSWORD',
];

describe('first-run onboarding (#251)', () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;
  let configPath: string;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
    home = mkdtempSync(join(tmpdir(), 'toon-firstrun-'));
    process.env['TOON_CLIENT_HOME'] = home;
    configPath = join(home, 'config.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  const silent = (): void => {};

  it('generates a keystore + config on a fresh install', async () => {
    expect(existsSync(configPath)).toBe(false);
    await scaffoldFirstRun({ log: silent });

    const keystorePath = join(home, 'keystore.json');
    expect(existsSync(keystorePath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);

    const file = readConfigFile(configPath);
    expect(file.keystorePath).toBe(keystorePath);
    expect(file.keystoreAutoPassword).toBe(true);
    // Transport knobs are surfaced for the user to fill in.
    expect(file.relayUrl).toBe('ws://localhost:7100');
    expect(file._help).toBeTruthy();
  });

  it('the generated identity reloads with no env var (resolveMnemonic)', async () => {
    await scaffoldFirstRun({ log: silent });
    const file = readConfigFile(configPath);
    // No TOON_CLIENT_KEYSTORE_PASSWORD set, yet the mnemonic resolves.
    const mnemonic = resolveMnemonic(file);
    expect(mnemonic.split(/\s+/).length).toBeGreaterThanOrEqual(12);
  });

  it('is idempotent: a second run keeps the same identity', async () => {
    await scaffoldFirstRun({ log: silent });
    const first = readConfigFile(configPath);
    const keystoreBefore = readFileSync(defaultKeystorePath(), 'utf8');

    await scaffoldFirstRun({ log: silent });
    const second = readConfigFile(configPath);
    const keystoreAfter = readFileSync(defaultKeystorePath(), 'utf8');

    expect(second.keystorePath).toBe(first.keystorePath);
    expect(keystoreAfter).toBe(keystoreBefore);
  });

  it('does not flag auto-password when the user sets the env password', async () => {
    process.env['TOON_CLIENT_KEYSTORE_PASSWORD'] = 'hunter2';
    await scaffoldFirstRun({ log: silent });
    const file = readConfigFile(configPath);
    expect(file.keystoreAutoPassword).toBeUndefined();
    // Resolves with the env password.
    expect(resolveMnemonic(file).length).toBeGreaterThan(0);
    // Without the env password a non-auto keystore must NOT silently load.
    delete process.env['TOON_CLIENT_KEYSTORE_PASSWORD'];
    expect(() => resolveMnemonic(file)).toThrow(/KEYSTORE_PASSWORD/);
  });

  it('leaves an existing identity untouched (env mnemonic)', async () => {
    process.env['TOON_CLIENT_MNEMONIC'] =
      'test test test test test test test test test test test junk';
    await scaffoldFirstRun({ log: silent });
    expect(existsSync(defaultKeystorePath())).toBe(false);
    // No config file is written when there is nothing to scaffold... except a
    // fresh install still gets the transport scaffold; assert identity is unset.
    const file = readConfigFile(configPath);
    expect(file.keystorePath).toBeUndefined();
  });

  it('scaffolds a config that resolves to a direct transport', async () => {
    await scaffoldFirstRun({ log: silent });
    const file = readConfigFile(configPath);

    const resolved = resolveConfig({ ...file, btpUrl: 'ws://1.2.3.4:3000/btp' });
    // No anon/HS transport overlay survives the scaffold → resolve path.
    expect(
      (resolved.toonClientConfig as Record<string, unknown>)['transport']
    ).toBeUndefined();
    expect(
      (resolved.toonClientConfig as Record<string, unknown>)['managedAnonProxy']
    ).toBeUndefined();
  });

  it('hasConfiguredIdentity reflects each source', () => {
    expect(hasConfiguredIdentity({})).toBe(false);
    expect(hasConfiguredIdentity({ mnemonic: 'x' })).toBe(true);
    expect(hasConfiguredIdentity({ keystorePath: '/k.json' })).toBe(true);
    process.env['TOON_CLIENT_MNEMONIC'] = 'words';
    expect(hasConfiguredIdentity({})).toBe(true);
  });

  it('honors configDir override via TOON_CLIENT_HOME', () => {
    expect(configDir()).toBe(home);
    expect(defaultKeystorePath()).toBe(join(home, 'keystore.json'));
  });
});
