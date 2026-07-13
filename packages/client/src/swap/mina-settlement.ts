/**
 * Mina receive-side swap settlement (toon-client#357, part of the rolling-swap
 * epic toon-meta#145; follow-up to the #352 receive-side ingestion PR).
 *
 * #352 shipped VERIFICATION of swapped-in Mina claims but explicitly left
 * REDEMPTION out: `POST /swap/settle` returned `SUBMISSION_UNSUPPORTED` for
 * `mina:*` bundles. This module is the missing redemption seam — it turns a
 * verified accumulated Mina claim into an on-chain co-signed `claimFromChannel`
 * transaction against the payment-channel zkApp.
 *
 * ## Why Mina needs a co-sign (and EVM/Solana do not)
 *
 * The zkApp's `claimFromChannel(newBalanceA, newBalanceB, newSalt, signatureA,
 * signatureB, participantA, participantB, channelNonce, newBalanceCommitment,
 * newNonce)` is DUAL-PARTY (connector#84): it verifies BOTH participants signed
 * the SAME message `[newBalanceCommitment, newNonce, storedChannelHash]`
 * (`packages/mina-zkapp/src/PaymentChannel.ts`). The client's existing
 * {@link MinaSigner} is payer-side only. On the swap RECEIVE side the client is
 * the RECIPIENT of the channel, so it must contribute the recipient's
 * co-signature (`signatureB` for its participant slot).
 *
 * ## Signature-message mismatch — the maker-side dependency
 *
 * The swap-wire claim (`AccumulatedClaim.claimBytes`) carries the maker's
 * Schnorr signature over `balanceProofFieldsMina(channelId, cumulativeAmount,
 * nonce, recipient)` (verified by the sdk's `verifyMinaSignature`). That is a
 * DIFFERENT message than the on-chain `[commitment, nonce, channelHash]`, so it
 * CANNOT be reused as an on-chain participant signature. On-chain redemption
 * therefore needs the maker to ALSO contribute a payment-channel-commitment-form
 * signature over `[commitment, nonce, channelHash]` (the same form the connector
 * payment-channel provider produces from a client claim). Until a maker delivers
 * that, {@link submitMinaSettlement} fails closed with
 * `MINA_MAKER_COSIGN_REQUIRED` (never a silent pass). See the PR body for the
 * cross-repo maker/wire follow-up.
 *
 * ## globalSlot preconditions
 *
 * Unlike `initiateClose`/`settle` (which pin `network.globalSlotSinceGenesis`
 * and were the subject of the #202 exact-slot-precondition bug), the zkApp's
 * `claimFromChannel` binds NO slot precondition — only `channelState == OPEN`,
 * `channelHash`, `depositTotal`, and a strictly-increasing `nonceField`. The
 * redeem path is therefore immune to the #202 slot-drift failure. The eventual
 * close+settle that pays escrow out to the recipient DOES touch the slot window
 * and remains the connector's `settleChannel` responsibility (a separate step).
 *
 * ## What runs where
 *
 * - On-chain STATE READ + co-sign assembly ({@link buildMinaCoSignedClaim}):
 *   plain GraphQL + `mina-signer` (Pallas Schnorr / Poseidon) — NO o1js, fully
 *   unit-testable in-process.
 * - Proof generation + broadcast ({@link submitMinaSettlement}): drives an
 *   injectable {@link MinaClaimSubmitter}; the default is an o1js-backed settler
 *   ({@link createO1jsMinaClaimSubmitter}) that dynamically imports `o1js` +
 *   `@toon-protocol/mina-zkapp` only when invoked (never loaded by the non-Mina
 *   suite). o1js circuit compilation + proving is slow (30-120s) and is exercised
 *   only against live devnet Mina behind an env gate.
 */

