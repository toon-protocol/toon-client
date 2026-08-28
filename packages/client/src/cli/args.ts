/**
 * The `toon` command line: what every command accepts, and how a mistake is
 * explained.
 *
 * Parsing is `node:util`'s {@link parseArgs} and nothing else — the package
 * targets Node ≥ 22, where that is a standard-library function, and a CLI whose
 * argument parser is a dependency is a CLI that can break on someone else's
 * release.
 *
 * Two decisions here are worth stating, because neither is the obvious one.
 *
 * **Every option is parsed against one union spec.** `parseArgs` is strict, so
 * it must be told about an option before it can see it; giving it only the
 * current command's options would make `toon balances --body x` fail as
 * "unknown option", which is true but unhelpful. Parsing against the union and
 * *then* checking the option against the command lets the error say the thing
 * that is actually wrong: `--body` is not an option of `balances`.
 *
 * **A mnemonic is never an option.** There is no `--mnemonic`, and there will
 * not be one: a flag value is written to shell history and is readable in `ps`
 * by every other user on the machine for as long as the process lives. The
 * phrase arrives on stdin (`toon init --import`), through `TOON_MNEMONIC`, or
 * out of an encrypted keystore — see {@link ./keystore.js}.
 */
import { parseArgs } from 'node:util';

/**
 * The user asked for something that is not a command, or gave a command
 * arguments it cannot take. Always exit code 2, never a stack trace: a usage
 * mistake is a conversation, not a crash.
 */
export class UsageError extends Error {
  readonly code = 'USAGE';
  /** The command to print usage for alongside the message, when one is known. */
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

/**
 * A setting could not be resolved: no connector, no keys, a keystore that is
 * not there, a password with nowhere to come from. Exit code 2, the same as a
 * usage mistake, because it is the same kind of problem — something the user
 * supplies is missing or wrong, and the message should say which.
 *
 * Lives beside {@link UsageError} rather than in `client/errors.ts` because it
 * is about *this program's* inputs — a library caller passes a config object and
 * never meets an environment variable.
 */
export class CliConfigError extends Error {
  readonly code = 'CONFIG';
  /** What to do about it, printed under the message. */
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliConfigError';
    this.hint = hint;
  }
}

/** One option as `parseArgs` wants it. */
interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  /** One line of help. */
  help: string;
  /** Placeholder for a string option's value, e.g. `URL`. */
  arg?: string;
}

/**
 * Options every command accepts. These are the settings-resolution inputs —
 * each one is the highest-priority source for a setting that otherwise comes
 * from the environment or a default (see {@link ./context.js}).
 */
export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  connector: {
    type: 'string',
    arg: 'URL',
    help: "The connector's client-edge URL. Env TOON_CONNECTOR.",
  },
  chain: {
    type: 'string',
    arg: 'evm|solana',
    help: 'Which settlement chain to pay on. Env TOON_CHAIN. Default: the first the node offers that you hold a key for.',
  },
  rpc: {
    type: 'string',
    arg: 'URL',
    help: 'Chain RPC endpoint. Env TOON_RPC_URL.',
  },
  store: {
    type: 'string',
    arg: 'PATH',
    help: 'Channel watermark file. Env TOON_CHANNEL_STORE. Default ~/.toon/channels.json.',
  },
  keystore: {
    type: 'string',
    arg: 'PATH',
    help: 'Encrypted mnemonic keystore. Env TOON_KEYSTORE. Default ~/.toon/keystore.json.',
  },
  'password-file': {
    type: 'string',
    arg: 'PATH',
    help: 'Read the keystore password from this file instead of prompting.',
  },
  transport: {
    type: 'string',
    arg: 'auto|http|btp',
    help: 'Which carriage to pay over. Default auto.',
  },
  json: { type: 'boolean', help: 'Print one JSON document on stdout and nothing else.' },
  quiet: { type: 'boolean', help: 'Suppress progress and warnings on stderr.' },
  help: { type: 'boolean', short: 'h', help: 'Show this help.' },
  version: { type: 'boolean', help: 'Print the client version.' },
};

