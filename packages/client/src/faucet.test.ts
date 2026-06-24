import { describe, it, expect, vi } from 'vitest';
import { fundWallet } from './faucet.js';
import { NetworkError } from './errors.js';

const EVM_ADDR = '0x1234567890123456789012345678901234567890';
const FAUCET = 'https://faucet.devnet.toonprotocol.dev';

/** Build a mock `fetch` returning a JSON 200 and recording the call. */
function mockJsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  ) as unknown as typeof fetch;
}

describe('fundWallet (devnet faucet)', () => {
  it('POSTs the EVM address to /api/request and returns parsed JSON', async () => {
    const fetchImpl = mockJsonFetch({ ok: true, txHash: '0xabc' });
    const result = await fundWallet(FAUCET, EVM_ADDR, 'evm', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe(`${FAUCET}/api/request`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ address: EVM_ADDR });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );

    expect(result.chain).toBe('evm');
    expect(result.address).toBe(EVM_ADDR);
    expect(result.response).toEqual({ ok: true, txHash: '0xabc' });
  });

  it('tolerates a trailing slash on the faucet base URL', async () => {
    const fetchImpl = mockJsonFetch({ ok: true });
    await fundWallet(`${FAUCET}/`, EVM_ADDR, 'evm', { fetchImpl });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe(`${FAUCET}/api/request`);
  });

  it('tolerates an empty/non-JSON 200 body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 })
    ) as unknown as typeof fetch;
    const result = await fundWallet(FAUCET, EVM_ADDR, 'evm', { fetchImpl });
    expect(result.response).toBe('');
  });

  it('throws NetworkError on a non-2xx faucet response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 })
    ) as unknown as typeof fetch;
    await expect(fundWallet(FAUCET, EVM_ADDR, 'evm', { fetchImpl })).rejects
      .toBeInstanceOf(NetworkError);
  });

  it('wraps a transport failure as NetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fundWallet(FAUCET, EVM_ADDR, 'evm', { fetchImpl })).rejects
      .toBeInstanceOf(NetworkError);
  });

  it('requires faucetUrl and address', async () => {
    await expect(fundWallet('', EVM_ADDR, 'evm')).rejects.toThrow(/faucetUrl/);
    await expect(fundWallet(FAUCET, '', 'evm')).rejects.toThrow(/address/);
  });

  it('POSTs the address to the chain-specific path for solana and mina', async () => {
    const solFetch = mockJsonFetch({ success: true });
    const solResult = await fundWallet(FAUCET, 'SoLaddr', 'solana', {
      fetchImpl: solFetch,
    });
    const [solUrl, solInit] = (solFetch as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(solUrl).toBe(`${FAUCET}/api/solana/request`);
    expect(JSON.parse(solInit.body as string)).toEqual({ address: 'SoLaddr' });
    expect(solResult.chain).toBe('solana');

    const minaFetch = mockJsonFetch({ success: true });
    await fundWallet(FAUCET, 'B62addr', 'mina', { fetchImpl: minaFetch });
    const [minaUrl] = (minaFetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(minaUrl).toBe(`${FAUCET}/api/mina/request`);
  });
});
