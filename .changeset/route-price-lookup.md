---
'@toon-protocol/client': major
'@toon-protocol/rig': major
'@toon-protocol/client-mcp': minor
---

Stop computing a per-byte price; ask for the route's price (#452).

ADR 0020 makes a price flat per handler: one handler, one price, and an app
that wants to charge differently exposes more handlers. Byte-proportional
pricing has no successor — the route table is the price list. A 100-byte and a
100 KB write to the same handler now cost the same, and the connector charges
accordingly regardless of what a client computes.

Four independent `10n` rates existed, each with a comment asserting it matched
the others. All four are gone, not centralised:

- `ToonClient.publishEvent`'s `basePricePerByte`, along with the TOON encoding
  produced only to be measured.
- `modes/http.ts`'s `basePricePerByte` bootstrap option.
- `client-runner.ts`'s `UPLOAD_FEE_PER_BYTE`.
- `StandalonePublisher`'s `uploadFeePerByte`.

A packet's amount now comes from `GET /ilp/routes/price?destination=` at the
terminating connector — the same longest-prefix lookup the claim gate charges
against, so it can never state a price a real request would not be charged.
Prices are cached per (endpoint, destination) by `ConnectorEdgeClient`, so this
is one round trip per destination rather than one per packet.

**Breaking — `@toon-protocol/client`**

- `publishEvent` fetches a price when `options.ilpAmount` is omitted. An
  explicit `ilpAmount` still overrides and skips the lookup entirely.
- A destination the connector terminates no route for now raises
  `NO_TERMINATED_ROUTE` before any packet is formed, rather than being priced
  at zero or at a local fallback.
- New: `ToonClient.getRoutePrice(destination)`, and
  `ConnectorEdgeClient.invalidateRoutePrice` / `hasCachedRoutePrice`.

**Breaking — `@toon-protocol/rig`**

- `FeeRates.uploadFeePerByte` and `FeeRates.minUploadFee` are replaced by a
  single flat `FeeRates.uploadFee`. With a flat price there is no floor to
  apply, because the route's price is the whole fee rather than a lower bound
  on one.
- `flooredUploadFee` is removed from the published surface.
- `StandalonePublisher`'s `uploadFeePerByte` constructor option is removed;
  `routePrices.store` is the upload fee. With no announced store price the
  publisher quotes 0 and lets the connector refuse, rather than inventing a
  rate.

The standalone `toon-protocol/rig` repository carries its own copy of
`standalone-publisher.ts` and pins the published client, so it needs the same
removal and its own release.

Note: `@toon-protocol/core`'s `BootstrapService` retains an internal
`basePricePerByte` default for its own bootstrap/discovery pricing surface.
That is a separate package and a separate concern; nothing in this repository
states a per-byte rate any more.
