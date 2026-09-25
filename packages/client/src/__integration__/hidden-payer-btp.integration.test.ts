/**
 * Integration test: a payer that is hiding, paying a CLEARNET connector over BTP.
 *
 * The other hidden-service suite is about reaching a connector that is itself a
 * `.anyone` node. This one is the other way round, and it is what a Hidden
 * Provider's directory publisher is (TOON_Network#165): the connector is an
 * ordinary public host — the devnet relay — and the thing being hidden is the
 * PAYER's address. Every byte it sends has to leave through the `anon` daemon,
 * the BTP websocket included, and the devnet relay pins its paid write route to
 * BTP, so there is no HTTP-only way round it.
 *
 * `socksProxy:` refuses a clearnet connector, so such a payer wires the proxy by
 * hand: `createHiddenServiceTransport(proxy)` and BOTH of its halves, `fetch` for
 * the client edge and `createWebSocket` for the BTP carriage. This suite pins
 * that contract end to end — a real SOCKS5 server, a real websocket, a real
 * sealed exchange — and pins the reason both halves are needed: `fetch` alone
 * leaves the socket to dial on its own.
 *
 * The connector's name is under `.test` (RFC 2606), which no resolver answers,
 * and the fake proxy is the only thing that knows where it is. A socket that did
 * not go through the proxy cannot reach it at all, so "it connected" is itself
 * the proof that it was proxied; the proxy's log proves the name went as a name.
 *
 * Needs no external services (loopback ephemeral ports only).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ToonClient } from '../client/ToonClient.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import {
  startFakeSocks5,
  type FakeSocks5Server,
} from '../transport/fake-socks5.js';
import {
  createHiddenServiceTransport,
  type HiddenServiceTransport,
} from '../transport/socks.js';
import {
  BTPMessageType,
  deserializeIlpPrepare,
  parseBtpMessage,
  serializeBtpMessage,
  serializeIlpFulfill,
  type BTPMessageData,
} from '../btp/protocol.js';
import { fromBase64, toBase64 } from '../utils/binary.js';

/** A clearnet-shaped name that no resolver will ever answer. */
const CLEAR_HOST = 'relay.clearnet.test';
const MNEMONIC = 'test test test test test test test test test test test junk';

describe('a hiding payer, paying a clearnet connector over BTP', () => {
  let fake: FakeTerminatingConnector;
  let origin: http.Server;
  let wss: WebSocketServer;
  let proxy: FakeSocks5Server;
  let btpConnections: number;
  let transport: HiddenServiceTransport;

  beforeAll(async () => {
    fake = new FakeTerminatingConnector({ endpoint: `http://${CLEAR_HOST}` });
    // The devnet relay's shape: the write route is pinned to BTP, so an HTTP
    // one-shot would be refused and nothing but the websocket can carry it.
    // Priced at zero so no chain is involved: what is under test is which
    // socket carries the packet, and the claim beside it rides whichever one
    // that is.
    fake.routePrice = 0n;
    fake.routes = [{ prefix: 'g.fake', price: '0', requiredTransport: 'btp' }];

    // The client edge, served by the fake over a real HTTP listener.
    origin = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        void fake
          .fetch(`${fake.endpoint}${req.url ?? '/'}`, {
            method: req.method ?? 'GET',
            ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
          })
          .then(async (answer) => {
            res.writeHead(answer.status, Object.fromEntries(answer.headers));
            res.end(Buffer.from(await answer.arrayBuffer()));
          });
      });
    });

    // The BTP carriage, on the same listener at the path the fake advertises
    // (`btpEndpoint: ws://<host>/ilp/btp`). It opens what was sealed to the fake
    // and seals the fake's answer back, so a reply the client can open proves
    // the packet crossed the socket intact.
    wss = new WebSocketServer({ server: origin, path: '/ilp/btp' });
    wss.on('connection', (socket) => {
      btpConnections += 1;
      socket.on('message', (raw: Buffer) => {
        const message = parseBtpMessage(new Uint8Array(raw));
        if (message.type !== BTPMessageType.MESSAGE) return;
        const data = message.data as BTPMessageData;
        const respond = (payload: BTPMessageData): void =>
          socket.send(
            serializeBtpMessage({
              type: BTPMessageType.RESPONSE,
              requestId: message.requestId,
              data: payload,
            })
          );

        if (data.protocolData.some((entry) => entry.protocolName === 'auth')) {
          respond({ protocolData: [] });
          return;
        }
        if (data.ilpPacket && data.ilpPacket.length > 0) {
          const prepare = deserializeIlpPrepare(data.ilpPacket);
          const fulfilled = fake.fulfill(toBase64(prepare.data));
          respond({
            protocolData: [],
            ilpPacket: serializeIlpFulfill({
              fulfillment: fromBase64(fulfilled.fulfillment),
              data: fromBase64(fulfilled.data),
            }),
          });
        }
      });
    });

    await new Promise<void>((resolve) =>
      origin.listen(0, '127.0.0.1', resolve)
    );
    const port = (origin.address() as AddressInfo).port;
    proxy = await startFakeSocks5(new Map([[CLEAR_HOST, port]]));
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  afterEach(async () => {
    await transport.close();
  });

  /** A client whose edge rides the proxy, and whose socket does only if `socketToo`. */
  function hidingClient(socketToo: boolean): Promise<ToonClient> {
    btpConnections = 0;
    proxy.requests.length = 0;
    transport = createHiddenServiceTransport(proxy.url, {
      connectTimeoutMs: 5_000,
    });
    return ToonClient.create({
      connector: fake.endpoint,
      mnemonic: MNEMONIC,
      channelStore: new InMemoryChannelStore(),
      transport: 'btp',
      btp: { maxReconnectAttempts: 0 },
      fetch: transport.fetch,
      ...(socketToo ? { createWebSocket: transport.createWebSocket } : {}),
    });
  }

  it("sends over a BTP socket that the transport's createWebSocket dialled through the proxy", async () => {
    const client = await hidingClient(true);
    try {
      const result = await client.send('g.fake.write', {
        body: '{"event":{}}',
      });

      if (!result.fulfilled)
        throw new Error(`refused: ${result.code} ${result.message}`);
      expect(result.status).toBe(200);
      expect(btpConnections).toBe(1);
      // Every connection this client made — the self-description AND the
      // websocket — reached the proxy as a NAME. One `ipv4` entry would mean
      // the payer resolved the connector itself, from its own address.
      expect(proxy.requests.length).toBeGreaterThanOrEqual(2);
      for (const request of proxy.requests) {
        expect(request).toEqual({ host: CLEAR_HOST, port: 80, kind: 'domain' });
      }
    } finally {
      await client.close();
    }
  });

  it('does not carry the socket when only fetch is handed over', async () => {
    // Why a hiding payer must pass BOTH halves. Without `createWebSocket` the
    // client opens its socket with the platform's own WebSocket, which resolves
    // and dials from this machine. Here the name resolves nowhere, so it fails
    // to connect; against a real relay it would have connected, from the
    // payer's real address, which is the leak TOON_Network#165 is about.
    const client = await hidingClient(false);
    try {
      await expect(
        client.send('g.fake.write', { body: '{"event":{}}' })
      ).rejects.toThrow(/WebSocket connection error/);
      expect(btpConnections).toBe(0);
    } finally {
      await client.close();
    }
  });
});
