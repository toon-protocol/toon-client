/**
 * `@toon-protocol/client` — pay for an HTTP request, per request, in stablecoin.
 *
 * A **connector** is a paid reverse proxy: it fronts an ordinary HTTP app,
 * charges a flat price per route, and hands that app a request which was
 * already paid for. This package is the payer. It seals your request into an
 * ILP packet addressed to a route, attaches a signed claim on a payment channel
 * you opened yourself on chain, and gives you back the app's HTTP response.
 *
 * ```ts
 * const client = await ToonClient.create({
 *   connector: 'https://proxy.ario.devnet.toonprotocol.dev',
 *   mnemonic: process.env.TOON_MNEMONIC,
 * });
 * await client.channel.open({ deposit: 100_000n });
 * const answer = await client.send({ body: 'hello' });
 * ```
 *
 * The protocol is defined by the connector, not by this package: the Rust
 * implementation and its committed wire vectors are the authority, and this
 * client replays those vectors as its own conformance suite.
 */

// The client itself.
export * from './client/index.js';

// Talking to a connector: its self-description, identity, prices, claim state,
// and the greeting it answers an unpaid request with.
export * from './connector/index.js';

// The two carriages a packet can ride, and the port they share.
export * from './ilp/index.js';
export * from './http/index.js';
export * from './btp/index.js';

// The sealed wire: the envelope, the gift wrap around it, and the fulfilment a
// shared secret derives. Exported for callers forming packets by hand.
export * from './wire/index.js';

// Payment channels: the on-chain lifecycle, and the watermark that outlives a
// process.
export * from './channel/index.js';

// Signing a claim, on each chain.
export * from './signing/index.js';

// Keys: mnemonic derivation and the on-disk keystore.
export * from './keys/index.js';

// Chain reads and transfers that have nothing to do with paying a connector.
export * from './wallet/index.js';

// NIP-90 jobs: a signed, kind-tagged event as the body of a paid request — and
// the ArNS ceremony that spends one across a store and a gas station.
export * from './jobs/index.js';

// Well-known devnet values. Defaults and examples only — a connector's real
// settlement facts always come from its own `GET /ilp`.
export * from './presets.js';

// Conditions, retries, encodings.
export * from './utils/index.js';