import { hexToMinaBase58PrivateKey } from '@toon-protocol/core';
import type { SettlementBundle } from '@toon-protocol/sdk';
import {
  buildMinaPaymentChannelProof,
  loadMinaPaymentChannelBindings,
  minaBalanceCommitment,
  minaParticipantChannelHashField,
} from '../channel/mina-payment-channel.js';
import {
  readMinaChannelState,
  MINA_CHANNEL_STATE,
  type MinaOnChainChannelState,
} from '../channel/mina-deposit.js';
import { deriveMinaSalt } from '../signing/mina-signer.js';

/** Bare Pallas Schnorr signature in the o1js JSON (decimal `r`/`s`) form. */
export interface MinaSignaturePair {
  r: string;
  s: string;
}

/** Stable failure codes for Mina receive-side settlement. */
export type MinaSettlementErrorCode =
  | 'NOT_MINA_BUNDLE'
  | 'NO_GRAPHQL_CONFIGURED'
  | 'CHANNEL_NOT_OPEN'
  | 'NONCE_NOT_ADVANCING'
  | 'CHANNEL_HASH_MISMATCH'
  | 'CUMULATIVE_EXCEEDS_DEPOSIT'
  | 'MINA_MAKER_COSIGN_REQUIRED'
  | 'PROVING_FAILED';

/** Result-shaped-by-throw settlement error carrying a stable {@link code}. */
export class MinaSettlementError extends Error {
  readonly code: MinaSettlementErrorCode;
  constructor(code: MinaSettlementErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MinaSettlementError';
    this.code = code;
  }
}

/** Inputs to {@link buildMinaCoSignedClaim} (pure assembly, no o1js). */
export interface MinaCoSignInputs {
  /** Deployed payment-channel zkApp address (B62) — the on-chain channel id. */
  channelId: string;
  /** Claim nonce being redeemed (must exceed the on-chain `nonceField`). */
  nonce: bigint;
  /** Cumulative amount credited to the recipient (base units). */
  cumulativeAmount: bigint;
  /** Recipient's Mina B62 pubkey — one channel participant (the co-signer). */
  recipient: string;
  /** Swap maker's Mina B62 pubkey — the other channel participant. */
  swapSignerAddress: string;
  /** On-chain `depositTotal` (base units) for balance conservation. */
  depositTotal: bigint;
  /** On-chain `channelHash` (decimal Field) used to resolve A/B ordering. */
  onChainChannelHash: string;
  /** Recipient's Mina private key (big-endian hex scalar OR `EK…` base58). */
  recipientPrivateKey: string;
  /** Channel nonce baked into the on-chain `channelHash` (default 0). */
  channelNonce?: bigint;
  /** Override the deterministic salt (else {@link deriveMinaSalt}). */
  saltOverride?: bigint;
  /**
   * Maker's payment-channel-commitment-form signature over
   * `[commitment, nonce, channelHash]`. REQUIRED for a fully-redeemable claim;
   * when absent the returned claim reports {@link makerSignatureMissing}.
   */
  makerSignature?: MinaSignaturePair;
}

/** A dual-party claim assembled for the zkApp's `claimFromChannel`. */
export interface MinaCoSignedClaim {
  channelId: string;
  /** Balance credited to `participantA` (base units). */
  balanceA: bigint;
  /** Balance credited to `participantB` (`depositTotal - balanceA`). */
  balanceB: bigint;
  salt: bigint;
  nonce: bigint;
  channelNonce: bigint;
  /** `Poseidon([balanceA, balanceB, salt])`, decimal Field. */
  balanceCommitment: string;
  /** Participant A B62 (ordered to reproduce the on-chain `channelHash`). */
  participantA: string;
  /** Participant B B62. */
  participantB: string;
  /** Which participant slot the recipient/co-signer occupies. */
  recipientRole: 'A' | 'B';
  /** The recipient's co-signature over `[commitment, nonce, channelHash]`. */
  recipientSignature: MinaSignaturePair;
  /** Signature for participant A (recipient's or maker's per {@link recipientRole}). */
  signatureA?: MinaSignaturePair;
  /** Signature for participant B. */
  signatureB?: MinaSignaturePair;
  /** True when no maker co-signature was supplied (claim not yet redeemable). */
  makerSignatureMissing: boolean;
}

