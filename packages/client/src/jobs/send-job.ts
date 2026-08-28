/**
 * Putting a {@link JobEvent} through a connector, and reading what came back.
 *
 * A job is an ordinary paid request — `POST` the event to the route, get the
 * app's HTTP response — so this adds no wire of its own. What it adds is the
 * one decoding rule both NIP-90 apps in this protocol share, and a single
 * vocabulary for the three quite different ways a job can fail to produce a
 * receipt:
 *
 *  - **the packet was refused** — a price, a route or a seal was wrong, and the
 *    app was never reached. `send()` returns this rather than throwing, and so
 *    does {@link sendJob};
 *  - **the app rejected the event** — a missing param, an unregistered kind.
 *    It rides home on a FULFILL with `accept: false`, so it cost what a receipt
 *    would have cost;
 *  - **the app answered, and the answer is a refusal.** A gas station that
 *    declines to spend has done its job: `accept: true`, a receipt, and
 *    `status: 'failed'` inside it. That is NOT this module's business — it is a
 *    successful job, and the caller branches on the receipt's own `reason`.
 *
 * The decoding rule: a receipt is `base64(JSON)` in `data`, and both apps ALSO
 * decode it into `result` for readability. `data` is the byte-faithful one and
 * is preferred here; `result` is the fallback, so a future app that emits only
 * one of the two still works.
 */

import { fromBase64, decodeUtf8 } from '../utils/binary.js';
import type { SendRefused, SendRequest, SendResult, SendOptions } from '../client/types.js';
import type { JobEvent } from './job-event.js';

/**
 * The part of a client a job needs: the ability to pay for one HTTP request.
 * `ToonClient` satisfies it, and so does any stand-in a test supplies.
 */
export interface JobSender {
  send(
    destination: string,
    request?: SendRequest,
    options?: SendOptions
  ): Promise<SendResult>;
}

/**
 * Where a job goes: who pays for it, which route terminates it, and — on a
 * FORWARDED route — whose key the payload is sealed to.
 *
 * The store and the gas station are different nodes with different connectors
 * and different channels, so a ceremony spanning both takes two endpoints. One
 * client can serve both only when it is attached to a node that forwards to
 * each, in which case both endpoints name that client and `sealTo` names the
 * far node — see `docs/devnet.md`.
 */
export interface JobEndpoint {
  /** Pays for the request. */
  client: JobSender;
  /** The ILP address of the route that terminates at the app. */
  destination: string;
  /** The terminating connector, when `destination` is forwarded. */
  sealTo?: string | Uint8Array;
  /** Per-packet timeout, in milliseconds. */
  timeoutMs?: number;
}

/**
 * What a job produced: a decoded receipt, or the reason there is none.
 *
 * `accepted: false` never means "the app said no to what you asked" — that is a
 * receipt. It means the receipt does not exist: the packet was refused, or the
 * app rejected the event before running it.
 */
export type JobAnswer<T> =
  | { accepted: true; receipt: T }
  | {
      accepted: false;
      /** An ILP reject code for a refusal, or the app's own `F00` / `T00`. */
      code: string;
      message: string;
      /** Present when the packet never reached the app. */
      refusal?: SendRefused;
    };

/** The `{ accept, data, result, code, message }` envelope both apps answer in. */
interface JobEnvelope {
  accept?: boolean;
  data?: string;
  result?: unknown;
  /**
   * The store's answer when its `data` is NOT JSON — kind:5094 returns a bare
   * Arweave transaction id, and the backend surfaces it here rather than under
   * `result`. A documented contract, not a quirk.
   */
  txId?: unknown;
  code?: string;
  message?: string;
}

/**
 * Pay for one job and decode its receipt.
 *
 * The receipt type is the caller's assertion, not a checked fact: these apps
 * publish their receipt shapes and this client mirrors them, but nothing on the
 * wire enforces the match, so a caller reading a field it needs should still
 * check it is there.
 */
export async function sendJob<T>(
  endpoint: JobEndpoint,
  event: JobEvent
): Promise<JobAnswer<T>> {
  const answer = await endpoint.client.send(
    endpoint.destination,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { event },
    },
    {
      ...(endpoint.sealTo !== undefined ? { sealTo: endpoint.sealTo } : {}),
      ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
    }
  );

  if (!answer.fulfilled) {
    return {
      accepted: false,
      code: answer.code,
      message: `kind:${event.kind} refused by ${answer.refusedBy}: ${answer.message}`,
      refusal: answer,
    };
  }

  let envelope: JobEnvelope;
  try {
    envelope = answer.json<JobEnvelope>();
  } catch {
    return {
      accepted: false,
      code: 'F00',
      message:
        `kind:${event.kind} answered ${answer.status} with a body that is not JSON: ` +
        truncate(decodeUtf8(answer.body)),
    };
  }

  if (envelope.accept !== true) {
    return {
      accepted: false,
      code: envelope.code ?? String(answer.status),
      message: envelope.message ?? `kind:${event.kind} was not accepted`,
    };
  }

  const receipt = decodeReceipt<T>(envelope);
  if (receipt === undefined) {
    return {
      accepted: false,
      code: 'F00',
      message: `kind:${event.kind} was accepted but carried no receipt`,
    };
  }
  return { accepted: true, receipt };
}

/**
 * `data` (byte-faithful) if it decodes as JSON; otherwise whichever field the
 * app said its answer in.
 *
 * The store decides between two of those by whether its base64 `data` parses
 * as a JSON object: a receipt goes to `result`, and anything else goes to
 * `txId`. kind:5094 takes the second branch — its whole answer is one Arweave
 * transaction id — so a client that reads only `result` calls a successful
 * upload "accepted but carried no receipt".
 */
function decodeReceipt<T>(envelope: JobEnvelope): T | undefined {
  if (typeof envelope.data === 'string') {
    try {
      return JSON.parse(decodeUtf8(fromBase64(envelope.data))) as T;
    } catch {
      // Fall through: an app that base64'd something that is not JSON has still
      // said what it meant in `result` or `txId`.
    }
  }
  if (envelope.result !== null && typeof envelope.result === 'object') {
    return envelope.result as T;
  }
  // A bare id is still a receipt. Wrapped, so the caller reads `receipt.txId`
  // the same way every other job's fields are read.
  if (typeof envelope.txId === 'string' && envelope.txId.length > 0) {
    return { txId: envelope.txId } as T;
  }
  return undefined;
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