/** Options that belong to individual commands. */
export const COMMAND_OPTIONS: Record<string, OptionSpec> = {
  import: { type: 'boolean', help: 'Import an existing BIP-39 phrase, read from stdin.' },
  'legacy-derivation': {
    type: 'boolean',
    help: "Derive the EVM key at Nostr's coin type, as this client did before 1.0.",
  },
  'all-derivations': {
    type: 'boolean',
    help: 'Show the addresses of every derivation scheme, not just the one in use.',
  },
  deposit: { type: 'string', arg: 'BASE_UNITS', help: 'Collateral to lock, in base units.' },
  'settlement-timeout': {
    type: 'string',
    arg: 'SECONDS',
    help: 'Challenge period. Default 86400; EVM floors it at 3600.',
  },
  'connector-view': {
    type: 'boolean',
    help: "Also ask the connector for its own watermark, and show both.",
  },
  method: { type: 'string', arg: 'VERB', help: 'HTTP method. Default POST.' },
  target: { type: 'string', arg: 'PATH', help: "Path beneath the route's handler. Default ''." },
  header: {
    type: 'string',
    short: 'H',
    multiple: true,
    arg: 'NAME:VALUE',
    help: 'A request header. Repeat for more; order and duplicates are preserved.',
  },
  body: { type: 'string', arg: 'TEXT', help: 'Request body. `-` reads stdin to EOF.' },
  'body-file': { type: 'string', arg: 'PATH', help: 'Read the request body from a file.' },
  'json-body': {
    type: 'boolean',
    help: 'Check the body parses as JSON and send it as application/json.',
  },
  amount: {
    type: 'string',
    arg: 'BASE_UNITS',
    help: 'Amount in base units. On send, overrides the route price.',
  },
  to: { type: 'string', arg: 'ADDRESS', help: 'Destination address.' },
  asset: { type: 'string', arg: 'native|token', help: "Which asset to move. Default 'token'." },
};

/** Everything `parseArgs` is allowed to see. */
const ALL_OPTIONS = { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS };

/** What one command is, for dispatch and for help. */
export interface CommandSpec {
  summary: string;
  /** The argument line, without the leading `toon`. */
  usage: string;
  /** Long option names this command accepts on top of the globals. */
  options: string[];
  minPositionals: number;
  maxPositionals: number;
  /** Extra paragraphs for `toon help <command>`. */
  details?: string[];
}

/**
 * The command surface, in the order it is printed.
 *
 * `describe`, `price` and `identity` are the three that need no channel and no
 * money; `identity` needs no network at all. They are first because they are
 * what a newcomer runs before deciding to spend anything.
 */
