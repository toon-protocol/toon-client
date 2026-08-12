/**
 * Serve-side job handling (toon-client#494, toon-meta#262 "agents earning").
 *
 * The connector originates a server-originated BTP MESSAGE carrying a PREPARE
 * for this client's registered ILP address (RFC-0023 symmetric grammar,
 * toon-client#493) — the earning half of the wire that `sendSwapPacket` /
 * `publishEvent` already use to PAY. {@link createJobMessageHandler} plugs a
 * caller-supplied {@link JobHandler} into `BtpRuntimeClientConfig.onMessage`
 * so a provider writes a handler, never a payments integration
 * (`connector-runtime/src/app_client.rs`'s payment-oblivious app contract,
 * carried over to the BTP-served case this ticket adds).
 *
 * Delivery is hashlock (toon-meta#262 decision 5, `hashlock-delivery.ts`
 * toon-client#495): the handler returns the fulfillment preimage it already
 * minted at quote time via {@link encryptArtifact}/{@link fulfillIncrement} —
 * this module never derives a condition/preimage relationship itself, only
 * verifies the handler's answer against the PREPARE's own condition before
 * it goes on the wire.
 *
 * Sealing at a client destination (toon-client#537, toon-meta#266 §7): under
 * epic decision 6 THIS client — the BTP session terminating the PREPARE, not
 * any connector — is the destination a buyer sealed to (ADR 0018). Passing
 * `identity` opens `job.data` as a gift wrap addressed to it before the
 * handler ever runs, and seals the handler's answer back with the same
 * shared secret (ADR 0018's bidirectional rule) before it goes on the FULFILL.
 * Additive: omitting `identity` reproduces the pre-#537 behaviour exactly —
 * `data` passes through unexamined in both directions, unchanged.
 *
 * Error policy (ADR 0020 "you pay for an answer, not the answer you
 * wanted", RFC-0027 F99 "Application Error — the terminating app declined
 * the delivery, or supplied no fulfilment matching the execution
 * condition"): a handler that throws, or whose returned fulfillment does not
 * satisfy the PREPARE's condition, answers F99 — the two cases RFC-0027's
 * own F99 gloss already names together. An already-expired PREPARE is
 * refused R00 without ever invoking the handler, so a provider is never
 * asked to do paid work for a packet that can no longer be honored. An
 * undecodable PREPARE is refused F00, and so is a PREPARE whose `data` will
 * not open under `identity` — distinct from F00's decode failure only in its
 * message, since RFC-0027 has no dedicated "wrong destination key" code, but
 * never conflated with F99: a wrap that never opened is not something the
 * handler ever saw or had a chance to decline. None of these paths ever
 * throw back into the BTP transport — every outcome is an answer (a
 * RESPONSE frame carrying FULFILL or REJECT), matching the symmetric
 * grammar's "every request gets an answer" contract.
 */

import type {
  BtpHandlerResponse,
  BtpMessageHandler,
  InboundBtpMessage,
} from './btp/IsomorphicBtpClient.js';
import {
  deserializeIlpPrepare,
  serializeIlpFulfill,
  serializeIlpReject,
} from './btp/protocol.js';
import { fulfillmentMatchesCondition } from './utils/condition.js';
import {
  GiftWrapError,
  openRequest,
  sealResponse,
  type GiftWrapEcdh,
} from './wire/giftwrap.js';

/** One connector-originated job PREPARE, decoded and ready for a handler. */
export interface JobRequest {
  /** The packet's paid amount (base units) — informational only; see ADR 0020. */
  amount: bigint;
  /** The ILP address the PREPARE addressed (this client's own, per §1.9). */
  destination: string;
  /** The hashlock condition the handler's fulfillment must satisfy. */
  executionCondition: Uint8Array;
  /** When this PREPARE can no longer be honored. */
  expiresAt: Date;
  /**
   * The application payload. When {@link createJobMessageHandler} is given
   * `identity`, the PREPARE's `data` is a gift wrap addressed to this client
   * (ADR 0018, toon-client#537) and this is already the OPENED plaintext —
   * never the raw wrap. Without `identity`, this is the raw `data` bytes,
   * passed through unexamined, exactly as before (additive).
   */
  data: Uint8Array;
}

/** What a {@link JobHandler} answers a job with. */
export interface JobAnswer {
  /**
   * The fulfillment preimage — reveals the hashlock key (toon-meta#262
   * decision 5). MUST satisfy `sha256(fulfillment) === executionCondition`;
   * see {@link fulfillIncrement} in `hashlock-delivery.ts` for the one call
   * site that should ever produce this value.
   */
  fulfillment: Uint8Array;
  /**
   * Answer payload. Defaults to empty. When `identity` was supplied to
   * {@link createJobMessageHandler}, this plaintext is sealed with the
   * request's own shared secret (ADR 0018's bidirectional rule) before it
   * goes on the FULFILL's `data` field; without `identity` it rides
   * unexamined, exactly as before.
   */
  data?: Uint8Array;
}

