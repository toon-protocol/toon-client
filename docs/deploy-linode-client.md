# Deploying the headless TOON client to Linode

Stands a **headless mcp-use client** up on a Linode VPS: an always-on `toon-clientd`
daemon plus a Claude-driven journey runner that exercises the SocialFi + DeFi journey
against a live apex hub. As a pure consumer the box has **no inbound ports** — only
outbound to the hub's BTP/relay (or its `.anon` hidden service in Phase 2).

> **Runner status:** the deterministic journey orchestrator is WS5 + WS7
> (`toon-protocol/toon-client#21`). Until it lands, the runner does a **safe read-only
> smoke** by default (`TOON_JOURNEY=smoke`); `full` is opt-in.

## Pairs with the hub

This mirrors the hub deploy (`toon-protocol/hub`, `docs/deploy-linode.md`) and **reuses
the same** `LINODE_TOKEN`, `LINODE_OBJ_*`, `TF_STATE_*`, `LINODE_REGION`, and
`ALLOWED_SSH_CIDR` secrets/vars (Terraform state uses a separate key,
`client/terraform.tfstate`). Run the hub first so you have its BTP/relay endpoints.

## 1. Additional secrets & variables

| Name | Kind | Purpose |
| --- | --- | --- |
| `CLIENT_SSH_KEY` | secret | Private CI deploy key for this box. |
| `CLIENT_SSH_PUBKEY` | var | Public half → cloud-init. |
| `TOON_CLIENT_KEYSTORE_PASSWORD` | secret | Unlocks the client's encrypted keystore. |
| `ANTHROPIC_API_KEY` | secret | Claude API key the mcp-use agent uses. |

Generate the deploy key: `ssh-keygen -t ed25519 -f client_deploy -N ''`.

## 2. Provision

Run **Deploy Headless Client (Linode)** with `apply_infra = true` (or `terraform apply`
locally — see [`infra/terraform/README.md`](../infra/terraform/README.md)). Grab the IP
from the logs.

## 3. One-time keystore + config bootstrap (seed stays off CI)

SSH in as `deploy` and create the config + keystore **once** on the persistent volume.

```bash
ssh deploy@<IP>
export TOON_CLIENT_CONFIG=/mnt/toon-client/config.json
export TOON_CLIENT_KEYSTORE_PASSWORD='<same value as the secret>'

# config.json points the daemon at the hub and at a keystore on the volume.
cat > "$TOON_CLIENT_CONFIG" <<'JSON'
{
  "destination": "g.townhouse.town",
  "btpUrl": "ws://<HUB_IP>:3000",
  "relayUrl": "ws://<HUB_IP>:7100",
  "transport": "direct",
  "keystorePath": "/mnt/toon-client/keystore.json"
}
JSON

# First start creates the encrypted keystore (encrypted with the env password) and the
# Nostr + EVM/Solana/Mina identity. Confirm the addresses, then stop.
toon-clientd &        # or: sudo systemctl start toon-clientd
sleep 3
toon-mcp <<< '{}'     # or query the daemon: curl 127.0.0.1:<httpPort>/status
```

Record the printed addresses and fund the client wallet with **small** testnet/devnet
amounts only (Base Sepolia USDC + a little gas; Solana devnet SOL; Mina devnet MINA).

## 4. Deploy

- **Automatic:** pushing under `infra/**` runs the pipeline → ships the runner → installs
  the CLI → writes the runtime secrets → restarts `toon-clientd` → health gate. The
  deploy refuses to run if `config.json` is missing (forces step 3 first).
- **Manual:** dispatch with `run_journey = true`, `journey_mode = smoke` to trigger one
  read-only smoke run; switch to `full` once the orchestrator + funded keystore are ready.

The headless runner is a **oneshot** unit and never auto-starts (it spends funds +
tokens). Trigger a run with the workflow input or `sudo systemctl start toon-headless`;
inspect with `journalctl -u toon-headless`.

## 5. Phase 2 — behind the anyone proxy

When the hub moves to HS mode, point the client at the hub's `.anon` endpoint and set the
transport to a SOCKS5h proxy in `config.json`:

```json
{ "btpUrl": "wss://<hub>.anon:443", "transport": "socks5h://127.0.0.1:9050", "relayUrl": "..." }
```

No firewall change is needed — the box was already egress-only.

## 6. Teardown & safety

- The Block Storage volume is the durable root of the client wallet/keystore — **snapshot
  it before `terraform destroy`.**
- Rotate `CLIENT_SSH_KEY`, `TOON_CLIENT_KEYSTORE_PASSWORD`, and `ANTHROPIC_API_KEY` per
  the org's secret-rotation policy.
