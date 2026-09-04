#!/usr/bin/env node
/**
 * The `toon` command.
 *
 * Dispatch, and the translation of everything that can go wrong into an exit
 * code a script can branch on:
 *
 * | code | meaning |
 * |------|---------|
 * | 0 | it worked — including a FULFILL whose app answered `404` |
 * | 1 | an unexpected error; this is the bug bucket |
 * | 2 | usage or configuration: something you typed or did not set |
 * | 3 | the packet was **refused** — a normal outcome, printed in full |
 * | 4 | funding or channel: no channel, no collateral, no gas |
 * | 5 | the connector or a chain RPC could not be reached |
 * | 6 | payment or a particular carriage is required |
 *
 * The mapping reads each error's `code` string rather than testing `instanceof`,
 * and that is deliberate: the error taxonomy lives in `client/errors.ts` and
 * grows there, so a CLI that imported every class by name would have to be
 * edited every time one was added — and would fail to *compile* against a build
 * that had not added it yet. Matching on the documented code string means a new
 * error lands with the right exit code the moment it carries the right code, and
 * an unrecognised one falls into 1, which is exactly what "unexpected" means.
 */
import { homedir } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CliConfigError,
  UsageError,
  boolOption,
  parseCommandLine,
  usage,
} from './args.js';
import { Context, resolveSettings, type CliDependencies } from './context.js';
import { Output, type Writer } from './output.js';
import { RUNNERS } from './commands/index.js';
import { isInteractive, promptHidden, readStdin } from './stdin.js';

/** Exit codes, named. */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  refused: 3,
  funding: 4,
  network: 5,
  paymentRequired: 6,
} as const;

/** Error `code` strings that mean "you typed or configured something wrong". */
const USAGE_CODES = new Set([
  'USAGE',
  'CONFIG',
  'VALIDATION_ERROR',
  'UNKNOWN_CHAIN',
  'INVALID_ADDRESS',
  'INVALID_DESTINATION',
  'CHAIN_UNAVAILABLE',
  'ROUTE_NOT_PRICED',
  'TRANSFER_UNSUPPORTED',
]);

/** …"there is no channel, or nothing in it". */
const FUNDING_CODES = new Set([
  'CHANNEL_FUNDING',
  'CHANNEL_RESUME',
  'CHANNEL_NOT_OPEN',
  'INSUFFICIENT_BALANCE',
  'TRANSFER_NOT_DELIVERED',
]);

/** …"the far end could not be reached, or would not answer sensibly". */
const NETWORK_CODES = new Set(['NETWORK_ERROR', 'CONNECTOR_ERROR', 'STALE_RPC_READ']);

/** …"pay, or come back over the other carriage". */
const PAYMENT_CODES = new Set([
  'PAYMENT_REQUIRED',
  'TRANSPORT_REQUIRED',
  'HTTP_402_REQUIRES_BTP',
  'HTTP_401_REQUIRES_BTP',
]);

/** Socket-level failures, which arrive as a `cause` rather than as a `code`. */
const SYSCALL_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** The `code` an error carries, if it carries a string one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Is this a socket failure in disguise?
 *
 * `fetch` reports a refused connection as a bare `TypeError: fetch failed` whose
 * real cause is nested one or two levels down, so the chain is walked rather
 * than the top-level error inspected. Getting this right is what separates
 * "your connector is not running" (5) from "this is a bug" (1).
 */
function isTransportFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const code = errorCode(current);
    if (code !== undefined && SYSCALL_CODES.has(code)) return true;
    if (current instanceof TypeError && /fetch failed|network|socket/i.test(current.message)) {
      return true;
    }
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Which exit code an error deserves. See this module's own table. */
export function exitCodeFor(error: unknown): number {
  const code = errorCode(error);
  if (code !== undefined) {
    if (USAGE_CODES.has(code)) return EXIT.usage;
    if (FUNDING_CODES.has(code)) return EXIT.funding;
    if (NETWORK_CODES.has(code)) return EXIT.network;
    if (PAYMENT_CODES.has(code)) return EXIT.paymentRequired;
    // The connector-edge taxonomy names one cause per code; every one of them
    // is "the connector answered something unusable", which is a network-side
    // problem from here.
    if (code.endsWith('_HTTP_STATUS') || code.endsWith('_MALFORMED')) return EXIT.network;
  }
  if (isTransportFailure(error)) return EXIT.network;
  return EXIT.unexpected;
}

/**
 * Print an error the way a person can act on, and return its exit code.
 *
 * Always writes, `--quiet` notwithstanding: quiet suppresses progress, not the
 * reason a command produced nothing.
 */
export function reportError(error: unknown, stderr: Writer): number {
  if (error instanceof UsageError) {
    stderr(`toon: ${error.message}`);
    stderr('');
    stderr(usage(error.command));
    return EXIT.usage;
  }
  if (error instanceof CliConfigError) {
    stderr(`toon: ${error.message}`);
    if (error.hint !== undefined) stderr(`      ${error.hint}`);
    return EXIT.usage;
  }

  const code = exitCodeFor(error);
  const message = error instanceof Error ? error.message : String(error);
  stderr(`toon: ${message}`);
  if (code === EXIT.network) {
    stderr('      The connector or the chain RPC could not be reached. Check the URL and try again.');
  }
  if (code === EXIT.unexpected && error instanceof Error && error.stack !== undefined) {
    // Nothing recognised this, so the stack is the only useful thing left.
    stderr(error.stack);
  }
  return code;
}

