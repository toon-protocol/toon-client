/**
 * Chain reads and transfers that have nothing to do with paying a connector.
 *
 * A payment channel is collateralised from an ordinary wallet, so a client that
 * could pay a connector but could not tell you what it holds, or move funds to
 * the address that needs them, is missing the half of the job the user does. None
 * of this touches the client edge: no connector is asked, nothing is sealed, and
 * no claim is signed.
 *
 * The settlement facts each read needs — which token, at what address, on which
 * chain — come from the connector's own `GET /ilp` rather than from a preset,
 * for the same reason everything else does: the node proved them against a live
 * chain at boot (`self-description-spec.md` ND-07), and a preset that disagreed
 * would report a balance in the wrong token without saying so.
 *
 * It reaches each chain through that chain's settlement network, the same one
 * the client pays on, and builds no chain client of its own (toon-client#777).
 */
import { readWalletBalances, type WalletChainBalances } from '../wallet/balances.js';
import { sendTransfer, type SendTransferParams, type SendTransferResult } from '../wallet/transfer.js';
import { fundWallet, type FundWalletResult } from '../wallet/faucet.js';
import type { ChainKind, WalletFacade } from './types.js';
import type { NodeSelfDescription } from '../connector/self-description.js';
import { ChainUnavailableError, chainUnavailableMessage } from './errors.js';
import type { ResolvedConfig } from './config.js';
import type { SettlementNetwork } from '../channel/batch-settlement/settlement-network.js';
import {
  EvmSettlementNetwork,
  type EvmRpc,
} from '../channel/batch-settlement/evm-network.js';
import { SolanaSettlementNetwork } from '../channel/batch-settlement/solana-network.js';
import type { SolanaRpcClient } from '../channel/solana/json-rpc.js';

export interface WalletFacadeDeps {
  config: ResolvedConfig;
  /** The node's `GET /ilp`, cached — the source of every token address read here. */
  describe: () => Promise<NodeSelfDescription>;
  /** The settlement networks the client pays on: each chain is reached through its own. */
  networks: readonly SettlementNetwork[];
}

/** One chain's settlement token, as the node's x402 terms name it. */
interface SettlementToken {
  kind: ChainKind;
  chain: string;
  tokenAddress: string;
}

export class ClientWalletFacade implements WalletFacade {
  private readonly deps: WalletFacadeDeps;

  constructor(deps: WalletFacadeDeps) {
    this.deps = deps;
  }

  /**
   * Native coin plus the connector's settlement token, per chain.
   *
   * Best effort per chain and per asset: a chain whose RPC is unreachable comes
   * back `unreadable` rather than failing the others, because a user with a
   * flaky Solana endpoint should still be told their EVM balance. `chain` narrows
   * the read to one.
   */
  async balances(chain?: ChainKind): Promise<WalletChainBalances[]> {
    const { config } = this.deps;
    const settlements = await this.settlements();

    const wanted: ChainKind[] = chain !== undefined ? [chain] : ['evm', 'solana'];
    const sources: Parameters<typeof readWalletBalances>[0] = {};
    const evmRpc = this.evmRpc();
    const solanaRpc = this.solanaRpc();

    for (const kind of wanted) {
      const entry = settlements.get(kind);
      if (kind === 'evm' && config.identity.evm && evmRpc) {
        sources.evm = {
          chainKey: entry?.chain ?? 'evm',
          owner: config.identity.evm.address,
          rpc: evmRpc,
          ...(entry?.tokenAddress ? { tokenAddress: entry.tokenAddress } : {}),
        };
      }
      if (kind === 'solana' && config.identity.solana && solanaRpc) {
        sources.solana = {
          ...(entry?.chain ? { chainKey: entry.chain } : {}),
          owner: config.identity.solana.publicKey,
          rpc: solanaRpc,
          ...(entry?.tokenAddress ? { tokenMint: entry.tokenAddress } : {}),
        };
      }
    }

    if (sources.evm === undefined && sources.solana === undefined) {
      throw new ChainUnavailableError(
        chainUnavailableMessage(chain, [...settlements.keys()], 'no-key'),
        [...settlements.keys()]
      );
    }
    return readWalletBalances(sources);
  }

