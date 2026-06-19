# Running the headless client journey in CI

The TOON client runs as an **ephemeral GitHub Actions job** — no dedicated VM. On each
run, [`.github/workflows/journey.yml`](../.github/workflows/journey.yml) installs the
pinned `@toon-protocol/client-mcp` CLI + the Claude Agent SDK runner
([`journey/runner.mjs`](../journey/runner.mjs)), **derives a funded wallet from the
treasury seed**, starts `toon-clientd`, and drives the SocialFi + DeFi journey against
the live apex hub.

This is the consumer-side counterpart to the hub (which *does* run on Linode, as a
persistent apex — see `toon-protocol/hub`). The client is episodic, so it needs no
durable disk: the wallet is re-derived from the seed each run.

> **Runner status:** the deterministic journey orchestrator is WS5 + WS7
> (`toon-protocol/toon-client#21`). Until it lands, the runner does a **safe read-only
> smoke** by default; `full` is opt-in and spends tiny testnet amounts.

## Why no Linode box for the client

The client is a *job* (run a journey, report, exit), not an always-on service. GitHub
Actions handles it: full outbound to the hub, `CLAUDE_CODE_OAUTH_TOKEN` works natively
(your loops already use it), and the seed-derived wallet removes the only thing that
needed persistence. A dedicated box is only worth it for a *resident, always-on* agent
(persistent subscription, long-lived reused channels).

## Secrets & variables

**Secrets**

| Name | Purpose |
| --- | --- |
| `TREASURY_MNEMONIC` | The seed phrase the daemon derives the client wallet from (`TOON_CLIENT_MNEMONIC`). Map this to your existing seed-phrase org secret if it has a different name. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Max-plan auth for the Agent SDK (the same org secret the backlog loops use). |

**Variables**

| Name | Example | Purpose |
| --- | --- | --- |
| `HUB_DESTINATION` | `g.townhouse.town` | Apex ILP address. |
| `HUB_BTP_URL` | `ws://<hub-ip>:3000` | Hub BTP endpoint (pay-to-write). |
| `HUB_RELAY_URL` | `ws://<hub-ip>:7100` | Hub Nostr relay WS (reads). |
| `CLIENT_ACCOUNT_INDEX` | `0` | BIP-44 account index the client wallet derives at (optional, default `0`). |

## Wallet & funding

The daemon derives the Nostr + EVM/Solana/Mina identity from `TREASURY_MNEMONIC` at
`CLIENT_ACCOUNT_INDEX` — deterministic, so the client is the **same identity every run**.

- **smoke** (default): read-only (`toon_status` / `toon_identity`) — **no funds needed**.
- **full**: spends. Fund the derived addresses with **small** testnet/devnet amounts
  (Base Sepolia USDC + a little gas; Solana devnet SOL; Mina devnet MINA). Print them from
  a smoke run's `toon_identity` output, then fund from the treasury. Use a distinct
  `CLIENT_ACCOUNT_INDEX` from the hub's settlement accounts to avoid key collisions.

## Reaching the hub

The job dials the hub from a GitHub-hosted runner (dynamic IP). In **Phase 1 direct
mode**, the hub's firewall must accept it — open the hub's client ports
(`ALLOWED_CLIENT_CIDR=0.0.0.0/0`) for the demo (pay-to-write gates abuse), or use a
just-in-time firewall rule. In **Phase 2 (anyone proxy / HS)** the hub has no inbound at
all; add an `anon` client step to the job and set `transport` to a `socks5h://` proxy
pointing at the hub's `.anon` endpoint.

## Run it

Actions → **Client Journey (CI)** → Run workflow → choose `journey_mode`:
- `smoke` works today (read-only).
- `full` once the WS5 orchestrator lands and the derived wallet is funded.

Inspect the run logs (the runner streams the agent's tool calls + result; the daemon log
is uploaded on completion).
