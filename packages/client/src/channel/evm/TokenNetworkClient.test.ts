import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../../signing/evm-signer.js';
import { TokenNetworkClient, parseEvmChainId } from './TokenNetworkClient.js';
import { deriveEvmChannelId } from './channel-id.js';
import type { ChannelTerms } from '../types.js';
import {
  ChannelFundingError,
  ChannelNotOpenError,
  ConfigError,
  StaleRpcReadError,
} from '../../client/errors.js';

const mockReadContract = vi.fn();
const mockWriteContract = vi.fn();
const mockWaitForTransactionReceipt = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    })),
    createWalletClient: vi.fn(() => ({ writeContract: mockWriteContract, chain: undefined })),
    // Decoding a real ABI-encoded log is not what these tests are about: the
    // `ChannelOpened` id is read out of topics[1] so a fixture can name it.
    decodeEventLog: vi.fn(({ topics }: { topics?: string[] }) => {
      if (topics && topics.length >= 2) {
        return { eventName: 'ChannelOpened', args: { channelId: topics[1] } };
      }
      throw new Error('Unknown event');
    }),
  };
});

const CHAIN = 'evm:84532';
const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';
const REGISTRY = '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1';
const TOKEN = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
const COUNTERPARTY = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ZERO = '0x0000000000000000000000000000000000000000';

/** `channels(id)` as the contract returns it: a positional tuple. */
function channelsView(opts: {
  state: number;
  closedAt?: bigint;
  settlementTimeout?: bigint;
  participant1?: string;
}) {
  return [
    opts.settlementTimeout ?? 86400n,
    opts.state,
    opts.closedAt ?? 0n,
    1000n,
    opts.participant1 ?? COUNTERPARTY,
    COUNTERPARTY,
  ];
}

/** `participants(id, addr)` as the contract returns it. */
function participantsView(deposit: bigint) {
  return [deposit, 0n, 0n];
}

function terms(overrides: Partial<ChannelTerms> = {}): ChannelTerms {
  return {
    kind: 'evm',
    chain: CHAIN,
    chainId: 84532,
    counterparty: COUNTERPARTY,
    token: TOKEN,
    decimals: 6,
    tokenNetwork: TOKEN_NETWORK,
    ...overrides,
  };
}