  /**
   * Move funds to another address.
   *
   * Delivery is CONFIRMED, not assumed: the destination's balance is polled until
   * it rises by the sent amount, because a landed transaction is not the same
   * fact as a delivered one — the devnet faucet's Solana leg has been observed
   * returning a real signature while delivering nothing
   * (toon-protocol/connector#691).
   */
  async transfer(params: SendTransferParams): Promise<SendTransferResult> {
    const { config } = this.deps;
    const settlements = await this.settlements();
    const entry = settlements.get(params.chain);
    const evmRpc = this.evmRpc();
    const solanaRpc = this.solanaRpc();

    return sendTransfer(
      {
        ...(evmRpc
          ? {
              evm: {
                chainKey: entry?.kind === 'evm' ? entry.chain : 'evm',
                rpc: evmRpc,
                ...(entry?.tokenAddress ? { tokenAddress: entry.tokenAddress } : {}),
              },
            }
          : {}),
        ...(config.identity.solana && solanaRpc
          ? {
              solana: {
                rpc: solanaRpc,
                keypair: config.identity.solana.secretKey,
                ...(entry?.tokenAddress ? { tokenMint: entry.tokenAddress } : {}),
              },
            }
          : {}),
      },
      params
    );
  }

  /**
   * Ask the devnet faucet for test funds. **Devnet only** — there is no mainnet
   * equivalent and there never will be.
   *
   * Defaults to the chain the client settles on, so `faucet()` funds the wallet
   * that is about to open a channel rather than an unrelated one.
   */
  async faucet(chain?: ChainKind): Promise<FundWalletResult> {
    const { config } = this.deps;
    const target = chain ?? (await this.defaultChain());
    const address =
      target === 'evm' ? config.identity.evm?.address : config.identity.solana?.publicKey;
    if (address === undefined) {
      throw new ChainUnavailableError(
        `This client holds no ${target} key, so there is no address to fund.`,
        []
      );
    }
    return fundWallet(config.faucetUrl, address, target, { fetchImpl: config.fetch });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * The node's settlement token per chain family, from its x402 terms: the
   * chain key (`evm:<chainId>` / `solana`, the spelling the balance and
   * transfer code key an RPC by) and the token address or mint.
   */
  private async settlements(): Promise<Map<ChainKind, SettlementToken>> {
    const description = await this.deps.describe();
    const byKind = new Map<ChainKind, SettlementToken>();
    for (const terms of description.batchSettlements) {
      if (byKind.has(terms.chain)) continue;
      byKind.set(terms.chain, {
        kind: terms.chain,
        chain:
          terms.chain === 'evm' ? `evm:${terms.network.slice('eip155:'.length)}` : 'solana',
        tokenAddress: terms.asset,
      });
    }
    return byKind;
  }

  /** The chain this client would settle on, for a `faucet()` with no argument. */
  private async defaultChain(): Promise<ChainKind> {
    const { config } = this.deps;
    if (config.chain !== undefined) return config.chain;
    const settlements = await this.settlements();
    for (const kind of settlements.keys()) {
      if (config.identity[kind] !== undefined) return kind;
    }
    if (config.identity.evm) return 'evm';
    if (config.identity.solana) return 'solana';
    throw new ChainUnavailableError(
      chainUnavailableMessage(undefined, [...settlements.keys()], 'no-key'),
      [...settlements.keys()]
    );
  }

  /** The EVM settlement network's RPC, when this client pays on EVM. */
  private evmRpc(): EvmRpc | undefined {
    return this.deps.networks.find((n) => n instanceof EvmSettlementNetwork)?.rpc;
  }

  /** The Solana settlement network's RPC, when this client pays on Solana. */
  private solanaRpc(): SolanaRpcClient | undefined {
    const network = this.deps.networks.find((n) => n instanceof SolanaSettlementNetwork);
    return network?.rpc;
  }
}
