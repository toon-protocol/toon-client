import { describe, it, expect, vi } from 'vitest';
import { readMinaDepositTotal } from './mina-deposit.js';

const ZKAPP = 'B62qrH1As4odHiNyKpTZMHaM6tRs6gi5DJ53efZKQBtbaR5CUctbDs6';
const URL = 'https://api.minascan.io/node/devnet/v1/graphql';

function gqlResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readMinaDepositTotal', () => {
  it('returns zkappState[4] (depositTotal) as a bigint', async () => {
    // appState order: [channelHash, balanceCommitment, nonceField, channelState, depositTotal, ...]
    const fetchImpl = vi.fn().mockResolvedValue(
      gqlResponse({
        data: {
          account: {
            zkappState: ['1', '2', '3', '1', '4000000', '0', '0', '0'],
          },
        },
      })
    );
    const dt = await readMinaDepositTotal(
      URL,
      ZKAPP,
      fetchImpl as unknown as typeof fetch
    );
    expect(dt).toBe(4_000_000n);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(JSON.parse(init.body).variables.pk).toBe(ZKAPP);
  });

  it('throws on a non-200 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(gqlResponse({}, 502));
    await expect(
      readMinaDepositTotal(URL, ZKAPP, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/HTTP 502/);
  });

  it('throws on a GraphQL errors payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        gqlResponse({ errors: [{ message: 'account not found' }] })
      );
    await expect(
      readMinaDepositTotal(URL, ZKAPP, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/account not found/);
  });

  it('throws when zkappState is missing or too short (not a zkApp)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        gqlResponse({ data: { account: { zkappState: null } } })
      );
    await expect(
      readMinaDepositTotal(URL, ZKAPP, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/no readable zkappState/);

    const shortFetch = vi
      .fn()
      .mockResolvedValue(
        gqlResponse({ data: { account: { zkappState: ['1', '2'] } } })
      );
    await expect(
      readMinaDepositTotal(URL, ZKAPP, shortFetch as unknown as typeof fetch)
    ).rejects.toThrow(/no readable zkappState/);
  });
});
