# @crosstown/client

High-level client library for interacting with the Crosstown protocol — an ILP-gated Nostr relay that solves the relay business model through micropayments.

## Features

- **HTTP Mode**: Connect to external ILP connector service via HTTP/WebSocket
- **Peer Discovery**: Automatic peer discovery via NIP-02 follow lists and kind:10032 events
- **SPSP Handshakes**: Automated SPSP (Simple Payment Setup Protocol) handshakes over Nostr
- **Event Publishing**: Publish Nostr events to relay with ILP micropayments
- **Bootstrap & Monitoring**: Automatic network bootstrap and real-time relay monitoring
- **Type-Safe**: Full TypeScript support with strict typing

## Installation

```bash
pnpm add @crosstown/client @crosstown/core @crosstown/relay nostr-tools
```

## Quick Start

### HTTP Mode (Recommended)

HTTP mode connects to an external ILP connector service. This is the recommended mode for most applications.

```typescript
import { CrosstownClient } from '@crosstown/client';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

// Generate identity
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

// Create client
const client = new CrosstownClient({
  // HTTP connector URL (required)
  connectorUrl: 'http://localhost:8080',

  // Identity (required)
  secretKey,
  ilpInfo: {
    pubkey,
    ilpAddress: `g.crosstown.${pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://localhost:3000',
  },

  // TOON encoding (required)
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,

  // Network (optional, defaults shown)
  relayUrl: 'ws://localhost:7100',      // Nostr relay URL
  queryTimeout: 30000,                  // Query timeout (30s)
  maxRetries: 3,                        // Max retry attempts
  retryDelay: 1000,                     // Retry delay (1s)
});

// Start client (bootstrap peers, start monitoring)
const result = await client.start();
console.log(`Started in ${result.mode} mode`);
console.log(`Discovered ${result.peersDiscovered} peers`);

// Publish event to relay via ILP payment
const event = finalizeEvent({
  kind: 1,
  content: 'Hello from Crosstown!',
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
}, secretKey);

const publishResult = await client.publishEvent(event);
if (publishResult.success) {
  console.log(`Published event ${publishResult.eventId}`);
  console.log(`Fulfillment: ${publishResult.fulfillment}`);
} else {
  console.error(`Failed to publish: ${publishResult.error}`);
}

// Clean up
await client.stop();
```

## API Reference

### `CrosstownClient`

Main client class for interacting with Crosstown network.

#### Constructor

```typescript
new CrosstownClient(config: CrosstownClientConfig)
```

**Config Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `connectorUrl` | `string` | ✅ | - | HTTP URL of external connector service (e.g., `http://localhost:8080`) |
| `secretKey` | `Uint8Array` | ✅ | - | 32-byte Nostr private key |
| `ilpInfo` | `IlpPeerInfo` | ✅ | - | ILP peer information (address, BTP endpoint, pubkey) |
| `toonEncoder` | `Function` | ✅ | - | Function to encode Nostr events to TOON binary format |
| `toonDecoder` | `Function` | ✅ | - | Function to decode TOON binary format to Nostr events |
| `relayUrl` | `string` | ❌ | `ws://localhost:7100` | Nostr relay URL for peer discovery |
| `queryTimeout` | `number` | ❌ | `30000` | Query timeout in milliseconds |
| `maxRetries` | `number` | ❌ | `3` | Maximum retry attempts for failed operations |
| `retryDelay` | `number` | ❌ | `1000` | Delay between retries in milliseconds |

#### Methods

##### `async start(): Promise<CrosstownStartResult>`

Starts the client and bootstraps the network.

**Returns:**
```typescript
{
  mode: 'http' | 'embedded',
  peersDiscovered: number
}
```

**Throws:**
- `CrosstownClientError` - If client is already started or initialization fails

---

##### `async publishEvent(event: NostrEvent): Promise<PublishEventResult>`

Publishes a signed Nostr event to the relay via ILP payment.

**Parameters:**
- `event` - Finalized (signed) Nostr event

**Returns:**
```typescript
{
  success: boolean,
  eventId?: string,
  fulfillment?: string,
  error?: string
}
```

**Throws:**
- `CrosstownClientError` - If client is not started or publishing fails

---

##### `async stop(): Promise<void>`

Stops the client and cleans up resources.

**Throws:**
- `CrosstownClientError` - If client is not started or stopping fails

---

##### `isStarted(): boolean`

Returns `true` if the client is currently started.

---

##### `getPeersCount(): number`

Returns the number of peers discovered during bootstrap.

