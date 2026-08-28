import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode, base58Decode } from '../utils/base58.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { OnChainChannelClient } from './OnChainChannelClient.js';
import { ChannelFundingError } from '../client/errors.js';
import {
  deriveChannelPDA,
  deriveVaultPDA,
  deriveAssociatedTokenAccount,
  MIN_LAMPORTS_FOR_CHANNEL_OPEN,
} from './solana/payment-channel.js';

// Mock viem module
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
    createWalletClient: vi.fn(() => ({
      writeContract: mockWriteContract,
    })),
    // Mock decodeEventLog so we don't need real ABI-encoded log data
    decodeEventLog: vi.fn(({ topics }: { topics?: string[] }) => {
      // Return ChannelOpened event with channelId from topics[1]
      if (topics && topics.length >= 2) {
        return {
          eventName: 'ChannelOpened',
          args: { channelId: topics[1] },
        };
      }
      throw new Error('Unknown event');
    }),
  };
});


const TEST_CHAIN = 'evm:anvil:31337';
const TEST_TOKEN_NETWORK = '0x5FbDB2315678afecb367f032d93F642f64180aa3'; // Mock USDC address (used as test TokenNetwork)
const TEST_TOKEN = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TEST_PEER_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TEST_CHANNEL_ID = '0x' + 'ab'.repeat(32);

