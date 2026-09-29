/**
 * x402 `batch-settlement` on the public devnet, from a wallet holding **no ETH**
 * (connector ADR 0074, toon-client#689).
 *
 * Two stages:
 *
 *   1. **Onboarding.** A fresh wallet draws USDC from the devnet faucet (which
 *      drips no ETH), and `BatchSettlementPayer.open()` deposits it through the
 *      devnet's x402 facilitator, the Onboarder at `onboard.devnet` (infra#23),
 *      into a channel whose receiver is the relay connector. The channel is
 *      then read back off Base Sepolia, and the wallet must still hold no ETH.
 *   2. **A paid send.** A `ToonClient` sharing that channel's store pays the
 *      relay's paid route with a voucher on it — no second deposit.
 *
 * ## Running it
 *
 * **It leaves a devnet-USDC channel behind** (1 USDC, withdrawable by the
 * channel's payer once the relay no longer needs it), so it is opt-in:
 *
 * ```bash
 * BATCH_SETTLEMENT_DEVNET=1 npx vitest run \
 *   --config vitest.integration.config.ts \
 *   src/__integration__/batch-settlement-devnet.integration.test.ts
 * ```
 *
 * Overrides: `TOON_CONNECTOR`, `TOON_FACILITATOR`, `TOON_RPC_URL`, `TOON_FAUCET`.
 *
 * ## Any ERC-20 (toon-client#695)
 *
 * With `DEVNET_FUNDER_KEY` also set — a Base Sepolia key holding a little ETH,
 * which pays to mint the token and nothing else — a third stage deposits the
 * devnet's first mock USDC (`0x49beE1Bc…`, which has neither ERC-3009 nor a
 * permit) through Permit2, from a fresh wallet holding NO ETH: the devnet
 * Onboarder funds and broadcasts the wallet's own `approve(Permit2)`
 * (`erc20ApprovalGasSponsoring`, toon-protocol/infra#40) and relays the
 * deposit. It leaves a 1 mock-USDC channel behind.
 *
 * The same key runs the self-paid half of #695's acceptance on Base Sepolia:
 * it sends each of three fresh wallets 0.0005 ETH, and each deposits from its
 * own ETH — once with `depositGas: 'self'`, once a plain ERC-20 with no
 * facilitator at all (approval and deposit both its own), and once with the
 * facilitator down. Each leaves a 1-token channel behind.
 */
