# API Reference

## Main Class: `TOONClient`

The primary interface for interacting with the TOON network.

```typescript
import { TOONClient } from '@toon-protocol/client';
```

### Constructor

```typescript
new TOONClient(config: TOONClientConfig)
```

Creates a new client instance. Does NOT start the client — call `start()` to initialize.

**Throws:**

- `ValidationError` - If configuration is invalid

---

## Configuration: `TOONClientConfig`

```typescript
interface TOONClientConfig {
  // ===== REQUIRED =====

  /** HTTP URL of external ILP connector service */
  connectorUrl: string; // Example: 'http://localhost:8080'

  /** 32-byte Nostr private key (generated via nostr-tools).
   *  Your EVM address is derived from this key automatically. */
  secretKey: Uint8Array;

  /** ILP peer information for this client */
  ilpInfo: {
    pubkey: string; // Nostr public key (hex)
    ilpAddress: string; // ILP address (e.g., 'g.toon.abc123')
    btpEndpoint: string; // BTP WebSocket endpoint (e.g., 'ws://localhost:3000')
  };

  /** Function to encode Nostr events to TOON binary format */
  toonEncoder: (event: NostrEvent) => Uint8Array;

  /** Function to decode TOON binary to Nostr events */
  toonDecoder: (bytes: Uint8Array) => NostrEvent;

  // ===== OPTIONAL =====

  /** Nostr relay URL for peer discovery (default: 'ws://localhost:7100') */
  relayUrl?: string;

  /** ILP destination address for event publishing (default: derived from connectorUrl port) */
  destinationAddress?: string;

  /** Override EVM private key. By default, the EVM key is derived from secretKey
   *  (both use secp256k1). Only set this if you need a different EVM identity. */
  evmPrivateKey?: string | Uint8Array;

  /** BTP WebSocket URL (default: derived from connectorUrl) */
  btpUrl?: string;

  /** BTP auth token for BTP handshake */
  btpAuthToken?: string;

  /** BTP peer ID (used in connector env var BTP_PEER_{ID}_SECRET) */
  btpPeerId?: string;

  /** Supported settlement chain identifiers (e.g., ["evm:anvil:31337"]) */
  supportedChains?: string[];

  /** Maps chain identifier to EVM settlement address */
  settlementAddresses?: Record<string, string>;

  /** Maps chain identifier to preferred token contract address */
  preferredTokens?: Record<string, string>;

  /** Maps chain identifier to TokenNetwork contract address (EVM only) */
  tokenNetworks?: Record<string, string>;

  /** Maps chain identifier to RPC URL (e.g., {"evm:anvil:31337": "http://localhost:8545"}) */
  chainRpcUrls?: Record<string, string>;

  /** Amount to deposit when opening channel (default: "0") */
  initialDeposit?: string;

  /** Challenge period in seconds (default: 86400) */
  settlementTimeout?: number;

  /** Query timeout in milliseconds (default: 30000) */
  queryTimeout?: number;

  /** Max retry attempts for failed operations (default: 3) */
  maxRetries?: number;

  /** Delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
}
```

**Important Notes:**

- **EVM identity is automatic**: Your EVM address is derived from `secretKey` — no separate key management needed. Both Nostr and EVM use secp256k1, so one key provides both identities.
- `evmPrivateKey` is an optional override for advanced use cases (hardware wallets, custodial keys)
- `connector` parameter is **not supported** (embedded mode not implemented)
- HTTP mode is the only supported mode in this version

---

## Methods

### `start(): Promise<TOONStartResult>`

Starts the client, bootstraps the network, and begins monitoring for new peers.

**What it does:**

1. Initializes HTTP runtime and admin clients
2. Discovers peers via NIP-02 follow lists and kind:10032 events
3. Registers with discovered peers via connector admin API
4. Starts monitoring relay for new kind:10032 events

**Returns:**

```typescript
{
  mode: 'http',           // Always 'http' in this version
  peersDiscovered: number // Number of peers found during bootstrap
}
```

**Throws:**

- `TOONClientError` - If client is already started
- `TOONClientError` - If initialization fails (wraps underlying error)

**Example:**

```typescript
const result = await client.start();
console.log(`Mode: ${result.mode}, Peers: ${result.peersDiscovered}`);
```

---

### `publishEvent(event: NostrEvent, options?: PublishEventOptions): Promise<PublishEventResult>`

Publishes a signed Nostr event to the relay via ILP micropayment.

**Parameters:**

- `event` - **Must be finalized** (signed with `id`, `pubkey`, `sig`). Use `finalizeEvent()` from nostr-tools.
- `options` - Optional configuration:
  - `destination?: string` - ILP destination address (defaults to `config.destinationAddress`)
  - `claim?: SignedBalanceProof` - Signed balance proof for payment channel settlement

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

