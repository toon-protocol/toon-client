/**
 * Base error class for all Crosstown client errors.
 */
export class CrosstownClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    cause?: Error
  ) {
    super(message, { cause });
    this.name = 'CrosstownClientError';
  }
}

/**
 * Network error for connection failures (ECONNREFUSED, ETIMEDOUT).
 * These errors trigger retry logic with exponential backoff.
 */
export class NetworkError extends CrosstownClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'NETWORK_ERROR', cause);
    this.name = 'NetworkError';
  }
}

/**
 * Connector error for 5xx server errors.
 * These errors indicate the connector is unavailable or malfunctioning.
 */
export class ConnectorError extends CrosstownClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'CONNECTOR_ERROR', cause);
    this.name = 'ConnectorError';
  }
}

/**
 * Validation error for invalid input parameters.
 * These errors are thrown before making any HTTP requests.
 */
export class ValidationError extends CrosstownClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'VALIDATION_ERROR', cause);
    this.name = 'ValidationError';
  }
}

/**
 * Unauthorized error for 401 responses from connector admin API.
 * Indicates missing or invalid authentication credentials.
 */
export class UnauthorizedError extends CrosstownClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'UNAUTHORIZED', cause);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Peer not found error for 404 responses when removing a peer.
 * Indicates the specified peer ID does not exist in the connector.
 */
export class PeerNotFoundError extends CrosstownClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'PEER_NOT_FOUND', cause);
    this.name = 'PeerNotFoundError';
  }
}

/**
 * Peer already exists error for 409 responses when adding a peer.
 * Indicates a peer with the same ID already exists in the connector.
 */
export class PeerAlreadyExistsError extends CrosstownClientError {
  constructor(message: string, cause?: Error) {
    super(message, 'PEER_ALREADY_EXISTS', cause);
    this.name = 'PeerAlreadyExistsError';
  }
}
