/**
 * Everything this client throws.
 *
 * ## The rule that orders this file
 *
 * **A reject is returned as `fulfilled: false`; it is never thrown.** Everything
 * declared here happened either *before* the packet went out — a missing key, a
 * route with no price, a chain this client holds no key for, a greeting demanding
 * payment or a different carriage — or *on chain*, where a transaction of the
 * caller's own reverted. Nothing here is the connector's verdict on a packet that
 * actually travelled.
 *
 * That split is not stylistic. A refusal is an outcome the wire is designed to
 * produce (`client-edge-spec.md` §1.3's five-step gate ends in a REJECT, not a
 * transport failure), and it carries facts a caller wants — what the path cost,
 * which claim was spent, who refused. Flattening it into an exception would throw
 * those away and would put the ordinary case of "you underpaid, here is the
 * price" onto the same path as "your RPC is unreachable".
 *
 * The one edge: {@link PaymentRequiredError} and {@link TransportRequiredError}
 * are *thrown by the transports* when the connector answers HTTP `402` rather
 * than routing at all, because at that layer there is no packet outcome to
 * return. {@link ../client/send.js}'s pipeline catches both and converts them
 * into a {@link ../client/types.js!SendRefused} with `refusedBy: 'edge'`, so a
 * caller of {@link ../client/ToonClient.js!ToonClient.send} still never sees a
 * refusal as an exception.
 */
import type { PaymentTerms, ChainKind } from './types.js';

/**
 * Base error class for all TOON client errors.
 */
export class ToonClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    cause?: Error
  ) {
    super(message, { cause });
    this.name = 'ToonClientError';
  }
}

/**
 * Network error for connection failures (ECONNREFUSED, ETIMEDOUT).
 * These errors trigger retry logic with exponential backoff.
 */
export class NetworkError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'NETWORK_ERROR', cause);
    this.name = 'NetworkError';
  }
}

/**
 * Connector error for a transport-level failure at the client edge: a `4xx`
 * that is not a greeting, or a `5xx`.
 *
 * Deliberately NOT how an ILP reject arrives. `client-edge-spec.md` §1.1 gives
 * `POST /ilp` a `200` for both a FULFILL and a REJECT, and reserves non-2xx for
 * the request never having become a packet at all (400 undecodable, 401 bad
 * `ILP-Peer-Id`, 413 over 2 MiB). So this class means "the connector did not
 * process a packet", never "the connector refused one".
 */
export class ConnectorError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTOR_ERROR', cause);
    this.name = 'ConnectorError';
  }
}

/**
 * Validation error for invalid input parameters.
 * These errors are thrown before making any HTTP requests.
 */
export class ValidationError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'ValidationError';
  }
}

// ─── Configuration and capability ───────────────────────────────────────────

/**
 * The configuration this client was handed cannot produce a working client, and
 * no amount of retrying will change that: no key material, a connector URL that
 * is not a URL, a negative deposit — or a fact this client checked against the
 * chain and found to disagree with what the node published.
 *
 * That last case is the one worth naming. `self-description-spec.md` ND-07 says
 * a node proves each settlement entry against a live chain before publishing it,
 * so a `tokenNetwork` that the `TokenNetworkRegistry` does not agree is the token
 * network for that token is a contradiction between two authorities, not a
 * recoverable condition. Signing a claim under the wrong `verifyingContract`
 * produces a signature that verifies against nothing, and the only symptom is a
 * refused claim — so it is caught here, before any collateral is locked.
 */
export class ConfigError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONFIG', cause);
    this.name = 'ConfigError';
  }
}

/**
 * The node settles on chains, but not on one this client holds a key for — or
 * not on the one {@link ../client/types.js!ToonClientConfig.chain} named.
 *
 * Carries {@link offered}, the chains the node *does* publish in its
 * `settlements[]`, because the remedy is always to pick one of them (or to
 * configure a key for one) and a message that only says "no" makes the caller go
 * read the self-description by hand to find out what would have worked.
 */
export class ChainUnavailableError extends ToonClientError {
  /** The chain keys the node publishes, exactly as it spells them (`evm:84532`, `solana`). */
  readonly offered: string[];

  constructor(message: string, offered: string[], cause?: Error) {
    super(message, 'CHAIN_UNAVAILABLE', cause);
    this.name = 'ChainUnavailableError';
    this.offered = [...offered];
  }
}

/**
 * An operation needs an open payment channel and there is not one.
 *
 * Thrown rather than returned because it is a precondition, not a verdict: no
 * packet is formed, no claim is signed and nothing reaches the connector. The
 * usual cause is `autoOpenChannel: false` with nothing opened yet, or a
 * `deposit`/`close`/`settle` called before `open`.
 */
export class ChannelNotOpenError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CHANNEL_NOT_OPEN', cause);
    this.name = 'ChannelNotOpenError';
  }
}

