/**
 * Turning a command line and an environment into a configured client.
 *
 * Every setting resolves the same way — **flag, then environment, then
 * default** — and the defaults are chosen so that a user who has run nothing but
 * `toon init` can still run `toon describe`. Where a default is a guess rather
 * than a fact, the guess is announced on stderr: falling back to the devnet
 * connector because none was named is exactly the kind of thing that should not
 * be silent, since the alternative is a user wondering why their production node
 * never saw the request.
 *
 * ## The one lazy import
 *
 * `ToonClient` is imported *here*, dynamically, and nowhere else. Every command
 * is written against {@link ToonClientLike} — the interface — so the whole CLI
 * can be unit-tested against a hand-written fake with no client, no network and
 * no chain anywhere in the test. The import stays a runtime lookup rather than a
 * static one for the same reason: a `toon --help` should not pay for loading
 * viem and the wire codec.
 *
 * ## Why a CLI never opens a channel by itself
 *
 * The library defaults `autoOpenChannel` to `true`, which is right for a
 * long-lived process configured once. It is wrong for a command: `toon send`
 * would submit chain transactions, spend gas and lock collateral as a side
 * effect of asking for one HTTP request. So the CLI turns it off and lets the
 * refusal explain itself — "no channel yet, run `toon channel open`" — which is
 * a sentence the user can act on, and reversible.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateRandomIdentity, type KeyDerivationScheme } from '../keys/KeyDerivation.js';
import type { ChainKind } from '../channel/types.js';
import type {
  ToonClientConfig,
  ToonClientLike,
  TransportPreference,
} from '../client/types.js';
import { DEVNET } from '../presets.js';
import { CliConfigError, UsageError, boolOption, stringOption, type ParsedValues } from './args.js';
import {
  MNEMONIC_ENV,
  readKeystore,
  resolveKeystorePath,
  resolvePassword,
  keystoreExists,
  type Env,
} from './keystore.js';
import type { Output } from './output.js';

export type { Env };

/** Environment variables that name a setting. */
export const CONNECTOR_ENV = 'TOON_CONNECTOR';
export const CHAIN_ENV = 'TOON_CHAIN';
export const RPC_ENV = 'TOON_RPC_URL';
export const CHANNEL_STORE_ENV = 'TOON_CHANNEL_STORE';

/** Where a setting's value came from. Reported so a surprising run can be explained. */
export type SettingSource = 'flag' | 'env' | 'default';

/** Everything resolved from the command line and the environment. */
export interface CliSettings {
  connector: string;
  connectorSource: SettingSource;
  /** Unset means "let the connector's settlements decide". */
  chain?: ChainKind;
  /** Unset means "the package's preset for whichever chain is chosen". */
  rpcUrl?: string;
  /** Always a path: an in-memory watermark is never the right default for a CLI. */
  channelStore: string;
  transport: TransportPreference;
  keystorePath: string;
  passwordFile?: string;
  json: boolean;
  quiet: boolean;
}

/** `~/.toon/channels.json`. */
export function defaultChannelStorePath(home: string = homedir()): string {
  return join(home, '.toon', 'channels.json');
}

function parseChain(value: string | undefined, from: string): ChainKind | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value === 'evm' || value === 'solana') return value;
  throw new UsageError(`${from} must be 'evm' or 'solana'; got '${value}'`);
}

function parseTransport(value: string | undefined, from: string): TransportPreference {
  if (value === undefined || value.length === 0) return 'auto';
  if (value === 'auto' || value === 'http' || value === 'btp') return value;
  throw new UsageError(`${from} must be 'auto', 'http' or 'btp'; got '${value}'`);
}

/**
 * Resolve every setting, and collect the notes worth printing.
 *
 * Pure apart from `homedir()`: no file is read and no network is touched, which
 * is what makes the precedence rules testable one at a time.
 */