describe('OnChainChannelClient', () => {
  let signer: EvmSigner;
  let client: OnChainChannelClient;

  beforeEach(() => {
    vi.clearAllMocks();
    signer = new EvmSigner(generatePrivateKey());
    client = new OnChainChannelClient({
      evmSigner: signer,
      chainRpcUrls: { [TEST_CHAIN]: 'http://localhost:8545' },
    });
    // Base (un-queued) `readContract` answer: the `channels()` view of a
    // freshly opened, VISIBLE channel. The #489 read-after-write poll reads it
    // between `openChannel` and `setTotalDeposit`; queued `mockResolvedValueOnce`
    // values still take priority, so per-test sequences are unaffected.
    mockReadContract.mockResolvedValue([
      86400n,
      1,
      0n,
      1000n,
      signer.address,
      TEST_PEER_ADDRESS,
    ]);
  });


  describe('openSolanaChannel (on-chain)', () => {
    const SOLANA_CHAIN = 'solana:devnet';
    const PROGRAM_ID = 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG';
    const TOKEN_MINT = '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q';
    const APEX_PUBKEY = 'So11111111111111111111111111111111111111112';
    const BLOCKHASH = 'GfHq2tTVk9z4eXgZ8nWz3vWqkXBQ8K9aBcDeFgHiJkLm';

    // Deterministic 32-byte Ed25519 seed -> stable client pubkey.
    const seed = new Uint8Array(32).fill(9);
    const clientPubkey = base58Encode(
      new Uint8Array(ed25519.getPublicKey(seed))
    );

    let fetchMock: ReturnType<typeof vi.fn>;
    const origFetch = globalThis.fetch;

    /** Options describing the on-chain channel account the mock serves. */
    interface ChannelAccountOpts {
      /** participant_a — the payer, unless a test says otherwise. */
      participantA?: string;
      /** participant_b — the apex. */
      participantB?: string;
      /** PER-PARTICIPANT collateral, as the program records it. */
      depositA?: bigint;
      depositB?: bigint;
      channelState?: 'opened' | 'closed' | 'settled';
    }

    /**
     * A real 178-byte `pchannel` account, laid out exactly as the program's
     * `state.rs` does: `[0..8]` discriminator, `[8..40]` participant_a,
     * `[40..72]` participant_b, `[72..104]` token_mint, `[104..112]` deposit_a,
     * `[112..120]` deposit_b, `[160]` state.
     *
     * Built field-by-field rather than as a zero-filled stub, because the two
     * fields that drive top-up decisions — the participants and their SEPARATE
     * deposits — are precisely what a zero stub cannot express.
     */
    function channelAccountData(o: ChannelAccountOpts): Buffer {
      const data = Buffer.alloc(178);
      Buffer.from([0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c]).copy(
        data,
        0
      );
      Buffer.from(base58Decode(o.participantA ?? clientPubkey)).copy(data, 8);
      Buffer.from(base58Decode(o.participantB ?? APEX_PUBKEY)).copy(data, 40);
      Buffer.from(base58Decode(TOKEN_MINT)).copy(data, 72);
      data.writeBigUInt64LE(o.depositA ?? 0n, 104);
      data.writeBigUInt64LE(o.depositB ?? 0n, 112);
      data[160] = { opened: 0, closed: 1, settled: 2 }[
        o.channelState ?? 'opened'
      ];
      return data;
    }

    /**
     * Queue an account-exists/absent + tx-confirm RPC sequence.
     *
     * `tokenBalance` is what `getTokenAccountBalance` reports (base units) for
     * every SPL account; `tokenBalanceFor` overrides it per account (the vault
     * PDA and the payer ATA hold different amounts on the top-up path). `null`
     * models an account that does not exist — which real Solana reports as the
     * JSON-RPC error reproduced verbatim below, NOT as a zero balance.
     * `rpcThrowsFor` makes the named methods fail at the TRANSPORT level (fetch
     * rejects), which must never be read as evidence about a balance.
     * `lamports` is the payer's native SOL balance (default: comfortably above
     * the rent + fee floor a fresh open needs).
     */
    function mockRpc(
      channelExists: boolean,
      opts: ChannelAccountOpts & {
        tokenBalance?: string | null;
        tokenBalanceFor?: (account: string) => string | null;
        rpcThrowsFor?: string[];
        lamports?: number;
      } = {}
    ): void {
      const flat =
        opts.tokenBalance === undefined ? '1000000000' : opts.tokenBalance;
      const tokenBalanceFor = opts.tokenBalanceFor ?? (() => flat);
      const lamports = opts.lamports ?? 1_000_000_000;
      fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          method: string;
          params: unknown[];
        };
        if (opts.rpcThrowsFor?.includes(body.method)) {
          throw new TypeError('fetch failed');
        }
        let result: unknown;
        switch (body.method) {
          case 'getBalance':
            result = { value: lamports };
            break;
          case 'getTokenAccountBalance': {
            const balance = tokenBalanceFor(body.params[0] as string);
            if (balance === null) {
              return {
                ok: true,
                json: async () => ({
                  jsonrpc: '2.0',
                  id: 1,
                  error: {
                    code: -32602,
                    message: 'Invalid param: could not find account',
                  },
                }),
              } as unknown as Response;
            }
            result = { value: { amount: balance, decimals: 6 } };
            break;
          }
          case 'getAccountInfo':
            result = {
              value: channelExists
                ? {
                    data: [
                      channelAccountData(opts).toString('base64'),
                      'base64',
                    ],
                    owner: PROGRAM_ID,
                    lamports: 1,
                  }
                : null,
            };
            break;
          case 'getLatestBlockhash':
            result = { value: { blockhash: BLOCKHASH } };
            break;
          case 'sendTransaction':
            result = 'tx-signature-stub';
            break;
          case 'getSignatureStatuses':
            result = { value: [{ confirmationStatus: 'confirmed' }] };
            break;
          default:
            result = null;
        }
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: 1, result }),
        } as unknown as Response;
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }

    afterEach(() => {
      globalThis.fetch = origFetch;
    });

    function makeClient(): OnChainChannelClient {
      return new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
        solanaConfig: {
          rpcUrl: 'http://localhost:8899',
          keypair: seed,
          programId: PROGRAM_ID,
        },
      });
    }

    it('returns the connector-parity PDA as the channel id and submits init', async () => {
      mockRpc(false);
      const c = makeClient();
      const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });

      const expected = deriveChannelPDA(
        clientPubkey,
        APEX_PUBKEY,
        TOKEN_MINT,
        PROGRAM_ID
      ).pda;
      expect(result.channelId).toBe(expected);
      expect(result.status).toBe('opening');

      // An initialize_channel transaction was submitted.
      const sent = fetchMock.mock.calls.some((call) => {
        const body = JSON.parse((call[1] as RequestInit).body as string) as {
          method: string;
        };
        return body.method === 'sendTransaction';
      });
      expect(sent).toBe(true);
    });

    it('is idempotent — skips init when the channel account already exists', async () => {
      mockRpc(true);
      const c = makeClient();
      const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });

      const expected = deriveChannelPDA(
        clientPubkey,
        APEX_PUBKEY,
        TOKEN_MINT,
        PROGRAM_ID
      ).pda;
      expect(result.channelId).toBe(expected);

      const sent = fetchMock.mock.calls.some((call) => {
        const body = JSON.parse((call[1] as RequestInit).body as string) as {
          method: string;
        };
        return body.method === 'sendTransaction';
      });
      expect(sent).toBe(false);
    });

    it('reads on-chain channel state from the PDA account', async () => {
      mockRpc(true);
      const c = makeClient();
      const { channelId } = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });
      const state = await c.getChannelState(channelId);
      expect(state.chain).toBe(SOLANA_CHAIN);
      expect(state.status).toBe('open');
    });

    it('throws when token mint is missing', async () => {
      mockRpc(false);
      const c = makeClient();
      await expect(
        c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      })
      ).rejects.toThrow(/SPL mint/i);
    });

    // ── #473: the open runs on the NEGOTIATED program ─────────────────────────
    //
    // The greeting's `programId` reaches the opener as
    // `OpenChannelParams.tokenNetwork`, and the signed claim's metadata reports
    // that same program. The open used to ignore it and use config's, so a
    // divergence would open a channel on one program and assert another.
    describe('negotiated programId (#473)', () => {
      // A DIFFERENT program from the client's configured PROGRAM_ID.
      const GREETING_PROGRAM = '2aEVJ8koWQqLptzTBvPTgcrDsPYtC1jvDVzHVjkGpump';

      it('derives the PDA against the greeting programId, not the config one', async () => {
        mockRpc(false);
        const c = makeClient();
        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          programId: GREETING_PROGRAM,
          decimals: 6,
        },
      });

        expect(result.channelId).toBe(
          deriveChannelPDA(
            clientPubkey,
            APEX_PUBKEY,
            TOKEN_MINT,
            GREETING_PROGRAM
          ).pda
        );
        expect(result.channelId).not.toBe(
          deriveChannelPDA(clientPubkey, APEX_PUBKEY, TOKEN_MINT, PROGRAM_ID)
            .pda
        );
      });

      it('falls back to the config programId when the negotiation names none', async () => {
        mockRpc(false);
        const c = makeClient();
        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });

        expect(result.channelId).toBe(
          deriveChannelPDA(clientPubkey, APEX_PUBKEY, TOKEN_MINT, PROGRAM_ID)
            .pda
        );
      });

      it('sends a later deposit to the program the channel was opened on', async () => {
        mockRpc(false);
        const c = new OnChainChannelClient({
          evmSigner: signer,
          chainRpcUrls: {},
          solanaConfig: {
            rpcUrl: 'http://localhost:8899',
            keypair: seed,
            programId: PROGRAM_ID,
            tokenMint: TOKEN_MINT,
          },
        });
        const { channelId } = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          programId: GREETING_PROGRAM,
          decimals: 6,
        },
      });
        fetchMock.mockClear();

        await c.depositToChannel(channelId, 100n, { currentDeposit: 0n });

        // The vault PDA is program-scoped: the deposit must carry the vault of
        // the GREETING program, never the config program's.
        const txs = fetchMock.mock.calls
          .map(
            (call) =>
              JSON.parse((call[1] as RequestInit).body as string) as {
                method: string;
                params: unknown[];
              }
          )
          .filter((b) => b.method === 'sendTransaction')
          .map((b) => Buffer.from(b.params[0] as string, 'base64'));
        const negotiatedVault = Buffer.from(
          base58Decode(deriveVaultPDA(channelId, GREETING_PROGRAM).pda)
        );
        const configVault = Buffer.from(
          base58Decode(deriveVaultPDA(channelId, PROGRAM_ID).pda)
        );
        expect(txs.some((tx) => tx.indexOf(negotiatedVault) !== -1)).toBe(true);
        expect(txs.some((tx) => tx.indexOf(configVault) !== -1)).toBe(false);
      });
    });

    // ── connector#646: the open must COLLATERALIZE the channel ────────────────
    //
    // The Solana branch used to read only `solanaConfig.deposit` — an
    // operator-only field nothing on the rig/daemon/preset path sets — so every
    // negotiated open skipped the `deposit` instruction and left the vault at 0
    // while the connector happily accepted claims against it. It now honours
    // `OpenChannelParams.initialDeposit`, exactly as the EVM opener does.
    describe('deposit at open (connector#646)', () => {
      /** Raw bytes of every submitted transaction. */
      function sentTxBytes(): Uint8Array[] {
        return fetchMock.mock.calls
          .map(
            (call) =>
              JSON.parse((call[1] as RequestInit).body as string) as {
                method: string;
                params: unknown[];
              }
          )
          .filter((body) => body.method === 'sendTransaction')
          .map(
            (body) =>
              new Uint8Array(Buffer.from(body.params[0] as string, 'base64'))
          );
      }

      /** The 16-byte `deposit` instruction data for `amount` (discriminator 0x02). */
      function depositIxData(amount: bigint): Buffer {
        const data = Buffer.alloc(16);
        data[0] = 0x02;
        data.writeBigUInt64LE(amount, 8);
        return data;
      }

      /** True when some submitted tx carries the `deposit` ix for `amount`. */
      function depositedAmount(amount: bigint): boolean {
        const needle = depositIxData(amount);
        return sentTxBytes().some(
          (tx) => Buffer.from(tx).indexOf(needle) !== -1
        );
      }

      it('locks the negotiated initialDeposit on-chain and reports it as depositTotal', async () => {
        mockRpc(false);
        const c = makeClient();
        const result = await c.openChannel({
          terms: {
            kind: 'solana',
            chain: SOLANA_CHAIN,
            token: TOKEN_MINT,
            counterparty: APEX_PUBKEY,
            decimals: 6,
          },
          // What ChannelManager.ensureChannel always passes — and what the
          // Solana branch used to drop on the floor.
          initialDeposit: 100000n,
        });

        expect(depositedAmount(100000n)).toBe(true);
        expect(result.depositTotal).toBe(100000n);
      });

      it('pulls the deposit from the payer ATA derived from owner + mint', async () => {
        mockRpc(false);
        const c = makeClient();
        await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        const ata = deriveAssociatedTokenAccount(clientPubkey, TOKEN_MINT);
        // The balance preflight reads exactly the account the deposit spends from.
        const checked = fetchMock.mock.calls.map(
          (call) =>
            JSON.parse((call[1] as RequestInit).body as string) as {
              method: string;
              params: unknown[];
            }
        );
        expect(
          checked.some(
            (b) => b.method === 'getTokenAccountBalance' && b.params[0] === ata
          )
        ).toBe(true);
        // …and that account's 32 raw bytes ride in the deposit transaction.
        const ataBytes = Buffer.from(base58Decode(ata));
        expect(
          sentTxBytes().some((tx) => Buffer.from(tx).indexOf(ataBytes) !== -1)
        ).toBe(true);
      });

      it('lets an explicit solanaConfig.deposit override the negotiated amount', async () => {
        mockRpc(false);
        const c = new OnChainChannelClient({
          evmSigner: signer,
          chainRpcUrls: {},
          solanaConfig: {
            rpcUrl: 'http://localhost:8899',
            keypair: seed,
            programId: PROGRAM_ID,
            tokenMint: TOKEN_MINT,
            deposit: { amount: '7', payerTokenAccount: APEX_PUBKEY },
          },
        });
        await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        expect(depositedAmount(7n)).toBe(true);
        expect(depositedAmount(100000n)).toBe(false);
      });

      it('opts out of the deposit entirely on an explicit 0 amount', async () => {
        mockRpc(false);
        const c = new OnChainChannelClient({
          evmSigner: signer,
          chainRpcUrls: {},
          solanaConfig: {
            rpcUrl: 'http://localhost:8899',
            keypair: seed,
            programId: PROGRAM_ID,
            tokenMint: TOKEN_MINT,
            deposit: { amount: '0', payerTokenAccount: APEX_PUBKEY },
          },
        });
        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        expect(sentTxBytes()).toHaveLength(1); // initialize_channel only
        expect(result.depositTotal).toBeUndefined();
      });

      it('refuses BEFORE spending rent when the token account is short', async () => {
        mockRpc(false, { tokenBalance: '1000' });
        const c = makeClient();
        await expect(
          c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      })
        ).rejects.toThrow(ChannelFundingError);
        // Nothing was submitted — no half-open, rent-paying, 0-collateral channel.
        expect(sentTxBytes()).toHaveLength(0);
      });

      it('refuses when the payer has no token account for the mint at all', async () => {
        mockRpc(false, { tokenBalance: null });
        const c = makeClient();
        await expect(
          c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      })
        ).rejects.toThrow(/does not exist/i);
        expect(sentTxBytes()).toHaveLength(0);
      });

      // A node that does not ANSWER says nothing about the user's balance.
      // Collapsing that into "account does not exist" would accuse a fully
      // funded wallet of being empty every time the RPC hiccups.
      it('does NOT turn a transient RPC failure into a funding error', async () => {
        mockRpc(false, { rpcThrowsFor: ['getTokenAccountBalance'] });
        const c = makeClient();
        const open = c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });
        await expect(open).rejects.toThrow(/fetch failed/);
        await expect(open).rejects.not.toBeInstanceOf(ChannelFundingError);
        expect(sentTxBytes()).toHaveLength(0);
      });

      it('never re-initializes an existing channel, and needs no rent for it', async () => {
        // Own collateral already at target, so nothing to top up — and no rent
        // floor, since both accounts already exist and are already rent-exempt.
        mockRpc(true, { depositA: 100000n, lamports: 5_000 });
        const c = makeClient();
        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });
        expect(result.status).toBe('opening');
        expect(result.depositTotal).toBe(100000n);
        expect(sentTxBytes()).toHaveLength(0);
      });

      // ── an EXISTING 0-collateral channel must not stay that way ─────────────
      //
      // The connector#646 channel is open on devnet with 0 collateral. A fix
      // that only collateralized FRESH opens would leave it — and every client
      // that resumes it — signing unredeemable claims forever.
      it('tops up an already-open channel whose own collateral is 0', async () => {
        const channelPDA = deriveChannelPDA(
          clientPubkey,
          APEX_PUBKEY,
          TOKEN_MINT,
          PROGRAM_ID
        ).pda;
        // The #646 state exactly: channel open, own deposit 0, payer funded.
        mockRpc(true, { depositA: 0n, tokenBalance: '50000000' });
        const c = makeClient();

        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        expect(result.channelId).toBe(channelPDA);
        expect(depositedAmount(100000n)).toBe(true);
        expect(result.depositTotal).toBe(100000n);
      });

      it('deposits only the SHORTFALL on a partially-collateralized channel', async () => {
        mockRpc(true, { depositA: 40000n, tokenBalance: '50000000' });
        const c = makeClient();

        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        expect(depositedAmount(60000n)).toBe(true); // 100000 − 40000
        expect(depositedAmount(100000n)).toBe(false);
        expect(result.depositTotal).toBe(100000n);
      });

      // ── the collateral that counts is the CLAIMER'S OWN ─────────────────────
      //
      // The vault holds deposit_a + deposit_b, but `Claim` bounds a claim by the
      // claimer's own deposit alone (`TransferredAmountExceedsDeposit`). Measuring
      // the vault would no-op here — a peer-funded vault reading at target while
      // this client's own collateral is 0 — reproducing the #646 harm inside the
      // code written to prevent it.
      it('tops up when the PEER funded the vault but our own deposit is 0', async () => {
        const channelPDA = deriveChannelPDA(
          clientPubkey,
          APEX_PUBKEY,
          TOKEN_MINT,
          PROGRAM_ID
        ).pda;
        const vault = deriveVaultPDA(channelPDA, PROGRAM_ID).pda;
        mockRpc(true, {
          depositA: 0n, // ours
          depositB: 5_000_000n, // the apex's
          // The vault token account is amply funded — by the PEER. Reading it
          // would say "nothing to do".
          tokenBalanceFor: (account) =>
            account === vault ? '5000000' : '50000000',
        });
        const c = makeClient();

        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        expect(depositedAmount(100000n)).toBe(true);
        expect(result.depositTotal).toBe(100000n); // ours, not 5_100_000
      });

      it('reads OUR deposit from deposit_b when we are participant B', async () => {
        mockRpc(true, {
          // Roles reversed: the apex initialized, so we are participant B.
          participantA: APEX_PUBKEY,
          participantB: clientPubkey,
          depositA: 5_000_000n, // theirs
          depositB: 40000n, // ours
          tokenBalance: '50000000',
        });
        const c = makeClient();

        const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

        expect(depositedAmount(60000n)).toBe(true); // 100000 − our 40000
        expect(result.depositTotal).toBe(100000n);
      });

      // ── a channel that cannot take a deposit must not be sent one ───────────
      //
      // The program rejects `Deposit` unless the state is `Opened`. Resuming a
      // channel this client has CLOSED is a supported, persisted state (the
      // withdraw flow), so it must come back unchanged — not as an opaque
      // `custom program error` surfacing as a daemon 500.
      it.each(['closed', 'settled'] as const)(
        'returns a %s channel untouched instead of firing a doomed deposit',
        async (channelState) => {
          mockRpc(true, {
            channelState,
            depositA: 0n,
            tokenBalance: '50000000',
          });
          const c = makeClient();

          const result = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      });

          expect(result.status).toBe('opening');
          expect(result.depositTotal).toBeUndefined();
          expect(sentTxBytes()).toHaveLength(0);
        }
      );

      // ── #474(b): native SOL is a SEPARATE requirement from the SPL token ────
      //
      // Rent for the channel + vault accounts and the signature fees are paid
      // in SOL. A wallet full of USDC but empty of SOL used to get as far as
      // submitting the open and fail on-chain, with nothing naming SOL.
      it('refuses when the payer holds the settlement token but no SOL for rent/fees', async () => {
        mockRpc(false, { lamports: 1000 });
        const c = makeClient();
        await expect(
          c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      })
        ).rejects.toThrow(/lamports.*payment channel|SOL/i);
        expect(sentTxBytes()).toHaveLength(0);
      });

      it('checks SOL even for a deposit-less open — the accounts still cost rent', async () => {
        mockRpc(false, { lamports: 0 });
        const c = makeClient();
        await expect(
          c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      })
        ).rejects.toThrow(ChannelFundingError);
        expect(sentTxBytes()).toHaveLength(0);
      });

      it('proceeds once the wallet clears the rent + fee floor', async () => {
        mockRpc(false, { lamports: Number(MIN_LAMPORTS_FOR_CHANNEL_OPEN) });
        const c = makeClient();
        await expect(
          c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
        initialDeposit: BigInt('100000'),
      })
        ).resolves.toMatchObject({ status: 'opening' });
      });
    });

    function depositClient(): OnChainChannelClient {
      return new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
        solanaConfig: {
          rpcUrl: 'http://localhost:8899',
          keypair: seed,
          programId: PROGRAM_ID,
          tokenMint: TOKEN_MINT,
          // amount 0 → open doesn't deposit; payerTokenAccount enables a later deposit.
          deposit: { amount: '0', payerTokenAccount: APEX_PUBKEY },
        },
      });
    }

    it('depositToChannel fires a deposit tx and returns current + delta', async () => {
      mockRpc(false);
      const c = depositClient();
      const { channelId } = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });
      fetchMock.mockClear();

      const out = await c.depositToChannel(channelId, 100n, {
        currentDeposit: 500n,
      });

      expect(out.txHash).toBe('tx-signature-stub');
      expect(out.depositTotal).toBe(600n); // incremental: 500 + 100
      const sent = fetchMock.mock.calls.some(
        (call) =>
          (
            JSON.parse((call[1] as RequestInit).body as string) as {
              method: string;
            }
          ).method === 'sendTransaction'
      );
      expect(sent).toBe(true);
    });

    it('depositToChannel derives the payer ATA from the mint when none is configured', async () => {
      mockRpc(false);
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
        // tokenMint present, but NO deposit.payerTokenAccount — it is derived
        // (the payer's ATA for the mint) rather than required from config.
        solanaConfig: {
          rpcUrl: 'http://localhost:8899',
          keypair: seed,
          programId: PROGRAM_ID,
          tokenMint: TOKEN_MINT,
        },
      });
      const { channelId } = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: TOKEN_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });
      fetchMock.mockClear();
      const out = await c.depositToChannel(channelId, 100n, {
        currentDeposit: 0n,
      });
      expect(out.txHash).toBe('tx-signature-stub');
      const sent = fetchMock.mock.calls.some(
        (call) =>
          (
            JSON.parse((call[1] as RequestInit).body as string) as {
              method: string;
            }
          ).method === 'sendTransaction'
      );
      expect(sent).toBe(true);
    });

    // The mint half of the #473 split: the ATA a deposit spends from must come
    // from the mint the CHANNEL was opened with, not from config. Every other
    // deposit test sets `cfg.tokenMint === params.token`, so only a divergence
    // can tell the two apart.
    it('depositToChannel derives the ATA from the NEGOTIATED mint, not the configured one', async () => {
      const NEGOTIATED_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
      mockRpc(false);
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
        solanaConfig: {
          rpcUrl: 'http://localhost:8899',
          keypair: seed,
          programId: PROGRAM_ID,
          tokenMint: TOKEN_MINT, // config default — the greeting overrides it
        },
      });
      const { channelId } = await c.openChannel({
        terms: {
          kind: 'solana',
          chain: SOLANA_CHAIN,
          token: NEGOTIATED_MINT,
          counterparty: APEX_PUBKEY,
          decimals: 6,
        },
      });
      fetchMock.mockClear();

      await c.depositToChannel(channelId, 100n, { currentDeposit: 0n });

      const txs = fetchMock.mock.calls
        .map(
          (call) =>
            JSON.parse((call[1] as RequestInit).body as string) as {
              method: string;
              params: unknown[];
            }
        )
        .filter((b) => b.method === 'sendTransaction')
        .map((b) => Buffer.from(b.params[0] as string, 'base64'));
      const negotiatedAta = Buffer.from(
        base58Decode(
          deriveAssociatedTokenAccount(clientPubkey, NEGOTIATED_MINT)
        )
      );
      const configAta = Buffer.from(
        base58Decode(deriveAssociatedTokenAccount(clientPubkey, TOKEN_MINT))
      );
      expect(txs.some((tx) => tx.indexOf(negotiatedAta) !== -1)).toBe(true);
      expect(txs.some((tx) => tx.indexOf(configAta) !== -1)).toBe(false);
    });
  });

  describe('dispatching, and the context a channel is dispatched on', () => {
    it('refuses to deposit into, close, settle or read a channel it never saw', async () => {
      const unknown = '0x' + 'ff'.repeat(32);
      await expect(client.depositToChannel(unknown, 1n, { currentDeposit: 0n })).rejects.toThrow(
        /no on-chain context/i
      );
      await expect(client.closeChannel(unknown)).rejects.toThrow(/no on-chain context/i);
      await expect(client.settleChannel(unknown)).rejects.toThrow(/no on-chain context/i);
      await expect(client.getChannelState(unknown)).rejects.toThrow(/no on-chain context/i);
    });

    it('gives a channel this process never opened its context back (#489)', async () => {
      client.adoptChannel(TEST_CHANNEL_ID, {
        chain: TEST_CHAIN,
        tokenNetworkAddress: TEST_TOKEN_NETWORK,
        tokenAddress: TEST_TOKEN,
      });
      expect(client.getChannelContext(TEST_CHANNEL_ID)).toEqual({
        chain: TEST_CHAIN,
        tokenNetworkAddress: TEST_TOKEN_NETWORK,
        tokenAddress: TEST_TOKEN,
      });

      // …and the resumed channel can now be read, which needs the chain and the
      // token network the adopt supplied.
      const state = await client.getChannelState(TEST_CHANNEL_ID);
      expect(state.status).toBe('open');
      expect(state.chain).toBe(TEST_CHAIN);
    });

    it('names the chain, and what IS configured, when no RPC is configured for it', () => {
      expect(() => client.evmClientFor('evm:1')).toThrow(/no rpc url configured for chain "evm:1"/i);
      expect(() => client.evmClientFor('evm:1')).toThrow(new RegExp(TEST_CHAIN));
    });

    it('reuses one TokenNetworkClient per chain rather than rebuilding it per call', () => {
      expect(client.evmClientFor(TEST_CHAIN)).toBe(client.evmClientFor(TEST_CHAIN));
    });

    it('rejects a non-positive deposit before it needs any context at all', async () => {
      await expect(
        client.depositToChannel(TEST_CHANNEL_ID, 0n, { currentDeposit: 0n })
      ).rejects.toThrow(RangeError);
    });
  });
});