/**
 * The destination is not a route this connector prices, so there is no amount to
 * put on a packet.
 *
 * `GET /ilp/routes/price` answered `404` — which is an *answer*, not a failure
 * (see {@link ../connector/ConnectorEdgeClient.js!ConnectorEdgeClient.getRoutePrice}):
 * this connector does not terminate that destination. Pass
 * {@link ../client/types.js!SendOptions.amount} explicitly to send anyway, which
 * is what a *forwarded* destination needs — its price lives at the connector that
 * terminates it, not at the one being posted to.
 */
export class RouteNotPricedError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'ROUTE_NOT_PRICED', cause);
    this.name = 'RouteNotPricedError';
  }
}

// ─── Greetings: refusals raised before the packet was routed ────────────────

/**
 * The connector answered an unpaid (or insufficiently paid) request with its
 * terms instead of routing it — HTTP `402`, `client-edge-spec.md` §1.4.
 *
 * The terms are the point: {@link terms} carries the route's price and the
 * chains it settles on, which is everything needed to open a channel and pay.
 * This is the greeting a first-contact client is *supposed* to receive.
 *
 * Thrown by the transport, where there is no packet outcome to return; converted
 * by {@link ../client/send.js} into a `SendRefused` with
 * `code: 'PAYMENT_REQUIRED'` and `refusedBy: 'edge'`, so a `send()` caller sees
 * an outcome rather than an exception. Catch it directly only when driving a
 * transport by hand.
 */
export class PaymentRequiredError extends ToonClientError {
  /** The route's terms, parsed from the x402 challenge body. */
  readonly terms: PaymentTerms;

  constructor(message: string, terms: PaymentTerms, cause?: Error) {
    super(message, 'PAYMENT_REQUIRED', cause);
    this.name = 'PaymentRequiredError';
    this.terms = terms;
  }
}

/**
 * The route refuses the carriage this request arrived on.
 *
 * A node may pin a route to one transport — the devnet relay's `g.toon.relay` is
 * BTP-only — and it says so two ways: in its self-description's
 * `requiredTransport`, and in the greeting it answers a wrong-carriage request
 * with (`extra.requiredTransport`, or an `F02` on BTP). Distinct from
 * {@link PaymentRequiredError} because the remedy is different: paying more will
 * never help, and re-sending over the other carriage always will.
 *
 * {@link required} is the carriage the node insists on, when it named one.
 */
export class TransportRequiredError extends ToonClientError {
  /** The carriage the node requires, when the refusal named one. */
  readonly required: 'http' | 'btp' | undefined;
  /** The route's terms, when the refusal carried them. */
  readonly terms: PaymentTerms | undefined;

  constructor(
    message: string,
    options: { required?: 'http' | 'btp'; terms?: PaymentTerms; cause?: Error } = {}
  ) {
    super(message, 'TRANSPORT_REQUIRED', options.cause);
    this.name = 'TransportRequiredError';
    this.required = options.required;
    this.terms = options.terms;
  }
}

// ─── On-chain and channel lifecycle ─────────────────────────────────────────

/**
 * Thrown when the one-time on-chain payment-channel OPEN reverts because the
 * local settlement wallet has no native gas to pay for its own
 * approve/openChannel/setTotalDeposit transactions. This is the channel OPEN
 * only — per-write settlement rides the packet and never spends gas. We remap
 * ONLY this case so callers get an actionable message (fund the wallet) instead
 * of the raw viem "...exceeds the balance of the account" string (toon-meta#65).
 * Retryable once the wallet is funded; the underlying viem/RPC error is
 * preserved as `cause`.
 */
export class ChannelFundingError extends ToonClientError {
  readonly retryable = true;
  constructor(message: string, cause?: Error) {
    super(message, 'CHANNEL_FUNDING', cause);
    this.name = 'ChannelFundingError';
  }
}

/**
 * Thrown when a persisted connector→channel binding names a channel whose CLAIM
 * WATERMARK (nonce + cumulative amount) is missing from the channel store.
 *
 * Resuming it anyway would re-track the live channel at nonce 0, and the
 * connector rejects every claim that does not strictly advance the nonce it has
 * already banked (`client-edge-spec.md` §1.3 step 2) — the `F01` failure from the
 * live measurement runs. Opening a fresh channel instead would silently strand
 * the collateral in the existing one. Neither is safe to do quietly, so this is a
 * hard error: the operator decides (settle the old channel, or restore the
 * watermark file). Never delete a channel store for a live channel.
 */
export class ChannelResumeError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CHANNEL_RESUME', cause);
    this.name = 'ChannelResumeError';
  }
}

/**
 * Thrown by {@link ../wallet/transfer.js!sendTransfer} when the sender cannot
 * cover the requested amount (plus, where applicable, the chain's own transaction
 * fee) on the source chain. A PREFLIGHT failure — thrown before any transaction
 * is built or submitted, so it never costs gas/fees.
 */
