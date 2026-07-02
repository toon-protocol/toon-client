/**
 * Identity resolution for the standalone-only `rig` CLI (#248).
 *
 * One precedence chain, used by every command that signs or pays:
 *
 *   1. `RIG_MNEMONIC` environment variable
 *   2. `TOON_CLIENT_MNEMONIC` environment variable — DEPRECATED alias of the
 *      env tier (a one-line stderr warning fires when it is the source)
 *   3. project-local `.env` — walked up from the working directory (through
 *      the repo root to the filesystem root); ONLY the `RIG_MNEMONIC` line is
 *      parsed out of it (never loaded into the process env, never required
 *      to exist)
 *   4. the shared `~/.toon-client` state dir (`TOON_CLIENT_HOME` override):
 *      encrypted keystore (`keystorePath` + `TOON_CLIENT_KEYSTORE_PASSWORD`,
 *      auto-password fallback for daemon-provisioned keystores), then the
 *      plain `mnemonic` config field — the pre-#248 standalone-context logic
 *
 * The BIP-44 `mnemonicAccountIndex` from the shared config file applies to
 * every source (same convention as the daemon), so the derived pubkey never
 * depends on WHERE the phrase came from.
 *
 * The phrase itself is never written anywhere by rig (not to git config, not
 * to any repo file) and never printed — callers report only the SOURCE and
 * the derived pubkey.
 *
 * Key derivation and keystore decryption live in the OPTIONAL
 * `@toon-protocol/client` peer dependency, loaded via dynamic import so this
 * module can be statically imported by every command without dragging the
 * client into runs that fail earlier (usage errors, missing git repo, …).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where the mnemonic came from (reported in output; the phrase never is). */
export type IdentitySourceKind =
  /** `RIG_MNEMONIC` environment variable. */
  | 'env'
  /** `TOON_CLIENT_MNEMONIC` environment variable (deprecated alias). */
  | 'env-alias'
  /** `RIG_MNEMONIC` parsed out of a project-local `.env` file. */
  | 'dotenv'
  /** Encrypted keystore referenced by the shared client config. */
  | 'keystore'
  /** Plain `mnemonic` field of the shared client config file. */
  | 'config';

/** A resolved signing identity: source + derived pubkey (never the phrase). */
export interface ResolvedIdentity {
  /** The BIP-39 phrase. Handle with care; never log or persist it. */
  mnemonic: string;
  /** BIP-44 account index used for derivation (shared config, default 0). */
  accountIndex: number;
  source: IdentitySourceKind;
  /** Human-facing source label, e.g. `RIG_MNEMONIC env` or a file path. */
  sourceLabel: string;
  /** Derived Nostr pubkey (hex) — the repo owner / `toon.owner` value. */
  pubkey: string;
}

/** No mnemonic could be resolved anywhere on the chain. */
export class MissingIdentityError extends Error {
  constructor(configPath: string) {
    super(
      'no identity found — rig needs a BIP-39 seed phrase to sign and pay. ' +
        'Provide one of (highest precedence first):\n' +
        '  • RIG_MNEMONIC environment variable\n' +
        '  • RIG_MNEMONIC=<phrase> in a project-local .env file (gitignore it!)\n' +
        `  • the shared client config at ${configPath} (mnemonic or ` +
        'keystorePath + TOON_CLIENT_KEYSTORE_PASSWORD)'
    );
    this.name = 'MissingIdentityError';
  }
}

// ---------------------------------------------------------------------------
// Shared client config conventions (duplicated from client-mcp — the same
// note as standalone/nonce-guard.ts: no @toon-protocol/client-mcp import)
// ---------------------------------------------------------------------------

/** Duplicated daemon convention: auto-keystore password. */
const DEFAULT_KEYSTORE_PASSWORD = 'toon-client-default';

/** Shared client state dir: `TOON_CLIENT_HOME`, else `~/.toon-client`. */
export function clientConfigPath(env: NodeJS.ProcessEnv): string {
  const dir = env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
  return join(dir, 'config.json');
}

/** The subset of the shared client config file identity resolution reads. */
interface ClientConfigIdentityFields {
  mnemonic?: unknown;
  mnemonicAccountIndex?: unknown;
  keystorePath?: unknown;
  keystoreAutoPassword?: unknown;
}

