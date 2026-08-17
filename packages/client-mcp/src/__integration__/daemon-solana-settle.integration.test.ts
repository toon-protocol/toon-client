/**
 * The DAEMON end of receive-side Solana settlement — REAL on-chain redemption
 * through `ClientRunner.settleSwapClaims` (toon-client#608).
 *
 * toon-client#605 proved the CLIENT LIBRARY redeems: `ingestReceivedClaims ->
 * buildSwapSettlements -> submitSolanaSettlement` against a real
 * `solana-test-validator`. #610 wired that proof into CI. Neither exercises
 * what actually runs in production — `ClientRunner.settleSwapClaims`
 * (`packages/client-mcp/src/daemon/client-runner.ts`) — which does four
 * things the library proof cannot reach:
 *
 *   1. config plumbing: it reads `solanaProgramId` from
 *      `this.config.toonClientConfig.solanaChannel?.programId`, conditionally
 *      spread into the builder call — a daemon configured with an
 *      `rpcUrl` but no `programId` must report `MISSING_CHAIN_CONFIG`, not
 *      silently build nothing;
 *   2. delegation: it calls `this.identityClient.settleSwapBundle(bundle)`,
 *      not `submitSolanaSettlement` directly — this suite is the first to
 *      drive that call against a real chain;
 *   3. watermark persistence: on success it re-`load`s the entry and writes
 *      `settledNonce`/`settleTxHash`/`settledAt` back to the
 *      `ReceivedClaimStore`, and a second call on the same entry must report
 *      `ALREADY_SETTLED` and send NOTHING — proven here by reading on-chain
 *      `nonce_a` before and after and requiring it did not move;
 *   4. error surfacing: a `SolanaSettlementError` code (`RECIPIENT_MISMATCH`)
 *      must reach the caller verbatim rather than collapsing to the generic
 *      `SUBMISSION_FAILED` every other submit failure gets.
 *
 * `ClientRunner.start()`/`.bootstrap()` are never called: `settleSwapClaims`
 * only ever touches `this.identityClient`, `this.receivedClaimStore` and
 * `this.config`, and a real apex/relay network is not this seam. The
 * `identityClient` is nonetheless a REAL `ToonClient` — the same class
 * `daemon.ts` constructs in production — so `settleSwapBundle`'s Solana
 * branch really does call the real `submitSolanaSettlement` against the real
 * validator. Its `solanaSeed` is normally derived from a mnemonic inside
 * `start()` (`registerMnemonicChainSigners`), which requires the full network
 * bootstrap this daemon-plumbing proof does not need since
 * `settleSwapBundle` only reads the field; it is poked directly here, the
 * same pattern `ToonClient.channelDeclaration.test.ts`'s `startedClient()`
 * already uses for `state`.
 *
 * Requires `solana-test-validator` on PATH (Agave v2.1.x). Absent, this suite
 * SKIPS — unless `CLIENT_REQUIRE_SOLANA=1`, which turns "not available" into
 * a hard failure so a CI job can never report success having run nothing.
 * Belongs in the same CI job as toon-client#605/#610's proof (the validator
 * is already installed there and the flag already set) — see ci.yml's
 * `solana-settlement-proof` job.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  balanceProofMessageSolana,
  base58Decode,
  base58Encode,
} from '@toon-protocol/core';
import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import {
  ToonClient,
  ingestReceivedClaims,
  JsonFileReceivedClaimStore,
  type ToonClientConfig,
} from '@toon-protocol/client';

import { ClientRunner, type ToonClientLike } from '../daemon/client-runner.js';
import type { ResolvedDaemonConfig } from '../daemon/config.js';

// ---------------------------------------------------------------------------
// Fixture / topology constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM_SO = join(HERE, 'fixtures', 'solana', 'payment_channel.so');
/** See fixtures/solana/README.md — must match connector's build byte-for-byte. */
const PROGRAM_SO_BYTES = 109_416;
const PROGRAM_SO_SHA256 =
  'b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600';

