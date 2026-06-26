# toon-* MCP tool reference

Each MCP tool maps to one `toon-clientd` daemon control-plane call. The daemon
owns the BTP session, payment channels, signer keys, and the persistent relay
subscriptions; the MCP server is a stateless proxy that auto-spawns the daemon
and holds no keys.

**Paid (SPENDY)** tools spend real value from a payment channel:
`toon_publish`, `toon_publish_unsigned`, `toon_upload_media`, `toon_swap`, and
`toon_http_fetch_paid` (only when the remote returns 402). Everything else is
free.

## Status & identity

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_status` | Daemon health: bootstrapping/ready, transport, relay connection, buffered-event count, per-chain settlement. | — | free |
| `toon_identity` | Public identity only: Nostr pubkey + EVM/Solana/Mina addresses. Never returns private keys. | — | free |

## Writes (pay-to-write)

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_publish` | Publish a **fully-signed** Nostr event; signs a payment-channel claim and forwards over BTP. | `event` (required), `destination?`, `fee?`, `btpUrl?` | **paid** |
| `toon_publish_unsigned` | Publish without holding a key: supply the event shell; the daemon signs it (merging latest tags for replaceable kinds 0/3). The path UI atoms use. | `kind` (required), `content?`, `tags?`, `destination?`, `fee?`, `btpUrl?` | **paid** |
| `toon_upload_media` | Two-step media write: upload base64 bytes to Arweave via the kind:5094 DVM, then publish a media event referencing the URL (default kind 1063; 20 picture, 21/22 video, 1 note+imeta). Single-packet. | `dataBase64` (required), `mime?`, `kind?`, `caption?`, `tags?`, `fee?`, `btpUrl?` | **paid** |

## Reads (free)

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_query` | One-shot structured read: resolve a NIP-01 filter to its current matches (subscribe, brief wait, return). Used to fill ViewSpec data binds. | `filter` (required), `timeoutMs?` | free |
| `toon_subscribe` | Register a persistent NIP-01 subscription. Omit `relayUrl` to fan out across all registered relays. | `filters` (required), `subId?`, `relayUrl?` | free |
| `toon_read` | Drain buffered events newer than a cursor; pass the returned cursor back to long-poll only new events. | `subId?`, `cursor?`, `limit?`, `relayUrl?` | free |

## Rendering (free to render; atom writes are paid)

Rendering is the **default surface for display requests** (see/show/open/view/
browse a feed, profile, channels, balances, swap): call `toon_atoms` then
`toon_render` — do not reply with a text list unless the user asks for text or
the host can't render.

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_atoms` | List the atom vocabulary (ids, kinds rendered, props, write actions) + example ViewSpecs. Call first to compose a view. | — | free |
| `toon_render` | Render an agent-authored ViewSpec as the in-host UI (`ui://toon/app`). The spec is validated against the atom/write allowlist. | `spec` (required: `{ title?, root }`) | free (the writes its atoms fire are paid) |

## Channels & swaps

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_open_channel` | Open (or return the existing) payment channel for a destination. Channels open lazily on first publish. | `destination?` | free |
| `toon_channels` | List tracked channels with nonce watermark + cumulative transferred amount. | — | free |
| `toon_swap` | Pay a swap peer asset A for asset B + a signed target-chain claim (NIP-59 gift-wrapped kind:20032). | `destination`, `amount`, `swapPubkey`, `pair`, `chainRecipient` (required), `packetCount?` | **paid** |

## Paid HTTP & funding

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_http_fetch_paid` | Fetch a paid resource; on 402 transparently pay over TOON and retry. Returns `{ status, headers, body }`. | `url` (required), `method?`, `headers?`, `body?`, `timeout?` | paid (only when 402) |
| `toon_fund_wallet` | Drip devnet test funds (native + USDC) to a wallet; with no args funds this client's own address on the active chain. | `chain?` (`evm`/`solana`/`mina`), `address?` | free (devnet faucet) |

