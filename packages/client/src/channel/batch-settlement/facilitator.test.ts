import { describe, it, expect, vi } from 'vitest';
import { settleDeposit } from './facilitator.js';
import type { BatchSettlementEvmOffer, Eip3009DepositPayload } from './evm.js';
import { FacilitatorError, NetworkError } from '../../client/errors.js';

const OFFER: BatchSettlementEvmOffer = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '1',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  maxTimeoutSeconds: 300,
  extra: {
    receiverAuthorizer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    withdrawDelay: 86_400,
    name: 'USDC',
    version: '2',
  },
};

const PAYLOAD = {
  type: 'deposit',
  channelConfig: { withdrawDelay: 86_400 },
} as unknown as Eip3009DepositPayload;

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      })
  );
}

describe('settleDeposit', () => {
  it('posts the x402 v2 settle body to <facilitator>/settle and returns the transaction', async () => {
    const fetchImpl = fakeFetch(200, {
      success: true,
      transaction: '0xabc',
      network: 'eip155:84532',
      payer: '0x1',
    });
    const result = await settleDeposit({
      facilitatorUrl: 'https://x402.org/facilitator/',
      offer: OFFER,
      payload: PAYLOAD,
      fetchImpl,
    });
    expect(result).toEqual({ transaction: '0xabc', network: 'eip155:84532' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://x402.org/facilitator/settle');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: OFFER, payload: PAYLOAD },
      paymentRequirements: OFFER,
    });
  });

  it('throws the facilitator’s own reason when it refuses the deposit', async () => {
    const fetchImpl = fakeFetch(200, {
      success: false,
      errorReason: 'invalid_batch_settlement_evm_cumulative_below_claimed',
      transaction: '',
      network: 'eip155:84532',
    });
    const err = await settleDeposit({
      facilitatorUrl: 'https://f',
      offer: OFFER,
      payload: PAYLOAD,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect((err as FacilitatorError).reason).toBe(
      'invalid_batch_settlement_evm_cumulative_below_claimed'
    );
  });

  it('reads the refusal out of a non-2xx settle body as well', async () => {
    const fetchImpl = fakeFetch(400, {
      success: false,
      errorReason: 'invalid_batch_settlement_evm_deposit_transaction_failed',
    });
    await expect(
      settleDeposit({
        facilitatorUrl: 'https://f',
        offer: OFFER,
        payload: PAYLOAD,
        fetchImpl,
      })
    ).rejects.toMatchObject({
      reason: 'invalid_batch_settlement_evm_deposit_transaction_failed',
    });
  });

  it('sends the channel’s own withdrawDelay, which may exceed the offer’s minimum', async () => {
    const fetchImpl = fakeFetch(200, { success: true, transaction: '0xabc' });
    const longer = {
      ...PAYLOAD,
      channelConfig: { withdrawDelay: 2 * 86_400 },
    } as unknown as Eip3009DepositPayload;
    await settleDeposit({
      facilitatorUrl: 'https://f',
      offer: OFFER,
      payload: longer,
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.paymentRequirements.extra.withdrawDelay).toBe(2 * 86_400);
    expect(body.paymentPayload.accepted.extra.withdrawDelay).toBe(2 * 86_400);
    expect(OFFER.extra.withdrawDelay).toBe(86_400);
  });

  it('reads an answer that is not a settle result as unreadable, not as a network fault', async () => {
    const fetchImpl = fakeFetch(502, '<html>bad gateway</html>');
    await expect(
      settleDeposit({
        facilitatorUrl: 'https://f',
        offer: OFFER,
        payload: PAYLOAD,
        fetchImpl,
      })
    ).rejects.toMatchObject({ reason: 'unreadable_response' });
  });

  it('treats a transport failure as a network fault', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      settleDeposit({
        facilitatorUrl: 'https://f',
        offer: OFFER,
        payload: PAYLOAD,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
