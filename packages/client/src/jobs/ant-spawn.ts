/**
 * Buying an ArNS name while holding nothing but ILP credit.
 *
 * `kind:5095 op=buy` needs a `processId` — the MPL Core asset pubkey of an ANT
 * the caller already owns. Spawning one costs ~0.012 SOL of rent, and a TOON
 * client holds stablecoin credit on a payment channel, not SOL. So the work is
 * split across the three parties, and no single one has to be able to do all of
 * it:
 *
 *   - the **store** composes the transaction (it is the only party with `@ar.io/sdk`)
 *   - the **client** signs it (it is the only party that may own the ANT)
 *   - the **gas station** pays for it and broadcasts it (it is the only party with SOL)
 *
 * The ceremony {@link spawnAnt} drives:
 *
 * ```text
 *   1. → gas    kind:5096 quote, no draft    → feePayer
 *   2. → store  kind:5095 op=prepare         → unsigned draft transaction
 *   3.          sign the mint and owner slots
 *   4. → gas    kind:5096 quote, with draft  → quoteId, recentBlockhash, maxLamports
 *   5.          patch the blockhash, sign again
 *   6. → gas    kind:5096 execute            → co-signed, broadcast, signature
 * ```
 *
 * Two quotes and two signings, because the gas station prices the job from a
 * SIGNED draft (that is what makes the free quote a full policy dry run) and
 * then requires the executed transaction to carry the blockhash **it** chose.
 * Everything from step 4 on runs inside one merged quote/blockhash deadline —
 * 60 seconds by default — which is why step 5 patches the 32 bytes locally
 * instead of paying for a second `op=prepare` round trip. Pass `reprepare` to
 * take that round trip anyway; the store returns a byte-identical transaction
 * but for those 32 bytes, so both routes end in the same place.
 *
 * Then {@link buyArnsName} spends the ANT: `kind:5095 op=buy` with the spawned
 * `processId`. {@link buyArnsNameWithNewAnt} is the two in order.
 *
 * **The spawned ANT is not ACL-bootstrapped.** That is ~61.4M lamports against
 * the gas station's 20M per-job ceiling, and its instructions would put the fee
 * payer in an ar.io slot, which the inspector refuses outright. The ANT resolves
 * fine; it just will not appear in "ANTs I own" registry lookups until the owner
 * bootstraps it later with its own SOL — and that registry is an
 * eventually-consistent secondary index, not truth.
 *
 * **Nothing here throws.** A packet the connector would not carry, an event the
 * app rejected, a gate that declined to spend and a receipt this client will not
 * sign are all outcomes — `{ spawned: false, step, reason, detail }`. By the
 * time any of them is read a packet has already been paid for, which is exactly
 * the case CLAUDE.md's rule covers: a refusal is returned, never thrown.
 *
 * `reason` is the gas station's own closed vocabulary wherever the verdict is
 * one the gas station would give — including the two checks this client makes
 * locally, which exist only to reach that verdict before paying for it.
 */

import {
  generateSolanaKeypair,
  parseSolanaWireTransaction,
  patchSolanaRecentBlockhash,
  signSolanaWireTransaction,
} from '../channel/solana/wire-transaction.js';
import type { Signer } from '../channel/solana/payment-channel.js';
import { base58Encode } from '../utils/base58.js';
import { buildJobEvent } from './job-event.js';
import { sendJob, type JobAnswer, type JobEndpoint } from './send-job.js';
import type {
  ArnsAntPrepareReceipt,
  ArnsBuyReceipt,
  ArnsNameType,
  GasStationExecuteReceipt,
  GasStationQuoteReceipt,
  GasStationReceipt,
} from './receipts.js';
import type { SendRefused } from '../client/types.js';

/** The NIP-90 job kind for the ArNS job — both of its ops. */
export const ARNS_KIND = 5095;
/** The NIP-90 job kind for the Solana gas station — both of its phases. */
export const SOLANA_GAS_KIND = 5096;

/** Which step of the ceremony an outcome stopped at. */
export type AntSpawnStep =
  | 'fee-payer-quote'
  | 'prepare'
  | 'quote'
  | 'reprepare'
  | 'sign'
  | 'execute';

