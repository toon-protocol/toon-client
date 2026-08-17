/**
 * Receive-side Solana settlement — REAL on-chain redemption through the CLIENT's
 * own path (toon-client#604).
 *
 * Every check that existed on this path before was a closed loop. The SDK signed
 * a digest and the SDK verified the same digest; the emitted transaction was
 * asserted only to be non-empty; the client's Solana submit branch answered
 * `SUBMISSION_UNSUPPORTED` and so was never exercised at all. That is how a
 * bundle no validator could execute (toon#214) and a `programId` read out of an
 * EVM-only config map (#604) both survived: a unit test asserting bytes cannot
 * catch bytes that merely look right.
 *
 * So this test asserts nothing about bytes. It runs the client's real pipeline —
 *
 *   ingestReceivedClaims  (receive-side verify, persists a watermark)
 *     → buildSwapSettlements  (resolves signer.programId, builds via the sdk)
 *       → submitSolanaSettlement  (patch blockhash, sign, broadcast, confirm)
 *
 * — against a local `solana-test-validator` running the REAL native
 * payment-channel program, and then reads the channel account back off chain and
 * requires that `nonce_a` / `transferred_amount_a` MOVED. Nothing but a
 * transaction the program actually accepted can make that assertion pass.
 *
 * What runs here:
 *   1. A `solana-test-validator` with the real program (vendored, size- and
 *      sha256-asserted — see `fixtures/solana/README.md`) loaded at genesis via
 *      `--bpf-program`.
 *   2. A real 178-byte `ChannelState` at its correctly-derived PDA, owned by the
 *      program, seeded at genesis via `--account`. Claim redemption touches no
 *      SPL vault, so a channel account is all the program needs — which keeps
 *      this harness free of `spl-token`, deposits and ATAs.
 *   3. The client pipeline above. The claim recipient is THIS client, and it is
 *      account 0 of the compiled message: fee payer and sole required signer, so
 *      it redeems unilaterally.
 *
 * Plus the two mirror-image negatives that make the pass meaningful:
 *   - a REPLAYED nonce is refused by the program, with state untouched;
 *   - a claim signed over the LEGACY `balanceProofHashSolana` digest — what every
 *     maker signed before toon#214 — is refused by the client's receive-side
 *     verify, and, forced past it, by the chain.
 *
 * Requires `solana-test-validator` on PATH (Agave v2.1.x; v3 hard-requires
 * io_uring, which some sandboxes lack). Absent, this suite SKIPS — unless
 * `CLIENT_REQUIRE_SOLANA=1`, which turns "not available" into a hard failure so a
 * CI job can never report success having run nothing.
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
  balanceProofHashSolana,
  balanceProofMessageSolana,
  base58Decode,
  base58Encode,
} from '@toon-protocol/core';
import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';

import { InMemoryReceivedClaimStore } from '../channel/ReceivedClaimStore.js';
import { ingestReceivedClaims } from '../swap/received-claims.js';
import { buildSwapSettlements } from '../swap/settle-received-claims.js';
import {
  buildSolanaSettlementTransaction,
  decodeSolanaSettlementClaimAmounts,
  submitSolanaSettlement,
  SolanaSettlementError,
} from '../swap/solana-settlement.js';

// ---------------------------------------------------------------------------
// Fixture / topology constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM_SO = join(HERE, 'fixtures', 'solana', 'payment_channel.so');
/** See fixtures/solana/README.md — must match connector's build byte-for-byte. */
const PROGRAM_SO_BYTES = 109_416;
const PROGRAM_SO_SHA256 =
  'b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600';

/**
 * connector's `LOCAL_TEST_PROGRAM_ID`
 * (`crates/connector-settlement-solana/src/test_support.rs`), also what swap's
 * and the sdk's harnesses load the same binary at. The program has no
 * `declare_id!`, so one shared local id means one shared set of PDAs.
 */
const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Deliberately distinct from swap's 18899/18898 and the sdk harness's
 * 18999/18998: a developer running several suites at once must not have one
 * silently attach to another's validator and assert against its state.
 */
const RPC_PORT = 18799;
const FAUCET_PORT = 18798;
const DYNAMIC_PORT_RANGE = '18760-18790';
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
  return sha256(new TextEncoder().encode(`toon-client-solana-settle/${label}`));
}

/** The maker's claim signer: the channel participant whose balance advances. */
const MAKER_SEED = seedFor('maker');
const MAKER_PUBKEY = base58Encode(
  new Uint8Array(ed25519.getPublicKey(MAKER_SEED))
);
/** THIS client: the claim recipient. Signs + pays for the redemption. */
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
  participantA: string;
  participantB: string;
  transferredA: bigint;
  transferredB: bigint;
  nonceA: bigint;
  nonceB: bigint;
  state: number;
}

