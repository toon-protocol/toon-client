import { describe, it, expect, afterEach } from 'vitest';
import {
  DEVNET,
  devnetDaemonEnv,
  isDevnetE2eEnabled,
  evmAddressForMnemonic,
  fundDevnetWallet,
} from './devnet.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

describe('devnet e2e wiring', () => {
  const saved = process.env['TOON_DEVNET_E2E'];
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, 'TOON_DEVNET_E2E');
    else process.env['TOON_DEVNET_E2E'] = saved;
  });

  it('exposes the deployed devnet endpoints (proxy → /ilp, g.proxy, chain 31337)', () => {
    expect(DEVNET.proxyUrl).toBe('https://proxy.devnet.toonprotocol.dev');
    expect(DEVNET.destination).toBe('g.proxy');
    expect(DEVNET.relayUrl).toBe('wss://relay-ws.devnet.toonprotocol.dev');
    expect(DEVNET.faucetUrl).toBe('https://faucet.devnet.toonprotocol.dev');
    expect(DEVNET.evmChainId).toBe(31337);
    expect(DEVNET.usdcDecimals).toBe(6);
  });

  it('builds a daemon env that routes writes through the proxy (no BTP)', () => {
    const env = devnetDaemonEnv();
    expect(env['TOON_CLIENT_PROXY_URL']).toBe(DEVNET.proxyUrl);
    expect(env['TOON_CLIENT_DESTINATION']).toBe('g.proxy');
    expect(env['TOON_CLIENT_BTP_URL']).toBeUndefined();
  });

  it('is gated OFF by default', () => {
    Reflect.deleteProperty(process.env, 'TOON_DEVNET_E2E');
    expect(isDevnetE2eEnabled()).toBe(false);
  });

  it('derives a deterministic 0x EVM address from the mnemonic', () => {
    const addr = evmAddressForMnemonic(MNEMONIC);
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Stable across calls.
    expect(evmAddressForMnemonic(MNEMONIC)).toBe(addr);
  });

  it('fundDevnetWallet refuses to hit the network when the gate is off', async () => {
    Reflect.deleteProperty(process.env, 'TOON_DEVNET_E2E');
    await expect(fundDevnetWallet(MNEMONIC)).rejects.toThrow(/disabled/);
  });

  it('fundDevnetWallet rejects non-EVM chains as deferred (WS3) even when gated on', async () => {
    process.env['TOON_DEVNET_E2E'] = '1';
    await expect(fundDevnetWallet(MNEMONIC, 'solana')).rejects.toThrow(
      /deferred \(WS3\)/
    );
  });
});
