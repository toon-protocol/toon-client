/**
 * Who pays a Base deposit's gas (toon-client#695): the facilitator, or the
 * payer from its own ETH — and, for a token without ERC-3009, who pays for the
 * one-time Permit2 approval.
 *
 * The facilitator, the token and the payer's wallet are fakes that record what
 * they were asked; the signatures are real.
 */
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, recoverTypedDataAddress, type Hex } from 'viem';
import { BatchSettlementPayer } from './payer.js';
import { BatchChannelManager } from './manager.js';
import { parseSelfDescription } from '../../connector/self-description.js';
import {
  ConfigError,
  FacilitatorError,
  InsufficientBalanceError,
} from '../../client/errors.js';
import { PERMIT2_ADDRESS, X402_BATCH_SETTLEMENT_ADDRESS } from './evm.js';
import type { EvmWalletAccess } from './deposit-gas.js';
import { must } from '../../utils/must.test-support.js';

const PAYER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const CONNECTOR_ADDRESS = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const TOKEN = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
const FACILITATOR = 'https://facilitator.test';

interface Options {
  /** What the connector names; omitted means it names none. */
  method?: 'eip3009' | 'permit2';
  connectorFacilitator?: string;
  network?: string;
  /** Permit2's allowance from the payer. */
  allowance?: bigint;
  /** The token's EIP-2612 nonce; `undefined` for a token with no permit. */
  permitNonce?: bigint;
  /** What the facilitator's /supported advertises. */
  extensions?: string[];
  /** How the facilitator answers /settle. */
  facilitator?: 'ok' | 'down' | 'refuse';
  /** The refusal's errorReason. */
  refusal?: string;
  /** The payer's ETH, wei. */
  eth?: bigint;
  depositGas?: 'auto' | 'facilitator' | 'self';
  depositMethod?: 'eip3009' | 'permit2';
  facilitatorUrl?: string | null;
}

interface Settled {
  paymentPayload: {
    payload: { deposit: { amount: string; authorization: Record<string, unknown> } };
    extensions?: Record<string, { info: Record<string, unknown> }>;
  };
}

function world(o: Options = {}) {
  const settled: Settled[] = [];
  const urls: string[] = [];
  const writes: { functionName: string; address: string; args: unknown[] }[] = [];
  const signed: Hex[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (o.facilitator === 'down') throw new TypeError('fetch failed');
    if (url.endsWith('/supported')) {
      return new Response(
        JSON.stringify({ kinds: [], extensions: o.extensions ?? [], signers: {} })
      );
    }
    settled.push(JSON.parse(init!.body as string) as Settled);
    return new Response(
      JSON.stringify(
        o.facilitator === 'refuse'
          ? { success: false, errorReason: o.refusal ?? 'unsupported_payment_flow' }
          : { success: true, transaction: '0xabc', network: 'eip155:84532' }
      )
    );
  }) as typeof fetch;

  const reader = {
    readContract: async (q: never) => {
      const { functionName } = q as { functionName: string };
      if (functionName === 'allowance') return o.allowance ?? 0n;
      if (functionName === 'nonces') {
        if (o.permitNonce === undefined) throw new Error('execution reverted');
        return o.permitNonce;
      }
      return functionName === 'channels' ? [0n, 0n] : [0n, 0];
    },
  };

  let n = 0;
  const wallet: EvmWalletAccess = {
    getBalance: async () => o.eth ?? 0n,
    getTransactionCount: async () => 3,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000n }),
    signTransaction: async (tx: never) => {
      const raw = await PAYER.signTransaction(tx);
      signed.push(raw);
      return raw;
    },
    writeContract: async (q: never) => {
      const { functionName, address, args } = q as {
        functionName: string;
        address: string;
        args: unknown[];
      };
      writes.push({ functionName, address, args });
      return `0x${(++n).toString(16).padStart(64, '0')}` as Hex;
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };

  const description = parseSelfDescription({
    ilpAddresses: ['g.toon.node'],
    batchSettlements: [
      {
        network: o.network ?? 'eip155:84532',
        asset: TOKEN,
        payTo: CONNECTOR_ADDRESS,
        receiverAuthorizer: CONNECTOR_ADDRESS,
        withdrawDelay: 86_400,
        name: 'Mock USD',
        version: '1',
        ...(o.method ? { assetTransferMethod: o.method } : {}),
        ...(o.connectorFacilitator ? { facilitator: o.connectorFacilitator } : {}),
      },
    ],
  });

  const manager = new BatchChannelManager();
  const payer = new BatchSettlementPayer({
    connector: 'https://node.example',
    manager,
    deposit: 10_000n,
    evm: {
      account: PAYER,
      ...(o.facilitatorUrl === null ? {} : { facilitatorUrl: o.facilitatorUrl ?? FACILITATOR }),
      ...(o.depositMethod ? { depositMethod: o.depositMethod } : {}),
      ...(o.depositGas ? { depositGas: o.depositGas } : {}),
      reader,
      wallet,
    },
    fetch: fetchImpl,
  });
  return { payer, manager, description, settled, urls, writes, signed };
}

