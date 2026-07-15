/**
 * `rig name` — ArNS naming verbs (#367): buy / set / status, owned and paid
 * by the rig mnemonic's Solana key.
 *
 * ArNS is the missing NAMING layer over everything Rig serves from Arweave.
 * Since ar.io's Solana migration, ArNS names are owned and managed by Solana
 * wallets, and `@ar.io/sdk` is Solana-native with prices denominated in mARIO.
 * The rig identity ALREADY has the required key: `@toon-protocol/client`
 * derives a Solana Ed25519 keypair from the same mnemonic that pays for pushes
 * (`m/44'/501'/{index}'/0'`, SLIP-0010 — see packages/client/src/keys) and
 * `rig fund --chain solana` funds it. So the same phrase can own ArNS names and
 * pay for them, with ZERO new key material or config.
 *
 * PAYMENT MODEL — the load-bearing distinction (see {@link MARIO_PAYMENT_NOTE}):
 * `rig name buy` spends **mARIO from the identity's Solana wallet, charged
 * on-chain by the ar.io registry program**. It does NOT move value through the
 * TOON ILP payment channels that `rig push` uses — a name purchase is a
 * Solana-settled registry transaction, not a pay-to-write relay claim.
 *
 * Same discipline as every paid rig command: estimate → confirm → execute,
 * strict `--json` contract, `--yes` for non-TTY. `buy` and `set` are the
 * money/state-moving paths (gated); `status` is FREE (a registry read, like
 * `rig balance`).
 *
 * DEPENDENCY HYGIENE (#367 open question, decided): `@ar.io/sdk` is an
 * OPTIONAL, lazily-imported dependency — it is `import()`ed only inside the
 * command path (via the {@link LoadArns} seam), so the base `rig` install stays
 * lean and runs that never touch names never pay its startup cost. When it is
 * not installed, the command fails with a clean, actionable error
 * ({@link ArnsSdkUnavailableError}) instead of a module-resolution stack trace.
 *
 * DEVNET/TESTNET (#367 open question): the registry process id is configurable
 * — `--network mainnet|devnet|testnet` (or `RIG_ARIO_NETWORK`) selects the
 * SDK's `ARIO_{MAINNET,DEVNET,TESTNET}_PROCESS_ID`, and `--process-id <id>`
 * (or `RIG_ARIO_PROCESS_ID`) overrides outright. Defaults to mainnet. Whether
 * public gateways resolve non-mainnet registries is UNVERIFIED (see the PR).
 */

import { parseArgs } from 'node:util';
import { formatUnits } from './balance.js';
import { emitCliError } from './errors.js';
import { resolveIdentity } from './identity.js';
import type { CliIo } from './output.js';
import type { IdentityReport } from './push.js';
import { renderIdentityLine } from './render.js';

// ---------------------------------------------------------------------------
// mARIO / ARIO
// ---------------------------------------------------------------------------

/**
 * $ARIO token decimals: 1 ARIO = 1_000_000 mARIO (mARIO is the base unit
 * `@ar.io/sdk` quotes in). Used only to render a human ARIO figure alongside
 * the exact mARIO amount — the mARIO integer is always the authoritative value.
 */
export const ARIO_DECIMALS = 6;

/** Render a mARIO base-unit amount as `<mARIO> mARIO (~<ARIO> ARIO)`. */
export function renderMario(mario: bigint): string {
  return `${mario.toString()} mARIO (~${formatUnits(mario.toString(), ARIO_DECIMALS)} ARIO)`;
}

/**
 * THE load-bearing note (#367): a name purchase spends mARIO on Solana via the
 * ar.io registry program — NOT through TOON ILP payment channels. Exported so
 * the buy human output, the `--json` hint, and the tests all pin one string.
 */
export const MARIO_PAYMENT_NOTE =
  "Payment is mARIO from this identity's Solana wallet, charged on-chain by " +
  'the ar.io registry program — NOT through TOON ILP payment channels. Fund ' +
  'this wallet with `rig fund --chain solana` (or send $ARIO to the Solana ' +
  'address above).';