/** Extract the bare `{ r, s }` from a `buildMinaPaymentChannelProof` proof JSON. */
function parseProofSignature(proofJson: string): MinaSignaturePair {
  const parsed = JSON.parse(proofJson) as {
    signature?: { r?: unknown; s?: unknown };
  };
  const r = parsed.signature?.r;
  const s = parsed.signature?.s;
  if (typeof r !== 'string' || typeof s !== 'string') {
    throw new Error('recipient co-signature proof did not carry string r/s');
  }
  return { r, s };
}

/**
 * Assemble a dual-party `claimFromChannel` claim from a verified swap claim.
 *
 * Pure crypto (GraphQL-read state is passed in): resolves the on-chain A/B
 * participant ordering by reproducing `channelHash`, conserves balances against
 * `depositTotal`, computes the Poseidon commitment, and produces the recipient's
 * co-signature over `[commitment, nonce, channelHash]` with `mina-signer`. No
 * o1js is loaded.
 *
 * @throws {MinaSettlementError} `CHANNEL_HASH_MISMATCH` when neither ordering of
 *   `{recipient, swapSignerAddress}` reproduces `onChainChannelHash`;
 *   `CUMULATIVE_EXCEEDS_DEPOSIT` when the credit exceeds the escrow.
 */
export async function buildMinaCoSignedClaim(
  inputs: MinaCoSignInputs
): Promise<MinaCoSignedClaim> {
  const channelNonce = inputs.channelNonce ?? 0n;
  const salt =
    inputs.saltOverride ?? deriveMinaSalt(inputs.channelId, Number(inputs.nonce));

  if (inputs.cumulativeAmount > inputs.depositTotal) {
    throw new MinaSettlementError(
      'CUMULATIVE_EXCEEDS_DEPOSIT',
      `claim cumulativeAmount (${inputs.cumulativeAmount}) exceeds the channel ` +
        `depositTotal (${inputs.depositTotal}) — cannot conserve balances`
    );
  }

  const { Poseidon, PublicKey } = await loadMinaPaymentChannelBindings();

  // Resolve which participant slot each party occupies by reproducing the
  // on-chain channelHash = Poseidon([A.x, B.x, channelNonce]). The zkApp verifies
  // signatureA against participantA and signatureB against participantB, so the
  // balances + signatures must be assigned to the ordering the channel was
  // opened with.
  const hashRecipientFirst = minaParticipantChannelHashField(
    Poseidon,
    PublicKey,
    inputs.recipient,
    inputs.swapSignerAddress,
    channelNonce
  ).toString();
  const hashMakerFirst = minaParticipantChannelHashField(
    Poseidon,
    PublicKey,
    inputs.swapSignerAddress,
    inputs.recipient,
    channelNonce
  ).toString();

  let participantA: string;
  let participantB: string;
  let recipientRole: 'A' | 'B';
  if (hashRecipientFirst === inputs.onChainChannelHash) {
    participantA = inputs.recipient;
    participantB = inputs.swapSignerAddress;
    recipientRole = 'A';
  } else if (hashMakerFirst === inputs.onChainChannelHash) {
    participantA = inputs.swapSignerAddress;
    participantB = inputs.recipient;
    recipientRole = 'B';
  } else {
    throw new MinaSettlementError(
      'CHANNEL_HASH_MISMATCH',
      `neither ordering of recipient ${inputs.recipient} / maker ` +
        `${inputs.swapSignerAddress} reproduces the on-chain channelHash ` +
        `${inputs.onChainChannelHash} (channelNonce ${channelNonce})`
    );
  }

  // Recipient-credit: the recipient's balance is the cumulative amount; the
  // maker (funder) keeps the remainder. Assign to A/B by the resolved ordering.
  const recipientBalance = inputs.cumulativeAmount;
  const makerBalance = inputs.depositTotal - inputs.cumulativeAmount;
  const balanceA = recipientRole === 'A' ? recipientBalance : makerBalance;
  const balanceB = inputs.depositTotal - balanceA;

  const balanceCommitment = minaBalanceCommitment(
    Poseidon,
    balanceA,
    balanceB,
    salt
  ).toString();

  // Recipient co-signs [commitment, nonce, channelHash] with its own key over
  // the SAME participant-form channelHash the zkApp stored. Reuse the connector-
  // parity proof builder so signer and on-chain verifier cannot drift.
  const recipientPrivateKeyBase58 = hexToMinaBase58PrivateKey(
    inputs.recipientPrivateKey
  );
  const built = await buildMinaPaymentChannelProof({
    zkAppAddress: inputs.channelId,
    minaPrivateKeyBase58: recipientPrivateKeyBase58,
    signerPublicKey: inputs.recipient,
    balanceA,
    balanceB,
    salt,
    nonce: inputs.nonce,
    participantA,
    participantB,
    channelNonce,
    proofEncoding: 'json',
  });
  if (built.balanceCommitment !== balanceCommitment) {
    // Defense-in-depth: the proof builder recomputes the commitment; a mismatch
    // means the two Poseidon paths diverged (should never happen).
    throw new Error(
      `co-sign commitment drift: builder ${built.balanceCommitment} != ${balanceCommitment}`
    );
  }
  const recipientSignature = parseProofSignature(built.proof);

  const signatureA =
    recipientRole === 'A' ? recipientSignature : inputs.makerSignature;
  const signatureB =
    recipientRole === 'B' ? recipientSignature : inputs.makerSignature;

  return {
    channelId: inputs.channelId,
    balanceA,
    balanceB,
    salt,
    nonce: inputs.nonce,
    channelNonce,
    balanceCommitment,
    participantA,
    participantB,
    recipientRole,
    recipientSignature,
    ...(signatureA ? { signatureA } : {}),
    ...(signatureB ? { signatureB } : {}),
    makerSignatureMissing: inputs.makerSignature === undefined,
  };
}

