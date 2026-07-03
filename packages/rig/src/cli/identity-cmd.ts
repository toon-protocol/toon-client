/**
 * `rig identity` — the cold-start identity command group (#294).
 *
 * rig resolves a signing identity along a precedence chain (./identity.ts) but,
 * before this command, it never MINTED one: a brand-new user hit
 * {@link MissingIdentityError} and had to hand-mint a BIP-39 phrase out of band
 * before anything ran. `rig identity` closes that gap while keeping rig's
 * deliberate security invariants intact:
 *
 *   - `rig identity create` — generate a fresh BIP-39 mnemonic (via the
 *     client's existing generator — no hand-rolled bip39/crypto), display it
 *     ONCE with a prominent backup warning, and persist it to the ENCRYPTED
 *     keystore under `TOON_CLIENT_HOME` (reusing the client/daemon keystore
 *     write path + the auto-password convention). This is the ONLY command
 *     that ever surfaces a phrase, and `--json` is the ONE sanctioned path
 *     that emits the phrase in machine output (a scripting/agent need).
 *   - `rig identity show` — report the active identity's SOURCE + derived
 *     pubkey; NEVER the phrase, in any mode.
 *   - `rig identity import` — read an existing phrase from stdin/prompt (NEVER
 *     argv — that leaks to shell history / `ps`) and write it to the keystore.
 *
 * The phrase is written ONLY to the encrypted keystore (or shown once / emitted
 * in the sanctioned `create --json` envelope) — never to git config, never to a
 * repo file, never to plaintext outside the keystore. Persistence is gated on
 * the command being explicitly invoked (and refuses to clobber an existing
 * identity without `--force`).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { emitCliError } from './errors.js';
import {
  clientConfigPath,
  clientKeystorePath,
  DEFAULT_KEYSTORE_PASSWORD,
  linkKeystoreInClientConfig,
  MissingIdentityError,
  readClientConfigFile,
  resolveIdentity,
  type ResolvedIdentity,
} from './identity.js';
import type { CliIo } from './output.js';
import { renderIdentityLine } from './render.js';

// ---------------------------------------------------------------------------
// Deps + client-key seam
// ---------------------------------------------------------------------------

/** The `@toon-protocol/client` key operations `rig identity` reuses. */
export interface IdentityKeyOps {
  /** Generate a fresh mnemonic, encrypt it, and write the keystore to `path`. */
  generateKeystore(path: string, password: string): { mnemonic: string };
  /** Validate + encrypt an existing mnemonic and write the keystore to `path`. */
  importKeystore(path: string, mnemonic: string, password: string): unknown;
  /** Derive the Nostr pubkey (hex) for a mnemonic at a BIP-44 account index. */
  deriveNostrKeyFromMnemonic(
    mnemonic: string,
    accountIndex?: number
  ): { pubkey: string };
}

/** Default key-ops loader: the real client, dynamically imported (see below). */
async function loadKeyOps(): Promise<IdentityKeyOps> {
  return (await import('@toon-protocol/client')) as unknown as IdentityKeyOps;
}

/** Deps `rig identity` needs; the seams default to the real implementations. */
export interface IdentityDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Identity resolver seam (tests); defaults to the real chain. */
  resolveIdentityImpl?: typeof resolveIdentity;
  /** Client key-ops seam (tests); defaults to `@toon-protocol/client`. */
  loadKeyOps?: () => Promise<IdentityKeyOps>;
  /**
   * Read one line of secret input for `rig identity import` (tests). Defaults
   * to a stdin read (prompt on stderr when interactive). NEVER argv.
   */
  readSecretLine?: (prompt: string, isInteractive: boolean) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Refused: an identity already resolves and `--force` was not given. */
export class IdentityExistsError extends Error {
  constructor(
    public readonly pubkey: string,
    public readonly sourceLabel: string
  ) {
    super(
      `an identity already resolves (${pubkey}, from ${sourceLabel}) — rig ` +
        'will not overwrite it. Inspect it with `rig identity show`, or pass ' +
        '`--force` to replace the keystore with a brand-new identity (the old ' +
        'phrase becomes unrecoverable unless you backed it up).'
    );
    this.name = 'IdentityExistsError';
  }
}

