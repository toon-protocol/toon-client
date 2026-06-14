# client-mcp live-exercise scripts

Manual, one-shot scripts for exercising a **running** `toon-clientd` daemon
against a live TOON node (e.g. the operator HS node from issue #197). They are
NOT part of the build or test suite — they drive the daemon's loopback control
plane (`http://127.0.0.1:8787`) the same way the `toon-mcp` plugin tools do.

Prereq: a configured + running daemon (`~/.toon-client/config.json`, then
`toon-clientd`), connected and `ready` (`curl 127.0.0.1:8787/status`).

| Script | What it does |
| --- | --- |
| `dvm-upload.mjs` | Builds a kind:5094 Arweave-blob DVM job and POSTs it via `/publish` to `g.townhouse.dvm`; prints the FULFILL Arweave txid. |

Run from this package dir, e.g.:

```bash
node scripts/dvm-upload.mjs
```

See also `packages/sdk/scripts/` for the mill swap exercise scripts
(`mill-swap.mjs` EVM→Solana, `mill-swap-mina.mjs` EVM→Mina), which build the
gift-wrapped kind:20032 rumor and drive the daemon `/swap` endpoint.