export class InsufficientBalanceError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'INSUFFICIENT_BALANCE', cause);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * Thrown when an EVM RPC never converges on a just-confirmed channel open —
 * the read-after-write hole behind `sepolia.base.org`'s load balancer, whose
 * replicas can serve a state that predates the `openChannel` receipt, making
 * the follow-up `setTotalDeposit` revert `InvalidChannelState()` (#489).
 */
export class StaleRpcReadError extends ToonClientError {
  readonly retryable = true;
  constructor(message: string, cause?: Error) {
    super(message, 'STALE_RPC_READ', cause);
    this.name = 'StaleRpcReadError';
  }
}

/**
 * Thrown by {@link ../wallet/transfer.js!sendTransfer} when `chain` is not one
 * this client can send on — either an unrecognized chain identifier, or a
 * recognized chain the client instance has no configuration for. Distinct from
 * {@link InvalidAddressError} (the chain is fine, the destination isn't) and from
 * {@link ChainUnavailableError} (this client is fine, the *node* does not settle
 * there).
 */
export class UnknownChainError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'UNKNOWN_CHAIN', cause);
    this.name = 'UnknownChainError';
  }
}

/**
 * Thrown by {@link ../wallet/transfer.js!sendTransfer} when the destination
 * address is malformed for the target chain (wrong format, wrong length, invalid
 * charset) — checked BEFORE any transaction is built, so a typo never costs
 * gas/fees or risks sending funds into a black hole.
 */
export class InvalidAddressError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'INVALID_ADDRESS', cause);
    this.name = 'InvalidAddressError';
  }
}

/**
 * Thrown by {@link ../wallet/transfer.js!sendTransfer} when a send was ACCEPTED
 * by the chain (a landed, non-reverted transaction / a node-accepted payment)
 * but the destination's observed balance never rose by the sent amount within
 * the bounded wait. This is the failure {@link ../wallet/transfer.js!sendTransfer}
 * exists to catch: the devnet faucet's Solana leg has been observed returning
 * success with a real transaction signature while delivering 0 lamports
 * (toon-protocol/connector#691) — trusting the send call's return value alone
 * would report a funded destination that in fact holds nothing.
 */
export class TransferNotDeliveredError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'TRANSFER_NOT_DELIVERED', cause);
    this.name = 'TransferNotDeliveredError';
  }
}

/**
 * Thrown by {@link ../wallet/transfer.js!sendTransfer} for a chain/asset
 * combination that is not implemented yet — today, a settlement token on a chain
 * whose token path this client does not build.
 */
export class TransferUnsupportedError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'TRANSFER_UNSUPPORTED', cause);
    this.name = 'TransferUnsupportedError';
  }
}

// ─── Error classification helpers ───────────────────────────────────────────

/**
 * Substrings that mark an insufficient-native-gas revert from an on-chain
 * channel-open tx. viem surfaces the node's message verbatim and the exact
 * phrasing varies by RPC (anvil/geth/hardhat), so we match a set of known
 * markers case-insensitively.
 */
const INSUFFICIENT_GAS_MARKERS = [
  'exceeds the balance of the account',
  'insufficient funds for gas',
  'insufficient funds for intrinsic transaction cost',
  'insufficient funds for transfer',
];

/**
 * True when `err` (or any error in its nested `cause` chain) is an
 * insufficient-native-gas revert. viem wraps the node error one or more levels
 * deep, so the whole chain is flattened and scanned.
 */
export function isInsufficientGasError(err: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur != null; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  const text = parts.join(' | ').toLowerCase();
  return INSUFFICIENT_GAS_MARKERS.some((m) => text.includes(m));
}

/**
 * Build the message a {@link ChainUnavailableError} carries, naming what the node
 * offered so the remedy is in the error rather than in the docs.
 */
export function chainUnavailableMessage(
  wanted: ChainKind | undefined,
  offered: string[],
  reason: 'no-key' | 'not-offered' | 'none'
): string {
  const list = offered.length > 0 ? offered.join(', ') : '(none)';
  if (reason === 'none') {
    return (
      'This connector publishes no settlement chains at all, so there is no ' +
      'channel to open and nothing can be paid for. Check that it is configured ' +
      'with a settlement backend.'
    );
  }
  if (reason === 'not-offered') {
    return (
      `This connector does not settle on "${String(wanted)}". It settles on: ` +
      `${list}. Set \`chain\` to one of those, or leave it unset to take the ` +
      'first one this client holds a key for.'
    );
  }
  return (
    `This client holds no key for any chain this connector settles on (${list}). ` +
    'Supply a `mnemonic` — which derives both an EVM and a Solana key — or the ' +
    'raw key for one of those chains.'
  );
}
