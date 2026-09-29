/**
 * Leaving an x402 `batch-settlement` channel, against the real contract and the
 * real program (connector ADR 0074, toon-client#691).
 *
 * Exit is the payer's own transaction and involves no connector, so it can be
 * proved end to end on local chains seeded with exactly what production runs:
 *
 *   - **EVM**: an `anvil` seeded by toon-protocol/infra's own
 *     `sandbox/scripts/seed-x402.sh` — `x402BatchSettlement` and its collectors
 *     at their production addresses (bytecode copied from Base Sepolia) and
 *     Circle's FiatToken v2.2 as an ERC-3009 USDC. A deposit is authorized by
 *     this client's `buildEip3009Deposit` and submitted by a third party, as a
 *     facilitator would; then `client.channel`'s `close()` starts the
 *     timed withdrawal, the chain's clock is moved past `withdrawDelay`, and
 *     `settle()` returns the deposit to the payer.
 *   - **Solana**: a `solana-test-validator` running solana-foundation's
 *     `payment-channels` at `CHNLx…` (infra's `artifacts/payment_channels.so`,
 *     dumped from mainnet-beta). The open is this client's `buildSponsoredOpen`,
 *     co-signed by a sponsor key the test holds; then `close()` sends
 *     `request_close`, and after the grace period `settle()` seals and
 *     `withdraw_payer`s the deposit back.
 *
 * The one liberty taken is a short exit window: `withdrawDelay` at the
 * contract's 15-minute floor (skipped with `evm_increaseTime`) and a one-second
 * `grace_period` (the program's own floor; a connector would publish a day).
 *
 * ## Running it
 *
 * Needs `anvil`, `cast`, `solana-test-validator` on PATH and an infra checkout
 * beside this one (or `INFRA_SANDBOX_DIR`). Absent any of them it SKIPS, unless
 * `CLIENT_REQUIRE_BATCH_SETTLEMENT=1` makes that a failure.
 *
 * ```bash
 * npx vitest run --config vitest.integration.config.ts \
 *   src/__integration__/batch-settlement-exit.integration.test.ts
 * ```
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  erc20Abi,
  http,
  parseAbi,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';

import {
  BatchChannelManager,
  type BatchChannel,
} from '../channel/batch-settlement/manager.js';
import type { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import {
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  X402_BATCH_SETTLEMENT_ADDRESS,
  batchChannelId,
  buildBatchChannelConfig,
  buildEip3009Deposit,
  readEvmBatchChannel,
  type BatchSettlementEvmOffer,
} from '../channel/batch-settlement/evm.js';
import {
  PAYMENT_CHANNELS_PROGRAM_ID,
  buildSponsoredOpen,
  getSvmBatchChannel,
  singleRecipientDistributionHash,
  type BatchSettlementSvmOffer,
  type SvmBatchChannelConfig,
} from '../channel/batch-settlement/svm.js';
import { ClientChannelFacade } from '../client/channel-facade.js';
import { parseSelfDescription } from '../connector/self-description.js';
import {
  deriveAssociatedTokenAccount,
  getLatestBlockhash,
  getTokenAccountBalance,
  solanaRpc,
  waitForConfirmation,
} from '../channel/solana/payment-channel.js';
import { signSolanaWireTransaction } from '../channel/solana/wire-transaction.js';
import { base58Decode, base58Encode } from '../utils/base58.js';
import { must } from '../utils/must.test-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA =
  process.env['INFRA_SANDBOX_DIR'] ??
  resolve(HERE, '../../../../../infra/sandbox');
const REQUIRE = process.env['CLIENT_REQUIRE_BATCH_SETTLEMENT'] === '1';
const CONNECTOR = 'https://node.example';

function onPath(bin: string, arg = '--version'): boolean {
  return spawnSync(bin, [arg], { stdio: 'ignore' }).status === 0;
}

const MISSING = [
  !onPath('anvil') && 'anvil',
  !onPath('cast') && 'cast',
  !onPath('solana-test-validator') && 'solana-test-validator',
  !existsSync(join(INFRA, 'scripts', 'seed-x402.sh')) &&
    `an infra checkout at ${INFRA}`,
].filter(Boolean);

if (MISSING.length > 0) {
  const why = `batch-settlement exit suite needs ${MISSING.join(', ')}`;
  if (REQUIRE) throw new Error(`CLIENT_REQUIRE_BATCH_SETTLEMENT=1 but ${why}`);
  console.warn(`SKIPPING: ${why}`);
}

async function waitFor(
  label: string,
  ms: number,
  probe: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function stop(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null) child.kill('SIGKILL');
}

// ─── EVM ────────────────────────────────────────────────────────────────────

const ANVIL_PORT = 18645;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
/** seed-x402.sh's FiatToken, and its owner (anvil-mnemonic index 21), which mints. */
const X402_USDC = '0x0A867CA0442383c2A89951244B955AA19b615b58';
const USDC_OWNER_KEY =
  '0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b';
