import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  computeChannelId as x402ComputeChannelId,
  signVoucher as x402SignVoucher,
  createBatchSettlementEIP3009DepositPayload as x402Eip3009Deposit,
} from '@x402/evm/batch-settlement/client';
import {
  batchChannelId,
  batchVoucherDigest,
  buildBatchChannelConfig,
  buildEip3009Deposit,
  buildPermit2Deposit,
  signBatchVoucher,
  X402_BATCH_SETTLEMENT_ADDRESS,
  type BatchSettlementEvmOffer,
} from './evm.js';
import { ConfigError, ValidationError } from '../../client/errors.js';

// Two throwaway keys: the funding wallet, and a separate session key.
const PAYER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const SESSION = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
);
const CONNECTOR = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_SEPOLIA = 84532;

const OFFER: BatchSettlementEvmOffer = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '1000',
  asset: USDC,
  payTo: CONNECTOR,
  maxTimeoutSeconds: 300,
  extra: {
    receiverAuthorizer: CONNECTOR,
    withdrawDelay: 86_400,
    name: 'USDC',
    version: '2',
  },
};

const SALT: Hex = `0x${'00'.repeat(31)}2a`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('buildBatchChannelConfig', () => {
  it('fills the connector-fixed seats from the offer and the client seats from the caller', () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      payerAuthorizer: SESSION.address,
      offer: OFFER,
      salt: SALT,
    });
    expect(config).toEqual({
      payer: PAYER.address,
      payerAuthorizer: SESSION.address,
      receiver: CONNECTOR,
      receiverAuthorizer: CONNECTOR,
      token: USDC,
      withdrawDelay: 86_400,
      salt: SALT,
    });
  });

  it('defaults the voucher signer to the payer', () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      salt: SALT,
    });
    expect(config.payerAuthorizer).toBe(PAYER.address);
  });

  it('draws a fresh random salt when none is given, so each channel is new', () => {
    const a = buildBatchChannelConfig({ payer: PAYER.address, offer: OFFER });
    const b = buildBatchChannelConfig({ payer: PAYER.address, offer: OFFER });
    expect(a.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
  });

  it('accepts a longer withdrawDelay than the published minimum, and refuses a shorter one', () => {
    const longer = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      withdrawDelay: 2 * 86_400,
    });
    expect(longer.withdrawDelay).toBe(2 * 86_400);
    expect(() =>
      buildBatchChannelConfig({
        payer: PAYER.address,
        offer: OFFER,
        withdrawDelay: 3_600,
      })
    ).toThrow(ConfigError);
  });

  it('refuses a withdrawDelay outside the contract range (15 minutes to 30 days)', () => {
    const tooLong = {
      ...OFFER,
      extra: { ...OFFER.extra, withdrawDelay: 31 * 86_400 },
    };
    expect(() =>
      buildBatchChannelConfig({ payer: PAYER.address, offer: tooLong })
    ).toThrow(ConfigError);
    const tooShort = { ...OFFER, extra: { ...OFFER.extra, withdrawDelay: 60 } };
    expect(() =>
      buildBatchChannelConfig({ payer: PAYER.address, offer: tooShort })
    ).toThrow(ConfigError);
  });

  it('refuses an offer whose receiverAuthorizer is not its payTo (ADR 0074 decisions 2 and 5)', () => {
    const delegated = {
      ...OFFER,
      extra: { ...OFFER.extra, receiverAuthorizer: SESSION.address },
    };
    expect(() =>
      buildBatchChannelConfig({ payer: PAYER.address, offer: delegated })
    ).toThrow(ConfigError);
  });

  it('refuses an offer that is not batch-settlement on an eip155 network', () => {
    expect(() =>
      buildBatchChannelConfig({
        payer: PAYER.address,
        offer: { ...OFFER, scheme: 'exact' as 'batch-settlement' },
      })
    ).toThrow(ConfigError);
    expect(() =>
      buildBatchChannelConfig({
        payer: PAYER.address,
        offer: { ...OFFER, network: 'solana:devnet' },
      })
    ).toThrow(ConfigError);
  });
});

