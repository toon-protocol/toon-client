/**
 * Asking the receiving connector to sponsor a Solana `open` (connector ADR 0074
 * decision 9; connector #1346).
 *
 * `POST <connector><sponsorEndpoint>` with `{ "transaction": "<base64>" }` — the
 * payer-signed `open` {@link ./svm.js!buildSponsoredOpen} built. The connector
 * vets it against x402's acceptance policy and its own published minimums,
 * co-signs it as fee payer and `rent_payer`, submits it and waits for it to
 * land, then answers `{ channelId, transaction, payer, deposit }`. It never
 * hands the co-signed bytes back, so the client never holds a transaction that
 * decides when the connector's rent is spent.
 *
 * A refusal is `{ error, detail }` with a status by class (400 malformed, 422
 * refused, 503 unavailable, 502 failed on chain), and the name is what a
 * client acts on.
 */

import { NetworkError, SponsorRefusedError } from '../../client/errors.js';

/** The channel the connector opened. */
export interface SponsoredOpen {
  /** The channel PDA, base58. */
  channelId: string;
  /** The open's transaction signature. */
  transaction: string;
  payer: string;
  /** Atomic units, decimal. */
  deposit: string;
}

/**
 * Post a payer-signed `open` to the connector's sponsor endpoint.
 *
 * @param connector the connector's client-edge base URL.
 * @param sponsorEndpoint the path its greeting publishes.
 * @throws {SponsorRefusedError} the connector answered and did not open it.
 * @throws {NetworkError} it did not answer, or not in a shape this client reads.
 */
export async function requestSponsoredOpen(params: {
  connector: string;
  sponsorEndpoint: string;
  transaction: string;
  fetchImpl?: typeof fetch;
}): Promise<SponsoredOpen> {
  const url = new URL(
    params.sponsorEndpoint,
    `${params.connector.replace(/\/+$/, '')}/`
  ).toString();
  const fetchImpl = params.fetchImpl ?? fetch;

  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: params.transaction }),
    });
    text = await response.text();
  } catch (err) {
    throw new NetworkError(
      `sponsor endpoint ${url} did not answer`,
      err instanceof Error ? err : undefined
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new NetworkError(
      `sponsor endpoint ${url} answered HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`
    );
  }

  if (!response.ok || typeof body['error'] === 'string') {
    const reason =
      typeof body['error'] === 'string'
        ? body['error']
        : `http_${response.status}`;
    const detail =
      typeof body['detail'] === 'string' ? `: ${body['detail']}` : '';
    throw new SponsorRefusedError(
      `the connector refused to sponsor the open (${reason})${detail}`,
      reason
    );
  }

  const { channelId, transaction, payer, deposit } = body;
  if (
    typeof channelId !== 'string' ||
    typeof transaction !== 'string' ||
    typeof payer !== 'string' ||
    typeof deposit !== 'string'
  ) {
    throw new NetworkError(
      `sponsor endpoint ${url} answered with no opened channel: ${text.slice(0, 200)}`
    );
  }
  return { channelId, transaction, payer, deposit };
}
