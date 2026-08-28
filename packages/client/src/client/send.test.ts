/**
 * The send pipeline, end to end against a fake connector.
 *
 * Real crypto, real OER, real HTTP transport, real `ChannelManager` and a real
 * `EvmSigner` — only the chain and the socket are absent. That matters most for
 * the seal: the fake can only produce a response this client can open by
 * genuinely opening the request first, so the two directions check each other
 * rather than a fixture checking itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import { HttpIlpClient } from '../http/HttpIlpClient.js';
import { ChannelManager } from '../channel/ChannelManager.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { parseSelfDescription } from '../connector/self-description.js';
import { send, toEnvelopeRequest, type SendContext } from './send.js';
import { RouteNotPricedError } from './errors.js';
import { decodeUtf8 } from '../utils/binary.js';

const CHANNEL = `0x${'ab'.repeat(32)}`;
const OTHER_CHANNEL = `0x${'cd'.repeat(32)}`;
const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';
const DESTINATION = 'g.fake.route';

interface Harness {
  fake: FakeTerminatingConnector;
  context: SendContext;
  channels: ChannelManager;
  /** Channel ids `ensureChannel` hands out, in order. Re-point to drive a re-resolve. */
  channelIds: string[];
  evicted: string[];
  /** `false` makes `evictChannel` report "nothing to retire", which vetoes the retry. */
  evictable: boolean;
  ensureCalls: number;
}

function harness(): Harness {
  const fake = new FakeTerminatingConnector({ endpoint: 'http://connector.test' });
  const signer = new EvmSigner(generatePrivateKey());
  const channels = new ChannelManager(signer, new InMemoryChannelStore());

  const state: Harness = {
    fake,
    channels,
    channelIds: [CHANNEL],
    evicted: [],
    evictable: true,
    ensureCalls: 0,
    context: undefined as unknown as SendContext,
  };

  const transport = new HttpIlpClient({
    httpEndpoint: 'http://connector.test/ilp',
    httpClient: fake.fetch,
    maxRetries: 0,
  });

  state.context = {
    describe: async () => parseSelfDescription(fake.selfDescription(), fake.endpoint),
    sealKey: async () => fake.identityPublic,
    sealKeyAt: async () => fake.identityPublic,
    price: async () => fake.routePrice,
    ensureChannel: async () => {
      const id = state.channelIds[Math.min(state.ensureCalls, state.channelIds.length - 1)];
      state.ensureCalls += 1;
      // Tracked here rather than on chain: this suite is about the pipeline, and
      // the on-chain open is `channel-facade`'s subject.
      channels.trackChannel(id!, {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: TOKEN_NETWORK,
        depositTotal: 1_000_000n,
      });
      return id!;
    },
    evictChannel: (channelId) => {
      state.evicted.push(channelId);
      return state.evictable;
    },
    channels,
    transport: async () => ({ kind: 'http', transport }),
    senderId: signer.address,
    chain: 'evm',
    timeoutMs: 5_000,
    warn: () => undefined,
  };
  return state;
}