/** connector's `LOCAL_TEST_PROGRAM_ID` — shared across every repo's fixture. */
const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Deliberately distinct from every other Solana validator this repo (or its
 * siblings) spins up: client's own redemption proof uses 18799/18798
 * (dynamic range 18760-18790), swap uses 18899/18898, the sdk harness uses
 * 18999/18998. A developer running several suites at once must not have one
 * silently attach to another's validator and assert against its state.
 */
const RPC_PORT = 18699;
const FAUCET_PORT = 18698;
const DYNAMIC_PORT_RANGE = '18660-18690';
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

/** ChannelState layout — connector packages/solana-program/src/state.rs. */
const CHANNEL_ACCOUNT_SIZE = 178;
/** ASCII "pchannel". */
const CHANNEL_DISCRIMINATOR = new Uint8Array([
  0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c,
]);
const OFFSETS = {
  participantA: 8,
  participantB: 40,
  tokenMint: 72,
  depositA: 104,
  depositB: 112,
  transferredA: 120,
  transferredB: 128,
  nonceA: 136,
  nonceB: 144,
  challengeDuration: 152,
  state: 160,
  closeTimestamp: 161,
  bump: 169,
} as const;

const DEPOSIT_A = 1_000_000n;
const CHALLENGE_DURATION = 3600n;
const FEE_PAYER_LAMPORTS = 1_000_000_000;

const SOLANA_CHAIN = 'solana:localnet';
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: SOLANA_CHAIN },
  rate: '1.0',
};

const REQUIRE_SOLANA = process.env['CLIENT_REQUIRE_SOLANA'] === '1';

// ---------------------------------------------------------------------------
// Keys — deterministic, throwaway, local-only
// ---------------------------------------------------------------------------

function seedFor(label: string): Uint8Array {
  return sha256(
    new TextEncoder().encode(`toon-client-mcp-daemon-solana/${label}`)
  );
}

/** The swap peer's claim signer: the channel participant whose balance advances. */
const MAKER_SEED = seedFor('maker');
const MAKER_PUBKEY = base58Encode(
  new Uint8Array(ed25519.getPublicKey(MAKER_SEED))
);
/** This daemon's identity: the claim recipient. Signs + pays for redemption. */
const RECIPIENT_SEED = seedFor('recipient');
const RECIPIENT_PUBKEY = base58Encode(
  new Uint8Array(ed25519.getPublicKey(RECIPIENT_SEED))
);
/** A key that is NOT the recipient — for the RECIPIENT_MISMATCH guard. */
const STRANGER_SEED = seedFor('stranger');
/** Any 32 bytes: `claim_from_channel` never touches the mint or a vault. */
const TOKEN_MINT = base58Encode(seedFor('mint'));

// ---------------------------------------------------------------------------
// Byte + PDA helpers (the program's own derivations, in TS)
// ---------------------------------------------------------------------------

function u64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 0; i < 8; i++) {
    out |= BigInt(bytes[offset + i] as number) << BigInt(i * 8);
  }
  return out;
}

/** True if 32 bytes decode to an Ed25519 curve point — a PDA must NOT. */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** `Pubkey::find_program_address` — first off-curve bump from 255 down. */
function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Uint8Array
): { pda: Uint8Array; bump: number } {
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, new Uint8Array([bump]), programId, marker];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      buf.set(part, cursor);
      cursor += part.length;
    }
    const candidate = sha256(buf);
    if (!isOnCurve(candidate)) return { pda: candidate, bump };
  }
  throw new Error('no viable PDA bump');
}

/** Seeds `[b"channel", min, max, mint]` — processor.rs `derive_channel_pda`. */
function deriveChannelPda(
  participantA: string,
  participantB: string,
  tokenMint: string,
  programId: string
): { pda: string; bump: number } {
  const sorted = [base58Decode(participantA), base58Decode(participantB)].sort(
    (x, y) => {
      for (let i = 0; i < 32; i++) {
        const dx = (x[i] as number) - (y[i] as number);
        if (dx !== 0) return dx;
      }
      return 0;
    }
  );
  const { pda, bump } = findProgramAddress(
    [
      new TextEncoder().encode('channel'),
      sorted[0] as Uint8Array,
      sorted[1] as Uint8Array,
      base58Decode(tokenMint),
    ],
    base58Decode(programId)
  );
  return { pda: base58Encode(pda), bump };
}