describe('TokenNetworkClient', () => {
  let signer: EvmSigner;
  let client: TokenNetworkClient;

  beforeEach(() => {
    vi.clearAllMocks();
    signer = new EvmSigner(generatePrivateKey());
    client = new TokenNetworkClient({
      chain: CHAIN,
      rpcUrl: 'http://localhost:8545',
      signer,
      // Keep the read-after-write poll from turning a failure into a 12-second test.
      readConsistency: { attempts: 3, delayMs: 0, depositRetries: 2 },
    });
  });

  describe('adopting an already-open channel (ADR 0059)', () => {
    it('derives the id from the pair and the epoch, and opens NOTHING when it is open', async () => {
      mockReadContract
        .mockResolvedValueOnce(4n) // channelEpoch(p1, p2)
        .mockResolvedValueOnce(channelsView({ state: 1 })) // channels(derived) → Opened
        .mockResolvedValueOnce(participantsView(250_000n)); // participants(derived, me)

      const result = await client.openOrAdopt({ terms: terms(), initialDeposit: 100_000n });

      const expected = deriveEvmChannelId(signer.address, COUNTERPARTY, 4n);
      expect(result.channelId).toBe(expected);
      expect(result.status).toBe('open');
      // The collateral reported is what the CHAIN holds, not what we would have
      // deposited had we opened.
      expect(result.depositTotal).toBe(250_000n);
      // Nothing was written: no second channel, no second lot of collateral.
      expect(mockWriteContract).not.toHaveBeenCalled();
    });

    it('reads channelEpoch with the pair SORTED, as the contract keys it', async () => {
      mockReadContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(channelsView({ state: 1 }))
        .mockResolvedValueOnce(participantsView(0n));

      await client.openOrAdopt({ terms: terms() });

      const epochCall = mockReadContract.mock.calls[0]?.[0] as {
        functionName: string;
        args: [string, string];
      };
      expect(epochCall.functionName).toBe('channelEpoch');
      const [p1, p2] = epochCall.args;
      expect(p1.toLowerCase() < p2.toLowerCase()).toBe(true);
    });

    it('opens when the derived id is at nothing (state NonExistent)', async () => {
      mockReadContract
        .mockResolvedValueOnce(0n) // epoch
        .mockResolvedValueOnce(channelsView({ state: 0, participant1: ZERO })); // nothing there
      mockWriteContract.mockResolvedValueOnce('0xopen');
      const derived = deriveEvmChannelId(signer.address, COUNTERPARTY, 0n);
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', derived, '0xp1', '0xp2'], data: '0x' }],
      });

      const result = await client.openOrAdopt({ terms: terms(), initialDeposit: 0n });
      expect(result.channelId).toBe(derived);
      expect(result.status).toBe('opening');
      expect(result.txHash).toBe('0xopen');
    });

    it('opens again after a settle, because the epoch advanced', async () => {
      mockReadContract
        .mockResolvedValueOnce(1n) // epoch advanced past the settled channel
        .mockResolvedValueOnce(channelsView({ state: 3 })); // channels(derived) → Settled
      mockWriteContract.mockResolvedValueOnce('0xopen');
      const derived = deriveEvmChannelId(signer.address, COUNTERPARTY, 1n);
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', derived, '0xp1', '0xp2'], data: '0x' }],
      });

      const result = await client.openOrAdopt({ terms: terms() });
      expect(result.channelId).toBe(derived);
    });

    it('refuses rather than reopening when the pair\'s channel is CLOSED', async () => {
      mockReadContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(channelsView({ state: 2, closedAt: 1700000000n }));

      await expect(client.openOrAdopt({ terms: terms() })).rejects.toBeInstanceOf(
        ChannelNotOpenError
      );
      expect(mockWriteContract).not.toHaveBeenCalled();
    });

    it('falls back to the ChannelOpened log when the deployment has no channelEpoch', async () => {
      // The deployed Base Sepolia TokenNetwork still carries the pre-ADR-0059
      // global counter and REVERTS this call; a client that treated that as
      // fatal could not open a channel on the live devnet at all.
      mockReadContract.mockRejectedValueOnce(new Error('execution reverted'));
      mockWriteContract.mockResolvedValueOnce('0xopen');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', '0x' + 'ab'.repeat(32), '0xp1', '0xp2'], data: '0x' }],
      });

      const result = await client.openOrAdopt({ terms: terms() });
      expect(result.channelId).toBe('0x' + 'ab'.repeat(32));
      // No `channels()` read happened: with no epoch there is no id to look up.
      expect(mockReadContract).toHaveBeenCalledTimes(1);
    });

    it('refuses when the opened id disagrees with the derived one', async () => {
      mockReadContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(channelsView({ state: 0, participant1: ZERO }));
      mockWriteContract.mockResolvedValueOnce('0xopen');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', '0x' + 'cd'.repeat(32), '0xp1', '0xp2'], data: '0x' }],
      });

      await expect(client.openOrAdopt({ terms: terms() })).rejects.toBeInstanceOf(ConfigError);
    });

    it('refuses when the open emitted no decodable ChannelOpened event', async () => {
      mockReadContract.mockRejectedValueOnce(new Error('reverted'));
      mockWriteContract.mockResolvedValueOnce('0xopen');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xunknown'], data: '0x' }],
      });

      await expect(client.openOrAdopt({ terms: terms() })).rejects.toThrow(/ChannelOpened/);
    });
  });

  describe('the registry is the authority on the token network', () => {
    it('refuses when the registry resolves the token to a DIFFERENT token network', async () => {
      mockReadContract.mockResolvedValueOnce('0x1111111111111111111111111111111111111111');

      await expect(
        client.openOrAdopt({ terms: terms({ tokenNetworkRegistry: REGISTRY }) })
      ).rejects.toBeInstanceOf(ConfigError);
      // Refused BEFORE anything on chain: no collateral is at risk.
      expect(mockWriteContract).not.toHaveBeenCalled();
    });

    it('refuses when the registry knows no token network for the token at all', async () => {
      mockReadContract.mockResolvedValueOnce(ZERO);

      await expect(
        client.openOrAdopt({ terms: terms({ tokenNetworkRegistry: REGISTRY }) })
      ).rejects.toThrow(/has no token network/i);
    });

    it('accepts a registry that agrees, ignoring checksum casing', async () => {
      mockReadContract
        .mockResolvedValueOnce(TOKEN_NETWORK.toLowerCase()) // getTokenNetwork
        .mockResolvedValueOnce(0n) // channelEpoch
        .mockResolvedValueOnce(channelsView({ state: 1 }))
        .mockResolvedValueOnce(participantsView(0n));

      await expect(
        client.openOrAdopt({ terms: terms({ tokenNetworkRegistry: REGISTRY }) })
      ).resolves.toMatchObject({ status: 'open' });
    });

    it('skips the check when the node published no registry — one declaration, nothing to contradict', async () => {
      mockReadContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(channelsView({ state: 1 }))
        .mockResolvedValueOnce(participantsView(0n));

      await expect(client.openOrAdopt({ terms: terms() })).resolves.toMatchObject({
        status: 'open',
      });
      expect(mockReadContract.mock.calls[0]?.[0]).toMatchObject({ functionName: 'channelEpoch' });
    });

    it('refuses a settlement entry that publishes no token network at all', async () => {
      await expect(
        client.openOrAdopt({ terms: terms({ tokenNetwork: undefined }) })
      ).rejects.toThrow(/publishes no\s+tokenNetwork/);
    });
  });

  describe('opening and collateralising', () => {
    beforeEach(() => {
      // No epoch on this deployment: straight to the open path.
      mockReadContract.mockRejectedValueOnce(new Error('reverted'));
    });

    async function openWith(initialDeposit: bigint, settlementTimeout?: number) {
      mockWriteContract.mockResolvedValue('0xtx');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', '0x' + 'ab'.repeat(32), '0xp1', '0xp2'], data: '0x' }],
      });
      return client.openOrAdopt({
        terms: terms(),
        initialDeposit,
        ...(settlementTimeout !== undefined ? { settlementTimeout } : {}),
      });
    }

    it('approves, opens, and deposits the collateral as a cumulative total', async () => {
      mockReadContract.mockResolvedValueOnce(0n); // allowance → approve needed
      mockWriteContract
        .mockResolvedValueOnce('0xapprove')
        .mockResolvedValueOnce('0xopen')
        .mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt
        .mockResolvedValueOnce({}) // approve
        .mockResolvedValueOnce({
          logs: [{ topics: ['0xev', '0x' + 'ab'.repeat(32), '0xp1', '0xp2'], data: '0x' }],
        })
        .mockResolvedValueOnce({}); // deposit
      mockReadContract.mockResolvedValueOnce(channelsView({ state: 1, participant1: signer.address }));

      const result = await client.openOrAdopt({ terms: terms(), initialDeposit: 100_000n });

      const fns = mockWriteContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
      expect(fns).toEqual(['approve', 'openChannel', 'setTotalDeposit']);
      expect(result.depositTotal).toBe(100_000n);
      const depositCall = mockWriteContract.mock.calls[2]?.[0] as { args: unknown[] };
      expect(depositCall.args[1]).toBe(signer.address);
      expect(depositCall.args[2]).toBe(100_000n);
    });

    it('skips the approve when the standing allowance already covers the deposit', async () => {
      mockReadContract.mockResolvedValueOnce(10n ** 30n); // allowance
      mockWriteContract.mockResolvedValueOnce('0xopen').mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt
        .mockResolvedValueOnce({
          logs: [{ topics: ['0xev', '0x' + 'ab'.repeat(32), '0xp1', '0xp2'], data: '0x' }],
        })
        .mockResolvedValueOnce({});
      mockReadContract.mockResolvedValueOnce(channelsView({ state: 1, participant1: signer.address }));

      await client.openOrAdopt({ terms: terms(), initialDeposit: 1n });
      const fns = mockWriteContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
      expect(fns).toEqual(['openChannel', 'setTotalDeposit']);
    });

    it('opens without a deposit — and skips the read-after-write wait, which has nothing to protect', async () => {
      const result = await openWith(0n);
      expect(result.depositTotal).toBe(0n);
      // `mockWaitForTransactionReceipt` is queued for the open only.
      const fns = mockWriteContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
      expect(fns).toEqual(['openChannel']);
    });

    it('raises a sub-hour settlement timeout to the contract\'s one-hour floor', async () => {
      await openWith(0n, 60);
      const openCall = mockWriteContract.mock.calls[0]?.[0] as { args: [string, bigint] };
      expect(openCall.args[1]).toBe(3600n);
    });

    it('passes a longer settlement timeout through unchanged', async () => {
      await openWith(0n, 172_800);
      const openCall = mockWriteContract.mock.calls[0]?.[0] as { args: [string, bigint] };
      expect(openCall.args[1]).toBe(172_800n);
    });

    it('remaps an insufficient-gas revert into an actionable ChannelFundingError', async () => {
      mockWriteContract.mockRejectedValueOnce(
        new Error(
          'The total cost (gas * gas fee + value) of executing this transaction ' +
            'exceeds the balance of the account.'
        )
      );
      const error = await client.openOrAdopt({ terms: terms() }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChannelFundingError);
      expect((error as Error).message).toContain(signer.address);
    });

    it('does NOT remap an unrelated open failure', async () => {
      mockWriteContract.mockRejectedValueOnce(new Error('nonce too low'));
      await expect(client.openOrAdopt({ terms: terms() })).rejects.toThrow('nonce too low');
    });
  });

  describe('surviving a stale-read RPC (#489)', () => {
    beforeEach(() => {
      mockReadContract.mockRejectedValueOnce(new Error('reverted')); // no epoch
      mockReadContract.mockResolvedValueOnce(10n ** 30n); // allowance
      mockWriteContract.mockResolvedValue('0xtx');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', '0x' + 'ab'.repeat(32), '0xp1', '0xp2'], data: '0x' }],
      });
    });

    it('waits for the RPC to report the channel before depositing into it', async () => {
      mockReadContract
        .mockResolvedValueOnce(channelsView({ state: 0, participant1: ZERO })) // stale replica
        .mockResolvedValueOnce(channelsView({ state: 1, participant1: signer.address })); // caught up
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      await client.openOrAdopt({ terms: terms(), initialDeposit: 5n });
      const fns = mockWriteContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
      expect(fns).toEqual(['openChannel', 'setTotalDeposit']);
    });

    it('retries setTotalDeposit when a stale replica reverts InvalidChannelState()', async () => {
      mockReadContract.mockResolvedValue(channelsView({ state: 1, participant1: signer.address }));
      mockWriteContract
        .mockResolvedValueOnce('0xopen')
        .mockRejectedValueOnce(new Error('execution reverted: 0xf806e9d9'))
        .mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt.mockResolvedValue({});

      await client.openOrAdopt({ terms: terms(), initialDeposit: 5n });
      const fns = mockWriteContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
      expect(fns).toEqual(['openChannel', 'setTotalDeposit', 'setTotalDeposit']);
    });

    it('does NOT retry a deposit that reverted for any other reason', async () => {
      mockReadContract.mockResolvedValue(channelsView({ state: 1, participant1: signer.address }));
      mockWriteContract
        .mockResolvedValueOnce('0xopen')
        .mockRejectedValueOnce(new Error('ERC20: transfer amount exceeds balance'));
      mockWaitForTransactionReceipt.mockResolvedValue({});

      await expect(
        client.openOrAdopt({ terms: terms(), initialDeposit: 5n })
      ).rejects.toThrow(/exceeds balance/);
    });

    it('fails with an actionable StaleRpcReadError when the RPC never converges', async () => {
      mockReadContract.mockResolvedValue(channelsView({ state: 0, participant1: ZERO }));
      mockWaitForTransactionReceipt.mockResolvedValue({});

      const error = await client
        .openOrAdopt({ terms: terms(), initialDeposit: 5n })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StaleRpcReadError);
      expect((error as Error).message).toContain('http://localhost:8545');
    });
  });

  describe('deposit / close / settle / read', () => {
    const CHANNEL = '0x' + 'ab'.repeat(32);

    it('deposits the new CUMULATIVE total, not the delta', async () => {
      mockReadContract.mockResolvedValueOnce(10n ** 30n); // allowance
      mockWriteContract.mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      const out = await client.deposit(TOKEN_NETWORK, CHANNEL, 5n, {
        currentDeposit: 10n,
        token: TOKEN,
      });
      expect(out.depositTotal).toBe(15n);
      const call = mockWriteContract.mock.calls[0]?.[0] as { args: unknown[] };
      expect(call.args[2]).toBe(15n);
    });

    it('approves first when the allowance is short of the delta', async () => {
      mockReadContract.mockResolvedValueOnce(1n);
      mockWriteContract.mockResolvedValueOnce('0xapprove').mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt.mockResolvedValue({});

      await client.deposit(TOKEN_NETWORK, CHANNEL, 5n, { currentDeposit: 0n, token: TOKEN });
      const fns = mockWriteContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
      expect(fns).toEqual(['approve', 'setTotalDeposit']);
    });

    it('rejects a non-positive deposit', async () => {
      await expect(
        client.deposit(TOKEN_NETWORK, CHANNEL, 0n, { currentDeposit: 0n })
      ).rejects.toBeInstanceOf(RangeError);
    });

    it('close reads the settle deadline back from chain rather than from a local clock', async () => {
      mockWriteContract.mockResolvedValueOnce('0xclose');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      mockReadContract.mockResolvedValueOnce(
        channelsView({ state: 2, closedAt: 1_700_000_000n, settlementTimeout: 3600n })
      );

      const out = await client.close(TOKEN_NETWORK, CHANNEL);
      expect(out.closedAt).toBe(1_700_000_000n);
      expect(out.settlementTimeout).toBe(3600n);
      expect(out.settleableAt).toBe(1_700_003_600n);
    });

    it('settle writes settleChannel', async () => {
      mockWriteContract.mockResolvedValueOnce('0xsettle');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      const out = await client.settle(TOKEN_NETWORK, CHANNEL);
      expect(out.txHash).toBe('0xsettle');
      expect((mockWriteContract.mock.calls[0]?.[0] as { functionName: string }).functionName).toBe(
        'settleChannel'
      );
    });

    it('maps the state enum, and reports the deposit and the settle deadline', async () => {
      mockReadContract
        .mockResolvedValueOnce(channelsView({ state: 2, closedAt: 100n, settlementTimeout: 60n }))
        .mockResolvedValueOnce(participantsView(42n));

      const state = await client.getChannelState(TOKEN_NETWORK, CHANNEL);
      expect(state).toMatchObject({
        channelId: CHANNEL,
        status: 'closed',
        chain: CHAIN,
        deposit: 42n,
        closedAt: 100n,
        settleableAt: 160n,
      });
    });

    it('maps NonExistent to `missing`, which is not the same fact as `settled`', async () => {
      mockReadContract
        .mockResolvedValueOnce(channelsView({ state: 0, participant1: ZERO }))
        .mockResolvedValueOnce(participantsView(0n));
      const state = await client.getChannelState(TOKEN_NETWORK, CHANNEL);
      expect(state.status).toBe('missing');
    });
  });

  describe('channelEpoch', () => {
    it('reports 0n — a pair that has never settled — as a real answer', async () => {
      mockReadContract.mockResolvedValueOnce(0n);
      await expect(client.channelEpoch(TOKEN_NETWORK, signer.address, COUNTERPARTY)).resolves.toBe(
        0n
      );
    });

    it('reports undefined — a deployment that cannot answer — for a revert', async () => {
      mockReadContract.mockRejectedValueOnce(new Error('execution reverted'));
      await expect(
        client.channelEpoch(TOKEN_NETWORK, signer.address, COUNTERPARTY)
      ).resolves.toBeUndefined();
    });
  });
});

describe('parseEvmChainId', () => {
  it('reads the canonical two-part key a self-description carries', () => {
    expect(parseEvmChainId('evm:84532')).toBe(84532);
  });

  it('reads the three-part key some deployments still spell', () => {
    expect(parseEvmChainId('evm:anvil:31337')).toBe(31337);
  });

  it('refuses a key with no chain id, rather than transacting on chain NaN', () => {
    expect(() => parseEvmChainId('evm')).toThrow(ConfigError);
    expect(() => parseEvmChainId('solana')).toThrow(ConfigError);
  });
});
