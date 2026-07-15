/**
 * ArNS (ar.io Name System) step for the permanent Arweave deploy of rig-web.
 *
 * A raw manifest txId (`https://ar-io.dev/<manifest-txid>/`) is unreadable and,
 * worse, changes on every redeploy — so there is no stable permanent URL even
 * once the underlying Arweave deploy unblocks. ArNS is the naming layer for
 * exactly this: a registered name resolves at every ar.io gateway as
 * `https://<name>.<gateway>/`, serving whatever txId the name's ANT record
 * points at. The name is the fixed pointer; the manifest txId keeps changing
 * underneath.
 *
 * Since ar.io's Solana migration (June 2026) names are owned and managed by a
 * **Solana wallet** via `@ar.io/sdk` (prices quoted/paid in mARIO, $ARIO base
 * units). This module is deliberately **self-contained and additive**:
 *
 *   - ONE-TIME  buy a name: `quoteBuyName()` (getTokenCost) then `buyName()`
 *     (buyRecord). Buying spawns an ANT owned by the deploy wallet.
 *   - EVERY REDEPLOY  point the name at the freshly-uploaded manifest:
 *     `pointNameAtManifest()` (setBaseNameRecord).
 *
 * The redeploy step is wired into the deploy flow **guarded / opt-in** via
 * `runArnsRedeployStep()`: it is a no-op unless an ArNS name is configured, so
 * the additive step never disturbs the existing (currently-blocked) upload
 * flow. Every money-moving path (`buyName`, `pointNameAtManifest`) takes the
 * ar.io client as an **injected dependency**, so it can be unit-tested today
 * against mocks/stubs with no real registry call and no funds spent — the issue
 * calls this out as independent of the two upload blockers (funded Turbo JWK /
 * client-side chunked store upload).
 *
 * ─── Wiring the real SDK (production, not exercised by tests) ────────────────
 * The caller constructs the concrete clients from `@ar.io/sdk` and injects them
 * — this module never imports the SDK, so no real network/registry code is
 * reachable from tests:
 *
 *   import { ARIO, ANT, ArweaveSigner } from '@ar.io/sdk';
 *   const signer = // Solana signer for the org deploy-identity wallet
 *   const ario = ARIO.init({ signer, processId });        // registry client
 *   // one-time:
 *   await buyName(ario, config);
 *   // every redeploy, for the name's own ANT process:
 *   const ant = ANT.init({ signer, processId: antProcessId });
 *   await runArnsRedeployStep({ manifestTxId, ant, config });
 *
 * See issue #366. Overlaps with #367 (`rig name` verbs, built in parallel);
 * this wrapper should later be consolidated with it.
 */

import { isValidArweaveTxId } from '@toon-protocol/arweave';

// ─── Configuration ──────────────────────────────────────────────────────────

/** Purchase model for an ArNS name. */
export type ArnsPurchaseType = 'lease' | 'permabuy';

/** Default ar.io gateway used to build the resulting URL. */
export const DEFAULT_ARNS_GATEWAY = 'https://ar-io.dev';

/** Default TTL for the ANT base-name record, in seconds. */
export const DEFAULT_ARNS_TTL_SECONDS = 3600;

/** mARIO per ARIO — $ARIO has 6 decimals, prices are quoted in mARIO. */
export const MARIO_PER_ARIO = 1_000_000;

/**
 * ArNS deploy configuration. Resolved from the environment by
 * {@link readArnsConfig}; absence of a name means "not configured" and the
 * redeploy step is skipped.
 */
export interface ArnsDeployConfig {
  /** The ArNS name to register / point (the `<name>` in `<name>.<gateway>`). */
  name: string;
  /** Purchase model. `lease` requires {@link ArnsDeployConfig.years}. */
  type: ArnsPurchaseType;
  /** Lease length in years (1–5); ignored for `permabuy`. */
  years?: number;
  /** TTL for the ANT base-name record, in seconds. */
  ttlSeconds: number;
  /** ar.io gateway origin used to build the result URL, e.g. `https://ar-io.dev`. */
  gateway: string;
  /** Relay URL baked into the `#relay=` fragment of the result URL. */
  relay: string;
  /**
   * Registry / ANT-registrar process id. Undefined means the SDK default
   * (mainnet). Devnet/testnet resolution by public gateways is UNVERIFIED —
   * see issue #366.
   */
  processId?: string;
  /**
   * Opaque identifier of the Solana **org deploy-identity** wallet that owns
   * the name (ANT ownership = the keys to the URL). This is a deliberate human
   * custody decision: it is NEVER a raw private key and is NEVER used to sign
   * here — the caller injects a real signer built from this identity. Carried
   * only so the config is self-describing and auditable.
   */
  walletId?: string;
}

