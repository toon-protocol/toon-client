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
 * SDK WIRING (#376): `@ar.io/sdk` >= 4.0.3 is Solana-native. There is no
 * `SolanaSigner` class and no AO registry process id, and `ARIO.init()` builds
 * NO default rpc — the caller constructs everything from `@solana/kit`:
 * `createSolanaRpc` (all calls), plus `createSolanaRpcSubscriptions` and a
 * `createKeyPairSignerFromBytes` signer for writes only. The FREE read path
 * (`status`) therefore runs signerless ({@link LoadArnsOptions.mode}) — reads
 * being free is the rig discipline everywhere else. This surface is pinned by
 * a live smoke test against the published SDK
 * (`src/__integration__/arns-live-read.integration.test.ts`), because both
 * #376 bugs came from coding against an API no released version exports.
 *
 * DEVNET (#367 open question, revised by #376): post-migration, registry
 * selection is a Solana CLUSTER, not an AO process id — `--network
 * mainnet|devnet` (or `RIG_ARIO_NETWORK`) picks the cluster (devnet applies
 * the SDK's `DEVNET_PROGRAM_IDS`); ar.io deploys nothing on Solana's testnet
 * cluster, so `testnet` is rejected up front. `--process-id <id>` (or
 * `RIG_ARIO_PROCESS_ID`) overrides the ArNS registry program id outright.
 * Defaults to mainnet.
 */

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { formatUnits } from './balance.js';
import { emitCliError } from './errors.js';
import { resolveEffectiveNetwork } from './fund.js';
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

/**
 * The brokered ("buyfor") counterpart of {@link MARIO_PAYMENT_NOTE}: with
 * `--via <dvm>`, a store DVM pays the mARIO name price from ITS wallet by
 * executing the kind:5095 ArNS-buy job — this identity never holds $ARIO.
 * The client still OWNS the name from inception, because the job carries the
 * processId of an ANT this identity spawned and owns (`ANT.spawn` costs only
 * dust SOL). Exported so the buy output and the tests pin one string.
 */
export const DVM_PAYMENT_NOTE =
  'Brokered buy (--via): the DVM pays the mARIO name price from ITS Solana ' +
  'wallet via the kind:5095 job; this wallet needs only dust SOL to spawn ' +
  'the ANT it owns. On the paid path the job fee is enforced by the ' +
  'connector payment proxy in front of the DVM; when --via targets the DVM ' +
  'backend directly the job payment is STUBBED (dev/e2e only). The ArNS ' +
  'purchase itself is real either way, and the name is owned by YOUR ANT ' +
  'from inception.';

// ---------------------------------------------------------------------------
// The ar.io SDK seam (lazily imported; tests inject a stub — NEVER the live net)
// ---------------------------------------------------------------------------

/** A name registration kind: a time-boxed lease or a one-time permabuy. */
export type NameType = 'lease' | 'permabuy';

/**
 * The Solana clusters ar.io deploys its programs to; mainnet is the default.
 * (No `testnet`: ar.io has no deployment on Solana's testnet cluster — #376.)
 */
export type ArioNetwork = 'mainnet' | 'devnet';

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
  /**
   * Spawn a fresh ANT owned by THIS identity's Solana key (`ANT.spawn` —
   * mints the MPL Core asset + initializes the ario-ant PDAs; costs only
   * rent/fee dust, no $ARIO). The returned `processId` (the asset pubkey) is
   * what a brokered `--via` buy hands the DVM so the client owns the bought
   * name from inception. Write mode only — a signerless SDK must throw.
   */
  spawnAnt(args: {
    name: string;
  }): Promise<{ processId: string; signature: string }>;
  /**
   * Build (do NOT send) a partially-signed ANT record-set transaction for
   * the gas-station path (toon-meta#163): feePayer = the DVM's advertised
   * gas wallet, lifetime = the quoted blockhash, caller = THIS identity's
   * Solana key, which partial-signs. Returns the base64 wire transaction
   * ready for a kind:5096 execute job. Write mode only.
   */
  buildSetRecordTransaction(args: {
    antProcessId: string;
    /** `@` for the base name. */
    undername: string;
    transactionId: string;
    ttlSeconds: number;
    feePayer: string;
    recentBlockhash: string;
  }): Promise<string>;
  /** Read a name's current registry record (free). */
  getArNSRecord(args: { name: string }): Promise<ArnsRecordView | null>;
  /** Bind an ANT handle for a name's process id (for `set` / `status`). */
  ant(processId: string): Promise<ArnsAnt>;
}

/** What the {@link LoadArns} seam needs to build a targeted SDK. */
export interface LoadArnsOptions {
  /**
   * Which capability the caller needs (#376). `read` builds a SIGNERLESS,
   * read-only client — the FREE lookups (`status`, cost quotes) must never
   * require write plumbing. `write` additionally derives a `@solana/kit`
   * signer from `solanaSecretKey` and wires the rpc-subscriptions client that
   * transaction confirmation requires.
   */
  mode: 'read' | 'write';
  /**
   * 64-byte Ed25519 Solana keypair (secretKey ‖ publicKey) that owns and
   * pays — consumed only in `write` mode (readers never touch it).
   */
  solanaSecretKey: Uint8Array;
  /** Solana public key (base58) — for the signer + human messaging. */
  solanaPublicKey: string;
  /** Which cluster's ar.io deployment to target. */
  network: ArioNetwork;
  /** Explicit ArNS registry program id override (wins over `network`). */
  processId?: string;
}

/** Build a network-targeted {@link ArnsSdk} (tests inject a stub). */
export type LoadArns = (options: LoadArnsOptions) => Promise<ArnsSdk>;

/**
 * The minimum `@ar.io/sdk` release `rig name` is built against: the first
 * Solana-native surface verified to expose the clients the default loader
 * wires (`ARIO.init`/`ANT.init` over a caller-built `@solana/kit` rpc, signer
 * optional). Mirrored by the `optionalDependencies` pin in package.json.
 */
export const MIN_ARIO_SDK_VERSION = '4.0.3';

/**
 * An optional module (`@ar.io/sdk`, or its `@solana/kit` companion) is not
 * installed. Optional-dependency by design (#367): surface a clean,
 * actionable message instead of a module-resolution stack trace. Distinct
 * from {@link ArnsSdkIncompatibleError} — "not installed" and "installed but
 * the wrong API surface" need different remediations (#376).
 */
export class ArnsSdkUnavailableError extends Error {
  constructor(cause?: unknown, module = '@ar.io/sdk') {
    super(
      `\`rig name\` needs the optional \`${module}\` dependency, which is not ` +
        'installed. It is intentionally NOT a base `rig` dependency (keeps the ' +
        'install lean). Add it to use ArNS naming:\n' +
        `  npm i @ar.io/sdk@^${MIN_ARIO_SDK_VERSION}    # or: pnpm add @ar.io/sdk@^${MIN_ARIO_SDK_VERSION}\n` +
        '(`@solana/kit` installs alongside it) then re-run your `rig name` ' +
        'command.' +
        (cause instanceof Error ? `\n(underlying error: ${cause.message})` : '')
    );
    this.name = 'ArnsSdkUnavailableError';
  }
}

/**
 * `@ar.io/sdk` (or `@solana/kit`) IS installed but exposes an API surface
 * `rig name` cannot drive — e.g. a pre-Solana-migration build. Kept separate
 * from {@link ArnsSdkUnavailableError} so users are never told to install a
 * package they already have (#376: the old message sent users chasing an
 * upgrade that did not exist).
 */
export class ArnsSdkIncompatibleError extends Error {
  constructor(detail: string) {
    super(
      `the installed @ar.io/sdk is incompatible with \`rig name\`: ${detail}.\n` +
        `\`rig name\` requires @ar.io/sdk >= ${MIN_ARIO_SDK_VERSION} (the ` +
        'Solana-native release driven via a `@solana/kit` rpc + signer). ' +
        'Upgrade with:\n' +
        '  npm i @ar.io/sdk@latest    # or: pnpm add @ar.io/sdk@latest'
    );
    this.name = 'ArnsSdkIncompatibleError';
  }
}

/** Public Solana RPC endpoints (fallbacks when the SDK exports none). */
const SOLANA_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';
const SOLANA_DEVNET_RPC_URL = 'https://api.devnet.solana.com';

/**
 * The untyped shape of the pieces of `@ar.io/sdk` the default loader reaches
 * for (verified against the published 4.0.3). Kept local (the package is
 * optional and its types are not a build dep) and cast through `unknown` —
 * never `any`, so eslint's no-explicit-any holds.
 */
interface RawArioModule {
  ARIO?: {
    init?: (config: unknown) => RawArioInstance;
  };
  ANT?: {
    /** 4.x resolves the ANT program from the asset, hence async. */
    init?: (config: unknown) => Promise<RawAntInstance>;
    /** 4.x Solana `ANT.spawn` — mints the MPL Core asset (write only). */
    spawn?: (
      params: unknown
    ) => Promise<{ processId: string; signature: string }>;
  };
  DEFAULT_SOLANA_RPC_URL?: string;
  MAINNET_RPC_URL?: string;
  DEVNET_RPC_URL?: string;
  /** Devnet (staging) program-id overrides — required off mainnet. */
  DEVNET_PROGRAM_IDS?: {
    core?: string;
    gar?: string;
    arns?: string;
    ant?: string;
  };
  /** Root-exported PDA helper: (mint, undername, antProgramId?) → [pda]. */
  getAntRecordPDA?: (
    mint: unknown,
    undername: string,
    programId?: unknown
  ) => Promise<readonly unknown[]>;
}
interface RawArioInstance {
  getTokenCost: (args: unknown) => Promise<unknown>;
  /** Present only on the writeable (signer-built) client. */
  buyRecord?: (args: unknown) => Promise<unknown>;
  getArNSRecord: (args: unknown) => Promise<unknown>;
}
interface RawAntInstance {
  getRecords: () => Promise<
    Record<string, { transactionId: string; ttlSeconds: number }>
  >;
  /** Present only on the writeable (signer-built) client. */
  setBaseNameRecord?: (args: unknown) => Promise<{ id: string }>;
  setUndernameRecord?: (args: unknown) => Promise<{ id: string }>;
}
/** The three `@solana/kit` factories the Solana-native SDK is driven with. */
interface RawSolanaKitModule {
  createSolanaRpc?: (url: string) => unknown;
  createSolanaRpcSubscriptions?: (url: string) => unknown;
  createKeyPairSignerFromBytes?: (bytes: Uint8Array) => Promise<unknown>;
  // ── extras the gas-station tx builder uses (all loose-typed on purpose:
  //    the optional module's types are not a build dep) ──
  createKeyPairFromBytes?: (bytes: Uint8Array) => Promise<unknown>;
  createNoopSigner?: (addr: unknown) => unknown;
  address?: (s: string) => unknown;
  blockhash?: (s: string) => unknown;
  createTransactionMessage?: (o: { version: number }) => unknown;
  setTransactionMessageFeePayer?: (a: unknown, m: unknown) => unknown;
  setTransactionMessageLifetimeUsingBlockhash?: (
    l: unknown,
    m: unknown
  ) => unknown;
  appendTransactionMessageInstructions?: (ix: unknown[], m: unknown) => unknown;
  compileTransaction?: (m: unknown) => unknown;
  partiallySignTransaction?: (kps: unknown[], tx: unknown) => Promise<unknown>;
  getBase64EncodedWireTransaction?: (tx: unknown) => string;
}
/** The `@ar.io/solana-contracts/ant` slice the record-set builder uses. */
interface RawAntContractsModule {
  getSetRecordInstructionAsync?: (
    input: Record<string, unknown>,
    config?: { programAddress?: unknown }
  ) => Promise<unknown>;
}

/**
 * Default {@link LoadArns}: lazily `import('@ar.io/sdk')` + `@solana/kit` and
 * adapt them to our seam. Specifiers are stored in `string`-typed variables so
 * TypeScript does not try to resolve the optional modules at build time; a
 * missing package surfaces as {@link ArnsSdkUnavailableError}, a wrong API
 * surface as {@link ArnsSdkIncompatibleError}.
 *
 * THE #376 LESSON, load-bearing: the SDK provides NO defaults. Bare
 * `ARIO.init()` throws and `ARIO.init({})` produces a client whose every read
 * fails — the caller must build the rpc (`createSolanaRpc`) explicitly, and
 * for writes also `rpcSubscriptions` + a `createKeyPairSignerFromBytes`
 * signer. Read mode constructs NO signer at all, so free lookups need zero
 * key material at the SDK layer.
 *
 * NOTE: no test drives this adapter against the live registry except the
 * env-gated smoke test (`__integration__/arns-live-read.integration.test.ts`,
 * FREE reads only) — every money-moving path runs ONLY against injected
 * stubs, and no real $ARIO is ever spent by code we run.
 */
export const defaultLoadArns: LoadArns = async (options) => {
  // Cast to `string` (not a literal type) so TypeScript does not try to
  // resolve the OPTIONAL modules at build time — a missing package must
  // surface as a clean runtime error, not a compile failure.
  const sdkSpecifier = '@ar.io/sdk' as string;
  let mod: RawArioModule;
  try {
    mod = (await import(sdkSpecifier)) as unknown as RawArioModule;
  } catch (err) {
    throw new ArnsSdkUnavailableError(err);
  }
  // `@solana/kit` carries the rpc/signer factories the Solana-native SDK is
  // driven with. It is a dependency of `@ar.io/sdk` AND declared in rig's own
  // optionalDependencies so strict (pnpm-style) layouts resolve it here too.
  const kitSpecifier = '@solana/kit' as string;
  let kit: RawSolanaKitModule;
  try {
    kit = (await import(kitSpecifier)) as unknown as RawSolanaKitModule;
  } catch (err) {
    throw new ArnsSdkUnavailableError(err, '@solana/kit');
  }

  const arioInit = mod.ARIO?.init;
  const antInit = mod.ANT?.init;
  if (!arioInit || !antInit) {
    throw new ArnsSdkIncompatibleError('it exposes no ARIO.init / ANT.init');
  }
  const {
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createKeyPairSignerFromBytes,
  } = kit;
  if (
    !createSolanaRpc ||
    !createSolanaRpcSubscriptions ||
    !createKeyPairSignerFromBytes
  ) {
    throw new ArnsSdkIncompatibleError(
      'the resolved @solana/kit exposes no createSolanaRpc / ' +
        'createSolanaRpcSubscriptions / createKeyPairSignerFromBytes'
    );
  }

  // Cluster targeting: rpc endpoint + (off mainnet) program-id overrides.
  const rpcUrl =
    options.network === 'devnet'
      ? (mod.DEVNET_RPC_URL ?? SOLANA_DEVNET_RPC_URL)
      : (mod.DEFAULT_SOLANA_RPC_URL ??
        mod.MAINNET_RPC_URL ??
        SOLANA_MAINNET_RPC_URL);
  const devnetIds =
    options.network === 'devnet' ? mod.DEVNET_PROGRAM_IDS : undefined;
  if (options.network === 'devnet' && devnetIds === undefined) {
    throw new ArnsSdkIncompatibleError(
      'it exposes no DEVNET_PROGRAM_IDS — devnet targeting needs the ' +
        "SDK's staging program ids"
    );
  }
  const antProgramId = devnetIds?.ant;
  const programOverrides = {
    ...(devnetIds?.core !== undefined ? { coreProgramId: devnetIds.core } : {}),
    ...(devnetIds?.gar !== undefined ? { garProgramId: devnetIds.gar } : {}),
    ...(devnetIds?.arns !== undefined ? { arnsProgramId: devnetIds.arns } : {}),
    ...(antProgramId !== undefined ? { antProgramId } : {}),
    // --process-id / RIG_ARIO_PROCESS_ID: explicit ArNS registry program
    // override (wins over the cluster default).
    ...(options.processId !== undefined
      ? { arnsProgramId: options.processId }
      : {}),
  };

  // Build the transport(s) explicitly — see the #376 lesson above. Write mode
  // alone derives the signer (from the identity's 64-byte Ed25519 keypair)
  // and the ws subscriptions client that transaction confirmation needs.
  const rpc = createSolanaRpc(rpcUrl);
  const writeExtras =
    options.mode === 'write'
      ? {
          signer: await createKeyPairSignerFromBytes(options.solanaSecretKey),
          rpcSubscriptions: createSolanaRpcSubscriptions(
            rpcUrl.replace(/^http/, 'ws')
          ),
        }
      : {};
  const ario = arioInit({ rpc, ...writeExtras, ...programOverrides });

  return {
    getTokenCost: async (args) => BigInt(String(await ario.getTokenCost(args))),
    buyRecord: async (args) => {
      if (typeof ario.buyRecord !== 'function') {
        throw new ArnsSdkIncompatibleError(
          'the signed ARIO client exposes no buyRecord'
        );
      }
      return (await ario.buyRecord(args)) as { id: string; processId?: string };
    },
    spawnAnt: async (args) => {
      const spawn = mod.ANT?.spawn;
      if (typeof spawn !== 'function') {
        throw new ArnsSdkIncompatibleError('it exposes no ANT.spawn');
      }
      if (options.mode !== 'write') {
        // Mirrors the SDK's own contract: spawning signs a transaction, so a
        // signerless (read) client must never attempt it.
        throw new ArnsSdkIncompatibleError(
          'ANT.spawn requires the write-mode SDK (a signer) — this client ' +
            'was built signerless'
        );
      }
      const result = await spawn({
        rpc,
        ...writeExtras,
        state: { name: args.name },
        ...(antProgramId !== undefined ? { antProgramId } : {}),
      });
      return { processId: result.processId, signature: result.signature };
    },
    buildSetRecordTransaction: async (args) => {
      if (options.mode !== 'write') {
        throw new ArnsSdkIncompatibleError(
          'buildSetRecordTransaction requires the write-mode SDK (a client ' +
            'partial-signature) — this client was built signerless'
        );
      }
      const contractsSpecifier = '@ar.io/solana-contracts/ant' as string;
      let contracts: RawAntContractsModule;
      try {
        contracts = (await import(
          contractsSpecifier
        )) as unknown as RawAntContractsModule;
      } catch (err) {
        throw new ArnsSdkUnavailableError(err, '@ar.io/solana-contracts');
      }
      const getSetRecordInstructionAsync = contracts.getSetRecordInstructionAsync;
      const getAntRecordPDA = mod.getAntRecordPDA;
      const {
        createKeyPairFromBytes,
        createNoopSigner,
        address: toAddr,
        blockhash: toBlockhash,
        createTransactionMessage,
        setTransactionMessageFeePayer,
        setTransactionMessageLifetimeUsingBlockhash,
        appendTransactionMessageInstructions,
        compileTransaction,
        partiallySignTransaction,
        getBase64EncodedWireTransaction,
      } = kit;
      if (
        !getSetRecordInstructionAsync ||
        !getAntRecordPDA ||
        !createKeyPairFromBytes ||
        !createNoopSigner ||
        !toAddr ||
        !toBlockhash ||
        !createTransactionMessage ||
        !setTransactionMessageFeePayer ||
        !setTransactionMessageLifetimeUsingBlockhash ||
        !appendTransactionMessageInstructions ||
        !compileTransaction ||
        !partiallySignTransaction ||
        !getBase64EncodedWireTransaction
      ) {
        throw new ArnsSdkIncompatibleError(
          'the installed @ar.io/sdk / @ar.io/solana-contracts / @solana/kit ' +
            'do not expose the record-set transaction builder surface'
        );
      }

      const asset = toAddr(args.antProcessId);
      const antProgram =
        antProgramId !== undefined ? toAddr(antProgramId) : undefined;
      const [recordPda] = await getAntRecordPDA(
        asset,
        args.undername,
        antProgram
      );
      // The client is the record CALLER (authority) — a noop signer here so
      // the compiled account meta is marked signer; the real signature comes
      // from partiallySignTransaction below. The DVM's gas wallet is ONLY
      // the fee payer.
      const ix = await getSetRecordInstructionAsync(
        {
          asset,
          record: recordPda,
          caller: createNoopSigner(toAddr(options.solanaPublicKey)),
          undername: args.undername,
          target: args.transactionId,
          targetProtocol: 0,
          ttlSeconds: args.ttlSeconds,
          priority: null,
          recordOwner: null,
        },
        antProgram !== undefined ? { programAddress: antProgram } : undefined
      );

      let message = createTransactionMessage({ version: 0 });
      message = setTransactionMessageFeePayer(toAddr(args.feePayer), message);
      message = setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: toBlockhash(args.recentBlockhash),
          lastValidBlockHeight: 0n,
        },
        message
      );
      message = appendTransactionMessageInstructions([ix], message);

      const keyPair = await createKeyPairFromBytes(options.solanaSecretKey);
      const signed = await partiallySignTransaction(
        [keyPair],
        compileTransaction(message)
      );
      return getBase64EncodedWireTransaction(signed);
    },
    getArNSRecord: async (args) => {
      // 4.x throws on an unregistered name; our seam reports `null` so
      // `status` can render "available" instead of an error.
      let raw: {
        processId?: string;
        type?: NameType;
        startTimestamp?: number;
        endTimestamp?: number;
        undernameLimit?: number;
      };
      try {
        raw = (await ario.getArNSRecord(args)) as typeof raw;
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) return null;
        throw err;
      }
      // Solana-native records carry cluster unix timestamps in SECONDS; the
      // seam contract (and the human expiry render) is ms epoch.
      return {
        processId: raw.processId ?? null,
        type: raw.type ?? null,
        ...(raw.startTimestamp !== undefined
          ? { startTimestamp: raw.startTimestamp * 1000 }
          : {}),
        ...(raw.endTimestamp !== undefined
          ? { endTimestamp: raw.endTimestamp * 1000 }
          : {}),
        ...(raw.undernameLimit !== undefined
          ? { undernameLimit: raw.undernameLimit }
          : {}),
      };
    },
    ant: async (pid) => {
      const ant = await antInit({
        processId: pid,
        rpc,
        ...writeExtras,
        ...(antProgramId !== undefined ? { antProgramId } : {}),
      });
      return {
        getRecords: async () => {
          // Pin the seam shape: 4.x records carry extra fields (index,
          // targetProtocol, …) that must not leak into the `--json` contract.
          const records = await ant.getRecords();
          const targets: Record<string, AntRecordTarget> = {};
          for (const [undername, record] of Object.entries(records)) {
            targets[undername] = {
              transactionId: record.transactionId,
              ttlSeconds: record.ttlSeconds,
            };
          }
          return targets;
        },
        setBaseNameRecord: async (a) => {
          if (typeof ant.setBaseNameRecord !== 'function') {
            throw new ArnsSdkIncompatibleError(
              'the signed ANT client exposes no setBaseNameRecord'
            );
          }
          return ant.setBaseNameRecord(a);
        },
        setUndernameRecord: async (a) => {
          if (typeof ant.setUndernameRecord !== 'function') {
            throw new ArnsSdkIncompatibleError(
              'the signed ANT client exposes no setUndernameRecord'
            );
          }
          return ant.setUndernameRecord(a);
        },
      };
    },
  };
};

