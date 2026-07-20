import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@toon-protocol/core';
import { EvmSigner } from '../signing/evm-signer.js';
import { OnChainChannelClient } from './OnChainChannelClient.js';
import { ChannelFundingError } from '../errors.js';
import { deriveChannelPDA } from './solana-payment-channel.js';

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

// Mock the on-chain Mina opener so the wiring tests don't pull o1js / hit a
// Mina node. The real opener (mina-channel-open.ts) is exercised by the gated
// Mina smoke loop against the live lightnet.
const mockOpenMinaChannelOnChain = vi.fn(
  async (p: { zkAppAddress: string }) => ({
    zkAppAddress: p.zkAppAddress,
    opened: true,
    initTxHash: 'mina-init-tx-hash',
    channelState: 1,
  })
);
vi.mock('./mina-channel-open.js', () => ({
  openMinaChannelOnChain: (...args: unknown[]) =>
    mockOpenMinaChannelOnChain(...(args as [{ zkAppAddress: string }])),
}));

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
  });

  describe('openChannel', () => {
    it('should send approve + openChannel + setTotalDeposit transactions', async () => {
      // Allowance returns 0 (needs approval)
      mockReadContract.mockResolvedValueOnce(0n);
      // Approve tx hash
      mockWriteContract.mockResolvedValueOnce('0xapprovehash');
      // Approve receipt
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      // OpenChannel tx hash
      mockWriteContract.mockResolvedValueOnce('0xopenhash');
      // OpenChannel receipt with ChannelOpened event
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [
          {
            topics: [
              '0xeventhash',
              TEST_CHANNEL_ID,
              '0xparticipant1',
              '0xparticipant2',
            ],
            data: '0x',
          },
        ],
      });
      // Deposit tx hash
      mockWriteContract.mockResolvedValueOnce('0xdeposithash');
      // Deposit receipt
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      const result = await client.openChannel({
        peerId: 'test-peer',
        chain: TEST_CHAIN,
        token: TEST_TOKEN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
        initialDeposit: '100000',
        settlementTimeout: 86400,
      });

      expect(result.channelId).toBe(TEST_CHANNEL_ID);
      expect(result.status).toBe('opening');
      // 3 write calls: approve, openChannel, setTotalDeposit
      expect(mockWriteContract).toHaveBeenCalledTimes(3);
    });

    it('should skip approve when allowance is sufficient', async () => {
      // Allowance is already sufficient
      mockReadContract.mockResolvedValueOnce(BigInt('999999999999'));
      // OpenChannel tx hash
      mockWriteContract.mockResolvedValueOnce('0xopenhash');
      // OpenChannel receipt
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [
          {
            topics: [
              '0xeventhash',
              TEST_CHANNEL_ID,
              '0xparticipant1',
              '0xparticipant2',
            ],
            data: '0x',
          },
        ],
      });
      // Deposit tx hash
      mockWriteContract.mockResolvedValueOnce('0xdeposithash');
      // Deposit receipt
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      await client.openChannel({
        peerId: 'test-peer',
        chain: TEST_CHAIN,
        token: TEST_TOKEN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
        initialDeposit: '100000',
      });

      // Only 2 write calls: openChannel, setTotalDeposit (no approve)
      expect(mockWriteContract).toHaveBeenCalledTimes(2);
    });

    it('should skip deposit when initialDeposit is 0', async () => {
      // OpenChannel tx hash
      mockWriteContract.mockResolvedValueOnce('0xopenhash');
      // OpenChannel receipt
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [
          {
            topics: [
              '0xeventhash',
              TEST_CHANNEL_ID,
              '0xparticipant1',
              '0xparticipant2',
            ],
            data: '0x',
          },
        ],
      });

      const result = await client.openChannel({
        peerId: 'test-peer',
        chain: TEST_CHAIN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
        initialDeposit: '0',
      });

      expect(result.channelId).toBe(TEST_CHANNEL_ID);
      // Only 1 write call: openChannel (no approve, no deposit)
      expect(mockWriteContract).toHaveBeenCalledTimes(1);
    });

    it('should throw when chain not found in chainRpcUrls', async () => {
      await expect(
        client.openChannel({
          peerId: 'test-peer',
          chain: 'evm:mainnet:1',
          tokenNetwork: TEST_TOKEN_NETWORK,
          peerAddress: TEST_PEER_ADDRESS,
        })
      ).rejects.toThrow('No RPC URL configured for chain "evm:mainnet:1"');
    });

    it('should throw when tokenNetwork is missing', async () => {
      await expect(
        client.openChannel({
          peerId: 'test-peer',
          chain: TEST_CHAIN,
          peerAddress: TEST_PEER_ADDRESS,
        })
      ).rejects.toThrow('tokenNetwork address is required');
    });

    it('should throw when ChannelOpened event not found in logs', async () => {
      // Import the mocked decodeEventLog to override for this test only
      const viem = await import('viem');
      const mockedDecode = vi.mocked(viem.decodeEventLog);
      // Make decodeEventLog throw for all logs (simulating no matching events)
      // Use mockImplementationOnce so it doesn't poison subsequent tests
      mockedDecode.mockImplementationOnce(() => {
        throw new Error('Unknown event');
      });

      // OpenChannel tx hash
      mockWriteContract.mockResolvedValueOnce('0xopenhash');
      // OpenChannel receipt with logs that won't decode
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xunknown'], data: '0x' }],
      });

      await expect(
        client.openChannel({
          peerId: 'test-peer',
          chain: TEST_CHAIN,
          tokenNetwork: TEST_TOKEN_NETWORK,
          peerAddress: TEST_PEER_ADDRESS,
        })
      ).rejects.toThrow('Failed to extract channelId');
    });

    it('remaps an insufficient-gas revert into an actionable ChannelFundingError (#65)', async () => {
      // The openChannel tx reverts because the wallet has no native gas — the
      // exact raw viem string reported on devnet.
      const viemErr = new Error(
        'The total cost (gas * gas fee + value) of executing this transaction ' +
          'exceeds the balance of the account.'
      );
      mockWriteContract.mockRejectedValueOnce(viemErr);

      let thrown: unknown;
      try {
        await client.openChannel({
          peerId: 'test-peer',
          chain: TEST_CHAIN,
          tokenNetwork: TEST_TOKEN_NETWORK,
          peerAddress: TEST_PEER_ADDRESS,
          initialDeposit: '0',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ChannelFundingError);
      const funding = thrown as ChannelFundingError;
      // Names the wallet, the chain FAMILY (evm, not the full slug), and remedy.
      expect(funding.message).toContain(signer.address);
      expect(funding.message).toContain('no gas on evm ');
      expect(funding.message).toContain('toon_fund_wallet');
      expect(funding.code).toBe('CHANNEL_FUNDING');
      expect(funding.retryable).toBe(true);
      // Original viem error preserved for debugging.
      expect(funding.cause).toBe(viemErr);
    });

    it('remaps an insufficient-gas revert on the approve leg too (#65)', async () => {
      // Allowance 0 → approve runs first and reverts for lack of gas.
      mockReadContract.mockResolvedValueOnce(0n);
      mockWriteContract.mockRejectedValueOnce(
        new Error('insufficient funds for gas * price + value')
      );

      await expect(
        client.openChannel({
          peerId: 'test-peer',
          chain: TEST_CHAIN,
          token: TEST_TOKEN,
          tokenNetwork: TEST_TOKEN_NETWORK,
          peerAddress: TEST_PEER_ADDRESS,
          initialDeposit: '100000',
        })
      ).rejects.toBeInstanceOf(ChannelFundingError);
    });

    it('does NOT remap unrelated channel-open errors (#65)', async () => {
      mockWriteContract.mockRejectedValueOnce(
        new Error('execution reverted: channel already exists')
      );

      const promise = client.openChannel({
        peerId: 'test-peer',
        chain: TEST_CHAIN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
        initialDeposit: '0',
      });
      await expect(promise).rejects.toThrow('channel already exists');
      await expect(promise).rejects.not.toBeInstanceOf(ChannelFundingError);
    });
  });

  describe('getChannelState', () => {
    it('should throw for untracked channel', async () => {
      await expect(
        client.getChannelState('0x' + 'ff'.repeat(32))
      ).rejects.toThrow('No context for channel');
    });

    it('should map contract state uint8 to status string', async () => {
      // First open a channel to cache context
      mockWriteContract.mockResolvedValueOnce('0xopenhash');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [
          {
            topics: [
              '0xeventhash',
              TEST_CHANNEL_ID,
              '0xparticipant1',
              '0xparticipant2',
            ],
            data: '0x',
          },
        ],
      });

      await client.openChannel({
        peerId: 'test-peer',
        chain: TEST_CHAIN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
      });

      // Now query state — state uint8 = 1 → 'open'
      mockReadContract.mockResolvedValueOnce([
        86400n, // settlementTimeout
        1, // state (open)
        0n, // closedAt
        1000n, // openedAt
        signer.address, // participant1
        TEST_PEER_ADDRESS, // participant2
      ]);

      const state = await client.getChannelState(TEST_CHANNEL_ID);

      expect(state.channelId).toBe(TEST_CHANNEL_ID);
      expect(state.status).toBe('open');
      expect(state.chain).toBe(TEST_CHAIN);
    });
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

    /** Queue an account-exists/absent + tx-confirm RPC sequence. */
    function mockRpc(channelExists: boolean): void {
      fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { method: string };
        let result: unknown;
        switch (body.method) {
          case 'getAccountInfo':
            result = {
              value: channelExists
                ? // 178-byte "pchannel" discriminator account (opened)
                  {
                    data: [
                      Buffer.from([
                        0x70,
                        0x63,
                        0x68,
                        0x61,
                        0x6e,
                        0x6e,
                        0x65,
                        0x6c,
                        ...new Array(170).fill(0),
                      ]).toString('base64'),
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
        peerId: 'apex',
        chain: SOLANA_CHAIN,
        token: TOKEN_MINT,
        peerAddress: APEX_PUBKEY,
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
        peerId: 'apex',
        chain: SOLANA_CHAIN,
        token: TOKEN_MINT,
        peerAddress: APEX_PUBKEY,
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
        peerId: 'apex',
        chain: SOLANA_CHAIN,
        token: TOKEN_MINT,
        peerAddress: APEX_PUBKEY,
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
          peerId: 'apex',
          chain: SOLANA_CHAIN,
          peerAddress: APEX_PUBKEY,
        })
      ).rejects.toThrow(/token mint/i);
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
        peerId: 'apex',
        chain: SOLANA_CHAIN,
        token: TOKEN_MINT,
        peerAddress: APEX_PUBKEY,
      });
      fetchMock.mockClear();

      const out = await c.depositToChannel(channelId, 100n, { currentDeposit: 500n });

      expect(out.txHash).toBe('tx-signature-stub');
      expect(out.depositTotal).toBe(600n); // incremental: 500 + 100
      const sent = fetchMock.mock.calls.some(
        (call) =>
          (JSON.parse((call[1] as RequestInit).body as string) as { method: string }).method ===
          'sendTransaction'
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
        solanaConfig: { rpcUrl: 'http://localhost:8899', keypair: seed, programId: PROGRAM_ID, tokenMint: TOKEN_MINT },
      });
      const { channelId } = await c.openChannel({
        peerId: 'apex',
        chain: SOLANA_CHAIN,
        token: TOKEN_MINT,
        peerAddress: APEX_PUBKEY,
      });
      fetchMock.mockClear();
      const out = await c.depositToChannel(channelId, 100n, { currentDeposit: 0n });
      expect(out.txHash).toBe('tx-signature-stub');
      const sent = fetchMock.mock.calls.some(
        (call) =>
          (JSON.parse((call[1] as RequestInit).body as string) as { method: string }).method ===
          'sendTransaction'
      );
      expect(sent).toBe(true);
    });
  });

  // ── Mina channel (Phase-2 Stage 3 + on-chain open) ──────────────────────────
  //
  // openMinaChannel now performs a REAL on-chain channel open (initialize +
  // optional deposit) on the deployed PaymentChannel zkApp — the Mina analog of
  // openSolanaChannel (connector#105). The heavyweight o1js opener
  // (mina-channel-open.ts) is mocked here (its live behaviour is exercised by
  // the gated Mina smoke loop against the lightnet); these tests assert the
  // wiring: setMinaConfig late-binds config and a mina:* open invokes the opener
  // with the right params, with the zkApp address as the channel id.
  describe('Mina channel (on-chain open via openMinaChannelOnChain)', () => {
    const MINA_CHAIN = 'mina:devnet';
    // A syntactically valid B62 base58 Mina address (55 chars).
    const ZKAPP_ADDRESS =
      'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im7T5sa';
    const APEX_MINA = 'B62qksocUTe3wxR3uHB9oV7yWZi6JdkWLwNDvVoUkbXkmTGwHo3rDNc';
    const MINA_PK = '0x' + '11'.repeat(32);

    it('throws when mina config is not provided (no setMinaConfig)', async () => {
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
      });
      await expect(
        c.openChannel({
          peerId: 'apex',
          chain: MINA_CHAIN,
          peerAddress: APEX_MINA,
        })
      ).rejects.toThrow(/Mina channel config not provided/i);
    });

    it('setMinaConfig late-binds config; a mina:* open invokes openMinaChannelOnChain with the deployed zkApp + apex peer', async () => {
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
      });
      c.setMinaConfig({
        graphqlUrl: 'http://localhost:28085/graphql',
        zkAppAddress: ZKAPP_ADDRESS,
        privateKey: MINA_PK,
      });

      const result = await c.openChannel({
        peerId: 'apex',
        chain: MINA_CHAIN,
        peerAddress: APEX_MINA,
        settlementTimeout: 123,
      });

      // The opener was invoked with the deployed zkApp, the client's Mina key,
      // and the apex's Mina B62 as participantB.
      expect(mockOpenMinaChannelOnChain).toHaveBeenCalledTimes(1);
      const callArg = mockOpenMinaChannelOnChain.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(callArg.graphqlUrl).toBe('http://localhost:28085/graphql');
      expect(callArg.zkAppAddress).toBe(ZKAPP_ADDRESS);
      expect(callArg.payerPrivateKey).toBe(MINA_PK);
      expect(callArg.peerPublicKey).toBe(APEX_MINA);
      // settlementTimeout (123) flows through as the channel timeout (bigint).
      expect(callArg.timeout).toBe(123n);

      // The deployed zkApp address IS the channel id (claim `zkAppAddress`).
      expect(result.channelId).toBe(ZKAPP_ADDRESS);
      expect(result.status).toBe('opening');
    });

    it('passes challengeDuration/tokenId/deposit/networkId from minaConfig to the opener', async () => {
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
      });
      c.setMinaConfig({
        graphqlUrl: 'http://localhost:28085/graphql',
        zkAppAddress: ZKAPP_ADDRESS,
        privateKey: MINA_PK,
        challengeDuration: 99999,
        tokenId: '1',
        deposit: { amount: '5000000' },
        networkId: 'devnet',
      });

      await c.openChannel({
        peerId: 'apex',
        chain: MINA_CHAIN,
        peerAddress: APEX_MINA,
        settlementTimeout: 123, // overridden by challengeDuration below
      });

      const callArg = mockOpenMinaChannelOnChain.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      // challengeDuration takes precedence over settlementTimeout.
      expect(callArg.timeout).toBe(99999n);
      expect(callArg.tokenId).toBe('1');
      expect(callArg.networkId).toBe('devnet');
      expect(callArg.deposit).toEqual({ amount: 5000000n });
    });

    it('throws for a missing zkAppAddress', async () => {
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
      });
      c.setMinaConfig({
        graphqlUrl: 'http://localhost:28085/graphql',
        zkAppAddress: '',
        privateKey: MINA_PK,
      });
      await expect(
        c.openChannel({
          peerId: 'apex',
          chain: MINA_CHAIN,
          peerAddress: APEX_MINA,
        })
      ).rejects.toThrow(/deployed zkAppAddress/i);
    });

    it('throws when peerAddress (apex Mina B62) is missing — refuses single-party open', async () => {
      // Root cause of the on-chain-settle failure: a single-party open records
      // empty participants while the claim is signed in participant form. The
      // dispatch layer must refuse it (parity with the Solana peerAddress guard).
      const c = new OnChainChannelClient({
        evmSigner: signer,
        chainRpcUrls: {},
      });
      c.setMinaConfig({
        graphqlUrl: 'http://localhost:28085/graphql',
        zkAppAddress: ZKAPP_ADDRESS,
        privateKey: MINA_PK,
      });
      await expect(
        c.openChannel({
          peerId: 'apex',
          chain: MINA_CHAIN,
          // peerAddress deliberately omitted
        })
      ).rejects.toThrow(/peerAddress/i);
      expect(mockOpenMinaChannelOnChain).not.toHaveBeenCalled();
    });
  });

  describe('depositToChannel (EVM)', () => {
    // Open an EVM channel first so channelContext (chain + tokenNetwork + token)
    // is populated for the standalone deposit.
    async function openEvmChannel(): Promise<string> {
      mockReadContract.mockResolvedValueOnce(0n); // allowance → approve
      mockWriteContract.mockResolvedValueOnce('0xapprove');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      mockWriteContract.mockResolvedValueOnce('0xopen');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', TEST_CHANNEL_ID, '0xp1', '0xp2'], data: '0x' }],
      });
      mockWriteContract.mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      const res = await client.openChannel({
        peerId: 'p',
        chain: TEST_CHAIN,
        token: TEST_TOKEN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
        initialDeposit: '100000',
        settlementTimeout: 86400,
      });
      vi.clearAllMocks();
      return res.channelId!;
    }

    it('submits setTotalDeposit with current + delta (cumulative)', async () => {
      const channelId = await openEvmChannel();
      mockReadContract.mockResolvedValueOnce(10n ** 30n); // allowance ample → no approve
      mockWriteContract.mockResolvedValueOnce('0xdep');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      const out = await client.depositToChannel(channelId, 50_000n, { currentDeposit: 100_000n });

      expect(out.depositTotal).toBe(150_000n);
      // Only the setTotalDeposit write (allowance was sufficient → no approve).
      expect(mockWriteContract).toHaveBeenCalledTimes(1);
      const call = mockWriteContract.mock.calls[0]![0] as {
        functionName: string;
        args: unknown[];
      };
      expect(call.functionName).toBe('setTotalDeposit');
      expect(call.args[2]).toBe(150_000n); // current 100k + delta 50k
    });

    it('approves the token-network when allowance is short', async () => {
      const channelId = await openEvmChannel();
      mockReadContract.mockResolvedValueOnce(0n); // allowance short → approve
      mockWriteContract.mockResolvedValueOnce('0xapprove');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      mockWriteContract.mockResolvedValueOnce('0xdep');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      await client.depositToChannel(channelId, 50_000n, { currentDeposit: 0n });

      // approve + setTotalDeposit
      expect(mockWriteContract).toHaveBeenCalledTimes(2);
      expect((mockWriteContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('approve');
      expect((mockWriteContract.mock.calls[1]![0] as { functionName: string }).functionName).toBe('setTotalDeposit');
    });

    it('rejects a non-positive amount', async () => {
      const channelId = await openEvmChannel();
      await expect(client.depositToChannel(channelId, 0n, { currentDeposit: 0n })).rejects.toThrow(/positive/i);
    });

    it('rejects an unknown channel (no on-chain context)', async () => {
      await expect(
        client.depositToChannel('0xunknown', 1n, { currentDeposit: 0n })
      ).rejects.toThrow(/context/i);
    });
  });

  describe('closeChannel / settleChannel (EVM)', () => {
    // Open an EVM channel so channelContext is populated, then clear the mocks.
    async function openEvmChannel(): Promise<string> {
      mockReadContract.mockResolvedValueOnce(0n);
      mockWriteContract.mockResolvedValueOnce('0xapprove');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      mockWriteContract.mockResolvedValueOnce('0xopen');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        logs: [{ topics: ['0xev', TEST_CHANNEL_ID, '0xp1', '0xp2'], data: '0x' }],
      });
      mockWriteContract.mockResolvedValueOnce('0xdeposit');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      const res = await client.openChannel({
        peerId: 'p',
        chain: TEST_CHAIN,
        token: TEST_TOKEN,
        tokenNetwork: TEST_TOKEN_NETWORK,
        peerAddress: TEST_PEER_ADDRESS,
        initialDeposit: '100000',
        settlementTimeout: 86400,
      });
      vi.clearAllMocks();
      return res.channelId!;
    }

    it('close writes closeChannel and computes settleableAt from the channels() view', async () => {
      const channelId = await openEvmChannel();
      mockWriteContract.mockResolvedValueOnce('0xclose');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});
      // channels() view: [settlementTimeout=100, state=2 (closed), closedAt=1000, ...]
      mockReadContract.mockResolvedValueOnce([100n, 2, 1000n, 900n, '0xa', '0xb']);

      const out = await client.closeChannel(channelId);

      expect((mockWriteContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('closeChannel');
      expect(out.closedAt).toBe(1000n);
      expect(out.settlementTimeout).toBe(100n);
      expect(out.settleableAt).toBe(1100n); // closedAt + settlementTimeout
    });

    it('settle writes settleChannel', async () => {
      const channelId = await openEvmChannel();
      mockWriteContract.mockResolvedValueOnce('0xsettle');
      mockWaitForTransactionReceipt.mockResolvedValueOnce({});

      const out = await client.settleChannel(channelId);

      expect(out.txHash).toBe('0xsettle');
      expect((mockWriteContract.mock.calls[0]![0] as { functionName: string }).functionName).toBe('settleChannel');
    });

    it('close/settle throw for an unknown channel', async () => {
      await expect(client.closeChannel('0xunknown')).rejects.toThrow(/context/i);
      await expect(client.settleChannel('0xunknown')).rejects.toThrow(/context/i);
    });
  });
});
