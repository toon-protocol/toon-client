---
'@toon-protocol/rig': patch
---

`rig fund` UX remediation + CLI polish (#280):

- **`rig fund` names the right knob first.** On a `custom`/unset network
  without a faucet, the guidance now leads with `TOON_CLIENT_NETWORK=devnet`
  (the actual fix for the shared devnet — no faucet URL needed) and frames
  `TOON_CLIENT_FAUCET_URL` as the self-hosted-network override. When a
  configured relay/proxy/BTP origin is under `*.devnet.toonprotocol.dev`, the
  message says so explicitly.
- **Calm stderr on paid commands.** The embedded client's expected
  `[Bootstrap] Announce failed … 402 Payment Required` x402 dump is reframed
  as one plain-language info line (harmless, the command continues); repeats
  are dropped, non-402 announce failures still pass through. Internal issue
  numbers are gone from user-facing warnings.
- **`rig pr create --body <text>` / `--body-file <path>`.** The PR
  description rides in a dedicated `description` tag on the kind:1617 event —
  never in the content, which stays pure `git format-patch` output so
  `git am` keeps applying it (git's patch-format detection hard-fails on
  leading prose). `rig pr show` renders the body as its own section and
  carries it in the `--json` envelope.