// ---------------------------------------------------------------------------
// The ar.io SDK seam (lazily imported; tests inject a stub — NEVER the live net)
// ---------------------------------------------------------------------------

/** A name registration kind: a time-boxed lease or a one-time permabuy. */
export type NameType = 'lease' | 'permabuy';

/** The three registries the SDK exposes; mainnet is the default. */
export type ArioNetwork = 'mainnet' | 'devnet' | 'testnet';

/** One name's current registry record (the free `status` read). */
export interface ArnsRecordView {
  /** ANT (Arweave Name Token) process id that owns/serves the name. */
  processId: string | null;
  /** `lease` or `permabuy`, when known. */
  type: NameType | null;
  /** Lease/registration start (ms epoch), when known. */
  startTimestamp?: number;
  /** Lease expiry (ms epoch); absent/undefined for a permabuy. */
  endTimestamp?: number;
  /** Included undername slots (ArNS ships 10 per name). */
  undernameLimit?: number;
}

/** One ANT record target (base name or an undername). */
export interface AntRecordTarget {
  /** Arweave txId the record points at (typically a path manifest). */
  transactionId: string;
  /** Record TTL in seconds (gateway cache hint). */
  ttlSeconds: number;
}

/**
 * A handle on one name's ANT process — used by `set` (write) and `status`
 * (read). The base name record is conventionally the `@` undername.
 */
export interface ArnsAnt {
  /** All current record targets, keyed by undername (`@` = the base name). */
  getRecords(): Promise<Record<string, AntRecordTarget>>;
  /** Point the base name at an Arweave txId. */
  setBaseNameRecord(args: {
    transactionId: string;
    ttlSeconds: number;
  }): Promise<{ id: string }>;
  /** Point an undername (`<sub>_<name>`) at an Arweave txId. */
  setUndernameRecord(args: {
    undername: string;
    transactionId: string;
    ttlSeconds: number;
  }): Promise<{ id: string }>;
}

/**
 * The slice of `@ar.io/sdk` `rig name` uses, behind our own seam so tests can
 * inject a stub and NEVER reach the live ar.io registry (the hard safety rule:
 * no real $ARIO is ever spent, no real registry call is ever made in code we
 * run or in tests).
 */
export interface ArnsSdk {
  /** Quote the mARIO cost of an intent (here always `Buy-Name`). */
  getTokenCost(args: {
    intent: 'Buy-Name';
    name: string;
    type: NameType;
    years?: number;
  }): Promise<bigint>;
  /**
   * Register (buy) a name; the spawned ANT is owned by the signer's Solana
   * key. Returns the settling registry transaction id and, when the SDK
   * surfaces it, the new ANT process id.
   */
  buyRecord(args: {
    name: string;
    type: NameType;
    years?: number;
  }): Promise<{ id: string; processId?: string }>;
  /** Read a name's current registry record (free). */
  getArNSRecord(args: { name: string }): Promise<ArnsRecordView | null>;
  /** Bind an ANT handle for a name's process id (for `set` / `status`). */
  ant(processId: string): Promise<ArnsAnt>;
}

/** What the {@link LoadArns} seam needs to build a signed, targeted SDK. */
export interface LoadArnsOptions {
  /** 64-byte Solana keypair (secretKey ‖ publicKey) that owns and pays. */
  solanaSecretKey: Uint8Array;
  /** Solana public key (base58) — for the signer + human messaging. */
  solanaPublicKey: string;
  /** Which registry to target. */
  network: ArioNetwork;
  /** Explicit registry process id override (wins over `network`). */
  processId?: string;
}

/** Build a signed, network-targeted {@link ArnsSdk} (tests inject a stub). */
export type LoadArns = (options: LoadArnsOptions) => Promise<ArnsSdk>;