/** ArNS name syntax: 1–51 chars, lowercase alphanumeric and hyphens, no edge/`--`. */
const ARNS_NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,51}(?<!-)$/;

/**
 * Validate an ArNS name against the registry syntax rules.
 * (Length, charset, and no leading/trailing/double hyphens.)
 */
export function isValidArnsName(name: string): boolean {
  return ARNS_NAME_RE.test(name);
}

/**
 * Resolve {@link ArnsDeployConfig} from an environment map (defaults to
 * `process.env`). Returns `null` when no `RIG_ARNS_NAME` is set — this is the
 * opt-in guard: the deploy flow runs unchanged unless a name is configured.
 *
 * Throws only when a name IS configured but the surrounding values are invalid,
 * so a misconfigured deploy fails loudly instead of pointing the wrong name.
 *
 * Recognized variables:
 *   RIG_ARNS_NAME         (required to enable) — the ArNS name
 *   RIG_ARNS_TYPE         'lease' (default) | 'permabuy'
 *   RIG_ARNS_YEARS        lease length, 1–5 (default 1; ignored for permabuy)
 *   RIG_ARNS_TTL_SECONDS  ANT record TTL (default 3600)
 *   RIG_ARNS_GATEWAY      result-URL gateway origin (default https://ar-io.dev)
 *   RIG_ARNS_RELAY        relay for the #relay= fragment (falls back to
 *                         VITE_DEFAULT_RELAY)
 *   RIG_ARNS_PROCESS_ID   registry process id (default: SDK mainnet)
 *   RIG_ARNS_WALLET       org deploy-identity wallet id (owner; never a key)
 */