// ---------------------------------------------------------------------------
// The brokered-buy DVM job seam (#buyfor)
// ---------------------------------------------------------------------------

/**
 * The NIP-90 job kind for a brokered ArNS name purchase — mirrors the store
 * repo's `ARNS_BUY_KIND` (the DVM registers this next to its kind:5094
 * Arweave storage job).
 */
export const ARNS_BUY_JOB_KIND = 5095;

/** One brokered buy job, ready to submit to a DVM. */
export interface DvmBuyJobRequest {
  /** The DVM endpoint `--via` resolved (the store backend base URL). */
  viaUrl: string;
  name: string;
  type: NameType;
  /** Lease years; null for a permabuy. */
  years: number | null;
  /** The CLIENT's freshly-spawned ANT (asset pubkey) — the owner-to-be. */
  processId: string;
  /** Nostr secret key that signs the job event (the rig identity). */
  nostrSecretKey: Uint8Array;
}

/** What the DVM reports back for an executed buy job. */
export interface DvmBuyJobReceipt {
  /** Registry transaction signature of the DVM-paid buy. */
  registryTxId: string;
  /** The mARIO the DVM quoted/paid, when reported. */
  quotedMario: string | null;
  /** The permissionless `syncAttributes` reconcile tx, when it succeeded. */
  syncAttributesTxId: string | null;
}

