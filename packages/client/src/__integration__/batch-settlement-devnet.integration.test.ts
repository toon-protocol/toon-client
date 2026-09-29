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
 */
import { describe, it, expect } from 'vitest';
import { createPublicClient, erc20Abi, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DEVNET } from '../presets.js';
import { ConnectorEdgeClient } from '../connector/ConnectorEdgeClient.js';
import { BatchChannelManager } from '../channel/batch-settlement/manager.js';
import { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { readEvmBatchChannel } from '../channel/batch-settlement/evm.js';
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
