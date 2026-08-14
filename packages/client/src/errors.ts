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
 * Connector error for 5xx server errors.
 * These errors indicate the connector is unavailable or malfunctioning.
 */
export class ConnectorError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTOR_ERROR', cause);
    this.name = 'ConnectorError';
  }
}

/**
 * Thrown when a paid write over ILP-over-HTTP is refused with `402 Payment
 * Required` whose x402 challenge body declares `requiredTransport: "btp"`
 * in an `accepts[]` entry (toon-client#561). Distinct from a plain
 * `ConnectorError` so a caller can retry the SAME write over an established
 * BTP uplink instead of surfacing a generic transport failure.
 *
 * Exists because #558's guard reads `requiredTransport` off the peer's
 * kind:10032 announce — but the live devnet relay's announce never carries
 * that field at all (only the connector's 402 response does, and only once
 * a client has already posted over HTTP). The announce-based guard stays in
 * place for connectors that DO announce it; this error covers every other
 * connector that enforces the requirement without announcing it.
 */
export class Http402RequiresBtpError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'HTTP_402_REQUIRES_BTP', cause);
    this.name = 'Http402RequiresBtpError';
  }
}

/**
 * Thrown when a paid write over ILP-over-HTTP is refused with a plain
 * `401 Unauthorized` (toon-client#565). Distinct from a plain
 * `ConnectorError` for the same reason `Http402RequiresBtpError` is: a
 * caller can retry the SAME write over an established BTP uplink instead of
 * surfacing a generic transport failure.
 *
 * Exists because the rust connector generation live on the two-box devnet
 * (`rust-sha-415531a`) answers an authenticated ILP-over-HTTP POST from an
 * unconfigured/discovered peer identity with `401` ("identity ... failed to
 * authenticate") rather than the prior generation's `402` x402 greeting —
 * so #561's 402-only fallback never fires and the write dies with an idle
 * BTP session sitting right next to it. A discovered edge's `httpEndpoint`
 * is never a peer this client is actually configured against, so a 401
 * here is the connector rejecting the anonymous identity, not a signal the
 * write itself is invalid — retrying over BTP (which authenticates the
 * negotiated session, not a bare HTTP identity header) is the right
 * response, mirroring the 402 case exactly.
 */
export class Http401RequiresBtpError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'HTTP_401_REQUIRES_BTP', cause);
    this.name = 'Http401RequiresBtpError';
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

/**
 * Unauthorized error for 401 responses from connector admin API.
 * Indicates missing or invalid authentication credentials.
 */
export class UnauthorizedError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'UNAUTHORIZED', cause);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Peer not found error for 404 responses when removing a peer.
 * Indicates the specified peer ID does not exist in the connector.
 */
export class PeerNotFoundError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'PEER_NOT_FOUND', cause);
    this.name = 'PeerNotFoundError';
  }
}

/**
 * Peer already exists error for 409 responses when adding a peer.
 * Indicates a peer with the same ID already exists in the connector.
 */
export class PeerAlreadyExistsError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'PEER_ALREADY_EXISTS', cause);
    this.name = 'PeerAlreadyExistsError';
  }
}

/**
 * Thrown when the one-time on-chain payment-channel OPEN reverts because the
 * local settlement wallet has no native gas to pay for its own
 * approve/openChannel/setTotalDeposit transactions. This is the channel OPEN
 * only — per-write settlement rides ILP-over-HTTP and never spends gas. We
 * remap ONLY this case so callers get an actionable message (fund the wallet)
 * instead of the raw viem "...exceeds the balance of the account" string
 * (toon-meta#65). Retryable once the wallet is funded; the underlying viem/RPC
 * error is preserved as `cause`.
 */
export class ChannelFundingError extends ToonClientError {
  readonly retryable = true;
  constructor(message: string, cause?: Error) {
    super(message, 'CHANNEL_FUNDING', cause);
    this.name = 'ChannelFundingError';
  }
}

/**
 * Thrown when a persisted peer→channel binding names a channel whose CLAIM
 * WATERMARK (nonce + cumulative amount) is missing from the channel store.
 *
 * Resuming it anyway would re-track the live channel at nonce 0, and the
 * connector rejects every claim below the nonce it has already seen — the F01
 * failure from the live measurement runs. Opening a fresh channel instead would
 * silently strand the collateral in the existing one. Neither is safe to do
 * quietly, so this is a hard error: the operator decides (settle the old
 * channel, or restore the watermark file). Never delete a channel store for a
 * live channel.
 */
export class ChannelResumeError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CHANNEL_RESUME', cause);
    this.name = 'ChannelResumeError';
  }
}

/**
 * Thrown by {@link ../transfer.js!sendTransfer} when the sender cannot cover
 * the requested amount (plus, where applicable, the chain's own transaction
 * fee) on the source chain. A PREFLIGHT failure — thrown before any
 * transaction is built or submitted, so it never costs gas/fees.
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
 * Thrown by {@link ../transfer.js!sendTransfer} when `chain` is not one this
 * client can send on — either an unrecognized chain identifier, or a
 * recognized chain the client instance has no configuration for (no
 * `chainRpcUrls` entry, no `solanaChannel`, no `minaChannel`). Distinct from
 * {@link InvalidAddressError} (the chain is fine, the destination isn't) and
 * from a plain unsupported chain/asset combination (see the transfer module
 * for chain-specific gaps, e.g. the Mina settlement token).
 */
export class UnknownChainError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'UNKNOWN_CHAIN', cause);
    this.name = 'UnknownChainError';
  }
}

/**
 * Thrown by {@link ../transfer.js!sendTransfer} when the destination address
 * is malformed for the target chain (wrong format, wrong length, invalid
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
 * Thrown by {@link ../transfer.js!sendTransfer} when a send was ACCEPTED by
 * the chain (a landed, non-reverted transaction / a node-accepted payment)
 * but the destination's observed balance never rose by the sent amount
 * within the bounded wait. This is the failure {@link sendTransfer} exists to
 * catch: the devnet faucet's Solana leg has been observed returning success
 * with a real transaction signature while delivering 0 lamports
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
 * Thrown by {@link ../transfer.js!sendTransfer} for a chain/asset combination
 * that is not implemented yet — e.g. the Mina settlement token (a custom
 * token transfer needs an o1js zkApp-approval path this client doesn't build
 * yet; native MINA is unaffected). Mirrors the documented Mina
 * deposit/close/settle gaps in {@link ../channel/OnChainChannelClient.js!OnChainChannelClient}.
 */
export class TransferUnsupportedError extends ToonClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'TRANSFER_UNSUPPORTED', cause);
    this.name = 'TransferUnsupportedError';
  }
}

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
