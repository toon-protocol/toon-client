import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@toon-protocol/core';
import { EvmSigner } from '../signing/evm-signer.js';
import { OnChainChannelClient } from './OnChainChannelClient.js';
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
  });
});
