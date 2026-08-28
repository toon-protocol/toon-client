/**
 * Which carriage to pay a node over, decided BEFORE a packet is formed.
 *
 * The connector serves ILP-over-HTTP (`POST /ilp`) and BTP (`GET /ilp/btp`) on
 * the same port, and a route's transport policy — `both` by default, or
 * restricted to one — is per-connector configuration, not a protocol constant
 * (`client-edge-spec.md` §1.4 "Transport policy", issue #701). A request over a
 * carriage its route does not accept is refused before payment is considered at
 * all: `402` on HTTP, an `F02` REJECT on BTP, both carrying the same x402 terms
 * with `extra.requiredTransport` naming the carriage the route does require.
 *
 * So a 1.0 client asks first. The node's self-description (`GET /ilp`) carries
 * `httpEndpoint`, `btpEndpoint` and — when every route covering the node's own
 * addresses agrees on one — `requiredTransport`, and this module reads a
 * carriage off that document. That is the whole of the change from 0.x, which
 * had no such document: it keyed this decision on a peer discovered from a
 * kind:10032 relay announce, then POSTed over HTTP and treated the resulting
 * `402`/`401` as the signal to retry over BTP. Both halves of that are gone —
 * the announce (connector ADR 0046) and the catch-a-failure fallback.
 *
 * This module decides; it opens nothing. Turning a {@link TransportChoice} into
 * a live transport is the caller's job.
 */

import type { NodeSelfDescription } from '../connector/self-description.js';
import type { TransportPreference } from '../client/types.js';
import { TransportRequiredError } from '../client/errors.js';

/**
 * `'auto'` is a preference, not an instruction: it defers to the node. An
 * explicit `'http'`/`'btp'` is an instruction, and is refused rather than
 * silently downgraded when the node publishes no such endpoint — a client that
 * asked for BTP and got HTTP would be paying over a carriage it deliberately
 * did not choose.
 */
export type { TransportPreference };

/** The carriage to use, and the absolute URL to reach it at. */
export interface TransportChoice {
  kind: 'http' | 'btp';
  /**
   * `POST /ilp` for `http`, the `ws(s)://` websocket URL for `btp` — absolute,
   * resolved against the base the description was read from when the node
   * published a relative endpoint.
   */
  url: string;
}

/**
 * Choose a carriage for `description`.
 *
 * - `'http'` / `'btp'`: honoured when the node publishes that endpoint;
 *   {@link TransportRequiredError} otherwise, naming the node's own
 *   `requiredTransport` when it stated one so the caller learns what to ask
 *   for instead.
 * - `'auto'`: `description.requiredTransport` when the node set it, else HTTP
 *   when it publishes an `httpEndpoint`, else BTP. HTTP is the default because
 *   it is stateless — one request, no session to keep alive — and a client
 *   that needs ordered claim nonces across many writes is a client that will
 *   ask for BTP explicitly (§1.9: one socket, one order, no racing into
 *   `F01 NonceNotAdvancing`).
 *
 * @param description the node's `GET /ilp` answer.
 * @param preference what the caller asked for. Default `'auto'`.
 * @param baseUrl the client-edge URL the description was read from, for
 *   resolving a relative endpoint. Defaults to `description.readFrom`, which
 *   `ConnectorEdgeClient.describe` records; an absolute endpoint needs neither.
 * @throws {TransportRequiredError} the requested carriage is unavailable, or
 *   the node publishes no usable endpoint at all.
 */
export function selectTransport(
  description: NodeSelfDescription,
  preference: TransportPreference = 'auto',
  baseUrl: string | undefined = description.readFrom
): TransportChoice {
  const http = resolveEndpoint(description.httpEndpoint, baseUrl);
  const btp = resolveEndpoint(description.btpEndpoint, baseUrl);
  const required = description.requiredTransport;

  if (preference === 'http' || preference === 'btp') {
    const url = preference === 'http' ? http : btp;
    if (url === undefined) {
      throw new TransportRequiredError(
        `the connector publishes no ${preference} endpoint` +
          (required !== undefined
            ? `; its self-description requires the ${required} transport`
            : ''),
        required !== undefined ? { required } : {}
      );
    }
    return { kind: preference, url };
  }

  // 'auto'. A node that states `requiredTransport` has already made this
  // decision — every route covering its own addresses agrees on one carriage —
  // so honouring it is not a preference but the only way a packet gets routed.
  if (required !== undefined) {
    const url = required === 'http' ? http : btp;
    if (url === undefined) {
      throw new TransportRequiredError(
        `the connector requires the ${required} transport but publishes no ${required} endpoint`,
        { required }
      );
    }
    return { kind: required, url };
  }

  if (http !== undefined) return { kind: 'http', url: http };
  if (btp !== undefined) return { kind: 'btp', url: btp };
  throw new TransportRequiredError(
    'the connector publishes neither an httpEndpoint nor a btpEndpoint'
  );
}

/**
 * Make a published endpoint absolute.
 *
 * A node's endpoints are configured strings, not introspected ones — a
 * container sees `0.0.0.0:4000` and can never learn its own public name
 * (`connector_domain::NodeFacts`) — so an operator MAY publish a relative one,
 * as the sibling x402 greeting field literally does (`"httpEndpoint": "/ilp"`).
 * A relative endpoint means "on the origin that answered", which is exactly
 * what `baseUrl` is. An already-absolute endpoint is returned unchanged, and an
 * unresolvable one is passed through rather than dropped: a caller reporting a
 * bad URL is more useful than one reporting no endpoint at all.
 */
function resolveEndpoint(
  endpoint: string | undefined,
  baseUrl: string | undefined
): string | undefined {
  const trimmed = endpoint?.trim();
  if (!trimmed) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}
