/**
 * The send pipeline, end to end against a fake connector.
 *
 * Real crypto, real OER and a real HTTP transport — only the chain, the socket
 * and the voucher's signature are absent. The voucher source is a stub that
 * keeps a running total and records each packet's fate, because what this suite
 * checks is how `send` drives it; the payer's own suite checks the vouchers.
 * The seal matters most: the fake can only produce a response this client can
 * open by genuinely opening the request first, so the two directions check each
 * other rather than a fixture checking itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import { HttpIlpClient } from '../http/HttpIlpClient.js';
import { parseSelfDescription } from '../connector/self-description.js';
import {
  send,
  toEnvelopeRequest,
  type PaidWriteTransport,
  type SendContext,
} from './send.js';
import type { SendRequest } from './types.js';
import type { VoucherOutcome } from '../channel/batch-settlement/payer.js';
import {
  BeforePayRefusedError,
  ChainUnavailableError,
  RouteNotPricedError,
} from './errors.js';
import { decodeUtf8 } from '../utils/binary.js';

const CHANNEL = `0x${'ab'.repeat(32)}`;
const DESTINATION = 'g.fake.route';

interface Harness {
  fake: FakeTerminatingConnector;
  context: SendContext;
  /** How many vouchers were asked for. */
  claimForCalls: number;
  /** Each voucher's reported fate, in order. */
  settled: VoucherOutcome[];
  /** The stub's running total: what it would sign next on. */
  cumulative: bigint;
  /** `false` models a node offering no x402 channel on the chain. */
  offered: boolean;
}

