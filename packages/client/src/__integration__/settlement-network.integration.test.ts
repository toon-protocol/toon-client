/**
 * The payer, through each real settlement network, on local chains: it opens
 * a channel, pays a packet from it, and covers a charge its deposit cannot
 * (toon-client#778).
 *
 *   - **EVM**: an `anvil` seeded by toon-protocol/infra's
 *     `sandbox/scripts/seed-x402.sh` (`x402BatchSettlement` at its production
 *     address, Circle's FiatToken as USDC). The payer holds ETH and deposits
 *     from its own wallet (`depositGas: 'self'`), so no facilitator is needed;
 *     a charge over the deposit tops the same channel up.
 *   - **Solana**: a `solana-test-validator` running solana-foundation's
 *     `payment-channels` (infra's `artifacts/payment_channels.so`). The sponsor
 *     endpoint is a fetch the test answers, co-signing as the connector's fee
 *     payer would; a charge over the deposit replaces the channel with a fresh
 *     sponsored one.
 *
 * Needs `anvil`, `cast`, `solana-test-validator` on PATH and an infra checkout
 * beside this one (or `INFRA_SANDBOX_DIR`). Absent any of them it SKIPS, unless
 * `CLIENT_REQUIRE_BATCH_SETTLEMENT=1` makes that a failure.
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
  http,
  parseAbi,
  recoverTypedDataAddress,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';

import { directFetch } from '../transport/rpc.js';
import { BatchChannelManager } from '../channel/batch-settlement/manager.js';
import { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { evmSettlementNetwork } from '../channel/batch-settlement/evm-network.js';
import { SolanaSettlementNetwork } from '../channel/batch-settlement/solana-network.js';
import {
  X402_BATCH_SETTLEMENT_ADDRESS,
  readEvmBatchChannel,
} from '../channel/batch-settlement/evm.js';
import {
  PAYMENT_CHANNELS_PROGRAM_ID,
  buildSvmVoucherMessage,
  getSvmBatchChannel,
} from '../channel/batch-settlement/svm.js';
import { parseSelfDescription } from '../connector/self-description.js';
import {
  deriveAssociatedTokenAccount,
  solanaRpc,
  waitForConfirmation,
} from '../channel/solana/payment-channel.js';
import {
  parseSolanaWireTransaction,
  signSolanaWireTransaction,
} from '../channel/solana/wire-transaction.js';
import { base58Decode, base58Encode } from '../utils/base58.js';
import { must } from '../utils/must.test-support.js';
import { STORED_FORMS } from '../channel/batch-settlement/stored-forms.test-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INFRA = process.env['INFRA_SANDBOX_DIR'] ?? resolve(HERE, '../../../../../infra/sandbox');
const REQUIRE = process.env['CLIENT_REQUIRE_BATCH_SETTLEMENT'] === '1';
const CONNECTOR = 'https://node.example';

function onPath(bin: string, arg = '--version'): boolean {
  return spawnSync(bin, [arg], { stdio: 'ignore' }).status === 0;
}

const MISSING = [
  !onPath('anvil') && 'anvil',
  !onPath('cast') && 'cast',
  !onPath('solana-test-validator') && 'solana-test-validator',
  !existsSync(join(INFRA, 'scripts', 'seed-x402.sh')) && `an infra checkout at ${INFRA}`,
].filter(Boolean);

if (MISSING.length > 0) {
  const why = `settlement network suite needs ${MISSING.join(', ')}`;
  if (REQUIRE) throw new Error(`CLIENT_REQUIRE_BATCH_SETTLEMENT=1 but ${why}`);
  console.warn(`SKIPPING: ${why}`);
}

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

function stop(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null) child.kill('SIGKILL');
}

// ─── EVM ────────────────────────────────────────────────────────────────────

const ANVIL_PORT = 18845;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
/** seed-x402.sh's FiatToken, and its owner (anvil-mnemonic index 21), which mints. */
const X402_USDC = '0x0A867CA0442383c2A89951244B955AA19b615b58';
const USDC_OWNER_KEY = '0xc511b2aa70776d4ff1d376e8537903dae36896132c90b91d52c1dfbae267cd8b';
/** anvil's account #1, the connector — the channel's receiver. */
const CONNECTOR_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EVM_DEPOSIT = 1_000_000n;

