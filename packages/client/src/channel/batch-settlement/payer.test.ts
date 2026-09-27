import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { BatchSettlementPayer, voucherRefusalIsNotAdvancing } from './payer.js';
import { BatchChannelManager } from './manager.js';
import { parseSelfDescription } from '../../connector/self-description.js';
import {
  ChannelNotOpenError,
  ConfigError,
  FacilitatorError,
} from '../../client/errors.js';

const PAYER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const CONNECTOR_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const DESCRIPTION = parseSelfDescription({
  ilpAddresses: ['g.toon.node'],
  batchSettlements: [
    {
      network: 'eip155:84532',
      asset: USDC,
      payTo: CONNECTOR_ADDRESS,
      receiverAuthorizer: CONNECTOR_ADDRESS,
      withdrawDelay: 86_400,
      name: 'USDC',
      version: '2',
    },
  ],
});

interface Posted {
  paymentPayload: {
    payload: {
      deposit: { amount: string };
      voucher: { maxClaimableAmount: string; channelId: string };
    };
  };
}

function facilitator(
  answer: unknown = {
    success: true,
    transaction: '0xabc',
    network: 'eip155:84532',
  }
) {
  const posted: Posted[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://facilitator.test/settle');
    posted.push(JSON.parse(init!.body as string) as Posted);
    return new Response(JSON.stringify(answer));
  }) as typeof fetch;
  return { posted, fetchImpl };
}