/** Arguments handed to a {@link MinaClaimSubmitter} (o1js proving boundary). */
export interface MinaClaimSubmitArgs {
  /** Mina GraphQL endpoint bound as the active o1js network. */
  graphqlUrl: string;
  /** Channel zkApp address (B62). */
  channelId: string;
  balanceA: bigint;
  balanceB: bigint;
  salt: bigint;
  nonce: bigint;
  /** Participant pubkeys (B62), ordered to match the on-chain `channelHash`. */
  participantA: string;
  participantB: string;
  channelNonce: bigint;
  signatureA: MinaSignaturePair;
  signatureB: MinaSignaturePair;
  /** Fee-payer / submitter Mina private key (hex scalar or `EK…` base58). */
  feePayerPrivateKey: string;
  /** zkApp tx fee (nanomina); the default settler applies 0.1 MINA when unset. */
  txFeeNanomina?: bigint;
}

/**
 * Generates the o1js proof and broadcasts the `claimFromChannel` tx. Injected so
 * the assembly logic can be unit-tested without loading the WASM circuit runtime.
 */
export interface MinaClaimSubmitter {
  claimFromChannel(args: MinaClaimSubmitArgs): Promise<{ txHash: string }>;
}

/** Read seam for the on-chain channel state (default: plain GraphQL). */
export type MinaChannelStateReader = (
  graphqlUrl: string,
  zkAppAddress: string
) => Promise<MinaOnChainChannelState>;

/** Context for {@link submitMinaSettlement}. */
export interface MinaSettlementContext {
  /** Mina GraphQL URL (reads state + binds the o1js network). */
  graphqlUrl?: string;
  /** Recipient's Mina private key (co-signs; also the default fee payer). */
  recipientPrivateKey: string;
  /** Maker's on-chain-form co-signature over `[commitment, nonce, channelHash]`. */
  makerSignature?: MinaSignaturePair;
  /** Fee-payer key override (defaults to `recipientPrivateKey`). */
  feePayerPrivateKey?: string;
  /** zkApp tx fee (nanomina). */
  txFeeNanomina?: bigint;
  /** Channel nonce for the on-chain `channelHash` (default 0). */
  channelNonce?: bigint;
  /** Inject a state reader (tests). Defaults to {@link readMinaChannelState}. */
  reader?: MinaChannelStateReader;
  /** Inject a proof submitter (tests). Defaults to an o1js-backed settler. */
  submitter?: MinaClaimSubmitter;
}

