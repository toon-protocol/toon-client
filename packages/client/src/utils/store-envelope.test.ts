import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { buildStoreWriteEnvelope } from './store-envelope.js';

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const event = {
  id: 'evt-id',
  pubkey: 'pk',
  created_at: 1,
  kind: 1,
  tags: [],
  content: 'hi',
  sig: 'sig',
} as unknown as NostrEvent;

describe('buildStoreWriteEnvelope', () => {
  it('defaults to POST /write (the relay paid-write surface)', () => {
    const s = decode(buildStoreWriteEnvelope(event));
    expect(s.startsWith('POST /write HTTP/1.1\r\n')).toBe(true);
  });

  it('targets POST /store for the Arweave store/DVM backend', () => {
    // Regression guard: blob uploads MUST hit /store, not /write — the store
    // backend serves /store + /health only, so /write 404s.
    const s = decode(buildStoreWriteEnvelope(event, '/store'));
    expect(s.startsWith('POST /store HTTP/1.1\r\n')).toBe(true);
  });

  it('carries the signed event verbatim as the JSON `event` body', () => {
    const s = decode(buildStoreWriteEnvelope(event, '/store'));
    const body = s.split('\r\n\r\n')[1] ?? '';
    expect(JSON.parse(body).event.id).toBe('evt-id');
  });
});