import { describe, it, expect } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEVNET } from '../presets.js';
import { ConnectorEdgeClient } from '../connector/ConnectorEdgeClient.js';
import { BatchChannelManager } from '../channel/batch-settlement/manager.js';
import { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { PERMIT2_ADDRESS, readEvmBatchChannel } from '../channel/batch-settlement/evm.js';
import { evmWalletAccess } from '../channel/batch-settlement/deposit-gas.js';
import { chooseBatchSettlement } from '../channel/batch-settlement/offers.js';
import { fundWallet } from '../wallet/faucet.js';
import { ToonClient } from '../client/ToonClient.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import type { NodeSelfDescription } from '../connector/self-description.js';
import { must } from '../utils/must.test-support.js';

const ENABLED = process.env['BATCH_SETTLEMENT_DEVNET'] === '1';
const CONNECTOR = process.env['TOON_CONNECTOR'] ?? DEVNET.relay.url;
const FACILITATOR =
  process.env['TOON_FACILITATOR'] ?? DEVNET.facilitator;
const RPC_URL = process.env['TOON_RPC_URL'] ?? 'https://sepolia.base.org';
const FAUCET = process.env['TOON_FAUCET'] ?? DEVNET.faucet;
const DEPOSIT = 1_000_000n; // 1 USDC
const BASE_SEPOLIA = 'eip155:84532';

describe.skipIf(!ENABLED)(
  'x402 batch-settlement on the devnet, with no ETH',
  () => {
    const chain = createPublicClient({ transport: http(RPC_URL) });
    const key = generatePrivateKey();
    const payer = privateKeyToAccount(key);
    const store = new InMemoryChannelStore();
    const manager = new BatchChannelManager(store);
    let desc: NodeSelfDescription;
    let channelId: string;

    it('funds a fresh wallet with devnet USDC and no ETH', async () => {
      desc = await new ConnectorEdgeClient({}).describe(CONNECTOR);
      const terms = chooseBatchSettlement(desc, 'evm');
      expect(terms?.network).toBe(BASE_SEPOLIA);
      const asset = must(terms).asset as Hex;

      await fundWallet(FAUCET, payer.address, 'evm');
      let balance = 0n;
      for (let i = 0; i < 40 && balance < DEPOSIT; i++) {
        balance = await chain.readContract({
          address: asset,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [payer.address],
        });
        if (balance < DEPOSIT) await new Promise((r) => setTimeout(r, 3_000));
      }
      expect(balance).toBeGreaterThanOrEqual(DEPOSIT);
      expect(await chain.getBalance({ address: payer.address })).toBe(0n);
    }, 180_000);

    it('opens a channel through the facilitator, and the chain holds the deposit', async () => {
      const payerFor = new BatchSettlementPayer({
        connector: CONNECTOR,
        manager,
        deposit: DEPOSIT,
        evm: {
          account: payer,
          facilitatorUrl: FACILITATOR,
          reader: chain as unknown as {
            readContract: (p: never) => Promise<unknown>;
          },
        },
      });
      const channel = await payerFor.open(desc, 'evm');
      expect(channel).toBeDefined();
      channelId = must(channel).channelId;
      console.log(
        `[batch-settlement devnet] channel ${must(channel).channelId} → ${CONNECTOR}`
      );

      let state = await readEvmBatchChannel(chain, must(channel).channelId as Hex);
      for (let i = 0; i < 10 && state.balance === 0n; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = await readEvmBatchChannel(chain, must(channel).channelId as Hex);
      }
      expect(state.balance).toBe(DEPOSIT);
      expect(state.totalClaimed).toBe(0n);
      expect(manager.depositTotal(must(channel).channelId)).toBe(DEPOSIT);
      expect(await chain.getBalance({ address: payer.address })).toBe(0n);
    }, 180_000);

    it('pays a paid route with a voucher on that channel', async () => {
      const client = await ToonClient.create({
        connector: CONNECTOR,
        evmPrivateKey: key,
        chain: 'evm',
        rpcUrl: RPC_URL,
        facilitatorUrl: FACILITATOR,
        deposit: DEPOSIT,
        channelStore: store,
      });
      try {
        const result = await client.send(DEVNET.relay.route, {
          body: 'batch-settlement devnet',
        });
        expect(result.fulfilled).toBe(true);
        expect(result.claim).toMatchObject({ channelId, chain: 'evm' });
        expect(manager.depositTotal(channelId)).toBe(DEPOSIT);
        expect(await chain.getBalance({ address: payer.address })).toBe(0n);
      } finally {
        await client.close();
      }
    }, 180_000);
  }
);

/** The devnet's first mock USDC: a public mint, and neither ERC-3009 nor a permit. */
const PLAIN_ERC20 = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
const FUNDER_KEY = process.env['DEVNET_FUNDER_KEY'] as Hex | undefined;

describe.skipIf(!ENABLED || FUNDER_KEY === undefined)(
  'an ERC-20 with neither ERC-3009 nor a permit, on the devnet, from a wallet with no ETH',
  () => {
    it('deposits through Permit2, the Onboarder sponsoring the approval', async () => {
      const chain = createPublicClient({ transport: http(RPC_URL) });
      const payer = privateKeyToAccount(generatePrivateKey());
      const funder = createWalletClient({
        account: privateKeyToAccount(must(FUNDER_KEY)),
        chain: { id: 84532, name: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
        transport: http(RPC_URL),
      });
      await chain.waitForTransactionReceipt({
        hash: await funder.writeContract({
          address: PLAIN_ERC20,
          abi: parseAbi(['function mint(address,uint256)']),
          functionName: 'mint',
          args: [payer.address, DEPOSIT],
        }),
      });
      expect(await chain.getBalance({ address: payer.address })).toBe(0n);

      const relay = await new ConnectorEdgeClient({}).describe(CONNECTOR);
      const base = must(chooseBatchSettlement(relay, 'evm'));
      if (base.chain !== 'evm') throw new Error('unreachable');
      // The relay is paid in devnet USDC; this deposit names the plain token
      // instead. The channel it opens is the point, not a packet over it.
      const description = {
        ...relay,
        batchSettlements: [
          {
            ...base,
            asset: PLAIN_ERC20,
            extra: { ...base.extra, name: 'USD Coin (mock)', version: '1', assetTransferMethod: 'permit2' as const },
          },
        ],
      };
      const payerFor = new BatchSettlementPayer({
        connector: CONNECTOR,
        manager: new BatchChannelManager(),
        deposit: DEPOSIT,
        evm: {
          account: payer,
          facilitatorUrl: FACILITATOR,
          reader: chain as unknown as { readContract: (p: never) => Promise<unknown> },
          wallet: evmWalletAccess({ rpcUrl: RPC_URL, account: payer }),
        },
      });
      const channel = must(await payerFor.open(description, 'evm'));
      console.log(`[batch-settlement devnet] Permit2 channel ${channel.channelId}`);

      let state = await readEvmBatchChannel(chain, channel.channelId as Hex);
      for (let i = 0; i < 10 && state.balance === 0n; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = await readEvmBatchChannel(chain, channel.channelId as Hex);
      }
      expect(state.balance).toBe(DEPOSIT);
      const allowance = await chain.readContract({
        address: PLAIN_ERC20,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [payer.address, PERMIT2_ADDRESS],
      });
      expect(allowance > 0n).toBe(true);
      // Its one transaction is the approval, paid with ETH the Onboarder sent it.
      expect(await chain.getTransactionCount({ address: payer.address })).toBe(1);
    }, 240_000);
  }
);

describe.skipIf(!ENABLED)(
  'a permit token through Permit2, on the devnet, from a wallet with no ETH',
  () => {
    it('deposits with the permit riding inside the deposit, the payer sending nothing', async () => {
      const chain = createPublicClient({ transport: http(RPC_URL) });
      const payer = privateKeyToAccount(generatePrivateKey());
      const relay = await new ConnectorEdgeClient({}).describe(CONNECTOR);
      const base = must(chooseBatchSettlement(relay, 'evm'));
      if (base.chain !== 'evm') throw new Error('unreachable');

      await fundWallet(FAUCET, payer.address, 'evm');
      let balance = 0n;
      for (let i = 0; i < 40 && balance < DEPOSIT; i++) {
        balance = await chain.readContract({
          address: base.asset as Hex,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [payer.address],
        });
        if (balance < DEPOSIT) await new Promise((r) => setTimeout(r, 3_000));
      }

      const payerFor = new BatchSettlementPayer({
        connector: CONNECTOR,
        manager: new BatchChannelManager(),
        deposit: DEPOSIT,
        evm: {
          account: payer,
          facilitatorUrl: FACILITATOR,
          // Devnet USDC has ERC-3009 too; Permit2 is forced to take the permit path.
          depositMethod: 'permit2',
          reader: chain as unknown as { readContract: (p: never) => Promise<unknown> },
          wallet: evmWalletAccess({ rpcUrl: RPC_URL, account: payer }),
        },
      });
      const channel = must(await payerFor.open(relay, 'evm'));
      let state = await readEvmBatchChannel(chain, channel.channelId as Hex);
      for (let i = 0; i < 10 && state.balance === 0n; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = await readEvmBatchChannel(chain, channel.channelId as Hex);
      }
      expect(state.balance).toBe(DEPOSIT);
      expect(await chain.getTransactionCount({ address: payer.address })).toBe(0);
      expect(await chain.getBalance({ address: payer.address })).toBe(0n);
    }, 240_000);
  }
);

/** What the funder sends each self-paying wallet: its approval and deposit, many times over. */
const GAS_MONEY = 500_000_000_000_000n; // 0.0005 ETH

describe.skipIf(!ENABLED || FUNDER_KEY === undefined)(
  'a payer paying its own gas, on the devnet',
  () => {
    const chain = createPublicClient({ transport: http(RPC_URL) });
    const funder = () =>
      createWalletClient({
        account: privateKeyToAccount(must(FUNDER_KEY)),
        chain: { id: 84532, name: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
        transport: http(RPC_URL),
      });

    /** A fresh wallet holding `GAS_MONEY` of ETH and `DEPOSIT` of devnet USDC, or of the plain token. */
    async function selfPayingWallet(plain: boolean) {
      const payer = privateKeyToAccount(generatePrivateKey());
      await chain.waitForTransactionReceipt({
        hash: await funder().sendTransaction({ to: payer.address, value: GAS_MONEY }),
      });
      if (plain) {
        await chain.waitForTransactionReceipt({
          hash: await funder().writeContract({
            address: PLAIN_ERC20,
            abi: parseAbi(['function mint(address,uint256)']),
            functionName: 'mint',
            args: [payer.address, DEPOSIT],
          }),
        });
      } else {
        await fundWallet(FAUCET, payer.address, 'evm');
      }
      return payer;
    }

    /** Open a channel to the relay from `payer`, and read its deposit back off the chain. */
    async function open(
      payer: ReturnType<typeof privateKeyToAccount>,
      evm: { facilitatorUrl: string; depositGas?: 'auto' | 'self' },
      plain = false
    ): Promise<void> {
      const relay = await new ConnectorEdgeClient({}).describe(CONNECTOR);
      const base = must(chooseBatchSettlement(relay, 'evm'));
      if (base.chain !== 'evm') throw new Error('unreachable');
      const asset = (plain ? PLAIN_ERC20 : base.asset) as Hex;
      // The faucet's drip may trail its answer.
      for (let i = 0; i < 40; i++) {
        const held = await chain.readContract({
          address: asset,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [payer.address],
        });
        if (held >= DEPOSIT) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
      const description = plain
        ? {
            ...relay,
            batchSettlements: [
              {
                ...base,
                asset: PLAIN_ERC20,
                extra: { ...base.extra, name: 'USD Coin (mock)', version: '1', assetTransferMethod: 'permit2' as const },
              },
            ],
          }
        : relay;
      const payerFor = new BatchSettlementPayer({
        connector: CONNECTOR,
        manager: new BatchChannelManager(),
        deposit: DEPOSIT,
        evm: {
          account: payer,
          facilitatorUrl: evm.facilitatorUrl,
          ...(evm.depositGas ? { depositGas: evm.depositGas } : {}),
          reader: chain as unknown as { readContract: (p: never) => Promise<unknown> },
          wallet: evmWalletAccess({ rpcUrl: RPC_URL, account: payer }),
        },
      });
      const channel = must(await payerFor.open(description, 'evm'));
      console.log(`[batch-settlement devnet] self-paid channel ${channel.channelId}`);
      let state = await readEvmBatchChannel(chain, channel.channelId as Hex);
      for (let i = 0; i < 10 && state.balance === 0n; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = await readEvmBatchChannel(chain, channel.channelId as Hex);
      }
      expect(state.balance).toBe(DEPOSIT);
    }

    it("depositGas 'self': the payer deposits devnet USDC from its own ETH", async () => {
      const payer = await selfPayingWallet(false);
      await open(payer, { facilitatorUrl: FACILITATOR, depositGas: 'self' });
      expect(await chain.getTransactionCount({ address: payer.address })).toBe(1);
    }, 240_000);

    it('a token with neither, and no facilitator: the payer approves Permit2 and deposits, from its own ETH', async () => {
      const payer = await selfPayingWallet(true);
      // `''` is "no facilitator", whatever the connector names.
      await open(payer, { facilitatorUrl: '' }, true);
      expect(await chain.getTransactionCount({ address: payer.address })).toBe(2);
    }, 240_000);

    it('a facilitator that is down: a payer holding ETH deposits directly', async () => {
      const payer = await selfPayingWallet(false);
      await open(payer, { facilitatorUrl: 'http://127.0.0.1:1' });
      expect(await chain.getTransactionCount({ address: payer.address })).toBe(1);
    }, 240_000);
  }
);
