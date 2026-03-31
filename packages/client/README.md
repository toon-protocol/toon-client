# @toon-protocol/client

High-level TypeScript client for publishing Nostr events to the TOON protocol — an ILP-gated Nostr relay that enables sustainable relay operation through micropayments.

## What It Does

This client handles:

- **ILP Micropayments**: Pay to publish Nostr events (read is free)
- **Payment Channels**: Automatic on-chain channel creation with off-chain settlement via signed balance proofs
- **Unified Identity**: One Nostr key = one EVM address (both use secp256k1, derived automatically)
- **Multi-Hop Routing**: Publish to any destination address, not just your direct peer
- **Network Bootstrap**: Automatically discover and register with ILP peers via NIP-02 follow lists
- **TOON Encoding**: Native binary format for agent-friendly event encoding

## Installation

```bash
pnpm add @toon-protocol/client @toon-protocol/core @toon-protocol/relay nostr-tools
```

## Prerequisites

The client requires external services. Use the SDK E2E infrastructure for local development:

```bash
# Start SDK E2E infrastructure
./scripts/sdk-e2e-infra.sh up

# Verify services are healthy
curl http://localhost:19100/health  # Peer 1 BLS
curl http://localhost:19110/health  # Peer 2 BLS
# Nostr relays on ws://localhost:19700 and ws://localhost:19710 (WebSocket, no HTTP endpoint)

# Stop infrastructure
./scripts/sdk-e2e-infra.sh down
```

| Service          | Port  | Purpose                                             |
| ---------------- | ----- | --------------------------------------------------- |
| **Anvil**        | 18545 | Local EVM chain (chain ID 31337)                    |
| **Peer 1 BLS**   | 19100 | Validates events, calculates pricing, stores events |
| **Peer 1 Relay** | 19700 | WebSocket relay for peer discovery (kind:10032)     |
| **Peer 2 BLS**   | 19110 | Validates events, calculates pricing, stores events |
| **Peer 2 Relay** | 19710 | WebSocket relay for peer discovery (kind:10032)     |

---

## Quick Start

```typescript
import { ToonClient } from '@toon-protocol/client';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';

// 1. Generate identity — one key gives you both Nostr and EVM identities
const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

// 2. Create client
const client = new ToonClient({
  connectorUrl: 'http://localhost:8080',
  secretKey,
  ilpInfo: {
    pubkey,
    ilpAddress: `g.toon.${pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://localhost:3000',
  },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,
});

// 3. Start (bootstrap network, discover peers)
await client.start();

// Your EVM address is derived from the same key — no separate config needed
console.log(`EVM address: ${client.getEvmAddress()}`);

// 4. Publish event to relay via ILP payment
const event = finalizeEvent(
  { kind: 1, content: 'Hello from TOON!', tags: [], created_at: Math.floor(Date.now() / 1000) },
  secretKey,
);

const result = await client.publishEvent(event);
if (result.success) {
  console.log(`Published: ${result.eventId}`);
}

// 5. Clean up
await client.stop();
```

---

## Payment Channels

The client supports EVM-based payment channels for off-chain settlement. Your EVM identity is derived from your Nostr `secretKey` automatically — no separate EVM key needed.

### Enabling Payment Channels

To use payment channels, add chain configuration. The client already has your EVM identity from `secretKey`:

```typescript
const client = new ToonClient({
  connectorUrl: 'http://localhost:8080',
  secretKey,
  ilpInfo: { pubkey, ilpAddress: `g.toon.${pubkey.slice(0, 8)}`, btpEndpoint: 'ws://localhost:3000' },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,

  // Add chain config to enable payment channels
  supportedChains: ['evm:anvil:31337'],
  chainRpcUrls: { 'evm:anvil:31337': 'http://localhost:8545' },
  settlementAddresses: { 'evm:anvil:31337': client.getEvmAddress()! },
  tokenNetworks: { 'evm:anvil:31337': '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' },
  initialDeposit: '1000000000000000000', // 1 ETH in wei
});

await client.start();

// Channels are created automatically during bootstrap
const channels = client.getTrackedChannels();
console.log(`Tracking ${channels.length} payment channels`);

// Publish with signed balance proof
const channelId = channels[0];
const claim = await client.signBalanceProof(channelId, 1000n);
await client.publishEvent(event, { claim });
```

### How It Works

1. **Bootstrap**: Client discovers peers via NIP-02 and kind:10032 events
2. **Channel Creation**: Opens on-chain payment channel using your derived EVM address
3. **Off-chain Payments**: Signed balance proofs settle payments off-chain
4. **Auto-tracking**: ChannelManager automatically tracks channels and increments nonces

### Using a Separate EVM Key (Advanced)

If you need a different EVM identity than your Nostr key (e.g., hardware wallet or custodial key), pass `evmPrivateKey` explicitly:

```typescript
const client = new ToonClient({
  // ... required config ...
  evmPrivateKey: '0x...', // Overrides the default derivation from secretKey
});
```

---

## Documentation

- **[API Reference](docs/api-reference.md)** — Constructor, config interface, and all methods
- **[Error Handling](docs/error-handling.md)** — Error class hierarchy, codes, and usage patterns
- **[HTTP Adapters](docs/adapters.md)** — Low-level `HttpRuntimeClient`, `HttpConnectorAdmin`, and `withRetry`
- **[Troubleshooting](docs/troubleshooting.md)** — Common issues and solutions

---

## Testing

### Unit & Integration Tests

```bash
cd packages/client
pnpm test                 # Run all unit/integration tests
pnpm test:coverage        # Run with coverage report
```

### E2E Tests

E2E tests require the SDK E2E infrastructure:

```bash
# Start infrastructure
./scripts/sdk-e2e-infra.sh up

# Run E2E tests
cd packages/client
pnpm test:e2e
```

See [tests/e2e/README.md](tests/e2e/README.md) for detailed E2E setup.

---

## Examples

See [examples/client-example/](../../examples/client-example/) for standalone client examples:

- **01 - Publish Event**: Full client lifecycle with self-describing claims
- **02 - Payment Channel Lifecycle**: Multiple events with incrementing balance proofs

---

## Related Packages

- **[@toon-protocol/core](../core/)** — Core protocol (peer discovery, bootstrap)
- **[@toon-protocol/relay](../relay/)** — Nostr relay with ILP payment gating
- **[@toon-protocol/bls](../bls/)** — Business Logic Server (pricing, validation, storage)

---

## License

MIT