/** This package's version, read at runtime so nothing has to be generated. */
export function packageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Commands that never reach a connector at all.
 *
 * `init` writes a keystore and `identity` derives addresses from a phrase;
 * both are pure local key work. Telling someone which node we would have
 * defaulted to is noise on those, and worse than noise — it implies a network
 * call that is not about to happen.
 */
const OFFLINE_COMMANDS = new Set(['init', 'identity']);

/**
 * Should the connector-resolution note be suppressed for this invocation?
 *
 * Two cases. The command takes no connector at all ({@link OFFLINE_COMMANDS}),
 * or its own argument names one: `describe <url>` and `price <dest> <url>` do,
 * and when they do the "no connector given, using the devnet node" note is not
 * merely noise — it is wrong. Either way it is suppressed rather than printed
 * and then contradicted.
 */
function overridesConnector(command: string, positionals: string[]): boolean {
  if (OFFLINE_COMMANDS.has(command)) return true;
  if (command === 'describe') return positionals[0] !== undefined;
  if (command === 'price') return positionals[1] !== undefined;
  return false;
}

export interface RunOptions {
  stdout?: Writer;
  stderr?: Writer;
  /** Overrides for anything that touches the outside world. Tests supply all of it. */
  deps?: Partial<CliDependencies>;
}

/** Everything the CLI needs from the world, with the real implementations. */
function defaultDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  const interactive = overrides.prompt === undefined && isInteractive();
  return {
    env: process.env,
    home: homedir(),
    readFile: (path: string) => readFileSync(path, 'utf8'),
    readFileBytes: (path: string) => new Uint8Array(readFileSync(path)),
    readStdin: () => readStdin(),
    // A prompt is offered only when there is a terminal to prompt on; otherwise
    // it stays `undefined` and the password resolution says so plainly instead
    // of hanging on a pipe that will never answer.
    ...(interactive ? { prompt: (message: string) => promptHidden(message) } : {}),
    ...overrides,
  };
}

/**
 * Run one command line and return its exit code.
 *
 * Never throws, never calls `process.exit`: everything is a return value, which
 * is what makes the whole surface testable.
 */
export async function runCli(argv: string[], options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  let out = new Output({ stdout, stderr });
  let context: Context | undefined;

  try {
    const line = parseCommandLine(argv);
    out = new Output({
      json: boolOption(line.values, 'json'),
      quiet: boolOption(line.values, 'quiet'),
      stdout,
      stderr,
    });

    if (boolOption(line.values, 'version')) {
      const version = packageVersion();
      out.render({ version }, () => {
        out.line(version);
      });
      return EXIT.ok;
    }

    // Help is an answer, so it goes to stdout — and it goes there directly,
    // bypassing `--json`, because help is prose and `--json` promises a
    // document about a connector, not about this program.
    if (line.command === undefined) {
      stdout(usage());
      return EXIT.ok;
    }
    if (line.command === 'help') {
      stdout(usage(line.positionals[0]));
      return EXIT.ok;
    }
    if (boolOption(line.values, 'help')) {
      stdout(usage(line.command));
      return EXIT.ok;
    }

    const deps = defaultDependencies(options.deps);
    const { settings, warnings } = resolveSettings(line.values, deps.env, { home: deps.home });
    if (!overridesConnector(line.command, line.positionals)) {
      for (const warning of warnings) out.warn(warning);
    }

    const runner = RUNNERS[line.command];
    if (runner === undefined) {
      throw new UsageError(`'${line.command}' has no implementation`, line.command);
    }

    context = new Context({
      command: line.command,
      positionals: line.positionals,
      values: line.values,
      settings,
      out,
      deps,
    });

    return await runner(context);
  } catch (error) {
    return reportError(error, stderr);
  } finally {
    // Release the BTP socket and flush the watermark, whatever happened. A
    // failure to close is reported and then dropped: it must never replace the
    // outcome the command already produced.
    const client = context?.openClient;
    if (client !== undefined) {
      try {
        await client.close();
      } catch (error) {
        out.warn(`toon: closing the client failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/**
 * Run only when this file *is* the program.
 *
 * The ESM entry check, and the reason `runCli` can be imported by a test
 * without the test becoming a CLI invocation.
 *
 * Both sides are resolved through their symlinks before they are compared, and
 * that is the whole point rather than a nicety. `package.json` points `bin` at
 * this file, so npm links `node_modules/.bin/toon` at it; Node then reports
 * `import.meta.url` as the *realpath* while `process.argv[1]` is the path as
 * invoked — the link. Comparing those two strings answers "no" for every
 * documented way to run the command (`npx toon`, a global install, the project
 * `.bin`), and the failure is silent: nothing runs and the process exits 0, so
 * a script checking `$?` sees green (#640).
 *
 * A path that cannot be resolved is compared as it stands rather than
 * disqualifying the invocation, so a filesystem that will not answer
 * `realpath` can only leave this as good as the plain string compare, never
 * worse.
 */
export function isEntryPoint(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    const self = fileURLToPath(moduleUrl);
    const invoked = fileURLToPath(pathToFileURL(entry).href);
    return self === invoked || throughLinks(self) === throughLinks(invoked);
  } catch {
    return false;
  }
}

/** The real file behind a path, or the path itself if it has no answer. */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
