/**
 * The EVM settlement network: x402's `batch-settlement` contract on an
 * `eip155:` network (connector ADR 0074; toon-client#689, #695).
 *
 * It opens a channel by depositing into it through an x402 facilitator — or
 * from the payer's own ETH, as `depositGas` and what is available decide —
 * covers a charge by depositing more into the same channel (ADR 0003), and
 * reads the escrow back from the contract.
 *
 * Its voucher scheme is EIP-712: a voucher signed by the channel's
 * `payerAuthorizer` over the channel id and the cumulative amount, carried as
 * {@link evmVoucherClaim}, and the claim-state challenge {@link signEvmChallenge}.
 */

import { createPublicClient, type Hex, type LocalAccount } from 'viem';
import {
  ConfigError,
  FacilitatorError,
  InsufficientBalanceError,
  NetworkError,
} from '../../client/errors.js';
import { defaultFacilitatorFor } from '../../presets.js';
import { rpcTransport, type ChainRpcRoute } from '../../transport/rpc.js';
import {
  batchChannelId,
  buildBatchChannelConfig,
  buildEip3009Deposit,
  buildPermit2Deposit,
  evmChainIdOf,
  readEvmBatchChannel,
  signBatchVoucher,
  type BatchSettlementEvmOffer,
  type ContractReader,
  type TypedDataSigner,
} from './evm.js';
import { settleDeposit } from './facilitator.js';
import {
  ERC20_APPROVAL_GAS_SPONSORING,
  EIP2612_GAS_SPONSORING,
  approvePermit2,
  depositDirectly,
  eip2612Nonce,
  evmWalletAccess,
  facilitatorExtensions,
  permit2Allowance,
  signEip2612GasSponsoring,
  signErc20ApprovalGasSponsoring,
  type DepositExtensions,
  type EvmWalletAccess,
} from './deposit-gas.js';
import { evmVoucherClaim } from './claim.js';
import { signEvmChallenge } from './challenge.js';
import { offerFromTerms, type BatchSettlementTerms } from './offers.js';
import type { BatchChannel } from './manager.js';
import type {
  Cover,
  OpenAmounts,
  PlannedOpen,
  SettlementNetwork,
  TopUpAmounts,
} from './settlement-network.js';

type EvmChannel = Extract<BatchChannel, { chain: 'evm' }>;

export interface EvmSettlementNetworkConfig {
  /** The funding wallet; also signs vouchers unless `voucherSigner` is set. */
  account: TypedDataSigner;
  /** Signs vouchers as the channel's `payerAuthorizer`. */
  voucherSigner?: TypedDataSigner;
  /**
   * The x402 facilitator that relays deposits and pays their gas. Defaults
   * to the devnet's own on Base Sepolia (`defaultFacilitatorFor`).
   */
  facilitatorUrl?: string;
  /**
   * How a deposit moves the token: `eip3009` for a token with ERC-3009,
   * `permit2` for any other ERC-20. Defaults to what the connector's offer
   * names (`assetTransferMethod`), and to `eip3009` when it names nothing.
   */
  depositMethod?: 'eip3009' | 'permit2';
  /**
   * Who pays a deposit's gas, and a Permit2 token's one-time approval's:
   *
   *   - `auto` (the default): the facilitator, when there is one and it will;
   *     otherwise the payer, when it holds ETH;
   *   - `facilitator`: only ever the facilitator — the payer's ETH is never
   *     spent;
   *   - `self`: always the payer, and no facilitator is contacted at all.
   */
  depositGas?: 'auto' | 'facilitator' | 'self';
  /**
   * The payer's own chain access: what a self-paid deposit or approval, and
   * an approval the facilitator sponsors, are signed and sent with. Without
   * it the payer can only use a facilitator, and only for tokens it needs no
   * approval for.
   */
  wallet?: EvmWalletAccess;
  /**
   * Reads the escrow back, to settle a deposit whose answer was lost and to
   * rebuild a lost watermark. Without one, either of those is an error
   * rather than a guess.
   */
  reader?: ContractReader;
  /** How the facilitator is reached. */
  fetch: typeof fetch;
}

export class EvmSettlementNetwork implements SettlementNetwork {
  readonly chain = 'evm' as const;
  readonly cover: Cover = {
    kind: 'top-up',
    deposit: (channel, terms, amounts) => this.topUp(channel, terms, amounts),
  };

  constructor(private readonly config: EvmSettlementNetworkConfig) {}

  serves(network: string): boolean {
    return network.startsWith('eip155:');
  }