describe('send — the happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('pays, seals, and returns the app\'s answer', async () => {
    h.fake.answer = {
      status: 201,
      headers: [['content-type', 'application/json']],
      body: new TextEncoder().encode('{"id":"abc"}'),
    };

    const result = await send(h.context, DESTINATION, { body: { hello: 'world' } });

    expect(result.fulfilled).toBe(true);
    if (!result.fulfilled) return;
    expect(result.status).toBe(201);
    expect(result.transport).toBe('http');
    expect(result.json<{ id: string }>()).toEqual({ id: 'abc' });
    expect(result.text()).toBe('{"id":"abc"}');
    expect(result.headers).toEqual([['content-type', 'application/json']]);
    expect(result.fulfillment).toHaveLength(32);
  });

  it('reports the claim it spent: nonce 1, cumulative = the route price', async () => {
    const result = await send(h.context, DESTINATION);
    expect(result.claim).toEqual({
      channelId: CHANNEL,
      chain: 'evm',
      nonce: 1,
      cumulative: 1000n,
      amount: 1000n,
    });
  });

  it('advances the watermark across requests, cumulatively', async () => {
    await send(h.context, DESTINATION);
    const second = await send(h.context, DESTINATION);
    expect(second.claim).toMatchObject({ nonce: 2, cumulative: 2000n });
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(2000n);
  });

  it('sends what the caller asked for, sealed — the fake had to open it to answer', async () => {
    await send(h.context, DESTINATION, {
      method: 'PUT',
      target: 'objects/1',
      headers: { 'x-trace': 'abc' },
      body: 'raw text',
    });

    const opened = h.fake.opened.at(-1);
    expect(opened?.request.method).toBe('PUT');
    expect(opened?.request.target).toBe('objects/1');
    expect(opened?.request.headers).toContainEqual(['x-trace', 'abc']);
    expect(decodeUtf8(opened!.request.body)).toBe('raw text');
  });

  it('labels the claim with the senderId and names the channel it drew on', async () => {
    await send(h.context, DESTINATION);
    const claim = h.fake.claims[0]!;
    expect(claim['blockchain']).toBe('evm');
    expect(claim['channelId']).toBe(CHANNEL);
    expect(claim['nonce']).toBe(1);
    expect(claim['transferredAmount']).toBe('1000');
    expect(claim['senderId']).toBe(h.context.senderId);
  });

  it('uses an explicit amount instead of asking for a price', async () => {
    const price = vi.spyOn(h.context, 'price');
    const result = await send(h.context, DESTINATION, {}, { amount: 4200n });
    expect(price).not.toHaveBeenCalled();
    expect(result.claim?.amount).toBe(4200n);
  });

  it('refuses to form a packet for a route this node does not price', async () => {
    h.fake.routePrice = null;
    await expect(send(h.context, 'g.somewhere.else')).rejects.toBeInstanceOf(
      RouteNotPricedError
    );
    // Nothing was signed, so nothing needs repaying.
    expect(h.fake.paidRequests).toBe(0);
  });
});

describe('send — a refused claim repays the watermark', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('F03 underpayment: reports the route price as accumulatedCost AND rolls back', async () => {
    h.fake.refusal = 'underpay';
    const result = await send(h.context, DESTINATION);

    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.code).toBe('F03');
    // The refusal's whole subject is the figure that was not covered, which is
    // the cheapest way to learn a price.
    expect(result.accumulatedCost).toBe(1000n);
    expect(result.claimAck).toEqual({ result: 'rejected', reason: 'amount_not_advancing' });

    // The connector banked nothing, so neither did we.
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(0n);
    // The nonce is NOT rolled back: a gap costs nothing, reusing one risks
    // presenting two different claims under a single number.
    expect(h.channels.getNonce(CHANNEL)).toBe(1);
  });

  it('F03 over-deposit: cost 0, and the same claim can be re-signed at the next nonce', async () => {
    h.fake.refusal = 'overDeposit';
    const first = await send(h.context, DESTINATION);
    expect(first.fulfilled).toBe(false);
    if (first.fulfilled) return;
    expect(first.code).toBe('F03');
    expect(first.accumulatedCost).toBe(0n);
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(0n);

    // The documented remedy: deposit more, then resend the same cumulative.
    h.fake.refusal = null;
    const second = await send(h.context, DESTINATION);
    expect(second.claim).toMatchObject({ nonce: 2, cumulative: 1000n });
  });

  it('a FULFILL carrying a REJECTED claim ack still repays — the two verdicts are independent', async () => {
    h.fake.refusal = 'routedButUnbanked';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(true);
    if (!result.fulfilled) return;
    // The app answered — and the claim that was supposed to pay for it did not
    // land. Surfaced rather than hidden, because a caller that only checked
    // `fulfilled` would never learn it.
    expect(result.claimAck).toEqual({ result: 'rejected', reason: 'nonce_not_advancing' });
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(0n);
  });

  it('does NOT repay a reject raised past the claim gate — that claim WAS banked', async () => {
    // `F02 no route` is raised after a valid claim advanced the connector's
    // watermark. Repaying it would leave the next claim short.
    h.fake.refusal = 'pathReject';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(1000n);
  });

  it('repays a thrown transport error, where nothing is known to have arrived', async () => {
    h.context.transport = async () => ({
      kind: 'http',
      transport: {
        sendIlpPacketWithClaim: () => Promise.reject(new Error('socket hang up')),
      },
    });
    await expect(send(h.context, DESTINATION)).rejects.toThrow('socket hang up');
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(0n);
  });
});

