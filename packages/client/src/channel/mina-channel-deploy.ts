/**
 * Per-pair Mina `PaymentChannel` zkApp deployment — the missing zero-config
 * piece of the Mina channel-open path.
 *
 * The `PaymentChannel` zkApp is SINGLE-PAIR: `initializeChannel` bakes
 * `channelHash = Poseidon([participantA.x, participantB.x, nonce])` into the
 * zkApp's on-chain state, and the zkApp address IS the channel id. One
 * deployment therefore serves exactly one client↔connector pair — a fresh
 * client cannot reuse the pair-bound zkApp another identity opened (its claim
 * would fail `mina_claim_verification_failed`: wrong on-chain channelHash).
 *
 * {@link ensureOwnedMinaZkApp} makes the open path self-sufficient:
 *
 *   1. Check the candidates (a previously recorded own deployment first, then
 *      the announce/preset-resolved address) for a zkApp that is ALREADY OURS
 *      — on-chain OPEN with channelHash == Poseidon([client.x, peer.x, 0]),
 *      or our own recorded deployment still awaiting initialization.
 *   2. Otherwise deploy a FRESH zkApp (new random zkApp key) from the same
 *      npm `@toon-protocol/mina-zkapp` + o1js build the claim verifier uses —
 *      the deployed verification key is the locally compiled one BY
 *      CONSTRUCTION, so the "vk drift" class of failure cannot occur.
 *
 * The connector accepts claims against ANY zkApp it can read on-chain (its
 * inbound verify resolves the claim's `zkAppAddress` on-chain and registers
 * unknown channels dynamically), so no connector-side registration step is
 * needed.
 *
 * Deploy and initialize are SEPARATE transactions (connector Issue #128:
 * `initializeChannel`'s `getAndRequireEquals` precondition fails while the
 * account does not exist yet) — this module only DEPLOYS; the normal
 * {@link openMinaChannelOnChain} initialize+deposit flow runs afterwards.
 *
 * Reuses the `createRequire`-anchored o1js loader from `mina-channel-open.ts`
 * (one shared CJS o1js instance — the ESM/CJS split instance bug) and stays
 * lazy so npm consumers who never touch Mina never load the WASM runtime.
 *
 * @module
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { hexToMinaBase58PrivateKey } from '@toon-protocol/core';
import {
  MINA_ACCOUNT_CREATION_FEE_NANOMINA,
  assertMinaFeePayerFunded,
  buildMinaTransaction,
  getCompiledPaymentChannel,
  getCompiledVerificationKeyHash,
  loadMinaRuntime,
} from './mina-channel-open.js';

/** PaymentChannel appState indices (see mina-channel-open.ts). */
const APPSTATE_CHANNEL_HASH = 0;
const APPSTATE_CHANNEL_STATE = 3;
/** CHANNEL_STATE values. */
const STATE_UNINITIALIZED = 0n;
const STATE_OPEN = 1n;

/** Everything worth persisting about an auto-deployed zkApp. */
export interface MinaZkAppDeployRecord {
  /** The deployed zkApp B62 address (== the channel id). */
  zkAppAddress: string;
  /** The zkApp's `EK…` base58 private key (needed to co-sign future txs). */
  zkAppPrivateKey: string;
  /** The fee payer (client Mina B62) that funded the deployment. */
  feePayer: string;
  /** Deploy tx hash, when the send surfaced one. */
  deployTxHash?: string;
  /** Verification-key hash of the compiled contract that was deployed. */
  vkHash?: string;
}

