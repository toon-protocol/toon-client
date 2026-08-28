/**
 * The Solana payment-channel lifecycle, against a real `solana-test-validator`:
 * **initialize → deposit → sign a v2 claim → redeem it → close → settle**, plus
 * the two negatives that make the positive mean anything.
 *
 * Everything on this path used to be a closed loop. The client signed a message
 * and the client verified the same message; the emitted transaction was asserted
 * only to be well-shaped. That is how a claim no validator would execute
 * survived: a unit test asserting bytes cannot catch bytes that merely look
 * right. So this suite asserts almost nothing about bytes. It runs the client's
 * real builders — `openSolanaChannel`, `depositSolanaChannel`,
 * `signBalanceProofMessage`, `claimFromSolanaChannel`, `closeSolanaChannel`,
 * `settleSolanaChannel` — against the REAL program, and then reads the chain
 * back and requires that it moved. Nothing but a transaction the program
 * actually accepted can make these assertions pass.
 *
 * ## What the negatives are for
 *
 * 1. **A legacy 48-byte signature is refused.** The pre-ADR-0053 message was
 *    `channelAccount || nonce || amount` and bound nothing about which
 *    deployment the channel lived on, so a signature was valid for its channel
 *    account on any cluster where that account existed. The program now rebuilds
 *    a 96-byte message including its OWN program id and refuses anything of a
 *    different length before it compares a byte. Signing the old message here
 *    and watching the chain refuse it is what turns "we migrated" from a claim
 *    into evidence — and it is only evidence because the vendored program is a
 *    post-ADR-0053 build (see `fixtures/solana/README.md`).
 * 2. **A replayed nonce is refused.** `ClaimFromChannel` demands
 *    `nonce > stored_nonce`. A captured claim is therefore spent once, on chain,
 *    regardless of what any off-chain watermark believes.
 *
 * ## What runs here
 *
 * A `solana-test-validator` with the vendored program (size- and
 * sha256-asserted) loaded at genesis via `--bpf-program`, plus genesis accounts
 * for two funded wallets, an SPL mint and a token account for each wallet. The
 * channel account and its vault are NOT seeded: they are created by the
 * program itself, because "initialize actually initializes" is one of the things
 * under test.
 *
 * Requires `solana-test-validator` on PATH (Agave v2.1.x; v3 hard-requires
 * io_uring, which some sandboxes lack). Absent, this suite SKIPS with a message
 * naming what is missing — unless `CLIENT_REQUIRE_SOLANA=1`, which turns "not
 * available" into a hard failure so a CI job can never report success having run
 * nothing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base58Decode, base58Encode } from '../utils/base58.js';
import {
  buildClaimFromChannelInstructions,
  buildEd25519VerifyInstruction,
  claimFromSolanaChannel,
  closeSolanaChannel,
  deriveChannelPDA,
  deriveVaultPDA,
  getChannelAccountState,
  getTokenAccountBalance,
  openSolanaChannel,
  settleSolanaChannel,
  settleableAt,
  signBalanceProofMessage,
  solanaRpc,
  buildAndSendTransaction,
} from '../channel/solana/payment-channel.js';

// ---------------------------------------------------------------------------
// Fixture / topology constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM_SO = join(HERE, 'fixtures', 'solana', 'payment_channel.so');
/** See fixtures/solana/README.md — must match the connector's build exactly. */
const PROGRAM_SO_BYTES = 109_400;
const PROGRAM_SO_SHA256 =
  'ae2e91488c5b7920ca58279359d99cf8a3726d6b3f3b80a398a014af759e7e87';

/**
 * The connector's `LOCAL_TEST_PROGRAM_ID`
 * (`crates/connector-settlement-solana/src/test_support.rs`). The program has no
 * `declare_id!`, so one shared local id means one shared set of PDAs — and,
 * since ADR 0053, one shared set of signable balance proofs.
 */
const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/**
 * Deliberately distinct from the other local Solana harnesses in this org: a
 * developer running several suites at once must not have one silently attach to
 * another's validator and assert against its state.
 */
const RPC_PORT = 18799;
const FAUCET_PORT = 18798;
const DYNAMIC_PORT_RANGE = '18760-18790';
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

/** Enough to cover rent for the channel + vault the program creates, and fees. */
const WALLET_LAMPORTS = 1_000_000_000;
const RENT_EXEMPT_TOKEN_ACCOUNT = 2_039_280;
const RENT_EXEMPT_MINT = 1_461_600;

