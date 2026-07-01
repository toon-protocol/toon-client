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
