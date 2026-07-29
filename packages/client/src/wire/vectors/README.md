# Vendored wire vectors

`wire-vectors.json` is a **verbatim copy** of `vectors/wire-vectors.json` on
[`toon-protocol/connector`](https://github.com/toon-protocol/connector) `main`.
It is generated there (`cargo run -p connector-vectors --bin generate-vectors`),
never hand-written, and it is the cross-repo contract for the client-edge
termination wire ([connector ADR
0021](https://github.com/toon-protocol/connector/blob/main/docs/adr/0021-vectors-are-normative-prose-is-not.md)):
reproducing these bytes is what conformance means for this client.

`wire-vectors.provenance.json` records the connector commit it came from and the
SHA-256 of the copy. `src/wire/wire-vectors.test.ts` replays all four sections:
`envelope` against `src/wire/envelope.ts`, `giftwrap` and `fulfilment` against
`src/wire/giftwrap.ts`, and `claim` against `src/signing/evm-signer.ts`.

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

`schema_version` is `1`. The file carries four sections, and as of
toon-client#449 this repo replays **all four**:

- `envelope` — **replayed** (toon-client#448): 5 valid round-trips + 8 rejection
  cases.
- `giftwrap` — **replayed** (toon-client#449), against `src/wire/giftwrap.ts`:
  the pinned `request_wrap_hex` and `response_wrap_hex` are reproduced
  byte-for-byte from each case's pinned ephemeral secret, shared secret and
  nonces, and re-opened with the fixture identity secret. The HKDF `info`
  strings and the wrap framing are recorded in `src/wire/giftwrap.ts`'s module
  comment, cited to `crates/connector-signer/src/giftwrap.rs`, and are also
  documented in the connector's own `vectors/README.md` (connector#588).
- `fulfilment` — **replayed** (toon-client#449): both the matching and the
  non-matching case, including that the condition a sender mints is `sha256` of
  the derived fulfilment
  (`crates/connector-domain/src/condition.rs`'s `derive_condition`).
- `claim` — **replayed** (connector#588 added it): the EIP-712 `BalanceProof` of
  [connector ADR
  0024](https://github.com/toon-protocol/connector/blob/main/docs/adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md),
  replayed against `src/signing/evm-signer.ts`. See below.

`loadWireVectors()` in `load.ts` exposes all four, so adding a section to the
harness is a new `describe` block, not a restructure — which is exactly how
`giftwrap` and `fulfilment` arrived. The **not replayed** label is enforced, not
decorative: `WIRE_VECTOR_SECTIONS` in `load.ts` is a closed
list, and the harness fails if the vendored file carries a section that is not
in it, or one that is neither in `sectionsReplayed` nor in
`sectionsPresentNotYetReplayed`. A section the connector adds therefore breaks
the build until someone decides, in writing, what this repo does with it — which
is how `claim` came to be replayed rather than ignored.

### Why `claim` is replayed here

The connector moved its *peer* wire onto EIP-712 `BalanceProof` in ADR 0024;
this client does not sign peer-wire claims, so it would have been defensible to
carry the section and skip it. It is replayed anyway because this client already
signs **exactly that struct** on the *client edge*:
`EvmSigner.signBalanceProof` uses a `TokenNetwork`/`1` domain with a per-channel
`chainId`/`verifyingContract` and the same five-field `BalanceProof` with
zeroed `lockedAmount`/`locksRoot`. It reproduces the published `digest_hex` and
the published 65-byte signature byte-for-byte, so these vectors are real
conformance evidence here — a drifted domain field, a reordered struct member or
a dropped zero field would all change the digest and fail.

The one representation difference is normalised in the harness rather than
papered over: the vectors carry a raw `recovery_id` of `00`/`01`, while viem —
like every wallet — emits `1b`/`1c`.