export interface AntSpawnParams {
  /** Where the kind:5095 job goes — the store. */
  store: JobEndpoint;
  /** Where the kind:5096 job goes — the gas station. */
  gas: JobEndpoint;
  /**
   * The keypair that will own the ANT. Its address goes to the store as
   * `owner`, and it signs the owner slot — which is also the account the fee
   * payer transfers the ANT state PDAs' rent to, in the same transaction.
   */
  owner: Signer;
  /** The ANT's display name: 1–51 lowercase alphanumerics and hyphens. */
  name: string;
  /** Arweave tx id the root `@` record points at. Default: the store's own. */
  target?: string;
  /** ANT ticker, 1–16 chars. Default: the ar.io program's own. */
  ticker?: string;
  /**
   * Override the ephemeral mint keypair. Supply one only to make a run
   * reproducible — its public half becomes the ANT's permanent address, and
   * nothing needs its private half once the spawn confirms.
   */
  mint?: Signer;
  /**
   * The gas station's execute-phase idempotency key. Default: a fresh UUID —
   * and it must be one, because that idempotency store is global and unscoped,
   * so a guessable key is somebody else's receipt.
   *
   * Reuse the SAME key to retry a `confirmation_timeout`. Both outcomes report
   * the key that was used, so a generated one is recoverable rather than lost
   * with the run that made it.
   */
  idempotencyKey?: string;
  /**
   * Ask the store to re-prepare against the quoted blockhash instead of
   * patching those 32 bytes locally. One more paid round trip inside the quote
   * TTL, for a transaction composed entirely by the party that composes it.
   */
  reprepare?: boolean;
}

/** The ANT exists on chain, and the client owns it. */
export interface AntSpawned {
  spawned: true;
  /** The ANT's MPL Core asset pubkey — hand this to {@link buyArnsName}. */
  processId: string;
  /** The same key, named for the keypair that signed the mint slot. */
  mint: string;
  owner: string;
  feePayer: string;
  quoteId: string;
  /** The confirmed transaction signature. */
  signature: string;
  slot: string | null;
  feeLamportsActual: string | null;
  recentBlockhash: string;
  /** True when the gas station replayed a receipt for this idempotency key. */
  replayed: boolean;
  /** The key used, so a `confirmation_timeout` can be retried with it. */
  idempotencyKey: string;
  /** The executed transaction, base64 — every slot filled but the fee payer's. */
  transaction: string;
}

/** Somebody said no, and said why. */
export interface AntSpawnRefused {
  spawned: false;
  step: AntSpawnStep;
  /**
   * The gas station's machine-readable reason where it was the gate that
   * declined, an ILP reject code where the packet was refused, or the app's own
   * `F00` / `T00` where the event was rejected. Branch on this, not on
   * {@link detail}.
   *
   * A check this client made locally answers in the gas station's OWN
   * vocabulary — `fee_payer_mismatch`, `blockhash_mismatch`,
   * `missing_client_signature` — because it is the same verdict on the same
   * bytes, reached before paying for it rather than after.
   */
  reason: string;
  detail: string;
  /** Present when the packet never reached the app. */
  refusal?: SendRefused;
  /** The ANT's address. It exists only if the spawn confirmed. */
  mint: string;
  /**
   * The key the execute carried, or would have. Together with {@link quoteId}
   * and {@link transaction} it is everything needed to re-send that execute —
   * which is the documented recovery from a `confirmation_timeout`, where the
   * transaction is broadcast and may yet land.
   */
  idempotencyKey: string;
  /** The quote the execute was made against, once there was one. */
  quoteId?: string;
  /** The bytes sent to the gas station, when the execute is what failed. */
  transaction?: string;
}

export type AntSpawnOutcome = AntSpawned | AntSpawnRefused;

/**
 * Spawn an ANT the caller owns, paid for by a gas station and composed by a
 * store. Steps 1–6 above.
 */
