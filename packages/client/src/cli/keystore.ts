/**
 * Where the keys are, and how the password to open them is obtained.
 *
 * The keystore itself — scrypt, AES-256-GCM, the `version`/`derivation` fields
 * and the rule that a pre-1.0 file is read as `legacy` — belongs to
 * {@link ../keys/keystore-node.js}. This module is only the CLI's half: which
 * file, whose password, and what to say when neither can be worked out.
 *
 * ## The order a password is looked for, and why it is this order
 *
 * 1. `--password-file` — an explicit instruction, so it wins. A user who names
 *    a file and is then prompted anyway has been ignored.
 * 2. `TOON_KEYSTORE_PASSWORD` — how CI supplies it. Deliberately ahead of the
 *    prompt so a scripted run never blocks on a terminal that will never answer.
 * 3. A hidden prompt, when stdin is a TTY.
 * 4. Otherwise a clear error naming both non-interactive options. A CLI that
 *    hangs forever on a pipe waiting for a password nobody can type is the
 *    failure this ordering exists to prevent.
 *
 * There is no `--password`. A flag value lands in shell history and is visible
 * in `ps` to every user on the machine — the same reason there is no
 * `--mnemonic`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openKeystore, type OpenedKeystore } from '../keys/keystore-node.js';
import { CliConfigError } from './args.js';

/** The environment, as a plain map — injected so resolution is testable. */
export type Env = Record<string, string | undefined>;

/** Environment variable names this CLI reads for keys. */
export const KEYSTORE_ENV = 'TOON_KEYSTORE';
export const KEYSTORE_PASSWORD_ENV = 'TOON_KEYSTORE_PASSWORD';
export const MNEMONIC_ENV = 'TOON_MNEMONIC';

/** `~/.toon/keystore.json`. */
export function defaultKeystorePath(home: string = homedir()): string {
  return join(home, '.toon', 'keystore.json');
}

/** Flag, then `TOON_KEYSTORE`, then the default path. */
export function resolveKeystorePath(options: {
  flag?: string | undefined;
  env?: Env;
  home?: string;
}): string {
  const flag = options.flag;
  if (flag !== undefined && flag.length > 0) return flag;
  const fromEnv = options.env?.[KEYSTORE_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return defaultKeystorePath(options.home ?? homedir());
}

/** How a password was obtained. Reported so a confusing run can be explained. */
export type PasswordSource = 'password-file' | 'env' | 'prompt';

export interface PasswordOptions {
  /** What the prompt says, e.g. `'Keystore password: '`. */
  message: string;
  /** The `--password-file` value, when one was given. */
  passwordFile?: string | undefined;
  env?: Env;
  /** Injected file reader, for tests. */
  readFile?: (path: string) => string;
  /**
   * The hidden prompt, or `undefined` when stdin is not a terminal. Injected
   * rather than detected here so the resolution order can be tested without a
   * TTY.
   */
  prompt?: ((message: string) => Promise<string>) | undefined;
}

/**
 * Resolve the keystore password. See this module's own docs for the order.
 *
 * A password file's content is trimmed of one trailing newline and nothing
 * else: `echo secret > pw.txt` is the way people make these files, and a
 * password of `"secret\n"` would then be a password nobody can retype.
 */
export async function resolvePassword(
  options: PasswordOptions
): Promise<{ password: string; source: PasswordSource }> {
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  if (options.passwordFile !== undefined && options.passwordFile.length > 0) {
    let contents: string;
    try {
      contents = read(options.passwordFile);
    } catch (err) {
      throw new CliConfigError(
        `cannot read the password file ${options.passwordFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const password = contents.replace(/\r?\n$/, '');
    if (password.length === 0) {
      throw new CliConfigError(`the password file ${options.passwordFile} is empty`);
    }
    return { password, source: 'password-file' };
  }

  const fromEnv = options.env?.[KEYSTORE_PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { password: fromEnv, source: 'env' };
  }

  if (options.prompt !== undefined) {
    const password = await options.prompt(options.message);
    if (password.length === 0) throw new CliConfigError('no password was entered');
    return { password, source: 'prompt' };
  }

  throw new CliConfigError(
    'a keystore password is needed and stdin is not a terminal to ask on',
    `Set ${KEYSTORE_PASSWORD_ENV}, or pass --password-file <path>.`
  );
}

/**
 * Open the keystore at `path`.
 *
 * Distinguishes "there is no keystore" from "that password is wrong", because
 * the two have completely different remedies and the underlying decrypt reports
 * the second one only.
 */
export function readKeystore(path: string, password: string): OpenedKeystore {
  if (!existsSync(path)) {
    throw new CliConfigError(`no keystore at ${path}`, "Run 'toon init' to create one.");
  }
  try {
    return openKeystore(path, password);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliConfigError(`could not open the keystore at ${path}: ${message}`);
  }
}

/** Create the directory a keystore is about to be written into, if needed. */
export function ensureKeystoreDirectory(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

/** Does a keystore already exist here? Used by `init` to refuse to overwrite one. */
export function keystoreExists(path: string): boolean {
  return existsSync(path);
}