function harness(): Harness {
  const fake = new FakeTerminatingConnector({ endpoint: 'http://connector.test' });
  const state: Harness = {
    fake,
    claimForCalls: 0,
    settled: [],
    cumulative: 0n,
    offered: true,
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
    routePrice: async () =>
      fake.routePrice === null
        ? null
        : {
            price: fake.routePrice,
            ...(fake.pricePerKib !== undefined ? { pricePerKib: fake.pricePerKib } : {}),
          },
    vouchers: {
      claimFor: async (_description, chain, amount) => {
        state.claimForCalls += 1;
        if (!state.offered) return undefined;
        state.cumulative += amount;
        const cumulative = state.cumulative;
        return {
          chain: chain as 'evm',
          channelId: CHANNEL,
          claim: {
            blockchain: 'evm',
            channelId: CHANNEL,
            maxClaimableAmount: cumulative.toString(),
            scheme: 'batch-settlement',
          },
          cumulative,
          settle: (outcome) => {
            state.settled.push(outcome);
            if (outcome.kind === 'refused') state.cumulative -= amount;
          },
        };
      },
    },
    transport: async () => ({ kind: 'http', transport }),
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
    expect(h.settled).toEqual([{ kind: 'banked' }]);
  });

  it('reports the voucher it spent: cumulative = the route price', async () => {
    const result = await send(h.context, DESTINATION);
    expect(result.claim).toEqual({
      channelId: CHANNEL,
      chain: 'evm',
      cumulative: 1000n,
      amount: 1000n,
    });
  });

  it('advances the running total across requests', async () => {
    await send(h.context, DESTINATION);
    const second = await send(h.context, DESTINATION);
    expect(second.claim).toMatchObject({ cumulative: 2000n, amount: 1000n });
  });

  it('carries the voucher on the wire, exactly as the payer built it', async () => {
    await send(h.context, DESTINATION);
    expect(h.fake.claims[0]).toEqual({
      blockchain: 'evm',
      channelId: CHANNEL,
      maxClaimableAmount: '1000',
      scheme: 'batch-settlement',
    });
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

  it('uses an explicit amount instead of asking for a price', async () => {
    const price = vi.spyOn(h.context, 'routePrice');
    const result = await send(h.context, DESTINATION, {}, { amount: 4200n });
    expect(price).not.toHaveBeenCalled();
    expect(result.claim?.amount).toBe(4200n);
  });

  // ── A metered route (connector publishes `pricePerKib`) ──────────────────
  //
  // The deployed store node prices `g.toon.store` at 1000 + 10/KiB and refuses
  // a voucher for the base price alone. These pin the arithmetic that stops
  // that happening: the metered quantity is the SEALED payload rather than the
  // caller's body, and the unit count rounds up.

  it('pays the base price PLUS the per-KiB rate on a metered route', async () => {
    h.fake.pricePerKib = 10n;
    const result = await send(h.context, DESTINATION, { body: 'hello' });
    expect(result.claim?.amount).toBe(1010n);
  });

  it('charges by the SEALED size, not the body size — a body under 1 KiB can cost two units', async () => {
    h.fake.pricePerKib = 10n;
    const result = await send(h.context, DESTINATION, { body: 'x'.repeat(1000) });
    expect(result.claim?.amount).toBe(1020n);
  });

  it('counts kibibytes STARTED, so an empty payload still costs one unit', async () => {
    h.fake.pricePerKib = 10n;
    const result = await send(h.context, DESTINATION, { body: '' });
    expect(result.claim?.amount).toBe(1010n);
  });

  it('leaves a flat-priced route exactly as it was', async () => {
    h.fake.pricePerKib = undefined;
    const result = await send(h.context, DESTINATION, { body: 'x'.repeat(5000) });
    expect(result.claim?.amount).toBe(1000n);
  });

  it('takes an explicit amount literally on a metered route — the caller knows the far terms', async () => {
    h.fake.pricePerKib = 10n;
    const result = await send(h.context, DESTINATION, { body: 'hello' }, { amount: 1011n });
    expect(result.claim?.amount).toBe(1011n);
  });

  it('refuses to form a packet for a route this node does not price', async () => {
    h.fake.routePrice = null;
    await expect(send(h.context, 'g.somewhere.else')).rejects.toBeInstanceOf(RouteNotPricedError);
    expect(h.claimForCalls).toBe(0);
    expect(h.fake.paidRequests).toBe(0);
  });

  it('refuses a paid packet to a node that offers no x402 channel on the chain', async () => {
    h.offered = false;
    await expect(send(h.context, DESTINATION)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(h.fake.paidRequests).toBe(0);
  });
});

describe('send — a voucher’s fate goes back to the payer', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('F03 underpayment: reports the route price as accumulatedCost, and the reject’s own text', async () => {
    h.fake.refusal = 'underpay';
    const result = await send(h.context, DESTINATION);

    expect(result.fulfilled).toBe(false);
    if (result.fulfilled) return;
    expect(result.code).toBe('F03');
    expect(result.accumulatedCost).toBe(1000n);
    expect(result.claimAck).toEqual({ result: 'rejected', reason: 'amount_not_advancing' });
    // The payer reads where the connector's watermark stands from the text.
    expect(h.settled).toEqual([
      { kind: 'refused', message: "claim rejected: advances value by 1, less than this route's price of 1000" },
    ]);
  });

  it('F03 over-deposit: cost 0, and the voucher is given back', async () => {
    h.fake.refusal = 'overDeposit';
    const first = await send(h.context, DESTINATION);
    expect(first.fulfilled).toBe(false);
    if (first.fulfilled) return;
    expect(first.code).toBe('F03');
    expect(first.accumulatedCost).toBe(0n);
    expect(h.settled[0]).toMatchObject({ kind: 'refused' });

    h.fake.refusal = null;
    const second = await send(h.context, DESTINATION);
    expect(second.claim).toMatchObject({ cumulative: 1000n });
  });

  it('a FULFILL carrying a REJECTED claim ack is still a refused voucher — the two verdicts are independent', async () => {
    h.fake.refusal = 'routedButUnbanked';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(true);
    if (!result.fulfilled) return;
    expect(result.claimAck).toEqual({ result: 'rejected', reason: 'amount_not_advancing' });
    expect(h.settled[0]).toMatchObject({ kind: 'refused' });
  });

  it('a reject raised past the claim gate is a BANKED voucher — it was accepted', async () => {
    // `F02 no route` is raised after a valid voucher advanced the connector's
    // watermark. Giving it back would leave the next one short.
    h.fake.refusal = 'pathReject';
    const result = await send(h.context, DESTINATION);
    expect(result.fulfilled).toBe(false);
    expect(h.settled).toEqual([{ kind: 'banked' }]);
  });

  it('a thrown transport error leaves the voucher counted, and rethrows', async () => {
    const failing: PaidWriteTransport = {
      sendIlpPacketWithClaim: () => Promise.reject(new Error('socket hang up')),
      sendIlpPacket: () => Promise.reject(new Error('socket hang up')),
    };
    h.context.transport = async () => ({ kind: 'http', transport: failing });
    await expect(send(h.context, DESTINATION)).rejects.toThrow('socket hang up');
    expect(h.settled).toEqual([{ kind: 'unknown' }]);
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
    // A greeting means the packet never travelled, so the voucher is given back.
    expect(h.settled).toEqual([{ kind: 'refused' }]);
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
  // that they meant it. Such a route runs no claim gate, so a client that
  // opened a channel to use one would have locked a deposit for nothing.
  it('sends with no voucher, and asks the payer for none', async () => {
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
    expect(result.claim).toBeUndefined();
    expect(h.claimForCalls).toBe(0);
    expect(h.fake.claims).toHaveLength(0);
  });

  it('still seals the request and reads the sealed answer back', async () => {
    const h = harness();
    h.fake.routePrice = 0n;
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

describe('send — beforePay, the caller\'s last look before money moves', () => {
  // A paid route bills for an ANSWER, and a refusal is an answer: the connector
  // collects the price before the app has seen the body (TOON_Network#115).
  // This hook is the one point at which the price is resolved and no voucher
  // has been signed — and a signed voucher is a bearer instrument.
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('refuses the send before a voucher exists: nothing signed, nothing sent', async () => {
    await expect(
      send(
        h.context,
        DESTINATION,
        { body: { wrong: 'envelope' } },
        { beforePay: () => 'the app takes a bare object, not a wrapped one' }
      )
    ).rejects.toBeInstanceOf(BeforePayRefusedError);

    expect(h.claimForCalls).toBe(0);
    expect(h.fake.claims).toHaveLength(0);
    expect(h.fake.paidRequests).toBe(0);
    expect(h.fake.opened).toHaveLength(0);
  });

  it('carries the reason verbatim, with the route and the price it refused', async () => {
    const error = await send(h.context, DESTINATION, {}, { beforePay: () => 'malformed body' })
      .then(() => undefined)
      .catch((e: unknown) => e as BeforePayRefusedError);

    expect(error).toBeInstanceOf(BeforePayRefusedError);
    expect(error?.reason).toBe('malformed body');
    expect(error?.code).toBe('BEFORE_PAY_REFUSED');
    expect(error?.destination).toBe(DESTINATION);
    expect(error?.amount).toBe(1000n);
  });

  it('lets a paid send through unchanged when it returns nothing', async () => {
    const result = await send(h.context, DESTINATION, { body: 'fine' }, { beforePay: () => undefined });
    expect(result.fulfilled).toBe(true);
    expect(result.claim).toEqual({ channelId: CHANNEL, chain: 'evm', cumulative: 1000n, amount: 1000n });
    expect(h.fake.claims).toHaveLength(1);
  });

  it('is handed the RESOLVED price, including a metered route\'s per-KiB charge', async () => {
    h.fake.pricePerKib = 10n;
    const seen: bigint[] = [];
    await send(
      h.context,
      DESTINATION,
      { body: 'x'.repeat(1000) },
      {
        beforePay: ({ amount }) => {
          seen.push(amount);
        },
      }
    );
    expect(seen).toEqual([1020n]);
  });

  it('is shown the destination and the request it is about to pay for', async () => {
    const request = { method: 'PUT', target: 'objects/1', body: { a: 1 } };
    const about: { destination: string; request: SendRequest }[] = [];
    await send(h.context, DESTINATION, request, {
      beforePay: ({ destination, request: seen }) => {
        about.push({ destination, request: seen });
      },
    });
    expect(about).toHaveLength(1);
    expect(about[0]?.destination).toBe(DESTINATION);
    expect(about[0]?.request).toBe(request);
  });

  it('runs on a free route too — a wrong body wastes the answer as well as the money', async () => {
    h.fake.routePrice = 0n;
    const seen: bigint[] = [];
    await expect(
      send(
        h.context,
        DESTINATION,
        { body: 'wrong' },
        {
          beforePay: ({ amount }) => {
            seen.push(amount);
            return 'still wrong, and still not worth sending';
          },
        }
      )
    ).rejects.toBeInstanceOf(BeforePayRefusedError);
    expect(seen).toEqual([0n]);
    expect(h.fake.opened).toHaveLength(0);
  });

  it('lets the callback\'s own throw propagate unchanged', async () => {
    const boom = new TypeError('schema compiled wrong');
    await expect(
      send(
        h.context,
        DESTINATION,
        {},
        {
          beforePay: () => {
            throw boom;
          },
        }
      )
    ).rejects.toBe(boom);
    expect(h.fake.claims).toHaveLength(0);
    expect(h.claimForCalls).toBe(0);
  });
});