describe('batchChannelId', () => {
  it('is the EIP-712 hash of the ChannelConfig, as @x402/evm computes it', () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      payerAuthorizer: SESSION.address,
      offer: OFFER,
      salt: SALT,
    });
    expect(batchChannelId(config, BASE_SEPOLIA)).toBe(
      x402ComputeChannelId(config, 'eip155:84532')
    );
    expect(batchChannelId(config, 8453)).toBe(
      x402ComputeChannelId(config, 'eip155:8453')
    );
    expect(batchChannelId(config, 8453)).not.toBe(
      batchChannelId(config, BASE_SEPOLIA)
    );
  });
});

describe('batchVoucherDigest', () => {
  it('hashes under the deployed VOUCHER_TYPEHASH (0x1e1bd6ff…9a69)', () => {
    const typehash = keccak256(
      toBytes('Voucher(bytes32 channelId,uint128 maxClaimableAmount)')
    );
    expect(typehash.startsWith('0x1e1bd6ff')).toBe(true);
    expect(typehash.endsWith('9a69')).toBe(true);

    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          keccak256(
            toBytes(
              'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
            )
          ),
          keccak256(toBytes('x402 Batch Settlement')),
          keccak256(toBytes('1')),
          BigInt(BASE_SEPOLIA),
          X402_BATCH_SETTLEMENT_ADDRESS,
        ]
      )
    );
    const channelId = keccak256(toBytes('some channel'));
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint128' }],
        [typehash, channelId, 1_234n]
      )
    );
    const expected = keccak256(
      new Uint8Array([
        0x19,
        0x01,
        ...toBytes(domainSeparator),
        ...toBytes(structHash),
      ])
    );
    expect(batchVoucherDigest(BASE_SEPOLIA, channelId, 1_234n)).toBe(expected);
  });
});

describe('signBatchVoucher', () => {
  const channelId = keccak256(toBytes('channel'));

  it('produces the same signature as @x402/evm, recoverable to the signer', async () => {
    const ours = await signBatchVoucher(
      SESSION,
      BASE_SEPOLIA,
      channelId,
      5_000n
    );
    const theirs = await x402SignVoucher(
      SESSION as never,
      channelId,
      '5000',
      'eip155:84532'
    );
    expect(ours).toEqual({
      channelId,
      maxClaimableAmount: '5000',
      signature: theirs.signature,
    });

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'x402 Batch Settlement',
        version: '1',
        chainId: BASE_SEPOLIA,
        verifyingContract: X402_BATCH_SETTLEMENT_ADDRESS,
      },
      types: {
        Voucher: [
          { name: 'channelId', type: 'bytes32' },
          { name: 'maxClaimableAmount', type: 'uint128' },
        ],
      },
      primaryType: 'Voucher',
      message: { channelId, maxClaimableAmount: 5_000n },
      signature: ours.signature,
    });
    expect(recovered).toBe(SESSION.address);
  });

  it('refuses an amount the connector cannot hold: negative, or above u64 (ADR 0074 decision 3)', async () => {
    await expect(
      signBatchVoucher(SESSION, BASE_SEPOLIA, channelId, -1n)
    ).rejects.toThrow(ValidationError);
    await expect(
      signBatchVoucher(SESSION, BASE_SEPOLIA, channelId, 2n ** 64n)
    ).rejects.toThrow(ValidationError);
    await expect(
      signBatchVoucher(SESSION, BASE_SEPOLIA, channelId, 2n ** 64n - 1n)
    ).resolves.toBeDefined();
  });
});