/**
 * `@ar.io/sdk` is not installed. Optional-dependency by design (#367): surface
 * a clean, actionable message instead of a raw module-resolution failure.
 */
export class ArnsSdkUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      '`rig name` needs the optional `@ar.io/sdk` dependency, which is not ' +
        'installed. It is intentionally NOT a base `rig` dependency (keeps the ' +
        'install lean). Add it to use ArNS naming:\n' +
        '  npm i @ar.io/sdk    # or: pnpm add @ar.io/sdk\n' +
        'then re-run your `rig name` command.' +
        (cause instanceof Error ? `\n(underlying error: ${cause.message})` : '')
    );
    this.name = 'ArnsSdkUnavailableError';
  }
}

/** Known mainnet registry process id (overridable via flag/env). */
const ARIO_MAINNET_PROCESS_ID = 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE';

/**
 * The untyped shape of the pieces of `@ar.io/sdk` the default loader reaches
 * for. Kept local (the package is optional and its types are not a build dep)
 * and cast through `unknown` — never `any`, so eslint's no-explicit-any holds.
 */
interface RawArioModule {
  ARIO?: {
    init?: (config: unknown) => RawArioInstance;
  };
  ANT?: {
    init?: (config: unknown) => RawAntInstance;
  };
  ArweaveSigner?: unknown;
  ARIO_MAINNET_PROCESS_ID?: string;
  ARIO_DEVNET_PROCESS_ID?: string;
  ARIO_TESTNET_PROCESS_ID?: string;
  /** Solana-native signer factory (post-migration @ar.io/sdk). */
  SolanaSigner?: new (secretKey: Uint8Array) => unknown;
}
interface RawArioInstance {
  getTokenCost: (args: unknown) => Promise<unknown>;
  buyRecord: (args: unknown) => Promise<unknown>;
  getArNSRecord: (args: unknown) => Promise<unknown>;
}
interface RawAntInstance {
  getRecords: () => Promise<Record<string, { transactionId: string; ttlSeconds: number }>>;
  setBaseNameRecord: (args: unknown) => Promise<{ id: string }>;
  setUndernameRecord: (args: unknown) => Promise<{ id: string }>;
}

/**
 * Default {@link LoadArns}: lazily `import('@ar.io/sdk')` and adapt it to our
 * seam. The specifier is stored in a `string`-typed variable so TypeScript
 * does not try to resolve the optional module at build time; a missing package
 * surfaces as {@link ArnsSdkUnavailableError}.
 *
 * NOTE: the real adapter is never exercised by tests (the hard safety rule —
 * every money-moving path runs ONLY against injected stubs). It exists so the
 * command works against a real, funded install once a human signs off on
 * spending real mainnet $ARIO.
 */