describe('a token with ERC-3009 (the default)', () => {
  it('deposits through the facilitator, spending none of the payer’s gas', async () => {
    const w = world({ eth: 10n ** 18n });
    await w.payer.open(w.description, 'evm');
    expect(w.settled).toHaveLength(1);
    expect(w.settled[0]?.paymentPayload.payload.deposit.authorization).toHaveProperty(
      'erc3009Authorization'
    );
    expect(w.writes).toEqual([]);
  });
});

describe('a token without ERC-3009, deposited through Permit2', () => {
  it('takes the method from the connector, and asks the facilitator for nothing extra once Permit2 is approved', async () => {
    const w = world({ method: 'permit2', allowance: 10n ** 30n });
    await w.payer.open(w.description, 'evm');
    const { paymentPayload } = must(w.settled[0]);
    expect(paymentPayload.payload.deposit.authorization).toHaveProperty('permit2Authorization');
    expect(paymentPayload.extensions).toBeUndefined();
  });

  it('with an EIP-2612 permit, has the facilitator fold a permit for Permit2 into the deposit', async () => {
    const w = world({
      method: 'permit2',
      permitNonce: 7n,
      extensions: ['eip2612GasSponsoring', 'erc20ApprovalGasSponsoring'],
    });
    await w.payer.open(w.description, 'evm');
    const info = must(must(w.settled[0]).paymentPayload.extensions)['eip2612GasSponsoring']?.info;
    expect(info).toMatchObject({
      from: PAYER.address,
      asset: TOKEN,
      spender: PERMIT2_ADDRESS,
      amount: '10000',
      nonce: '7',
      version: '1',
    });
    const permit2 = must(w.settled[0]).paymentPayload.payload.deposit.authorization[
      'permit2Authorization'
    ] as { deadline: string };
    // The permit expires with the Permit2 authorization it serves.
    expect(must(info)['deadline']).toBe(permit2.deadline);
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Mock USD', version: '1', chainId: 84532, verifyingContract: TOKEN },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: PAYER.address,
        spender: PERMIT2_ADDRESS,
        value: 10_000n,
        nonce: 7n,
        deadline: BigInt(permit2.deadline),
      },
      signature: must(info)['signature'] as Hex,
    });
    expect(recovered).toBe(PAYER.address);
    expect(w.writes).toEqual([]);
  });

  it('with neither, hands the facilitator the payer’s signed, unsent approve(Permit2) to fund and broadcast', async () => {
    const w = world({ method: 'permit2', extensions: ['erc20ApprovalGasSponsoring'] });
    await w.payer.open(w.description, 'evm');
    const info = must(must(w.settled[0]).paymentPayload.extensions)['erc20ApprovalGasSponsoring']
      ?.info;
    expect(info).toMatchObject({ from: PAYER.address, asset: TOKEN, spender: PERMIT2_ADDRESS });
    const tx = parseTransaction(must(info)['signedTransaction'] as Hex);
    expect(tx.to?.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(tx.data?.startsWith('0x095ea7b3')).toBe(true); // approve(address,uint256)
    expect(tx.gas).toBe(70_000n);
    expect(tx.nonce).toBe(3);
    expect(w.writes).toEqual([]);
  });

  it('when the facilitator sponsors no approval, approves Permit2 from the payer’s own ETH, then deposits gaslessly', async () => {
    const w = world({ method: 'permit2', extensions: [], eth: 10n ** 16n });
    await w.payer.open(w.description, 'evm');
    expect(w.writes.map((x) => x.functionName)).toEqual(['approve']);
    expect(w.writes[0]?.address.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(w.writes[0]?.args[0]).toBe(PERMIT2_ADDRESS);
    expect(w.settled).toHaveLength(1);
    expect(must(w.settled[0]).paymentPayload.extensions).toBeUndefined();
  });

  it('with no sponsor and no ETH, says what is missing and deposits nothing', async () => {
    const w = world({ method: 'permit2', extensions: [] });
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(InsufficientBalanceError);
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(/Permit2.*approval.*ETH/s);
    expect(w.settled).toEqual([]);
    expect(w.writes).toEqual([]);
  });

  it('lets the caller’s depositMethod override the connector’s', async () => {
    const w = world({ method: 'eip3009', depositMethod: 'permit2', allowance: 10n ** 30n });
    await w.payer.open(w.description, 'evm');
    expect(must(w.settled[0]).paymentPayload.payload.deposit.authorization).toHaveProperty(
      'permit2Authorization'
    );
  });
});