  /**
   * A channel opened by depositing into it through the facilitator. The
   * deposit's own voucher is the first packet's charge, so the first packet can
   * carry the very same voucher (ADR 0074 prerequisite 1).
   */
  async open(
    terms: BatchSettlementTerms,
    amounts: OpenAmounts
  ): Promise<PlannedOpen> {
    const offer = this.offer(terms, amounts.charge);
    const evm = this.config;
    const config = buildBatchChannelConfig({
      payer: evm.account.address,
      payerAuthorizer: this.voucherSigner.address,
      offer,
    });
    const channel: EvmChannel = {
      chain: 'evm',
      channelId: batchChannelId(config, evmChainIdOf(offer.network)),
      network: offer.network,
      config,
    };
    const deposit =
      amounts.deposit > amounts.charge ? amounts.deposit : amounts.charge;
    return {
      channel,
      deposit,
      land: () => this.settle(offer, channel, deposit, amounts.charge),
    };
  }

  async read(
    channel: BatchChannel
  ): Promise<{ escrow: bigint | undefined; landed: bigint }> {
    const reader = this.config.reader;
    if (!reader) {
      throw new ConfigError(
        `channel ${channel.channelId} needs reading back from the chain, and this payer has no EVM reader`
      );
    }
    const state = await readEvmBatchChannel(reader, channel.channelId as Hex);
    return {
      escrow:
        state.balance > 0n || state.totalClaimed > 0n
          ? state.balance
          : undefined,
      landed: state.totalClaimed,
    };
  }

  async voucher(
    channel: BatchChannel,
    cumulative: bigint
  ): Promise<Record<string, unknown>> {
    const evm = this.evmChannel(channel);
    const voucher = await signBatchVoucher(
      this.voucherSigner,
      evmChainIdOf(evm.network),
      evm.channelId as Hex,
      cumulative
    );
    return evmVoucherClaim(voucher, evm.config);
  }

  async challenge(
    channel: BatchChannel,
    expires: bigint
  ): Promise<Record<string, unknown>> {
    const evm = this.evmChannel(channel);
    return signEvmChallenge(
      this.voucherSigner,
      evmChainIdOf(evm.network),
      evm.config,
      evm.channelId as Hex,
      expires
    );
  }

  /** Deposit `amount` more into `channel`, carrying the running cumulative. */
  private async topUp(
    channel: BatchChannel,
    terms: BatchSettlementTerms,
    amounts: TopUpAmounts
  ): Promise<void> {
    await this.settle(
      this.offer(terms, amounts.charge),
      this.evmChannel(channel),
      amounts.amount,
      amounts.voucherAmount
    );
  }

  private get voucherSigner(): TypedDataSigner {
    return this.config.voucherSigner ?? this.config.account;
  }

  /** The connector's terms, priced for a charge, as the offer the greeting would carry. */
  private offer(
    terms: BatchSettlementTerms,
    charge: bigint
  ): BatchSettlementEvmOffer {
    const priced = offerFromTerms(terms, charge);
    if (priced.chain !== 'evm') {
      throw new ConfigError(
        `the EVM settlement network cannot pay on ${terms.network}`
      );
    }
    return priced.offer;
  }

  private evmChannel(channel: BatchChannel): EvmChannel {
    if (channel.chain !== 'evm') {
      throw new ConfigError(
        `channel ${channel.channelId} is on ${channel.network}, not an EVM network`
      );
    }
    return channel;
  }

