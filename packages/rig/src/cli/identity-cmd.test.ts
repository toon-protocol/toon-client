/**
 * `rig identity` tests (#294): the cold-start generate/show/import flows
 * against the REAL `@toon-protocol/client` generator + keystore (a temp
 * TOON_CLIENT_HOME), matching the standalone init/identity test style.
 *
 *   - create → encrypted-keystore write → a second `show` re-resolves it via
 *     the keystore tier with the SAME derived pubkey (the round-trip);
 *   - create refuses an existing identity (and --force replaces it);
 *   - the --json contract: `create --json` emits the phrase in `mnemonic`
 *     (the ONE sanctioned exception), `show --json` never does;
 *   - import reads the phrase from the stdin seam (never argv) and never
 *     echoes it back;
 *   - the keystore-file-exists clobber guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveNostrKeyFromMnemonic } from '@toon-protocol/client';
import { runIdentity, type IdentityDeps } from './identity-cmd.js';
import type { CliIo } from './output.js';

const PHRASE_B =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PUBKEY_B = deriveNostrKeyFromMnemonic(PHRASE_B).pubkey;

let homeDir: string;
let cwd: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'toon-rig-idcmd-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'toon-rig-idcmd-cwd-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

interface Harness {
  deps: IdentityDeps;
  out: string[];
  err: string[];
}

function makeDeps(
  env: Record<string, string> = {},
  overrides: Partial<IdentityDeps> = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
    isInteractive: false,
    confirm: async () => false,
  };
  return {
    out,
    err,
    deps: {
      io,
      env: { TOON_CLIENT_HOME: homeDir, ...env },
      cwd,
      ...overrides,
    },
  };
}

function keystorePath(): string {
  return join(homeDir, 'keystore.json');
}

function lastJson(out: string[]): Record<string, unknown> {
  return JSON.parse(out[out.length - 1] as string) as Record<string, unknown>;
}

describe('rig identity create', () => {
  it('generates a keystore and a second `show` re-resolves the same pubkey', async () => {
    const create = makeDeps();
    expect(await runIdentity(['create'], create.deps)).toBe(0);

    // The keystore is on disk and config points at it.
    expect(existsSync(keystorePath())).toBe(true);
    const config = JSON.parse(readFileSync(join(homeDir, 'config.json'), 'utf8'));
    expect(config.keystorePath).toBe(keystorePath());
    expect(config.keystoreAutoPassword).toBe(true);

    // The phrase was shown once (human banner) with the backup warning.
    const banner = create.out.join('\n');
    expect(banner).toContain('shown ONCE');
    const pubkeyLine = banner.match(/Nostr pubkey : ([0-9a-f]{64})/);
    const createdPubkey = pubkeyLine?.[1];
    expect(createdPubkey).toMatch(/^[0-9a-f]{64}$/);

    // The round-trip: a fresh `show` resolves via the keystore tier.
    const show = makeDeps();
    expect(await runIdentity(['show'], show.deps)).toBe(0);
    const shownText = show.out.join('\n');
    expect(shownText).toContain(`pubkey : ${createdPubkey}`);
    expect(shownText).toContain('source : keystore');
    // The phrase itself never reappears.
    expect(shownText).not.toContain('CONTROLS YOUR FUNDS');
  });

  it('refuses when an identity already resolves; --force replaces it', async () => {
    // Seed an env identity → create must refuse (exit 1, keystore untouched).
    const refuse = makeDeps({ RIG_MNEMONIC: PHRASE_B });
    expect(await runIdentity(['create'], refuse.deps)).toBe(1);
    expect(refuse.err.join('\n')).toContain('already resolves');
    expect(refuse.err.join('\n')).toContain(PUBKEY_B);
    expect(existsSync(keystorePath())).toBe(false);

    // --force writes a keystore, but env still shadows → a shadow note fires.
    const force = makeDeps({ RIG_MNEMONIC: PHRASE_B });
    expect(await runIdentity(['create', '--force'], force.deps)).toBe(0);
    expect(existsSync(keystorePath())).toBe(true);
    expect(force.err.join('\n')).toContain('shadows the new keystore');
  });

  it('refuses to clobber an existing keystore file (no --force)', async () => {
    const first = makeDeps();
    expect(await runIdentity(['create'], first.deps)).toBe(0);
    const firstKeystore = readFileSync(keystorePath(), 'utf8');

    // Delete the config link but leave the keystore file: create must refuse.
    rmSync(join(homeDir, 'config.json'));
    const second = makeDeps();
    expect(await runIdentity(['create'], second.deps)).toBe(1);
    expect(second.err.join('\n')).toContain('keystore file already exists');
    // The keystore bytes are untouched.
    expect(readFileSync(keystorePath(), 'utf8')).toBe(firstKeystore);
  });

  it('--json emits the seed phrase in `mnemonic` (the sanctioned exception)', async () => {
    const h = makeDeps();
    expect(await runIdentity(['create', '--json'], h.deps)).toBe(0);
    const doc = lastJson(h.out);
    expect(doc).toMatchObject({ command: 'identity create', created: true });
    expect(typeof doc['mnemonic']).toBe('string');
    expect((doc['mnemonic'] as string).split(' ').length).toBe(12);
    expect(doc['pubkey']).toMatch(/^[0-9a-f]{64}$/);
    expect(doc['keystorePath']).toBe(keystorePath());
    // The SECRET warning goes to stderr, not the machine stream.
    expect(h.err.join('\n')).toContain('SECRET');
  });

  it('honors --password (keystoreAutoPassword=false, no env-var reload)', async () => {
    const h = makeDeps({}, {});
    expect(await runIdentity(['create', '--password', 'hunter2'], h.deps)).toBe(0);
    const config = JSON.parse(readFileSync(join(homeDir, 'config.json'), 'utf8'));
    expect(config.keystoreAutoPassword).toBe(false);
    // Without the password env var a later resolve refuses (correct posture).
    const show = makeDeps();
    expect(await runIdentity(['show'], show.deps)).toBe(1);
    expect(show.err.join('\n')).toContain('TOON_CLIENT_KEYSTORE_PASSWORD');
    // With it, resolution succeeds.
    const withPw = makeDeps({ TOON_CLIENT_KEYSTORE_PASSWORD: 'hunter2' });
    expect(await runIdentity(['show'], withPw.deps)).toBe(0);
  });
});

describe('rig identity show', () => {
  it('errors with the resolution remediation when no identity exists', async () => {
    const h = makeDeps();
    expect(await runIdentity(['show'], h.deps)).toBe(1);
    const text = h.err.join('\n');
    expect(text).toContain('no identity found');
    expect(text).toContain('rig identity create');
  });

  it('--json reports source + pubkey and NEVER the phrase', async () => {
    const h = makeDeps({ RIG_MNEMONIC: PHRASE_B });
    expect(await runIdentity(['show', '--json'], h.deps)).toBe(0);
    const doc = lastJson(h.out);
    expect(doc).toMatchObject({
      command: 'identity show',
      source: 'env',
      pubkey: PUBKEY_B,
    });
    expect(doc['mnemonic']).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('legal winner');
  });
});

describe('rig identity import', () => {
  it('reads the phrase from the stdin seam and writes the keystore', async () => {
    const h = makeDeps(
      {},
      { readSecretLine: async () => `  ${PHRASE_B}  ` }
    );
    expect(await runIdentity(['import'], h.deps)).toBe(0);
    expect(existsSync(keystorePath())).toBe(true);
    // The pubkey is reported; the phrase is NEVER echoed back.
    expect(h.out.join('\n')).toContain(`Imported identity ${PUBKEY_B}`);
    expect(h.out.join('\n')).not.toContain('legal winner');

    // Round-trips: a fresh show resolves the imported keystore.
    const show = makeDeps();
    expect(await runIdentity(['show'], show.deps)).toBe(0);
    expect(show.out.join('\n')).toContain(`pubkey : ${PUBKEY_B}`);
  });

  it('errors when stdin yields no phrase', async () => {
    const h = makeDeps({}, { readSecretLine: async () => '   ' });
    expect(await runIdentity(['import'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('no seed phrase provided');
  });

  it('rejects an invalid BIP-39 phrase (client validation)', async () => {
    const h = makeDeps(
      {},
      { readSecretLine: async () => 'not a real mnemonic at all please' }
    );
    expect(await runIdentity(['import'], h.deps)).toBe(1);
    expect(existsSync(keystorePath())).toBe(false);
  });
});

describe('rig identity dispatch', () => {
  it('--help prints usage (exit 0); no subcommand errors (exit 2)', async () => {
    const help = makeDeps();
    expect(await runIdentity(['--help'], help.deps)).toBe(0);
    expect(help.out.join('\n')).toContain('rig identity <command>');

    const none = makeDeps();
    expect(await runIdentity([], none.deps)).toBe(2);
    expect(none.err.join('\n')).toContain('needs a subcommand');

    const bad = makeDeps();
    expect(await runIdentity(['frobnicate'], bad.deps)).toBe(2);
    expect(bad.err.join('\n')).toContain('unknown rig identity subcommand');
  });
});