function readClientConfigFile(path: string): ClientConfigIdentityFields {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClientConfigIdentityFields;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(
      `failed to read client config at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// .env parsing (RIG_MNEMONIC only — never arbitrary env loading)
// ---------------------------------------------------------------------------

const DOTENV_LINE_RE = /^\s*(?:export\s+)?RIG_MNEMONIC\s*=\s*(.*)\s*$/;

/**
 * Extract ONLY the `RIG_MNEMONIC` value from `.env` file content. Supports
 * `export ` prefixes, single/double quotes, full-line `#` comments, and
 * inline ` #` comments on unquoted values. Multiple assignments: the last
 * one wins (shell-sourcing semantics). An empty value counts as unset.
 * Nothing is ever loaded into `process.env`.
 */
export function parseDotenvMnemonic(content: string): string | undefined {
  let found: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const match = DOTENV_LINE_RE.exec(line);
    if (!match) continue;
    let value = (match[1] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment starts at the first whitespace-preceded #.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    if (value !== '') found = value;
  }
  return found;
}

/**
 * Walk up from `startDir` (the working directory — the walk passes through
 * the repo root) to the filesystem root, returning the first `.env` file
 * that defines `RIG_MNEMONIC`. `stopDir` bounds the walk (tests).
 */
export function findDotenvMnemonic(
  startDir: string,
  stopDir?: string
): { path: string; mnemonic: string } | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        const mnemonic = parseDotenvMnemonic(readFileSync(candidate, 'utf8'));
        if (mnemonic !== undefined) return { path: candidate, mnemonic };
      } catch {
        // Unreadable .env → keep walking; the file is never required.
      }
    }
    if (stopDir !== undefined && dir === stopDir) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveIdentityOptions {
  env: NodeJS.ProcessEnv;
  /** Working directory the `.env` walk starts from. */
  cwd: string;
  /** Stderr line sink for the deprecated-alias warning. */
  warn(line: string): void;
  /** Bound the `.env` walk-up (tests only). */
  dotenvStopDir?: string;
}

/** The resolved source before any derivation (dependency-free). */
interface MnemonicSource {
  mnemonic: string;
  source: IdentitySourceKind;
  sourceLabel: string;
}

function resolveMnemonicSource(
  options: ResolveIdentityOptions,
  file: ClientConfigIdentityFields,
  configPath: string
): MnemonicSource | { keystorePath: string } {
  const { env } = options;

  const rigEnv = env['RIG_MNEMONIC']?.trim();
  if (rigEnv) {
    return { mnemonic: rigEnv, source: 'env', sourceLabel: 'RIG_MNEMONIC env' };
  }

  const aliasEnv = env['TOON_CLIENT_MNEMONIC']?.trim();
  if (aliasEnv) {
    options.warn(
      'rig: TOON_CLIENT_MNEMONIC is deprecated — rename the variable to RIG_MNEMONIC'
    );
    return {
      mnemonic: aliasEnv,
      source: 'env-alias',
      sourceLabel: 'TOON_CLIENT_MNEMONIC env (deprecated alias)',
    };
  }

  const dotenv = findDotenvMnemonic(options.cwd, options.dotenvStopDir);
  if (dotenv) {
    return {
      mnemonic: dotenv.mnemonic,
      source: 'dotenv',
      sourceLabel: dotenv.path,
    };
  }

  if (typeof file.keystorePath === 'string' && file.keystorePath !== '') {
    return { keystorePath: file.keystorePath };
  }
  if (typeof file.mnemonic === 'string' && file.mnemonic.trim() !== '') {
    return {
      mnemonic: file.mnemonic.trim(),
      source: 'config',
      sourceLabel: configPath,
    };
  }
  throw new MissingIdentityError(configPath);
}

/** Load the optional client peer dependency, with a clear error when absent. */
async function loadClientKeys(): Promise<{
  loadKeystore(path: string, password: string): string;
  deriveNostrKeyFromMnemonic(
    mnemonic: string,
    accountIndex?: number
  ): { secretKey: Uint8Array; pubkey: string };
}> {
  try {
    return await import('@toon-protocol/client');
  } catch (err) {
    throw new Error(
      'identity derivation needs the optional peer dependency ' +
        '@toon-protocol/client — install it (`npm i @toon-protocol/client`) ' +
        `and re-run (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Resolve the CLI signing identity along the precedence chain and derive its
 * Nostr pubkey. Throws {@link MissingIdentityError} (with the full
 * three-option remediation) when nothing on the chain yields a phrase.
 */
export async function resolveIdentity(
  options: ResolveIdentityOptions
): Promise<ResolvedIdentity> {
  const configPath = clientConfigPath(options.env);
  const file = readClientConfigFile(configPath);
  const picked = resolveMnemonicSource(options, file, configPath);

  const keys = await loadClientKeys();
  let source: MnemonicSource;
  if ('keystorePath' in picked) {
    const password =
      options.env['TOON_CLIENT_KEYSTORE_PASSWORD'] ??
      (file.keystoreAutoPassword === true ? DEFAULT_KEYSTORE_PASSWORD : undefined);
    if (!password) {
      throw new Error(
        `keystorePath is set in ${configPath} but TOON_CLIENT_KEYSTORE_PASSWORD is not provided`
      );
    }
    source = {
      mnemonic: keys.loadKeystore(picked.keystorePath, password),
      source: 'keystore',
      sourceLabel: picked.keystorePath,
    };
  } else {
    source = picked;
  }

  const accountIndex =
    typeof file.mnemonicAccountIndex === 'number' ? file.mnemonicAccountIndex : 0;
  const { pubkey } = keys.deriveNostrKeyFromMnemonic(source.mnemonic, accountIndex);
  return { ...source, accountIndex, pubkey };
}
