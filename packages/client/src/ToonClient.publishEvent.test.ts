/**
 * `ToonClient.publishEvent` at its own surface: the claim DELIVERY MECHANISM
 * (Story 50.3 AC#1) and the sealed wire it now rides on (toon-client#450).
 *
 * The claim half is a regression guard for the F06 ("No payment channel claim
 * attached to packet") root cause: a caller-supplied `{ claim }` MUST be
 * attached INLINE on the PREPARE (`sendIlpPacketWithClaim`), so the receiving
 * connector's per-packet validator accepts it. It MUST NOT be delivered only
 * via the out-of-band `sendClaimMessage` path, which that validator never
 * sees.
 *
 * The wire half asserts what the packet is made of: the terminating
 * connector's identity is fetched before a packet is formed, `data` is a gift
 * wrap around an OER envelope (never HTTP text), the condition is derived from
 * the secret that wrap carries and is never all-zero, and the answer is opened
 * with that same secret. The fake connector on the other end genuinely opens
 * what this client sealed — it cannot answer at all otherwise — so these
 * assertions are about the real bytes, not about a fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { ToonClient } from './ToonClient.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SignedBalanceProof } from './types.js';
import {
  FakeTerminatingConnector,
  plaintextReject,
} from './wire/fake-connector.test-support.js';
import { isZeroCondition } from './utils/condition.js';
import { fromBase64 } from './utils/binary.js';

// A deterministic 32-byte secret key so getPublicKey() works.
const SECRET_KEY = new Uint8Array(32).fill(7);

function baseConfig() {
  return {
    secretKey: SECRET_KEY,
    connectorUrl: 'http://connector.test',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    // Non-empty encoder so the computed default amount is > 0 (claim path).
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

function makeEvent(): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'hello relay',
    sig: 'b'.repeat(128),
  } as unknown as NostrEvent;
}

function makeProof(): SignedBalanceProof {
  return {
    channelId:
      '0xdff44167e826f9f85e5f046f2358c79c8354691b44a89cac0e7f584612258d2d',
    nonce: 1,
    transferredAmount: 1_000_000n,
    lockedAmount: 0n,
    locksRoot: '0x' + '0'.repeat(64),
    signature: '0x' + 'c'.repeat(130),
    signerAddress: '0x' + 'd'.repeat(40),
    chainId: 31337,
    tokenNetworkAddress: '0x' + 'e'.repeat(40),
  } as unknown as SignedBalanceProof;
}

let connector: FakeTerminatingConnector;
let realFetch: typeof fetch;

beforeEach(() => {
  connector = new FakeTerminatingConnector();
  realFetch = globalThis.fetch;
  globalThis.fetch = connector.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The single request the connector opened, asserted rather than assumed. */
function onlyOpened(connector: FakeTerminatingConnector) {
  const [first] = connector.opened;
  if (first === undefined) {
    throw new Error('the connector opened no request at all');
  }
  return first;
}

/** Wire a client up with a paid-write transport, as `start()` would have. */
function attachTransport(
  client: ToonClient,
  transport: Record<string, unknown>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: {},
    runtimeClient: {},
    peersDiscovered: 0,
    btpClient: transport,
  };
}

