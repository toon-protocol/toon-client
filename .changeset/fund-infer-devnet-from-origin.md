---
'@toon-protocol/rig': minor
---

`rig fund`: infer devnet from a configured devnet origin (#288).

When the resolved network is `custom` (or unset) but a configured origin —
`relayUrl`/`proxyUrl`/`btpUrl` or their `TOON_CLIENT_*_URL` env overrides —
points at the shared devnet (`*.devnet.toonprotocol.dev`), `rig fund` now
treats the network as `devnet` and drips from the deployed devnet faucet
automatically, instead of stopping to tell the user to also export
`TOON_CLIENT_NETWORK=devnet`. The origin host already encodes `devnet`, so the
extra step is redundant.

- An **explicit** non-`custom` `TOON_CLIENT_NETWORK` (or config `network`)
  stays authoritative and is never coerced to devnet; `TOON_CLIENT_FAUCET_URL`
  / `faucetUrl` overrides keep top precedence.
- The inference is surfaced, not silent: human output prints an "Inferred
  network 'devnet' from the configured origin …" line and `--json` carries
  `inferredDevnetFrom`.
- The #280 remediation text is unchanged for the no-devnet-origin case.
