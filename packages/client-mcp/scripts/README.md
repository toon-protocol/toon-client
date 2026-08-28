# client-mcp live-exercise scripts

Manual, one-shot scripts for exercising a **running** `toon-clientd` daemon
against a live TOON node (e.g. the operator HS node from issue #197). They are
NOT part of the build or test suite — they drive the daemon's loopback control
plane (`http://127.0.0.1:8787`) the same way the `toon-mcp` plugin tools do.

Prereq: a configured + running daemon (`~/.toon-client/config.json`, then
`toon-clientd`), connected and `ready` (`curl 127.0.0.1:8787/status`).

| Script | What it does |
| --- | --- |
| `dvm-upload.mjs` | Builds a kind:5094 Arweave-blob DVM job and POSTs it via `/publish` to `g.proxy.store`; prints the FULFILL Arweave txid. |

Run from this package dir, e.g.:

```bash
node scripts/dvm-upload.mjs
```

There is no swap script here (and no swap-scripts package to reach for). To
exercise a swap manually, POST the daemon's `/swap` endpoint the same way
`toon_swap` does — the daemon itself runs the whole session: a kind:20033 RFQ
to the maker, then the coupled rolling fills, which is TOON's only swap
protocol.