describe('ToonClient.publishEvent claim delivery mechanism (Story 50.3 AC#1)', () => {
  it('attaches the explicit claim INLINE via sendIlpPacketWithClaim (not the async claim-receiver path)', async () => {
    const client = new ToonClient(baseConfig());

    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    // The async out-of-band path must NOT be the delivery mechanism for the
    // PREPARE's claim — if publishEvent ever routes here instead of inline, the
    // receiving per-packet validator emits F06.
    const sendClaimMessage = vi.fn(async () => undefined);
    const sendIlpPacket = vi.fn(async () => ({ accepted: true }));

    attachTransport(client, {
      sendIlpPacketWithClaim,
      sendClaimMessage,
      sendIlpPacket,
    });

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(true);

    // INLINE path used exactly once.
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    // Async claim-receiver path was NOT used as the (sole) delivery mechanism.
    expect(sendClaimMessage).not.toHaveBeenCalled();

    const [ilpParams, claimMessage] =
      sendIlpPacketWithClaim.mock.calls[0] ?? [];

    // The PREPARE targets the configured apex destination.
    expect(ilpParams).toMatchObject({ destination: 'g.proxy' });

    // The claim message carried inline is the EVM claim derived from the proof,
    // matching the connector's `payment-channel-claim` validator expectations.
    expect(claimMessage).toMatchObject({
      blockchain: 'evm',
      channelId: makeProof().channelId,
      signature: makeProof().signature,
      signerAddress: makeProof().signerAddress,
      transferredAmount: '1000000',
    });
  });

  it('honors an explicit ilpAmount override while still attaching the claim inline', async () => {
    const client = new ToonClient(baseConfig());

    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    const sendClaimMessage = vi.fn(async () => undefined);

    attachTransport(client, { sendIlpPacketWithClaim, sendClaimMessage });

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
      ilpAmount: 1_000_000n,
    });

    expect(result.success).toBe(true);
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    expect(sendClaimMessage).not.toHaveBeenCalled();

    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(ilpParams).toMatchObject({ amount: '1000000' });
  });
});

describe('ToonClient.publishEvent forms a sealed packet (toon-client#450)', () => {
  it('seals an OER envelope to the terminating connector, and no HTTP text is produced', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    attachTransport(client, { sendIlpPacketWithClaim });

    await client.publishEvent(makeEvent(), { claim: makeProof() });

    // The connector could only have recorded this by genuinely opening what
    // the client sealed — with its own identity key, which the client fetched.
    expect(connector.opened).toHaveLength(1);
    const { request } = onlyOpened(connector);
    expect(request.method).toBe('POST');
    // '' resolves to the handler's own path (ADR 0025); the deployed edge
    // refuses an absolute '/write' with F00.
    expect(request.target).toBe('');
    expect(request.headers).toContainEqual([
      'content-type',
      'application/json',
    ]);
    expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({
      event: makeEvent(),
    });

    // The wire bytes are a gift wrap (leading type byte 1), not HTTP text.
    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    const sent = fromBase64((ilpParams as unknown as { data: string }).data);
    expect(sent[0]).toBe(1);
    expect(new TextDecoder().decode(sent)).not.toContain('HTTP/1.1');
  });

  it('sends `proxyPath` as the envelope target', async () => {
    const client = new ToonClient(baseConfig());
    attachTransport(client, {
      sendIlpPacketWithClaim: async (params: { data: string }) =>
        connector.fulfill(params.data),
    });

    // Handler-RELATIVE (ADR 0025): a sub-path beneath the route's handler.
    // The absolute '/store' this test used to send is now refused by the
    // connector (and by the fake) as an escape attempt.
    await client.publishEvent(makeEvent(), {
      claim: makeProof(),
      proxyPath: 'v2',
    });

    expect(onlyOpened(connector).request.target).toBe('v2');
  });

  it('mints a real execution condition matching the fulfilment the connector derives', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    attachTransport(client, { sendIlpPacketWithClaim });

    await client.publishEvent(makeEvent(), { claim: makeProof() });

    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    const condition = (
      ilpParams as unknown as { executionCondition?: Uint8Array }
    ).executionCondition;

    // Never all-zero: the Rust connector refuses that outright, which is why
    // the pre-#450 publish path could not work against it at all.
    expect(condition).toBeDefined();
    expect(condition).toHaveLength(32);
    expect(isZeroCondition(condition)).toBe(false);

    // And it is THE condition for this packet's secret — the connector's own
    // derived fulfilment is its preimage.
    const { fulfillment } = onlyOpened(connector);
    expect(Array.from(sha256(fulfillment))).toEqual(
      Array.from(condition ?? new Uint8Array())
    );
  });

  it('mints a fresh secret per packet, so no two publishes share a condition', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    attachTransport(client, { sendIlpPacketWithClaim });

    await client.publishEvent(makeEvent(), { claim: makeProof() });
    await client.publishEvent(makeEvent(), { claim: makeProof() });

    const conditions = sendIlpPacketWithClaim.mock.calls.map(([p]) =>
      Array.from(
        (p as unknown as { executionCondition: Uint8Array }).executionCondition
      )
    );
    expect(conditions[0]).not.toEqual(conditions[1]);
  });

  it('refuses to form a packet when the connector will not give up an identity', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as typeof fetch;

    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn();
    attachTransport(client, { sendIlpPacketWithClaim });

    await expect(
      client.publishEvent(makeEvent(), { claim: makeProof() })
    ).rejects.toThrow(/Failed to publish event/);

    // There is no fallback key to seal to, so nothing was sent at all.
    expect(sendIlpPacketWithClaim).not.toHaveBeenCalled();
  });
});