/** The one channel every test in this file reads, redeems against and re-reads. */
const channel = deriveChannelPda(
  MAKER_PUBKEY,
  RECIPIENT_PUBKEY,
  TOKEN_MINT,
  PROGRAM_ID
);

/** Serialize an Opened `ChannelState` the program will accept and mutate. */
function encodeChannelState(bump: number): Uint8Array {
  const data = new Uint8Array(CHANNEL_ACCOUNT_SIZE);
  data.set(CHANNEL_DISCRIMINATOR, 0);
  data.set(base58Decode(MAKER_PUBKEY), OFFSETS.participantA);
  data.set(base58Decode(RECIPIENT_PUBKEY), OFFSETS.participantB);
  data.set(base58Decode(TOKEN_MINT), OFFSETS.tokenMint);
  data.set(u64LE(DEPOSIT_A), OFFSETS.depositA);
  data.set(u64LE(0n), OFFSETS.depositB);
  data.set(u64LE(0n), OFFSETS.transferredA);
  data.set(u64LE(0n), OFFSETS.transferredB);
  data.set(u64LE(0n), OFFSETS.nonceA);
  data.set(u64LE(0n), OFFSETS.nonceB);
  data.set(u64LE(CHALLENGE_DURATION), OFFSETS.challengeDuration);
  data[OFFSETS.state] = 0; // Opened
  data.set(u64LE(0n), OFFSETS.closeTimestamp);
  data[OFFSETS.bump] = bump;
  return data;
}

interface DecodedChannel {
  transferredA: bigint;
  nonceA: bigint;
  state: number;
}

