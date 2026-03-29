# E2E Test Setup Guide

This guide explains how to run end-to-end tests for `@toon-protocol/client` HTTP mode.

## Prerequisites

### 1. Docker and Docker Compose

Verify Docker and Docker Compose are installed:

```bash
docker --version          # Should show Docker version 20+
docker compose version    # Should show Compose v2+
```

If not installed:

- **macOS:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux:** Install [Docker Engine](https://docs.docker.com/engine/install/) and [Docker Compose](https://docs.docker.com/compose/install/)

## Running E2E Tests

### Step 1: Start Infrastructure

From the repository root, start the SDK E2E infrastructure:

```bash
./scripts/sdk-e2e-infra.sh up
```

### Step 2: Verify Services Are Healthy

Wait for the infrastructure script to complete, then verify:

```bash
# Peer 1 BLS (required)
curl http://localhost:19100/health
# Expected: 200 OK or {"status":"ok"}

# Peer 2 BLS (required)
curl http://localhost:19110/health
# Expected: 200 OK or {"status":"ok"}
```

### Step 3: Run E2E Tests

```bash
cd packages/client
pnpm test:e2e
```

Expected output:

```
✓ TOONClient HTTP Mode E2E > HTTP Mode Bootstrap and Lifecycle
✓ TOONClient HTTP Mode E2E > Event Publishing via HTTP Connector
✓ TOONClient HTTP Mode E2E > Multiple Client Instances
```

### Step 4: Stop Infrastructure

After testing, stop the infrastructure:

```bash
# From repository root
./scripts/sdk-e2e-infra.sh down
```

## Troubleshooting

### Tests Are Skipped

**Symptom:** E2E tests show `⏭️  Skipping: Infrastructure not ready`

**Solution:**

1. Verify infrastructure is running: `docker compose -p toon-sdk-e2e -f docker-compose-sdk-e2e.yml ps`
2. Check service health:
   ```bash
   curl http://localhost:19100/health  # Peer 1 BLS
   curl http://localhost:19110/health  # Peer 2 BLS
   ```
3. If services are not healthy, check logs:
   ```bash
   docker compose -p toon-sdk-e2e -f docker-compose-sdk-e2e.yml logs
   ```

### Port Conflicts

**Symptom:** `Error: bind: address already in use`

**Solution:**

```bash
# Find process using port 19100 (Peer 1 BLS)
lsof -ti:19100 | xargs kill -9

# Find process using port 19110 (Peer 2 BLS)
lsof -ti:19110 | xargs kill -9

# Find process using port 19700 (Peer 1 relay)
lsof -ti:19700 | xargs kill -9

# Find process using port 18545 (Anvil)
lsof -ti:18545 | xargs kill -9
```

Then restart infrastructure:

```bash
./scripts/sdk-e2e-infra.sh down && ./scripts/sdk-e2e-infra.sh up
```

### BLS Health Check Fails

**Symptom:** `curl http://localhost:19100/health` returns connection refused

**Solution:**

1. Check if containers are running:
   ```bash
   docker compose -p toon-sdk-e2e -f docker-compose-sdk-e2e.yml ps
   ```
2. Check logs:
   ```bash
   docker compose -p toon-sdk-e2e -f docker-compose-sdk-e2e.yml logs
   ```
3. Restart infrastructure:
   ```bash
   ./scripts/sdk-e2e-infra.sh down && ./scripts/sdk-e2e-infra.sh up
   ```

### Tests Timeout

**Symptom:** `Test timed out in 30000ms`

**Solution:**

1. Check if relay is slow to respond (network issues)
2. Increase timeout in `vitest.e2e.config.ts`:
   ```typescript
   testTimeout: 60000, // Increase from 30s to 60s
   ```

## Manual Testing

You can also test the client manually using the infrastructure:

```javascript
import { TOONClient } from '@toon-protocol/client';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

const client = new TOONClient({
  connectorUrl: 'http://localhost:8080',
  secretKey,
  ilpInfo: {
    pubkey,
    ilpAddress: `g.toon.test.${pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://test:3000',
  },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,
  relayUrl: 'ws://localhost:7100',
});

await client.start();

const event = finalizeEvent(
  {
    kind: 1,
    content: 'Hello from TOON!',
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  },
  secretKey
);

const result = await client.publishEvent(event);
console.log('Published:', result);

await client.stop();
```

## CI/CD Integration

E2E tests are designed to automatically skip if infrastructure is not available. This allows them to run in CI environments where docker-compose may not be available, while still providing full E2E coverage in local development.

To run E2E tests in CI:

```yaml
# Example GitHub Actions workflow
- name: Start Infrastructure
  run: ./scripts/sdk-e2e-infra.sh up

- name: Run E2E Tests
  run: cd packages/client && pnpm test:e2e

- name: Stop Infrastructure
  run: ./scripts/sdk-e2e-infra.sh down
```

## Further Reading

- [Docker Compose Documentation](https://docs.docker.com/compose/)
