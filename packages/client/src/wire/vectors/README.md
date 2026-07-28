# Vendored wire vectors

`wire-vectors.json` is a **verbatim copy** of `vectors/wire-vectors.json` on
[`toon-protocol/connector`](https://github.com/toon-protocol/connector) `main`.
It is generated there (`cargo run -p connector-vectors --bin generate-vectors`),
never hand-written, and it is the cross-repo contract for the client-edge
termination wire ([connector ADR
0021](https://github.com/toon-protocol/connector/blob/main/docs/adr/0021-vectors-are-normative-prose-is-not.md)):
reproducing these bytes is what conformance means for this client.

`wire-vectors.provenance.json` records the connector commit it came from and the
SHA-256 of the copy. `src/wire/wire-vectors.test.ts` replays the `envelope`
section against `src/wire/envelope.ts`.

## Why vendored, and not fetched or submoduled

A vendored copy that can drift silently is the worst option, so this one cannot:

| | |
|---|---|
| **Integrity** | `wire-vectors.test.ts` hashes the vendored file every run and fails if it does not match `provenance.sha256`. Hand-editing the copy to make a failing replay pass is therefore not possible without also editing the provenance, which shows up in review as exactly what it is. |
| **Drift** | `pnpm --filter @toon-protocol/client vectors:check` fetches the connector's current `main` copy and fails if it differs. `.github/workflows/wire-vectors-drift.yml` runs it daily and on any PR that touches `src/wire/**`. |
| **Refresh** | `pnpm --filter @toon-protocol/client vectors:refresh` rewrites both files from connector `main` (or `--ref <sha>`). The diff it produces is the wire change. |

The rejected alternatives:

- **Fetched at test time** — makes `pnpm test` require the network and makes a
  connector-side change break this repo's CI on an unrelated PR, with no commit
  here recording what changed. Conformance would also be untestable offline.
- **Git submodule** — pulls the entire Rust connector repo (and its
  toolchain-shaped tree) into every `pnpm install` for one 7 KB JSON file, and
  submodule pointer bumps are a notoriously easy thing to merge without reading.

Vendoring keeps the bytes in this repo's history — so `git log` on this file is
the record of every wire change this client has adopted — while the check above
removes the one thing vendoring costs.

## Refreshing

```sh
# Adopt connector main:
pnpm --filter @toon-protocol/client vectors:refresh
# Or pin an exact connector commit:
pnpm --filter @toon-protocol/client vectors:refresh -- --ref <connector-sha>
```

Then run `pnpm --filter @toon-protocol/client test`. A failing replay after a
refresh means the wire changed and this client has not caught up — that is the
signal, not a flake. Commit `wire-vectors.json` and
`wire-vectors.provenance.json` together.

## Sections

`schema_version` is `1`. The file carries three sections; this repo replays them
as its children land:

- `envelope` — **replayed** (toon-client#448): 5 valid round-trips + 8 rejection
  cases.
- `giftwrap` — present, not yet replayed (toon-client#449 owns the seal). The
  HKDF salt/info labels and wrap framing are **not** documented in the
  connector's `vectors/README.md`; they are only in
  `crates/connector-signer/src/giftwrap.rs` (tracked as connector#587).
- `fulfilment` — present, not yet replayed.

`loadWireVectors()` in `load.ts` already exposes all three, so adding a section
to the harness is a new `describe` block, not a restructure.