export interface DeployMinaZkAppParams {
  /** Mina GraphQL endpoint to deploy through. */
  graphqlUrl: string;
  /** Fee payer private key (hex scalar or `EK…` base58 — same as the opener). */
  payerPrivateKey: string;
  /**
   * Deploy fee in nanomina. Default 100_000_000 (0.1 MINA); the new zkApp
   * account additionally costs the protocol's 1 MINA account-creation fee,
   * charged to the payer via `AccountUpdate.fundNewAccount`.
   */
  feeNanomina?: bigint;
  /**
   * Reuse THIS zkApp key (`EK…` base58) instead of generating a fresh one.
   * Used to re-attempt a deployment whose key was already recorded (so a
   * crashed/pending first attempt does not orphan a NEW ~1.1-MINA zkApp on
   * every retry — the SAME address is redeployed).
   */
  zkAppPrivateKey?: string;
  /**
   * Called with the zkApp address + key IMMEDIATELY after the key is known and
   * the fee-payer preflight passes — BEFORE the circuit compiles or the deploy
   * tx is sent. The rig store persists this so a crash between send and
   * confirmation reuses the SAME zkApp next run rather than deploying (and
   * paying for) a second one. Fired only for a freshly-generated key (a
   * redeploy of a recorded key is already persisted).
   */
  onDeploying?: (record: {
    zkAppAddress: string;
    zkAppPrivateKey: string;
    feePayer: string;
  }) => void | Promise<void>;
  /** Progress lines (compile/deploy/inclusion phases take minutes). */
  onProgress?: (line: string) => void;
  /** Inclusion poll interval ms (default 15_000; tests shrink it). */
  pollIntervalMs?: number;
  /** Inclusion poll budget ms (default 540_000 ≈ 9 min). */
  pollTimeoutMs?: number;
}

export interface EnsureOwnedMinaZkAppParams extends DeployMinaZkAppParams {
  /** The connector peer's Mina settlement B62 (participantB of the pair). */
  peerPublicKey: string;
  /** A previously recorded own deployment for this identity/pair, if any. */
  deployed?: { zkAppAddress: string; zkAppPrivateKey: string };
  /** The announce/preset-resolved zkApp address (checked after `deployed`). */
  candidateZkAppAddress?: string;
  /**
   * Called with the record IMMEDIATELY after a fresh deployment is confirmed
   * on-chain — BEFORE this function returns — so the zkApp key is persisted
   * even if the caller's subsequent initialize fails.
   */
  onDeployed?: (record: MinaZkAppDeployRecord) => void | Promise<void>;
}

/** Required fee-payer balance to deploy: 1 MINA account creation + tx fees. */
function requiredDeployBalanceNanomina(feeNanomina: bigint): bigint {
  // account-creation (1 MINA) + the deploy tx fee + a buffer for the follow-up
  // initializeChannel tx (same fee) the opener submits right after.
  return MINA_ACCOUNT_CREATION_FEE_NANOMINA + feeNanomina * 2n;
}

