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
 */
import { readWalletBalances, type WalletChainBalances } from '../wallet/balances.js';
import { sendTransfer, type SendTransferParams, type SendTransferResult } from '../wallet/transfer.js';
import { fundWallet, type FundWalletResult } from '../wallet/faucet.js';
import type { ChainKind, WalletFacade } from './types.js';
import type { NodeSelfDescription } from '../connector/self-description.js';
import type { ConnectorChainSettlementTerms } from '../connector/ConnectorEdgeClient.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChainUnavailableError, ConfigError, chainUnavailableMessage } from './errors.js';
import type { ResolvedConfig } from './config.js';

export interface WalletFacadeDeps {
  config: ResolvedConfig;
  /** The node's `GET /ilp`, cached — the source of every token address read here. */
  describe: () => Promise<NodeSelfDescription>;
}

export class ClientWalletFacade implements WalletFacade {
  private readonly deps: WalletFacadeDeps;
  private evmSigner: EvmSigner | undefined;

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
    const sources: Parameters<typeof readWalletBalances>[0] = { fetchImpl: config.fetch };

    for (const kind of wanted) {
      const entry = settlements.get(kind);
      if (kind === 'evm' && config.identity.evm) {
        sources.evm = {
          chainKey: entry?.chain ?? 'evm',
          rpcUrl: config.rpcUrls.evm,
          owner: config.identity.evm.address,
          ...(entry?.tokenAddress ? { tokenAddress: entry.tokenAddress } : {}),
        };
      }
      if (kind === 'solana' && config.identity.solana) {
        sources.solana = {
          ...(entry?.chain ? { chainKey: entry.chain } : {}),
          rpcUrl: config.rpcUrls.solana,
          owner: config.identity.solana.publicKey,
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

    return sendTransfer(
      {
        ...(config.identity.evm
          ? {
              evm: {
                chainKey: entry?.kind === 'evm' ? entry.chain : 'evm',
                rpcUrl: config.rpcUrls.evm,
                signer: this.signer(),
                ...(entry?.tokenAddress ? { tokenAddress: entry.tokenAddress } : {}),
              },
            }
          : {}),
        ...(config.identity.solana
          ? {
              solana: {
                rpcUrl: config.rpcUrls.solana,
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

  /** The node's settlements, keyed by chain family. */
  private async settlements(): Promise<Map<ChainKind, ConnectorChainSettlementTerms>> {
    const description = await this.deps.describe();
    const byKind = new Map<ChainKind, ConnectorChainSettlementTerms>();
    for (const entry of description.settlements) {
      if (!byKind.has(entry.kind)) byKind.set(entry.kind, entry);
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

  /** The EVM transaction signer, built once and only when a transfer needs one. */
  private signer(): EvmSigner {
    if (this.evmSigner) return this.evmSigner;
    const key = this.deps.config.identity.evm?.privateKey;
    if (key === undefined) {
      throw new ConfigError('This client holds no EVM key, so it cannot sign an EVM transaction.');
    }
    this.evmSigner = new EvmSigner(key);
    return this.evmSigner;
  }
}
