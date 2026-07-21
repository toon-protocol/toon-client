---
"@toon-protocol/rig": minor
"@toon-protocol/client": minor
---

Zero-config devnet: baked defaults for a fresh install, a `rig entry` switch,
and per-pair Mina zkApp auto-deploy.

rig:

- `rig fund` on a completely fresh install (no config, env, or git-origin
  anywhere) now infers devnet from core's committed genesis seed and drips —
  `npm i -g @toon-protocol/rig && rig fund` works with zero config. Any
  configured origin (devnet or not) still suppresses the seed, so an explicit
  or deliberately non-devnet setup keeps its exact semantics (#288).
- `rig name buy`/`rig name set` default `--via` to the deployed devnet store
  DVM when BOTH the ArNS `--network` and the TOON network resolve to devnet;
  the new `--direct` flag opts out (and also suppresses `RIG_ARNS_DVM_URL`).
- `rig channels` — shorthand for `rig channel list`.
- New `rig entry <apex|sandbox|url>`: switch the network entry node (payment
  ingress + relay) with the devnet sandbox endpoints baked in. Mutations
  clear the topology cache, remove the legacy `proxyUrl` override, and warn
  about env precedence, per-entry channels, the sandbox's Mina-only
  settlement, and git-origin relay precedence.
- New `rig channel deploy-zkapp`: pre-deploy this identity's dedicated Mina
  PaymentChannel zkApp ahead of the first paid Mina write.
- `chain` (and the new verbs) added to the strict-`--json` owned-verb set.

client:

- Per-pair Mina zkApp auto-deploy: the Mina `PaymentChannel` zkApp is
  single-pair, so a fresh identity can never open a channel on the shared
  announce/preset zkApp. `minaChannel.autoDeploy` (wired automatically by
  rig's derived config) makes `openMinaChannel` resolve a zkApp that is
  provably owned by this pair — reusing a recorded deployment, including
  crash-recovery of an uninitialized one — and deploy a dedicated zkApp
  otherwise (deploy and initialize stay separate transactions). New exports:
  `deployMinaChannelZkApp`, `ensureOwnedMinaZkApp`. Without `autoDeploy`,
  behavior is unchanged and `zkAppAddress` remains required.