const MINT_DECIMALS = 6;
const INITIAL_TOKEN_BALANCE = 5_000_000n;
const DEPOSIT = 1_000_000n;
const CLAIM_AMOUNT = 250_000n;
const CLAIM_NONCE = 1n;
/**
 * Zero, so `settle` is legal the moment `close` lands. The challenge period is
 * the counterparty's window to redeem a newer proof, and this suite redeems
 * BEFORE closing, so there is nothing for a wait to protect — it would only add
 * wall-clock to a test that already proves the deadline arithmetic through
 * `settleableAt`.
 */
const CHALLENGE_DURATION = 0n;

const REQUIRE_SOLANA = process.env['CLIENT_REQUIRE_SOLANA'] === '1';

// ---------------------------------------------------------------------------
// Keys — deterministic, throwaway, local-only
// ---------------------------------------------------------------------------

function seedFor(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`toon-client-solana-lifecycle/${label}`));
}

/** THIS client: opens the channel, deposits, and signs the balance proof. */
const PAYER_SEED = seedFor('payer');
const PAYER = base58Encode(new Uint8Array(ed25519.getPublicKey(PAYER_SEED)));
/** The apex's settlement key: redeems the payer's proof, unilaterally. */
const PEER_SEED = seedFor('peer');
const PEER = base58Encode(new Uint8Array(ed25519.getPublicKey(PEER_SEED)));

/** Plain 32-byte addresses. Neither a mint nor a token account is ever a signer. */
const MINT = base58Encode(seedFor('mint'));
const PAYER_TOKEN_ACCOUNT = base58Encode(seedFor('payer-token'));
const PEER_TOKEN_ACCOUNT = base58Encode(seedFor('peer-token'));

const channel = deriveChannelPDA(PAYER, PEER, MINT, PROGRAM_ID);
const vault = deriveVaultPDA(channel.pda, PROGRAM_ID);

// ---------------------------------------------------------------------------
// SPL Token account encodings (spl_token::state)
// ---------------------------------------------------------------------------

function u64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(i * 8)) & 0xffn);
  return out;
}

/** `spl_token::state::Mint` — 82 bytes, both COption authorities set to None. */
function encodeMint(supply: bigint): Uint8Array {
  const data = new Uint8Array(82);
  // [0..4) mint_authority COption tag = 0 (None); [4..36) unused pubkey
  data.set(u64LE(supply), 36);
  data[44] = MINT_DECIMALS;
  data[45] = 1; // is_initialized
  // [46..50) freeze_authority COption tag = 0 (None)
  return data;
}

/** `spl_token::state::Account` — 165 bytes, Initialized, no delegate. */
function encodeTokenAccount(owner: string, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(base58Decode(MINT), 0);
  data.set(base58Decode(owner), 32);
  data.set(u64LE(amount), 64);
  // [72..76) delegate COption tag = 0 (None)
  data[108] = 1; // AccountState::Initialized
  // [109..113) is_native COption = 0; [121..129) delegated_amount = 0
  // [129..133) close_authority COption = 0
  return data;
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

const HAVE_VALIDATOR = validatorAvailable();

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
let workDir: string | undefined;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  return (await solanaRpc(RPC_URL, method, params)) as T;
}

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (!HAVE_VALIDATOR && !REQUIRE_SOLANA) {
  // Printed at collection time so the reason is in the report next to the
  // skipped block, not buried in a hook that never ran.
  console.log(
    'SKIPPING the Solana channel lifecycle: `solana-test-validator` is not on ' +
      'PATH. Install Agave v2.1.x — sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)" ' +
      '— or set CLIENT_REQUIRE_SOLANA=1 to make its absence a failure.'
  );
}