/** Refused: a keystore file already sits at the target path (unlinked). */
export class KeystoreFileExistsError extends Error {
  constructor(public readonly keystorePath: string) {
    super(
      `a keystore file already exists at ${keystorePath} — rig will not ` +
        'overwrite it. Link it via the client config, or pass `--force` to ' +
        'replace it with a new identity.'
    );
    this.name = 'KeystoreFileExistsError';
  }
}

// ---------------------------------------------------------------------------
// Core: generate / import → encrypted keystore
// ---------------------------------------------------------------------------

/** A newly minted (or imported) identity — the phrase is present ONLY here. */
export interface CreatedIdentity {
  /** The BIP-39 phrase. Surfaced only by `create` (once / `--json`). */
  mnemonic: string;
  pubkey: string;
  keystorePath: string;
  configPath: string;
  /** True when rig chose the default keystore password (no user password). */
  autoPassword: boolean;
  accountIndex: number;
  /**
   * Set only when a HIGHER-precedence source (env / .env) still shadows the
   * new keystore identity — possible only under `--force`.
   */
  shadowedBy?: { sourceLabel: string; pubkey: string };
}

/** Inputs shared by `create` and `import` (IO-free core). */
export interface MintIdentityInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Overwrite an existing identity / keystore file. */
  force: boolean;
  /** Explicit `--password` (overrides `TOON_CLIENT_KEYSTORE_PASSWORD` + auto). */
  password?: string;
  warn(line: string): void;
  resolveIdentityImpl?: typeof resolveIdentity;
  loadKeyOps?: () => Promise<IdentityKeyOps>;
}

interface KeystoreTarget {
  keystorePath: string;
  password: string;
  autoPassword: boolean;
  /** An identity that already resolved (guards + shadow reporting). */
  existing?: ResolvedIdentity;
  keyOps: IdentityKeyOps;
}

/** Guard against clobbering, resolve the keystore path + password. */
async function prepareKeystoreTarget(
  input: MintIdentityInput
): Promise<KeystoreTarget> {
  const keyOps = await (input.loadKeyOps ?? loadKeyOps)();
  const resolveImpl = input.resolveIdentityImpl ?? resolveIdentity;

  let existing: ResolvedIdentity | undefined;
  try {
    existing = await resolveImpl({
      env: input.env,
      cwd: input.cwd,
      warn: input.warn,
    });
  } catch (err) {
    if (!(err instanceof MissingIdentityError)) throw err;
  }
  if (existing && !input.force) {
    throw new IdentityExistsError(existing.pubkey, existing.sourceLabel);
  }

  const keystorePath = clientKeystorePath(input.env);
  if (existsSync(keystorePath) && !input.force) {
    throw new KeystoreFileExistsError(keystorePath);
  }

  const envPassword = input.env['TOON_CLIENT_KEYSTORE_PASSWORD']?.trim() || undefined;
  const explicit = input.password ?? envPassword;
  const autoPassword = explicit === undefined;
  const password = explicit ?? DEFAULT_KEYSTORE_PASSWORD;

  mkdirSync(dirname(keystorePath), { recursive: true });
  return { keystorePath, password, autoPassword, existing, keyOps };
}

/** BIP-44 account index from the shared config (default 0), as resolve uses. */
function readAccountIndex(env: NodeJS.ProcessEnv): number {
  const file = readClientConfigFile(clientConfigPath(env));
  return typeof file.mnemonicAccountIndex === 'number'
    ? file.mnemonicAccountIndex
    : 0;
}