describe('buildEip3009Deposit', () => {
  it('is byte-for-byte the payload @x402/evm builds, given the same salt and clock', async () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      salt: SALT,
    });
    const depositSalt = new Uint8Array(32).fill(7);
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(a: T) => {
        (a as unknown as Uint8Array).set(depositSalt);
        return a;
      }
    );

    const theirs = await x402Eip3009Deposit(
      PAYER as never,
      2,
      OFFER as never,
      config,
      '1000000',
      '1000'
    );
    const ours = await buildEip3009Deposit({
      payer: PAYER,
      offer: OFFER,
      config,
      amount: 1_000_000n,
      voucherAmount: 1_000n,
    });
    expect(ours).toEqual(theirs.payload);
  });

  it('signs the voucher with the session key when one is given', async () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      payerAuthorizer: SESSION.address,
      offer: OFFER,
      salt: SALT,
    });
    const ours = await buildEip3009Deposit({
      payer: PAYER,
      voucherSigner: SESSION,
      offer: OFFER,
      config,
      amount: 1_000_000n,
      voucherAmount: 1_000n,
    });
    expect(ours.voucher).toEqual(
      await signBatchVoucher(
        SESSION,
        BASE_SEPOLIA,
        batchChannelId(config, BASE_SEPOLIA),
        1_000n
      )
    );
  });

  it('refuses a voucher signer that is not the config’s payerAuthorizer', async () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      salt: SALT,
    });
    await expect(
      buildEip3009Deposit({
        payer: PAYER,
        voucherSigner: SESSION,
        offer: OFFER,
        config,
        amount: 1_000_000n,
        voucherAmount: 1_000n,
      })
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a zero first voucher, which a TypeScript facilitator rejects (ADR 0074 prerequisite 1)', async () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      salt: SALT,
    });
    await expect(
      buildEip3009Deposit({
        payer: PAYER,
        offer: OFFER,
        config,
        amount: 1_000_000n,
        voucherAmount: 0n,
      })
    ).rejects.toThrow(ValidationError);
  });

  it('lets a top-up carry a cumulative voucher larger than the amount it adds', async () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      salt: SALT,
    });
    const topUp = await buildEip3009Deposit({
      payer: PAYER,
      offer: OFFER,
      config,
      amount: 10n,
      voucherAmount: 5_000n,
    });
    expect(topUp.voucher.maxClaimableAmount).toBe('5000');
    expect(topUp.deposit.amount).toBe('10');
  });

  it('refuses an offer with no EIP-712 domain for its token', async () => {
    const noDomain = {
      ...OFFER,
      extra: { receiverAuthorizer: CONNECTOR, withdrawDelay: 86_400 },
    };
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: noDomain,
      salt: SALT,
    });
    await expect(
      buildEip3009Deposit({
        payer: PAYER,
        offer: noDomain,
        config,
        amount: 10n,
        voucherAmount: 1n,
      })
    ).rejects.toThrow(ConfigError);
  });
});

describe('buildPermit2Deposit', () => {
  it('signs a PermitWitnessTransferFrom that binds the deposit to its channel', async () => {
    const config = buildBatchChannelConfig({
      payer: PAYER.address,
      offer: OFFER,
      salt: SALT,
    });
    const channelId = batchChannelId(config, BASE_SEPOLIA);
    vi.useFakeTimers({ now: 1_790_000_000_000 });
    const ours = await buildPermit2Deposit({
      payer: PAYER,
      offer: OFFER,
      config,
      amount: 1_000_000n,
      voucherAmount: 1_000n,
      nonce: 99n,
    });

    expect(ours.type).toBe('deposit');
    expect(ours.channelConfig).toEqual(config);
    const auth = ours.deposit.authorization.permit2Authorization;
    expect(auth).toMatchObject({
      from: PAYER.address,
      permitted: { token: USDC, amount: '1000000' },
      spender: '0x4020425FAf3B746C082C2f942b4E5159887B0005',
      nonce: '99',
      deadline: String(1_790_000_000 + 300),
      witness: { channelId },
    });

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'Permit2',
        chainId: BASE_SEPOLIA,
        verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      },
      types: {
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: 'DepositWitness' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        DepositWitness: [{ name: 'channelId', type: 'bytes32' }],
      },
      primaryType: 'PermitWitnessTransferFrom',
      message: {
        permitted: { token: USDC, amount: 1_000_000n },
        spender: '0x4020425FAf3B746C082C2f942b4E5159887B0005',
        nonce: 99n,
        deadline: BigInt(1_790_000_000 + 300),
        witness: { channelId },
      },
      signature: auth.signature,
    });
    expect(recovered).toBe(PAYER.address);
    expect(ours.voucher).toEqual(
      await signBatchVoucher(PAYER, BASE_SEPOLIA, channelId, 1_000n)
    );
  });
});
