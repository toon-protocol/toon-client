# Error Handling

The client provides specialized error classes for different failure scenarios.

## Error Class Hierarchy

```typescript
TOONClientError (base class)
├── NetworkError              // Connection failures (ECONNREFUSED, ETIMEDOUT)
├── ConnectorError           // Connector server errors (5xx)
├── ValidationError          // Invalid config or input
├── UnauthorizedError        // Admin API 401 responses
├── PeerNotFoundError        // Admin API 404 responses (peer not found)
└── PeerAlreadyExistsError   // Admin API 409 responses (duplicate peer)
```

## Importing Error Classes

```typescript
import {
  TOONClientError,
  NetworkError,
  ConnectorError,
  ValidationError,
  UnauthorizedError,
  PeerNotFoundError,
  PeerAlreadyExistsError,
} from '@toon-protocol/client';
```

## Error Properties

All error classes extend `TOONClientError` with these properties:

```typescript
class TOONClientError extends Error {
  name: string; // Error class name
  message: string; // Human-readable error message
  code: string; // Machine-readable error code
  cause?: Error; // Original error (if wrapped)
}
```

## Usage Example

```typescript
try {
  await client.start();
} catch (error) {
  if (error instanceof NetworkError) {
    // Connection to connector failed (ECONNREFUSED, timeout, DNS failure)
    console.error('Cannot reach connector:', error.message);
    // Retry with exponential backoff or switch to backup connector
  } else if (error instanceof ConnectorError) {
    // Connector returned 5xx server error
    console.error('Connector is malfunctioning:', error.message);
    // Alert ops team, wait before retry
  } else if (error instanceof ValidationError) {
    // Invalid configuration (fix before retry)
    console.error('Invalid config:', error.message);
    // Fix config and restart
  } else if (error instanceof UnauthorizedError) {
    // Admin API authentication failed
    console.error('Auth failed:', error.message);
    // Check auth credentials
  } else if (error instanceof PeerNotFoundError) {
    // Tried to remove non-existent peer
    console.error('Peer not found:', error.message);
  } else if (error instanceof PeerAlreadyExistsError) {
    // Tried to add duplicate peer
    console.error('Peer already exists:', error.message);
  } else {
    // Unexpected error
    console.error('Unexpected error:', error);
  }
}
```

## Error Codes

| Error Class              | Code                   | Meaning                                                           |
| ------------------------ | ---------------------- | ----------------------------------------------------------------- |
| `TOONClientError`   | `INVALID_STATE`        | Operation called in wrong state (e.g., `stop()` before `start()`) |
| `TOONClientError`   | `INITIALIZATION_ERROR` | Client failed to initialize during `start()`                      |
| `TOONClientError`   | `PUBLISH_ERROR`        | Event publishing failed                                           |
| `TOONClientError`   | `STOP_ERROR`           | Error during cleanup in `stop()`                                  |
| `NetworkError`           | `NETWORK_ERROR`        | Connection failure (ECONNREFUSED, ETIMEDOUT, DNS)                 |
| `ConnectorError`         | `CONNECTOR_ERROR`      | Connector 5xx server error                                        |
| `ValidationError`        | `VALIDATION_ERROR`     | Invalid configuration or input parameters                         |
| `UnauthorizedError`      | `UNAUTHORIZED`         | Admin API 401 authentication failure                              |
| `PeerNotFoundError`      | `PEER_NOT_FOUND`       | Admin API 404 peer not found                                      |
| `PeerAlreadyExistsError` | `PEER_ALREADY_EXISTS`  | Admin API 409 duplicate peer                                      |