describe.skipIf(!HAVE_VALIDATOR && !REQUIRE_SOLANA)(
  'Solana payment-channel lifecycle against a real validator',
  () => {
    beforeAll(async () => {
      if (!HAVE_VALIDATOR) {
        // Only reachable with CLIENT_REQUIRE_SOLANA=1 — a CI job asking to be
        // told, loudly, that it ran nothing.
        throw new Error(
          'CLIENT_REQUIRE_SOLANA=1 but solana-test-validator is not on PATH. ' +
            'Install Agave v2.1.x: sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"'
        );
      }
      assertProgramFixture();

      workDir = mkdtempSync(join(tmpdir(), 'toon-client-solana-'));
      const accounts: [string, string][] = [
        [
          PAYER,
          writeAccountFile(
            workDir,
            'payer.json',
            PAYER,
            SYSTEM_PROGRAM_ID,
            WALLET_LAMPORTS,
            new Uint8Array(0)
          ),
        ],
        [
          PEER,
          writeAccountFile(
            workDir,
            'peer.json',
            PEER,
            SYSTEM_PROGRAM_ID,
            WALLET_LAMPORTS,
            new Uint8Array(0)
          ),
        ],
        [
          MINT,
          writeAccountFile(
            workDir,
            'mint.json',
            MINT,
            TOKEN_PROGRAM_ID,
            RENT_EXEMPT_MINT,
            encodeMint(INITIAL_TOKEN_BALANCE)
          ),
        ],
        [
          PAYER_TOKEN_ACCOUNT,
          writeAccountFile(
            workDir,
            'payer-token.json',
            PAYER_TOKEN_ACCOUNT,
            TOKEN_PROGRAM_ID,
            RENT_EXEMPT_TOKEN_ACCOUNT,
            encodeTokenAccount(PAYER, INITIAL_TOKEN_BALANCE)
          ),
        ],
        [
          PEER_TOKEN_ACCOUNT,
          writeAccountFile(
            workDir,
            'peer-token.json',
            PEER_TOKEN_ACCOUNT,
            TOKEN_PROGRAM_ID,
            RENT_EXEMPT_TOKEN_ACCOUNT,
            encodeTokenAccount(PEER, 0n)
          ),
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
          String(FAUCET_PORT),
          '--dynamic-port-range',
          DYNAMIC_PORT_RANGE,
          '--bpf-program',
          PROGRAM_ID,
          PROGRAM_SO,
          ...accounts.flatMap(([pubkey, file]) => ['--account', pubkey, file]),
          '--reset',
          '--quiet',
        ],
        { stdio: 'ignore' }
      );

      await waitFor('validator health', 90_000, async () => {
        const health = await rpc<string>('getHealth', []);
        return health === 'ok';
      });
      await waitFor('program at genesis', 30_000, async () => {
        const info = await rpc<{ value: { executable: boolean } | null }>(
          'getAccountInfo',
          [PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed' }]
        );
        return info.value !== null && info.value.executable;
      });
      // A loader-v3 program is invocable only from the slot AFTER its
      // ProgramData's `slot`, which for a genesis `--bpf-program` is 0. The
      // validator answers `getHealth: ok` while still at slot 0 for a second or
      // two, and a transaction sent in that window fails with "Program is not
      // deployed" — an error with nothing to do with the instruction being
      // built. Wait the slot out.
      await waitFor('first slot after genesis', 60_000, async () => {
        const slot = await rpc<number>('getSlot', []);
        return slot >= 1;
      });
    }, 180_000);

    afterAll(async () => {
      if (validator) {
        validator.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        if (validator.exitCode === null) validator.kill('SIGKILL');
      }
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    // ── the lifecycle, in order ──────────────────────────────────────────────
    // These tests share on-chain state on purpose: a channel HAS a lifecycle,
    // and each step's precondition is the previous step's effect. Splitting
    // them into independent tests would mean re-deriving that state by hand,
    // which is exactly the closed loop this suite exists to escape.

    it('initializes and collateralizes a channel the program accepts', async () => {
      const result = await openSolanaChannel({
        rpcUrl: RPC_URL,
        programId: PROGRAM_ID,
        tokenMint: MINT,
        payerSeed: PAYER_SEED,
        payerPubkey: PAYER,
        peerPubkey: PEER,
        challengeDuration: CHALLENGE_DURATION,
        deposit: { amount: DEPOSIT, payerTokenAccount: PAYER_TOKEN_ACCOUNT },
      });

      expect(result.opened).toBe(true);
      expect(result.channelPDA).toBe(channel.pda);
      expect(result.initTxSignature).toBeTruthy();
      expect(result.depositTxSignature).toBeTruthy();

      const account = await getChannelAccountState(RPC_URL, channel.pda);
      expect(account.exists).toBe(true);
      expect(account.state).toBe('opened');
      expect(account.tokenMint).toBe(MINT);
      expect(account.challengeDuration).toBe(CHALLENGE_DURATION);
      expect(account.bump).toBe(channel.bump);
      // Participants are stored SORTED, whatever order they were handed in.
      expect([account.participantA, account.participantB].sort()).toEqual(
        [PAYER, PEER].sort()
      );
      expect(ownDeposit(account)).toBe(DEPOSIT);
      expect(peerDeposit(account)).toBe(0n);
      expect(ownNonce(account)).toBe(0n);

      // The collateral really left the payer's token account for the vault.
      expect(await getTokenAccountBalance(RPC_URL, PAYER_TOKEN_ACCOUNT)).toBe(
        INITIAL_TOKEN_BALANCE - DEPOSIT
      );
      expect(await getTokenAccountBalance(RPC_URL, vault.pda)).toBe(DEPOSIT);
    });

    it('is idempotent: a second open neither re-initializes nor over-deposits', async () => {
      const again = await openSolanaChannel({
        rpcUrl: RPC_URL,
        programId: PROGRAM_ID,
        tokenMint: MINT,
        payerSeed: PAYER_SEED,
        payerPubkey: PAYER,
        peerPubkey: PEER,
        challengeDuration: CHALLENGE_DURATION,
        deposit: { amount: DEPOSIT, payerTokenAccount: PAYER_TOKEN_ACCOUNT },
      });
      expect(again.opened).toBe(false);
      expect(again.depositTxSignature).toBeUndefined();
      expect(again.depositTotal).toBe(DEPOSIT);
      expect(await getTokenAccountBalance(RPC_URL, vault.pda)).toBe(DEPOSIT);
    });

    it('refuses a claim signed over the legacy 48-byte message', async () => {
      // The pre-ADR-0053 layout: `channelAccount || nonce || amount`, no domain
      // tag and no program id. The Ed25519 precompile still passes — the
      // signature IS genuine over those 48 bytes — so what refuses this is the
      // program's own length check on the message it rebuilt, which is the
      // point: the migration is enforced on chain, not by convention.
      const legacy = new Uint8Array(48);
      legacy.set(base58Decode(channel.pda), 0);
      legacy.set(u64LE(CLAIM_NONCE), 32);
      legacy.set(u64LE(CLAIM_AMOUNT), 40);
      const legacySignature = new Uint8Array(ed25519.sign(legacy, PAYER_SEED));

      const [, programIx] = buildClaimFromChannelInstructions({
        programId: PROGRAM_ID,
        channelPDA: channel.pda,
        claimerPubkey: PAYER,
        feePayerPubkey: PEER,
        nonce: CLAIM_NONCE,
        transferredAmount: CLAIM_AMOUNT,
        signature: legacySignature,
      });

      await expect(
        buildAndSendTransaction(
          RPC_URL,
          {
            publicKey: base58Decode(PEER),
            privateKey: PEER_SEED,
          },
          [
            buildEd25519VerifyInstruction(PAYER, legacySignature, legacy),
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the builder always returns two instructions
            programIx!,
          ]
        )
        // `InvalidSignature` (PaymentChannelError = 8) — the program's message
        // length check, NOT a precompile failure and not a malformed account
        // list. Asserting the code is what stops this passing for the wrong
        // reason, which a bare "it threw" would happily do.
      ).rejects.toThrow(/custom program error: 0x8\b/);

      const account = await getChannelAccountState(RPC_URL, channel.pda);
      expect(ownNonce(account)).toBe(0n);
      expect(ownTransferred(account)).toBe(0n);
    });

    it('redeems a v2 claim the counterparty submits unilaterally', async () => {
      // The payer signs; the PEER pays for and signs the transaction. The payer
      // never co-signs — its authorization is the balance proof itself, which
      // is what lets a connector redeem an inbound claim on its own.
      const signature = signBalanceProofMessage(
        PROGRAM_ID,
        channel.pda,
        CLAIM_NONCE,
        CLAIM_AMOUNT,
        PAYER_SEED
      );

      const { claimTxSignature } = await claimFromSolanaChannel({
        rpcUrl: RPC_URL,
        programId: PROGRAM_ID,
        channelPDA: channel.pda,
        claimerPubkey: PAYER,
        feePayerPubkey: PEER,
        feePayerSeed: PEER_SEED,
        nonce: CLAIM_NONCE,
        transferredAmount: CLAIM_AMOUNT,
        signature: new Uint8Array(signature),
      });
      expect(claimTxSignature).toBeTruthy();

      const account = await getChannelAccountState(RPC_URL, channel.pda);
      expect(ownNonce(account)).toBe(CLAIM_NONCE);
      expect(ownTransferred(account)).toBe(CLAIM_AMOUNT);
      // The peer's own side is untouched — a claim advances one participant.
      expect(peerNonce(account)).toBe(0n);
      // Redemption moves no tokens; it moves the watermark settlement divides on.
      expect(await getTokenAccountBalance(RPC_URL, vault.pda)).toBe(DEPOSIT);
    });

    it('refuses a replayed nonce, leaving the watermark where it was', async () => {
      const signature = signBalanceProofMessage(
        PROGRAM_ID,
        channel.pda,
        CLAIM_NONCE,
        CLAIM_AMOUNT,
        PAYER_SEED
      );

      await expect(
        claimFromSolanaChannel({
          rpcUrl: RPC_URL,
          programId: PROGRAM_ID,
          channelPDA: channel.pda,
          claimerPubkey: PAYER,
          feePayerPubkey: PEER,
          feePayerSeed: PEER_SEED,
          nonce: CLAIM_NONCE,
          transferredAmount: CLAIM_AMOUNT,
          signature: new Uint8Array(signature),
        })
        // `NonceNotMonotonic` (PaymentChannelError = 6).
      ).rejects.toThrow(/custom program error: 0x6\b/);

      const account = await getChannelAccountState(RPC_URL, channel.pda);
      expect(ownNonce(account)).toBe(CLAIM_NONCE);
      expect(ownTransferred(account)).toBe(CLAIM_AMOUNT);
    });

    it('closes the channel and stamps a settlement deadline', async () => {
      const { closeTxSignature } = await closeSolanaChannel({
        rpcUrl: RPC_URL,
        programId: PROGRAM_ID,
        channelPDA: channel.pda,
        closerSeed: PAYER_SEED,
        closerPubkey: PAYER,
      });
      expect(closeTxSignature).toBeTruthy();

      const account = await getChannelAccountState(RPC_URL, channel.pda);
      expect(account.state).toBe('closed');
      expect(account.closeTimestamp).toBeGreaterThan(0n);
      expect(settleableAt(account)).toBe(
        (account.closeTimestamp ?? 0n) + CHALLENGE_DURATION
      );
    });

    it('settles, paying each side deposit − sent + received', async () => {
      const before = await getChannelAccountState(RPC_URL, channel.pda);
      const participantAToken =
        before.participantA === PAYER ? PAYER_TOKEN_ACCOUNT : PEER_TOKEN_ACCOUNT;
      const participantBToken =
        before.participantA === PAYER ? PEER_TOKEN_ACCOUNT : PAYER_TOKEN_ACCOUNT;

      const { settleTxSignature } = await settleSolanaChannel({
        rpcUrl: RPC_URL,
        programId: PROGRAM_ID,
        channelPDA: channel.pda,
        callerSeed: PEER_SEED,
        callerPubkey: PEER,
        participantATokenAccount: participantAToken,
        participantBTokenAccount: participantBToken,
      });
      expect(settleTxSignature).toBeTruthy();

      // The payer gets its collateral back minus what it spent; the peer gets
      // exactly the redeemed claim.
      expect(await getTokenAccountBalance(RPC_URL, PAYER_TOKEN_ACCOUNT)).toBe(
        INITIAL_TOKEN_BALANCE - CLAIM_AMOUNT
      );
      expect(await getTokenAccountBalance(RPC_URL, PEER_TOKEN_ACCOUNT)).toBe(
        CLAIM_AMOUNT
      );

      // A settled channel's account is zeroed and its lamports reclaimed, so it
      // is indistinguishable from one that never existed — which is exactly
      // what `getChannelAccountState` reports.
      const after = await getChannelAccountState(RPC_URL, channel.pda);
      expect(after.exists).toBe(false);
      expect(await getTokenAccountBalance(RPC_URL, vault.pda)).toBeNull();
    });
  }
);

// ---------------------------------------------------------------------------
// Reading "our" side of a channel whose participants are stored sorted
// ---------------------------------------------------------------------------

function ownDeposit(account: {
  participantA?: string;
  depositA?: bigint;
  depositB?: bigint;
}): bigint {
  return account.participantA === PAYER
    ? (account.depositA ?? 0n)
    : (account.depositB ?? 0n);
}

function peerDeposit(account: {
  participantA?: string;
  depositA?: bigint;
  depositB?: bigint;
}): bigint {
  return account.participantA === PAYER
    ? (account.depositB ?? 0n)
    : (account.depositA ?? 0n);
}

function ownNonce(account: {
  participantA?: string;
  nonceA?: bigint;
  nonceB?: bigint;
}): bigint {
  return account.participantA === PAYER
    ? (account.nonceA ?? 0n)
    : (account.nonceB ?? 0n);
}

function peerNonce(account: {
  participantA?: string;
  nonceA?: bigint;
  nonceB?: bigint;
}): bigint {
  return account.participantA === PAYER
    ? (account.nonceB ?? 0n)
    : (account.nonceA ?? 0n);
}

function ownTransferred(account: {
  participantA?: string;
  transferredAmountA?: bigint;
  transferredAmountB?: bigint;
}): bigint {
  return account.participantA === PAYER
    ? (account.transferredAmountA ?? 0n)
    : (account.transferredAmountB ?? 0n);
}
