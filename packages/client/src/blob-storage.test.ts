import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { BLOB_STORAGE_REQUEST_KIND } from '@toon-protocol/core';
import { requestBlobStorage } from './blob-storage.js';
import type { ToonClient } from './ToonClient.js';
import type { PublishEventResult } from './types.js';

/**
 * Builds a minimal ToonClient stub whose `publishEvent` records the event +
 * options it was called with and returns a caller-supplied result.
 */
function mockClient(result: PublishEventResult): {
  client: ToonClient;
  publishEvent: ReturnType<typeof vi.fn>;
} {
  const publishEvent = vi.fn(async () => result);
  const client = { publishEvent } as unknown as ToonClient;
  return { client, publishEvent };
}

/** base64(utf8(txId)) — the FULFILL data contract for single-packet uploads. */
function fulfillData(txId: string): string {
  return Buffer.from(txId, 'utf-8').toString('base64');
}

describe('requestBlobStorage', () => {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  // 43-char base64url Arweave tx ID.
  const TX_ID = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

  it('builds a kind:5094 request with blob, bid, and content type', async () => {
    const { client, publishEvent } = mockClient({
      success: true,
      eventId: 'evt',
      data: fulfillData(TX_ID),
    });

    await requestBlobStorage(client, secretKey, {
      blobData: new TextEncoder().encode('hello arweave'),
      contentType: 'text/plain',
      bid: '130',
      destination: 'g.toon.peer1',
    });

    expect(publishEvent).toHaveBeenCalledTimes(1);
    const [event, options] = publishEvent.mock.calls[0] as [
      NostrEvent,
      Record<string, unknown>,
    ];

    expect(event.kind).toBe(BLOB_STORAGE_REQUEST_KIND);
    expect(event.pubkey).toBe(pubkey);

    // i tag carries base64 blob with type 'blob'
    const iTag = event.tags.find((t) => t[0] === 'i');
    expect(iTag).toEqual([
      'i',
      Buffer.from('hello arweave', 'utf-8').toString('base64'),
      'blob',
    ]);

    // bid + output tags
    expect(event.tags.find((t) => t[0] === 'bid')).toEqual([
      'bid',
      '130',
      'usdc',
    ]);
    expect(event.tags.find((t) => t[0] === 'output')).toEqual([
      'output',
      'text/plain',
    ]);

    // destination forwarded to publishEvent
    expect(options.destination).toBe('g.toon.peer1');
  });

  it('decodes the base64 FULFILL data into an Arweave tx ID', async () => {
    const { client } = mockClient({
      success: true,
      eventId: 'evt',
      data: fulfillData(TX_ID),
    });

    const result = await requestBlobStorage(client, secretKey, {
      blobData: new TextEncoder().encode('payload'),
      bid: '70',
    });

    expect(result.success).toBe(true);
    expect(result.txId).toBe(TX_ID);
    expect(result.eventId).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it('derives the bid from ilpAmount when bid is omitted', async () => {
    const { client, publishEvent } = mockClient({
      success: true,
      data: fulfillData(TX_ID),
    });

    await requestBlobStorage(client, secretKey, {
      blobData: new Uint8Array([1, 2, 3]),
      ilpAmount: 999n,
    });

    const [event, options] = publishEvent.mock.calls[0] as [
      NostrEvent,
      Record<string, unknown>,
    ];
    expect(event.tags.find((t) => t[0] === 'bid')).toEqual([
      'bid',
      '999',
      'usdc',
    ]);
    expect(options.ilpAmount).toBe(999n);
  });

  it('returns an error without publishing when no bid/ilpAmount is supplied', async () => {
    const { client, publishEvent } = mockClient({ success: true });

    const result = await requestBlobStorage(client, secretKey, {
      blobData: new Uint8Array([1]),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bid/i);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('propagates a rejected publish as an error result', async () => {
    const { client } = mockClient({
      success: false,
      error: 'Event rejected: F06 - no route',
    });

    const result = await requestBlobStorage(client, secretKey, {
      blobData: new Uint8Array([1]),
      bid: '10',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('F06');
    expect(result.txId).toBeUndefined();
  });

  it('errors when FULFILL data is missing', async () => {
    const { client } = mockClient({ success: true, eventId: 'evt' });

    const result = await requestBlobStorage(client, secretKey, {
      blobData: new Uint8Array([1]),
      bid: '10',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no data/i);
  });

  it('errors when decoded FULFILL data is not a valid Arweave tx ID', async () => {
    const { client } = mockClient({
      success: true,
      data: fulfillData('not-a-tx-id'),
    });

    const result = await requestBlobStorage(client, secretKey, {
      blobData: new Uint8Array([1]),
      bid: '10',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a valid Arweave tx ID/i);
  });
});
