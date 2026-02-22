# @crosstown/client

High-level TypeScript client for publishing Nostr events to the Crosstown protocol — an ILP-gated Nostr relay that enables sustainable relay operation through micropayments.

## What It Does

This client handles:
- **ILP Micropayments**: Pay to publish Nostr events (read is free)
- **Network Bootstrap**: Automatically discover and handshake with ILP peers via NIP-02 follow lists
- **HTTP-Only Mode**: Connects to external ILP connector service (embedded mode not yet implemented)
- **TOON Encoding**: Native binary format for agent-friendly event encoding

## Installation

```bash
pnpm add @crosstown/client @crosstown/core @crosstown/relay nostr-tools
```

## Prerequisites

### Required Infrastructure (HTTP Mode)

The client requires external services. Use docker-compose for local development:

```bash
# Start all required services
docker compose -f docker-compose-simple.yml up -d

# Verify services are healthy
curl http://localhost:8080/health  # ILP Connector (runtime)
curl http://localhost:8081/health  # ILP Connector (admin)
curl http://localhost:3100/health  # Crosstown BLS
# Nostr relay on ws://localhost:7100 (WebSocket, no HTTP endpoint)

# Stop infrastructure
docker compose -f docker-compose-simple.yml down
```

| Service | Port | Purpose |
|---------|------|---------|
| **ILP Connector (Runtime)** | 8080 | Routes ILP packets to relay |
| **ILP Connector (Admin)** | 8081 | Manages peer configuration |
| **Crosstown BLS** | 3100 | Validates events, calculates pricing, stores events |
| **Nostr Relay** | 7100 | WebSocket relay for peer discovery (kind:10032) |

See [docker-compose-simple.yml](../../docker-compose-simple.yml) for configuration details.

---

## Quick Start

```typescript
import { CrosstownClient } from '@crosstown/client';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

// 1. Generate identity
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

// 2. Create client
const client = new CrosstownClient({
  connectorUrl: 'http://localhost:8080',       // Required: ILP connector endpoint
  secretKey,                                   // Required: Nostr private key
  ilpInfo: {                                   // Required: ILP peer info
    pubkey,
    ilpAddress: `g.crosstown.${pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://localhost:3000',
  },
  toonEncoder: encodeEventToToon,              // Required: TOON encoder
  toonDecoder: decodeEventFromToon,            // Required: TOON decoder
  relayUrl: 'ws://localhost:7100',             // Optional: defaults to ws://localhost:7100
});

// 3. Start (bootstrap network, discover peers)
const result = await client.start();
console.log(`Discovered ${result.peersDiscovered} peers`);

// 4. Publish event to relay via ILP payment
const event = finalizeEvent({
  kind: 1,
  content: 'Hello from Crosstown!',
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
}, secretKey);

const publishResult = await client.publishEvent(event);
if (publishResult.success) {
  console.log(`Published: ${publishResult.eventId}`);
  console.log(`Fulfillment: ${publishResult.fulfillment}`);
} else {
  console.error(`Failed: ${publishResult.error}`);
}

// 5. Clean up
await client.stop();
```

---

## API Reference

### Main Class: `CrosstownClient`

The primary interface for interacting with the Crosstown network.

```typescript
import { CrosstownClient } from '@crosstown/client';
```

#### Constructor

```typescript
new CrosstownClient(config: CrosstownClientConfig)
```

Creates a new client instance. Does NOT start the client — call `start()` to initialize.

**Throws:**
- `ValidationError` - If configuration is invalid

---

### Configuration: `CrosstownClientConfig`

```typescript
interface CrosstownClientConfig {
  // ===== REQUIRED =====

  /** HTTP URL of external ILP connector service */
  connectorUrl: string;                        // Example: 'http://localhost:8080'

  /** 32-byte Nostr private key (generated via nostr-tools) */
  secretKey: Uint8Array;

