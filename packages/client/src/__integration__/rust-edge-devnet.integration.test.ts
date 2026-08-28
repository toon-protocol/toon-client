/**
 * The north-star proof, client side: a paid request through a DEPLOYED Rust
 * connector on the public devnet, driven entirely through the 1.0 public API.
 *
 * Everything the packet needs is discovered from the node itself — one
 * `GET /ilp` for the sealing key and the settlement facts, one
 * `GET /ilp/routes/price` for the price — because a connector *answers*, it
 * never announces
 * ([ADR 0022](https://github.com/toon-protocol/connector/blob/main/docs/adr/0022-a-connector-answers-it-does-not-announce.md)),
 * and a price is flat per handler (ADR 0020) so nothing local could derive one.
 * The only thing this test supplies is a funded key.
 *
 * It is the counterpart to the loopback suites: those prove the wire against a
 * connector this repo controls, and this proves it against one it does not.
 *
 * ## Running it
 *
 * **This spends real testnet USDC and real testnet gas**, so it is opt-in and
 * runs nowhere by default:
 *
 * ```bash
 * RUST_EDGE_DEVNET=1 \
 * TOON_MNEMONIC="…twelve words…" \
 * npx vitest run src/__integration__/rust-edge-devnet.integration.test.ts
 * ```
 *
 * The wallet needs Base Sepolia ETH for gas and mock USDC for collateral;
 * `toon faucet` drips both. The channel is opened on the first run and
 * **adopted** on every later one — a channel's id is derived from its
 * participants (ADR 0059), so nothing needs to be remembered between runs for
 * the right channel to be found, though a `TOON_CHANNEL_STORE` path is still
 * required so the claim watermark survives: a claim must strictly advance the
 * nonce the connector has already banked (`client-edge-spec.md` §1.3 step 2),
 * and a forgotten watermark refuses every later claim.
 *
 * Overrides: `TOON_CONNECTOR`, `TOON_DESTINATION`, `TOON_CHAIN`,
 * `TOON_RPC_URL`, `TOON_TRANSPORT`, `TOON_CHANNEL_STORE`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToonClient } from '../client/ToonClient.js';
import { DEVNET } from '../presets.js';
import type { ChainKind, TransportPreference } from '../client/types.js';

const ENABLED = process.env['RUST_EDGE_DEVNET'] === '1';
const MNEMONIC = process.env['TOON_MNEMONIC'];

const CONNECTOR = process.env['TOON_CONNECTOR'] ?? DEVNET.store.url;
const DESTINATION = process.env['TOON_DESTINATION'] ?? DEVNET.store.route;
const CHAIN = process.env['TOON_CHAIN'] as ChainKind | undefined;
const TRANSPORT = process.env['TOON_TRANSPORT'] as TransportPreference | undefined;
const RPC_URL = process.env['TOON_RPC_URL'];
/**
 * Where the claim watermark goes.
 *
 * A temp store is enough for ONE run: persisting matters because a later
 * process must resume the watermark, and a run that opens its own channel has
 * nothing to resume. A repeated run against a live channel needs a real path,
 * which is what `TOON_CHANNEL_STORE` is for. Resolved lazily so a skipped run
 * creates no directory.
 */
function channelStorePath(): string {
  return (
    process.env['TOON_CHANNEL_STORE'] ??
    join(mkdtempSync(join(tmpdir(), 'toon-devnet-')), 'channels.json')
  );
}

const maybe = ENABLED && MNEMONIC ? describe : describe.skip;

let client: ToonClient | undefined;

afterAll(async () => {
  await client?.close();
});

