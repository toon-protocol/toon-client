/**
 * Unit tests for the HTTP store-write envelope on the paid-write path
 * (fix/publish-event-store-envelope).
 *
 * Regression guard for the F01 ("Invalid HTTP envelope: malformed
 * request-line") root cause: `publishEvent` used to send the BARE TOON-encoded
 * event as the ILP PREPARE `data`. But the deployed connector is a
 * payment-proxy that terminates the paid write as HTTP-in-ILP — it decodes the
 * PREPARE `data` as a literal HTTP/1.1 request and reverse-proxies it to the
 * relay store's `POST /write`. Bare TOON has no request-line, so the proxy
 * rejects with F01.
 *
 * These tests assert at the `publishEvent` surface that the ILP `data` carried
 * to the transport decodes to a well-formed `POST /write` request-line plus a
 * JSON `{"event": <full signed event object>}` body — the exact shape the
 * deployed store accepts (proven live on devnet).
 */

import { describe, it, expect, vi } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { buildStoreWriteEnvelope } from './utils/store-envelope.js';
import { fromBase64, decodeUtf8 } from './utils/binary.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SignedBalanceProof } from './types.js';

const SECRET_KEY = new Uint8Array(32).fill(7);

function baseConfig() {
  return {
    secretKey: SECRET_KEY,
    connectorUrl: 'http://localhost:9999',
    destinationAddress: 'g.proxy.relay.store',
    ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.toon.test' },
    // Encoder used ONLY for pricing; the wire bytes are the HTTP envelope.
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
    tags: [['t', 'toon']],
    content: 'hello store',
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

/** Decode an ILP `data` (base64) into request-line / headers / body parts. */
function decodeEnvelope(dataB64: string) {
  const raw = decodeUtf8(fromBase64(dataB64));
  const sep = raw.indexOf('\r\n\r\n');
  expect(sep).toBeGreaterThan(0);
  const head = raw.slice(0, sep);
  const body = raw.slice(sep + 4);
  const [requestLine, ...headerLines] = head.split('\r\n');
  return { requestLine, headerLines, body };
}

describe('ToonClient.publishEvent HTTP store-write envelope (F01 regression)', () => {
  it('emits a well-formed POST /write envelope with the full event as JSON body', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: undefined,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };

    const event = makeEvent();
    const result = await client.publishEvent(event, { claim: makeProof() });
    expect(result.success).toBe(true);
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);

    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    const { requestLine, headerLines, body } = decodeEnvelope(
      (ilpParams as { data: string }).data
    );

    // Request-line must be exactly what the connector's decodeHttpRequest +
    // the relay store's /write route accept.
    expect(requestLine).toBe('POST /write HTTP/1.1');
    expect(headerLines).toContain('Content-Type: application/json');

    // Body is JSON carrying the FULL signed event OBJECT under `event`
    // (the store runs verifyEvent on it — it is NOT the TOON string).
    const parsed = JSON.parse(body);
    expect(parsed.event).toMatchObject({
      id: event.id,
      pubkey: event.pubkey,
      kind: 1,
      sig: event.sig,
      content: 'hello store',
    });
  });

  it('does NOT send the bare TOON bytes as the ILP data', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: undefined,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };

    await client.publishEvent(makeEvent(), { claim: makeProof() });
    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    const sentBytes = fromBase64((ilpParams as { data: string }).data);

    // The bare TOON encoding (the OLD, F01-causing payload) is [1,2,3,4].
    expect(Array.from(sentBytes)).not.toEqual([1, 2, 3, 4]);
    // It starts with the HTTP request-line instead.
    expect(decodeUtf8(sentBytes).startsWith('POST /write HTTP/1.1')).toBe(true);
  });

  it('buildStoreWriteEnvelope helper matches the publishEvent wire bytes', () => {
    const event = makeEvent();
    const bytes = buildStoreWriteEnvelope(event);
    const text = decodeUtf8(bytes);
    expect(text.startsWith('POST /write HTTP/1.1\r\n')).toBe(true);
    expect(text).toContain('\r\nContent-Type: application/json');
    expect(text).toContain('\r\n\r\n');
    const body = text.slice(text.indexOf('\r\n\r\n') + 4);
    expect(JSON.parse(body)).toEqual({ event });
  });
});