export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    summary: 'Create or import a keystore.',
    usage: 'init [--import] [--legacy-derivation]',
    options: ['import', 'legacy-derivation'],
    minPositionals: 0,
    maxPositionals: 0,
    details: [
      'Writes an encrypted BIP-39 keystore to ~/.toon/keystore.json (mode 0600).',
      'With --import the phrase is read from stdin — never from an argument, which',
      'would be recorded in shell history and visible in `ps` to everyone on the box.',
    ],
  },
  identity: {
    summary: 'Show the addresses this keystore holds. Offline.',
    usage: 'identity [--all-derivations]',
    options: ['all-derivations'],
    minPositionals: 0,
    maxPositionals: 0,
    details: [
      'Touches no network and no chain: the addresses are derived locally from the',
      'phrase. --all-derivations also shows where a pre-1.0 keystore put the EVM key,',
      'which is the address to look at when a channel opened before 1.0 seems to have',
      'vanished.',
    ],
  },
  describe: {
    summary: 'Read a connector’s self-description. Free, needs no keys.',
    usage: 'describe [URL]',
    options: [],
    minPositionals: 0,
    maxPositionals: 1,
    details: [
      'One unauthenticated GET returns everything needed to transact with a node:',
      'its addresses, its endpoints, the key payloads are sealed to, what it settles',
      'in, and what each route costs.',
    ],
  },
  price: {
    summary: 'What one route costs. Free, needs no keys.',
    usage: 'price <destination> [URL]',
    options: [],
    minPositionals: 1,
    maxPositionals: 2,
  },
  probe: {
    summary: "Learn a path's cost without buying the work.",
    usage: 'probe <destination>',
    options: [],
    minPositionals: 1,
    maxPositionals: 1,
    details: ['Needs an open channel: a probe carries a claim, it just does not spend it.'],
  },
  send: {
    summary: 'Pay for one HTTP request and print the answer.',
    usage: 'send <destination> [--method VERB] [--target PATH] [-H NAME:VALUE]... [--body TEXT | --body-file PATH | --body -] [--json-body] [--amount BASE_UNITS]',
    options: ['method', 'target', 'header', 'body', 'body-file', 'json-body', 'amount'],
    minPositionals: 1,
    maxPositionals: 1,
    details: [
      'The status printed is the app’s own: a 404 from the app is a real answer, it',
      'rides home fulfilled and costs exactly what a 200 costs. Only a refusal short',
      'of the app exits 3.',
    ],
  },
  channel: {
    summary: 'Open, fund, inspect, close and settle the payment channel.',
    usage: 'channel open|deposit <amount>|close|settle|status [--deposit BASE_UNITS] [--connector-view]',
    options: ['deposit', 'settlement-timeout', 'connector-view'],
    minPositionals: 1,
    maxPositionals: 2,
    details: [
      'Every one of these is your transaction, on your gas. `close` starts the',
      'challenge period; `settle` pays out once it has elapsed.',
    ],
  },
  'claim-state': {
    summary: "The connector's own watermark for your channels.",
    usage: 'claim-state',
    options: [],
    minPositionals: 0,
    maxPositionals: 0,
  },
  balances: {
    summary: 'Chain balances for this identity.',
    usage: 'balances',
    options: [],
    minPositionals: 0,
    maxPositionals: 0,
  },
  transfer: {
    summary: 'Move funds out of this wallet.',
    usage: 'transfer --to <address> --amount <base units> [--asset native|token]',
    options: ['to', 'amount', 'asset'],
    minPositionals: 0,
    maxPositionals: 0,
  },
  faucet: {
    summary: 'Ask the devnet faucet for test funds.',
    usage: 'faucet',
    options: [],
    minPositionals: 0,
    maxPositionals: 0,
  },
  help: {
    summary: 'Show help for a command.',
    usage: 'help [COMMAND]',
    options: [],
    minPositionals: 0,
    maxPositionals: 1,
  },
};

/** The `channel` subcommands, in the order a channel goes through them. */
export const CHANNEL_SUBCOMMANDS = ['open', 'deposit', 'status', 'close', 'settle'] as const;

/** A parsed command line, before any setting is resolved. */
export interface ParsedCommandLine {
  /** `undefined` when the line was only `--help` or `--version`. */
  command: string | undefined;
  /** Positionals after the command word. */
  positionals: string[];
  values: ParsedValues;
}

/** Option values, typed the way `parseArgs` returns them. */
export type ParsedValues = Record<string, string | boolean | string[] | undefined>;

/** Read a string option, or `undefined`. Throws if it was given more than once. */
export function stringOption(values: ParsedValues, name: string): string | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length > 1) throw new UsageError(`--${name} was given more than once`);
    return v[0];
  }
  return undefined;
}

/** Read a boolean option. Absent is `false`. */
export function boolOption(values: ParsedValues, name: string): boolean {
  return values[name] === true;
}