describe('the payer paying its own gas', () => {
  it("depositGas 'self' deposits from the payer's wallet and never calls a facilitator", async () => {
    const w = world({ depositGas: 'self', eth: 10n ** 16n });
    await w.payer.open(w.description, 'evm');
    expect(w.urls).toEqual([]);
    expect(w.writes.map((x) => x.functionName)).toEqual(['deposit']);
    expect(w.writes[0]?.address).toBe(X402_BATCH_SETTLEMENT_ADDRESS);
  });

  it("depositGas 'self' with a Permit2 token approves, then deposits, both from the payer", async () => {
    const w = world({ depositGas: 'self', method: 'permit2', eth: 10n ** 16n });
    await w.payer.open(w.description, 'evm');
    expect(w.urls).toEqual([]);
    expect(w.writes.map((x) => x.functionName)).toEqual(['approve', 'deposit']);
  });

  it("depositGas 'self' with no ETH says so, before signing anything onto the chain", async () => {
    const w = world({ depositGas: 'self' });
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(InsufficientBalanceError);
    expect(w.writes).toEqual([]);
  });

  it('with no facilitator for the network, deposits directly when the payer holds ETH', async () => {
    const w = world({ network: 'eip155:8453', facilitatorUrl: null, eth: 10n ** 16n });
    await w.payer.open(w.description, 'evm');
    expect(w.urls).toEqual([]);
    expect(w.writes.map((x) => x.functionName)).toEqual(['deposit']);
  });

  it('with no facilitator and no ETH, names both ways out', async () => {
    const w = world({ network: 'eip155:8453', facilitatorUrl: null });
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(ConfigError);
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(/facilitatorUrl.*ETH/s);
  });

  it('falls back to depositing directly when the facilitator is down, and the payer holds ETH', async () => {
    const w = world({ facilitator: 'down', eth: 10n ** 16n });
    await w.payer.open(w.description, 'evm');
    expect(w.writes.map((x) => x.functionName)).toEqual(['deposit']);
  });

  it('keeps a deposit the facilitator broadcast but could not confirm, and does not send a second', async () => {
    const w = world({ facilitator: 'refuse', refusal: 'settlement_pending', eth: 10n ** 16n });
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(/settlement_pending/);
    expect(w.writes).toEqual([]);
    const [pending] = w.manager.channels('https://node.example');
    expect(w.manager.pendingDeposit(must(pending).channel.channelId)).toBe(10_000n);
  });

  it('reports a refusal of the deposit itself as it is, without spending the payer’s ETH on it', async () => {
    const w = world({
      facilitator: 'refuse',
      refusal: 'invalid_batch_settlement_evm_insufficient_balance',
      eth: 10n ** 16n,
    });
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(
      /invalid_batch_settlement_evm_insufficient_balance/
    );
    expect(w.writes).toEqual([]);
  });

  it('falls back to depositing directly when the facilitator cannot handle this deposit, and the payer holds ETH', async () => {
    const w = world({ facilitator: 'refuse', eth: 10n ** 16n });
    await w.payer.open(w.description, 'evm');
    expect(w.settled).toHaveLength(1);
    expect(w.writes.map((x) => x.functionName)).toEqual(['deposit']);
  });

  it("depositGas 'facilitator' never spends the payer's ETH, even when the facilitator refuses", async () => {
    const w = world({ facilitator: 'refuse', eth: 10n ** 16n, depositGas: 'facilitator' });
    await expect(w.payer.open(w.description, 'evm')).rejects.toThrow(FacilitatorError);
    expect(w.writes).toEqual([]);
  });
});

describe('which facilitator', () => {
  it('uses the one the connector names when the caller names none', async () => {
    const w = world({
      network: 'eip155:8453',
      facilitatorUrl: null,
      connectorFacilitator: 'https://facilitator.node.example',
    });
    await w.payer.open(w.description, 'evm');
    expect(w.urls).toEqual(['https://facilitator.node.example/settle']);
  });

  it('prefers the caller’s own over the connector’s', async () => {
    const w = world({ connectorFacilitator: 'https://facilitator.node.example' });
    await w.payer.open(w.description, 'evm');
    expect(w.urls).toEqual([`${FACILITATOR}/settle`]);
  });
});
