import { describe, it, expect } from 'vitest';
import { rewriteUrlsForGateway } from './gateway.js';

describe('rewriteUrlsForGateway', () => {
  it('rewrites both btpUrl and connectorUrl', () => {
    const result = rewriteUrlsForGateway(
      'https://gateway.example.com',
      'ws://original:3000',
      'http://original:8080'
    );
    expect(result.btpUrl).toBe('wss://gateway.example.com/btp');
    expect(result.connectorUrl).toBe('https://gateway.example.com/api');
  });

  it('uses ws:// for http:// gateway', () => {
    const result = rewriteUrlsForGateway(
      'http://localhost:8000',
      'ws://peer:3000',
      'http://peer:8080'
    );
    expect(result.btpUrl).toBe('ws://localhost:8000/btp');
    expect(result.connectorUrl).toBe('http://localhost:8000/api');
  });

  it('strips trailing slash from gateway URL', () => {
    const result = rewriteUrlsForGateway(
      'https://gateway.example.com/',
      'ws://peer:3000',
      'http://peer:8080'
    );
    expect(result.btpUrl).toBe('wss://gateway.example.com/btp');
    expect(result.connectorUrl).toBe('https://gateway.example.com/api');
  });

  it('returns undefined for btpUrl when not provided', () => {
    const result = rewriteUrlsForGateway(
      'https://gateway.example.com',
      undefined,
      'http://peer:8080'
    );
    expect(result.btpUrl).toBeUndefined();
    expect(result.connectorUrl).toBe('https://gateway.example.com/api');
  });

  it('returns undefined for connectorUrl when not provided', () => {
    const result = rewriteUrlsForGateway(
      'https://gateway.example.com',
      'ws://peer:3000',
      undefined
    );
    expect(result.btpUrl).toBe('wss://gateway.example.com/btp');
    expect(result.connectorUrl).toBeUndefined();
  });
});
