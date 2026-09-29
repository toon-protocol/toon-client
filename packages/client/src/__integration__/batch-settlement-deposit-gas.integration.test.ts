/**
 * Who pays a Base deposit's gas, proved against the real contracts and the
 * real Onboarder (toon-client#695).
 *
 * `anvil` is seeded by toon-protocol/infra's own `seed-x402.sh`: Permit2,
 * `x402BatchSettlement` and both deposit collectors at their production
 * addresses, and Circle's FiatToken v2.2 (ERC-3009 AND an EIP-2612 permit).
 * WETH9 is placed beside them as the token with NEITHER. The Onboarder is
 * infra's own (`onboarder/index.mjs`), run as a process against that anvil,
 * with both of x402's gas-sponsoring extensions.
 *
 * Six deposits, each from a fresh wallet, each read back off the chain:
 *
 *   1. a token with neither ERC-3009 nor a permit, from a wallet with NO ETH —
 *      the Onboarder funds and broadcasts the payer's signed approval;
 *   2. a permit token deposited through Permit2 with NO ETH — the permit rides
 *      inside the deposit, and the payer sends nothing at all;
 *   3. `depositGas: 'self'` — the payer deposits from its own ETH, and no
 *      facilitator is contacted;
 *   4. a token with neither, and no facilitator at all — the payer approves
 *      Permit2 and deposits, both from its own ETH;
 *   5. a facilitator that is down — the payer, holding ETH, deposits directly;
 *   6. the facilitator the CONNECTOR names in its terms, the caller naming
 *      none — the seller's facilitator sponsors the payer's approval.
 *
 * And, for each deposit method, that one signed authorization lands once: the
 * Onboarder settles it, and the payer's own copy of the same deposit reverts.
 *
 * ## Running it
 *
 * Needs `anvil` on PATH, and an infra checkout beside this one
 * (`INFRA_SANDBOX_DIR`, and `INFRA_ONBOARDER_DIR` for an Onboarder with its
 * `node_modules` installed). Absent any of them it SKIPS, unless
 * `CLIENT_REQUIRE_BATCH_SETTLEMENT=1` makes that a failure.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { BatchChannelManager } from '../channel/batch-settlement/manager.js';
import {
  approvePermit2,
  depositDirectly,
  evmWalletAccess,
} from '../channel/batch-settlement/deposit-gas.js';
import {
  batchChannelId,
  buildBatchChannelConfig,
  buildEip3009Deposit,
  buildPermit2Deposit,
  readEvmBatchChannel,
  PERMIT2_ADDRESS,
} from '../channel/batch-settlement/evm.js';
import { settleDeposit } from '../channel/batch-settlement/facilitator.js';
import { chooseBatchSettlement, offerFromTerms } from '../channel/batch-settlement/offers.js';
import { parseSelfDescription } from '../connector/self-description.js';
import { must } from '../utils/must.test-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA =
  process.env['INFRA_SANDBOX_DIR'] ?? resolve(HERE, '../../../../../infra/sandbox');
const ONBOARDER =
  process.env['INFRA_ONBOARDER_DIR'] ?? resolve(INFRA, '..', 'onboarder');
const REQUIRE = process.env['CLIENT_REQUIRE_BATCH_SETTLEMENT'] === '1';

const MISSING = [
  spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0 && 'anvil',
  !existsSync(join(INFRA, 'scripts', 'seed-x402.sh')) && `an infra checkout at ${INFRA}`,
  !existsSync(join(ONBOARDER, 'node_modules', '@x402', 'extensions')) &&
    `an Onboarder with gas sponsoring and its node_modules at ${ONBOARDER}`,
].filter(Boolean);
if (MISSING.length > 0) {
  const why = `the deposit-gas suite needs ${MISSING.join(', ')}`;
  if (REQUIRE) throw new Error(`CLIENT_REQUIRE_BATCH_SETTLEMENT=1 but ${why}`);
  console.warn(`SKIPPING: ${why}`);
}

const ANVIL_PORT = 18745;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const ONBOARDER_PORT = 14122;
const ONBOARDER_URL = `http://127.0.0.1:${ONBOARDER_PORT}`;
const NETWORK = 'eip155:31337';
/** seed-x402.sh's FiatToken, and its owner (anvil-mnemonic index 21), which mints. */
const USDC = '0x0A867CA0442383c2A89951244B955AA19b615b58';
const USDC_OWNER_KEY =
  '0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b';