describe('send — refusedBy is only as strong as the evidence', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("a SEALED reject proves the destination refused — only it could seal one", async () => {
    h.fake.refusal = 'sealedReject';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.refusedBy).toBe('destination');
    expect(result.code).toBe('F99');
  });

  it('a PLAINTEXT reject identifies nobody, so it is only the path', async () => {
    h.fake.refusal = 'pathReject';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.refusedBy).toBe('path');
    expect(result.code).toBe('F02');
  });

  it('a greeting is the EDGE: it refused before routing anything', async () => {
    h.fake.refusal = 'greeting';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.refusedBy).toBe('edge');
    expect(result.code).toBe('PAYMENT_REQUIRED');
    expect(result.terms?.price).toBe(1000n);
    expect(result.terms?.destination).toBe(DESTINATION);
    // A greeting means the packet never travelled, so the claim is repaid.
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(0n);
  });

  it('a greeting naming a carriage is TRANSPORT_REQUIRED, not a payment problem', async () => {
    h.fake.refusal = 'greeting';
    h.fake.requiredTransport = 'btp';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.code).toBe('TRANSPORT_REQUIRED');
    expect(result.refusedBy).toBe('edge');
  });
});

describe('send — the bounded stale-channel retry', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('F01 unknown channel: evicts the binding and retries ONCE on a re-resolved channel', async () => {
    h.channelIds = [CHANNEL, OTHER_CHANNEL];
    // The first attempt is refused; the re-resolved channel is accepted.
    let sent = 0;
    const inner = h.context.transport;
    h.context.transport = async (d) => {
      const carriage = await inner(d);
      return {
        kind: carriage.kind,
        transport: {
          sendIlpPacketWithClaim: (params, claim) => {
            sent += 1;
            h.fake.refusal = sent === 1 ? 'unknownChannel' : null;
            return carriage.transport.sendIlpPacketWithClaim(params, claim);
          },
        },
      };
    };

    const result = await send(h.context, DESTINATION);

    expect(h.evicted).toEqual([CHANNEL]);
    expect(sent).toBe(2);
    expect(result.fulfilled).toBe(true);
    expect(result.claim?.channelId).toBe(OTHER_CHANNEL);
    // The dead channel's watermark was repaid; the new one carries the spend.
    expect(h.channels.getCumulativeAmount(CHANNEL)).toBe(0n);
    expect(h.channels.getCumulativeAmount(OTHER_CHANNEL)).toBe(1000n);
  });

  it('does not retry when re-resolution lands on the SAME channel', async () => {
    h.fake.refusal = 'unknownChannel';
    h.channelIds = [CHANNEL]; // every ensure returns the same id

    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.code).toBe('F01');
    // The retry was attempted and abandoned once it produced the same channel,
    // so the ORIGINAL refusal is reported rather than a second one.
    expect(h.evicted).toEqual([CHANNEL]);
  });

  it('does not retry when there was no binding to retire', async () => {
    h.fake.refusal = 'unknownChannel';
    h.evictable = false;
    await send(h.context, DESTINATION);
    expect(h.fake.paidRequests).toBe(1);
  });

  it('never retries a second time — one eviction per request, never a loop', async () => {
    h.fake.refusal = 'unknownChannel';
    h.channelIds = [CHANNEL, OTHER_CHANNEL, `0x${'ef'.repeat(32)}`];
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    expect(h.fake.paidRequests).toBe(2);
    expect(h.evicted).toEqual([CHANNEL]);
  });

  it('leaves a NONCE-race F01 alone — that channel is healthy and evicting it would strand it', async () => {
    // The connector's own `F01` for a non-advancing nonce names no missing
    // channel, so the guard must not fire.
    h.context.transport = async () => ({
      kind: 'http',
      transport: {
        sendIlpPacketWithClaim: () =>
          Promise.resolve({
            accepted: false,
            code: 'F01',
            message: 'claim rejected: nonce not advancing',
          }),
      },
    });
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    expect(h.evicted).toEqual([]);
  });
});