- `TOONClientError` - If client is not started
- `TOONClientError` - If publishing fails (network/connector error)

**Examples:**

_Basic usage (publishes to default destination):_

```typescript
const event = finalizeEvent(
  { kind: 1, content: 'Hello', tags: [], created_at: now },
  secretKey
);
const result = await client.publishEvent(event);

if (result.success) {
  console.log(`Published: ${result.eventId}`);
} else {
  console.error(`Failed: ${result.error}`);
}
```

_Multi-hop routing (publish to different destination):_

```typescript
// Publish to genesis node via peer1 connector
const result = await client.publishEvent(event, {
  destination: 'g.toon.genesis',
});
```

_With payment channel claim:_

```typescript
const claim = await client.signBalanceProof(channelId, amount);
const result = await client.publishEvent(event, {
  destination: 'g.toon.peer1',
  claim,
});
```

---

### `signBalanceProof(channelId: string, amount: bigint): Promise<SignedBalanceProof>`

Signs a balance proof for a payment channel with the specified amount.

**Parameters:**

- `channelId` - Payment channel identifier
- `amount` - Additional amount to add to cumulative transferred amount

**Returns:**

```typescript
{
  channelId: string;
  nonce: number; // Auto-incremented
  transferredAmount: bigint; // Cumulative amount
  lockedAmount: bigint; // Always 0n (no HTLCs yet)
  locksRoot: string; // Hash of empty lock set
  signature: string; // EIP-712 signature
  signerAddress: string; // EVM address of signer
}
```

**Throws:**

- `TOONClientError` - If channel not tracked

**Example:**

```typescript
// EVM signer is always available (derived from secretKey)
const claim = await client.signBalanceProof('0xChannelId...', 1000n);

// Use claim in payment
await client.publishEvent(event, { claim });
```

---

### `getTrackedChannels(): string[]`

Returns list of payment channel IDs currently tracked by the client.

**Returns:** Array of channel ID strings

**Example:**

```typescript
const channels = client.getTrackedChannels();
console.log(`Tracking ${channels.length} channels:`, channels);
```

---

### `getPublicKey(): string`

Returns the Nostr public key derived from the secret key. Works before `start()` is called.

**Returns:** Hex-encoded public key string

**Example:**

```typescript
const pubkey = client.getPublicKey();
console.log(`Public key: ${pubkey}`);
```

---

### `getEvmAddress(): string | undefined`

Returns the EVM address derived from `secretKey` (or explicit `evmPrivateKey` override). Works before `start()` is called.

**Returns:** EVM address string

**Example:**

```typescript
const evmAddr = client.getEvmAddress();
console.log(`EVM address: ${evmAddr}`);
```

---

### `sendPayment(params: PaymentParams): Promise<IlpSendResult>`

Sends an ILP payment, optionally with a balance proof claim via BTP.

**Parameters:**

```typescript
{
  destination: string;          // ILP destination address
  amount: string;              // Amount in base units
  data?: string;               // Base64-encoded data
  claim?: SignedBalanceProof;  // Optional balance proof
}
```

**Returns:**

```typescript
{
  accepted: boolean;
  fulfillment?: string;
  code?: string;
  message?: string;
  data?: string;
}
```

**Throws:**

- `TOONClientError` - If client is not started

**Example:**

```typescript
const result = await client.sendPayment({
  destination: 'g.toon.peer1',
  amount: '5000',
  data: Buffer.from('custom data').toString('base64'),
});
```

---

### `stop(): Promise<void>`

Stops the client and cleans up resources.

**What it does:**

1. Disconnects BTP client if connected
2. Clears internal state

**Throws:**

- `TOONClientError` - If client is not started
- `TOONClientError` - If stopping fails

**Example:**

```typescript
await client.stop();
```

---

### `isStarted(): boolean`

Returns `true` if the client is currently started, `false` otherwise.

**Example:**

```typescript
if (!client.isStarted()) {
  await client.start();
}
```

---

### `getPeersCount(): number`

Returns the number of peers discovered during bootstrap.

**Throws:**

- `TOONClientError` - If client is not started

**Example:**

```typescript
const count = client.getPeersCount();
console.log(`Connected to ${count} peers`);
```

---

### `getDiscoveredPeers(): DiscoveredPeer[]`

Returns the list of peers discovered by the relay monitor.

**Returns:**

```typescript
Array<{
  ilpAddress: string;
  btpEndpoint: string;
  pubkey: string;
  // ... other peer metadata
}>;
```

**Throws:**

- `TOONClientError` - If client is not started

**Example:**

```typescript
const peers = client.getDiscoveredPeers();
peers.forEach((peer) => {
  console.log(`Peer: ${peer.pubkey} at ${peer.ilpAddress}`);
});
```
