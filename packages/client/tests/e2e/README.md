# E2E Test Setup Guide

This guide explains how to run end-to-end tests for `@crosstown/client` HTTP mode.

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

### 2. Build Docker Images

Build the required Docker images from the repository root:

```bash
# Build Crosstown image (relay + BLS)
docker build -f docker/Dockerfile -t crosstown:optimized .

# Build connector image
cd ../connector
docker build -t connector:patched .
cd ../crosstown
```

## Running E2E Tests

### Step 1: Start Infrastructure

From the repository root, start the docker-compose infrastructure:

```bash
docker compose -f docker-compose-simple.yml up -d
```

Expected output:
```
✔ Container crosstown-connector  Started
✔ Container crosstown-node       Started
```

### Step 2: Verify Services Are Healthy

Wait 5-10 seconds for services to start, then verify:

```bash
# Connector runtime (required)
curl http://localhost:8080/health
# Expected: 200 OK or {"status":"ok"}

# Crosstown BLS (required)
curl http://localhost:3100/health
# Expected: 200 OK or {"status":"ok"}
```

### Step 3: Run E2E Tests

```bash
cd packages/client
pnpm test:e2e
```

Expected output:
```
✓ CrosstownClient HTTP Mode E2E > HTTP Mode Bootstrap and Lifecycle
✓ CrosstownClient HTTP Mode E2E > Event Publishing via HTTP Connector
✓ CrosstownClient HTTP Mode E2E > Multiple Client Instances
```

### Step 4: Stop Infrastructure

After testing, stop the infrastructure:

```bash
# From repository root
docker compose -f docker-compose-simple.yml down

# Optional: Remove volumes (clears event database)
docker compose -f docker-compose-simple.yml down -v
```

## Troubleshooting

### Tests Are Skipped

**Symptom:** E2E tests show `⏭️  Skipping: Infrastructure not ready`

**Solution:**
1. Verify docker-compose is running: `docker compose -f docker-compose-simple.yml ps`
2. Check service health:
   ```bash
   curl http://localhost:8080/health  # Connector
   curl http://localhost:3100/health  # BLS
   ```
3. If services are not healthy, check logs:
   ```bash
   docker compose -f docker-compose-simple.yml logs connector
   docker compose -f docker-compose-simple.yml logs crosstown-node
   ```

### Port Conflicts

**Symptom:** `Error: bind: address already in use`

**Solution:**
```bash
# Find process using port 8080 (connector runtime)
lsof -ti:8080 | xargs kill -9

# Find process using port 8081 (connector admin)
lsof -ti:8081 | xargs kill -9

# Find process using port 7100 (Nostr relay)
lsof -ti:7100 | xargs kill -9

# Find process using port 3100 (BLS)
lsof -ti:3100 | xargs kill -9
```

Then restart docker-compose:
```bash
docker compose -f docker-compose-simple.yml up -d
```

### Images Not Found

**Symptom:** `Error: pull access denied for crosstown:optimized`

**Solution:**
Build the images first (see Prerequisites step 2 above).

### Connector Health Check Fails

**Symptom:** `curl http://localhost:8080/health` returns connection refused

**Solution:**
1. Check if connector container is running:
   ```bash
   docker compose -f docker-compose-simple.yml ps
   ```
2. Check connector logs:
   ```bash
   docker compose -f docker-compose-simple.yml logs connector
   ```
3. Restart infrastructure:
   ```bash
   docker compose -f docker-compose-simple.yml restart
   ```

### BLS Health Check Fails

**Symptom:** `curl http://localhost:3100/health` returns connection refused

**Solution:**
1. Check if crosstown-node container is running:
   ```bash
   docker compose -f docker-compose-simple.yml ps
   ```
2. Check BLS logs:
   ```bash
   docker compose -f docker-compose-simple.yml logs crosstown-node
   ```
3. Verify BLS config in docker-compose-simple.yml

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
import { CrosstownClient } from '@crosstown/client';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);

const client = new CrosstownClient({
  connectorUrl: 'http://localhost:8080',
  secretKey,
  ilpInfo: {
    pubkey,
    ilpAddress: `g.crosstown.test.${pubkey.slice(0, 8)}`,
    btpEndpoint: 'ws://test:3000',
  },
  toonEncoder: encodeEventToToon,
  toonDecoder: decodeEventFromToon,
  relayUrl: 'ws://localhost:7100',
});

await client.start();

const event = finalizeEvent({
  kind: 1,
  content: 'Hello from Crosstown!',
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
}, secretKey);

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
  run: docker compose -f docker-compose-simple.yml up -d

- name: Wait for Services
  run: |
    sleep 10
    curl --retry 5 --retry-delay 2 http://localhost:8080/health
    curl --retry 5 --retry-delay 2 http://localhost:3100/health

- name: Run E2E Tests
  run: cd packages/client && pnpm test:e2e

- name: Stop Infrastructure
  run: docker compose -f docker-compose-simple.yml down
```

## Further Reading

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Crosstown Architecture](../../../docs/architecture/)
- [ILP Connector Documentation](https://github.com/interledger/rafiki/tree/main/packages/backend)