maybe('a paid request through the deployed Rust connector (devnet)', () => {
  it('describes the node, pays for a request, and reads the sealed answer', async () => {
    client = await ToonClient.create({
      connector: CONNECTOR,
      mnemonic: MNEMONIC,
      channelStore: channelStorePath(),
      ...(CHAIN ? { chain: CHAIN } : {}),
      ...(TRANSPORT ? { transport: TRANSPORT } : {}),
      ...(RPC_URL ? { rpcUrl: RPC_URL } : {}),
      deposit: 100_000n,
      timeoutMs: 60_000,
    });

    // (1) One free GET is the whole of bootstrapping.
    const description = await client.describe();
    expect(description.ilpAddresses.length).toBeGreaterThan(0);
    // Without a sealing key a packet cannot be formed at all
    // (`self-description-spec.md` ND-06).
    expect(description.edgeIdentity?.publicKey).toMatch(/^0x04[0-9a-fA-F]{128}$/);
    expect(description.settlements.length).toBeGreaterThan(0);

    // (2) The price is ASKED for.
    const price = await client.price(DESTINATION);
    expect(price).not.toBeNull();
    expect(price!).toBeGreaterThan(0n);

    // (3) Open, or adopt what is already open. Costs gas the first time and
    // nothing thereafter.
    const opened = await client.channel.open({ deposit: 100_000n });
    expect(opened.status).toBe('open');
    expect(opened.domain.chain).toBe(description.settlements[0]?.chain);
    expect(opened.depositTotal).toBeGreaterThanOrEqual(price!);

    // (4) The paid request itself: sealed payload, signed claim, one packet.
    const answer = await client.send(DESTINATION, {
      headers: { 'content-type': 'text/plain' },
      body: `toon-client 1.0 devnet proof ${new Date().toISOString()}`,
    });

    if (!answer.fulfilled) {
      throw new Error(
        `refused by ${answer.refusedBy}: ${answer.code} — ${answer.message}` +
          (answer.accumulatedCost !== undefined
            ? ` (path cost ${answer.accumulatedCost.toString()})`
            : '')
      );
    }
    expect(answer.status).toBeGreaterThanOrEqual(200);
    expect(answer.status).toBeLessThan(400);
    // The fulfilment is proof the packet reached the receiver it was sealed to.
    expect(answer.fulfillment).toHaveLength(32);
    // A paid route always reports its claim; only a route priced at zero omits
    // one, and this suite deliberately buys a priced route.
    const claim = answer.claim;
    expect(claim).toBeDefined();
    if (claim === undefined) throw new Error('a paid send reported no claim');
    expect(claim.amount).toBe(price);
    expect(claim.nonce).toBeGreaterThan(0);

    // (5) The local watermark advanced by exactly what was paid.
    const after = await client.channel.state();
    expect(after.spent).toBe(claim.cumulative);
    expect(after.nonce).toBe(claim.nonce);
    expect(after.available).toBe(after.depositTotal - after.spent);

    // (6) …and the CONNECTOR's own watermark agrees with ours. This is the
    // assertion the whole suite exists for: two independent records of one
    // channel, reconciled over the wire rather than assumed.
    const [state] = await client.claimState([claim.channelId]);
    expect(state).toBeDefined();
    if (state?.ok === true) {
      expect(BigInt(state.cumulativeClaimed)).toBe(claim.cumulative);
      expect(state.nonce).toBe(claim.nonce);
    }
  }, 300_000);

  it('charges the same for a second request, and the nonce strictly advances', async () => {
    expect(client).toBeDefined();
    const before = await client!.channel.state();
    const answer = await client!.send(DESTINATION, { body: 'second' });

    if (!answer.fulfilled) {
      throw new Error(`refused: ${answer.code} — ${answer.message}`);
    }
    const claim = answer.claim;
    if (claim === undefined) throw new Error('a paid send reported no claim');
    expect(claim.nonce).toBe(before.nonce + 1);
    expect(claim.cumulative).toBe(before.spent + claim.amount);
  }, 300_000);

  it('answers null for a destination this node does not terminate', async () => {
    expect(client).toBeDefined();
    await expect(client!.price('g.nowhere.at.all')).resolves.toBeNull();
  }, 60_000);
});