**Throws:**
- `CrosstownClientError` - If client is not started

---

##### `getDiscoveredPeers(): DiscoveredPeer[]`

Returns the list of peers discovered by the relay monitor.

**Throws:**
- `CrosstownClientError` - If client is not started

## Docker Infrastructure

The client requires external infrastructure in HTTP mode. Use docker-compose for local development:

### Quick Start

```bash
# From repository root
docker compose -f docker-compose-simple.yml up -d

# Verify services are healthy
curl http://localhost:8080/health  # Connector
curl http://localhost:3100/health  # BLS

# Use the client (see Quick Start above)

# Stop infrastructure
docker compose -f docker-compose-simple.yml down
```

### Services

| Service | Port | Purpose |
|---------|------|---------|
| Connector Runtime | 8080 | ILP packet routing |
| Connector Admin | 8081 | Peer management |
| Crosstown BLS | 3100 | Business logic server (event pricing, validation) |
| Nostr Relay | 7100 | Nostr WebSocket relay |

See [docker-compose-simple.yml](../../docker-compose-simple.yml) for full configuration.

## Error Handling

The client provides typed error classes for different failure scenarios:

```typescript
import {
  CrosstownClientError,  // Base error class
  NetworkError,          // Network failures (ECONNREFUSED, ETIMEDOUT)
  ConnectorError,        // Connector server errors (5xx)
  ValidationError,       // Invalid configuration or input
} from '@crosstown/client';

try {
  await client.start();
} catch (error) {
  if (error instanceof NetworkError) {
    console.error('Network failure:', error.message);
    // Retry or fallback to different connector
  } else if (error instanceof ConnectorError) {
    console.error('Connector unavailable:', error.message);
    // Wait and retry, or alert user
  } else if (error instanceof ValidationError) {
    console.error('Invalid config:', error.message);
    // Fix configuration and restart
  } else {
    console.error('Unexpected error:', error);
  }
}
```

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

See [tests/e2e/README.md](tests/e2e/README.md) for detailed E2E test setup instructions.

## Limitations (Current Version)

This version implements **HTTP mode only**. The following limitations apply:

### 1. Embedded Mode Not Implemented

The `connector` config parameter is not yet supported. Embedded mode (running connector in-process) will be added in a future epic.

```typescript
// ❌ NOT SUPPORTED (will throw error)
const client = new CrosstownClient({
  connector: embeddedConnectorInstance,  // Error: "Embedded mode not yet implemented"
  ...
});

// ✅ SUPPORTED (HTTP mode)
const client = new CrosstownClient({
  connectorUrl: 'http://localhost:8080',
  ...
});
```

### 2. HTTP Mode Limitations

- **No Direct Channel Client:** HTTP mode does not support direct payment channels (returns `null` in initialization)
- **No `handlePacket` Callback:** Connector handles incoming packets internally
- **Requires External Service:** Connector must be running externally (docker-compose or standalone)

### 3. Authentication Deferred

HTTP connector API is assumed to be local/trusted (no authentication required). Production authentication will be added in a future security enhancement story.

## Troubleshooting

### Client Fails to Start

**Problem:** `CrosstownClientError: Failed to start client`

**Solutions:**
1. Verify connector is running: `curl http://localhost:8080/health`
2. Check connector logs: `docker compose -f docker-compose-simple.yml logs connector`
3. Verify config has valid `connectorUrl`, `secretKey`, and `ilpInfo`

### Event Publishing Fails

**Problem:** `PublishEventResult.success === false`

**Solutions:**
1. Verify client is started: `client.isStarted()` should return `true`
2. Check event is properly signed (use `finalizeEvent` from nostr-tools)
3. Verify relay is accessible: `wscat -c ws://localhost:7100`
4. Check BLS logs: `docker compose -f docker-compose-simple.yml logs crosstown-node`

### Port Conflicts

**Problem:** `Error: bind: address already in use`

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

## Examples

See [packages/examples/](../examples/) for more examples:
- Basic HTTP mode client
- Multi-client event publishing
- Error handling patterns
- Custom retry strategies

## Related Packages

- `@crosstown/core` - Core protocol implementation (peer discovery, SPSP, bootstrap)
- `@crosstown/relay` - Nostr relay server with ILP payment gating
- `@crosstown/bls` - Business Logic Server (event pricing, validation, storage)

## License

MIT

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/crosstown/issues)
- **Discussions:** [GitHub Discussions](https://github.com/yourusername/crosstown/discussions)
- **Documentation:** [docs/](../../docs/)