  /** ILP peer information for this client */
  ilpInfo: {
    pubkey: string;                            // Nostr public key (hex)
    ilpAddress: string;                        // ILP address (e.g., 'g.crosstown.abc123')
    btpEndpoint: string;                       // BTP WebSocket endpoint (e.g., 'ws://localhost:3000')
  };

  /** Function to encode Nostr events to TOON binary format */
  toonEncoder: (event: NostrEvent) => Uint8Array;

  /** Function to decode TOON binary to Nostr events */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;

  // ===== OPTIONAL =====

  /** Nostr relay URL for peer discovery (default: 'ws://localhost:7100') */
  relayUrl?: string;

  /** Query timeout in milliseconds (default: 30000) */
  queryTimeout?: number;

  /** Max retry attempts for failed operations (default: 3) */
  maxRetries?: number;

  /** Delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
}
```

**Important Notes:**
- `connector` parameter is **not supported** (embedded mode not implemented)
- Passing `connector` will throw `ValidationError: "Embedded mode not yet implemented"`
- HTTP mode is the only supported mode in this version

---

### Methods

#### `start(): Promise<CrosstownStartResult>`

Starts the client, bootstraps the network, and begins monitoring for new peers.

**What it does:**
1. Initializes HTTP runtime and admin clients
2. Discovers peers via NIP-02 follow lists and kind:10032 events
3. Performs SPSP handshakes with discovered peers
4. Starts monitoring relay for new kind:10032 events

**Returns:**
```typescript
{
  mode: 'http',           // Always 'http' in this version
  peersDiscovered: number // Number of peers found during bootstrap
}
```

**Throws:**
- `CrosstownClientError` - If client is already started
- `CrosstownClientError` - If initialization fails (wraps underlying error)

**Example:**
```typescript
const result = await client.start();
console.log(`Mode: ${result.mode}, Peers: ${result.peersDiscovered}`);
```

---

#### `publishEvent(event: NostrEvent): Promise<PublishEventResult>`

Publishes a signed Nostr event to the relay via ILP micropayment.

**Parameters:**
- `event` - **Must be finalized** (signed with `id`, `pubkey`, `sig`). Use `finalizeEvent()` from nostr-tools.

**Returns:**
```typescript
{
  success: boolean,       // Whether event was successfully published
  eventId?: string,       // Event ID (if success)
  fulfillment?: string,   // ILP fulfillment proof (if success)
  error?: string          // Error message (if failure)
}
```

**Throws:**
- `CrosstownClientError` - If client is not started
- `CrosstownClientError` - If publishing fails (network/connector error)

**Example:**
```typescript
const event = finalizeEvent({ kind: 1, content: 'Hello', tags: [], created_at: now }, secretKey);
const result = await client.publishEvent(event);

if (result.success) {
  console.log(`Published: ${result.eventId}`);
} else {
  console.error(`Failed: ${result.error}`);
}
```

---

#### `stop(): Promise<void>`

Stops the client and cleans up resources.

**What it does:**
1. Stops relay monitoring subscription
2. Closes SimplePool connections
3. Clears internal state

**Throws:**
- `CrosstownClientError` - If client is not started
- `CrosstownClientError` - If stopping fails

**Example:**
```typescript
await client.stop();
```

---

#### `isStarted(): boolean`

Returns `true` if the client is currently started, `false` otherwise.

**Example:**
```typescript
if (!client.isStarted()) {
  await client.start();
}
```

---

#### `getPeersCount(): number`

Returns the number of peers discovered during bootstrap.

**Throws:**
- `CrosstownClientError` - If client is not started

**Example:**
```typescript
const count = client.getPeersCount();
console.log(`Connected to ${count} peers`);
```

---

#### `getDiscoveredPeers(): DiscoveredPeer[]`

Returns the list of peers discovered by the relay monitor.

**Returns:**
```typescript
Array<{
  ilpAddress: string;
  btpEndpoint: string;
  pubkey: string;
  // ... other peer metadata
}>
```

**Throws:**
- `CrosstownClientError` - If client is not started

**Example:**
```typescript
const peers = client.getDiscoveredPeers();
peers.forEach(peer => {
  console.log(`Peer: ${peer.pubkey} at ${peer.ilpAddress}`);
});
```

---

## Error Handling

The client provides specialized error classes for different failure scenarios.

### Error Class Hierarchy

```typescript
CrosstownClientError (base class)
├── NetworkError              // Connection failures (ECONNREFUSED, ETIMEDOUT)
├── ConnectorError           // Connector server errors (5xx)
├── ValidationError          // Invalid config or input
├── UnauthorizedError        // Admin API 401 responses
├── PeerNotFoundError        // Admin API 404 responses (peer not found)
└── PeerAlreadyExistsError   // Admin API 409 responses (duplicate peer)
```

### Importing Error Classes

```typescript
import {
  CrosstownClientError,
  NetworkError,
  ConnectorError,
  ValidationError,
  UnauthorizedError,
  PeerNotFoundError,
  PeerAlreadyExistsError,
} from '@crosstown/client';
```

### Error Properties

All error classes extend `CrosstownClientError` with these properties:

```typescript
class CrosstownClientError extends Error {
  name: string;        // Error class name
  message: string;     // Human-readable error message
  code: string;        // Machine-readable error code
  cause?: Error;       // Original error (if wrapped)
}
```

### Usage Example

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

### Error Codes

| Error Class | Code | Meaning |
|-------------|------|---------|
| `CrosstownClientError` | `INVALID_STATE` | Operation called in wrong state (e.g., `stop()` before `start()`) |
| `CrosstownClientError` | `INITIALIZATION_ERROR` | Client failed to initialize during `start()` |
| `CrosstownClientError` | `PUBLISH_ERROR` | Event publishing failed |
| `CrosstownClientError` | `STOP_ERROR` | Error during cleanup in `stop()` |
| `NetworkError` | `NETWORK_ERROR` | Connection failure (ECONNREFUSED, ETIMEDOUT, DNS) |
| `ConnectorError` | `CONNECTOR_ERROR` | Connector 5xx server error |
| `ValidationError` | `VALIDATION_ERROR` | Invalid configuration or input parameters |
| `UnauthorizedError` | `UNAUTHORIZED` | Admin API 401 authentication failure |
| `PeerNotFoundError` | `PEER_NOT_FOUND` | Admin API 404 peer not found |
| `PeerAlreadyExistsError` | `PEER_ALREADY_EXISTS` | Admin API 409 duplicate peer |

---

## Advanced Usage: HTTP Adapters

For advanced use cases, you can use the HTTP adapter classes directly without `CrosstownClient`.

### `HttpRuntimeClient`

Low-level client for sending ILP packets to the connector runtime API.

```typescript
import { HttpRuntimeClient } from '@crosstown/client';

const runtimeClient = new HttpRuntimeClient({
  connectorUrl: 'http://localhost:8080',
  timeout: 30000,        // Optional: request timeout (ms)
  maxRetries: 3,         // Optional: max retry attempts
  retryDelay: 1000,      // Optional: retry delay (ms)
});

const result = await runtimeClient.sendIlpPacket({
  destination: 'g.crosstown.relay',
  amount: '1000',
  data: 'base64EncodedToonData==',
});

if (result.accepted) {
  console.log('Payment accepted:', result.fulfillment);
} else {
  console.error('Payment rejected:', result.code, result.message);
}
```

**Methods:**
- `sendIlpPacket(params): Promise<IlpSendResult>`
  - `params.destination` - ILP address (must start with `g.`)
  - `params.amount` - Amount in base units (stringified integer)
  - `params.data` - Base64-encoded packet data
  - `params.timeout` - Optional timeout override (ms)

**Throws:**
- `ValidationError` - Invalid parameters (empty destination, malformed ILP address, invalid amount, non-Base64 data)
- `NetworkError` - Connection failure (retries automatically)
- `ConnectorError` - Connector 5xx error (no retry)

---

### `HttpConnectorAdmin`

Low-level client for managing ILP peers via the connector admin API.

```typescript
import { HttpConnectorAdmin } from '@crosstown/client';

const adminClient = new HttpConnectorAdmin({
  adminUrl: 'http://localhost:8081',
  timeout: 30000,        // Optional: request timeout (ms)
  maxRetries: 3,         // Optional: max retry attempts
  retryDelay: 1000,      // Optional: retry delay (ms)
});

// Add single peer
await adminClient.addPeer({
  id: 'nostr-abc123',
  url: 'btp+ws://alice.example.com:3000',
  authToken: 'secret-token',
  routes: [{ prefix: 'g.crosstown.alice' }],
  settlement: {
    preference: 'payment-channel',
    evmAddress: '0x...',
    tokenAddress: '0x...',
    tokenNetworkAddress: '0x...',
    chainId: 1,
  },
});

// Remove single peer
await adminClient.removePeer('nostr-abc123');

// Bulk operations (parallel execution with Promise.allSettled)
const addResults = await adminClient.addPeers([
  { id: 'peer1', url: 'btp+ws://...', authToken: 'token1' },
  { id: 'peer2', url: 'btp+ws://...', authToken: 'token2' },
]);

const removeResults = await adminClient.removePeers(['peer1', 'peer2']);

// Check results
addResults.forEach(result => {
  if (result.success) {
    console.log(`Added: ${result.peerId}`);
  } else {
    console.error(`Failed: ${result.peerId}`, result.error);
  }
});
```

**Methods:**

1. **`addPeer(config): Promise<void>`**
   - `config.id` - Unique peer identifier (non-empty string)
   - `config.url` - BTP WebSocket URL (must start with `btp+ws://` or `btp+wss://`)
   - `config.authToken` - Authentication token (can be empty string for no auth)
   - `config.routes` - Optional routing table entries
   - `config.settlement` - Optional settlement configuration

2. **`removePeer(peerId): Promise<void>`**
   - `peerId` - Peer identifier to remove

3. **`addPeers(configs): Promise<PeerOperationResult[]>`**
   - Bulk add with parallel execution
   - Returns array of results (success/error per peer)

4. **`removePeers(peerIds): Promise<PeerOperationResult[]>`**
   - Bulk remove with parallel execution
   - Returns array of results (success/error per peer)

**Throws:**
- `ValidationError` - Invalid parameters (empty id, malformed URL, etc.)
- `PeerAlreadyExistsError` - Peer with same ID exists (409)
- `PeerNotFoundError` - Peer doesn't exist (404)
- `UnauthorizedError` - Authentication failed (401)
- `NetworkError` - Connection failure (retries automatically)
- `ConnectorError` - Server error (5xx)

**Bulk Operation Result:**
```typescript
interface PeerOperationResult {
  peerId: string;    // Peer ID that was operated on
  success: boolean;  // Whether operation succeeded
  error?: Error;     // Error object (if failed)
}
```

---

## Utilities

### `withRetry()`

Retry helper with exponential backoff.

```typescript
import { withRetry } from '@crosstown/client';

const result = await withRetry(
  async () => {
    // Your async operation
    return await fetchData();
  },
  {
    maxRetries: 3,
    retryDelay: 1000,
    exponentialBackoff: true,
    shouldRetry: (error) => error instanceof NetworkError,
  }
);
```

**Options:**
- `maxRetries` - Maximum retry attempts (default: 3)
- `retryDelay` - Initial delay between retries in ms (default: 1000)
- `exponentialBackoff` - Double delay after each retry (default: false)
- `shouldRetry` - Function to determine if error is retryable (default: retry all)

---

## Testing

### Unit & Integration Tests

```bash
cd packages/client
pnpm test                 # Run all unit/integration tests
pnpm test:coverage        # Run with coverage report
```

### E2E Tests

E2E tests require docker-compose infrastructure:

```bash
# Start infrastructure
docker compose -f docker-compose-simple.yml up -d

# Wait for services to start (5-10 seconds)
sleep 10

# Run E2E tests
cd packages/client
pnpm test:e2e

# Stop infrastructure
docker compose -f docker-compose-simple.yml down
```

See [tests/e2e/README.md](tests/e2e/README.md) for detailed E2E setup.

---

## Current Limitations

### 1. HTTP Mode Only

**Embedded mode is not implemented.** Attempting to use it will throw an error:

```typescript
// ❌ NOT SUPPORTED
const client = new CrosstownClient({
  connector: embeddedConnectorInstance,  // ValidationError: "Embedded mode not yet implemented"
  // ...
});

// ✅ SUPPORTED
const client = new CrosstownClient({
  connectorUrl: 'http://localhost:8080',
  // ...
});
```

### 2. No Direct Payment Channels

HTTP mode does not support direct payment channel client (returns `null` during initialization). Payment channel management must be handled externally via the connector.

### 3. No Authentication

HTTP connector API is assumed to be local/trusted. Production authentication will be added in a future release.

### 4. Fixed Pricing

Event pricing is currently hardcoded (`amount: '1000'` in `publishEvent()`). Dynamic pricing based on event size/kind will be added in a future release.

---

## Troubleshooting

### Client Fails to Start

**Symptom:** `CrosstownClientError: Failed to start client`

**Solutions:**
1. Verify connector is running:
   ```bash
   curl http://localhost:8080/health
   ```
2. Check connector logs:
   ```bash
   docker compose -f docker-compose-simple.yml logs connector
   ```
3. Verify config has valid `connectorUrl`, `secretKey`, and `ilpInfo`

---

### Event Publishing Fails

**Symptom:** `PublishEventResult.success === false`

**Solutions:**
1. Verify client is started:
   ```typescript
   if (!client.isStarted()) {
     await client.start();
   }
   ```
2. Check event is properly signed (use `finalizeEvent` from nostr-tools)
3. Verify relay is accessible:
   ```bash
   wscat -c ws://localhost:7100
   ```
4. Check BLS logs:
   ```bash
   docker compose -f docker-compose-simple.yml logs crosstown-node
   ```

---

### Port Conflicts

**Symptom:** `Error: bind: address already in use`

**Solutions:**
```bash
# Kill processes using ports
lsof -ti:8080 | xargs kill -9  # Connector runtime
lsof -ti:8081 | xargs kill -9  # Connector admin
lsof -ti:7100 | xargs kill -9  # Nostr relay
lsof -ti:3100 | xargs kill -9  # BLS

# Restart infrastructure
docker compose -f docker-compose-simple.yml up -d
```

---

### Network Errors

**Symptom:** `NetworkError: Failed to connect to connector`

**Solutions:**
1. Check connector is running and accessible
2. Verify firewall/network settings allow connections to connector ports
3. Increase timeout in config:
   ```typescript
   const client = new CrosstownClient({
     // ...
     queryTimeout: 60000,  // 60 seconds
   });
   ```

---

## Examples

See [packages/examples/](../examples/) for more examples:
- Basic HTTP mode client
- Multi-client event publishing
- Error handling patterns
- Custom retry strategies
- Direct adapter usage

---

## Related Packages

- **[@crosstown/core](../core/)** - Core protocol (peer discovery, SPSP, bootstrap)
- **[@crosstown/relay](../relay/)** - Nostr relay with ILP payment gating
- **[@crosstown/bls](../bls/)** - Business Logic Server (pricing, validation, storage)

---

## License

MIT

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/crosstown/issues)
- **Discussions:** [GitHub Discussions](https://github.com/yourusername/crosstown/discussions)
- **Documentation:** [docs/](../../docs/)
