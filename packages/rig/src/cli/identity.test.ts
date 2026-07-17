/**
 * Identity-resolution chain tests (#248): the RIG_MNEMONIC precedence
 * matrix (env > env alias > project .env > keystore/config), the deprecated
 * TOON_CLIENT_MNEMONIC warning, and `.env` parse safety (only RIG_MNEMONIC
 * is read; quotes, comments, export prefixes; never required; never loaded
 * into the process env).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveNostrKeyFromMnemonic,
  importKeystore,
} from '@toon-protocol/client';
import {
  MissingIdentityError,
  findDotenvMnemonic,
  parseDotenvMnemonic,
  resolveIdentity,
  type ResolveIdentityOptions,
} from './identity.js';

// Two distinct valid BIP-39 phrases so pubkeys distinguish the winning tier.
const PHRASE_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PUBKEY_A = deriveNostrKeyFromMnemonic(PHRASE_A).pubkey;
const PUBKEY_B = deriveNostrKeyFromMnemonic(PHRASE_B).pubkey;

let dir: string;
let homeDir: string;
let warnings: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'toon-rig-identity-'));
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-identity-home-'));
  warnings = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function opts(
  env: Record<string, string>,
  cwd = dir
): ResolveIdentityOptions {
  return {
    env: { TOON_CLIENT_HOME: homeDir, ...env },
    cwd,
    warn: (line) => warnings.push(line),
    dotenvStopDir: dir, // never walk above the fixture dir (host .env safety)
  };
}

function writeClientConfig(config: Record<string, unknown>): void {
  writeFileSync(join(homeDir, 'config.json'), JSON.stringify(config));
}

describe('parseDotenvMnemonic', () => {
  it('parses plain, quoted, and export-prefixed assignments', () => {
    expect(parseDotenvMnemonic(`RIG_MNEMONIC=${PHRASE_A}`)).toBe(PHRASE_A);
    expect(parseDotenvMnemonic(`RIG_MNEMONIC="${PHRASE_A}"`)).toBe(PHRASE_A);
    expect(parseDotenvMnemonic(`RIG_MNEMONIC='${PHRASE_A}'`)).toBe(PHRASE_A);
    expect(parseDotenvMnemonic(`export RIG_MNEMONIC=${PHRASE_A}`)).toBe(PHRASE_A);
    expect(parseDotenvMnemonic(`  RIG_MNEMONIC = ${PHRASE_A}  `)).toBe(PHRASE_A);
  });

  it('ignores comments and strips inline comments from unquoted values', () => {
    expect(parseDotenvMnemonic(`# RIG_MNEMONIC=${PHRASE_B}`)).toBeUndefined();
    expect(
      parseDotenvMnemonic(`RIG_MNEMONIC=${PHRASE_A} # devnet identity`)
    ).toBe(PHRASE_A);
    // A quoted value keeps everything inside the quotes.
    expect(parseDotenvMnemonic(`RIG_MNEMONIC="${PHRASE_A} # not a comment"`)).toBe(
      `${PHRASE_A} # not a comment`
    );
  });

  it('reads ONLY RIG_MNEMONIC (never other variables), last assignment wins', () => {
    const content = [
      `TOON_CLIENT_MNEMONIC=${PHRASE_B}`,
      `OTHER=${PHRASE_B}`,
      `RIG_MNEMONIC=${PHRASE_B}`,
      `RIG_MNEMONIC=${PHRASE_A}`,
    ].join('\n');
    expect(parseDotenvMnemonic(content)).toBe(PHRASE_A);
  });

  it('treats an empty value as unset', () => {
    expect(parseDotenvMnemonic('RIG_MNEMONIC=')).toBeUndefined();
    expect(parseDotenvMnemonic('RIG_MNEMONIC=""')).toBeUndefined();
  });
});

describe('findDotenvMnemonic', () => {
  it('walks up from the start dir and stops at stopDir', () => {
    writeFileSync(join(dir, '.env'), `RIG_MNEMONIC=${PHRASE_A}\n`);
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findDotenvMnemonic(nested, dir)).toEqual({
      path: join(dir, '.env'),
      mnemonic: PHRASE_A,
    });
    // Nearest .env wins over an ancestor one.
    writeFileSync(join(nested, '.env'), `RIG_MNEMONIC=${PHRASE_B}\n`);
    expect(findDotenvMnemonic(nested, dir)?.mnemonic).toBe(PHRASE_B);
  });

  it('keeps walking past a .env without RIG_MNEMONIC and never requires one', () => {
    const nested = join(dir, 'sub');
    mkdirSync(nested);
    writeFileSync(join(nested, '.env'), 'UNRELATED=1\n');
    writeFileSync(join(dir, '.env'), `RIG_MNEMONIC=${PHRASE_A}\n`);
    expect(findDotenvMnemonic(nested, dir)?.mnemonic).toBe(PHRASE_A);
    rmSync(join(dir, '.env'));
    expect(findDotenvMnemonic(nested, dir)).toBeUndefined();
  });
});

describe('resolveIdentity precedence', () => {
  it('RIG_MNEMONIC env beats everything (alias, .env, config)', async () => {
    writeFileSync(join(dir, '.env'), `RIG_MNEMONIC=${PHRASE_B}\n`);
    writeClientConfig({ mnemonic: PHRASE_B });
    const identity = await resolveIdentity(
      opts({ RIG_MNEMONIC: PHRASE_A, TOON_CLIENT_MNEMONIC: PHRASE_B })
    );
    expect(identity.source).toBe('env');
    expect(identity.sourceLabel).toBe('RIG_MNEMONIC env');
    expect(identity.pubkey).toBe(PUBKEY_A);
    expect(identity.pubkey).not.toBe(PUBKEY_B); // the losing tiers' identity
    expect(warnings).toEqual([]); // no deprecation noise when the alias loses
  });

  it('TOON_CLIENT_MNEMONIC is honored as a deprecated alias (warns once)', async () => {
    writeFileSync(join(dir, '.env'), `RIG_MNEMONIC=${PHRASE_B}\n`);
    writeClientConfig({ mnemonic: PHRASE_B });
    const identity = await resolveIdentity(
      opts({ TOON_CLIENT_MNEMONIC: PHRASE_A })
    );
    expect(identity.source).toBe('env-alias');
    expect(identity.pubkey).toBe(PUBKEY_A);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('TOON_CLIENT_MNEMONIC is deprecated');
    expect(warnings[0]).toContain('RIG_MNEMONIC');
  });

  it('project .env beats the keystore/config tier', async () => {
    writeFileSync(join(dir, '.env'), `RIG_MNEMONIC="${PHRASE_A}"\n`);
    writeClientConfig({ mnemonic: PHRASE_B });
    const identity = await resolveIdentity(opts({}));
    expect(identity.source).toBe('dotenv');
    expect(identity.sourceLabel).toBe(join(dir, '.env'));
    expect(identity.pubkey).toBe(PUBKEY_A);
  });

  it('falls back to the shared config mnemonic field', async () => {
    writeClientConfig({ mnemonic: PHRASE_A });
    const identity = await resolveIdentity(opts({}));
    expect(identity.source).toBe('config');
    expect(identity.sourceLabel).toBe(join(homeDir, 'config.json'));
    expect(identity.pubkey).toBe(PUBKEY_A);
  });

  it('decrypts a keystore (preferred over the plain mnemonic field)', async () => {
    const keystorePath = join(homeDir, 'keystore.json');
    importKeystore(keystorePath, PHRASE_A, 'hunter2');
    writeClientConfig({ keystorePath, mnemonic: PHRASE_B });
    const identity = await resolveIdentity(
      opts({ TOON_CLIENT_KEYSTORE_PASSWORD: 'hunter2' })
    );
    expect(identity.source).toBe('keystore');
    expect(identity.sourceLabel).toBe(keystorePath);
    expect(identity.pubkey).toBe(PUBKEY_A);
  });

  it('uses the auto-password for daemon-provisioned keystores', async () => {
    const keystorePath = join(homeDir, 'keystore.json');
    importKeystore(keystorePath, PHRASE_A, 'toon-client-default');
    writeClientConfig({ keystorePath, keystoreAutoPassword: true });
    const identity = await resolveIdentity(opts({}));
    expect(identity.source).toBe('keystore');
    expect(identity.pubkey).toBe(PUBKEY_A);
  });

  it('errors when a keystore is configured without any password source', async () => {
    const keystorePath = join(homeDir, 'keystore.json');
    importKeystore(keystorePath, PHRASE_A, 'hunter2');
    writeClientConfig({ keystorePath });
    await expect(resolveIdentity(opts({}))).rejects.toThrow(
      /TOON_CLIENT_KEYSTORE_PASSWORD/
    );
  });

  it('applies the shared mnemonicAccountIndex to home-sourced phrases', async () => {
    writeClientConfig({ mnemonic: PHRASE_A, mnemonicAccountIndex: 1 });
    const identity = await resolveIdentity(opts({}));
    expect(identity.source).toBe('config');
    expect(identity.accountIndex).toBe(1);
    expect(identity.pubkey).toBe(deriveNostrKeyFromMnemonic(PHRASE_A, 1).pubkey);
    expect(identity.pubkey).not.toBe(PUBKEY_A);
  });

  it('ignores per-home mnemonicAccountIndex for an env-sourced phrase (#384)', async () => {
    writeClientConfig({ mnemonicAccountIndex: 1 });
    const identity = await resolveIdentity(opts({ RIG_MNEMONIC: PHRASE_A }));
    expect(identity.accountIndex).toBe(0);
    expect(identity.pubkey).toBe(PUBKEY_A);
  });

  it('derives the same identity from RIG_MNEMONIC across different homes (#384)', async () => {
    // Home A carries an accountIndex; home B has no config at all. An
    // explicit RIG_MNEMONIC must pin one identity regardless.
    writeClientConfig({ mnemonicAccountIndex: 3 });
    const otherHome = mkdtempSync(join(tmpdir(), 'toon-rig-identity-home-b-'));
    try {
      const a = await resolveIdentity(opts({ RIG_MNEMONIC: PHRASE_A }));
      const b = await resolveIdentity({
        ...opts({ RIG_MNEMONIC: PHRASE_A }),
        env: { TOON_CLIENT_HOME: otherHome, RIG_MNEMONIC: PHRASE_A },
      });
      expect(a.pubkey).toBe(PUBKEY_A);
      expect(b.pubkey).toBe(PUBKEY_A);
      expect(a.accountIndex).toBe(0);
      expect(b.accountIndex).toBe(0);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it('RIG_ACCOUNT_INDEX overrides the index for every source', async () => {
    writeClientConfig({ mnemonicAccountIndex: 1 });
    const fromEnv = await resolveIdentity(
      opts({ RIG_MNEMONIC: PHRASE_A, RIG_ACCOUNT_INDEX: '2' })
    );
    expect(fromEnv.accountIndex).toBe(2);
    expect(fromEnv.pubkey).toBe(deriveNostrKeyFromMnemonic(PHRASE_A, 2).pubkey);

    writeClientConfig({ mnemonic: PHRASE_A, mnemonicAccountIndex: 1 });
    const fromConfig = await resolveIdentity(opts({ RIG_ACCOUNT_INDEX: '2' }));
    expect(fromConfig.source).toBe('config');
    expect(fromConfig.accountIndex).toBe(2);
    expect(fromConfig.pubkey).toBe(deriveNostrKeyFromMnemonic(PHRASE_A, 2).pubkey);
  });

  it('rejects a malformed RIG_ACCOUNT_INDEX instead of deriving silently', async () => {
    await expect(
      resolveIdentity(opts({ RIG_MNEMONIC: PHRASE_A, RIG_ACCOUNT_INDEX: 'one' }))
    ).rejects.toThrow(/RIG_ACCOUNT_INDEX must be a non-negative integer/);
    await expect(
      resolveIdentity(opts({ RIG_MNEMONIC: PHRASE_A, RIG_ACCOUNT_INDEX: '-1' }))
    ).rejects.toThrow(/RIG_ACCOUNT_INDEX/);
  });

  it('throws MissingIdentityError listing all three options when nothing resolves', async () => {
    await expect(resolveIdentity(opts({}))).rejects.toThrow(MissingIdentityError);
    const err = await resolveIdentity(opts({})).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(MissingIdentityError);
    const message = (err as Error).message;
    expect(message).toContain('RIG_MNEMONIC environment variable');
    expect(message).toContain('.env');
    expect(message).toContain(join(homeDir, 'config.json'));
  });

  it('never exposes the phrase and never touches process.env', async () => {
    writeFileSync(
      join(dir, '.env'),
      `RIG_MNEMONIC=${PHRASE_A}\nEVIL_VAR=should-not-load\n`
    );
    const identity = await resolveIdentity(opts({}));
    expect(identity.pubkey).toBe(PUBKEY_A);
    expect(process.env['EVIL_VAR']).toBeUndefined();
    expect(process.env['RIG_MNEMONIC']).toBeUndefined();
    // The report surface (source/label/pubkey) never carries the phrase.
    expect(identity.sourceLabel).not.toContain('abandon');
    expect(identity.pubkey).not.toContain('abandon');
  });
});