export function resolveSettings(
  values: ParsedValues,
  env: Env,
  options: { home?: string } = {}
): { settings: CliSettings; warnings: string[] } {
  const home = options.home ?? homedir();
  const warnings: string[] = [];

  const connectorFlag = stringOption(values, 'connector');
  const connectorEnv = env[CONNECTOR_ENV];
  let connector: string;
  let connectorSource: SettingSource;
  if (connectorFlag !== undefined && connectorFlag.length > 0) {
    connector = connectorFlag;
    connectorSource = 'flag';
  } else if (connectorEnv !== undefined && connectorEnv.length > 0) {
    connector = connectorEnv;
    connectorSource = 'env';
  } else {
    connector = DEVNET.store.url;
    connectorSource = 'default';
    warnings.push(
      `toon: no connector given, using the devnet store node ${DEVNET.store.url}.\n` +
        `      Set --connector or ${CONNECTOR_ENV} to talk to another node.`
    );
  }

  const chain =
    parseChain(stringOption(values, 'chain'), '--chain') ??
    parseChain(env[CHAIN_ENV], CHAIN_ENV);

  const rpcUrl = stringOption(values, 'rpc') ?? env[RPC_ENV];

  const channelStore =
    stringOption(values, 'store') ??
    (env[CHANNEL_STORE_ENV] !== undefined && env[CHANNEL_STORE_ENV].length > 0
      ? env[CHANNEL_STORE_ENV]
      : defaultChannelStorePath(home));

  const transport = parseTransport(stringOption(values, 'transport'), '--transport');

  const settings: CliSettings = {
    connector,
    connectorSource,
    ...(chain !== undefined ? { chain } : {}),
    ...(rpcUrl !== undefined && rpcUrl.length > 0 ? { rpcUrl } : {}),
    channelStore,
    transport,
    keystorePath: resolveKeystorePath({
      flag: stringOption(values, 'keystore'),
      env,
      home,
    }),
    ...(stringOption(values, 'password-file') !== undefined
      ? { passwordFile: stringOption(values, 'password-file') }
      : {}),
    json: boolOption(values, 'json'),
    quiet: boolOption(values, 'quiet'),
  };

  return { settings, warnings };
}

/**
 * The key material a command will run with.
 *
 * `ephemeral` exists for the two commands that pay for nothing —
 * {@link ../cli/commands/describe.js} and {@link ../cli/commands/price.js} read
 * a connector's free, unauthenticated endpoints. Rather than making the client
 * cope with having no identity at all, they run with a throwaway one: nothing is
 * signed with it, no chain is touched, and it is discarded when the process
 * exits. That is what lets `toon describe` work on a machine that has never run
 * `toon init`.
 */
export type KeyMaterial =
  | { kind: 'mnemonic'; mnemonic: string; derivation: KeyDerivationScheme; from: 'env' | 'keystore' }
  | { kind: 'ephemeral' };

/** Dependencies a command may need, all injectable so the CLI is testable end to end. */
export interface CliDependencies {
  env: Env;
  home: string;
  /** Read a whole file as UTF-8. */
  readFile?: (path: string) => string;
  /** The hidden password prompt, or `undefined` when stdin is not a terminal. */
  prompt?: ((message: string) => Promise<string>) | undefined;
  /** Read stdin to EOF — `send --body -`, and `init --import`. */
  readStdin?: () => Promise<Uint8Array>;
  /** Read a whole file as bytes — `send --body-file`, whose content may be binary. */
  readFileBytes?: (path: string) => Uint8Array;
  /** Build the client. Overridden in tests with a fake. */
  createClient?: (config: ToonClientConfig) => Promise<ToonClientLike>;
}

/**
 * Find the keys.
 *
 * `TOON_MNEMONIC` wins because a phrase in the environment is an explicit
 * instruction from whoever set it, and because it is how a container without a
 * writable home directory is expected to run. It is read as the **standard**
 * derivation: a bare phrase carries no record of which addresses it means, and
 * standard is the one every other wallet agrees on. A phrase whose channels were
 * opened before 1.0 belongs in a keystore, where the file itself records that.
 */
export async function resolveKeyMaterial(
  settings: CliSettings,
  deps: CliDependencies,
  options: { keyless?: boolean } = {}
): Promise<KeyMaterial> {
  const fromEnv = deps.env[MNEMONIC_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return {
      kind: 'mnemonic',
      mnemonic: fromEnv.trim(),
      derivation: 'standard',
      from: 'env',
    };
  }

  if (keystoreExists(settings.keystorePath)) {
    const { password } = await resolvePassword({
      message: `Password for ${settings.keystorePath}: `,
      passwordFile: settings.passwordFile,
      env: deps.env,
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
      prompt: deps.prompt,
    });
    const opened = readKeystore(settings.keystorePath, password);
    return {
      kind: 'mnemonic',
      mnemonic: opened.mnemonic,
      derivation: opened.derivation,
      from: 'keystore',
    };
  }

  if (options.keyless === true) return { kind: 'ephemeral' };

  throw new CliConfigError(
    `no keys: ${MNEMONIC_ENV} is unset and there is no keystore at ${settings.keystorePath}`,
    "Run 'toon init' to create one, or set TOON_MNEMONIC."
  );
}

