# `infra/terraform` — headless TOON client on Linode

Provisions one **egress-only** Linode instance + a persistent Block Storage volume, and
bootstraps it (Node 20, the pinned `@toon-protocol/client-mcp` CLI, systemd units) via
cloud-init. The box runs `toon-clientd` (always-on) and, on demand, the headless
Claude Agent SDK journey runner.

Normally driven by `.github/workflows/deploy-client.yml`; notes below are for local runs.

## Inputs

| Variable | Default | Notes |
| --- | --- | --- |
| `region` | `us-ord` | Must support Metadata/cloud-init + Block Storage. |
| `instance_type` | `g6-standard-1` | 2 GB; fits the daemon + the Node agent. |
| `volume_size` | `20` | GiB; holds `config.json`, the encrypted keystore, channel watermarks. |
| `client_version` | `0.1.0` | Pinned `@toon-protocol/client-mcp`; keep in sync with `infra/client-version.txt`. |
| `ssh_pubkey` | — | **Required.** Public half of the CI deploy key (`CLIENT_SSH_KEY`). |
| `allowed_ssh_cidr` | — | **Required.** Restrict SSH; there are no other inbound ports. |

## Auth & state

Identical to the hub's pattern: `LINODE_TOKEN` for the provider, and an S3 backend on
Linode Object Storage (credentials via `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

```bash
export LINODE_TOKEN=...
export AWS_ACCESS_KEY_ID=...            # Linode Object Storage access key
export AWS_SECRET_ACCESS_KEY=...        # Linode Object Storage secret key

terraform init \
  -backend-config="bucket=toon-tfstate" \
  -backend-config="key=client/terraform.tfstate" \
  -backend-config="region=us-ord-1" \
  -backend-config="endpoints={s3=\"https://us-ord-1.linodeobjects.com\"}"

terraform apply \
  -var="ssh_pubkey=$(cat ~/.ssh/client_deploy.pub)" \
  -var="allowed_ssh_cidr=203.0.113.4/32"
```

After apply, complete the one-time keystore + config bootstrap in
[`docs/deploy-linode-client.md`](../../docs/deploy-linode-client.md).

> The Block Storage volume is the durable root of the client wallet/keystore.
> **Snapshot it before destroying anything.**
