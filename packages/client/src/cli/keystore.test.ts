import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CliConfigError } from './args.js';
import {
  defaultKeystorePath,
  ensureKeystoreDirectory,
  keystoreExists,
  readKeystore,
  resolveKeystorePath,
  resolvePassword,
} from './keystore.js';
import { generateKeystore } from '../keys/keystore-node.js';

const workspace = mkdtempSync(join(tmpdir(), 'toon-cli-keystore-'));
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('locating the keystore', () => {
  it('defaults to ~/.toon/keystore.json', () => {
    expect(defaultKeystorePath('/home/x')).toBe('/home/x/.toon/keystore.json');
  });

  it('prefers the flag, then the environment, then the default', () => {
    const env = { TOON_KEYSTORE: '/from/env.json' };
    expect(resolveKeystorePath({ flag: '/from/flag.json', env, home: '/home/x' })).toBe(
      '/from/flag.json'
    );
    expect(resolveKeystorePath({ env, home: '/home/x' })).toBe('/from/env.json');
    expect(resolveKeystorePath({ env: {}, home: '/home/x' })).toBe('/home/x/.toon/keystore.json');
  });
});

describe('resolving the password', () => {
  const prompt = async (): Promise<string> => 'from-prompt';

  it('lets an explicitly named file win over everything', async () => {
    const result = await resolvePassword({
      message: 'pw: ',
      passwordFile: '/pw.txt',
      env: { TOON_KEYSTORE_PASSWORD: 'from-env' },
      readFile: () => 'from-file\n',
      prompt,
    });
    expect(result).toEqual({ password: 'from-file', source: 'password-file' });
  });

  it('strips exactly one trailing newline, because that is how the file was made', async () => {
    const result = await resolvePassword({
      message: 'pw: ',
      passwordFile: '/pw.txt',
      readFile: () => 'secret \r\n',
    });
    expect(result.password).toBe('secret ');
  });

  it('refuses an empty password file rather than trying an empty password', async () => {
    await expect(
      resolvePassword({ message: 'pw: ', passwordFile: '/pw.txt', readFile: () => '\n' })
    ).rejects.toThrow(/empty/);
  });

  it('prefers the environment over a prompt, so a scripted run never blocks', async () => {
    const result = await resolvePassword({
      message: 'pw: ',
      env: { TOON_KEYSTORE_PASSWORD: 'from-env' },
      prompt,
    });
    expect(result).toEqual({ password: 'from-env', source: 'env' });
  });

  it('prompts when nothing else supplied one', async () => {
    const result = await resolvePassword({ message: 'pw: ', env: {}, prompt });
    expect(result).toEqual({ password: 'from-prompt', source: 'prompt' });
  });

  it('says what to do when there is no terminal and no variable', async () => {
    await expect(resolvePassword({ message: 'pw: ', env: {} })).rejects.toThrow(
      /not a terminal/
    );
    try {
      await resolvePassword({ message: 'pw: ', env: {} });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CliConfigError).hint).toMatch(/TOON_KEYSTORE_PASSWORD/);
      expect((error as CliConfigError).hint).toMatch(/--password-file/);
    }
  });
});

describe('reading the keystore', () => {
  it("tells a newcomer to run 'toon init' when there is no keystore", () => {
    const missing = join(workspace, 'nope.json');
    expect(keystoreExists(missing)).toBe(false);
    try {
      readKeystore(missing, 'pw');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CliConfigError);
      expect((error as CliConfigError).hint).toMatch(/toon init/);
    }
  });

  it('round-trips a keystore this package wrote, derivation included', () => {
    const path = join(workspace, 'nested', 'keystore.json');
    ensureKeystoreDirectory(path);
    const { mnemonic } = generateKeystore(path, 'pw', { derivation: 'standard' });
    const opened = readKeystore(path, 'pw');
    expect(opened.mnemonic).toBe(mnemonic);
    expect(opened.derivation).toBe('standard');
  });

  it('reports a wrong password as a config problem, not a crash', () => {
    const path = join(workspace, 'bad.json');
    writeFileSync(path, 'not json at all');
    expect(() => readKeystore(path, 'pw')).toThrow(CliConfigError);
  });
});