export async function spawnAnt(params: AntSpawnParams): Promise<AntSpawnOutcome> {
  const owner = base58Encode(params.owner.publicKey);
  const mintKeypair = params.mint ?? generateSolanaKeypair();
  const mint = base58Encode(mintKeypair.publicKey);
  const idempotencyKey = params.idempotencyKey ?? crypto.randomUUID();
  const held = new Map<string, Signer>([
    [mint, mintKeypair],
    [owner, params.owner],
  ]);

  /** Every refusal carries the same three facts about the run that produced it. */
  const stop = (
    step: AntSpawnStep,
    refused: PartialRefusal
  ): AntSpawnRefused => ({ ...refused, step, mint, idempotencyKey });

  // ── 1. What address must the transaction name as its fee payer? ───────────
  // A quote with no draft is the cheapest way to ask: it prices nothing and
  // returns the gas wallet, which the store needs before it can compose.
  const feePayerQuote = await quote(params.gas, undefined);
  if (!feePayerQuote.ok) return stop('fee-payer-quote', feePayerQuote.refused);
  const feePayer = feePayerQuote.receipt.feePayer;

  // ── 2. Compose. No blockhash yet: a draft exists only to be priced. ───────
  const drafted = await prepare(params, { mint, owner, feePayer });
  if (!drafted.ok) return stop('prepare', drafted.refused);
  const draft = drafted.receipt;

  const drafters = signersFor(draft, held, { mint, feePayer });
  if (!drafters.ok) return stop('prepare', drafters.refused);

  // ── 3. Sign the slots the store said are ours. ────────────────────────────
  const signedDraft = signSolanaWireTransaction(draft.transaction, drafters.receipt);

  // ── 4. Quote the SIGNED draft: a full policy dry run, for free. ───────────
  const priced = await quote(params.gas, signedDraft);
  if (!priced.ok) return stop('quote', priced.refused);
  const { quoteId, recentBlockhash } = priced.receipt;

  // ── 5. Carry the quoted blockhash, then sign again — in that order. ───────
  // Signing first would be signing a message about to change underneath the
  // signature, so both routes end with the signing, never with the blockhash.
  let unsigned: string;
  let signers = drafters.receipt;
  if (params.reprepare === true) {
    const reprepared = await prepare(params, { mint, owner, feePayer }, recentBlockhash);
    if (!reprepared.ok) return stop('reprepare', { ...reprepared.refused, quoteId });
    const resigners = signersFor(reprepared.receipt, held, { mint, feePayer });
    if (!resigners.ok) return stop('reprepare', { ...resigners.refused, quoteId });
    unsigned = reprepared.receipt.transaction;
    signers = resigners.receipt;
  } else {
    unsigned = patchSolanaRecentBlockhash(draft.transaction, recentBlockhash);
  }
  const executable = signSolanaWireTransaction(unsigned, signers);

  const unexecutable = checkExecutable(executable, { feePayer, recentBlockhash });
  if (unexecutable) return stop('sign', { ...unexecutable, quoteId, transaction: executable });

  // ── 6. Pay, co-sign, broadcast. ───────────────────────────────────────────
  const executed = await sendJob<GasStationReceipt>(
    params.gas,
    buildJobEvent({
      kind: SOLANA_GAS_KIND,
      params: {
        phase: 'execute',
        transaction: executable,
        quoteId,
        idempotencyKey,
      },
    })
  );
  const settled = readGasStation<GasStationExecuteReceipt>(executed, 'execute');
  if (!settled.ok) {
    return stop('execute', { ...settled.refused, quoteId, transaction: executable });
  }

  return {
    spawned: true,
    processId: draft.processId,
    mint,
    owner,
    feePayer,
    quoteId,
    signature: settled.receipt.signature,
    slot: settled.receipt.slot,
    feeLamportsActual: settled.receipt.feeLamportsActual,
    recentBlockhash,
    replayed: settled.receipt.replayed === true,
    idempotencyKey,
    transaction: executable,
  };
}

// ---------------------------------------------------------------------------
// Buying the name
// ---------------------------------------------------------------------------

export interface ArnsBuyParams {
  /** Where the kind:5095 job goes — the store. */
  store: JobEndpoint;
  /** The ArNS name to register. */
  name: string;
  /** The ANT that will hold it — {@link AntSpawned.processId}. */
  processId: string;
  /** Default `'lease'`. */
  type?: ArnsNameType;
  /** Lease length, 1–5. Invalid for a permabuy. */
  years?: number;
  /** The store's own replay key for the buy. Defaults to the event id. */
  idempotencyKey?: string;
}

export type ArnsBuyOutcome =
  | { bought: true; receipt: ArnsBuyReceipt }
  | { bought: false; reason: string; detail: string; refusal?: SendRefused };

/**
 * Register an ArNS name to an ANT the caller already owns — `kind:5095 op=buy`.
 * The store's own ARIO float pays the registry; this client pays the store.
 */