/**
 * A provider's job handler: receives a job and returns an answer. Amount,
 * payer and chain never arrive as parameters here (ADR 0020's payment-
 * oblivious app contract) — the handler is never something that must verify
 * a payment, only produce a fulfillment for one already validated by the
 * claim gate before this MESSAGE was ever originated.
 */
export type JobHandler = (job: JobRequest) => Promise<JobAnswer> | JobAnswer;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Builds a REJECT-carrying {@link BtpHandlerResponse}. */
function rejectResponse(
  code: string,
  message: string,
  triggeredBy?: string
): BtpHandlerResponse {
  return {
    ilpPacket: serializeIlpReject({
      code,
      ...(triggeredBy !== undefined ? { triggeredBy } : {}),
      message,
      data: new Uint8Array(0),
    }),
  };
}

/**
 * Wraps a {@link JobHandler} as a `BtpRuntimeClientConfig`/`IsomorphicBtpClientConfig`
 * `onMessage` handler: decodes an inbound job PREPARE, invokes `handler`, and
 * answers with a RESPONSE carrying FULFILL or REJECT — see this module's own
 * doc for the exact error-code policy.
 *
 * A server-originated MESSAGE that carries no PREPARE at all (§1.9 step 1's
 * auth MESSAGE, or a claim-only standalone MESSAGE) is not a job; it is
 * answered with an empty RESPONSE, unchanged from the pre-#494 default.
 *
 * @param identity This client's own ADR 0018 secret key (or a
 *   {@link GiftWrapEcdh} for a remote/hardware-backed one) — the counterpart
 *   to `ToonClient.getSealingPublicKey()`. When supplied, a PREPARE whose
 *   `data` does not open as a gift wrap addressed to it is refused before
 *   `handler` ever runs, `job.data` is the opened plaintext, and the
 *   handler's answer is sealed back with the same shared secret. Omit it to
 *   reproduce the pre-#537 behaviour exactly: `data` passes through
 *   unsealed in both directions (toon-client#537, toon-meta#266 §7).
 */
export function createJobMessageHandler(
  handler: JobHandler,
  identity?: Uint8Array | GiftWrapEcdh
): BtpMessageHandler {
  return async (message: InboundBtpMessage): Promise<BtpHandlerResponse> => {
    if (!message.ilpPacket || message.ilpPacket.length === 0) {
      return {};
    }

    let prepared: JobRequest;
    try {
      prepared = deserializeIlpPrepare(message.ilpPacket);
    } catch (error) {
      return rejectResponse('F00', `undecodable PREPARE: ${errText(error)}`);
    }

    if (prepared.expiresAt.getTime() <= Date.now()) {
      return rejectResponse(
        'R00',
        'PREPARE already expired; the handler was never invoked',
        prepared.destination
      );
    }

    // Unseal at the CLIENT destination (toon-meta#266 §7 step 5) — this
    // client is the terminus a buyer sealed to, not a connector, so opening
    // the wrap happens here, before the handler ever sees `data`.
    let job = prepared;
    let sharedSecret: Uint8Array | undefined;
    if (identity !== undefined) {
      try {
        const opened = openRequest(prepared.data, identity);
        job = { ...prepared, data: opened.envelopeBytes };
        sharedSecret = opened.sharedSecret;
      } catch (error) {
        if (!(error instanceof GiftWrapError)) throw error;
        return rejectResponse(
          'F00',
          `sealed PREPARE data did not open under this client's identity: ${error.message}`,
          prepared.destination
        );
      }
    }

    let answer: JobAnswer;
    try {
      answer = await handler(job);
    } catch (error) {
      return rejectResponse('F99', errText(error), job.destination);
    }

    if (!fulfillmentMatchesCondition(answer.fulfillment, job.executionCondition)) {
      return rejectResponse(
        'F99',
        'handler fulfillment does not match the PREPARE execution condition',
        job.destination
      );
    }

    const answerData = answer.data ?? new Uint8Array(0);
    return {
      ilpPacket: serializeIlpFulfill({
        fulfillment: answer.fulfillment,
        // Seal the answer back with the request's own secret (ADR 0018's
        // bidirectional rule) whenever the request itself was sealed;
        // unsealed in, unsealed out otherwise (additive).
        data:
          sharedSecret !== undefined
            ? sealResponse(sharedSecret, answerData)
            : answerData,
      }),
    };
  };
}
