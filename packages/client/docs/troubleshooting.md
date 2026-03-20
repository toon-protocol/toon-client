# Troubleshooting

## Client Fails to Start

**Symptom:** `TOONClientError: Failed to start client`

**Solutions:**

1. Verify connector is running:
   ```bash
   curl http://localhost:8080/health
   ```
2. Check connector logs:
   ```bash
   docker compose -p toon-genesis -f docker-compose-genesis.yml logs toon
   ```
3. Verify config has valid `connectorUrl`, `secretKey`, and `ilpInfo`

---

## Event Publishing Fails

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
   docker compose -p toon-genesis -f docker-compose-genesis.yml logs toon
   ```

---

## Port Conflicts

**Symptom:** `Error: bind: address already in use`

**Solutions:**

```bash
# Kill processes using ports
lsof -ti:8080 | xargs kill -9  # Connector runtime
lsof -ti:8081 | xargs kill -9  # Connector admin
lsof -ti:7100 | xargs kill -9  # Nostr relay
lsof -ti:3100 | xargs kill -9  # BLS

# Restart infrastructure
docker compose -p toon-genesis -f docker-compose-genesis.yml up -d
```

---

## Network Errors

**Symptom:** `NetworkError: Failed to connect to connector`

**Solutions:**

1. Check connector is running and accessible
2. Verify firewall/network settings allow connections to connector ports
3. Increase timeout in config:
   ```typescript
   const client = new TOONClient({
     // ...
     queryTimeout: 60000, // 60 seconds
   });
   ```
