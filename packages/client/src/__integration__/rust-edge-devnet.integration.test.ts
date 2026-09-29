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
 * **This spends real testnet USDC**, so it is opt-in and runs nowhere by
 * default:
 *
 * ```bash
 * RUST_EDGE_DEVNET=1 \
 * TOON_MNEMONIC="…twelve words…" \
 * npx vitest run src/__integration__/rust-edge-devnet.integration.test.ts
 * ```
 *
 * The wallet needs devnet USDC for the deposit and no gas: on Base the deposit
 * is relayed by the devnet's x402 facilitator, on Solana the connector
 * sponsors the open (connector ADRs 0074, 0075). `toon faucet` drips the USDC.
 * The channel is opened on the first run and resumed on later ones from
 * `TOON_CHANNEL_STORE`: an x402 channel's config is not recoverable from the
 * chain, so a run without the store opens a fresh one.
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
 * process must resume the channel and its watermark, and a run that opens its
 * own channel has nothing to resume. A repeated run against a live channel needs a real path,
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
    expect(description.batchSettlements.length).toBeGreaterThan(0);

    // (2) The price is ASKED for.
    const price = await client.price(DESTINATION);
    expect(price).not.toBeNull();
    expect(price!).toBeGreaterThan(0n);

    // (3) Open, or resume what is already open. Costs a deposit the first time
    // and nothing thereafter, and no gas either way.
    const opened = await client.channel.open();
    expect(description.batchSettlements.map((t) => t.network)).toContain(
      opened.channel.network
    );
    expect(opened.depositTotal).toBeGreaterThanOrEqual(price!);

    // (4) The paid request itself: sealed payload, signed voucher, one packet.
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
    expect(claim.channelId).toBe(opened.channel.channelId);

    // (5) The local watermark advanced by exactly what was paid.
    const after = await client.channel.current();
    expect(after?.signed).toBe(claim.cumulative);

    // (6) …and the CONNECTOR's own watermark agrees with ours. This is the
    // assertion the whole suite exists for: two independent records of one
    // channel, reconciled over the wire rather than assumed.
    const [state] = await client.claimState([claim.channelId]);
    expect(state).toBeDefined();
    expect(state?.ok).toBe(true);
    if (state?.ok === true) {
      expect(BigInt(state.cumulativeClaimed)).toBe(claim.cumulative);
    }
  }, 300_000);

  it('charges the same for a second request, and the voucher strictly advances', async () => {
    expect(client).toBeDefined();
    const before = await client!.channel.current();
    if (before === undefined) throw new Error('no channel after a paid send');
    const answer = await client!.send(DESTINATION, { body: 'second' });

    if (!answer.fulfilled) {
      throw new Error(`refused: ${answer.code} — ${answer.message}`);
    }
    const claim = answer.claim;
    if (claim === undefined) throw new Error('a paid send reported no claim');
    expect(claim.cumulative).toBe(before.signed + claim.amount);
  }, 300_000);

  it('answers null for a destination this node does not terminate', async () => {
    expect(client).toBeDefined();
    await expect(client!.price('g.nowhere.at.all')).resolves.toBeNull();
  }, 60_000);
});
