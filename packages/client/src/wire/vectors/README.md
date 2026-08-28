# Vendored wire vectors

`wire-vectors.json` is a **verbatim copy** of `vectors/wire-vectors.json` on
[`toon-protocol/connector`](https://github.com/toon-protocol/connector) `main`.
It is generated there (`cargo run -p connector-vectors --bin generate-vectors`),
never hand-written, and it is the cross-repo contract for the client-edge
termination wire ([connector ADR
0021](https://github.com/toon-protocol/connector/blob/main/docs/adr/0021-vectors-are-normative-prose-is-not.md)):
reproducing these bytes is what conformance means for this client.

`wire-vectors.provenance.json` records the connector commit it came from, where
those bytes were read from (`source`: a GitHub ref or a local checkout), and the
SHA-256 of the copy. `src/wire/wire-vectors.test.ts` replays **all six**
sections: `envelope` against `src/wire/envelope.ts`, `giftwrap` and `fulfilment`
against `src/wire/giftwrap.ts`, `claim` and `channel_control_declaration`
against `src/signing/evm-signer.ts`, and `peer_carriage` against
`src/btp/protocol.ts` and `src/channel/solana/payment-channel.ts` — the last in
part, for the reason set out below.

## Why vendored, and not fetched or submoduled

A vendored copy that can drift silently is the worst option, so this one cannot:

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Integrity** | `wire-vectors.test.ts` hashes the vendored file every run and fails if it does not match `provenance.sha256`. Hand-editing the copy to make a failing replay pass is therefore not possible without also editing the provenance, which shows up in review as exactly what it is.                                                                                                                                                                                                                                                                                         |
| **Drift**     | `pnpm --filter @toon-protocol/client vectors:check` fetches the connector's current `main` copy and fails if it differs, printing both SHA-256s. `.github/workflows/wire-vectors-drift.yml` runs it daily (06:17 UTC), on `workflow_dispatch`, and on any PR touching `src/wire/**`, `scripts/refresh-wire-vectors.mjs` or the workflow itself. It installs nothing (node builtins + global `fetch` only), so it is a ~10s job. **A red drift job is not a broken build** — it means the wire moved and this client has not adopted it yet; the fix is a refresh, below. |
| **Refresh**   | `pnpm --filter @toon-protocol/client vectors:refresh` rewrites both files from connector `main` (or `--ref <sha>`, or `--from-local <checkout>`). The diff it produces is the wire change.                                                                                                                                                                                                                                                                                                                                                                                                             |

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

Run `vectors:refresh` when — and only when — you are **deliberately adopting a wire
change**: the drift job has gone red, or you are landing a client change against a
connector commit that moved these bytes. It is never a fix for a failing replay on
its own; it is the act of accepting a new contract, and the diff it produces _is_ the
wire change, so it belongs in a commit of its own with that framing.

```sh
# Adopt connector main:
pnpm --filter @toon-protocol/client vectors:refresh
# Or pin an exact connector commit:
pnpm --filter @toon-protocol/client vectors:refresh -- --ref <connector-sha>
# Or adopt a LOCAL connector checkout (bytes not pushed yet):
pnpm --filter @toon-protocol/client vectors:refresh -- --from-local /path/to/connector
```

### `--from-local`

A wire change lands in a working connector checkout before it reaches `main`.
Fetching from GitHub at that moment vendors the **wrong bytes** and records a
commit that does not contain them — provenance that reads as verified and is
not. `--from-local <checkout>` reads `<checkout>/vectors/wire-vectors.json` off
disk and takes the commit, date and subject from that checkout's own
`git rev-parse HEAD` / `git log -1`, recording `"source": "local"`.

It **refuses** — exit 2, nothing written — when that checkout has uncommitted
changes to the vector file, because a vendored copy has to be attributable to a
state someone else can check out. `--check` works the same way against a local
checkout, so you can see the drift before adopting it. The provenance's `dirty`
field is therefore always `false`, and the harness asserts it: a `true` could
only have been typed in by hand.

Then run `pnpm --filter @toon-protocol/client test`. A failing replay after a
refresh means the wire changed and this client has not caught up — that is the
signal, not a flake. Commit `wire-vectors.json` and
`wire-vectors.provenance.json` together.

## Sections

`schema_version` is `4`. The file carries six sections and this repo replays
**all six**:

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
- `peer_carriage` — **replayed in part** (connector#758). See below.
- `channel_control_declaration` — **replayed** (connector#795 added it, toon-
  client#540): the BTP auth greeting's `channelId`/`expires`/`signature`
  declaration, replayed against `src/signing/evm-signer.ts`. See below.

`loadWireVectors()` in `load.ts` exposes all six, so adding a section to the
harness is a new `describe` block, not a restructure — which is exactly how
`giftwrap`, `fulfilment`, `channel_control_declaration` and `peer_carriage`
arrived. The labels are enforced, not decorative: `WIRE_VECTOR_SECTIONS` in
`load.ts` is a closed list, the harness fails if the vendored file carries a
section that is not in it or one that is in neither provenance list, and inside
`peer_carriage` the same rule applies per item via `PEER_ONLY_ITEMS`. A section
— or a peer-carriage item — the connector adds therefore breaks the build until
someone decides, in writing, what this repo does with it.

### Schema history

`schema_version` bumps only when a field's meaning changes under an SDK.

|     |                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2` | `peer_carriage.claim_solana.programId` names the real settlement program, not the system program (connector#1127) — a version-1 reading of that field builds a non-conforming claim.                                                    |
| `3` | Minimum delivery retired (connector#1143, ADR 0057): `minimum_delivery_absent`/`_malformed` deleted, and the `toon-minimum-delivery` entry and header gone from both carriages.                                                          |
| `4` | The `{peerId, secret}` peer credential deleted (connector#1157, ADR 0060): `peer_carriage.credential` is gone from both carriages. Peer role is decided by the covering claim's signature instead, which every peer frame already carried. |

### Why `peer_carriage` is replayed, and only in part

It was carried-but-skipped for two schema versions, on the grounds that the
connector-to-connector peer wire is not something a client SDK speaks. That is
still true of most of it — claim-ack carriage, flush, retransmission semantics —
and those items are named in `PEER_ONLY_ITEMS` in `wire-vectors.test.ts`.

But the **OER ILP packet lives inside these fixtures**, and it is not peer-only
at all: it is the same PREPARE/FULFILL/REJECT the client edge sends and
receives, in TOON's own dialect ([connector ADR
0063](https://github.com/toon-protocol/connector/blob/main/docs/adr/0063-the-ilp-packet-is-toons-dialect-not-rfc-0027s.md)
— a VarUInt amount and a 19-byte GeneralizedTime, not RFC 0027's fixed fields).
The connector's own `vectors/README.md` is explicit: "There is no separate
top-level `packet` section: replay these." So this repo does, against
`src/btp/protocol.ts`:

- `prepare.http_body_hex` decodes to `prepare.prepare`'s declared values **and**
  re-encodes to exactly those bytes — both directions, so a decoder that merely
  tolerated a non-canonical length would fail the second half.
- `prepare.btp_message_hex` parses to a BTP MESSAGE carrying the identical OER
  packet plus one `payment-channel-claim` entry whose raw UTF-8 is `claim_json`
  — and the HTTP header carries base64 of those same bytes, not a second
  serialization.
- `prepare_no_claim` carries byte-identical packet bytes with the claim removed.
- `fulfill_ack_accepted.packet_hex` and `reject_with_cost.packet_hex` likewise,
  including that `accumulated_cost` is **not** in the REJECT's bytes — it rides
  beside the packet (connector ADR 0011).
- `forwarded_data_unchanged.sealed_data_hex` — one of this file's own giftwrap
  request wraps — appears byte-for-byte as the PREPARE's `data` on both
  carriages.

And `claim_solana.signed_message_hex` is the 96-byte balance proof of
[connector ADR
0053](https://github.com/toon-protocol/connector/blob/main/docs/adr/0053-a-solana-claim-binds-its-domain-the-way-an-evm-claim-does.md),
which is exactly what `src/channel/solana/payment-channel.ts`'s
`buildBalanceProofMessage` produces for this client's own Solana claims — so it
is replayed against that, including that bytes 16..48 are the claim's declared
`programId`. That is the binding which stops a proof signed for one deployment
being redeemed at another; before ADR 0053 the message was 48 bytes and bound
nothing about which chain the channel lived on. Both claims' JSON key sets are
also checked against what `EvmSigner`/`SolanaSigner.buildClaimMessage` emit,
since the connector reads a claim field by field, and a missing or invented
field is refused structurally before any signature is looked at.

### Why `claim` is replayed here

The connector moved its _peer_ wire onto EIP-712 `BalanceProof` in ADR 0024;
this client does not sign peer-wire claims, so it would have been defensible to
carry the section and skip it. It is replayed anyway because this client already
signs **exactly that struct** on the _client edge_:
`EvmSigner.signBalanceProof` uses a `TokenNetwork`/`1` domain with a per-channel
`chainId`/`verifyingContract` and the same five-field `BalanceProof` with
zeroed `lockedAmount`/`locksRoot`. It reproduces the published `digest_hex` and
the published 65-byte signature byte-for-byte, so these vectors are real
conformance evidence here — a drifted domain field, a reordered struct member or
a dropped zero field would all change the digest and fail.

The one representation difference is normalised in the harness rather than
papered over: the vectors carry a raw `recovery_id` of `00`/`01`, while viem —
like every wallet — emits `1b`/`1c`.

### Why `channel_control_declaration` is replayed here

This is the client-edge wire, not the peer wire: it is the BTP auth entry a
**client** sends to declare which channel
it controls, and `btp/IsomorphicBtpClient.ts` already sends exactly this
declaration on every `connect()`/`reauthenticate()` (toon-client#513). The
signature is produced by `EvmSigner.signClaimStateChallenge`, under the same
`TokenNetwork`/`1` domain as `claim` but a distinct
`ClaimStateChallenge(bytes32 channelId,uint256 expires)` typehash — so a
captured declaration and a captured claim can never stand in for each other.
The vectors' `digest_hex` and 65-byte `signature_hex` are reproduced
byte-for-byte from the published fields and fixture secret, using the same
`00`/`01` → `1b`/`1c` recovery-id normalisation as `claim`.

Not replayed: `auth_json`/`btp_message_hex`, which pin one example JSON
serialization of the auth entry — the connector's own, key-alphabetised by
`serde_json`. This client's greeting is a different but equally valid
encoding of it: `IsomorphicBtpClient.authenticate()` orders keys by insertion
and spreads a `blockchain` tag in beside them, because its
`BtpChannelDeclaration` covers the Solana shape too. Neither difference is
observable to the verifier — the connector reads the entry field-by-field off
a `serde_json::Value` (`connector-client-edge/src/btp.rs`'s
`auth_channel_proof`), so what the contract fixes is which fields are present
and what the EIP-712 digest and signature over them are, which is exactly
what is replayed above.

Also not replayed: the `expires` wall-clock check — that is the verifier's
(the connector's) job, not the declarer's; `channel_control_declaration_expired`
carries a genuinely-verifying signature for exactly this reason (see the
vectors' own `signature_verifies`).