export function readArnsConfig(
  env: Record<string, string | undefined> = process.env,
): ArnsDeployConfig | null {
  const name = env['RIG_ARNS_NAME']?.trim();
  if (!name) return null;

  if (!isValidArnsName(name)) {
    throw new Error(
      `RIG_ARNS_NAME "${name}" is not a valid ArNS name (1–51 chars, lowercase a–z, 0–9, hyphens; no leading/trailing/double hyphen).`,
    );
  }

  const rawType = env['RIG_ARNS_TYPE']?.trim() ?? 'lease';
  if (rawType !== 'lease' && rawType !== 'permabuy') {
    throw new Error(
      `RIG_ARNS_TYPE must be 'lease' or 'permabuy' (got "${rawType}").`,
    );
  }
  const type: ArnsPurchaseType = rawType;

  let years: number | undefined;
  if (type === 'lease') {
    const rawYears = env['RIG_ARNS_YEARS']?.trim();
    years = rawYears === undefined ? 1 : Number(rawYears);
    if (!Number.isInteger(years) || years < 1 || years > 5) {
      throw new Error(
        `RIG_ARNS_YEARS must be an integer 1–5 for a lease (got "${rawYears}").`,
      );
    }
  }

  const ttlSeconds = parsePositiveInt(
    env['RIG_ARNS_TTL_SECONDS'],
    DEFAULT_ARNS_TTL_SECONDS,
    'RIG_ARNS_TTL_SECONDS',
  );

  const gateway = env['RIG_ARNS_GATEWAY']?.trim() || DEFAULT_ARNS_GATEWAY;
  assertHttpOrigin(gateway, 'RIG_ARNS_GATEWAY');

  const relay = env['RIG_ARNS_RELAY']?.trim() || env['VITE_DEFAULT_RELAY']?.trim();
  if (!relay) {
    throw new Error(
      'An ArNS name is configured but no relay is set — set RIG_ARNS_RELAY (or VITE_DEFAULT_RELAY) so the result URL carries a #relay= fragment.',
    );
  }
  if (!/^wss?:\/\//.test(relay)) {
    throw new Error(
      `RIG_ARNS_RELAY must be a ws:// or wss:// URL (got "${relay}").`,
    );
  }

  const config: ArnsDeployConfig = {
    name,
    type,
    ttlSeconds,
    gateway,
    relay,
  };
  if (years !== undefined) config.years = years;
  const processId = env['RIG_ARNS_PROCESS_ID']?.trim();
  if (processId) config.processId = processId;
  const walletId = env['RIG_ARNS_WALLET']?.trim();
  if (walletId) config.walletId = walletId;

  return config;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  varName: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${varName} must be a positive integer (got "${raw}").`);
  }
  return n;
}

function assertHttpOrigin(value: string, varName: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${varName} must be an absolute http(s) URL (got "${value}").`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${varName} must use http(s) (got "${value}").`);
  }
}

// ─── Injected `@ar.io/sdk` surface (structural — never imported here) ────────
// These interfaces mirror only the fraction of `@ar.io/sdk` this module uses.
// The concrete `ARIO.init(...)` / `ANT.init(...)` instances are structurally
// assignable to them, so production injects the real SDK while tests inject
// mocks — no `@ar.io/sdk` dependency is pulled into rig-web and no registry
// call is reachable from a test.

/** Parameters for `ario.getTokenCost({ intent: 'Buy-Name', ... })`. */
export interface TokenCostParams {
  intent: 'Buy-Name';
  name: string;
  type: ArnsPurchaseType;
  years?: number;
}

/** Parameters for `ario.buyRecord(...)`. */
export interface BuyRecordParams {
  name: string;
  type: ArnsPurchaseType;
  years?: number;
  processId?: string;
}

/** Result of a write (AO message / tx id). */
export interface ArioWriteResult {
  id: string;
}

/** The `ARIO` registry client surface used here. */
export interface ArioClient {
  /** Quote a registry intent; returns the cost in mARIO. */
  getTokenCost(params: TokenCostParams): Promise<number>;
  /** Buy a name (spawns an ANT owned by the signer's wallet). */
  buyRecord(params: BuyRecordParams): Promise<ArioWriteResult>;
}

/** Parameters for `ant.setBaseNameRecord(...)`. */
export interface SetBaseNameRecordParams {
  transactionId: string;
  ttlSeconds: number;
}

/** The per-name `ANT` client surface used here. */
export interface AntClient {
  /** Point the name's base record at a manifest/tx id. */
  setBaseNameRecord(params: SetBaseNameRecordParams): Promise<ArioWriteResult>;
}

// ─── One-time: quote + buy ───────────────────────────────────────────────────

/** A registry-cost quote for buying a name. */
export interface ArnsQuote {
  /** Cost in mARIO ($ARIO base units). */
  mARIO: number;
  /** Same cost expressed in whole ARIO (mARIO / 1e6). */
  ARIO: number;
}

/**
 * Quote the one-time cost of buying `config.name` (getTokenCost, intent
 * `Buy-Name`). Read-only: spends nothing. Injected `ario` is mocked in tests.
 */
export async function quoteBuyName(
  ario: ArioClient,
  config: ArnsDeployConfig,
): Promise<ArnsQuote> {
  const params: TokenCostParams = {
    intent: 'Buy-Name',
    name: config.name,
    type: config.type,
  };
  if (config.type === 'lease' && config.years !== undefined) {
    params.years = config.years;
  }
  const mARIO = await ario.getTokenCost(params);
  if (!Number.isFinite(mARIO) || mARIO < 0) {
    throw new Error(`getTokenCost returned an invalid cost: ${mARIO}`);
  }
  return { mARIO, ARIO: mARIO / MARIO_PER_ARIO };
}

/** Result of a one-time name purchase. */
export interface BuyNameResult {
  /** AO message / tx id of the buyRecord write. */
  messageId: string;
}

/**
 * Buy `config.name` (buyRecord). SPENDS $ARIO from the injected client's
 * wallet — in tests `ario` is always a mock/stub, so no funds move and no real
 * registry call is made. Buying spawns an ANT owned by the deploy wallet; the
 * returned ANT process id is discovered separately (SDK `getArNSRecord`) or
 * from the buy receipt, and used to construct the {@link AntClient} for
 * redeploys.
 */
export async function buyName(
  ario: ArioClient,
  config: ArnsDeployConfig,
): Promise<BuyNameResult> {
  if (config.type === 'lease' && config.years === undefined) {
    throw new Error('A lease purchase requires `years`.');
  }
  const params: BuyRecordParams = {
    name: config.name,
    type: config.type,
  };
  if (config.type === 'lease' && config.years !== undefined) {
    params.years = config.years;
  }
  if (config.processId) params.processId = config.processId;

  const { id } = await ario.buyRecord(params);
  if (!id) {
    throw new Error('buyRecord did not return a message id.');
  }
  return { messageId: id };
}

// ─── Every redeploy: point the name at the new manifest ──────────────────────

/**
 * Point the name's ANT base record at `manifestTxId` (setBaseNameRecord). This
 * is the per-redeploy step: the name stays fixed, the manifest txId underneath
 * it changes. Injected `ant` is mocked in tests, so no funds move.
 */
export async function pointNameAtManifest(
  ant: AntClient,
  manifestTxId: string,
  ttlSeconds: number = DEFAULT_ARNS_TTL_SECONDS,
): Promise<ArioWriteResult> {
  if (!isValidArweaveTxId(manifestTxId)) {
    throw new Error(
      `manifestTxId "${manifestTxId}" is not a valid 43-char Arweave tx id.`,
    );
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`ttlSeconds must be a positive integer (got ${ttlSeconds}).`);
  }
  const result = await ant.setBaseNameRecord({
    transactionId: manifestTxId,
    ttlSeconds,
  });
  if (!result?.id) {
    throw new Error('setBaseNameRecord did not return a message id.');
  }
  return result;
}

/**
 * Build the stable, human-readable, gateway-agnostic result URL:
 * `https://<name>.<gateway-host>/#relay=<relay>`. The `#relay=` fragment
 * (issue #266) already works on gateway hosts, so a named deploy stays
 * relay-configurable with no rebuild.
 */
export function buildArnsUrl(config: ArnsDeployConfig): string {
  const gatewayHost = new URL(config.gateway).host;
  return `https://${config.name}.${gatewayHost}/#relay=${config.relay}`;
}

// ─── Guarded redeploy wiring ─────────────────────────────────────────────────

/** Outcome of {@link runArnsRedeployStep}. */
export type ArnsRedeployResult =
  | { skipped: true; reason: string }
  | { skipped: false; url: string; writeId: string; name: string };

/**
 * The additive, **opt-in** ArNS step for the permanent-deploy flow. Call it
 * after the manifest has been uploaded, passing the fresh manifest txId.
 *
 *   - If no ArNS name is configured (`readArnsConfig` → null), it is a no-op
 *     and returns `{ skipped: true }` — the existing deploy flow is undisturbed.
 *   - Otherwise it points the configured name at `manifestTxId` and returns the
 *     stable result URL.
 *
 * `ant` is injected (constructed from `@ar.io/sdk` for the name's ANT process
 * in production; a mock in tests), so this whole path is exercised today
 * without an unblocked upload and without spending funds.
 */
export async function runArnsRedeployStep(args: {
  manifestTxId: string;
  ant: AntClient;
  /** Pre-resolved config; if omitted, resolved from `env`. */
  config?: ArnsDeployConfig | null;
  env?: Record<string, string | undefined>;
}): Promise<ArnsRedeployResult> {
  const config =
    args.config !== undefined ? args.config : readArnsConfig(args.env);
  if (!config) {
    return { skipped: true, reason: 'no ArNS name configured' };
  }

  const { id } = await pointNameAtManifest(
    args.ant,
    args.manifestTxId,
    config.ttlSeconds,
  );

  return {
    skipped: false,
    url: buildArnsUrl(config),
    writeId: id,
    name: config.name,
  };
}