describe.skipIf(MISSING.length > 0)('the payer through the EVM settlement network', () => {
  let anvil: ChildProcess | undefined;
  const chain = defineChain({
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_RPC] } },
  });
  const pub = createPublicClient({ chain, transport: http(ANVIL_RPC) });
  const account = privateKeyToAccount(generatePrivateKey());
  const description = parseSelfDescription({
    batchSettlements: [
      {
        network: 'eip155:31337',
        asset: X402_USDC,
        payTo: CONNECTOR_ADDRESS,
        receiverAuthorizer: CONNECTOR_ADDRESS,
        withdrawDelay: 900,
        name: 'USDC',
        version: '2',
        assetTransferMethod: 'eip3009',
      },
    ],
  });

  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore' });
    await waitFor('anvil', 30_000, async () => (await pub.getChainId()) === 31337);
    const seeded = spawnSync('sh', [join(INFRA, 'scripts', 'seed-x402.sh')], {
      env: { ...process.env, RPC_URL: ANVIL_RPC, ARTIFACTS_DIR: join(INFRA, 'artifacts', 'evm') },
      encoding: 'utf8',
    });
    if (seeded.status !== 0) throw new Error(`seed-x402.sh failed:\n${seeded.stderr}`);
    const owner = createWalletClient({
      account: privateKeyToAccount(USDC_OWNER_KEY),
      chain,
      transport: http(ANVIL_RPC),
    });
    await pub.waitForTransactionReceipt({
      hash: await owner.writeContract({
        address: X402_USDC,
        abi: parseAbi(['function mint(address to, uint256 amount) returns (bool)']),
        functionName: 'mint',
        args: [account.address, 3n * EVM_DEPOSIT],
      }),
    });
    await pub.request({
      method: 'anvil_setBalance' as never,
      params: [account.address, '0xde0b6b3a7640000'] as never,
    });
  }, 120_000);

  afterAll(() => stop(anvil));

  it('opens, pays and tops up on the real contract', async () => {
    const manager = new BatchChannelManager(STORED_FORMS);
    const payer = new BatchSettlementPayer({
      connector: CONNECTOR,
      manager,
      deposit: EVM_DEPOSIT,
      networks: [
        evmSettlementNetwork({
          account,
          rpc: { url: ANVIL_RPC, fetch: directFetch },
          fetch: directFetch,
          depositGas: 'self',
        }),
      ],
    });

    // Open, and pay the first packet.
    const first = must(await payer.claimFor(description, 'evm', 400_000n));
    first.settle({ kind: 'banked' });
    expect(first.cumulative).toBe(400_000n);
    expect((await readEvmBatchChannel(pub, first.channelId as Hex)).balance).toBe(EVM_DEPOSIT);
    const signer = await recoverTypedDataAddress({
      domain: {
        name: 'x402 Batch Settlement',
        version: '1',
        chainId: 31337,
        verifyingContract: X402_BATCH_SETTLEMENT_ADDRESS,
      },
      types: {
        Voucher: [
          { name: 'channelId', type: 'bytes32' },
          { name: 'maxClaimableAmount', type: 'uint128' },
        ],
      },
      primaryType: 'Voucher',
      message: { channelId: first.channelId as Hex, maxClaimableAmount: 400_000n },
      signature: first.claim['signature'] as Hex,
    });
    expect(signer).toBe(account.address);

    // A charge the deposit cannot cover tops the same channel up.
    const second = must(await payer.claimFor(description, 'evm', 800_000n));
    expect(second.channelId).toBe(first.channelId);
    expect(second.cumulative).toBe(1_200_000n);
    expect((await readEvmBatchChannel(pub, first.channelId as Hex)).balance).toBe(
      2n * EVM_DEPOSIT
    );
    expect(manager.depositTotal(first.channelId)).toBe(2n * EVM_DEPOSIT);
  }, 120_000);
});

// ─── Solana ─────────────────────────────────────────────────────────────────

const RPC_PORT = 18950;
const SOLANA_RPC = { url: `http://127.0.0.1:${RPC_PORT}`, fetch: directFetch };
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const SOL_DEPOSIT = 1_000_000n;
const SOL_HELD = 3_000_000n;

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