/** Read a repeatable string option as a list, in the order it was given. */
export function listOption(values: ParsedValues, name: string): string[] {
  const v = values[name];
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * Parse one command line.
 *
 * Throws {@link UsageError} — and only {@link UsageError} — for anything the
 * user can fix by typing something else.
 */
export function parseCommandLine(argv: string[]): ParsedCommandLine {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: ALL_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const values = parsed.values as ParsedValues;
  const positionals = parsed.positionals;
  const command = positionals[0];

  // `--help` and `--version` are answers in their own right, so they are read
  // before the command is validated: `toon --help` and `toon --version` must
  // work, and `toon nonsense --help` should print help rather than complain.
  if (command === undefined) {
    return { command: undefined, positionals: [], values };
  }

  const spec = COMMANDS[command];
  if (spec === undefined) {
    throw new UsageError(`unknown command '${command}'. Run 'toon help' for the list.`);
  }

  const rest = positionals.slice(1);
  if (!boolOption(values, 'help')) {
    for (const name of Object.keys(values)) {
      if (values[name] === undefined) continue;
      if (name in GLOBAL_OPTIONS) continue;
      if (spec.options.includes(name)) continue;
      throw new UsageError(`--${name} is not an option of '${command}'`, command);
    }
    if (rest.length < spec.minPositionals) {
      throw new UsageError(`'${command}' needs more arguments`, command);
    }
    if (rest.length > spec.maxPositionals) {
      throw new UsageError(
        `'${command}' takes at most ${String(spec.maxPositionals)} argument(s); got ${String(rest.length)}`,
        command
      );
    }
  }

  return { command, positionals: rest, values };
}

/** `--name ARG` or `-s, --name`, padded for a two-column layout. */
function optionLine(name: string, spec: OptionSpec): [string, string] {
  const short = spec.short === undefined ? '' : `-${spec.short}, `;
  const arg = spec.arg === undefined ? '' : ` <${spec.arg}>`;
  return [`  ${short}--${name}${arg}`, spec.help];
}

/** Render two-column rows with the left column padded to a common width. */
function columns(rows: [string, string][]): string {
  const width = rows.reduce((w, [left]) => Math.max(w, left.length), 0);
  return rows.map(([left, right]) => `${left.padEnd(width)}  ${right}`).join('\n');
}

/**
 * The help text — for one command, or the whole surface.
 *
 * Kept here rather than in each command module so that adding a command that
 * nothing documents is impossible: the same table drives dispatch and help.
 */
export function usage(command?: string): string {
  if (command !== undefined && command in COMMANDS) {
    const spec = COMMANDS[command] as CommandSpec;
    const parts = [`toon ${spec.usage}`, '', spec.summary];
    if (spec.details) parts.push('', ...spec.details);
    const opts = spec.options.map((name) =>
      optionLine(name, COMMAND_OPTIONS[name] as OptionSpec)
    );
    if (opts.length > 0) parts.push('', 'Options:', columns(opts));
    parts.push(
      '',
      'Global options:',
      columns(Object.entries(GLOBAL_OPTIONS).map(([n, s]) => optionLine(n, s)))
    );
    return parts.join('\n');
  }

  return [
    'toon — pay for an HTTP request, per request, over a payment channel.',
    '',
    'Usage: toon <command> [options]',
    '',
    'Commands:',
    columns(
      Object.entries(COMMANDS).map(([name, spec]) => [`  ${name}`, spec.summary])
    ),
    '',
    'Global options:',
    columns(Object.entries(GLOBAL_OPTIONS).map(([n, s]) => optionLine(n, s))),
    '',
    'Environment: TOON_CONNECTOR, TOON_MNEMONIC, TOON_KEYSTORE,',
    '             TOON_KEYSTORE_PASSWORD, TOON_CHAIN, TOON_RPC_URL, TOON_CHANNEL_STORE.',
    '',
    "Run 'toon help <command>' for one command in detail.",
  ].join('\n');
}
