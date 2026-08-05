import { describe, it, expect, vi } from 'vitest';
import {
  IsomorphicBtpClient,
  type BtpChannelDeclaration,
  type BtpHandlerResponse,
} from './IsomorphicBtpClient.js';
import {
  BTPMessageType,
  serializeBtpMessage,
  parseBtpMessage,
  type BTPMessageData,
} from './protocol.js';

/**
 * A minimal WebSocket test double: captures every frame `send()` writes and
 * lets a test drive `onopen`/`onmessage`/`onclose` directly, the way a real
 * socket's event loop would. `close()` deliberately does NOT invoke
 * `onclose` synchronously (a real WebSocket's close is asynchronous) — tests
 * that care about the close event trigger it explicitly via `triggerClose`.
 */
class FakeWebSocket {
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = false;

  send(data: unknown): void {
    this.sent.push(
      data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    );
  }

  close(): void {
    this.closed = true;
  }

  triggerOpen(): void {
    this.onopen?.();
  }

  triggerMessage(data: Uint8Array): void {
    this.onmessage?.({ data });
  }

  triggerClose(): void {
    this.onclose?.();
  }
}

/** Flushes the microtask queue past the `dispatchInbound` `.then().then()` chain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createConnectedClient(configOverrides: Record<string, unknown> = {}) {
  const fakeWs = new FakeWebSocket();
  const client = new IsomorphicBtpClient({
    url: 'ws://test',
    peerId: 'p',
    authToken: '',
    createWebSocket: () => fakeWs as unknown as WebSocket,
    ...configOverrides,
  });

  const connectPromise = client.connect();
  fakeWs.triggerOpen();

  // authenticate() awaits getChannelDeclaration() before building the
  // greeting (toon-client#513), so the auth MESSAGE is no longer sent
  // synchronously inside triggerOpen()'s call stack — flush the microtask
  // queue first, then answer it with a bare RESPONSE under the same requestId.
  await flush();
  const authFrame = parseBtpMessage(fakeWs.sent[0]!);
  fakeWs.triggerMessage(
    serializeBtpMessage({
      type: BTPMessageType.RESPONSE,
      requestId: authFrame.requestId,
      data: { protocolData: [], ilpPacket: new Uint8Array(0) },
    })
  );
  await connectPromise;
  fakeWs.sent.length = 0; // drop the auth frame — tests only care about post-auth traffic

  return { client, fakeWs };
}

function inboundMessageFrame(requestId: number): Uint8Array {
  return serializeBtpMessage({
    type: BTPMessageType.MESSAGE,
    requestId,
    data: {
      protocolData: [
        {
          protocolName: 'payout-notice',
          contentType: 1,
          data: new TextEncoder().encode('increment 3'),
        },
      ],
      ilpPacket: new Uint8Array(0),
    },
  });
}

function inboundTransferFrame(requestId: number, amount: bigint): Uint8Array {
  return serializeBtpMessage({
    type: BTPMessageType.TRANSFER,
    requestId,
    data: {
      amount,
      protocolData: [
        {
          protocolName: 'payout-claim',
          contentType: 1,
          data: new TextEncoder().encode('{}'),
        },
      ],
    },
  });
}

describe('IsomorphicBtpClient — server-originated MESSAGE (toon-client#493)', () => {
  it('dispatches to onMessage and answers RESPONSE under the same requestId', async () => {
    const onMessage = vi.fn(
      (): BtpHandlerResponse => ({
        protocolData: [
          { protocolName: 'ack', contentType: 1, data: new Uint8Array([1]) },
        ],
      })
    );
    const { fakeWs } = await createConnectedClient({ onMessage });

    fakeWs.triggerMessage(inboundMessageFrame(777));
    await flush();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]![0]).toMatchObject({
      requestId: 777,
      protocolData: [
        {
          protocolName: 'payout-notice',
          contentType: 1,
          data: new TextEncoder().encode('increment 3'),
        },
      ],
    });

    expect(fakeWs.sent).toHaveLength(1);
    const answer = parseBtpMessage(fakeWs.sent[0]!);
    expect(answer.type).toBe(BTPMessageType.RESPONSE);
    expect(answer.requestId).toBe(777);
    expect((answer.data as BTPMessageData).protocolData).toEqual([
      { protocolName: 'ack', contentType: 1, data: new Uint8Array([1]) },
    ]);
  });

  it('is dropped unanswered when no onMessage handler is configured (pre-#493 behavior)', async () => {
    const { fakeWs } = await createConnectedClient();

    fakeWs.triggerMessage(inboundMessageFrame(1));
    await flush();

    expect(fakeWs.sent).toHaveLength(0);
  });

  it('answers a throwing handler with an ERROR frame carrying the same requestId', async () => {
    const onMessage = vi.fn(() => {
      throw new Error('boom');
    });
    const { fakeWs } = await createConnectedClient({ onMessage });

    fakeWs.triggerMessage(inboundMessageFrame(5));
    await flush();

    expect(fakeWs.sent).toHaveLength(1);
    const answer = parseBtpMessage(fakeWs.sent[0]!);
    expect(answer.type).toBe(BTPMessageType.ERROR);
    expect(answer.requestId).toBe(5);
  });
});

describe('IsomorphicBtpClient — server-originated TRANSFER (toon-client#493)', () => {
  it('dispatches to onTransfer with the amount and answers RESPONSE', async () => {
    const onTransfer = vi.fn((): BtpHandlerResponse => ({}));
    const { fakeWs } = await createConnectedClient({ onTransfer });

    fakeWs.triggerMessage(inboundTransferFrame(42, 1_000_000n));
    await flush();

    expect(onTransfer).toHaveBeenCalledTimes(1);
    expect(onTransfer.mock.calls[0]![0]).toMatchObject({
      requestId: 42,
      amount: 1_000_000n,
    });

    const answer = parseBtpMessage(fakeWs.sent[0]!);
    expect(answer.type).toBe(BTPMessageType.RESPONSE);
    expect(answer.requestId).toBe(42);
  });

  it('still answers an empty RESPONSE when no onTransfer handler is configured', async () => {
    const { fakeWs } = await createConnectedClient();

    fakeWs.triggerMessage(inboundTransferFrame(9, 500n));
    await flush();

    expect(fakeWs.sent).toHaveLength(1);
    const answer = parseBtpMessage(fakeWs.sent[0]!);
    expect(answer.type).toBe(BTPMessageType.RESPONSE);
    expect(answer.requestId).toBe(9);
    expect((answer.data as BTPMessageData).protocolData).toEqual([]);
  });
});

describe('IsomorphicBtpClient — id-space separation (toon-client#493)', () => {
  it('a colliding inbound requestId never resolves a pending outbound request', async () => {
    const onMessage = vi.fn((): BtpHandlerResponse => ({}));
    const { client, fakeWs } = await createConnectedClient({ onMessage });

    const sendPromise = client.sendPacket({
      type: 12,
      amount: 1000n,
      destination: 'g.toon.alice',
      executionCondition: new Uint8Array(32),
      expiresAt: new Date(Date.now() + 30_000),
      data: new Uint8Array(0),
    });

    // The outbound PREPARE's requestId — the first frame `sendPacket` wrote.
    const outboundFrame = parseBtpMessage(fakeWs.sent[0]!);
    const collidingId = outboundFrame.requestId;
    fakeWs.sent.length = 0;

    // A server-originated MESSAGE arrives carrying the SAME id.
    fakeWs.triggerMessage(inboundMessageFrame(collidingId));
    await flush();

    // Dispatched as an inbound request (answered), not mistaken for the answer
    // to our own outbound send.
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: collidingId })
    );
    let settled = false;
    void sendPromise.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    // The real RESPONSE for our own outbound send still resolves it correctly.
    fakeWs.triggerMessage(
      serializeBtpMessage({
        type: BTPMessageType.RESPONSE,
        requestId: collidingId,
        data: {
          protocolData: [],
          ilpPacket: new Uint8Array([13, ...new Uint8Array(32), 0]),
        },
      })
    );
    const result = await sendPromise;
    expect(result.type).toBe(13);
  });
});

describe('IsomorphicBtpClient — disconnect fails in-flight inbound work loudly (toon-client#493)', () => {
  it('calls onInboundError for a handler that had not yet replied when disconnect() runs', async () => {
    let resolveHandler: (r: BtpHandlerResponse) => void = () => {};
    const onMessage = vi.fn(
      () =>
        new Promise<BtpHandlerResponse>((resolve) => {
          resolveHandler = resolve;
        })
    );
    const onInboundError = vi.fn();
    const { client, fakeWs } = await createConnectedClient({
      onMessage,
      onInboundError,
    });

    fakeWs.triggerMessage(inboundMessageFrame(3));
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(1);

    await client.disconnect();

    expect(onInboundError).toHaveBeenCalledTimes(1);
    expect(onInboundError.mock.calls[0]![1]).toBe(3);

    // The handler settling after the fact must not throw or send anything further.
    expect(() => resolveHandler({})).not.toThrow();
    await flush();
    expect(fakeWs.sent).toHaveLength(0);
  });

  it('calls onInboundError when the socket closes before the handler replies', async () => {
    const onMessage = vi.fn(() => new Promise<BtpHandlerResponse>(() => {}));
    const onInboundError = vi.fn();
    const { fakeWs } = await createConnectedClient({
      onMessage,
      onInboundError,
    });

    fakeWs.triggerMessage(inboundMessageFrame(11));
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(1);

    fakeWs.triggerClose();

    expect(onInboundError).toHaveBeenCalledTimes(1);
    expect(onInboundError.mock.calls[0]![1]).toBe(11);
  });
});

/** Decodes the JSON body of a greeting frame's `auth` protocolData entry. */
function decodeAuthGreeting(frame: Uint8Array): Record<string, unknown> {
  const message = parseBtpMessage(frame);
  const data = message.data as BTPMessageData;
  const authEntry = data.protocolData.find((pd) => pd.protocolName === 'auth');
  if (!authEntry) throw new Error('frame carries no auth protocolData entry');
  return JSON.parse(new TextDecoder().decode(authEntry.data)) as Record<
    string,
    unknown
  >;
}