/** Turn resolved settings and key material into the library's own config object. */
export function buildClientConfig(
  settings: CliSettings,
  keys: KeyMaterial
): ToonClientConfig {
  const base: ToonClientConfig = {
    connector: settings.connector,
    channelStore: settings.channelStore,
    transport: settings.transport,
    // See this module's docs: a command never opens a channel as a side effect.
    autoOpenChannel: false,
    ...(settings.chain !== undefined ? { chain: settings.chain } : {}),
    ...(settings.rpcUrl !== undefined ? { rpcUrl: settings.rpcUrl } : {}),
  };

  if (keys.kind === 'mnemonic') {
    return { ...base, mnemonic: keys.mnemonic, keyDerivation: keys.derivation };
  }

  const identity = generateRandomIdentity();
  return {
    ...base,
    evmPrivateKey: identity.evm.privateKey,
    solanaSecretKey: identity.solana.secretKey,
  };
}

/**
 * The concrete client's factory, as this module needs to see it.
 *
 * Deliberately structural, and deliberately optional on the module namespace:
 * the CLI depends on the *shape* `create(config) => ToonClientLike`, so it type
 * checks and unit-tests without the class, and reports a comprehensible error
 * rather than a `TypeError` if a build ever ships without it.
 */
interface ToonClientModule {
  ToonClient?: { create(config: ToonClientConfig): Promise<ToonClientLike> };
}

/** Load `ToonClient` and construct one. The only place the class is named. */
export async function defaultCreateClient(config: ToonClientConfig): Promise<ToonClientLike> {
  const module = (await import('../client/index.js')) as ToonClientModule;
  const factory = module.ToonClient;
  if (factory === undefined) {
    throw new Error(
      'this build of @toon-protocol/client exports no ToonClient; the CLI cannot run against it'
    );
  }
  return factory.create(config);
}

/** What a command is handed. */
export interface CommandContext {
  readonly command: string;
  readonly positionals: string[];
  readonly values: ParsedValues;
  readonly settings: CliSettings;
  readonly out: Output;
  readonly deps: CliDependencies;
  /**
   * The client, created on first use and reused after that.
   *
   * `keyless` lets the two free commands run with a throwaway identity instead
   * of failing on a machine with no keystore. `connector` is how `describe` and
   * `price` honour the URL given as their own argument, which outranks every
   * other source precisely because it was typed for this one invocation.
   */
  client(options?: { keyless?: boolean; connector?: string }): Promise<ToonClientLike>;
  /** The client, if one was ever created — so the caller can close it. */
  readonly openClient: ToonClientLike | undefined;
}

/** The live {@link CommandContext}. */
export class Context implements CommandContext {
  readonly command: string;
  readonly positionals: string[];
  readonly values: ParsedValues;
  readonly settings: CliSettings;
  readonly out: Output;
  readonly deps: CliDependencies;
  private instance: ToonClientLike | undefined;

  constructor(init: {
    command: string;
    positionals: string[];
    values: ParsedValues;
    settings: CliSettings;
    out: Output;
    deps: CliDependencies;
  }) {
    this.command = init.command;
    this.positionals = init.positionals;
    this.values = init.values;
    this.settings = init.settings;
    this.out = init.out;
    this.deps = init.deps;
  }

  get openClient(): ToonClientLike | undefined {
    return this.instance;
  }

  async client(options: { keyless?: boolean; connector?: string } = {}): Promise<ToonClientLike> {
    if (this.instance !== undefined) return this.instance;
    const settings =
      options.connector === undefined
        ? this.settings
        : { ...this.settings, connector: options.connector, connectorSource: 'flag' as const };
    const keys = await resolveKeyMaterial(settings, this.deps, options);
    const config = buildClientConfig(settings, keys);
    const create = this.deps.createClient ?? defaultCreateClient;
    this.instance = await create(config);
    return this.instance;
  }
}
