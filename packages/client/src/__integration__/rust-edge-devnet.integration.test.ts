/**
 * The north-star proof, client side: a paid write through the DEPLOYED Rust
 * connector on devnet — sealed wire (ADR 0018/0019), real EIP-712 claim
 * against the real Base Sepolia TokenNetwork, real relay delivery.
 *
 * Opt-in: runs only when RUST_EDGE_E2E_BUYER_KEY is set (a funded Base
 * Sepolia key that has already opened a channel with the devnet apex's
 * settlement address on the deployed TokenNetwork). Everything else is
 * discovered from the edge itself — identity and price are ASKED for, per
 * ADR 0020/0022, never assumed.
 *
 *   RUST_EDGE_E2E_BUYER_KEY=0x… \
 *   RUST_EDGE_E2E_CHANNEL_ID=0x… \
 *   RUST_EDGE_E2E_NONCE=1 \
 *   RUST_EDGE_E2E_CUMULATIVE=1000 \
 *   pnpm vitest run src/__integration__/rust-edge-devnet.integration.test.ts
 *
 * NONCE/CUMULATIVE exist because the claim gate's watermark is durable on
 * the box (connector #605): every run must advance past every prior run, so
 * a rerun needs a fresh (higher) nonce and cumulative amount.
 */
import { describe, it, expect } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';

import { ConnectorEdgeClient } from '../adapters/ConnectorEdgeClient.js';
import { HttpIlpClient } from '../adapters/HttpIlpClient.js';
import { sealExchange, readExchangeOutcome } from '../wire/sealed-exchange.js';
import { EvmSigner } from '../signing/evm-signer.js';

/** The full `POST /ilp` URL — `HttpIlpClient` posts to it verbatim, and
 *  `ConnectorEdgeClient` normalizes the trailing `/ilp` away for the
 *  identity and price lookups. */
const EDGE =
  process.env.RUST_EDGE_E2E_EDGE ??
  'https://proxy.devnet.toonprotocol.dev/rust/ilp';
const DESTINATION = process.env.RUST_EDGE_E2E_DESTINATION ?? 'g.toon.relay';
const CHAIN_ID = Number(process.env.RUST_EDGE_E2E_CHAIN_ID ?? 84532);
const TOKEN_NETWORK =
  process.env.RUST_EDGE_E2E_TOKEN_NETWORK ??
  '0x1E95493fEF46707E034b4a1945f25a8C76A1823D';
const TOKEN =
  process.env.RUST_EDGE_E2E_TOKEN ??
  '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
const ZERO_LOCKS_ROOT = `0x${'0'.repeat(64)}`;

const BUYER_KEY = process.env.RUST_EDGE_E2E_BUYER_KEY;
const CHANNEL_ID = process.env.RUST_EDGE_E2E_CHANNEL_ID;

const maybe = BUYER_KEY && CHANNEL_ID ? describe : describe.skip;

maybe('a paid write through the deployed Rust edge (devnet)', () => {
  it('pays for a relay write with a sealed packet and a TokenNetwork claim', async () => {
    const edgeClient = new ConnectorEdgeClient({});

    // (1) The terminating connector's key — no packet without it.
    const identity = await edgeClient.getIdentity(EDGE);
    const connectorKey = identity.publicKey;

    // (2) The price is asked for, never computed locally.
    const priced = await edgeClient.getRoutePrice(EDGE, DESTINATION);
    expect(priced).not.toBeNull();
    const price = BigInt(priced!.price);

    // The claim must advance the durable watermark past every prior run.
    const nonce = Number(process.env.RUST_EDGE_E2E_NONCE ?? 1);
    const cumulative = BigInt(
      process.env.RUST_EDGE_E2E_CUMULATIVE ?? String(price)
    );

    // (3) A real signed Nostr event for the relay.
    const nostrSecret = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', 'rust-edge-e2e']],
        content: `first paid write over the sealed wire to the Rust apex (${new Date().toISOString()})`,
      },
      nostrSecret
    );

    // (4) Seal to the connector's key; the condition is derived from the
    // secret inside the wrap, so they cannot drift apart.
    const exchange = sealExchange(
      {
        method: 'POST',
        // ADR 0025 (#596): the target is resolved STRICTLY BENEATH the
        // route's configured handler path. '' means "the handler's own
        // path" — the route already ends at /write; an absolute '/write'
        // is refused as an escape attempt (F00).
        target: '',
        headers: [['content-type', 'application/json']],
        body: new TextEncoder().encode(JSON.stringify({ event })),
      },
      connectorKey
    );

    // (5) The claim: an EIP-712 BalanceProof on the deployed TokenNetwork.
    const signer = new EvmSigner(BUYER_KEY!);
    const proof = await signer.signBalanceProof({
      channelId: CHANNEL_ID!,
      nonce,
      transferredAmount: cumulative,
      lockedAmount: 0n,
      locksRoot: ZERO_LOCKS_ROOT,
      chainId: CHAIN_ID,
      tokenNetworkAddress: TOKEN_NETWORK,
      tokenAddress: TOKEN,
    });
    const claim = EvmSigner.buildClaimMessage(proof, getPublicKey(nostrSecret));

    // (6) One POST /ilp: PREPARE + claim header.
    const transport = new HttpIlpClient({ httpEndpoint: EDGE });
    const result = await transport.sendIlpPacketWithClaim(
      {
        destination: DESTINATION,
        amount: String(price),
        data: Buffer.from(exchange.data).toString('base64'),
        executionCondition: exchange.condition,
      },
      claim
    );

    // (7) Open the answer with the sealed secret.
    const outcome = readExchangeOutcome(
      result,
      result.data === undefined
        ? undefined
        : Uint8Array.from(Buffer.from(result.data, 'base64')),
      exchange.sharedSecret
    );

    // Surface the whole outcome on failure — the reject code is the
    // diagnosis (F03 underpaid, F01 unknown channel, T00 not durable…).
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      kind: 'answered',
    });
    if (outcome.kind === 'answered') {
      expect(
        outcome.response.status,
        new TextDecoder().decode(outcome.response.body)
      ).toBeGreaterThanOrEqual(200);
      expect(outcome.response.status).toBeLessThan(300);
      // eslint-disable-next-line no-console -- e2e evidence
      console.log('relay answered', outcome.response.status, {
        eventId: event.id,
        body: new TextDecoder().decode(outcome.response.body),
      });
    }
  }, 60_000);
});
