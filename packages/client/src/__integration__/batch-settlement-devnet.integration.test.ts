/**
 * x402 `batch-settlement` on the public devnet, from a wallet holding **no ETH**
 * (connector ADR 0074, toon-client#689).
 *
 * Two stages, because the devnet has only one of the two parties so far:
 *
 *   1. **Onboarding** — always. A fresh wallet draws USDC from the devnet
 *      faucet (which drips no ETH), and `BatchSettlementPayer.open()` deposits
 *      it through the devnet's x402 facilitator, the Onboarder at
 *      `onboard.devnet` (infra#23), into a channel whose receiver is the relay
 *      connector. The channel is then read back off Base Sepolia, and the
 *      wallet must still hold no ETH.
 *
 *      A node that has not opted in publishes no `batchSettlements`, so the
 *      relay's terms are then built from its own `evm:84532` settlement entry:
 *      the same receiver, `receiverAuthorizer` and token its batch-settlement
 *      entry would carry (ADR 0074 decision 2), and ADR 0074's default one-day
 *      minimum `withdrawDelay`.
 *   2. **A paid send** — only once the node really publishes `batchSettlements`
 *      on Base, since until then it refuses every voucher by name. A
 *      `ToonClient` created with `batchSettlement` then pays a paid route with
 *      a voucher.
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
import type { NodeSelfDescription } from '../connector/self-description.js';

const ENABLED = process.env['BATCH_SETTLEMENT_DEVNET'] === '1';
const CONNECTOR = process.env['TOON_CONNECTOR'] ?? DEVNET.relay.url;
const FACILITATOR =
  process.env['TOON_FACILITATOR'] ?? 'https://onboard.devnet.toonprotocol.dev';
const RPC_URL = process.env['TOON_RPC_URL'] ?? 'https://sepolia.base.org';
const FAUCET = process.env['TOON_FAUCET'] ?? DEVNET.faucet;
const DEPOSIT = 1_000_000n; // 1 USDC
const BASE_SEPOLIA = 'eip155:84532';

/**
 * The node's own Base terms when it publishes them; otherwise the ones its
 * `evm:84532` settlement entry implies, marked so the paid stage is skipped.
 */
function baseTerms(desc: NodeSelfDescription): {
  desc: NodeSelfDescription;
  published: boolean;
} {
  if (chooseBatchSettlement(desc, 'evm') !== undefined)
    return { desc, published: true };
  const settlement = desc.settlements.find((s) => s.chain === 'evm:84532');
  if (settlement === undefined || settlement.kind !== 'evm') {
    throw new Error(
      `${CONNECTOR} settles on no evm:84532 channel to take a receiver from`
    );
  }
  const receiver = settlement.settlementAddress;
  return {
    published: false,
    desc: {
      ...desc,
      batchSettlements: [
        {
          chain: 'evm',
          network: BASE_SEPOLIA,
          asset: settlement.tokenAddress,
          payTo: receiver,
          // Circle's FiatToken v2.2 — the devnet USDC since connector#1337.
          extra: {
            receiverAuthorizer: receiver,
            withdrawDelay: 86_400,
            name: 'USDC',
            version: '2',
          },
        },
      ],
    },
  };
}

describe.skipIf(!ENABLED)(
  'x402 batch-settlement on the devnet, with no ETH',
  () => {
    const chain = createPublicClient({ transport: http(RPC_URL) });
    const key = generatePrivateKey();
    const payer = privateKeyToAccount(key);
    const manager = new BatchChannelManager();
    let terms: { desc: NodeSelfDescription; published: boolean };

    it('funds a fresh wallet with devnet USDC and no ETH', async () => {
      const desc = await new ConnectorEdgeClient({}).describe(CONNECTOR);
      terms = baseTerms(desc);
      const asset = chooseBatchSettlement(terms.desc, 'evm')!.asset as Hex;

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
      const channel = await payerFor.open(terms.desc, 'evm');
      expect(channel).toBeDefined();
      console.log(
        `[batch-settlement devnet] channel ${channel!.channelId} → ${CONNECTOR}`
      );

      let state = await readEvmBatchChannel(chain, channel!.channelId as Hex);
      for (let i = 0; i < 10 && state.balance === 0n; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        state = await readEvmBatchChannel(chain, channel!.channelId as Hex);
      }
      expect(state.balance).toBe(DEPOSIT);
      expect(state.totalClaimed).toBe(0n);
      expect(manager.depositTotal(channel!.channelId)).toBe(DEPOSIT);
      expect(await chain.getBalance({ address: payer.address })).toBe(0n);
    }, 180_000);

    it('pays a paid route with a voucher, once the node publishes batch-settlement', async (ctx) => {
      if (!terms.published) {
        console.log(
          `[batch-settlement devnet] ${CONNECTOR} publishes no batchSettlements yet; ` +
            'the paid send waits for it to opt in'
        );
        ctx.skip();
      }
      const client = await ToonClient.create({
        connector: CONNECTOR,
        evmPrivateKey: key,
        chain: 'evm',
        rpcUrl: RPC_URL,
        batchSettlement: { facilitatorUrl: FACILITATOR, deposit: DEPOSIT },
      });
      try {
        const result = await client.send(DEVNET.relay.route, {
          body: 'batch-settlement devnet',
        });
        expect(result.fulfilled).toBe(true);
        if (result.fulfilled)
          expect(result.claim?.scheme).toBe('batch-settlement');
        expect(await chain.getBalance({ address: payer.address })).toBe(0n);
      } finally {
        await client.close();
      }
    }, 180_000);
  }
);
