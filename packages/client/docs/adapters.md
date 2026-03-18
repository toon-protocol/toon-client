# HTTP Adapters & Utilities

For advanced use cases, you can use the HTTP adapter classes directly without `TOONClient`.

## `HttpRuntimeClient`

Low-level client for sending ILP packets to the connector runtime API.

```typescript
import { HttpRuntimeClient } from '@toon-protocol/client';

const runtimeClient = new HttpRuntimeClient({
  connectorUrl: 'http://localhost:8080',
  timeout: 30000, // Optional: request timeout (ms)
  maxRetries: 3, // Optional: max retry attempts
  retryDelay: 1000, // Optional: retry delay (ms)
});

const result = await runtimeClient.sendIlpPacket({
  destination: 'g.toon.relay',
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

## `HttpConnectorAdmin`

Low-level client for managing ILP peers via the connector admin API.

```typescript
import { HttpConnectorAdmin } from '@toon-protocol/client';

const adminClient = new HttpConnectorAdmin({
  adminUrl: 'http://localhost:8081',
  timeout: 30000, // Optional: request timeout (ms)
  maxRetries: 3, // Optional: max retry attempts
  retryDelay: 1000, // Optional: retry delay (ms)
});

// Add single peer
await adminClient.addPeer({
  id: 'nostr-abc123',
  url: 'btp+ws://alice.example.com:3000',
  authToken: 'secret-token',
  routes: [{ prefix: 'g.toon.alice' }],
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
addResults.forEach((result) => {
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
  peerId: string; // Peer ID that was operated on
  success: boolean; // Whether operation succeeded
  error?: Error; // Error object (if failed)
}
```

---

## `withRetry()`

Retry helper with exponential backoff.

```typescript
import { withRetry } from '@toon-protocol/client';

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
