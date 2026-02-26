import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  decodeEventLog,
  defineChain,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { ConnectorChannelClient, OpenChannelParams, OpenChannelResult, ChannelState } from '@crosstown/core';
import type { EvmSigner } from '../signing/evm-signer.js';

// TokenNetwork ABI — only the functions we need
const TOKEN_NETWORK_ABI = [
  {
    name: 'openChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'participant2', type: 'address' },
      { name: 'settlementTimeout', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'setTotalDeposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'participant', type: 'address' },
      { name: 'totalDeposit', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'channels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'settlementTimeout', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'closedAt', type: 'uint256' },
      { name: 'openedAt', type: 'uint256' },
      { name: 'participant1', type: 'address' },
      { name: 'participant2', type: 'address' },
    ],
  },
  {
    name: 'ChannelOpened',
    type: 'event',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'participant1', type: 'address', indexed: true },
      { name: 'participant2', type: 'address', indexed: true },
      { name: 'settlementTimeout', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ERC20 ABI — only approve and allowance
const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Maps on-chain state uint8 to ChannelState status */
const STATE_MAP: Record<number, ChannelState['status']> = {
  0: 'settled',
  1: 'open',
  2: 'closed',
  3: 'settled',
};

export interface OnChainChannelClientConfig {
  evmSigner: EvmSigner;
  chainRpcUrls: Record<string, string>;
}

/**
 * Implements ConnectorChannelClient using viem for direct on-chain
 * interaction with TokenNetwork smart contract.
 *
 * Fully non-custodial — the client deposits its own funds on-chain.
 */
export class OnChainChannelClient implements ConnectorChannelClient {
  private readonly evmSigner: EvmSigner;
  private readonly chainRpcUrls: Record<string, string>;
  private readonly channelContext = new Map<string, { chain: string; tokenNetworkAddress: string }>();

  constructor(config: OnChainChannelClientConfig) {
    this.evmSigner = config.evmSigner;
    this.chainRpcUrls = config.chainRpcUrls;
  }

  /**
   * Parse chain identifier to extract chainId.
   * Format: "evm:{network}:{chainId}" e.g., "evm:anvil:31337"
   */
  private parseChainId(chain: string): number {
    const parts = chain.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid chain format: "${chain}". Expected "evm:{network}:{chainId}".`);
    }
    const chainId = parseInt(parts[2]!, 10);
    if (isNaN(chainId)) {
      throw new Error(`Invalid chainId in chain "${chain}".`);
    }
    return chainId;
  }

  /**
   * Create viem clients for a given chain.
   */
  private createClients(chain: string) {
    const rpcUrl = this.chainRpcUrls[chain];
    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for chain "${chain}". Available: ${Object.keys(this.chainRpcUrls).join(', ')}`);
    }

    const chainId = this.parseChainId(chain);

    const viemChain = defineChain({
      id: chainId,
      name: chain,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });

    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: viemChain,
    });

    const walletClient = createWalletClient({
      account: this.evmSigner.account,
      transport: http(rpcUrl),
      chain: viemChain,
    });

    return { publicClient, walletClient };
  }

  /**
   * Opens a new payment channel on-chain.
   *
   * 1. Approve token spend if needed
   * 2. Call TokenNetwork.openChannel()
   * 3. Extract channelId from ChannelOpened event
   * 4. Deposit initial funds if specified
   */
  async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
    const { chain, tokenNetwork, peerAddress, initialDeposit, settlementTimeout } = params;

    if (!tokenNetwork) {
      throw new Error('tokenNetwork address is required for on-chain channel opening');
    }

    const { publicClient, walletClient } = this.createClients(chain);
    const tokenNetworkAddr = tokenNetwork as Hex;
    const deposit = initialDeposit ? BigInt(initialDeposit) : 0n;

    // If deposit > 0, ensure token approval
    if (deposit > 0n && params.token) {
      const tokenAddr = params.token as Hex;
      const myAddress = this.evmSigner.address as Hex;

      const currentAllowance = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [myAddress, tokenNetworkAddr],
      });

      if ((currentAllowance as bigint) < deposit) {
        const approveHash = await walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [tokenNetworkAddr, maxUint256],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    // Open channel
    const timeout = BigInt(settlementTimeout ?? 86400);
    const openHash = await walletClient.writeContract({
      address: tokenNetworkAddr,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'openChannel',
      args: [peerAddress as Hex, timeout],
    });

    const receipt: TransactionReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });

    // Extract channelId from ChannelOpened event
    let channelId: string | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: TOKEN_NETWORK_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'ChannelOpened') {
          channelId = (decoded.args as any).channelId;
          break;
        }
      } catch {
        // Not our event, skip
      }
    }

    if (!channelId) {
      throw new Error('Failed to extract channelId from ChannelOpened event');
    }

    // Cache context for getChannelState
    this.channelContext.set(channelId, { chain, tokenNetworkAddress: tokenNetwork });

    // Deposit initial funds if specified
    if (deposit > 0n) {
      const depositHash = await walletClient.writeContract({
        address: tokenNetworkAddr,
        abi: TOKEN_NETWORK_ABI,
        functionName: 'setTotalDeposit',
        args: [channelId as Hex, this.evmSigner.address as Hex, deposit],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
    }

    return { channelId, status: 'opening' };
  }

  /**
   * Gets the current state of a payment channel from on-chain data.
   */
  async getChannelState(channelId: string): Promise<ChannelState> {
    const context = this.channelContext.get(channelId);
    if (!context) {
      throw new Error(`No context for channel "${channelId}". Channel must be opened via this client first.`);
    }

    const { publicClient } = this.createClients(context.chain);

    const result = await publicClient.readContract({
      address: context.tokenNetworkAddress as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'channels',
      args: [channelId as Hex],
    });

    const [, state] = result as [bigint, number, bigint, bigint, string, string];
    const status = STATE_MAP[state] ?? 'settled';

    return {
      channelId,
      status,
      chain: context.chain,
    };
  }
}