export interface MinaSettlementResult {
  txHash: string;
}

/**
 * Redeem a verified Mina swap claim via a co-signed on-chain `claimFromChannel`.
 *
 * Env/config-gated like the EVM path: with no `graphqlUrl` the caller gets
 * `NO_GRAPHQL_CONFIGURED` (built-not-submitted). Reads the live channel state,
 * asserts it is OPEN and the claim nonce advances the on-chain watermark,
 * assembles the dual-party claim ({@link buildMinaCoSignedClaim}), and — only
 * with a maker co-signature present — drives the o1js proof + broadcast.
 *
 * @throws {MinaSettlementError} with a stable {@link MinaSettlementErrorCode}.
 */
export async function submitMinaSettlement(
  bundle: SettlementBundle,
  context: MinaSettlementContext
): Promise<MinaSettlementResult> {
  if (bundle.chainKind !== 'mina') {
    throw new MinaSettlementError(
      'NOT_MINA_BUNDLE',
      `submitMinaSettlement only settles mina bundles (got ${bundle.chainKind} for ${bundle.chain})`
    );
  }
  if (!context.graphqlUrl) {
    throw new MinaSettlementError(
      'NO_GRAPHQL_CONFIGURED',
      `no Mina graphqlUrl configured for "${bundle.chain}" — set minaChannel.graphqlUrl to enable receive-side settlement.`
    );
  }
  const graphqlUrl = context.graphqlUrl;
  const channelNonce = context.channelNonce ?? 0n;
  const nonce = BigInt(bundle.nonce);
  const cumulativeAmount = BigInt(bundle.cumulativeAmount);

  const read = context.reader ?? readMinaChannelState;
  const state = await read(graphqlUrl, bundle.channelId);

  if (state.channelState !== MINA_CHANNEL_STATE.OPEN) {
    throw new MinaSettlementError(
      'CHANNEL_NOT_OPEN',
      `channel ${bundle.channelId} is not OPEN (channelState=${state.channelState}); claimFromChannel only applies to an OPEN channel.`
    );
  }
  if (nonce <= state.nonceField) {
    throw new MinaSettlementError(
      'NONCE_NOT_ADVANCING',
      `claim nonce ${nonce} does not advance the on-chain nonceField ${state.nonceField} for ${bundle.channelId} (already claimed).`
    );
  }

  const claim = await buildMinaCoSignedClaim({
    channelId: bundle.channelId,
    nonce,
    cumulativeAmount,
    recipient: bundle.recipient,
    swapSignerAddress: bundle.swapSignerAddress,
    depositTotal: state.depositTotal,
    onChainChannelHash: state.channelHash,
    recipientPrivateKey: context.recipientPrivateKey,
    channelNonce,
    ...(context.makerSignature ? { makerSignature: context.makerSignature } : {}),
  });

  if (claim.makerSignatureMissing || !claim.signatureA || !claim.signatureB) {
    throw new MinaSettlementError(
      'MINA_MAKER_COSIGN_REQUIRED',
      `on-chain claimFromChannel is dual-party: it needs the maker's ` +
        `payment-channel-commitment signature over [commitment, nonce, channelHash] ` +
        `in addition to the recipient's co-signature. The swap-wire claim only carries ` +
        `the maker's balanceProofFieldsMina signature (a different message), so the maker ` +
        `must additionally deliver an on-chain-form co-signature. Recipient co-signature ` +
        `assembled and ready (${bundle.channelId} nonce ${nonce}).`
    );
  }

  const submitter = context.submitter ?? createO1jsMinaClaimSubmitter();
  const { txHash } = await submitter.claimFromChannel({
    graphqlUrl,
    channelId: bundle.channelId,
    balanceA: claim.balanceA,
    balanceB: claim.balanceB,
    salt: claim.salt,
    nonce: claim.nonce,
    participantA: claim.participantA,
    participantB: claim.participantB,
    channelNonce: claim.channelNonce,
    signatureA: claim.signatureA,
    signatureB: claim.signatureB,
    feePayerPrivateKey:
      context.feePayerPrivateKey ?? context.recipientPrivateKey,
    ...(context.txFeeNanomina !== undefined
      ? { txFeeNanomina: context.txFeeNanomina }
      : {}),
  });
  return { txHash };
}