describe('toEnvelopeRequest', () => {
  it('defaults to POST at the handler\'s own path', () => {
    expect(toEnvelopeRequest({})).toEqual({
      method: 'POST',
      target: '',
      headers: [],
      body: new Uint8Array(0),
    });
  });

  it('says what a JSON body is, since the app reads these headers', () => {
    const request = toEnvelopeRequest({ body: { a: 1 } });
    expect(request.headers).toEqual([['content-type', 'application/json']]);
    expect(decodeUtf8(request.body)).toBe('{"a":1}');
  });

  it('does not override a content-type the caller set', () => {
    const request = toEnvelopeRequest({
      headers: { 'Content-Type': 'application/ld+json' },
      body: { a: 1 },
    });
    expect(request.headers).toEqual([['Content-Type', 'application/ld+json']]);
  });

  it('preserves header order and duplicates from an array — the wire is a sequence', () => {
    const request = toEnvelopeRequest({
      headers: [
        ['accept', 'a'],
        ['accept', 'b'],
      ],
    });
    expect(request.headers).toEqual([
      ['accept', 'a'],
      ['accept', 'b'],
    ]);
  });

  it('passes bytes through untouched', () => {
    const body = new Uint8Array([1, 2, 3]);
    expect(toEnvelopeRequest({ body }).body).toBe(body);
  });
});

describe('send — a route priced at zero', () => {
  // A connector states a free route rather than implying one: every terminated
  // route must carry a price, and `price = 0` is how an operator writes down
  // that they meant it, "because it is never silently free". Such a route runs
  // no claim gate, so a client that opened a channel to use one would have paid
  // gas and locked collateral for nothing.
  //
  // Found against the live devnet relay, which serves exactly this shape:
  // `g.toon.relay` at 1, and `g.toon.relay.ephemeral` at 0.
  it('sends with no claim, and opens no channel at all', async () => {
    const h = harness();
    h.fake.routePrice = 0n;
    h.fake.answer = {
      status: 200,
      headers: [['content-type', 'text/plain']],
      body: new TextEncoder().encode('free'),
    };

    const result = await send(h.context, DESTINATION, { body: 'free route' });

    expect(result.fulfilled).toBe(true);
    if (!result.fulfilled) return;
    expect(result.status).toBe(200);
    expect(result.text()).toBe('free');
    // No claim, because nothing was paid — reporting a zero-valued one would be
    // a fiction, and a caller checking `claim` would read it as a payment.
    expect(result.claim).toBeUndefined();
    // And no channel was reached for: this is what makes a free route usable by
    // a client holding no funds.
    expect(h.ensureCalls).toBe(0);
    expect(h.fake.claims).toHaveLength(0);
  });

  it('still seals the request and reads the sealed answer back', async () => {
    // The only thing a free route drops is the payment. The envelope, the gift
    // wrap, the condition derived from the secret inside it and the sealed
    // answer are all unchanged — which is why the fake can still open it.
    const h = harness();
    h.fake.routePrice = 0n;
    // The target is relative: it is resolved BENEATH the route's handler path
    // and can never replace it (connector ADR 0025), so an absolute one is
    // refused `F00` before the app is touched.
    const result = await send(h.context, DESTINATION, {
      method: 'PUT',
      target: 'thing',
      body: { a: 1 },
    });

    expect(result.fulfilled).toBe(true);
    const opened = h.fake.opened.at(-1);
    expect(opened?.request.method).toBe('PUT');
    expect(opened?.request.target).toBe('thing');
  });
});