/** Assemble the {@link CreatedIdentity} once a phrase is on disk. */
function finishMint(
  input: MintIdentityInput,
  target: KeystoreTarget,
  mnemonic: string
): CreatedIdentity {
  const configPath = linkKeystoreInClientConfig(
    input.env,
    target.keystorePath,
    target.autoPassword
  );
  const accountIndex = readAccountIndex(input.env);
  const { pubkey } = target.keyOps.deriveNostrKeyFromMnemonic(
    mnemonic,
    accountIndex
  );
  const result: CreatedIdentity = {
    mnemonic,
    pubkey,
    keystorePath: target.keystorePath,
    configPath,
    autoPassword: target.autoPassword,
    accountIndex,
  };
  if (target.existing && target.existing.pubkey !== pubkey) {
    result.shadowedBy = {
      sourceLabel: target.existing.sourceLabel,
      pubkey: target.existing.pubkey,
    };
  }
  return result;
}

/** Generate a fresh identity into the encrypted keystore. */
export async function createIdentity(
  input: MintIdentityInput
): Promise<CreatedIdentity> {
  const target = await prepareKeystoreTarget(input);
  const { mnemonic } = target.keyOps.generateKeystore(
    target.keystorePath,
    target.password
  );
  return finishMint(input, target, mnemonic);
}

/** Import an existing phrase into the encrypted keystore (validated). */
export async function importIdentity(
  input: MintIdentityInput & { mnemonic: string }
): Promise<CreatedIdentity> {
  const target = await prepareKeystoreTarget(input);
  // importKeystore validates the BIP-39 phrase before writing anything.
  target.keyOps.importKeystore(
    target.keystorePath,
    input.mnemonic,
    target.password
  );
  return finishMint(input, target, input.mnemonic);
}

// ---------------------------------------------------------------------------
// Human display (the one-time backup banner)
// ---------------------------------------------------------------------------

/** The one-time seed-phrase backup banner (human, non-`--json`). */
export function createdIdentityBanner(result: CreatedIdentity): string[] {
  return [
    '',
    '════════════════════════════════════════════════════════════════',
    '  rig: generated a new identity',
    '════════════════════════════════════════════════════════════════',
    `  Nostr pubkey : ${result.pubkey}`,
    '',
    '  Seed phrase — this phrase CONTROLS YOUR FUNDS. Write it down and',
    '  store it safely. It is shown ONCE and CANNOT be recovered:',
    '',
    `    ${result.mnemonic}`,
    '',
    `  Encrypted keystore: ${result.keystorePath}`,
    result.autoPassword
      ? '  Encrypted with the default password, so the identity reloads with no\n' +
        '  env var. To use your own password: set TOON_CLIENT_KEYSTORE_PASSWORD\n' +
        '  and re-import with `rig identity import`.'
      : '  Encrypted with your TOON_CLIENT_KEYSTORE_PASSWORD / --password.',
    '════════════════════════════════════════════════════════════════',
    '',
  ];
}

/** The stderr note fired after a fresh mint, when a higher tier shadows it. */
export function shadowNote(shadowedBy: {
  sourceLabel: string;
  pubkey: string;
}): string {
  return (
    `note: a higher-precedence identity (${shadowedBy.pubkey}, from ` +
    `${shadowedBy.sourceLabel}) still shadows the new keystore — rig keeps ` +
    'using it until you remove that source (unset the env var / edit .env).'
  );
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export const IDENTITY_USAGE = `Usage: rig identity <command> [options]

Manage the BIP-39 signing identity rig uses to sign and pay:

  create   generate a fresh identity into the encrypted keystore under
           TOON_CLIENT_HOME. The seed phrase is shown ONCE — back it up.
           Refuses to overwrite an existing identity without --force.
  show     report the ACTIVE identity's source + derived pubkey (never the
           phrase); errors with the resolution remediation when none exists.
  import   read an EXISTING phrase from stdin (never a CLI argument) and write
           it to the encrypted keystore.

Options:
  --force              (create/import) replace an existing identity/keystore
  --password <pass>    encrypt with this password instead of the auto default
                       (else TOON_CLIENT_KEYSTORE_PASSWORD, else a default so
                       the identity reloads with no env var)
  --json               machine-readable output. NOTE: \`identity create --json\`
                       DELIBERATELY emits the seed phrase in a \`mnemonic\`
                       field — treat that output as SECRET. \`identity show\`
                       and \`identity import\` never emit the phrase.
  -h, --help           show this help`;

/** Route `rig identity <sub>`; returns the process exit code. */
export async function runIdentity(
  args: string[],
  deps: IdentityDeps
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'create':
      return runIdentityCreate(rest, deps);
    case 'show':
      return runIdentityShow(rest, deps);
    case 'import':
      return runIdentityImport(rest, deps);
    case 'help':
    case '--help':
    case '-h':
      deps.io.out(IDENTITY_USAGE);
      return 0;
    case undefined:
      deps.io.err('rig identity needs a subcommand: create | show | import');
      deps.io.err(IDENTITY_USAGE);
      return 2;
    default:
      deps.io.err(`unknown rig identity subcommand: ${sub}`);
      deps.io.err(IDENTITY_USAGE);
      return 2;
  }
}

