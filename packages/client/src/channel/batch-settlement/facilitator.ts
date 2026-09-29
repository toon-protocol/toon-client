/**
 * Handing an x402 `batch-settlement` deposit to a facilitator, which submits it
 * and pays its gas (connector ADR 0074, prerequisite 2).
 *
 * This is the one step of paying from an x402 channel that leaves the packet
 * path: the deposit goes to a stock x402 facilitator's `/settle`, exactly as an
 * x402 resource server would send it, and every voucher afterwards travels
 * inside ILP. The body is x402 v2's settle request (`@x402/core`'s
 * `HTTPFacilitatorClient.settle`): the payload, wrapped with the requirements it
 * answers, which here are the connector's own `accepts[]` offer.
 */

import type { BatchDepositPayload, BatchSettlementEvmOffer } from './evm.js';
import { FacilitatorError, NetworkError } from '../../client/errors.js';

/** The deposit as the chain now holds it. */
export interface SettledDeposit {
  /** The deposit's transaction hash, sent from the facilitator's signer. */
  transaction: string;
  network: string;
}

/**
 * POST a deposit to `<facilitatorUrl>/settle`, and return its transaction.
 *
 * The requirements sent are the offer with `extra.withdrawDelay` set to the
 * channel's own: the offer publishes a MINIMUM, a channel may choose longer, and
 * a stock facilitator requires the two to be equal (x402 EVM spec, rule 5).
 *
 * @throws {FacilitatorError} when the facilitator refuses it — its `errorReason`
 *   is carried as `reason` — or answers with something that is not a settle
 *   result (`reason` `unreadable_response`).
 * @throws {NetworkError} when it does not answer at all.
 */
export async function settleDeposit(params: {
  facilitatorUrl: string;
  offer: BatchSettlementEvmOffer;
  payload: BatchDepositPayload<unknown>;
  /**
   * x402 extensions for the facilitator — a gas-sponsored Permit2 approval
   * (`deposit-gas.ts`) — carried as `paymentPayload.extensions`.
   */
  extensions?: Record<string, { info: Record<string, unknown> }>;
  fetchImpl?: typeof fetch;
}): Promise<SettledDeposit> {
  const { payload } = params;
  const offer: BatchSettlementEvmOffer = {
    ...params.offer,
    extra: {
      ...params.offer.extra,
      withdrawDelay: payload.channelConfig.withdrawDelay,
    },
  };
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = `${params.facilitatorUrl.replace(/\/+$/, '')}/settle`;

  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          accepted: offer,
          payload,
          ...(params.extensions ? { extensions: params.extensions } : {}),
        },
        paymentRequirements: offer,
      }),
    });
    text = await response.text();
  } catch (err) {
    throw new NetworkError(
      `facilitator ${url} did not answer`,
      err instanceof Error ? err : undefined
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FacilitatorError(
      `facilitator ${url} answered HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
      'unreadable_response'
    );
  }
  if (typeof body !== 'object' || body === null || !('success' in body)) {
    throw new FacilitatorError(
      `facilitator ${url} answered HTTP ${response.status} with no settle result: ${text.slice(0, 200)}`,
      'unreadable_response'
    );
  }

  const result = body as {
    success: unknown;
    errorReason?: unknown;
    errorMessage?: unknown;
    transaction?: unknown;
    network?: unknown;
  };
  if (
    result.success !== true ||
    typeof result.transaction !== 'string' ||
    !result.transaction
  ) {
    const reason =
      typeof result.errorReason === 'string' ? result.errorReason : 'unknown';
    const detail =
      typeof result.errorMessage === 'string' ? `: ${result.errorMessage}` : '';
    throw new FacilitatorError(
      `facilitator refused the deposit (${reason})${detail}`,
      reason
    );
  }
  return {
    transaction: result.transaction,
    network:
      typeof result.network === 'string' ? result.network : offer.network,
  };
}
