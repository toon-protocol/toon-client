import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSigner } from './evm-signer.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('EvmSigner', () => {
  it('derives the address from a hex key, with or without 0x', () => {
    const expected = privateKeyToAccount(KEY).address;
    expect(new EvmSigner(KEY).address).toBe(expected);
    expect(new EvmSigner(KEY.slice(2)).address).toBe(expected);
  });

  it('accepts raw key bytes', () => {
    const bytes = Uint8Array.from(Buffer.from(KEY.slice(2), 'hex'));
    expect(new EvmSigner(bytes).address).toBe(privateKeyToAccount(KEY).address);
  });

  it('exposes a viem account that signs as that address', async () => {
    const signer = new EvmSigner(KEY);
    expect(signer.account.address).toBe(signer.address);
    const signature = await signer.account.signMessage({ message: 'hi' });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
