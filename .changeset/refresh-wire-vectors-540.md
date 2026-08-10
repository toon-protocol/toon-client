---
'@toon-protocol/client': patch
---

Refresh the vendored wire vectors to `toon-protocol/connector@33f10e2a00be` (issue #540), closing two days of drift that failed every PR's `Vendored vectors match connector main` check regardless of what the PR touched.

- The connector added two sections since the last vendored commit (`425a8abb`): `peer_carriage` (connector#758, the connector-to-connector peer wire) and `channel_control_declaration` (connector#795, the BTP auth greeting's `channelId`/`expires`/`signature` declaration).
- `channel_control_declaration` is now replayed against `EvmSigner.signClaimStateChallenge` — this client already signs exactly this EIP-712 `ClaimStateChallenge` struct and sends the declaration on every `connect()`/`reauthenticate()` (toon-client#513), so the vectors are real conformance evidence here, same reasoning as why `claim` is replayed.
- `peer_carriage` is carried but deliberately **not** replayed: it is the wire between two connectors, which this client never speaks. Declared in `wire-vectors.provenance.json`'s `sectionsPresentNotYetReplayed` rather than silently dropped from the loader's schema — see `packages/client/src/wire/vectors/README.md` for the full reasoning.
- `.github/workflows/wire-vectors-drift.yml`'s daily scheduled run now files-or-updates a tracking issue on drift (idempotent via a hidden marker) instead of only going red with nobody watching, and closes it again once a refresh lands.