export async function buyArnsName(params: ArnsBuyParams): Promise<ArnsBuyOutcome> {
  const answer = await sendJob<ArnsBuyReceipt>(
    params.store,
    buildJobEvent({
      kind: ARNS_KIND,
      params: {
        op: 'buy',
        name: params.name,
        processId: params.processId,
        type: params.type ?? 'lease',
        years:
          (params.type ?? 'lease') === 'lease' && params.years !== undefined
            ? String(params.years)
            : undefined,
        idempotencyKey: params.idempotencyKey,
      },
    })
  );
  if (!answer.accepted) {
    return {
      bought: false,
      reason: answer.code,
      detail: answer.message,
      ...(answer.refusal ? { refusal: answer.refusal } : {}),
    };
  }
  return { bought: true, receipt: answer.receipt };
}

/** Both halves: spawn an ANT, then register the name to it. */
export type ArnsNameWithAntOutcome =
  | { bought: true; ant: AntSpawned; receipt: ArnsBuyReceipt }
  | { bought: false; ant?: AntSpawned; step: AntSpawnStep | 'buy'; reason: string; detail: string };

/**
 * The whole thing: spawn an ANT and register `name` to it.
 *
 * The two halves are separately re-runnable on purpose. If the buy fails after
 * the spawn confirmed, the ANT is still yours — call {@link buyArnsName} with
 * the `processId` in `ant` rather than spawning a second one.
 */