export interface EnsureOwnedMinaZkAppResult {
  /** The zkApp to open the channel on (ours — reused or freshly deployed). */
  zkAppAddress: string;
  /** True when this call deployed a fresh zkApp. */
  deployed: boolean;
  /** The deploy record (fresh deploys only). */
  record?: MinaZkAppDeployRecord;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deploy a fresh `PaymentChannel` zkApp (BARE — no initialization) and wait
 * for the account to exist on-chain. Returns the full deploy record; the
 * caller persists it (losing the zkApp key would strand the ~1.1 MINA the
 * deployment cost).
 */
export async function deployMinaChannelZkApp(
  params: DeployMinaZkAppParams
): Promise<MinaZkAppDeployRecord> {
  const { o1js } = await loadMinaRuntime();
  const { Mina, PrivateKey, AccountUpdate, fetchAccount } = o1js;
  const progress = params.onProgress ?? ((): void => undefined);

  const network = Mina.Network(params.graphqlUrl);
  Mina.setActiveInstance(network);

  const payerKeyBase58 = hexToMinaBase58PrivateKey(params.payerPrivateKey);
  const payerPrivateKey = PrivateKey.fromBase58(payerKeyBase58);
  const payerPublicKey = payerPrivateKey.toPublicKey();

  const feeNanomina = params.feeNanomina ?? 100_000_000n;

  // ── Preflight (bug #1) ───────────────────────────────────────────────────
  // Fail fast if the fee payer cannot fund the deploy — BEFORE the ~1-3 min
  // circuit compile. Without this the compile runs first and only then does
  // Mina.transaction throw `getAccount: Could not find account …`, wasting the
  // compile AND leaking the o1js transaction context (see buildMinaTransaction).
  await assertMinaFeePayerFunded({
    o1js,
    payerPublicKey,
    requiredNanomina: requiredDeployBalanceNanomina(feeNanomina),
    graphqlUrl: params.graphqlUrl,
  });

  // Reuse a recorded key (redeploy of a pending/crashed attempt) or mint a
  // fresh one. A fresh key is PERSISTED via onDeploying BEFORE any spend so a
  // crash between send and confirmation never orphans a new zkApp (bug #3).
  const zkAppPrivateKey = params.zkAppPrivateKey
    ? PrivateKey.fromBase58(params.zkAppPrivateKey)
    : PrivateKey.random();
  const zkAppPublicKey = zkAppPrivateKey.toPublicKey();
  const zkAppAddress: string = zkAppPublicKey.toBase58();
  if (!params.zkAppPrivateKey) {
    await params.onDeploying?.({
      zkAppAddress,
      zkAppPrivateKey: zkAppPrivateKey.toBase58(),
      feePayer: payerPublicKey.toBase58(),
    });
  }

  progress(
    'compiling the PaymentChannel circuit (one-time, can take 1-3 minutes)…'
  );
  const PaymentChannel = await getCompiledPaymentChannel();

  const zkApp = new PaymentChannel(zkAppPublicKey);

  // The payer account must be in the active-instance cache for the fee/nonce.
  await fetchAccount({ publicKey: payerPublicKey });

  progress(
    `deploying a dedicated PaymentChannel zkApp ${zkAppAddress} ` +
      '(costs the 1 MINA account-creation fee + tx fee)…'
  );
  const fee = Number(feeNanomina);
  // Deploy ONLY — initialize is a separate tx (Issue #128: the initialize
  // precondition needs the account to already exist). Built through
  // buildMinaTransaction so a failure cannot leak the o1js transaction context
  // and poison a retry (bug #2).
  const deployTx = await buildMinaTransaction(
    o1js,
    { sender: payerPublicKey, fee },
    async () => {
      AccountUpdate.fundNewAccount(payerPublicKey);
      await zkApp.deploy();
    }
  );
  await deployTx.prove();
  const sent = await deployTx.sign([payerPrivateKey, zkAppPrivateKey]).send();
  const deployTxHash: string | undefined = sent.hash ?? undefined;

  progress(
    `deploy tx sent${deployTxHash ? ` (${deployTxHash})` : ''} — waiting for ` +
      'inclusion (devnet blocks are ~3 minutes)…'
  );
  // Poll fetchAccount rather than trusting `.wait()` alone: what the opener
  // needs is the ACCOUNT resolvable through this GraphQL endpoint.
  const interval = params.pollIntervalMs ?? 15_000;
  const budget = params.pollTimeoutMs ?? 540_000;
  const started = Date.now();
  // Best-effort `.wait()` first — on some o1js versions it returns promptly
  // after inclusion, which shortcuts the polling below.
  try {
    await sent.wait();
  } catch {
    // fall through to polling — some endpoints reject the wait subscription
  }
  for (;;) {
    const res = await fetchAccount({ publicKey: zkAppPublicKey });
    if (!res.error && res.account) break;
    if (Date.now() - started > budget) {
      throw new Error(
        `Mina zkApp ${zkAppAddress} did not appear on-chain within ` +
          `${Math.round(budget / 60_000)} minutes of the deploy tx` +
          `${deployTxHash ? ` (${deployTxHash})` : ''} — check the tx on ` +
          'minascan before retrying (the zkApp key has been recorded)'
      );
    }
    await sleep(interval);
  }
  progress(`zkApp ${zkAppAddress} is on-chain (bare — initialize follows).`);

  return {
    zkAppAddress,
    zkAppPrivateKey: zkAppPrivateKey.toBase58(),
    feePayer: payerPublicKey.toBase58(),
    ...(deployTxHash !== undefined ? { deployTxHash } : {}),
    ...(getCompiledVerificationKeyHash() !== undefined
      ? { vkHash: getCompiledVerificationKeyHash() }
      : {}),
  };
}

/**
 * Resolve the zkApp this (client, peer) pair should open its channel on:
 * reuse one that is provably ours, else deploy fresh. See the module doc for
 * the decision table.
 */
export async function ensureOwnedMinaZkApp(
  params: EnsureOwnedMinaZkAppParams
): Promise<EnsureOwnedMinaZkAppResult> {
  const { o1js } = await loadMinaRuntime();
  const { Mina, PrivateKey, PublicKey, Field, Poseidon, fetchAccount } = o1js;
  const progress = params.onProgress ?? ((): void => undefined);

  const network = Mina.Network(params.graphqlUrl);
  Mina.setActiveInstance(network);

  const payerKeyBase58 = hexToMinaBase58PrivateKey(params.payerPrivateKey);
  const clientPublicKey = PrivateKey.fromBase58(payerKeyBase58).toPublicKey();
  const peerPublicKey = PublicKey.fromBase58(params.peerPublicKey);

  // The participant-form pair hash `initializeChannel` bakes on-chain (and the
  // off-chain claim signer binds to): Poseidon([A.x, B.x, nonce=0]).
  if (!Poseidon) {
    throw new Error(
      'the loaded o1js runtime does not expose Poseidon — cannot derive the pair hash'
    );
  }
  const expectedChannelHash: string = Poseidon.hash([
    clientPublicKey.x,
    peerPublicKey.x,
    Field(0),
  ]).toString();

  interface Candidate {
    address: string;
    ownRecord: boolean;
  }
  const candidates: Candidate[] = [];
  if (params.deployed?.zkAppAddress) {
    candidates.push({ address: params.deployed.zkAppAddress, ownRecord: true });
  }
  if (
    params.candidateZkAppAddress &&
    params.candidateZkAppAddress !== params.deployed?.zkAppAddress
  ) {
    candidates.push({
      address: params.candidateZkAppAddress,
      ownRecord: false,
    });
  }

  // A recorded own key whose account is not (yet) on-chain: the previous
  // deploy attempt was persisted BEFORE its tx confirmed (bug #3), then
  // crashed/never landed. Redeploy the SAME key rather than minting a new
  // zkApp — otherwise every retry orphans another ~1.1-MINA deployment.
  let pendingOwnKey: string | undefined;

  for (const candidate of candidates) {
    let appState: { toString(): string }[] | undefined;
    try {
      const res = await fetchAccount({
        publicKey: PublicKey.fromBase58(candidate.address),
      });
      if (res.error || !res.account) {
        // Not on-chain. If it is OUR recorded deployment, remember its key so
        // the deploy below reuses the SAME address instead of orphaning a new
        // zkApp on every retry.
        if (candidate.ownRecord && params.deployed?.zkAppPrivateKey) {
          pendingOwnKey = params.deployed.zkAppPrivateKey;
        }
        continue;
      }
      appState = res.account.zkapp?.appState;
    } catch {
      continue;
    }
    const channelHash = appState?.[APPSTATE_CHANNEL_HASH]?.toString() ?? '';
    const channelState = BigInt(
      appState?.[APPSTATE_CHANNEL_STATE]?.toString() ?? '0'
    );
    if (channelState === STATE_OPEN && channelHash === expectedChannelHash) {
      // OPEN for exactly our pair — ours, reuse (open is idempotent on it).
      progress(`reusing our open Mina channel zkApp ${candidate.address}.`);
      return { zkAppAddress: candidate.address, deployed: false };
    }
    if (candidate.ownRecord && channelState === STATE_UNINITIALIZED) {
      // Our own recorded deployment that never got initialized (crash between
      // deploy and init) — reuse it; the normal open initializes it.
      progress(
        `reusing our recorded (uninitialized) Mina zkApp ${candidate.address}.`
      );
      return { zkAppAddress: candidate.address, deployed: false };
    }
    // Anything else — a foreign pair's channel, the shared announce zkApp
    // someone already initialized, CLOSING/SETTLED remnants — is not ours.
  }

  // No usable candidate: deploy a dedicated zkApp for this pair. Reuse the
  // recorded pending key when present (redeploy the same address, no orphan).
  const record = await deployMinaChannelZkApp({
    ...params,
    ...(pendingOwnKey ? { zkAppPrivateKey: pendingOwnKey } : {}),
    ...(params.onDeploying ? { onDeploying: params.onDeploying } : {}),
  });
  // Persist BEFORE returning: if the caller's initialize fails, the zkApp key
  // (and the ~1.1 MINA it cost) must not be lost.
  await params.onDeployed?.(record);
  return { zkAppAddress: record.zkAppAddress, deployed: true, record };
}