describe('ToonClient.publishEvent reads the sealed answer (toon-client#450)', () => {
  it('opens the response envelope and reports its status, headers and body', async () => {
    const client = new ToonClient(baseConfig());
    connector.answer = {
      status: 201,
      headers: [['x-relay', 'ok']],
      body: new TextEncoder().encode('{"stored":true}'),
    };
    attachTransport(client, {
      sendIlpPacketWithClaim: async (params: { data: string }) =>
        connector.fulfill(params.data),
    });

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(true);
    expect(result.eventId).toBe(makeEvent().id);
    expect(result.response?.status).toBe(201);
    expect(result.response?.headers).toContainEqual(['x-relay', 'ok']);
    expect(new TextDecoder().decode(result.response?.body)).toBe(
      '{"stored":true}'
    );
  });

  it('FAILS the publish (no fake eventId) on a non-2xx answer, but still surfaces it', async () => {
    const client = new ToonClient(baseConfig());
    connector.answer = {
      status: 404,
      headers: [],
      body: new TextEncoder().encode('404 Not Found'),
    };

    // The explicit-claim path does not re-sign, so a failed write must not
    // advance the nonce watermark beyond what the caller already signed.
    const signBalanceProof = vi.fn();
    attachTransport(client, {
      sendIlpPacketWithClaim: async (params: { data: string }) =>
        connector.fulfill(params.data),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = {
      signBalanceProof,
      isTracking: () => false,
    };

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(false);
    expect(result.eventId).toBeUndefined();
    expect(result.error).toMatch(/404/);
    // ADR 0020: the answer arrived on a FULFILL and value moved, so the caller
    // can still see exactly what it paid for.
    expect(result.response?.status).toBe(404);
    expect(signBalanceProof).not.toHaveBeenCalled();
  });

  it('reports a sealed reject as the DESTINATION refusing', async () => {
    const client = new ToonClient(baseConfig());
    attachTransport(client, {
      sendIlpPacketWithClaim: async (params: { data: string }) =>
        connector.rejectSealed(params.data, 'F99', 'relay says no'),
    });

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(false);
    expect(result.refusedBy).toBe('destination');
    expect(result.code).toBe('F99');
    expect(result.error).toMatch(/relay says no/);
  });

  it('reports a plaintext reject as a PATH refusal, distinguishably', async () => {
    const client = new ToonClient(baseConfig());
    attachTransport(client, {
      sendIlpPacketWithClaim: async () => plaintextReject('F02', 'no route'),
    });

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(false);
    expect(result.refusedBy).toBe('path');
    expect(result.code).toBe('F02');
    expect(result.error).toMatch(/no route/);
  });

  it('refuses a FULFILL that is not a sealed response rather than reporting success', async () => {
    const client = new ToonClient(baseConfig());
    attachTransport(client, {
      sendIlpPacketWithClaim: async () => ({
        accepted: true,
        data: Buffer.from('ack:1', 'utf-8').toString('base64'),
      }),
    });

    // Value moved for bytes this client cannot read. Reporting success there
    // is exactly what the plaintext path used to do.
    await expect(
      client.publishEvent(makeEvent(), { claim: makeProof() })
    ).rejects.toThrow(/Failed to publish event/);
  });
});

// ---------------------------------------------------------------------------
// Pricing — asked for, never computed (toon-client#452, ADR 0020)
// ---------------------------------------------------------------------------

describe('ToonClient.publishEvent asks the route for its price (toon-client#452)', () => {
  /** Every URL the client fetched, in order. */
  function urlsFetched(): string[] {
    const spy = globalThis.fetch as unknown as {
      mock?: { calls: unknown[][] };
    };
    return (spy.mock?.calls ?? []).map((c) => String(c[0]));
  }

  function spyOnConnectorFetch(): void {
    globalThis.fetch = vi.fn(connector.fetch) as unknown as typeof fetch;
  }

  it('prices the packet at the destination route price, not at any local rate', async () => {
    connector.routePrice = 1234n;
    spyOnConnectorFetch();
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    attachTransport(client, { sendIlpPacketWithClaim });

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(true);
    const [params] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect((params as { amount: string }).amount).toBe('1234');

    // It really came off the wire, from the documented endpoint.
    expect(
      urlsFetched().some((u) =>
        u.includes('/ilp/routes/price?destination=g.proxy')
      )
    ).toBe(true);
  });

  it('does not multiply the price by anything — a bigger event costs the same', async () => {
    // The whole point of ADR 0020: byte-proportional pricing has no successor.
    connector.routePrice = 1000n;
    const amountFor = async (encodedLength: number): Promise<string> => {
      const local = new FakeTerminatingConnector();
      local.routePrice = 1000n;
      globalThis.fetch = local.fetch;
      const config = baseConfig() as unknown as {
        toonEncoder: (e: unknown) => Uint8Array;
      };
      config.toonEncoder = () => new Uint8Array(encodedLength);
      const client = new ToonClient(
        config as unknown as ConstructorParameters<typeof ToonClient>[0]
      );
      const send = vi.fn(async (params: { data: string }) =>
        local.fulfill(params.data)
      );
      attachTransport(client, { sendIlpPacketWithClaim: send });
      await client.publishEvent(makeEvent(), { claim: makeProof() });
      return (send.mock.calls[0]?.[0] as { amount: string }).amount;
    };

    expect(await amountFor(4)).toBe('1000');
    expect(await amountFor(100_000)).toBe('1000');
  });

  it('an explicit ilpAmount still overrides, and never asks for a price', async () => {
    spyOnConnectorFetch();
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    attachTransport(client, { sendIlpPacketWithClaim });

    await client.publishEvent(makeEvent(), {
      claim: makeProof(),
      ilpAmount: 7n,
    });

    const [params] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect((params as { amount: string }).amount).toBe('7');
    // The identity is still fetched (a packet cannot be sealed without it);
    // the price is not, because the caller already stated one.
    expect(urlsFetched().some((u) => u.includes('/ilp/identity'))).toBe(true);
    expect(urlsFetched().some((u) => u.includes('/ilp/routes/price'))).toBe(
      false
    );
  });

  it('refuses a destination the connector terminates no route for, rather than pricing it at zero', async () => {
    connector.routePrice = null; // the connector answers 404
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async (params: { data: string }) =>
      connector.fulfill(params.data)
    );
    attachTransport(client, { sendIlpPacketWithClaim });

    // Distinguishable, and no packet is formed at all — pricing an unroutable
    // write at 0 would send one certain to be rejected for an unreadable
    // reason.
    await expect(
      client.publishEvent(makeEvent(), { claim: makeProof() })
    ).rejects.toThrow(/terminates no route/);
    expect(sendIlpPacketWithClaim).not.toHaveBeenCalled();
  });

  it('fetches a price once per destination and reuses it, not once per packet', async () => {
    spyOnConnectorFetch();
    const client = new ToonClient(baseConfig());
    attachTransport(client, {
      sendIlpPacketWithClaim: vi.fn(async (params: { data: string }) =>
        connector.fulfill(params.data)
      ),
    });

    await client.publishEvent(makeEvent(), { claim: makeProof() });
    await client.publishEvent(makeEvent(), { claim: makeProof() });
    await client.publishEvent(makeEvent(), { claim: makeProof() });

    const priceCalls = urlsFetched().filter((u) =>
      u.includes('/ilp/routes/price')
    );
    expect(priceCalls).toHaveLength(1);
  });

  it('asks separately for a second destination', async () => {
    spyOnConnectorFetch();
    const client = new ToonClient(baseConfig());
    attachTransport(client, {
      sendIlpPacketWithClaim: vi.fn(async (params: { data: string }) =>
        connector.fulfill(params.data)
      ),
    });

    await client.publishEvent(makeEvent(), { claim: makeProof() });
    await client.publishEvent(makeEvent(), {
      claim: makeProof(),
      destination: 'g.proxy.store',
    });

    const priceCalls = urlsFetched().filter((u) =>
      u.includes('/ilp/routes/price')
    );
    expect(priceCalls).toHaveLength(2);
    expect(priceCalls[1]).toContain('destination=g.proxy.store');
  });

  it('getRoutePrice exposes the same lookup, and reports an unterminated route as null', async () => {
    const client = new ToonClient(baseConfig());
    connector.routePrice = 4321n;
    await expect(client.getRoutePrice('g.proxy')).resolves.toBe(4321n);

    const other = new ToonClient(baseConfig());
    connector.routePrice = null;
    await expect(other.getRoutePrice('g.nowhere')).resolves.toBeNull();
  });
});

describe('announce-less channel bootstrap (connector #617)', () => {
  const GREETING_SETTLEMENT = {
    chain: 'evm:84532',
    settlementAddress: '0x' + 'a'.repeat(40),
    tokenNetworkRegistry: '0x' + 'b'.repeat(40),
    tokenNetwork: '0x' + 'e'.repeat(40),
    tokenAddress: '0x' + 'f'.repeat(40),
    decimals: 6,
  };

  it('synthesizes the negotiation from the greeting and opens the channel', async () => {
    const client = new ToonClient(baseConfig());
    connector.settlementTerms = GREETING_SETTLEMENT;
    attachTransport(client, {
      sendIlpPacketWithClaim: async (params: { data: string }) =>
        connector.fulfill(params.data),
    });
    const ensureChannel = vi.fn(async () => 'chan-1');
    const signBalanceProof = vi.fn(async () => makeProof());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = {
      ensureChannel,
      signBalanceProof,
      isTracking: () => false,
      getSignerForChannel: () => ({
        buildClaimMessage: (proof: unknown, sender: unknown) => ({
          proof,
          sender,
        }),
      }),
    };

    const result = await client.publishEvent(makeEvent());

    expect(result.success).toBe(true);
    // The negotiation ensureChannel received was built from the greeting's
    // own facts — nothing announced, nothing configured.
    expect(ensureChannel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        chain: 'evm:84532',
        chainType: 'evm',
        chainId: 84532,
        settlementAddress: GREETING_SETTLEMENT.settlementAddress,
        tokenNetwork: GREETING_SETTLEMENT.tokenNetwork,
        tokenAddress: GREETING_SETTLEMENT.tokenAddress,
      })
    );
    // The claim then advanced by the asked price, exactly as a negotiated
    // peer's would have.
    expect(signBalanceProof).toHaveBeenCalledWith('chan-1', 1000n);
  });

  it('still refuses precisely when the greeting carries no settlement facts', async () => {
    const client = new ToonClient(baseConfig());
    connector.settlementTerms = null;
    attachTransport(client, {
      sendIlpPacketWithClaim: async (params: { data: string }) =>
        connector.fulfill(params.data),
    });
    const ensureChannel = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = {
      ensureChannel,
      signBalanceProof: vi.fn(),
      isTracking: () => false,
    };

    await expect(client.publishEvent(makeEvent())).rejects.toThrow(
      /No negotiation metadata/
    );
    expect(ensureChannel).not.toHaveBeenCalled();
  });
});
