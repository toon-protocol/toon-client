---
'@toon-protocol/client': minor
---

**A metered route is now paid correctly — `send()` never under-pays a `pricePerKib` again.**

The self-description parser read each route as `{ prefix, price }` and dropped the `pricePerKib`
the connectors publish beside it. So `price()` answered the base price, `send()` signed a claim for
it, and the connector refused: `F03 — advances value by 1000, less than this route's price of 1010`.
On the public devnet that made `g.toon.store` and `g.toon.relay.store` unusable through the
documented one-liner — the route in every example was also wrong (see below), so the first paid
request a reader could copy failed twice over.

The rate is now read from both places it appears — `pricePerKib` in `GET /ilp`, `price_per_kib` in
`GET /ilp/routes/price` — and applied by a single exported rule:

```ts
chargeFor(terms, sealedBytes) // price + pricePerKib × (⌊bytes / 1024⌋ + 1)
```

Two details that are easy to get wrong and are now pinned by tests: the metered quantity is the
**sealed** payload, not the caller's request body, and kibibytes are counted from one rather than
rounded up from zero, so the smallest possible packet already costs one unit. Because the charge
depends on the sealed size, `send()` now **seals before it prices** — steps 3 and 4 of the pipeline
are swapped, and the ordering is documented as the contract it is.

A forwarded route that the attached node prices — `g.toon.relay.store`, `g.toon.relay.gas` — no
longer needs an explicit `amount` at all. It still needs `sealTo`.

New and changed API:

- `chargeFor(terms, sealedBytes)`, `routeFor(desc, destination)` and the `RouteCharge` type are
  exported from the package root.
- `RoutePrice` and `ConnectorRoutePrice` carry an optional `pricePerKib`.
- `ToonClient.routePrice(destination)` returns a route's full terms. `ToonClient.price()` is
  unchanged and still answers the base price alone — it is now documented as the base rather than
  the total.
- `toon price` prints the per-KiB rate beside the base price on a metered route.
- `defaultDestinationFor(desc)` is exported, and `ToonClient.defaultDestination` exposes it.
- `send()` gains an overload taking only a request; `toon send`'s destination becomes optional.
- **Breaking, for implementers of the `SendContext` port only:** `price(destination)` is replaced by
  `routePrice(destination)`, returning the whole terms instead of one figure. Nothing that uses
  `ToonClient` is affected.

**A connector URL is now the whole of the configuration.**

`send()`'s destination is optional. Omitted, the packet goes to `defaultDestination` — the first
address the node published for itself in `GET /ilp` that it also prices — so nothing has to repeat
a route string it just read off the node:

```ts
const client = await ToonClient.create({ connector: 'https://…', mnemonic });
await client.send({ body: 'hello' });           // the node's own address
await client.send('g.toon.relay.store', { … }); // or name a forwarded route
```

`toon send` takes the destination as an optional positional for the same reason, so
`TOON_CONNECTOR` alone is enough to buy something. Naming a destination is still how you address a
route a node *forwards* rather than terminates, since that route is by definition not its own
address. A node that publishes no `ilpAddresses` at all is a `ConfigError` rather than a guess.

**The devnet presets and docs now match what is deployed.** Verified by paying every route on the
live nodes.

- `DEVNET.store.route` was `g.toon.ario`, which no node serves — every node answers it `404`. It is
  `g.toon.store`, and it meters at 10/KiB. The same dead route was in the README, `docs/`, the
  package README and the `src/index.ts` example.
- `DEVNET.gas` is new: the gas station at `proxy.gas.devnet.toonprotocol.dev` (`g.toon.gas`) was
  missing from the presets and the devnet reference entirely.
- `DEVNET.ephemeral` is new, for the relay's zero-priced lane.
- `DEVNET.evm.tokenNetwork`, `DEVNET.evm.tokenNetworkRegistry` and `DEVNET.solana.tokenAddress` were
  all stale.
- `docs/devnet.md` claimed no route was carriage-pinned; `g.toon.relay` is pinned to BTP. It also
  claimed the faucet tops up ETH for gas, which is disabled — neither faucet leg funds gas.

These are conveniences only: a client still reads every settlement fact it pays against from the
node's own `GET /ilp`, never from a preset.
