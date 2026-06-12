import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveTransport } from './index.js';

// Mock the node-only daemon + socks helpers so resolveTransport's auto-start
// branch is exercised WITHOUT downloading a real binary or spawning anon.
const startManagedAnonProxy = vi.fn();
vi.mock('./anon-proxy.js', () => ({
  startManagedAnonProxy: (...args: unknown[]) => startManagedAnonProxy(...args),
}));
vi.mock('./socks5.js', () => ({
  createSocks5WebSocketFactory: (proxy: string) => () => ({ proxy }),
  createSocks5Fetch: (proxy: string) => () => ({ proxy }),
  probeSocks5Proxy: vi.fn(async () => {}),
}));

const stop = vi.fn(async () => {});

beforeEach(() => {
  startManagedAnonProxy.mockReset();
  stop.mockReset();
  startManagedAnonProxy.mockResolvedValue({
    socksProxy: 'socks5h://127.0.0.1:9050',
    stop,
  });
  delete process.env['ANYONE_PROXY_URLS'];
});

afterEach(() => {
  delete process.env['ANYONE_PROXY_URLS'];
});

describe('resolveTransport — managed anon auto-start', () => {
  it('auto-starts the managed proxy for a .anyone btpUrl with no explicit proxy', async () => {
    const resolved = await resolveTransport(
      undefined,
      'ws://abc234def.anyone:3000/btp',
      undefined
    );
    expect(startManagedAnonProxy).toHaveBeenCalledTimes(1);
    expect(resolved.createWebSocket).toBeTypeOf('function');
    expect(resolved.httpClient).toBeTypeOf('function');
    expect(resolved.stopManagedProxy).toBe(stop);
  });

  it('auto-starts for a { type: "direct" } transport on a .anyone host', async () => {
    const resolved = await resolveTransport(
      { type: 'direct' },
      'ws://abc234def.anyone:3000/btp',
      undefined
    );
    expect(startManagedAnonProxy).toHaveBeenCalledTimes(1);
    expect(resolved.stopManagedProxy).toBe(stop);
  });

  it('does NOT auto-start for a non-.anyone host', async () => {
    const resolved = await resolveTransport(
      undefined,
      'ws://localhost:3000/btp',
      undefined
    );
    expect(startManagedAnonProxy).not.toHaveBeenCalled();
    expect(resolved).toEqual({});
  });

  it('does NOT auto-start when an explicit socks5 proxy is given (.anyone host)', async () => {
    const resolved = await resolveTransport(
      { type: 'socks5', socksProxy: 'socks5h://127.0.0.1:1080' },
      'ws://abc234def.anyone:3000/btp',
      undefined
    );
    expect(startManagedAnonProxy).not.toHaveBeenCalled();
    // Goes through the explicit-socks5 path instead.
    expect(resolved.createWebSocket).toBeTypeOf('function');
    expect(resolved.stopManagedProxy).toBeUndefined();
  });

  it('does NOT auto-start when an explicit gateway transport is given (.anyone host)', async () => {
    const resolved = await resolveTransport(
      { type: 'gateway', gatewayUrl: 'https://gw.example.com' },
      'ws://abc234def.anyone:3000/btp',
      'http://abc234def.anyone:8080'
    );
    expect(startManagedAnonProxy).not.toHaveBeenCalled();
    expect(resolved.btpUrl).toBeDefined();
  });

  it('does NOT auto-start when ANYONE_PROXY_URLS is set (escape hatch)', async () => {
    process.env['ANYONE_PROXY_URLS'] = 'socks5h://127.0.0.1:9999';
    const resolved = await resolveTransport(
      undefined,
      'ws://abc234def.anyone:3000/btp',
      undefined
    );
    expect(startManagedAnonProxy).not.toHaveBeenCalled();
    expect(resolved).toEqual({});
  });

  it('does NOT auto-start when managedAnonProxy is false (opt-out)', async () => {
    const resolved = await resolveTransport(
      undefined,
      'ws://abc234def.anyone:3000/btp',
      undefined,
      { managedAnonProxy: false }
    );
    expect(startManagedAnonProxy).not.toHaveBeenCalled();
    expect(resolved).toEqual({});
  });

  it('passes a custom SOCKS port through to the managed proxy', async () => {
    await resolveTransport(undefined, 'ws://abc.anyone:3000/btp', undefined, {
      managedAnonSocksPort: 19050,
    });
    expect(startManagedAnonProxy).toHaveBeenCalledWith({ socksPort: 19050 });
  });
});