interface MintFlags {
  force: boolean;
  password?: string;
  json: boolean;
  help: boolean;
}

function parseMintArgs(args: string[], verb: string): MintFlags {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      password: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (positionals.length > 0) {
    throw new Error(`rig identity ${verb} takes no positional arguments`);
  }
  const flags: MintFlags = {
    force: values.force ?? false,
    json: values.json ?? false,
    help: values.help ?? false,
  };
  const password = values.password;
  if (password !== undefined) {
    if (password === '') throw new Error('--password must not be empty');
    flags.password = password;
  }
  return flags;
}

async function runIdentityCreate(
  args: string[],
  deps: IdentityDeps
): Promise<number> {
  const { io } = deps;
  let flags: MintFlags;
  try {
    flags = parseMintArgs(args, 'create');
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(IDENTITY_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(IDENTITY_USAGE);
    return 0;
  }

  try {
    const result = await createIdentity({
      env: deps.env,
      cwd: deps.cwd,
      force: flags.force,
      ...(flags.password !== undefined ? { password: flags.password } : {}),
      warn: (line) => io.err(line),
      ...(deps.resolveIdentityImpl
        ? { resolveIdentityImpl: deps.resolveIdentityImpl }
        : {}),
      ...(deps.loadKeyOps ? { loadKeyOps: deps.loadKeyOps } : {}),
    });
    emitCreated(io, flags.json, 'identity create', result);
    return 0;
  } catch (err) {
    return emitMintError(io, flags.json, 'identity create', err);
  }
}

async function runIdentityImport(
  args: string[],
  deps: IdentityDeps
): Promise<number> {
  const { io } = deps;
  let flags: MintFlags;
  try {
    flags = parseMintArgs(args, 'import');
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(IDENTITY_USAGE);
    return 2;
  }
  if (flags.help) {
    io.out(IDENTITY_USAGE);
    return 0;
  }

  try {
    const read = deps.readSecretLine ?? defaultReadSecretLine;
    const phrase = (
      await read(
        'Paste your BIP-39 seed phrase (read from stdin, not the terminal ' +
          'history): ',
        io.isInteractive
      )
    ).trim();
    if (phrase === '') {
      throw new Error(
        'no seed phrase provided on stdin — pipe it in or type it at the ' +
          'prompt (never pass a phrase as a CLI argument; it leaks to shell ' +
          'history and `ps`).'
      );
    }
    const result = await importIdentity({
      env: deps.env,
      cwd: deps.cwd,
      force: flags.force,
      mnemonic: phrase,
      ...(flags.password !== undefined ? { password: flags.password } : {}),
      warn: (line) => io.err(line),
      ...(deps.resolveIdentityImpl
        ? { resolveIdentityImpl: deps.resolveIdentityImpl }
        : {}),
      ...(deps.loadKeyOps ? { loadKeyOps: deps.loadKeyOps } : {}),
    });
    // Import NEVER echoes the phrase back (unlike create) — only the pubkey.
    if (flags.json) {
      io.emitJson({
        command: 'identity import',
        imported: true,
        pubkey: result.pubkey,
        keystorePath: result.keystorePath,
        autoPassword: result.autoPassword,
        ...(result.shadowedBy ? { shadowedBy: result.shadowedBy } : {}),
      });
    } else {
      io.out(`Imported identity ${result.pubkey}`);
      io.out(`  Encrypted keystore: ${result.keystorePath}`);
    }
    if (result.shadowedBy) io.err(shadowNote(result.shadowedBy));
    return 0;
  } catch (err) {
    return emitMintError(io, flags.json, 'identity import', err);
  }
}

async function runIdentityShow(
  args: string[],
  deps: IdentityDeps
): Promise<number> {
  const { io } = deps;
  let json = false;
  let help = false;
  try {
    const parsed = parseArgs({
      args,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
    json = parsed.values.json ?? false;
    help = parsed.values.help ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(IDENTITY_USAGE);
    return 2;
  }
  if (help) {
    io.out(IDENTITY_USAGE);
    return 0;
  }

  try {
    const identity = await (deps.resolveIdentityImpl ?? resolveIdentity)({
      env: deps.env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
    });
    // NEVER the phrase — source + derived pubkey only.
    if (json) {
      io.emitJson({
        command: 'identity show',
        source: identity.source,
        sourceLabel: identity.sourceLabel,
        pubkey: identity.pubkey,
        accountIndex: identity.accountIndex,
      });
    } else {
      io.out(renderIdentityLine(identity));
      io.out(`  source : ${identity.source} (${identity.sourceLabel})`);
      io.out(`  pubkey : ${identity.pubkey}`);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'identity show', err);
  }
}

// ---------------------------------------------------------------------------
// Shared emitters
// ---------------------------------------------------------------------------

/**
 * Emit a freshly created identity. `--json` is the ONE sanctioned path that
 * carries the phrase (the `mnemonic` field) — a scripting/agent need — as the
 * single stdout document; human mode prints the one-time backup banner.
 */
export function emitCreated(
  io: CliIo,
  json: boolean,
  command: string,
  result: CreatedIdentity
): void {
  if (json) {
    io.emitJson({
      command,
      created: true,
      pubkey: result.pubkey,
      keystorePath: result.keystorePath,
      autoPassword: result.autoPassword,
      // DELIBERATE, documented exception to "never print the phrase": the
      // scripting/agent path needs the generated phrase to back it up.
      mnemonic: result.mnemonic,
      ...(result.shadowedBy ? { shadowedBy: result.shadowedBy } : {}),
    });
    io.err(
      'rig: `--json` emitted your seed phrase in the `mnemonic` field — this ' +
        'output is SECRET; store it safely and do not log or share it.'
    );
  } else {
    for (const line of createdIdentityBanner(result)) io.out(line);
  }
  if (result.shadowedBy) io.err(shadowNote(result.shadowedBy));
}

/** Map the mint-path errors to output; refusals get their own stable codes. */
function emitMintError(
  io: CliIo,
  json: boolean,
  command: string,
  err: unknown
): 1 {
  if (err instanceof IdentityExistsError) {
    if (json) {
      io.emitJson({
        command,
        error: 'identity_exists',
        pubkey: err.pubkey,
        detail: err.message,
      });
    }
    for (const line of err.message.split('\n')) io.err(line);
    return 1;
  }
  if (err instanceof KeystoreFileExistsError) {
    if (json) {
      io.emitJson({
        command,
        error: 'keystore_exists',
        keystorePath: err.keystorePath,
        detail: err.message,
      });
    }
    for (const line of err.message.split('\n')) io.err(line);
    return 1;
  }
  return emitCliError(io, json, command, err);
}

/** Default secret reader: one line from stdin, prompt on stderr when a TTY. */
async function defaultReadSecretLine(
  prompt: string,
  isInteractive: boolean
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(isInteractive ? prompt : '');
  } finally {
    rl.close();
  }
}
