---
'@toon-protocol/git': minor
---

Standalone embedded Publisher + daemon-collision nonce guard (#228).

New `@toon-protocol/git/standalone` subpath export (the core entry stays
dependency-light — `@toon-protocol/client` is an OPTIONAL peer dependency
needed only by this entry): `StandalonePublisher` implements the `Publisher`
interface over an EMBEDDED `ToonClient` built from the caller's config
(mnemonic + account index, the `packages/client/src/config.ts` shape) for
CI/servers/one-shot CLI runs with no toon-clientd. Publishes sign with the
derived Nostr key and pay one balance-proof claim per write at the flat
per-event fee; `uploadGitObject` mirrors the proven seed pipeline (kind:5094
store write tagged Git-SHA/Git-Type/Repo, bytes × per-byte bid, routed via
`proxyPath: '/store'`, Arweave txId decoded from the FULFILL — HTTP-enveloped
or legacy bare form); `getFeeRates` reports the configured flat event fee +
per-byte upload rate. Publish/store routes derive from the channel anchor with
the daemon's `<base>.relay.store` convention.

Nonce-ownership guard (the load-bearing piece): the payment channel's
cumulative-claim watermark tolerates exactly ONE writer per identity, so
before any paid operation the publisher (1) probes the toon-clientd loopback
control API (`GET /status`, port 8787 / `TOON_CLIENT_HTTP_PORT`) and REFUSES
with `DaemonIdentityConflictError` when a running daemon reports the same
Nostr pubkey — use daemon mode or stop the daemon — and (2) holds an exclusive
per-pubkey advisory lockfile (`standalone-<pubkey>.lock` under
`~/.toon-client` / `TOON_CLIENT_HOME`) against other standalone processes,
with stale-lock reclaim by dead-pid detection, released on `stop()` and
process exit.