function payer(
  deposit = 10_000n,
  fetchImpl?: typeof fetch,
  facilitatorUrl = 'https://facilitator.test'
) {
  const manager = new BatchChannelManager();
  const p = new BatchSettlementPayer({
    connector: 'https://node.example',
    manager,
    deposit,
    evm: { account: PAYER, facilitatorUrl },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { p, manager };
}

describe('BatchSettlementPayer on Base', () => {
  it('steps aside when the node offers no batch-settlement on the chain', async () => {
    const { p } = payer();
    expect(
      await p.claimFor(parseSelfDescription({}), 'evm', 1_000n)
    ).toBeUndefined();
  });

  it('onboards through the facilitator, and the first packet carries the deposit’s own voucher', async () => {
    const f = facilitator();
    const { p, manager } = payer(10_000n, f.fetchImpl);
    const voucher = await p.claimFor(DESCRIPTION, 'evm', 1_000n);

    expect(f.posted).toHaveLength(1);
    const deposited = f.posted[0]!.paymentPayload.payload;
    expect(deposited.deposit.amount).toBe('10000');
    expect(deposited.voucher.maxClaimableAmount).toBe('1000');
    expect(voucher!.claim['signature']).toBe(
      (
        deposited.voucher as unknown as { signature: string }
      ).signature.toLowerCase()
    );
    expect(voucher!.channelId).toBe(deposited.voucher.channelId);
    expect(voucher!.cumulative).toBe(1_000n);
    expect(voucher!.claim['scheme']).toBe('batch-settlement');
    expect(manager.depositTotal(voucher!.channelId)).toBe(10_000n);

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'x402 Batch Settlement',
        version: '1',
        chainId: 84532,
        verifyingContract: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003',
      },
      types: {
        Voucher: [
          { name: 'channelId', type: 'bytes32' },
          { name: 'maxClaimableAmount', type: 'uint128' },
        ],
      },
      primaryType: 'Voucher',
      message: {
        channelId: voucher!.channelId as Hex,
        maxClaimableAmount: 1_000n,
      },
      signature: voucher!.claim['signature'] as Hex,
    });
    expect(recovered).toBe(PAYER.address);
  });

  it('signs the running total on later packets, without another deposit', async () => {
    const f = facilitator();
    const { p } = payer(10_000n, f.fetchImpl);
    await p.claimFor(DESCRIPTION, 'evm', 1_000n);
    const second = await p.claimFor(DESCRIPTION, 'evm', 500n);
    expect(second!.cumulative).toBe(1_500n);
    expect(f.posted).toHaveLength(1);
  });

  it('gives a refused charge back, and keeps a not-advancing or unanswered one', async () => {
    const f = facilitator();
    const { p } = payer(10_000n, f.fetchImpl);
    (await p.claimFor(DESCRIPTION, 'evm', 1_000n))!.settle({
      kind: 'refused',
      notAdvancing: false,
    });
    expect((await p.claimFor(DESCRIPTION, 'evm', 1_000n))!.cumulative).toBe(
      1_000n
    );
    (await p.claimFor(DESCRIPTION, 'evm', 1_000n))!.settle({ kind: 'unknown' });
    expect((await p.claimFor(DESCRIPTION, 'evm', 1_000n))!.cumulative).toBe(
      3_000n
    );
  });

  it('tops up through the facilitator when the deposit cannot cover the next voucher', async () => {
    const f = facilitator();
    const { p, manager } = payer(2_000n, f.fetchImpl);
    await p.claimFor(DESCRIPTION, 'evm', 1_500n);
    const next = await p.claimFor(DESCRIPTION, 'evm', 1_000n);
    expect(f.posted).toHaveLength(2);
    const topUp = f.posted[1]!.paymentPayload.payload;
    expect(topUp.deposit.amount).toBe('2000');
    expect(topUp.voucher.maxClaimableAmount).toBe('2500');
    expect(next!.cumulative).toBe(2_500n);
    expect(manager.depositTotal(next!.channelId)).toBe(4_000n);
  });

  it('onboards a fresh channel instead of voucher-ing on one this client is leaving', async () => {
    const f = facilitator();
    const { p, manager } = payer(10_000n, f.fetchImpl);
    const first = await p.claimFor(DESCRIPTION, 'evm', 1_000n);
    manager.markClosing(first!.channelId, 1n, 2n);
    const next = await p.claimFor(DESCRIPTION, 'evm', 1_000n);
    expect(f.posted).toHaveLength(2);
    expect(next!.channelId).not.toBe(first!.channelId);
    expect(next!.cumulative).toBe(1_000n);
  });

  it('with autoOpen off, refuses to open or top up on a packet, and opens on request', async () => {
    const f = facilitator();
    const manager = new BatchChannelManager();
    const p = new BatchSettlementPayer({
      connector: 'https://node.example',
      manager,
      deposit: 2_000n,
      evm: { account: PAYER, facilitatorUrl: 'https://facilitator.test' },
      fetch: f.fetchImpl,
      autoOpen: false,
    });
    await expect(p.claimFor(DESCRIPTION, 'evm', 1_000n)).rejects.toThrow(
      ChannelNotOpenError
    );
    expect(f.posted).toHaveLength(0);

    const opened = await p.open(DESCRIPTION, 'evm');
    // The deposit's voucher is one unit, and it is not counted as spent.
    expect(f.posted[0]!.paymentPayload.payload.voucher.maxClaimableAmount).toBe(
      '1'
    );
    expect(manager.signedSoFar(opened!.channelId)).toBe(0n);
    expect((await p.claimFor(DESCRIPTION, 'evm', 1_500n))!.cumulative).toBe(
      1_500n
    );
    await expect(p.claimFor(DESCRIPTION, 'evm', 1_000n)).rejects.toThrow(
      ChannelNotOpenError
    );
  });

  it('needs a facilitator to onboard', async () => {
    const { p } = payer(10_000n, undefined, '');
    await expect(p.claimFor(DESCRIPTION, 'evm', 1_000n)).rejects.toThrow(
      ConfigError
    );
  });

  it('explains a Permit2 deposit refused for want of an allowance', async () => {
    const f = facilitator({
      success: false,
      errorReason: 'invalid_batch_settlement_evm_permit2_allowance_required',
    });
    const manager = new BatchChannelManager();
    const p = new BatchSettlementPayer({
      connector: 'https://node.example',
      manager,
      deposit: 10_000n,
      evm: {
        account: PAYER,
        facilitatorUrl: 'https://facilitator.test',
        depositMethod: 'permit2',
      },
      fetch: f.fetchImpl,
    });
    const err = await p
      .claimFor(DESCRIPTION, 'evm', 1_000n)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FacilitatorError);
    expect((err as Error).message).toMatch(/approve/);
  });
});

describe('voucherRefusalIsNotAdvancing', () => {
  it('reads the connector’s own sentences', () => {
    expect(
      voucherRefusalIsNotAdvancing(
        "claim rejected: cumulative amount goes backwards relative to this channel's watermark"
      )
    ).toBe(true);
    expect(
      voucherRefusalIsNotAdvancing(
        "claim rejected: advances value by 0, less than this route's price of 100"
      )
    ).toBe(true);
    expect(
      voucherRefusalIsNotAdvancing(
        "claim rejected: advances value by 50, less than this route's price of 100"
      )
    ).toBe(false);
    expect(
      voucherRefusalIsNotAdvancing('claim rejected: signature does not verify')
    ).toBe(false);
    expect(voucherRefusalIsNotAdvancing(undefined)).toBe(false);
  });
});