/** anvil's account #0, standing in for a facilitator that submits the deposit. */
const RELAYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** anvil's account #1, the connector — the channel's receiver. */
const CONNECTOR_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EVM_DEPOSIT = 3_000_000n;
const WITHDRAW_DELAY = 900;

describe.skipIf(MISSING.length > 0)('x402 batch-settlement exit on EVM', () => {
  let anvil: ChildProcess | undefined;
  const chain = defineChain({
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_RPC] } },
  });
  const pub = createPublicClient({ chain, transport: http(ANVIL_RPC) });
  const payerKey = generatePrivateKey();
  const payer = privateKeyToAccount(payerKey);
  const manager = new BatchChannelManager();
  let channel: BatchChannel;

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'], {
      stdio: 'ignore',
    });
    await waitFor(
      'anvil',
      30_000,
      async () => (await pub.getChainId()) === 31337
    );
    const seeded = spawnSync('sh', [join(INFRA, 'scripts', 'seed-x402.sh')], {
      env: {
        ...process.env,
        RPC_URL: ANVIL_RPC,
        ARTIFACTS_DIR: join(INFRA, 'artifacts', 'evm'),
      },
      encoding: 'utf8',
    });
    if (seeded.status !== 0)
      throw new Error(`seed-x402.sh failed:\n${seeded.stderr}`);

    const owner = createWalletClient({
      account: privateKeyToAccount(USDC_OWNER_KEY),
      chain,
      transport: http(ANVIL_RPC),
    });
    await pub.waitForTransactionReceipt({
      hash: await owner.writeContract({
        address: X402_USDC,
        abi: parseAbi([
          'function mint(address to, uint256 amount) returns (bool)',
        ]),
        functionName: 'mint',
        args: [payer.address, EVM_DEPOSIT],
      }),
    });
    // Exit is the one step that costs the payer gas.
    await pub.request({
      method: 'anvil_setBalance' as never,
      params: [payer.address, '0xde0b6b3a7640000'] as never,
    });
  }, 120_000);

  afterAll(() => stop(anvil));

  it('deposits under an ERC-3009 authorization this client signed, submitted by a third party', async () => {
    const offer: BatchSettlementEvmOffer = {
      scheme: 'batch-settlement',
      network: 'eip155:31337',
      amount: '1',
      asset: X402_USDC,
      payTo: CONNECTOR_ADDRESS,
      maxTimeoutSeconds: 300,
      extra: {
        receiverAuthorizer: CONNECTOR_ADDRESS,
        withdrawDelay: WITHDRAW_DELAY,
        name: 'USDC',
        version: '2',
      },
    };
    const config = buildBatchChannelConfig({ payer: payer.address, offer });
    const payload = await buildEip3009Deposit({
      payer,
      offer,
      config,
      amount: EVM_DEPOSIT,
      voucherAmount: 1n,
    });
    const auth = payload.deposit.authorization.erc3009Authorization;
    const collectorData = encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes' },
      ],
      [
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        BigInt(auth.salt),
        auth.signature,
      ]
    );
    const relayer = createWalletClient({
      account: privateKeyToAccount(RELAYER_KEY),
      chain,
      transport: http(ANVIL_RPC),
    });
    const receipt = await pub.waitForTransactionReceipt({
      hash: await relayer.writeContract({
        address: X402_BATCH_SETTLEMENT_ADDRESS,
        abi: parseAbi([
          'function deposit((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config, uint128 amount, address collector, bytes collectorData)',
        ]),
        functionName: 'deposit',
        args: [
          {
            payer: config.payer as Hex,
            payerAuthorizer: config.payerAuthorizer as Hex,
            receiver: config.receiver as Hex,
            receiverAuthorizer: config.receiverAuthorizer as Hex,
            token: config.token as Hex,
            withdrawDelay: config.withdrawDelay,
            salt: config.salt,
          },
          EVM_DEPOSIT,
          ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
          collectorData,
        ],
      }),
    });
    expect(receipt.status).toBe('success');

    channel = {
      chain: 'evm',
      channelId: batchChannelId(config, 31337),
      network: 'eip155:31337',
      config,
    };
    const state = await readEvmBatchChannel(pub, channel.channelId as Hex);
    expect(state.balance).toBe(EVM_DEPOSIT);
    manager.adopt(CONNECTOR, channel, EVM_DEPOSIT);
  });

  it('closes with a timed withdrawal, and settles the deposit back once the delay has passed', async () => {
    let now = BigInt((await pub.getBlock()).timestamp);
    const facade = new ClientChannelFacade({
      connector: CONNECTOR,
      payer: {} as BatchSettlementPayer,
      chain: 'evm',
      manager,
      describe: async () => parseSelfDescription({}),
      evm: {
        privateKey: Buffer.from(payerKey.slice(2), 'hex'),
        rpcUrl: ANVIL_RPC,
        rpcDispatcher: undefined,
      },
      now: () => now,
    });

    const closed = await facade.close();
    expect(closed).toHaveLength(1);
    expect(must(closed[0]).error).toBeUndefined();
    expect(must(closed[0]).transaction).toMatch(/^0x/);
    expect(
      (await readEvmBatchChannel(pub, channel.channelId as Hex))
        .pendingWithdrawal
    ).toBe(EVM_DEPOSIT);

    // Not yet: the delay has not passed.
    expect(await facade.settle()).toEqual([]);

    await pub.request({
      method: 'evm_increaseTime' as never,
      params: [WITHDRAW_DELAY + 1] as never,
    });
    await pub.request({ method: 'evm_mine' as never, params: [] as never });
    now = BigInt((await pub.getBlock()).timestamp);

    const settled = await facade.settle();
    expect(settled).toHaveLength(1);
    expect(must(settled[0]).error).toBeUndefined();
    const balance = await pub.readContract({
      address: X402_USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [payer.address],
    });
    expect(balance).toBe(EVM_DEPOSIT);
    expect(facade.channels()[0]!.settledAt).toBe(now);
  });
});