  /**
   * Put a deposit of `amount`, carrying the voucher for `voucherAmount`, on
   * chain — through the facilitator, or from the payer's own ETH, as
   * `depositGas` and what is available decide (toon-client#695).
   */
  private async settle(
    offer: BatchSettlementEvmOffer,
    channel: EvmChannel,
    amount: bigint,
    voucherAmount: bigint
  ): Promise<void> {
    const evm = this.config;
    const mode = evm.depositGas ?? 'auto';
    const method =
      evm.depositMethod ?? offer.extra.assetTransferMethod ?? 'eip3009';
    // An empty `facilitatorUrl` is the caller saying "none", not "the default".
    const facilitatorUrl =
      mode === 'self' || evm.facilitatorUrl === ''
        ? undefined
        : (evm.facilitatorUrl ??
          offer.extra.facilitator ??
          defaultFacilitatorFor(offer.network));
    if (facilitatorUrl === undefined && mode === 'facilitator') {
      throw new ConfigError(
        `depositing into a channel on ${offer.network} needs \`facilitatorUrl\`: the x402 ` +
          'facilitator that relays the deposit and pays its gas. This connector names none.'
      );
    }

    const build =
      method === 'permit2' ? buildPermit2Deposit : buildEip3009Deposit;
    const payload = await build({
      payer: evm.account,
      ...(evm.voucherSigner ? { voucherSigner: evm.voucherSigner } : {}),
      offer: {
        ...offer,
        extra: { ...offer.extra, withdrawDelay: channel.config.withdrawDelay },
      },
      config: channel.config,
      amount,
      voucherAmount,
    });

    // A Permit2 token needs Permit2 approved for the amount first.
    let extensions: DepositExtensions | undefined;
    // Without a reader the allowance is unknown, and the facilitator decides.
    if (method === 'permit2' && evm.reader) {
      const allowance = await permit2Allowance(
        evm.reader,
        offer.asset,
        evm.account.address
      );
      if (allowance < amount) {
        extensions = facilitatorUrl
          ? await this.sponsoredApproval(offer, facilitatorUrl, amount, payload)
          : undefined;
        if (extensions === undefined) {
          if (mode === 'facilitator') {
            throw new FacilitatorError(
              `${offer.asset} has no ERC-3009, so its deposit goes through Permit2, which needs ` +
                `a one-time approval from ${evm.account.address}; the facilitator sponsors none, ` +
                "and depositGas 'facilitator' will not spend this wallet's ETH on it.",
              'permit2_allowance_required'
            );
          }
          await this.payOwnGas(
            `a one-time Permit2 approval of ${offer.asset}`,
            facilitatorUrl
          );
          await approvePermit2(this.requireWallet(), offer.asset, {
            reader: evm.reader,
            owner: evm.account.address,
            atLeast: amount,
          });
        }
      }
    }

    if (facilitatorUrl === undefined) {
      await this.payOwnGas('the deposit', facilitatorUrl, offer.network);
      await depositDirectly(this.requireWallet(), payload, method);
      return;
    }
    try {
      await settleDeposit({
        facilitatorUrl,
        // The facilitator checks the payload against the requirements' method,
        // so they name the one signed, which the caller may have overridden.
        offer: {
          ...offer,
          extra: { ...offer.extra, assetTransferMethod: method },
        },
        payload,
        ...(extensions ? { extensions } : {}),
        fetchImpl: evm.fetch,
      });
    } catch (err) {
      // The same signed payload can go on chain from the payer's own wallet,
      // and its nonce is single-use: if the facilitator's did land after all,
      // this one reverts rather than depositing twice. An approval the
      // facilitator was to fund is not ours to redo, so that case rethrows.
      const retry =
        mode === 'auto' &&
        extensions === undefined &&
        facilitatorCannotHandle(err) &&
        (await holdsEth(evm.wallet));
      if (!retry) throw explainPermit2(err, offer, evm);
      await depositDirectly(this.requireWallet(), payload, method);
    }
  }

  /**
   * One of x402's gas-sponsoring extensions for a Permit2 approval, when the
   * facilitator offers one this token can use; `undefined` otherwise.
   */
  private async sponsoredApproval(
    offer: BatchSettlementEvmOffer,
    facilitatorUrl: string,
    amount: bigint,
    payload: { deposit: unknown }
  ): Promise<DepositExtensions | undefined> {
    const evm = this.config;
    let offered: string[];
    try {
      offered = await facilitatorExtensions(facilitatorUrl, evm.fetch);
    } catch {
      return undefined;
    }
    const chainId = evmChainIdOf(offer.network);
    if (
      offered.includes(EIP2612_GAS_SPONSORING) &&
      offer.extra.name &&
      offer.extra.version
    ) {
      const nonce = await eip2612Nonce(
        this.requireReader(),
        offer.asset,
        evm.account.address
      );
      if (nonce !== undefined) {
        const auth = (
          payload.deposit as {
            authorization: { permit2Authorization: { deadline: string } };
          }
        ).authorization.permit2Authorization;
        return signEip2612GasSponsoring({
          payer: evm.account,
          token: offer.asset,
          name: offer.extra.name,
          version: offer.extra.version,
          chainId,
          nonce,
          amount,
          deadline: auth.deadline,
        });
      }
    }
    if (offered.includes(ERC20_APPROVAL_GAS_SPONSORING) && evm.wallet) {
      return signErc20ApprovalGasSponsoring({
        payerAddress: evm.account.address,
        wallet: evm.wallet,
        token: offer.asset,
        chainId,
      });
    }
    return undefined;
  }