describe.skipIf(MISSING.length > 0)('the payer through the Solana settlement network', () => {
  const PAYER = keypair('settlement-network-payer');
  const SPONSOR = keypair('settlement-network-sponsor');
  const RECEIVER = keypair('settlement-network-receiver');
  const MINT = base58Encode(keypair('settlement-network-mint').publicKey);
  const PAYER_ATA = deriveAssociatedTokenAccount(PAYER.address, MINT);
  let validator: ChildProcess | undefined;
  let workDir: string | undefined;
  const description = parseSelfDescription({
    batchSettlements: [
      {
        network: 'solana:local',
        asset: MINT,
        payTo: RECEIVER.address,
        feePayer: SPONSOR.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        sponsorEndpoint: '/ilp/sponsor',
        minDeposit: '0',
        withdrawDelay: 900,
      },
    ],
  });

  /**
   * The connector's sponsor endpoint: co-sign as the fee payer, send, and
   * answer with the channel the open created.
   */
  const opened: string[] = [];
  const sponsor = (async (_url: string, init?: RequestInit) => {
    const { transaction } = JSON.parse(must(init).body as string) as { transaction: string };
    const signature = (await solanaRpc(SOLANA_RPC, 'sendTransaction', [
      signSolanaWireTransaction(transaction, [SPONSOR]),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ])) as string;
    await waitForConfirmation(SOLANA_RPC, signature);
    let channelId: string | undefined;
    for (const key of parseSolanaWireTransaction(transaction).staticAccounts) {
      const info = (await solanaRpc(SOLANA_RPC, 'getAccountInfo', [
        key,
        { encoding: 'base64', commitment: 'confirmed' },
      ])) as { value: { owner: string; executable: boolean } | null };
      if (info.value?.owner === PAYMENT_CHANNELS_PROGRAM_ID && !info.value.executable) {
        if ((await getSvmBatchChannel(SOLANA_RPC, key)) !== null) channelId = key;
      }
    }
    opened.push(must(channelId));
    return new Response(
      JSON.stringify({
        channelId,
        transaction: signature,
        payer: PAYER.address,
        deposit: SOL_DEPOSIT.toString(),
      })
    );
  }) as typeof fetch;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'toon-settlement-network-'));
    const mint = new Uint8Array(82);
    mint.set(u64(SOL_HELD), 36);
    mint[44] = 6;
    mint[45] = 1;
    const ata = new Uint8Array(165);
    ata.set(base58Decode(MINT), 0);
    ata.set(base58Decode(PAYER.address), 32);
    ata.set(u64(SOL_HELD), 64);
    ata[108] = 1;
    const system = (address: string) =>
      accountFile(must(workDir), address, SYSTEM_PROGRAM_ID, 1_000_000_000, new Uint8Array(0));
    const accounts: [string, string][] = [
      [PAYER.address, system(PAYER.address)],
      [SPONSOR.address, system(SPONSOR.address)],
      [MINT, accountFile(workDir, MINT, TOKEN_PROGRAM_ID, 1_461_600, mint)],
      [PAYER_ATA, accountFile(workDir, PAYER_ATA, TOKEN_PROGRAM_ID, 2_039_280, ata)],
    ];
    validator = spawn(
      'solana-test-validator',
      [
        '--ledger',
        join(workDir, 'ledger'),
        '--rpc-port',
        String(RPC_PORT),
        '--faucet-port',
        '18949',
        '--gossip-port',
        '18945',
        '--dynamic-port-range',
        '18910-18940',
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
      async () => ((await solanaRpc(SOLANA_RPC, 'getSlot', [])) as number) >= 2
    );
  }, 180_000);

  afterAll(() => {
    stop(validator);
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('opens through the sponsor, pays, and replaces a channel it cannot cover', async () => {
    const manager = new BatchChannelManager(STORED_FORMS);
    const payer = new BatchSettlementPayer({
      connector: CONNECTOR,
      manager,
      deposit: SOL_DEPOSIT,
      networks: [
        new SolanaSettlementNetwork({
          signer: PAYER,
          rpc: SOLANA_RPC,
          fetch: sponsor,
          connector: CONNECTOR,
        }),
      ],
    });

    // Open, and pay the first packet.
    const first = must(await payer.claimFor(description, 'solana', 600_000n));
    first.settle({ kind: 'banked' });
    expect(opened).toEqual([first.channelId]);
    expect(first.cumulative).toBe(600_000n);
    expect(must(await getSvmBatchChannel(SOLANA_RPC, first.channelId)).deposit).toBe(SOL_DEPOSIT);
    expect(
      ed25519.verify(
        base58Decode(first.claim['signature'] as string),
        buildSvmVoucherMessage(first.channelId, 600_000n),
        PAYER.publicKey
      )
    ).toBe(true);

    // A charge the deposit cannot cover replaces the channel with a fresh one.
    const second = must(await payer.claimFor(description, 'solana', 600_000n));
    expect(second.channelId).not.toBe(first.channelId);
    expect(opened).toEqual([first.channelId, second.channelId]);
    expect(second.cumulative).toBe(600_000n);
    expect(must(await getSvmBatchChannel(SOLANA_RPC, second.channelId)).deposit).toBe(
      SOL_DEPOSIT
    );
    // The old channel is archived, not forgotten: close and settle still find it.
    expect(manager.openChannels(CONNECTOR).map((c) => c.channelId)).toEqual(
      expect.arrayContaining([first.channelId, second.channelId])
    );
  }, 180_000);
});
