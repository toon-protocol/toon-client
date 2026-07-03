---
'@toon-protocol/rig': patch
---

`rig fund`: infer devnet from a configured devnet git origin (#288).

The shipped #291 auto-detect only inspected the env/config
`relayUrl`/`proxyUrl`/`btpUrl` endpoints — NOT the git `origin` remote that
`rig remote add origin <relay-url>` configures. So a fresh user who followed
the documented flow (`rig remote add origin
wss://relay-ws.devnet.toonprotocol.dev`, then `rig fund`) still landed on
network `custom` and had to also export `TOON_CLIENT_NETWORK=devnet`.

`rig fund` now ALSO resolves the origin relay URL the same way `rig push`/`rig
fetch` do (via the `rig remote`/git-config `origin` resolution) and treats a
`*.devnet.toonprotocol.dev` origin host as the devnet signal. A plain
`rig fund` with no env var now drips for that user.

- An **explicit** non-`custom` `TOON_CLIENT_NETWORK` (or config `network`)
  stays authoritative and is never coerced to devnet; `TOON_CLIENT_FAUCET_URL`
  / `faucetUrl` overrides keep top precedence.
- A non-devnet or non-relay origin (e.g. an SSH GitHub clone URL) infers
  nothing; the origin resolution is best-effort and never errors a free
  command.
- The inference is still surfaced (the "Inferred network 'devnet' from the
  configured origin …" line / `--json` `inferredDevnetFrom`).