/** Submit one kind:5095 job (tests inject a stub — NEVER the live net). */
export type SubmitDvmBuyJob = (
  request: DvmBuyJobRequest
) => Promise<DvmBuyJobReceipt>;

/** A DVM refused or failed a brokered buy job. */
export class DvmBuyJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DvmBuyJobError';
  }
}

/**
 * Default {@link SubmitDvmBuyJob}: sign a kind:5095 event carrying the job as
 * NIP-90 `param` tags and POST it to the DVM's payment-oblivious `/store`
 * backend. This is the DIRECT interface — on the paid path the identical
 * event travels inside a paid ILP packet and the connector in front of the
 * DVM replays this same HTTP request after terminating payment
 * (RouteTermination), so the job shape is one and the same.
 */
export const defaultSubmitDvmBuyJob: SubmitDvmBuyJob = async (request) => {
  const { finalizeEvent } = await import('nostr-tools/pure');
  const event = finalizeEvent(
    {
      kind: ARNS_BUY_JOB_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['param', 'name', request.name],
        ['param', 'type', request.type],
        ...(request.years !== null
          ? [['param', 'years', String(request.years)]]
          : []),
        ['param', 'processId', request.processId],
      ],
    },
    request.nostrSecretKey
  );

  const url = `${request.viaUrl.replace(/\/+$/, '')}/store`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
  } catch (err) {
    throw new DvmBuyJobError(
      `could not reach the DVM at ${url}: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  let body: {
    accept?: boolean;
    code?: string;
    message?: string;
    result?: {
      registryTxId?: unknown;
      quotedMario?: unknown;
      syncAttributesTxId?: unknown;
    };
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new DvmBuyJobError(
      `the DVM at ${url} returned a non-JSON response (HTTP ${response.status})`
    );
  }
  if (!response.ok || body.accept !== true) {
    throw new DvmBuyJobError(
      `the DVM rejected the kind:${ARNS_BUY_JOB_KIND} buy job ` +
        `(HTTP ${response.status}${body.code ? `, ${body.code}` : ''})` +
        `${body.message ? `: ${body.message}` : ''}`
    );
  }
  const registryTxId = body.result?.registryTxId;
  if (typeof registryTxId !== 'string' || registryTxId.length === 0) {
    throw new DvmBuyJobError(
      `the DVM accepted the job but returned no registryTxId — response: ` +
        JSON.stringify(body.result ?? null)
    );
  }
  return {
    registryTxId,
    quotedMario:
      typeof body.result?.quotedMario === 'string'
        ? body.result.quotedMario
        : null,
    syncAttributesTxId:
      typeof body.result?.syncAttributesTxId === 'string'
        ? body.result.syncAttributesTxId
        : null,
  };
};

// ---------------------------------------------------------------------------
// The gas-station job seam (kind:5096 — toon-meta#163)
// ---------------------------------------------------------------------------

/** The NIP-90 job kind for a gas-station (fee-payer-as-a-service) job. */
export const GAS_STATION_JOB_KIND = 5096;

/** A kind:5096 quote — the merged quote/blockhash deadline contract. */
export interface GasStationQuote {
  quoteId: string;
  /** The DVM's advertised fee-payer address — set as the tx feePayer. */
  feePayer: string;
  /** The delta cap the DVM will enforce (lamports, base-10 string). */
  maxLamports: string;
  /** Build + partial-sign against exactly this blockhash. */
  recentBlockhash: string;
  /** ms epoch — submit before this or re-quote. */
  expiresAt: number;
}

/** A landed kind:5096 execute result. */
export interface GasStationExecuteResult {
  signature: string;
  slot: string | null;
  feeLamportsActual: string | null;
  replayed?: boolean;
}

/** The DVM refused or failed a gas-station job (machine-readable reason). */
export class GasStationJobError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'GasStationJobError';
  }
}

/** kind:5096 client seam (tests inject a stub — NEVER the live net). */
export interface GasStationClient {
  quote(args: {
    viaUrl: string;
    /** Optional draft wire tx for an accurate (rent-aware) maxLamports. */
    transaction?: string;
    nostrSecretKey: Uint8Array;
  }): Promise<GasStationQuote>;
  execute(args: {
    viaUrl: string;
    transaction: string;
    quoteId: string;
    idempotencyKey: string;
    nostrSecretKey: Uint8Array;
  }): Promise<GasStationExecuteResult>;
}

/** POST one signed kind:5096 job to the DVM's `/store` backend. */
async function postGasStationJob(
  viaUrl: string,
  params: [string, string][],
  nostrSecretKey: Uint8Array
): Promise<Record<string, unknown>> {
  const { finalizeEvent } = await import('nostr-tools/pure');
  const event = finalizeEvent(
    {
      kind: GAS_STATION_JOB_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: params.map(([k, v]) => ['param', k, v]),
    },
    nostrSecretKey
  );
  const url = `${viaUrl.replace(/\/+$/, '')}/store`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
  } catch (err) {
    throw new GasStationJobError(
      'unreachable',
      `could not reach the DVM at ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let body: { accept?: boolean; code?: string; message?: string; result?: Record<string, unknown> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new GasStationJobError(
      'bad_response',
      `the DVM at ${url} returned a non-JSON response (HTTP ${response.status})`
    );
  }
  if (!response.ok || body.accept !== true || !body.result) {
    throw new GasStationJobError(
      String(body.code ?? 'rejected'),
      `the DVM rejected the kind:${GAS_STATION_JOB_KIND} job (HTTP ${response.status}${body.code ? `, ${body.code}` : ''})${body.message ? `: ${body.message}` : ''}`
    );
  }
  const result = body.result;
  if (result['status'] === 'failed') {
    throw new GasStationJobError(
      String(result['reason'] ?? 'failed'),
      `gas-station job failed: ${String(result['reason'] ?? 'unknown')} — ${String(result['detail'] ?? '')}`
    );
  }
  return result;
}

/**
 * Default {@link GasStationClient}: signed kind:5096 events POSTed to the
 * DVM's payment-oblivious `/store` backend — the identical HTTP request the
 * connector payment proxy replays on the paid path (RouteTermination).
 */
export const defaultGasStationClient: GasStationClient = {
  quote: async (args) => {
    const result = await postGasStationJob(
      args.viaUrl,
      [
        ['phase', 'quote'],
        ...(args.transaction !== undefined
          ? ([['transaction', args.transaction]] as [string, string][])
          : []),
      ],
      args.nostrSecretKey
    );
    const { quoteId, feePayer, maxLamports, recentBlockhash, expiresAt } =
      result as Partial<GasStationQuote>;
    if (
      typeof quoteId !== 'string' ||
      typeof feePayer !== 'string' ||
      typeof maxLamports !== 'string' ||
      typeof recentBlockhash !== 'string' ||
      typeof expiresAt !== 'number'
    ) {
      throw new GasStationJobError(
        'bad_response',
        `the DVM quote is missing fields: ${JSON.stringify(result)}`
      );
    }
    return { quoteId, feePayer, maxLamports, recentBlockhash, expiresAt };
  },
  execute: async (args) => {
    const result = await postGasStationJob(
      args.viaUrl,
      [
        ['phase', 'execute'],
        ['transaction', args.transaction],
        ['quoteId', args.quoteId],
        ['idempotencyKey', args.idempotencyKey],
      ],
      args.nostrSecretKey
    );
    const signature = result['signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new GasStationJobError(
        'bad_response',
        `the DVM execute result carries no signature: ${JSON.stringify(result)}`
      );
    }
    return {
      signature,
      slot: typeof result['slot'] === 'string' ? result['slot'] : null,
      feeLamportsActual:
        typeof result['feeLamportsActual'] === 'string'
          ? result['feeLamportsActual']
          : null,
      ...(result['replayed'] === true ? { replayed: true } : {}),
    };
  },
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
  /** kind:5095 job submitter seam; defaults to the signed HTTP POST. */
  submitDvmBuyJob?: SubmitDvmBuyJob;
  /** kind:5096 gas-station client seam; defaults to the signed HTTP POST. */
  gasStation?: GasStationClient;
  /**
   * TOON-network resolution seam for the default `--via` DVM (defaults to
   * `rig fund`'s {@link resolveEffectiveNetwork}; tests inject). The devnet
   * DVM is only defaulted when the TOON side ALSO resolves to devnet.
   */
  resolveToonNetwork?: typeof resolveEffectiveNetwork;
}

