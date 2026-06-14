# toon-* MCP tool reference

Each MCP tool maps to one `toon-clientd` daemon control-plane endpoint. The
daemon owns the BTP session, payment channels, signer keys, and the persistent
town-relay subscription; the MCP server is a stateless proxy that auto-spawns the
daemon and holds no keys.

| MCP tool | Daemon endpoint | Arguments | Returns |
|---|---|---|---|
| `toon_status` | `GET /status` | — | `{ ready, bootstrapping, settlementChain, identity, transport, relay, network[], lastError? }` |
| `toon_identity` | `GET /status` (projected) | — | `{ identity, ready, bootstrapping }` |
| `toon_publish` | `POST /publish` | `{ event, destination?, fee? }` | `{ eventId, channelId, nonce, data? }` |
| `toon_subscribe` | `POST /subscribe` | `{ filters, subId? }` | `{ subId }` |
| `toon_read` | `GET /events` | `{ subId?, cursor?, limit? }` | `{ events[], cursor, hasMore }` |
| `toon_open_channel` | `POST /channels` | `{ destination? }` | `{ channelId }` |
| `toon_channels` | `GET /channels` | — | `{ channels: [{ channelId, nonce, cumulativeAmount }] }` |
| `toon_swap` | `POST /swap` | `{ destination, amount, toonData? }` | `{ accepted, data?, code?, message? }` |

## Read cursor semantics

`toon_read` returns events newer than `cursor` plus a new `cursor`. Long-poll by
passing the returned `cursor` back on the next call — you only ever see each
event once. Omit `subId` to drain across all subscriptions. The daemon
de-duplicates by `event.id` and decodes the relay's TOON-encoded event payloads
into standard Nostr event objects.

## Settlement chain selection

A single daemon settles to the apex on one chain (`settlementChain` in
`toon_status`). The active chain is chosen by daemon config (`chain`, or the
`TOON_CLIENT_CHAIN` env). For simultaneous multi-chain, run one daemon per chain
on a distinct port + channel store.

## Bootstrapping

The first call after a cold start can return a "still bootstrapping — retry
shortly" message while the managed anon proxy + BTP session come up (~30–90s).
Poll `toon_status` until `ready: true` before paid writes. Free reads
(`toon_subscribe`/`toon_read`) work as soon as the relay connects, independent of
the paid-write path.