describe('IsomorphicBtpClient — channel declaration on the greeting (toon-client#513)', () => {
  it('sends the greeting exactly as before when getChannelDeclaration is unset', async () => {
    const fakeWs = new FakeWebSocket();
    const client = new IsomorphicBtpClient({
      url: 'ws://test',
      peerId: 'p',
      authToken: 's',
      createWebSocket: () => fakeWs as unknown as WebSocket,
    });

    const connectPromise = client.connect();
    fakeWs.triggerOpen();
    await flush();
    const authFrame = parseBtpMessage(fakeWs.sent[0]!);
    fakeWs.triggerMessage(
      serializeBtpMessage({
        type: BTPMessageType.RESPONSE,
        requestId: authFrame.requestId,
        data: { protocolData: [], ilpPacket: new Uint8Array(0) },
      })
    );
    await connectPromise;

    expect(decodeAuthGreeting(fakeWs.sent[0]!)).toEqual({
      peerId: 'p',
      secret: 's',
    });
  });

  it('declares the channel on the initial greeting when one is already known', async () => {
    const declaration: BtpChannelDeclaration = {
      blockchain: 'evm',
      channelId: '0x' + '1'.repeat(64),
      expires: 1234,
      signature: '0xsig',
    };
    const fakeWs = new FakeWebSocket();
    const client = new IsomorphicBtpClient({
      url: 'ws://test',
      peerId: 'p',
      authToken: 's',
      createWebSocket: () => fakeWs as unknown as WebSocket,
      getChannelDeclaration: () => declaration,
    });

    const connectPromise = client.connect();
    fakeWs.triggerOpen();
    await flush();
    const authFrame = parseBtpMessage(fakeWs.sent[0]!);
    fakeWs.triggerMessage(
      serializeBtpMessage({
        type: BTPMessageType.RESPONSE,
        requestId: authFrame.requestId,
        data: { protocolData: [], ilpPacket: new Uint8Array(0) },
      })
    );
    await connectPromise;

    expect(decodeAuthGreeting(fakeWs.sent[0]!)['channel']).toEqual(
      declaration
    );
  });

  it('reauthenticate() re-declares a channel that became known after connect, without a new socket', async () => {
    const known: { declaration?: BtpChannelDeclaration } = {};
    const { client, fakeWs } = await createConnectedClient({
      getChannelDeclaration: () => known.declaration,
    });

    known.declaration = {
      blockchain: 'solana',
      channelAccount: 'ChanAcct11111111111111111111111111111111',
      expires: 999,
      signature: 'base64sig',
    };

    const reauthPromise = client.reauthenticate();
    await flush();
    const authFrame = parseBtpMessage(fakeWs.sent[0]!);
    fakeWs.triggerMessage(
      serializeBtpMessage({
        type: BTPMessageType.RESPONSE,
        requestId: authFrame.requestId,
        data: { protocolData: [], ilpPacket: new Uint8Array(0) },
      })
    );
    await reauthPromise;

    expect(decodeAuthGreeting(fakeWs.sent[0]!)['channel']).toEqual(
      known.declaration
    );
    expect(fakeWs.closed).toBe(false);
  });

  it('reauthenticate() is a no-op when not connected', async () => {
    const fakeWs = new FakeWebSocket();
    const client = new IsomorphicBtpClient({
      url: 'ws://test',
      peerId: 'p',
      authToken: 's',
      createWebSocket: () => fakeWs as unknown as WebSocket,
    });

    await expect(client.reauthenticate()).resolves.toBeUndefined();
    expect(fakeWs.sent).toHaveLength(0);
  });
});