/**
 * The deployed devnet store DVM — defaulted as `--via` for buy/set when BOTH
 * the ArNS `--network` and the TOON network resolve to devnet and the user
 * neither named a DVM (`--via`/`RIG_ARNS_DVM_URL`) nor opted out (`--direct`).
 */
export const DEVNET_DVM_URL = 'https://dvm.devnet.toonprotocol.dev';

export const NAME_USAGE = `Usage: rig name <buy|set|status> <name> [options]

ArNS naming for Arweave-served artifacts. A name registered on the ar.io
registry resolves at every ar.io gateway (https://<name>.<gateway>/), pointing
at whatever Arweave txId its ANT record targets (10 undernames included).

Names are OWNED and PAID FOR by this rig identity's Solana key — the same
mnemonic that pays for pushes (derived at m/44'/501'/0'/0'). Fund it with
\`rig fund --chain solana\`. Purchases spend mARIO on Solana via the ar.io
registry program — NOT through TOON ILP payment channels.

Commands:
  name buy <name> [--years n | --permabuy] [--via <dvm-url>]
                       quote (mARIO) → confirm → register. The spawned ANT is
                       owned by this identity's Solana key. Default: 1-year
                       lease. PAID — spends mARIO from the Solana wallet.
                       With --via: BROKERED — this identity spawns and owns
                       the ANT (dust SOL only), then a store DVM executes the
                       kind:5095 buy job and pays the mARIO from ITS wallet;
                       the name is owned by your ANT from inception.
  name set <name> <txId> [--undername <sub>] [--ttl <seconds>] [--via <dvm-url>]
                       point the name (or an undername) at an Arweave txId
                       (typically a deployed path manifest). Signs an ANT
                       record update with the Solana key. With --via: the
                       gas-station path (kind:5096) — you author and
                       partial-sign, the DVM co-signs as fee payer and pays
                       the lamports; needs ZERO SOL in this wallet.
                       <txId> may instead be given via --tx-id <id> — use
                       that instead of the positional when the txId leads
                       with '-' or '_' (Arweave txids are base64url). For a
                       leading '-' write --tx-id=<id> (the '=' form), since
                       "--tx-id -XYZ..." is itself ambiguous to the parser.
  name status <name>   FREE: registry record (lease/permabuy, expiry), ANT
                       process id, current target txId(s), TTL, undernames.

Options:
  --years <n>          lease length in years (buy; default 1; mutually
                       exclusive with --permabuy)
  --permabuy           permanent registration instead of a lease (buy)
  --undername <sub>    target the undername <sub>_<name> instead of the base
                       name (set)
  --ttl <seconds>      record TTL in seconds (set; default 3600)
  --tx-id <id>         set only: the Arweave txId to point at, as an
                       explicit option instead of the positional (mutually
                       exclusive with the positional <txId>). For a value
                       leading with '-' use --tx-id=<id>.
  --network <net>      cluster: mainnet | devnet (default mainnet; or
                       RIG_ARIO_NETWORK). ar.io has no Solana-testnet
                       deployment. Non-mainnet gateway resolution is
                       unverified.
  --process-id <id>    explicit ArNS registry program id — a Solana program
                       address (overrides --network; or RIG_ARIO_PROCESS_ID)
  --via <dvm-url>      broker buy/set through a store DVM's job endpoint (or
                       RIG_ARNS_DVM_URL). The DVM pays the mARIO; you own the
                       name via your spawned ANT. Direct backend targeting
                       stubs the job payment (dev/e2e) — the paid path runs
                       the same job through the connector payment proxy.
                       DEVNET DEFAULT: with --network devnet and the TOON
                       network on devnet too, buy/set default to the deployed
                       devnet store DVM (${DEVNET_DVM_URL})
                       unless --direct opts out.
  --direct             force the direct wallet-paid path: never default (or
                       read RIG_ARNS_DVM_URL as) a --via DVM. Mutually
                       exclusive with an explicit --via.
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
const NETWORKS: readonly ArioNetwork[] = ['mainnet', 'devnet'];

/** Resolved wallet context shared by every `rig name` action. */
interface NameContext {
  identity: IdentityReport;
  solanaAddress: string;
  network: ArioNetwork;
  processId: string | undefined;
  sdk: ArnsSdk;
  /** Nostr secret key of the identity — signs brokered kind:5095 jobs. */
  nostrSecretKey: Uint8Array;
}

/**
 * Resolve the rig identity, derive its Solana key (the owner/payer), and build
 * the (stub-injected in tests) ArNS SDK targeted at the chosen registry.
 * `mode` decides whether the SDK gets write plumbing: every FREE lookup —
 * `status`, the buy quote, the set preview — runs `read` (signerless, #376);
 * `buy`/`set` escalate to `write` only at execute time, after the confirm
 * gate.
 */
async function resolveNameContext(
  deps: NameDeps,
  network: ArioNetwork,
  processId: string | undefined,
  mode: 'read' | 'write'
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
        "owned by the Solana key (m/44'/501'/0'/0'). Ensure the optional " +
        'Solana derivation deps are installed.'
    );
  }
  const sdk = await (deps.loadArns ?? defaultLoadArns)({
    mode,
    solanaSecretKey: derived.solana.secretKey,
    solanaPublicKey: solanaAddress,
    network,
    ...(processId !== undefined ? { processId } : {}),
  });
  const nostrSecretKey = client.deriveNostrKeyFromMnemonic(
    resolved.mnemonic,
    resolved.accountIndex
  ).secretKey;
  return { identity, solanaAddress, network, processId, sdk, nostrSecretKey };
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
  /** Brokered buy: the DVM endpoint to submit the kind:5095 job to. */
  via?: string;
  /**
   * Opt out of the devnet default `--via` DVM: force the direct wallet-paid
   * path even when both networks resolve to devnet.
   */
  direct: boolean;
  /**
   * `set` only: the Arweave txId as an explicit option, so it never has to
   * sit in the hyphen-ambiguous positional slot — Arweave txids are
   * base64url and roughly 1 in 32 lead with `-` or `_`, which Node's
   * `parseArgs` (strict by default) misreads as an unknown flag (#399).
   */
  txId?: string;
  yes: boolean;
  json: boolean;
}

function parseNameFlags(
  args: string[],
  env: NodeJS.ProcessEnv
): {
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
      via: { type: 'string' },
      direct: { type: 'boolean', default: false },
      'tx-id': { type: 'string' },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    return {
      positionals: ['--help'],
      flags: {
        permabuy: false,
        ttl: 0,
        network: 'mainnet',
        direct: false,
        yes: false,
        json: false,
      },
    };
  }

  let years: number | undefined;
  if (values.years !== undefined) {
    years = Number(values.years);
    if (!Number.isInteger(years) || years <= 0) {
      throw new Error(
        `--years must be a positive integer, got ${JSON.stringify(values.years)}`
      );
    }
  }
  if (years !== undefined && values.permabuy) {
    throw new Error('--years and --permabuy are mutually exclusive');
  }

  let ttl = DEFAULT_TTL_SECONDS;
  if (values.ttl !== undefined) {
    ttl = Number(values.ttl);
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error(
        `--ttl must be a positive integer number of seconds, got ${JSON.stringify(values.ttl)}`
      );
    }
  }

  const networkRaw = values.network ?? env['RIG_ARIO_NETWORK'] ?? 'mainnet';
  if (!NETWORKS.includes(networkRaw as ArioNetwork)) {
    throw new Error(
      `--network must be one of ${NETWORKS.join(' | ')}, got ${JSON.stringify(networkRaw)}`
    );
  }
  const processId = values['process-id'] ?? env['RIG_ARIO_PROCESS_ID'];

  if (values.direct && values.via !== undefined) {
    throw new Error(
      '--direct and --via are mutually exclusive: --direct forces the ' +
        'wallet-paid path, --via brokers through a DVM'
    );
  }
  // --direct beats the ambient RIG_ARNS_DVM_URL too (explicit opt-out).
  const viaRaw = values.direct
    ? undefined
    : (values.via ?? env['RIG_ARNS_DVM_URL']);
  let via: string | undefined;
  if (viaRaw !== undefined) {
    if (!/^https?:\/\/.+/.test(viaRaw)) {
      throw new Error(
        `--via must be an http(s) DVM endpoint URL, got ${JSON.stringify(viaRaw)}`
      );
    }
    via = viaRaw;
  }

  return {
    positionals,
    flags: {
      ...(years !== undefined ? { years } : {}),
      permabuy: values.permabuy ?? false,
      ...(values.undername !== undefined
        ? { undername: values.undername }
        : {}),
      ttl,
      network: networkRaw as ArioNetwork,
      ...(processId !== undefined ? { processId } : {}),
      ...(via !== undefined ? { via } : {}),
      direct: values.direct ?? false,
      ...(values['tx-id'] !== undefined ? { txId: values['tx-id'] } : {}),
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
  /** Brokered buy: the DVM endpoint the kind:5095 job goes to (else null). */
  via: string | null;
  identity: IdentityReport;
  solanaAddress: string;
  /** The mARIO quote (base units, string) + a human ARIO figure. */
  quote: { mARIO: string; ARIO: string };
  /** How the purchase settles — always Solana/registry, never ILP. */
  payment: string;
  executed: boolean;
  hint?: string;
  /** Brokered buy: the ANT this identity spawned and owns (execute only). */
  spawn?: { processId: string; signature: string };
  result?: {
    registryTxId: string;
    antProcessId: string | null;
    /** Brokered buy: the DVM's permissionless trait reconcile tx, if any. */
    syncAttributesTxId?: string | null;
    /** Brokered buy: the mARIO the DVM reported paying, if any. */
    dvmQuotedMario?: string | null;
  };
}

async function runBuy(
  name: string,
  flags: NameFlags,
  deps: NameDeps
): Promise<number> {
  const { io } = deps;
  const type: NameType = flags.permabuy ? 'permabuy' : 'lease';
  const years = type === 'lease' ? (flags.years ?? DEFAULT_LEASE_YEARS) : null;

  // Signerless context: the quote is a FREE read (#376); write plumbing is
  // built only after the confirm gate, right before money moves.
  const ctx = await resolveNameContext(
    deps,
    flags.network,
    flags.processId,
    'read'
  );

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

  const via = flags.via ?? null;
  const paymentNote = via === null ? MARIO_PAYMENT_NOTE : DVM_PAYMENT_NOTE;

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
    via,
    identity: ctx.identity,
    solanaAddress: ctx.solanaAddress,
    quote,
    payment: paymentNote,
    executed,
    ...extra,
  });

  // ── Human estimate table ─────────────────────────────────────────────────
  if (!flags.json) {
    io.out(
      `Buy ArNS name "${name}" — ${type}` +
        (years !== null ? ` (${years} year${years === 1 ? '' : 's'})` : '') +
        ` on ${ctx.network}` +
        (via !== null ? ` — brokered via DVM ${via}` : '')
    );
    io.out(
      via === null
        ? `  Cost: ${renderMario(mario)}`
        : `  Name cost (paid by the DVM): ${renderMario(mario)}`
    );
    io.out(`  Solana wallet: ${ctx.solanaAddress}`);
    io.out(`  ${paymentNote}`);
    io.out(renderIdentityLine(ctx.identity));
  }

  // ── Confirm gate ─────────────────────────────────────────────────────────
  if (!flags.yes) {
    if (flags.json) {
      io.emitJson(
        buildJson(false, {
          hint:
            via === null
              ? 'estimate only — re-run with --yes to buy (spends mARIO on Solana, non-refundable)'
              : 'estimate only — re-run with --yes to spawn your ANT and submit the kind:5095 buy job to the DVM',
        })
      );
      return 0;
    }
    if (!io.isInteractive) {
      io.err(
        via === null
          ? 'refusing to spend mARIO without confirmation in a non-interactive ' +
              'session — re-run with --yes (or use --json for a pure estimate)'
          : 'refusing to spawn an ANT and submit a paid DVM job without ' +
              'confirmation in a non-interactive session — re-run with --yes ' +
              '(or use --json for a pure estimate)'
      );
      return 1;
    }
    const proceed = await io.confirm(
      via === null
        ? `Proceed — buy "${name}" for ${renderMario(mario)} from your Solana wallet? [y/N] `
        : `Proceed — spawn your ANT and have the DVM at ${via} buy "${name}" ` +
            `for ${renderMario(mario)} from ITS wallet? [y/N] `
    );
    if (!proceed) {
      io.err('aborted — nothing was bought or paid.');
      return 1;
    }
  }

  // ── Execute — build the signed SDK (write mode) only now, confirmed ──────
  const signed = await resolveNameContext(
    deps,
    flags.network,
    flags.processId,
    'write'
  );

  if (via !== null) {
    // ── Brokered ("buyfor"): spawn OUR ANT, then the DVM buys for it ───────
    // 1. ANT.spawn with this identity's Solana key — the client owns the ANT
    //    (and therefore the name, from inception). Costs dust SOL, no $ARIO.
    const spawn = await signed.sdk.spawnAnt({ name });
    if (!flags.json) {
      io.out(`Spawned ANT ${spawn.processId} (tx ${spawn.signature})`);
    }
    // 2. Submit the kind:5095 job carrying OUR processId; the DVM executes
    //    buyRecord with ITS funded signer.
    const submit = deps.submitDvmBuyJob ?? defaultSubmitDvmBuyJob;
    const receipt = await submit({
      viaUrl: via,
      name,
      type,
      years,
      processId: spawn.processId,
      nostrSecretKey: signed.nostrSecretKey,
    });
    const result = {
      registryTxId: receipt.registryTxId,
      antProcessId: spawn.processId,
      syncAttributesTxId: receipt.syncAttributesTxId,
      dvmQuotedMario: receipt.quotedMario,
    };

    if (flags.json) {
      io.emitJson(
        buildJson(true, {
          spawn: { processId: spawn.processId, signature: spawn.signature },
          result,
        })
      );
    } else {
      io.out(
        `Registered "${name}" via the DVM — registry tx ${result.registryTxId}`
      );
      io.out(`  ANT process (owned by YOU): ${spawn.processId}`);
      if (receipt.syncAttributesTxId) {
        io.out(`  Trait sync: ${receipt.syncAttributesTxId}`);
      } else {
        // Proven on devnet: the deployed ario-ant program gates SyncAttributes
        // to the NFT holder, so the DVM cannot reconcile the traits — you can.
        io.out(
          '  Trait sync: not run by the DVM (holder-gated on this ' +
            'deployment) — as the ANT holder you can reconcile with ' +
            'syncAttributes later; resolution works regardless.'
        );
      }
      io.out(
        `Point it at content with \`rig name set ${name} <txId>\`, then it ` +
          `resolves at https://${name}.<gateway>/`
      );
    }
    return 0;
  }

  // ── Direct: register with our own funded wallet (the #367 path) ──────────
  const receipt = await signed.sdk.buyRecord({
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
  /** Gas-station path: the DVM endpoint the kind:5096 job goes to. */
  via: string | null;
  identity: IdentityReport;
  solanaAddress: string;
  antProcessId: string;
  executed: boolean;
  hint?: string;
  /** Gas-station path: the quote the DVM enforced. */
  gasStation?: {
    quoteId: string;
    feePayer: string;
    maxLamports: string;
    expiresAt: number;
    feeLamportsActual: string | null;
  };
  result?: { messageId: string };
}

async function runSet(
  name: string,
  txId: string,
  flags: NameFlags,
  deps: NameDeps
): Promise<number> {
  const { io } = deps;
  // Signerless context: the record lookup / preview is a FREE read (#376);
  // write plumbing is built only after the confirm gate.
  const ctx = await resolveNameContext(
    deps,
    flags.network,
    flags.processId,
    'read'
  );

  const record = await ctx.sdk.getArNSRecord({ name });
  if (!record || !record.processId) {
    throw new Error(
      `no ArNS record for "${name}" on ${ctx.network} — buy it first with ` +
        `\`rig name buy ${name}\` (or check \`rig name status ${name}\`)`
    );
  }
  const antProcessId = record.processId;
  const undername = flags.undername ?? null;
  const via = flags.via ?? null;

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
    via,
    identity: ctx.identity,
    solanaAddress: ctx.solanaAddress,
    antProcessId,
    executed,
    ...extra,
  });

  const targetLabel = undername
    ? `undername "${undername}_${name}"`
    : `base name "${name}"`;

  if (!flags.json) {
    io.out(
      `Set ${targetLabel} → txId ${txId} (ttl ${flags.ttl}s) on ${ctx.network}` +
        (via !== null ? ` — gas paid by the DVM at ${via} (kind:5096)` : '')
    );
    io.out(`  ANT process: ${antProcessId}`);
    io.out(`  Signed by the identity's Solana key (${ctx.solanaAddress}).`);
    if (via !== null) {
      io.out(
        '  Gas station: you author + partial-sign the record update; the ' +
          'DVM co-signs as fee payer and pays the lamports (toon-meta#163). ' +
          'Direct backend targeting stubs the job payment (dev/e2e).'
      );
    }
    io.out(renderIdentityLine(ctx.identity));
  }

  // ── Confirm gate (a signed ANT record update) ────────────────────────────
  if (!flags.yes) {
    if (flags.json) {
      io.emitJson(
        buildJson(false, {
          hint:
            via === null
              ? 'estimate only — re-run with --yes to write the ANT record'
              : 'estimate only — re-run with --yes to quote the gas-station and write the ANT record (DVM pays the gas)',
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
      `Proceed — point ${targetLabel} at ${txId}?` +
        (via !== null ? ' (the DVM pays the gas)' : '') +
        ' [y/N] '
    );
    if (!proceed) {
      io.err('aborted — the ANT record was not changed.');
      return 1;
    }
  }

  // ── Execute (sign + submit the ANT record update) ────────────────────────
  // Only now — confirmed — build the signed SDK (write mode).
  const signed = await resolveNameContext(
    deps,
    flags.network,
    flags.processId,
    'write'
  );

  if (via !== null) {
    // ── Gas-station path (toon-meta#163): author + partial-sign locally,
    //    the DVM co-signs as fee payer and broadcasts. ────────────────────
    const gas = deps.gasStation ?? defaultGasStationClient;
    // Quote: learn the fee payer + the quoted blockhash (merged deadline).
    const quote = await gas.quote({
      viaUrl: via,
      nostrSecretKey: signed.nostrSecretKey,
    });
    // Build + partial-sign against exactly the quoted blockhash.
    const wireTx = await signed.sdk.buildSetRecordTransaction({
      antProcessId,
      undername: undername ?? '@',
      transactionId: txId,
      ttlSeconds: flags.ttl,
      feePayer: quote.feePayer,
      recentBlockhash: quote.recentBlockhash,
    });
    const executed = await gas.execute({
      viaUrl: via,
      transaction: wireTx,
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      nostrSecretKey: signed.nostrSecretKey,
    });
    const gasStation = {
      quoteId: quote.quoteId,
      feePayer: quote.feePayer,
      maxLamports: quote.maxLamports,
      expiresAt: quote.expiresAt,
      feeLamportsActual: executed.feeLamportsActual,
    };
    const result = { messageId: executed.signature };

    if (flags.json) {
      io.emitJson(buildJson(true, { gasStation, result }));
    } else {
      io.out(
        `Updated — record-set tx ${executed.signature} (gas paid by ${quote.feePayer})`
      );
      const host = undername ? `${undername}_${name}` : name;
      io.out(
        `  Resolves at https://${host}.<gateway>/ (allow for gateway cache/TTL).`
      );
    }
    return 0;
  }

  const ant = await signed.sdk.ant(antProcessId);
  const receipt = undername
    ? await ant.setUndernameRecord({
        undername,
        transactionId: txId,
        ttlSeconds: flags.ttl,
      })
    : await ant.setBaseNameRecord({
        transactionId: txId,
        ttlSeconds: flags.ttl,
      });
  const result = { messageId: receipt.id };

  if (flags.json) {
    io.emitJson(buildJson(true, { result }));
  } else {
    io.out(`Updated — ANT message ${result.messageId}`);
    const host = undername ? `${undername}_${name}` : name;
    io.out(
      `  Resolves at https://${host}.<gateway>/ (allow for gateway cache/TTL).`
    );
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
  // FREE read: signerless SDK — a status lookup must never need write plumbing.
  const ctx = await resolveNameContext(
    deps,
    flags.network,
    flags.processId,
    'read'
  );

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
      io.out(
        `    ${label} → ${target.transactionId} (ttl ${target.ttlSeconds}s)`
      );
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

  // Default `--via` DVM on the shared devnet (#demo): buy/set broker through
  // the deployed store DVM when the user neither named a DVM (--via /
  // RIG_ARNS_DVM_URL) nor opted out (--direct). Hard-gated BOTH ways: the
  // ArNS `--network` must be devnet (a mainnet purchase must never silently
  // switch payment paths) AND the TOON network must resolve to devnet (same
  // inference `rig fund` drips on — explicit config, devnet origin, or the
  // genesis-seed fresh install).
  if (
    (sub === 'buy' || sub === 'set') &&
    !flags.direct &&
    flags.via === undefined &&
    flags.network === 'devnet'
  ) {
    let toonDevnet = false;
    try {
      const resolved = await (deps.resolveToonNetwork ??
        resolveEffectiveNetwork)({ env: deps.env, cwd: deps.cwd });
      toonDevnet = resolved.effectiveNetwork === 'devnet';
    } catch {
      // Unreadable client config — leave the wallet-paid path untouched.
    }
    if (toonDevnet) {
      flags = { ...flags, via: DEVNET_DVM_URL };
      io.err(
        `Brokering via the devnet store DVM ${DEVNET_DVM_URL} ` +
          `(no --via given; pass --direct for a wallet-paid ${sub}).`
      );
    }
  }

  try {
    if (sub === 'buy') return await runBuy(name, flags, deps);
    if (sub === 'status') return await runStatus(name, flags, deps);
    // set: `rig name set <name> <txId>` — or `rig name set <name> --tx-id
    // <id>` (#399: a positional txId leading with `-`/`_` is hyphen-
    // ambiguous with Node's strict `parseArgs`).
    if (flags.txId !== undefined && positionals[1] !== undefined) {
      io.err('`--tx-id` and a positional <txId> are mutually exclusive');
      io.err(NAME_USAGE);
      return 2;
    }
    const txId = flags.txId ?? positionals[1];
    if (txId === undefined) {
      io.err(
        '`rig name set` needs a <txId> (the Arweave transaction to point at) ' +
          '— as a positional or via --tx-id'
      );
      io.err(NAME_USAGE);
      return 2;
    }
    return await runSet(name, txId, flags, deps);
  } catch (err) {
    return emitCliError(io, flags.json, 'name', err);
  }
}