export async function buyArnsNameWithNewAnt(
  params: AntSpawnParams & Pick<ArnsBuyParams, 'type' | 'years'>
): Promise<ArnsNameWithAntOutcome> {
  const ant = await spawnAnt(params);
  if (!ant.spawned) {
    return { bought: false, step: ant.step, reason: ant.reason, detail: ant.detail };
  }
  const bought = await buyArnsName({
    store: params.store,
    name: params.name,
    processId: ant.processId,
    ...(params.type !== undefined ? { type: params.type } : {}),
    ...(params.years !== undefined ? { years: params.years } : {}),
  });
  if (!bought.bought) {
    return { bought: false, ant, step: 'buy', reason: bought.reason, detail: bought.detail };
  }
  return { bought: true, ant, receipt: bought.receipt };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A refusal as a step knows it — before the facts about the run as a whole
 * (which step, which mint, which idempotency key) are stamped on by `stop`.
 */
type PartialRefusal = Omit<AntSpawnRefused, 'step' | 'mint' | 'idempotencyKey'>;

/** A step's result: its receipt, or the refusal to hand back to the caller. */
type Step<T> =
  | { ok: true; receipt: T }
  | { ok: false; refused: PartialRefusal };

async function quote(
  gas: JobEndpoint,
  draft: string | undefined
): Promise<Step<GasStationQuoteReceipt>> {
  const answer = await sendJob<GasStationReceipt>(
    gas,
    buildJobEvent({
      kind: SOLANA_GAS_KIND,
      params: { phase: 'quote', transaction: draft },
    })
  );
  return readGasStation<GasStationQuoteReceipt>(answer, 'quote');
}

async function prepare(
  params: AntSpawnParams,
  keys: { mint: string; owner: string; feePayer: string },
  recentBlockhash?: string
): Promise<Step<ArnsAntPrepareReceipt>> {
  const answer = await sendJob<ArnsAntPrepareReceipt>(
    params.store,
    buildJobEvent({
      kind: ARNS_KIND,
      params: {
        op: 'prepare',
        name: params.name,
        owner: keys.owner,
        mint: keys.mint,
        feePayer: keys.feePayer,
        recentBlockhash,
        target: params.target,
        ticker: params.ticker,
      },
    })
  );
  if (!answer.accepted) return { ok: false, refused: refusalOf(answer) };
  return { ok: true, receipt: answer.receipt };
}

/**
 * Read a gas-station answer. A receipt with `status: 'failed'` is the gate
 * declining — an accepted job, and the one case where {@link AntSpawnRefused}'s
 * `reason` carries the vocabulary a caller can branch on.
 */
function readGasStation<T extends GasStationReceipt>(
  answer: JobAnswer<GasStationReceipt>,
  phase: 'quote' | 'execute'
): Step<T> {
  if (!answer.accepted) return { ok: false, refused: refusalOf(answer) };
  const receipt = answer.receipt;
  if (receipt.status === 'failed') {
    return {
      ok: false,
      refused: {
        spawned: false,
        reason: receipt.reason,
        detail: receipt.detail,
      },
    };
  }
  if (receipt.phase !== phase) {
    return {
      ok: false,
      refused: {
        spawned: false,
        reason: 'malformed_receipt',
        detail: `asked the gas station for a ${phase} and it answered with a ${receipt.phase}`,
      },
    };
  }
  return { ok: true, receipt: receipt as T };
}

/**
 * The store named the signers; resolve them to the keys we hold, BY ADDRESS.
 *
 * `clientSigners` is the subset of the compiled slots that are ours to fill, and
 * `requiredSigners` is address-sorted within a role — so a positional read of
 * either is wrong for exactly the pairs of keys that happen to sort the other
 * way, which is the kind of bug that passes every test but one run in ten.
 * Signing what the receipt NAMES, rather than what this function assumes, is
 * also the only thing that stays right if a future store composes a transaction
 * where the owner is not among the client's slots.
 *
 * A receipt this client cannot honour is a REFUSAL, not an exception: two
 * packets have already been paid for by the time it is read, and a client that
 * threw here would be throwing after the packet went out.
 */
function signersFor(
  receipt: ArnsAntPrepareReceipt,
  held: Map<string, Signer>,
  expected: { mint: string; feePayer: string }
): Step<Signer[]> {
  const unheld = receipt.clientSigners.filter((signer) => !held.has(signer));
  if (unheld.length > 0) {
    return malformed(
      `the prepared transaction needs signatures this client does not hold: ${unheld.join(', ')} ` +
        `(holding ${[...held.keys()].join(' and ')})`
    );
  }
  if (receipt.feePayer !== expected.feePayer) {
    return malformed(
      `the prepared transaction names ${receipt.feePayer} as fee payer, not the quoted ${expected.feePayer}`
    );
  }
  // The mint's public half IS the ANT's address, so a `processId` that is not
  // it would send the follow-up name purchase at somebody else's asset.
  if (receipt.processId !== expected.mint) {
    return malformed(
      `the prepared transaction spawns ${receipt.processId}, not the mint ${expected.mint} it was given`
    );
  }
  const signers: Signer[] = [];
  for (const address of receipt.clientSigners) {
    const signer = held.get(address);
    if (signer !== undefined) signers.push(signer);
  }
  return { ok: true, receipt: signers };
}

/**
 * The local half of what the gas station is about to check: the fee payer is
 * slot 0, the blockhash is the quoted one, and every other slot is filled.
 *
 * Advisory only — the gas station's inspector is the authority and runs again
 * on the same bytes. This exists so that its verdict arrives for free instead of
 * for the price of an execute, which is why it answers in that inspector's own
 * vocabulary rather than inventing a second one.
 *
 * @returns The refusal, or `undefined` when the transaction is executable.
 */
function checkExecutable(
  wireBase64: string,
  expected: { feePayer: string; recentBlockhash: string }
): PartialRefusal | undefined {
  const parsed = parseSolanaWireTransaction(wireBase64);
  if (parsed.signers[0] !== expected.feePayer) {
    return {
      spawned: false,
      reason: 'fee_payer_mismatch',
      detail: `slot 0 is ${parsed.signers[0] ?? '(none)'}, not the quoted fee payer ${expected.feePayer}`,
    };
  }
  if (parsed.recentBlockhash !== expected.recentBlockhash) {
    return {
      spawned: false,
      reason: 'blockhash_mismatch',
      detail: `the transaction carries blockhash ${parsed.recentBlockhash}, not the quoted ${expected.recentBlockhash}`,
    };
  }
  const missing = parsed.unsigned.filter((signer) => signer !== expected.feePayer);
  if (missing.length > 0) {
    return {
      spawned: false,
      reason: 'missing_client_signature',
      detail: `these slots are still unsigned: ${missing.join(', ')}`,
    };
  }
  return undefined;
}

/** A job that produced no receipt, as the refusal to hand back to the caller. */
function refusalOf(
  answer: Extract<JobAnswer<unknown>, { accepted: false }>
): PartialRefusal {
  return {
    spawned: false,
    reason: answer.code,
    detail: answer.message,
    ...(answer.refusal ? { refusal: answer.refusal } : {}),
  };
}

/** The store composed something this client will not sign. */
function malformed(detail: string): { ok: false; refused: PartialRefusal } {
  return { ok: false, refused: { spawned: false, reason: 'malformed_receipt', detail } };
}