export const defaultLoadArns: LoadArns = async (options) => {
  // Cast to `string` (not a literal type) so TypeScript does not try to
  // resolve the OPTIONAL `@ar.io/sdk` module at build time — a missing package
  // must surface as a clean runtime error, not a compile failure.
  const specifier = '@ar.io/sdk' as string;
  let mod: RawArioModule;
  try {
    mod = (await import(specifier)) as unknown as RawArioModule;
  } catch (err) {
    throw new ArnsSdkUnavailableError(err);
  }
  if (!mod.ARIO?.init || !mod.ANT?.init) {
    throw new ArnsSdkUnavailableError(
      new Error('the installed @ar.io/sdk does not expose ARIO.init / ANT.init')
    );
  }
  const processId =
    options.processId ??
    (options.network === 'devnet'
      ? (mod.ARIO_DEVNET_PROCESS_ID ?? '')
      : options.network === 'testnet'
        ? (mod.ARIO_TESTNET_PROCESS_ID ?? '')
        : (mod.ARIO_MAINNET_PROCESS_ID ?? ARIO_MAINNET_PROCESS_ID));
  if (!processId) {
    throw new ArnsSdkUnavailableError(
      new Error(
        `the installed @ar.io/sdk exposes no ${options.network} registry ` +
          'process id — pass --process-id explicitly'
      )
    );
  }
  if (!mod.SolanaSigner) {
    throw new ArnsSdkUnavailableError(
      new Error(
        'the installed @ar.io/sdk exposes no SolanaSigner — this build predates ' +
          "ar.io's Solana migration; upgrade @ar.io/sdk"
      )
    );
  }
  const signer = new mod.SolanaSigner(options.solanaSecretKey);
  const ario = mod.ARIO.init({ process: processId, signer });
  const antInit = mod.ANT.init;
  return {
    getTokenCost: async (args) => BigInt(String(await ario.getTokenCost(args))),
    buyRecord: async (args) =>
      (await ario.buyRecord(args)) as { id: string; processId?: string },
    getArNSRecord: async (args) =>
      (await ario.getArNSRecord(args)) as ArnsRecordView | null,
    ant: async (pid) => {
      const ant = antInit({ processId: pid, signer });
      return {
        getRecords: () => ant.getRecords(),
        setBaseNameRecord: (a) => ant.setBaseNameRecord(a),
        setUndernameRecord: (a) => ant.setUndernameRecord(a),
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Deps + usage
// ---------------------------------------------------------------------------

/** What `rig name` needs from the command environment. */
export interface NameDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  /** Working directory (project-local `.env` walk for the identity). */
  cwd: string;
  /** ar.io SDK loader seam; defaults to the lazy `@ar.io/sdk` import. */
  loadArns?: LoadArns;
}

export const NAME_USAGE = `Usage: rig name <buy|set|status> <name> [options]

ArNS naming for Arweave-served artifacts. A name registered on the ar.io
registry resolves at every ar.io gateway (https://<name>.<gateway>/), pointing
at whatever Arweave txId its ANT record targets (10 undernames included).

Names are OWNED and PAID FOR by this rig identity's Solana key — the same
mnemonic that pays for pushes (derived at m/44'/501'/0'/0'). Fund it with
\`rig fund --chain solana\`. Purchases spend mARIO on Solana via the ar.io
registry program — NOT through TOON ILP payment channels.

Commands:
  name buy <name> [--years n | --permabuy]
                       quote (mARIO) → confirm → register. The spawned ANT is
                       owned by this identity's Solana key. Default: 1-year
                       lease. PAID — spends mARIO from the Solana wallet.
  name set <name> <txId> [--undername <sub>] [--ttl <seconds>]
                       point the name (or an undername) at an Arweave txId
                       (typically a deployed path manifest). Signs an ANT
                       record update with the Solana key.
  name status <name>   FREE: registry record (lease/permabuy, expiry), ANT
                       process id, current target txId(s), TTL, undernames.

Options:
  --years <n>          lease length in years (buy; default 1; mutually
                       exclusive with --permabuy)
  --permabuy           permanent registration instead of a lease (buy)
  --undername <sub>    target the undername <sub>_<name> instead of the base
                       name (set)
  --ttl <seconds>      record TTL in seconds (set; default 3600)
  --network <net>      registry: mainnet | devnet | testnet (default mainnet;
                       or RIG_ARIO_NETWORK). Non-mainnet gateway resolution is
                       unverified.
  --process-id <id>    explicit registry process id (overrides --network; or
                       RIG_ARIO_PROCESS_ID)
  --yes                skip the confirmation (required when not a TTY) for
                       buy/set
  --json               machine-readable envelope; for buy/set without --yes it
                       is a pure estimate (nothing is bought or written)
  -h, --help           show this help`;

// ---------------------------------------------------------------------------
// Shared setup: identity → Solana key → SDK
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_LEASE_YEARS = 1;
const NETWORKS: readonly ArioNetwork[] = ['mainnet', 'devnet', 'testnet'];

/** Resolved wallet context shared by every `rig name` action. */
interface NameContext {
  identity: IdentityReport;
  solanaAddress: string;
  network: ArioNetwork;
  processId: string | undefined;
  sdk: ArnsSdk;
}

/**
 * Resolve the rig identity, derive its Solana key (the owner/payer), and build
 * the (stub-injected in tests) ArNS SDK targeted at the chosen registry.
 */
async function resolveNameContext(
  deps: NameDeps,
  network: ArioNetwork,
  processId: string | undefined
): Promise<NameContext> {
  const { io, env } = deps;
  const resolved = await resolveIdentity({
    env,
    cwd: deps.cwd,
    warn: (line) => io.err(line),
  });
  const identity: IdentityReport = {
    pubkey: resolved.pubkey,
    source: resolved.source,
    sourceLabel: resolved.sourceLabel,
  };
  // Dynamic import: `@toon-protocol/client` is heavy — the same lazy load
  // `rig fund`/`rig balance` use to derive the multi-chain identity.
  const client = await import('@toon-protocol/client');
  const derived = await client.deriveFullIdentity(
    resolved.mnemonic,
    resolved.accountIndex
  );
  const solanaAddress = derived.solana.publicKey;
  if (!solanaAddress) {
    throw new Error(
      'no Solana key could be derived for this identity — ArNS names are ' +
        'owned by the Solana key (m/44\'/501\'/0\'/0\'). Ensure the optional ' +
        'Solana derivation deps are installed.'
    );
  }
  const sdk = await (deps.loadArns ?? defaultLoadArns)({
    solanaSecretKey: derived.solana.secretKey,
    solanaPublicKey: solanaAddress,
    network,
    ...(processId !== undefined ? { processId } : {}),
  });
  return { identity, solanaAddress, network, processId, sdk };
}

// ---------------------------------------------------------------------------
// Parsed flags
// ---------------------------------------------------------------------------

interface NameFlags {
  years?: number;
  permabuy: boolean;
  undername?: string;
  ttl: number;
  network: ArioNetwork;
  processId?: string;
  yes: boolean;
  json: boolean;
}

function parseNameFlags(args: string[], env: NodeJS.ProcessEnv): {
  positionals: string[];
  flags: NameFlags;
} {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      years: { type: 'string' },
      permabuy: { type: 'boolean', default: false },
      undername: { type: 'string' },
      ttl: { type: 'string' },
      network: { type: 'string' },
      'process-id': { type: 'string' },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    return { positionals: ['--help'], flags: { permabuy: false, ttl: 0, network: 'mainnet', yes: false, json: false } };
  }

  let years: number | undefined;
  if (values.years !== undefined) {
    years = Number(values.years);
    if (!Number.isInteger(years) || years <= 0) {
      throw new Error(`--years must be a positive integer, got ${JSON.stringify(values.years)}`);
    }
  }
  if (years !== undefined && values.permabuy) {
    throw new Error('--years and --permabuy are mutually exclusive');
  }

  let ttl = DEFAULT_TTL_SECONDS;
  if (values.ttl !== undefined) {
    ttl = Number(values.ttl);
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error(`--ttl must be a positive integer number of seconds, got ${JSON.stringify(values.ttl)}`);
    }
  }

  const networkRaw = values.network ?? env['RIG_ARIO_NETWORK'] ?? 'mainnet';
  if (!NETWORKS.includes(networkRaw as ArioNetwork)) {
    throw new Error(`--network must be one of ${NETWORKS.join(' | ')}, got ${JSON.stringify(networkRaw)}`);
  }
  const processId = values['process-id'] ?? env['RIG_ARIO_PROCESS_ID'];

  return {
    positionals,
    flags: {
      ...(years !== undefined ? { years } : {}),
      permabuy: values.permabuy ?? false,
      ...(values.undername !== undefined ? { undername: values.undername } : {}),
      ttl,
      network: networkRaw as ArioNetwork,
      ...(processId !== undefined ? { processId } : {}),
      yes: values.yes ?? false,
      json: values.json ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// buy
// ---------------------------------------------------------------------------

interface NameBuyJson {
  command: 'name';
  action: 'buy';
  name: string;
  type: NameType;
  years: number | null;
  network: ArioNetwork;
  processId: string | null;
  identity: IdentityReport;
  solanaAddress: string;
  /** The mARIO quote (base units, string) + a human ARIO figure. */
  quote: { mARIO: string; ARIO: string };
  /** How the purchase settles — always Solana/registry, never ILP. */
  payment: string;
  executed: boolean;
  hint?: string;
  result?: { registryTxId: string; antProcessId: string | null };
}

async function runBuy(
  name: string,
  flags: NameFlags,
  deps: NameDeps
): Promise<number> {
  const { io } = deps;
  const type: NameType = flags.permabuy ? 'permabuy' : 'lease';
  const years = type === 'lease' ? (flags.years ?? DEFAULT_LEASE_YEARS) : null;

  const ctx = await resolveNameContext(deps, flags.network, flags.processId);

  // ── Estimate (quote the mARIO cost) ──────────────────────────────────────
  const mario = await ctx.sdk.getTokenCost({
    intent: 'Buy-Name',
    name,
    type,
    ...(years !== null ? { years } : {}),
  });
  const quote = {
    mARIO: mario.toString(),
    ARIO: formatUnits(mario.toString(), ARIO_DECIMALS),
  };

  const buildJson = (
    executed: boolean,
    extra: Partial<NameBuyJson> = {}
  ): NameBuyJson => ({
    command: 'name',
    action: 'buy',
    name,
    type,
    years,
    network: ctx.network,
    processId: ctx.processId ?? null,
    identity: ctx.identity,
    solanaAddress: ctx.solanaAddress,
    quote,
    payment: MARIO_PAYMENT_NOTE,
    executed,
    ...extra,
  });

  // ── Human estimate table ─────────────────────────────────────────────────
  if (!flags.json) {
    io.out(
      `Buy ArNS name "${name}" — ${type}` +
        (years !== null ? ` (${years} year${years === 1 ? '' : 's'})` : '') +
        ` on ${ctx.network}`
    );
    io.out(`  Cost: ${renderMario(mario)}`);
    io.out(`  Solana wallet: ${ctx.solanaAddress}`);
    io.out(`  ${MARIO_PAYMENT_NOTE}`);
    io.out(renderIdentityLine(ctx.identity));
  }

  // ── Confirm gate ─────────────────────────────────────────────────────────
  if (!flags.yes) {
    if (flags.json) {
      io.emitJson(
        buildJson(false, {
          hint: 'estimate only — re-run with --yes to buy (spends mARIO on Solana, non-refundable)',
        })
      );
      return 0;
    }
    if (!io.isInteractive) {
      io.err(
        'refusing to spend mARIO without confirmation in a non-interactive ' +
          'session — re-run with --yes (or use --json for a pure estimate)'
      );
      return 1;
    }
    const proceed = await io.confirm(
      `Proceed — buy "${name}" for ${renderMario(mario)} from your Solana wallet? [y/N] `
    );
    if (!proceed) {
      io.err('aborted — nothing was bought or paid.');
      return 1;
    }
  }

  // ── Execute (register; the spawned ANT is owned by the Solana key) ────────
  const receipt = await ctx.sdk.buyRecord({
    name,
    type,
    ...(years !== null ? { years } : {}),
  });
  const result = {
    registryTxId: receipt.id,
    antProcessId: receipt.processId ?? null,
  };

  if (flags.json) {
    io.emitJson(buildJson(true, { result }));
  } else {
    io.out(`Registered "${name}" — registry tx ${result.registryTxId}`);
    if (result.antProcessId) io.out(`  ANT process: ${result.antProcessId}`);
    io.out(
      `Point it at content with \`rig name set ${name} <txId>\`, then it ` +
        `resolves at https://${name}.<gateway>/`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

interface NameSetJson {
  command: 'name';
  action: 'set';
  name: string;
  undername: string | null;
  txId: string;
  ttl: number;
  network: ArioNetwork;
  processId: string | null;
  identity: IdentityReport;
  solanaAddress: string;
  antProcessId: string;
  executed: boolean;
  hint?: string;
  result?: { messageId: string };
}

async function runSet(
  name: string,
  txId: string,
  flags: NameFlags,
  deps: NameDeps
): Promise<number> {
  const { io } = deps;
  const ctx = await resolveNameContext(deps, flags.network, flags.processId);

  const record = await ctx.sdk.getArNSRecord({ name });
  if (!record || !record.processId) {
    throw new Error(
      `no ArNS record for "${name}" on ${ctx.network} — buy it first with ` +
        `\`rig name buy ${name}\` (or check \`rig name status ${name}\`)`
    );
  }
  const antProcessId = record.processId;
  const undername = flags.undername ?? null;

  const buildJson = (
    executed: boolean,
    extra: Partial<NameSetJson> = {}
  ): NameSetJson => ({
    command: 'name',
    action: 'set',
    name,
    undername,
    txId,
    ttl: flags.ttl,
    network: ctx.network,
    processId: ctx.processId ?? null,
    identity: ctx.identity,
    solanaAddress: ctx.solanaAddress,
    antProcessId,
    executed,
    ...extra,
  });

  const targetLabel = undername ? `undername "${undername}_${name}"` : `base name "${name}"`;

  if (!flags.json) {
    io.out(`Set ${targetLabel} → txId ${txId} (ttl ${flags.ttl}s) on ${ctx.network}`);
    io.out(`  ANT process: ${antProcessId}`);
    io.out(`  Signed by the identity's Solana key (${ctx.solanaAddress}).`);
    io.out(renderIdentityLine(ctx.identity));
  }

  // ── Confirm gate (a signed ANT record update) ────────────────────────────
  if (!flags.yes) {
    if (flags.json) {
      io.emitJson(
        buildJson(false, {
          hint: 'estimate only — re-run with --yes to write the ANT record',
        })
      );
      return 0;
    }
    if (!io.isInteractive) {
      io.err(
        'refusing to write an ANT record without confirmation in a ' +
          'non-interactive session — re-run with --yes (or --json to preview)'
      );
      return 1;
    }
    const proceed = await io.confirm(
      `Proceed — point ${targetLabel} at ${txId}? [y/N] `
    );
    if (!proceed) {
      io.err('aborted — the ANT record was not changed.');
      return 1;
    }
  }

  // ── Execute (sign + submit the ANT record update) ────────────────────────
  const ant = await ctx.sdk.ant(antProcessId);
  const receipt = undername
    ? await ant.setUndernameRecord({ undername, transactionId: txId, ttlSeconds: flags.ttl })
    : await ant.setBaseNameRecord({ transactionId: txId, ttlSeconds: flags.ttl });
  const result = { messageId: receipt.id };

  if (flags.json) {
    io.emitJson(buildJson(true, { result }));
  } else {
    io.out(`Updated — ANT message ${result.messageId}`);
    const host = undername ? `${undername}_${name}` : name;
    io.out(`  Resolves at https://${host}.<gateway>/ (allow for gateway cache/TTL).`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// status (FREE)
// ---------------------------------------------------------------------------

interface NameStatusJson {
  command: 'name';
  action: 'status';
  name: string;
  network: ArioNetwork;
  processId: string | null;
  registered: boolean;
  identity: IdentityReport;
  solanaAddress: string;
  record: {
    antProcessId: string | null;
    type: NameType | null;
    startTimestamp: number | null;
    endTimestamp: number | null;
    undernameLimit: number | null;
  } | null;
  /** ANT record targets keyed by undername (`@` = base name). */
  targets: Record<string, AntRecordTarget> | null;
}

async function runStatus(
  name: string,
  flags: NameFlags,
  deps: NameDeps
): Promise<number> {
  const { io } = deps;
  const ctx = await resolveNameContext(deps, flags.network, flags.processId);

  const record = await ctx.sdk.getArNSRecord({ name });
  let targets: Record<string, AntRecordTarget> | null = null;
  if (record?.processId) {
    const ant = await ctx.sdk.ant(record.processId);
    targets = await ant.getRecords();
  }

  if (flags.json) {
    io.emitJson({
      command: 'name',
      action: 'status',
      name,
      network: ctx.network,
      processId: ctx.processId ?? null,
      registered: record !== null,
      identity: ctx.identity,
      solanaAddress: ctx.solanaAddress,
      record: record
        ? {
            antProcessId: record.processId,
            type: record.type,
            startTimestamp: record.startTimestamp ?? null,
            endTimestamp: record.endTimestamp ?? null,
            undernameLimit: record.undernameLimit ?? null,
          }
        : null,
      targets,
    } satisfies NameStatusJson);
    return 0;
  }

  io.out(`ArNS name "${name}" on ${ctx.network}:`);
  if (!record) {
    io.out('  not registered — available to `rig name buy`.');
    io.out(renderIdentityLine(ctx.identity));
    return 0;
  }
  io.out(`  ANT process: ${record.processId ?? '(unknown)'}`);
  io.out(`  Type: ${record.type ?? '(unknown)'}`);
  if (record.type === 'permabuy') {
    io.out('  Expiry: never (permabuy)');
  } else if (record.endTimestamp !== undefined) {
    io.out(`  Expiry: ${new Date(record.endTimestamp).toISOString()}`);
  }
  if (record.undernameLimit !== undefined) {
    io.out(`  Undernames included: ${record.undernameLimit}`);
  }
  if (targets && Object.keys(targets).length > 0) {
    io.out('  Records:');
    for (const [under, target] of Object.entries(targets)) {
      const label = under === '@' ? '(base)' : `${under}_${name}`;
      io.out(`    ${label} → ${target.transactionId} (ttl ${target.ttlSeconds}s)`);
    }
  } else {
    io.out('  Records: none set — point one with `rig name set`.');
  }
  io.out(renderIdentityLine(ctx.identity));
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run `rig name <sub> …`; returns the process exit code. */
export async function runName(args: string[], deps: NameDeps): Promise<number> {
  const { io } = deps;
  const sub = args[0];

  if (sub === undefined) {
    // Usage error → stderr + exit 2 (matches every other rig-owned command).
    io.err(NAME_USAGE);
    return 2;
  }
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    io.out(NAME_USAGE);
    return 0;
  }
  if (!['buy', 'set', 'status'].includes(sub)) {
    io.err(`unknown \`rig name\` subcommand: ${JSON.stringify(sub)}`);
    io.err(NAME_USAGE);
    return 2;
  }

  let positionals: string[];
  let flags: NameFlags;
  try {
    const parsed = parseNameFlags(args.slice(1), deps.env);
    positionals = parsed.positionals;
    flags = parsed.flags;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(NAME_USAGE);
    return 2;
  }
  if (positionals[0] === '--help') {
    io.out(NAME_USAGE);
    return 0;
  }

  const name = positionals[0];
  if (name === undefined) {
    io.err(`\`rig name ${sub}\` needs a <name>`);
    io.err(NAME_USAGE);
    return 2;
  }

  try {
    if (sub === 'buy') return await runBuy(name, flags, deps);
    if (sub === 'status') return await runStatus(name, flags, deps);
    // set: `rig name set <name> <txId>`
    const txId = positionals[1];
    if (txId === undefined) {
      io.err('`rig name set` needs a <txId> (the Arweave transaction to point at)');
      io.err(NAME_USAGE);
      return 2;
    }
    return await runSet(name, txId, flags, deps);
  } catch (err) {
    return emitCliError(io, flags.json, 'name', err);
  }
}