  /** Refuse, naming what would work, unless the payer holds ETH to pay `what` with. */
  private async payOwnGas(
    what: string,
    facilitatorUrl: string | undefined,
    network?: string
  ): Promise<void> {
    const evm = this.config;
    const wallet = evm.wallet;
    const eth = wallet ? await wallet.getBalance() : 0n;
    if (eth > 0n) return;
    if (
      network !== undefined &&
      facilitatorUrl === undefined &&
      evm.depositGas !== 'self'
    ) {
      throw new ConfigError(
        `depositing into a channel on ${network} needs either \`facilitatorUrl\` — an x402 ` +
          'facilitator that pays the gas, which this connector names none of — or ETH in ' +
          `${evm.account.address} to deposit directly.`
      );
    }
    throw new InsufficientBalanceError(
      `${what} costs gas, ${
        facilitatorUrl ? 'the facilitator does not sponsor it, ' : ''
      }and ${evm.account.address} holds no ETH to pay for it. Send it a little ETH, or use a ` +
        (what.includes('Permit2')
          ? 'facilitator that sponsors Permit2 approvals.'
          : 'facilitator.')
    );
  }

  private requireReader(): ContractReader {
    const evm = this.config;
    if (!evm.reader) {
      throw new ConfigError(
        'this payer has no EVM reader to read the token with'
      );
    }
    return evm.reader;
  }

  private requireWallet(): EvmWalletAccess {
    const evm = this.config;
    if (!evm.wallet) {
      throw new ConfigError(
        "paying a deposit's gas from this wallet needs its EVM chain access"
      );
    }
    return evm.wallet;
  }
}

/**
 * The EVM settlement network over the client's RPC route. Its reader opens the
 * RPC on first use, so a client that never reads a channel back opens no
 * connection.
 */
export function evmSettlementNetwork(params: {
  account: LocalAccount;
  rpc: ChainRpcRoute;
  fetch: typeof fetch;
  facilitatorUrl?: string;
  depositMethod?: 'eip3009' | 'permit2';
  depositGas?: 'auto' | 'facilitator' | 'self';
}): EvmSettlementNetwork {
  const { account, rpc, ...rest } = params;
  return new EvmSettlementNetwork({
    ...rest,
    account,
    reader: lazyReader(rpc),
    wallet: evmWalletAccess({ rpc, account }),
  });
}

/** A `readContract` over `route`, built on first use. */
function lazyReader(route: ChainRpcRoute): ContractReader {
  let client: ReturnType<typeof createPublicClient> | undefined;
  return {
    readContract: (params: never) => {
      client ??= createPublicClient({ transport: rpcTransport(route) });
      return client.readContract(params);
    },
  };
}

/** A facilitator's Permit2-allowance refusal, explained; any other error as it was. */
function explainPermit2(
  err: unknown,
  offer: BatchSettlementEvmOffer,
  evm: { account: { address: string } }
): unknown {
  if (
    err instanceof FacilitatorError &&
    err.reason.includes('permit2_allowance')
  ) {
    return new FacilitatorError(
      `${offer.asset} has no Permit2 allowance from ${evm.account.address}. A Permit2 ` +
        'deposit needs a one-time `approve(Permit2, …)` from the payer, which costs ' +
        'native gas unless the facilitator sponsors it; hold a little ETH, use a ' +
        'facilitator that sponsors approvals, or use a token with ERC-3009.',
      err.reason,
      err
    );
  }
  return err;
}

/**
 * Whether a failed facilitator call leaves the deposit for the payer to send
 * itself: the facilitator did not answer, answered with something that is not
 * a settle result (a 500 — x402's "no facilitator registered for this scheme
 * and network"), or said it cannot handle this kind of deposit. A refusal of
 * the deposit itself (a balance, a voucher, a deadline) would fail on chain
 * just the same, and `settlement_pending` means the facilitator's own
 * transaction may yet land.
 */
function facilitatorCannotHandle(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (!(err instanceof FacilitatorError)) return false;
  return (
    err.reason === 'unreadable_response' ||
    err.reason.startsWith('unsupported_')
  );
}

/** Whether the payer holds any ETH; an unreadable balance counts as none. */
async function holdsEth(wallet: EvmWalletAccess | undefined): Promise<boolean> {
  if (!wallet) return false;
  try {
    return (await wallet.getBalance()) > 0n;
  } catch {
    return false;
  }
}