// ─── Solana ─────────────────────────────────────────────────────────────────

const RPC_PORT = 18899;
const SOLANA_RPC = `http://127.0.0.1:${RPC_PORT}`;
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SOL_DEPOSIT = 2_000_000n;

function keypair(label: string) {
  const privateKey = new Uint8Array(32);
  privateKey.set(new TextEncoder().encode(label).slice(0, 32));
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey, address: base58Encode(publicKey) };
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** A genesis account file in the `solana account --output json` shape. */
function accountFile(
  dir: string,
  pubkey: string,
  owner: string,
  lamports: number,
  data: Uint8Array
): string {
  const path = join(dir, `${pubkey}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      pubkey,
      account: {
        lamports,
        data: [Buffer.from(data).toString('base64'), 'base64'],
        owner,
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    })
  );
  return path;
}

describe.skipIf(MISSING.length > 0)(
  'x402 batch-settlement exit on Solana',
  () => {
    const PAYER = keypair('batch-exit-payer');
    const SPONSOR = keypair('batch-exit-sponsor');
    const RECEIVER = keypair('batch-exit-receiver');
    const MINT = base58Encode(keypair('batch-exit-mint').publicKey);
    const PAYER_ATA = deriveAssociatedTokenAccount(PAYER.address, MINT);
    let validator: ChildProcess | undefined;
    let workDir: string | undefined;
    const manager = new BatchChannelManager();
    let channel: BatchChannel;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'toon-batch-exit-'));
      const mint = new Uint8Array(82);
      mint.set(u64(SOL_DEPOSIT), 36);
      mint[44] = 6;
      mint[45] = 1;
      const ata = new Uint8Array(165);
      ata.set(base58Decode(MINT), 0);
      ata.set(base58Decode(PAYER.address), 32);
      ata.set(u64(SOL_DEPOSIT), 64);
      ata[108] = 1;
      const accounts: [string, string][] = [
        [
          PAYER.address,
          accountFile(
            workDir,
            PAYER.address,
            SYSTEM_PROGRAM_ID,
            1_000_000_000,
            new Uint8Array(0)
          ),
        ],
        [
          SPONSOR.address,
          accountFile(
            workDir,
            SPONSOR.address,
            SYSTEM_PROGRAM_ID,
            1_000_000_000,
            new Uint8Array(0)
          ),
        ],
        [MINT, accountFile(workDir, MINT, TOKEN_PROGRAM_ID, 1_461_600, mint)],
        [
          PAYER_ATA,
          accountFile(workDir, PAYER_ATA, TOKEN_PROGRAM_ID, 2_039_280, ata),
        ],
      ];
      validator = spawn(
        'solana-test-validator',
        [
          '--ledger',
          join(workDir, 'ledger'),
          '--rpc-port',
          String(RPC_PORT),
          '--faucet-port',
          '18898',
          '--dynamic-port-range',
          '18860-18890',
          '--bpf-program',
          PAYMENT_CHANNELS_PROGRAM_ID,
          join(INFRA, 'artifacts', 'payment_channels.so'),
          ...accounts.flatMap(([pubkey, file]) => ['--account', pubkey, file]),
          '--reset',
          '--quiet',
        ],
        { stdio: 'ignore' }
      );
      await waitFor(
        'validator',
        90_000,
        async () => (await solanaRpc(SOLANA_RPC, 'getHealth', [])) === 'ok'
      );
      await waitFor(
        'first slot',
        60_000,
        async () =>
          ((await solanaRpc(SOLANA_RPC, 'getSlot', [])) as number) >= 2
      );
    }, 180_000);

    afterAll(() => {
      stop(validator);
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    it('opens with this client’s sponsored open, co-signed by the sponsor', async () => {
      const offer: BatchSettlementSvmOffer = {
        scheme: 'batch-settlement',
        network: 'solana:local',
        amount: '1',
        asset: MINT,
        payTo: RECEIVER.address,
        maxTimeoutSeconds: 1,
        extra: {
          feePayer: SPONSOR.address,
          withdrawDelay: 1,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
      };
      const openSlot = BigInt(
        (await solanaRpc(SOLANA_RPC, 'getSlot', [
          { commitment: 'confirmed' },
        ])) as number
      );
      // A one-second grace period: the program's floor, below the 900 s x402 and
      // any connector would require, so the config is written out by hand.
      const config: SvmBatchChannelConfig = {
        payer: PAYER.address,
        payerAuthorizer: PAYER.address,
        receiver: RECEIVER.address,
        token: MINT,
        withdrawDelay: 1,
        salt: 7n,
        openSlot,
      };
      const { transaction, channelId } = buildSponsoredOpen({
        payer: PAYER,
        config,
        offer,
        connectorSponsor: SPONSOR.address,
        deposit: SOL_DEPOSIT,
        recentBlockhash: await getLatestBlockhash(SOLANA_RPC),
      });
      const cosigned = signSolanaWireTransaction(transaction, [SPONSOR]);
      const signature = (await solanaRpc(SOLANA_RPC, 'sendTransaction', [
        cosigned,
        { encoding: 'base64', preflightCommitment: 'confirmed' },
      ])) as string;
      await waitForConfirmation(SOLANA_RPC, signature);

      const state = await getSvmBatchChannel(SOLANA_RPC, channelId);
      expect(state).toMatchObject({
        status: 'open',
        deposit: SOL_DEPOSIT,
        settled: 0n,
        gracePeriod: 1,
        payer: PAYER.address,
        payee: SPONSOR.address,
        rentPayer: SPONSOR.address,
        authorizedSigner: PAYER.address,
        mint: MINT,
        openSlot,
      });
      expect(Buffer.from(must(state).distributionHash).toString('hex')).toBe(
        Buffer.from(singleRecipientDistributionHash(RECEIVER.address)).toString(
          'hex'
        )
      );
      expect(await getTokenAccountBalance(SOLANA_RPC, PAYER_ATA)).toBe(0n);

      channel = {
        chain: 'solana',
        channelId,
        network: 'solana:local',
        sponsor: SPONSOR.address,
        config,
      };
      manager.adopt(CONNECTOR, channel, SOL_DEPOSIT);
    });

    it('requests the close, then seals and withdraws the deposit back after the grace period', async () => {
      const facade = new ClientChannelFacade({
        connector: CONNECTOR,
        payer: {} as BatchSettlementPayer,
        chain: 'solana',
        manager,
        describe: async () => parseSelfDescription({}),
        solana: { signer: PAYER, rpc: SOLANA_RPC },
      });

      const closed = await facade.close();
      expect(must(closed[0]).error).toBeUndefined();
      expect(
        must(await getSvmBatchChannel(SOLANA_RPC, channel.channelId)).status
      ).toBe('closing');

      // The program reads the cluster's clock: wait until it is past the grace period.
      await new Promise((r) => setTimeout(r, 3_000));
      let settled = await facade.settle();
      for (
        let i = 0;
        i < 10 &&
        settled.some(
          (r) => r.error !== undefined || r.transaction === undefined
        );
        i++
      ) {
        await new Promise((r) => setTimeout(r, 1_000));
        settled = await facade.settle();
      }
      expect(settled).toHaveLength(1);
      expect(must(settled[0]).error).toBeUndefined();
      expect(await getTokenAccountBalance(SOLANA_RPC, PAYER_ATA)).toBe(
        SOL_DEPOSIT
      );
      const after = await getSvmBatchChannel(SOLANA_RPC, channel.channelId);
      expect(after?.status).toBe('sealed');
      expect(after?.payerWithdrawnAt).not.toBe(0n);
    });
  }
);