## Targets (relays & apexes)

| Tool | Purpose | Key params | Paid? |
|---|---|---|---|
| `toon_targets` | List every registered relay (read source) and apex (BTP write target) with status. | — | free |
| `toon_add_relay` | Add a relay read target at runtime (persisted); joins fan-out reads immediately. | `relayUrl` (required) | free |
| `toon_remove_relay` | Remove a relay read target (persisted). Cannot remove the config-seeded default. | `relayUrl` (required) | free |
| `toon_add_apex` | Add an apex write target; settlement params are **discovered** from the apex's kind:10032 off the given relay. | `ilpAddress`, `relayUrl` (required), `pubkey?`, `chain?`, `childPeers?`, `feePerEvent?` | free |
| `toon_remove_apex` | Remove an apex write target by BTP URL (persisted). Cannot remove the config-seeded default. | `btpUrl` (required) | free |

## ViewSpec grammar (toon_render)

A ViewSpec is `{ title?, root: ViewNode }`. A `ViewNode` is
`{ atom, props?, children?, bind?, actions? }`:

- `atom` — an id from `toon_atoms` (see the catalog: layout `stack`/`section`/
  `card`/`tabs`; social `profile-header`/`note-card`/`reaction-bar`/
  `follow-button`/`composer`/`pay-confirm`; media `media-embed`/`media-uploader`;
  forge `repo-card`/`issue-card`/`pr-card`/`comment-thread`; defi `channel-card`/
  `swap-form`/`settlement-receipt`; onboard `onboard-card`; fallback
  `generic-event`).
- `bind` — `{ query: <NIP-01 filter>, kindAuto?: boolean }` for free reads
  (resolved via `toon_query`). `kindAuto` routes each bound event through its
  default atom.
- `actions` — map a named action to a write tool, e.g.
  `{ post: { tool: "toon_publish_unsigned", args: { kind: 1 } } }`. SPENDY
  actions (e.g. `media-uploader`, `swap-form`) spend real value when fired.

## The render trust gradient (toon_render / unknown kinds)

`toon_render` paints agent-authored ViewSpecs. For *incoming* events the client
applies the render trust gradient (see the `nip-on-toon-discovery` spec):

1. **Known kind** → native atom, full trust.
2. **Unknown kind** → resolve the event's `ui` tag to an addressable
   `kind:31036` renderer authored by the event author (`d` = target kind);
   re-verify its signature. The renderer's `m` (mimeType) tag selects the branch:
   `application/a2ui+json` → branch 2 (A2UI, medium trust),
   `text/html;profile=mcp-app` → branch 3 (sandboxed mcp-ui, low trust).
3. **No renderer** → branch 4 (model-generated fallback, low trust); the client
   may publish the result back as a `kind:31036` so the next client knows it.

A swap-defense guard fails closed to the safe branch on author/signature/trust
violations. A sandboxed widget may only *request* an action; the authorization
surface is always rendered by the trusted host outside the iframe.

## Read cursor semantics

`toon_read` returns events newer than `cursor` plus a new `cursor`. Long-poll by
passing the returned `cursor` back — you only ever see each event once. Omit
`subId` to drain across all subscriptions. The daemon de-duplicates by
`event.id` and decodes TOON-encoded relay payloads into standard Nostr events.

## Settlement chain selection

A single daemon settles to the apex on one chain (`settlementChain` in
`toon_status`). The active chain is chosen by daemon config (`chain`, or the
`TOON_CLIENT_CHAIN` env). For simultaneous multi-chain, run one daemon per chain
on a distinct port + channel store.

## Bootstrapping

The first call after a cold start can return a "still bootstrapping — retry
shortly" message while the managed anon proxy + BTP session come up (~30–90s).
Poll `toon_status` until `ready: true` before paid writes. Free reads
(`toon_query`/`toon_subscribe`/`toon_read`) work as soon as the relay connects,
independent of the paid-write path.
