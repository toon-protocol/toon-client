import { describe, it, expect } from 'vitest';
import { parseFulfillHttp, parseFulfillHttpBytes } from './fulfill-http.js';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

describe('parseFulfillHttp', () => {
  it('parses a 200 response with a JSON body', () => {
    const body = '{"accept":true,"txId":"abc"}';
    const r = parseFulfillHttp(
      b64(
        `HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      )
    );
    expect(r.isHttp).toBe(true);
    expect(r.status).toBe(200);
    expect(r.statusText).toBe('OK');
    expect(r.body).toBe(body);
  });

  it('parses a 404 response (status + body)', () => {
    const r = parseFulfillHttp(
      b64('HTTP/1.1 404 Not Found\r\ncontent-length: 13\r\n\r\n404 Not Found')
    );
    expect(r.isHttp).toBe(true);
    expect(r.status).toBe(404);
    expect(r.body).toBe('404 Not Found');
  });

  it('tolerates a missing reason phrase', () => {
    const r = parseFulfillHttp(b64('HTTP/1.1 204\r\n\r\n'));
    expect(r.isHttp).toBe(true);
    expect(r.status).toBe(204);
    expect(r.statusText).toBe('');
  });

  it('reports isHttp:false for a non-HTTP payload (no status line)', () => {
    const r = parseFulfillHttp(b64('ack:1'));
    expect(r.isHttp).toBe(false);
    expect(r.status).toBe(0);
  });

  it('reports isHttp:false for a bare Arweave-tx-id-like payload', () => {
    const r = parseFulfillHttp(b64('abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE'));
    expect(r.isHttp).toBe(false);
  });

  it('reports isHttp:false for a present-but-malformed status line', () => {
    const r = parseFulfillHttpBytes(
      new TextEncoder().encode('HTTP/1.1 NOTACODE\r\n\r\nbody')
    );
    expect(r.isHttp).toBe(false);
  });

  it('handles a response with no body separator', () => {
    const r = parseFulfillHttpBytes(
      new TextEncoder().encode('HTTP/1.1 200 OK')
    );
    expect(r.isHttp).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toBe('');
  });
});