/** WETH9, placed where Base keeps it: an ERC-20 with no ERC-3009 and no permit. */
const WETH = '0x4200000000000000000000000000000000000006';
/** anvil's account #1: the connector, the channel's receiver. */
const CONNECTOR_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** anvil's account #2: wraps the WETH it hands out. */
const WETH_FUNDER_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const DEPOSIT = 1_000_000n;
const ONE_ETH = 10n ** 18n;

async function waitFor(label: string, ms: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(MISSING.length > 0)('who pays a Base deposit’s gas, on the real contracts', () => {
  let anvil: ChildProcess | undefined;
  let onboarder: ChildProcess | undefined;
  const chain = defineChain({
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_RPC] } },
  });
  const pub = createPublicClient({ chain, transport: http(ANVIL_RPC) });

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore' });
    await waitFor('anvil', 30_000, async () => (await pub.getChainId()) === 31337);
    const seeded = spawnSync('sh', [join(INFRA, 'scripts', 'seed-x402.sh')], {
      env: { ...process.env, RPC_URL: ANVIL_RPC, ARTIFACTS_DIR: join(INFRA, 'artifacts', 'evm') },
      encoding: 'utf8',
    });
    if (seeded.status !== 0) throw new Error(`seed-x402.sh failed:\n${seeded.stderr}`);
    await pub.request({
      method: 'anvil_setCode' as never,
      params: [WETH, readFileSync(join(INFRA, 'artifacts', 'evm', 'WETH9.runtime.hex'), 'utf8').trim()] as never,
    });

    onboarder = spawn('node', ['index.mjs'], {
      cwd: ONBOARDER,
      env: {
        ...process.env,
        EVM_RPC_URL: ANVIL_RPC,
        PORT: String(ONBOARDER_PORT),
        // The token with neither ERC-3009 nor a permit: its approval is sponsored.
        ONBOARDER_SPONSORED_TOKENS: WETH,
      },
      stdio: 'ignore',
    });
    await waitFor('the Onboarder', 30_000, async () => {
      const supported = (await (await fetch(`${ONBOARDER_URL}/supported`)).json()) as {
        extensions: string[];
      };
      return supported.extensions.includes('erc20ApprovalGasSponsoring');
    });
  }, 180_000);

  afterAll(() => {
    for (const child of [onboarder, anvil]) if (child?.exitCode === null) child.kill('SIGKILL');
  });

  /** A fresh wallet holding `eth` wei, `tokens` of `token` (one deposit's worth by default), and nothing else. */
  async function freshPayer(token: string, eth: bigint, tokens = DEPOSIT) {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    if (token === USDC) {
      const owner = createWalletClient({ account: privateKeyToAccount(USDC_OWNER_KEY), chain, transport: http(ANVIL_RPC) });
      await pub.waitForTransactionReceipt({
        hash: await owner.writeContract({
          address: USDC,
          abi: parseAbi(['function mint(address to, uint256 amount) returns (bool)']),
          functionName: 'mint',
          args: [account.address, tokens],
        }),
      });
    } else {
      const funder = createWalletClient({ account: privateKeyToAccount(WETH_FUNDER_KEY), chain, transport: http(ANVIL_RPC) });
      const weth = parseAbi(['function deposit() payable', 'function transfer(address,uint256) returns (bool)']);
      await pub.waitForTransactionReceipt({
        hash: await funder.writeContract({ address: WETH, abi: weth, functionName: 'deposit', value: tokens }),
      });
      await pub.waitForTransactionReceipt({
        hash: await funder.writeContract({ address: WETH, abi: weth, functionName: 'transfer', args: [account.address, tokens] }),
      });
    }
    await pub.request({
      method: 'anvil_setBalance' as never,
      params: [account.address, `0x${eth.toString(16)}`] as never,
    });
    return account;
  }

  /**
   * Open a channel to the connector. `facilitatorUrl` is the caller's own
   * (`''` for none), and `named` the one the connector's terms name.
   */
  function open(
    account: ReturnType<typeof privateKeyToAccount>,
    token: string,
    evm: {
      facilitatorUrl?: string;
      named?: string;
      depositGas?: 'auto' | 'facilitator' | 'self';
    },
    method?: 'eip3009' | 'permit2'
  ) {
    const payer = new BatchSettlementPayer({
      connector: 'https://node.example',
      manager: new BatchChannelManager(),
      deposit: DEPOSIT,
      evm: {
        account,
        ...(evm.facilitatorUrl !== undefined ? { facilitatorUrl: evm.facilitatorUrl } : {}),
        ...(evm.depositGas ? { depositGas: evm.depositGas } : {}),
        reader: pub as never,
        wallet: evmWalletAccess({ rpcUrl: ANVIL_RPC, account }),
      },
    });
    return payer.open(connectorTerms(token, method, evm.named), 'evm');
  }

  /** The connector's self-description, its one EVM entry in `token`. */
  function connectorTerms(token: string, method?: 'eip3009' | 'permit2', named?: string) {
    return parseSelfDescription({
      batchSettlements: [
        {
          network: NETWORK,
          asset: token,
          payTo: CONNECTOR_ADDRESS,
          receiverAuthorizer: CONNECTOR_ADDRESS,
          withdrawDelay: 900,
          ...(token === USDC ? { name: 'USDC', version: '2' } : { name: 'Wrapped Ether', version: '1' }),
          ...(method ? { assetTransferMethod: method } : {}),
          ...(named ? { facilitator: named } : {}),
        },
      ],
    });
  }

  async function escrow(channelId: string): Promise<bigint> {
    return (await readEvmBatchChannel(pub, channelId as Hex)).balance;
  }
  const txCount = (address: Hex) => pub.getTransactionCount({ address });

  it('a token with neither ERC-3009 nor a permit, from a wallet with no ETH: the Onboarder sponsors the approval', async () => {
    const payer = await freshPayer(WETH, 0n);
    const channel = must(await open(payer, WETH, { facilitatorUrl: ONBOARDER_URL }, 'permit2'));
    expect(await escrow(channel.channelId)).toBe(DEPOSIT);
    const allowance = await pub.readContract({
      address: WETH,
      abi: parseAbi(['function allowance(address,address) view returns (uint256)']),
      functionName: 'allowance',
      args: [payer.address, PERMIT2_ADDRESS],
    });
    expect(allowance > 0n).toBe(true);
    // The payer's one transaction is its own approval, paid with ETH the
    // Onboarder gave it for exactly that.
    expect(await txCount(payer.address)).toBe(1);
  }, 120_000);

  it('a permit token through Permit2, from a wallet with no ETH: the permit rides inside the deposit', async () => {
    const payer = await freshPayer(USDC, 0n);
    const channel = must(await open(payer, USDC, { facilitatorUrl: ONBOARDER_URL }, 'permit2'));
    expect(await escrow(channel.channelId)).toBe(DEPOSIT);
    expect(await txCount(payer.address)).toBe(0);
  }, 120_000);

  it("depositGas 'self': the payer deposits from its own ETH, and no facilitator is contacted", async () => {
    // A facilitator that answers, named by both the caller and the connector,
    // and counting every request it is sent.
    let contacted = 0;
    const spy: Server = createServer((_req, res) => {
      contacted++;
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => spy.listen(0, '127.0.0.1', r));
    const spyUrl = `http://127.0.0.1:${(spy.address() as AddressInfo).port}`;
    try {
      const payer = await freshPayer(USDC, ONE_ETH);
      const channel = must(
        await open(payer, USDC, { facilitatorUrl: spyUrl, named: spyUrl, depositGas: 'self' })
      );
      expect(await escrow(channel.channelId)).toBe(DEPOSIT);
      expect(await txCount(payer.address)).toBe(1);
      expect(contacted).toBe(0);
    } finally {
      await new Promise((r) => spy.close(r));
    }
  }, 120_000);

  it('a token with neither, and no facilitator: the payer approves Permit2 and deposits, from its own ETH', async () => {
    const payer = await freshPayer(WETH, ONE_ETH);
    const channel = must(await open(payer, WETH, { facilitatorUrl: '' }, 'permit2'));
    expect(await escrow(channel.channelId)).toBe(DEPOSIT);
    expect(await txCount(payer.address)).toBe(2);
  }, 120_000);

  it('the facilitator the connector names, the caller naming none: it sponsors the approval of a wallet with no ETH', async () => {
    const payer = await freshPayer(WETH, 0n);
    const channel = must(await open(payer, WETH, { named: ONBOARDER_URL }, 'permit2'));
    expect(await escrow(channel.channelId)).toBe(DEPOSIT);
    expect(await txCount(payer.address)).toBe(1);
  }, 120_000);

  it('a facilitator that is down: a payer holding ETH deposits directly', async () => {
    const payer = await freshPayer(USDC, ONE_ETH);
    const channel = must(await open(payer, USDC, { facilitatorUrl: 'http://127.0.0.1:1' }));
    expect(await escrow(channel.channelId)).toBe(DEPOSIT);
    expect(await txCount(payer.address)).toBe(1);
  }, 120_000);

  it.each([
    // FiatToken's own refusal of a spent ERC-3009 nonce.
    ['eip3009', USDC, /authorization is used or canceled/],
    // Permit2's `InvalidNonce()`: its unordered nonce, already spent.
    ['permit2', WETH, /0x756688fe/],
  ] as const)(
    'one %s authorization lands once: the Onboarder settles it, and the payer’s own copy reverts',
    async (method, token, spent) => {
      // Enough of the token for two deposits, so only the spent authorization
      // can stop the second.
      const payer = await freshPayer(token, ONE_ETH, 2n * DEPOSIT);
      const wallet = evmWalletAccess({ rpcUrl: ANVIL_RPC, account: payer });
      if (method === 'permit2') await approvePermit2(wallet, token);
      const priced = offerFromTerms(must(chooseBatchSettlement(connectorTerms(token, method), 'evm')), 1n);
      if (priced.chain !== 'evm') throw new Error('unreachable');
      const offer = priced.offer;
      const config = buildBatchChannelConfig({ payer: payer.address, offer });
      const build = method === 'permit2' ? buildPermit2Deposit : buildEip3009Deposit;
      const payload = await build({
        payer,
        offer: { ...offer, extra: { ...offer.extra, withdrawDelay: config.withdrawDelay } },
        config,
        amount: DEPOSIT,
        voucherAmount: 1n,
      });

      const channelId = batchChannelId(config, 31337);
      await settleDeposit({ facilitatorUrl: ONBOARDER_URL, offer, payload });
      expect(await escrow(channelId)).toBe(DEPOSIT);
      // The payer's fallback, had the Onboarder's answer been lost: refused by
      // the spent nonce, not by the balance, which covers a second deposit.
      await expect(depositDirectly(wallet, payload, method)).rejects.toThrow(spent);
      expect(await escrow(channelId)).toBe(DEPOSIT);
    },
    120_000
  );
});