/** Default zkApp tx fee (0.1 MINA in nanomina) — real networks reject 0-fee txs. */
const DEFAULT_MINA_TX_FEE_NANOMINA = 100_000_000n;

/**
 * Build the default o1js-backed {@link MinaClaimSubmitter}.
 *
 * Mirrors the connector's `MinaPaymentChannelSDK.claimFromChannel`: binds the
 * active Mina network, fetches the channel + fee-payer accounts, deserializes the
 * `{r,s}` signatures, and builds + proves + broadcasts the zkApp
 * `claimFromChannel` method. o1js and `@toon-protocol/mina-zkapp` are imported
 * dynamically INSIDE `claimFromChannel` so the non-Mina test suite never loads
 * the multi-hundred-MB WASM circuit runtime. Compilation + proving are slow
 * (30-120s) and only run against live devnet Mina.
 */
export function createO1jsMinaClaimSubmitter(): MinaClaimSubmitter {
  return {
    async claimFromChannel(args: MinaClaimSubmitArgs): Promise<{ txHash: string }> {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const o1js: any = await import('o1js');
        const {
          Mina,
          PrivateKey,
          PublicKey,
          Field,
          Poseidon,
          Signature,
          fetchAccount,
        } = o1js;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const zkAppMod: any = await import('@toon-protocol/mina-zkapp');
        const PaymentChannel = zkAppMod.PaymentChannel;

        Mina.setActiveInstance(Mina.Network(args.graphqlUrl));

        const feePayerKey = PrivateKey.fromBase58(
          hexToMinaBase58PrivateKey(args.feePayerPrivateKey)
        );
        const feePayerPub = feePayerKey.toPublicKey();

        await PaymentChannel.compile();

        const zkAppPub = PublicKey.fromBase58(args.channelId);
        await fetchAccount({ publicKey: zkAppPub });
        await fetchAccount({ publicKey: feePayerPub });
        const zkApp = new PaymentChannel(zkAppPub);

        const balA = Field(args.balanceA);
        const balB = Field(args.balanceB);
        const saltField = Field(args.salt);
        const newNonce = Field(args.nonce);
        const channelNonce = Field(args.channelNonce);
        const newBalanceCommitment = Poseidon.hash([balA, balB, saltField]);
        const sigA = Signature.fromJSON({
          r: args.signatureA.r,
          s: args.signatureA.s,
        });
        const sigB = Signature.fromJSON({
          r: args.signatureB.r,
          s: args.signatureB.s,
        });
        const partA = PublicKey.fromBase58(args.participantA);
        const partB = PublicKey.fromBase58(args.participantB);

        const fee = (
          args.txFeeNanomina ?? DEFAULT_MINA_TX_FEE_NANOMINA
        ).toString();
        const txn = await Mina.transaction(
          { sender: feePayerPub, fee },
          async () => {
            await zkApp.claimFromChannel(
              balA,
              balB,
              saltField,
              sigA,
              sigB,
              partA,
              partB,
              channelNonce,
              newBalanceCommitment,
              newNonce
            );
          }
        );
        await txn.prove();
        const sent = await txn.sign([feePayerKey]).send();
        return { txHash: sent.hash ?? '' };
      } catch (err) {
        throw new MinaSettlementError(
          'PROVING_FAILED',
          err instanceof Error ? err.message : String(err)
        );
      }
    },
  };
}