function decodeChannelState(data: Uint8Array): DecodedChannel {
  expect(data.length).toBe(CHANNEL_ACCOUNT_SIZE);
  expect(Array.from(data.slice(0, 8))).toEqual(
    Array.from(CHANNEL_DISCRIMINATOR)
  );
  return {
    participantA: base58Encode(data.slice(8, 40)),
    participantB: base58Encode(data.slice(40, 72)),
    transferredA: readU64LE(data, OFFSETS.transferredA),
    transferredB: readU64LE(data, OFFSETS.transferredB),
    nonceA: readU64LE(data, OFFSETS.nonceA),
    nonceB: readU64LE(data, OFFSETS.nonceB),
    state: data[OFFSETS.state] as number,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC (test-side only — the submitter uses the client's own transport)
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

const channel = deriveChannelPda(
  MAKER_PUBKEY,
  RECIPIENT_PUBKEY,
  TOKEN_MINT,
  PROGRAM_ID
);

let validator: ChildProcess | undefined;
let workDir: string | undefined;
let ready = false;

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
  if (!validatorAvailable()) {
    if (REQUIRE_SOLANA) {
      throw new Error(
        'CLIENT_REQUIRE_SOLANA=1 but solana-test-validator is not on PATH. ' +
          'Install Agave v2.1.x: sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"'
      );
    }
    console.log(
      'Skipping Solana redemption proof: solana-test-validator not on PATH'
    );
    return;
  }
  assertProgramFixture();

  workDir = mkdtempSync(join(tmpdir(), 'toon-client-solana-'));
  const channelAccountFile = writeAccountFile(
    workDir,
    'channel.json',
    channel.pda,
    PROGRAM_ID,
    2_000_000,
    encodeChannelState(channel.bump)
  );
  const feePayerFile = writeAccountFile(
    workDir,
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
      join(workDir, 'ledger'),
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
  // A loader-v3 program is invocable only from the slot AFTER its ProgramData's
  // `slot`, which for a genesis `--bpf-program` is 0. The validator answers
  // `getHealth: ok` while still at slot 0 for a second or two, and a transaction
  // sent in that window fails with "Program is not deployed" /
  // InstructionError::InvalidAccountData — an error with nothing to do with the
  // instruction being built. Wait the slot out.
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
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claim construction
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

/** The pre-toon#214 scheme: a signature over a digest no program verifies. */
function legacyClaimFor(nonce: bigint, amount: bigint): AccumulatedClaim {
  const digest = balanceProofHashSolana(
    channel.pda,
    amount,
    nonce,
    RECIPIENT_PUBKEY
  );
  return {
    ...claimFor(nonce, amount),
    claimBytes: new Uint8Array(ed25519.sign(digest, MAKER_SEED)),
  };
}

/**
 * The client's real receive-side path: verify + persist the watermark, then build
 * the settlement bundle from what was persisted.
 *
 * Deliberately goes through `ingestReceivedClaims` rather than hand-building a
 * `ReceivedClaimEntry`, so the receive-side verify — the half that still checked
 * the legacy digest before the sdk bump — is part of what this proves.
 */
function ingestAndBuild(
  claim: AccumulatedClaim,
  opts: {
    solanaProgramId?: string;
    tokenNetworks?: Record<string, string>;
  } = {}
): ReturnType<typeof buildSwapSettlements>[number] {
  const store = new InMemoryReceivedClaimStore();
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

  const builds = buildSwapSettlements({
    entries: store.list(),
    verifySignatures: true,
    ...(opts.solanaProgramId ? { solanaProgramId: opts.solanaProgramId } : {}),
    ...(opts.tokenNetworks ? { tokenNetworks: opts.tokenNetworks } : {}),
  });
  expect(builds).toHaveLength(1);
  return builds[0] as ReturnType<typeof buildSwapSettlements>[number];
}

/** Ingest → build → submit, through the client's own submitter. */
async function redeem(
  claim: AccumulatedClaim,
  seed: Uint8Array = RECIPIENT_SEED
): Promise<string> {
  const build = ingestAndBuild(claim, { solanaProgramId: PROGRAM_ID });
  expect(
    build.error,
    `build failed: ${JSON.stringify(build.error)}`
  ).toBeUndefined();
  const bundle = build.bundle;
  if (!bundle) throw new Error('no bundle');
  const { txHash } = await submitSolanaSettlement(bundle, {
    rpcUrl: RPC_URL,
    recipientSeed: seed,
  });
  return txHash;
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe.runIf(validatorAvailable() || REQUIRE_SOLANA)(
  'receive-side Solana settlement redeems against the real program',
  { timeout: 120_000 },
  () => {
    it('[P0] the genesis channel is a real, program-owned ChannelState at its derived PDA', async () => {
      expect(ready).toBe(true);
      const state = await readChannel();
      // The program re-derives this PDA from the stored participants + mint and
      // rejects a mismatch (PaymentChannelError::InvalidPDA), so reading it back
      // through its own layout also proves the derivation above is correct.
      expect(state.participantA).toBe(MAKER_PUBKEY);
      expect(state.participantB).toBe(RECIPIENT_PUBKEY);
      expect(state.state).toBe(0); // Opened
      expect(state.nonceA).toBe(0n);
      expect(state.transferredA).toBe(0n);
    });

    it('[P0] #604 was the blocker: without a solanaProgramId the build fails, and tokenNetworks is NOT a substitute', () => {
      const claim = claimFor(1n, 250_000n);

      // No programId at all.
      const missing = ingestAndBuild(claim);
      expect(missing.bundle).toBeUndefined();
      expect(missing.error?.code).toBe('MISSING_CHAIN_CONFIG');

      // The EVM-only leg-A map, which is what this branch read before #604.
      // Passing it must change NOTHING — otherwise settlement would be addressed
      // to a TokenNetwork rather than to the program owning the channel PDA.
      const viaTokenNetworks = ingestAndBuild(claim, {
        tokenNetworks: { [SOLANA_CHAIN]: PROGRAM_ID },
      });
      expect(viaTokenNetworks.bundle).toBeUndefined();
      expect(viaTokenNetworks.error?.code).toBe('MISSING_CHAIN_CONFIG');

      // The correct source builds.
      const built = ingestAndBuild(claim, { solanaProgramId: PROGRAM_ID });
      expect(built.error).toBeUndefined();
      expect(built.bundle).toBeDefined();
    });

    it('[P0] a claim redeems: the transaction executes and on-chain state MOVES', async () => {
      const nonce = 1n;
      const amount = 250_000n;
      const before = await readChannel();
      expect(before.nonceA).toBe(0n);
      expect(before.transferredA).toBe(0n);

      // What the transaction claims to do, read out of the program's OWN
      // instruction data rather than from the bundle's summary fields — so a
      // builder that dropped or reordered them cannot pass by agreeing with
      // itself.
      const build = ingestAndBuild(claimFor(nonce, amount), {
        solanaProgramId: PROGRAM_ID,
      });
      const bundle = build.bundle;
      if (!bundle) throw new Error(`no bundle: ${JSON.stringify(build.error)}`);
      expect(decodeSolanaSettlementClaimAmounts(bundle)).toEqual({
        nonce,
        transferredAmount: amount,
      });

      const txHash = await submitSolanaSettlement(bundle, {
        rpcUrl: RPC_URL,
        recipientSeed: RECIPIENT_SEED,
      });
      expect(txHash.txHash).toBeTruthy();

      const after = await readChannel();
      // Printed so a CI log carries the evidence that this suite did real work.
      console.log(
        `[solana-settle] tx ${txHash.txHash} moved ${channel.pda}: ` +
          `nonce_a ${before.nonceA} -> ${after.nonceA}, ` +
          `transferred_amount_a ${before.transferredA} -> ${after.transferredA}`
      );
      // The maker is participant A, so ITS slots advance — and only those.
      expect(after.nonceA).toBe(nonce);
      expect(after.transferredA).toBe(amount);
      expect(after.nonceB).toBe(0n);
      expect(after.transferredB).toBe(0n);
      expect(after.state).toBe(0);
    });

    it('[P0] a second, higher claim advances the same channel again', async () => {
      const nonce = 2n;
      const amount = 500_000n;
      await redeem(claimFor(nonce, amount));
      const after = await readChannel();
      expect(after.nonceA).toBe(nonce);
      expect(after.transferredA).toBe(amount);
    });

    it('[P0] a replayed nonce is refused BY THE PROGRAM, state untouched', async () => {
      const before = await readChannel();
      await expect(
        redeem(claimFor(before.nonceA, before.transferredA))
      ).rejects.toThrow(SolanaSettlementError);
      const after = await readChannel();
      expect(after.nonceA).toBe(before.nonceA);
      expect(after.transferredA).toBe(before.transferredA);
    });

    it('[P0] a LEGACY-digest claim is refused by the receive-side verify, and by the chain if forced (toon#214)', async () => {
      const before = await readChannel();
      const nonce = before.nonceA + 1n;
      const amount = before.transferredA + 1_000n;

      // 1. The client's receive-side verify refuses it. This is what the sdk
      //    bump bought: before it, the client verified the legacy digest and
      //    would have REJECTED the redeemable claim above while ACCEPTING this
      //    unredeemable one — exactly backwards.
      const store = new InMemoryReceivedClaimStore();
      const ingested = ingestReceivedClaims({
        claims: [legacyClaimFor(nonce, amount)],
        expectedChain: SOLANA_CHAIN,
        chainRecipient: RECIPIENT_PUBKEY,
        expectedSignerAddress: MAKER_PUBKEY,
        store,
      });
      expect(ingested.verified).toEqual([]);
      expect(ingested.rejected).toHaveLength(1);
      expect(store.list()).toEqual([]);

      // 2. Forced past the client entirely — a bundle built from a good claim,
      //    then submitted with the legacy signature swapped in — the CHAIN
      //    refuses it: the Ed25519 precompile cannot verify a signature over a
      //    different message.
      const build = ingestAndBuild(claimFor(nonce, amount), {
        solanaProgramId: PROGRAM_ID,
      });
      const bundle = build.bundle;
      if (!bundle) throw new Error('no bundle');
      const legacySig = new Uint8Array(
        ed25519.sign(
          balanceProofHashSolana(channel.pda, amount, nonce, RECIPIENT_PUBKEY),
          MAKER_SEED
        )
      );
      // Splice the legacy signature into the precompile instruction's inline
      // signature slot, leaving everything else the sdk built untouched.
      const forged = new Uint8Array(bundle.unsignedTxBytes);
      const at = indexOfSubarray(forged, bundle.unsignedTxBytes.slice(-24));
      expect(at).toBeGreaterThan(0); // claim instruction found
      const sigAt = indexOfSubarray(forged, extractPrecompileSignature(bundle));
      expect(sigAt).toBeGreaterThan(0);
      forged.set(legacySig, sigAt);
      await expect(
        submitSolanaSettlement(
          { ...bundle, unsignedTxBytes: forged },
          { rpcUrl: RPC_URL, recipientSeed: RECIPIENT_SEED }
        )
      ).rejects.toThrow(SolanaSettlementError);

      // 3. Nothing moved.
      const after = await readChannel();
      expect(after.nonceA).toBe(before.nonceA);
      expect(after.transferredA).toBe(before.transferredA);
    });

    it('[P0] a client that is not the claim recipient is refused LOCALLY, before broadcast', async () => {
      const before = await readChannel();
      const build = ingestAndBuild(claimFor(before.nonceA + 1n, 900_000n), {
        solanaProgramId: PROGRAM_ID,
      });
      const bundle = build.bundle;
      if (!bundle) throw new Error('no bundle');
      // The recipient is account 0 of the compiled message: fee payer and sole
      // required signer. Signing with anyone else yields a transaction the chain
      // rejects for reasons that name nothing; fail here instead.
      expect(() =>
        buildSolanaSettlementTransaction(bundle, {
          recipientSeed: STRANGER_SEED,
          recentBlockhash: new Uint8Array(32).fill(1),
        })
      ).toThrow(/not the recipient of this claim/);
      const after = await readChannel();
      expect(after.nonceA).toBe(before.nonceA);
    });
  }
);

/** First index of `needle` in `haystack`, or -1. */
function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * The 64 bytes the sdk inlined into the Ed25519 precompile instruction as the
 * maker's signature. Read out of the message via the precompile header's own
 * `signature_offset` field (little-endian u16 at byte 6 of the instruction data)
 * rather than a hard-coded position.
 */
function extractPrecompileSignature(bundle: {
  unsignedTxBytes: Uint8Array;
}): Uint8Array {
  const bytes = bundle.unsignedTxBytes;
  // The precompile instruction data begins with num_signatures(1) padding(1)
  // then the SignatureOffsets struct: signature_offset(2) ... — and the offsets
  // are relative to the start of that instruction data. Locate it by its
  // distinctive 16-byte header prefix.
  const header = new Uint8Array([1, 0]);
  for (let i = 0; i + 112 + 48 <= bytes.length; i++) {
    if (bytes[i] !== header[0] || bytes[i + 1] !== header[1]) continue;
    const sigOffset =
      (bytes[i + 2] as number) | ((bytes[i + 3] as number) << 8);
    const msgOffset =
      (bytes[i + 10] as number) | ((bytes[i + 11] as number) << 8);
    if (sigOffset === 48 && msgOffset === 112) {
      return bytes.slice(i + sigOffset, i + sigOffset + 64);
    }
  }
  throw new Error('could not locate the Ed25519 precompile signature');
}