function decodeChannelState(data: Uint8Array): DecodedChannel {
  expect(data.length).toBe(CHANNEL_ACCOUNT_SIZE);
  expect(Array.from(data.slice(0, 8))).toEqual(
    Array.from(CHANNEL_DISCRIMINATOR)
  );
  return {
    transferredA: readU64LE(data, OFFSETS.transferredA),
    nonceA: readU64LE(data, OFFSETS.nonceA),
    state: data[OFFSETS.state] as number,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC (test-side only — the daemon's submitter uses its own transport)
// ---------------------------------------------------------------------------

async function rpc<T>(
  method: string,
  params: unknown[]
): Promise<{ result?: T; error?: { code: number; message: string } }> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
}

async function rpcOk<T>(method: string, params: unknown[]): Promise<T> {
  const body = await rpc<T>(method, params);
  if (body.error) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result as T;
}

interface AccountInfoValue {
  data: [string, string];
  owner: string;
  executable: boolean;
}

async function getAccount(pubkey: string): Promise<AccountInfoValue | null> {
  const result = await rpcOk<{ value: AccountInfoValue | null }>(
    'getAccountInfo',
    [pubkey, { encoding: 'base64', commitment: 'confirmed' }]
  );
  return result.value;
}

async function readChannel(): Promise<DecodedChannel> {
  const account = await getAccount(channel.pda);
  if (!account) throw new Error(`channel account ${channel.pda} not found`);
  expect(account.owner).toBe(PROGRAM_ID);
  return decodeChannelState(
    new Uint8Array(Buffer.from(account.data[0], 'base64'))
  );
}

// ---------------------------------------------------------------------------
// Validator lifecycle
// ---------------------------------------------------------------------------

function validatorAvailable(): boolean {
  const probe = spawnSync('solana-test-validator', ['--version'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

function assertProgramFixture(): void {
  const bytes = readFileSync(PROGRAM_SO);
  const digest = Buffer.from(sha256(new Uint8Array(bytes))).toString('hex');
  if (bytes.length !== PROGRAM_SO_BYTES || digest !== PROGRAM_SO_SHA256) {
    throw new Error(
      `vendored payment_channel.so drifted: ${bytes.length} bytes / ${digest} ` +
        `(expected ${PROGRAM_SO_BYTES} / ${PROGRAM_SO_SHA256}). ` +
        `Refresh it and the constants together — see fixtures/solana/README.md.`
    );
  }
}

/** A genesis account file in the `solana account --output json` shape. */
function writeAccountFile(
  dir: string,
  name: string,
  pubkey: string,
  owner: string,
  lamports: number,
  data: Uint8Array
): string {
  const path = join(dir, name);
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

let validator: ChildProcess | undefined;
let ready = false;
let tmpDir: string;
let apexStoreCounter = 0;

async function waitFor(
  label: string,
  timeoutMs: number,
  probe: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (validator && validator.exitCode !== null) {
      throw new Error(
        `solana-test-validator exited (code ${validator.exitCode}) while waiting for ${label}`
      );
    }
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

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'toon-client-mcp-daemon-solana-'));

  if (!validatorAvailable()) {
    if (REQUIRE_SOLANA) {
      throw new Error(
        'CLIENT_REQUIRE_SOLANA=1 but solana-test-validator is not on PATH. ' +
          'Install Agave v2.1.x: sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"'
      );
    }
    console.log(
      'Skipping daemon Solana settlement proof: solana-test-validator not on PATH'
    );
    return;
  }
  assertProgramFixture();

  const channelAccountFile = writeAccountFile(
    tmpDir,
    'channel.json',
    channel.pda,
    PROGRAM_ID,
    2_000_000,
    encodeChannelState(channel.bump)
  );
  const feePayerFile = writeAccountFile(
    tmpDir,
    'fee-payer.json',
    RECIPIENT_PUBKEY,
    SYSTEM_PROGRAM_ID,
    FEE_PAYER_LAMPORTS,
    new Uint8Array(0)
  );

  validator = spawn(
    'solana-test-validator',
    [
      '--ledger',
      join(tmpDir, 'ledger'),
      '--rpc-port',
      String(RPC_PORT),
      '--faucet-port',
      String(FAUCET_PORT),
      '--dynamic-port-range',
      DYNAMIC_PORT_RANGE,
      '--bpf-program',
      PROGRAM_ID,
      PROGRAM_SO,
      '--account',
      channel.pda,
      channelAccountFile,
      '--account',
      RECIPIENT_PUBKEY,
      feePayerFile,
      '--reset',
      '--quiet',
    ],
    { stdio: 'ignore' }
  );

  await waitFor('validator health', 90_000, async () => {
    const body = await rpc<string>('getHealth', []);
    return body.result === 'ok';
  });
  await waitFor('program at genesis', 30_000, async () => {
    const account = await getAccount(PROGRAM_ID);
    return account !== null && account.executable;
  });
  await waitFor('channel account at genesis', 30_000, async () => {
    const account = await getAccount(channel.pda);
    return account !== null && account.owner === PROGRAM_ID;
  });
  // See solana-settlement-redeem.integration.test.ts (packages/client) for why
  // this wait is necessary: a loader-v3 program at genesis is only invocable
  // from the slot AFTER slot 0.
  await waitFor('first slot after genesis', 60_000, async () => {
    const slot = await rpcOk<number>('getSlot', []);
    return slot >= 1;
  });
  ready = true;
}, 180_000);

afterAll(async () => {
  if (validator) {
    validator.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (validator.exitCode === null) validator.kill('SIGKILL');
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claim + daemon construction
// ---------------------------------------------------------------------------

function claimFor(nonce: bigint, amount: bigint): AccumulatedClaim {
  const message = balanceProofMessageSolana(
    base58Decode(channel.pda),
    nonce,
    amount
  );
  return {
    packetIndex: 0,
    sourceAmount: amount,
    targetAmount: amount,
    claimBytes: new Uint8Array(ed25519.sign(message, MAKER_SEED)),
    swapEphemeralPubkey: 'ab'.repeat(32),
    pair: PAIR,
    receivedAt: Date.now(),
    channelId: channel.pda,
    nonce: nonce.toString(),
    cumulativeAmount: amount.toString(),
    recipient: RECIPIENT_PUBKEY,
    swapSignerAddress: MAKER_PUBKEY,
  };
}

/** Verify + persist a claim into a fresh on-disk store — the daemon's real
 * receive-side path, exercised the same way `ClientRunner` would populate it
 * from a live swap (`toReceivedClaimInfo`), so `settleSwapClaims` reads a
 * store built by production code rather than a hand-built fixture. */
function seedStore(storePath: string, claim: AccumulatedClaim): void {
  const store = new JsonFileReceivedClaimStore(storePath);
  const ingested = ingestReceivedClaims({
    claims: [claim],
    expectedChain: SOLANA_CHAIN,
    chainRecipient: RECIPIENT_PUBKEY,
    expectedSignerAddress: MAKER_PUBKEY,
    store,
  });
  expect(
    ingested.rejected,
    `receive-side verify rejected the claim: ${JSON.stringify(
      ingested.rejected.map((r) => ({ code: r.code, message: r.message }))
    )}`
  ).toEqual([]);
  expect(ingested.verified).toHaveLength(1);
}

/**
 * Build a `ClientRunner` whose `identityClient` is a REAL `ToonClient` — the
 * same construction `daemon.ts` uses in production — configured to redeem
 * against the local validator. Never `.start()`ed or `.bootstrap()`ed:
 * `settleSwapClaims` only reaches `identityClient`/`receivedClaimStore`/
 * `config`, none of which need a live apex or relay.
 */
function makeRunner(opts: {
  storePath: string;
  solanaChannel?: { rpcUrl?: string; programId?: string };
  identitySeed?: Uint8Array;
}): ClientRunner {
  const seed = opts.identitySeed ?? RECIPIENT_SEED;
  const config: ResolvedDaemonConfig = {
    httpPort: 0,
    relayUrl: 'ws://relay.invalid',
    hasUplink: false,
    destination: 'g.proxy',
    publishDestination: 'g.proxy',
    storeDestination: 'g.proxy',
    feePerEvent: 1n,
    chain: 'evm',
    apexChannelStorePath: join(
      tmpDir,
      `apex-channels-${apexStoreCounter++}.json`
    ),
    receivedClaimStorePath: opts.storePath,
    toonClientConfig: {
      // Never dialed — the runner is never started/bootstrapped.
      btpUrl: 'ws://127.0.0.1:1/btp',
      ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.toon.test' },
      toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
      toonDecoder: (_t: string) => ({}) as never,
      ...(opts.solanaChannel ? { solanaChannel: opts.solanaChannel } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
  return new ClientRunner({
    config,
    createClient: (clientConfig: ToonClientConfig) => {
      const client = new ToonClient(clientConfig);
      // Solana/Mina signers are normally registered inside `start()`
      // (`registerMnemonicChainSigners`, derived from `config.mnemonic`),
      // which requires the full HTTP-mode network bootstrap — irrelevant to
      // this daemon-plumbing proof, since `settleSwapBundle`'s Solana branch
      // only reads `solanaSeed`. Poked directly, mirroring the `(client as
      // any).state = {...}` pattern `ToonClient.channelDeclaration.test.ts`'s
      // `startedClient()` already uses to exercise real methods without a
      // real `start()`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).solanaSeed = seed;
      return client as unknown as ToonClientLike;
    },
  });
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe.runIf(validatorAvailable() || REQUIRE_SOLANA)(
  'ClientRunner.settleSwapClaims redeems Solana claims against the real program (#608)',
  { timeout: 120_000 },
  () => {
    it('[P0] the genesis channel is a real, program-owned ChannelState at its derived PDA', async () => {
      expect(ready).toBe(true);
      const state = await readChannel();
      expect(state.state).toBe(0); // Opened
      expect(state.nonceA).toBe(0n);
      expect(state.transferredA).toBe(0n);
    });

    it('[P0] config plumbing: solanaChannel.rpcUrl with no programId reports MISSING_CHAIN_CONFIG, not a generic failure', async () => {
      const storePath = join(tmpDir, 'store-missing-config.json');
      seedStore(storePath, claimFor(1n, 250_000n));

      const runner = makeRunner({
        storePath,
        solanaChannel: { rpcUrl: RPC_URL }, // no programId
      });
      const res = await runner.settleSwapClaims({});
      expect(res.results).toHaveLength(1);
      const result = res.results[0]!;
      expect(result.built).toBe(false);
      expect(result.submitted).toBe(false);
      expect(result.error?.code).toBe('MISSING_CHAIN_CONFIG');
    });

    it('[P0] error surfacing: a claim recipient mismatch reports RECIPIENT_MISMATCH, not SUBMISSION_FAILED', async () => {
      const storePath = join(tmpDir, 'store-mismatch.json');
      seedStore(storePath, claimFor(77n, 999_000n));
      const before = await readChannel();

      // identityClient's Solana key is the STRANGER, not this channel's
      // recipient — a real, local SolanaSettlementError('RECIPIENT_MISMATCH')
      // from the real submitSolanaSettlement, not a mock.
      const runner = makeRunner({
        storePath,
        solanaChannel: { rpcUrl: RPC_URL, programId: PROGRAM_ID },
        identitySeed: STRANGER_SEED,
      });
      const res = await runner.settleSwapClaims({});
      expect(res.results).toHaveLength(1);
      const result = res.results[0]!;
      expect(result.built).toBe(true);
      expect(result.submitted).toBe(false);
      expect(result.error?.code).toBe('RECIPIENT_MISMATCH');
      expect(result.error?.message).toContain(
        'not the recipient of this claim'
      );

      // Nothing was ever broadcast: on-chain state is untouched.
      const after = await readChannel();
      expect(after.nonceA).toBe(before.nonceA);
      expect(after.transferredA).toBe(before.transferredA);
    });

    it('[P0] delegation: settleSwapClaims redeems for real through identityClient.settleSwapBundle — on-chain state moves and the watermark is persisted', async () => {
      const storePath = join(tmpDir, 'store-happy.json');
      const nonce = 1n;
      const amount = 250_000n;
      seedStore(storePath, claimFor(nonce, amount));

      const before = await readChannel();
      expect(before.nonceA).toBe(0n);

      const runner = makeRunner({
        storePath,
        solanaChannel: { rpcUrl: RPC_URL, programId: PROGRAM_ID },
      });
      const res = await runner.settleSwapClaims({});
      expect(res.results).toHaveLength(1);
      const result = res.results[0]!;
      expect(result.built).toBe(true);
      expect(result.submitted).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.txHash).toBeTruthy();

      const after = await readChannel();
      console.log(
        `[daemon-solana-settle] tx ${result.txHash} moved ${channel.pda}: ` +
          `nonce_a ${before.nonceA} -> ${after.nonceA}, ` +
          `transferred_amount_a ${before.transferredA} -> ${after.transferredA}`
      );
      expect(after.nonceA).toBe(nonce);
      expect(after.transferredA).toBe(amount);

      // The watermark was re-loaded and persisted — a fresh store read (not
      // the in-process runner) proves it actually hit disk.
      const persisted = new JsonFileReceivedClaimStore(storePath).load(
        SOLANA_CHAIN,
        channel.pda
      );
      expect(persisted?.settledNonce).toBe(nonce);
      expect(persisted?.settleTxHash).toBe(result.txHash);
      expect(persisted?.settledAt).toBeDefined();

      // A second call on the SAME watermark reports ALREADY_SETTLED and sends
      // NOTHING — proven by reading on-chain state, not just the response
      // shape: nonce_a must not move again.
      const again = await runner.settleSwapClaims({});
      expect(again.results).toHaveLength(1);
      const replay = again.results[0]!;
      expect(replay.built).toBe(false);
      expect(replay.submitted).toBe(false);
      expect(replay.error?.code).toBe('ALREADY_SETTLED');

      const afterReplay = await readChannel();
      expect(afterReplay.nonceA).toBe(nonce);
      expect(afterReplay.transferredA).toBe(amount);
    });
  }
);
