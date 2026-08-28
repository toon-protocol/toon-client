/**
 * The on-chain channel port: what the client needs a chain to be able to do,
 * independent of which chain it is.
 *
 * These types were `@toon-protocol/core`'s `ConnectorChannelClient` family,
 * whose names still carried the retired admin-API model — a channel opened by
 * `POST /admin/channels` on the connector. That is not how a channel comes into
 * existence any more, and the naming mattered: **a connector has no endpoint
 * that opens a channel** (`self-description-spec.md` ND-03). The client opens,
 * funds, closes and settles the channel itself, directly on chain, and the
 * connector discovers it by reading the chain
 * ([ADR 0052](https://github.com/toon-protocol/connector/blob/main/docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md)).
 * So this is a port over *chains*, not over the connector.
 */

/** Which settlement family a channel lives in. Mina is gone (connector ADR 0002). */
export type ChainKind = 'evm' | 'solana';

/**
 * Everything needed to open one channel, as read off the connector's own
 * self-description (`GET /ilp` → `settlements[]`) rather than configured.
 *
 * The connector proved each of these against a live chain at startup
 * (`self-description-spec.md` ND-07), which is why they are taken from the
 * document instead of from a preset: two declarations of one fact is how a
 * mainnet node comes to describe itself as devnet.
 */
export interface ChannelTerms {
  kind: ChainKind;
  /** The chain key exactly as published: `evm:84532`, or `solana`. */
  chain: string;
  /** EVM only: the numeric chain id parsed out of `chain`. The EIP-712 domain's `chainId`. */
  chainId?: number;
  /**
   * The connector's own settlement address — the counterparty this channel is
   * opened *with*. `0x…` on EVM, base58 on Solana.
   */
  counterparty: string;
  /** ERC-20 address, or the SPL mint. */
  token: string;
  /** Base units per whole token, as the connector reports it. */
  decimals: number;
  /** EVM: the `TokenNetwork` — the EIP-712 `verifyingContract` a claim is signed under. */
  tokenNetwork?: string;
  /** EVM: the `TokenNetworkRegistry` that minted the `TokenNetwork`; the stable address. */
  tokenNetworkRegistry?: string;
  /** Solana: the settlement program the channel account lives under, bound into every claim (ADR 0053). */
  programId?: string;
}

/** Parameters for opening a channel on chain. */
export interface OpenChannelParams {
  terms: ChannelTerms;
  /** Initial collateral, in the token's base units. */
  initialDeposit?: bigint;
  /**
   * Challenge period in seconds. The EVM `TokenNetwork` enforces a one-hour
   * floor; the Solana program takes it as the channel's `challenge_duration`.
   */
  settlementTimeout?: number;
}

/** What opening produced. */
export interface OpenChannelResult {
  /** `0x…` 32 bytes on EVM; the channel account's base58 pubkey on Solana. */
  channelId: string;
  status: ChannelStatus;
  /** The transaction that opened it. Absent when an existing channel was adopted. */
  txHash?: string;
  /** On-chain collateral after opening, when the opener read it back. */
  depositTotal?: bigint;
}

/**
 * Where a channel is in its lifecycle.
 *
 * `opening` is real and worth distinguishing: the opening transaction is
 * submitted but not yet confirmed, so the channel does not exist for anyone
 * reading the chain — including the connector, which resolves a claim's channel
 * by reading it. A claim signed in that window is refused as naming an unknown
 * channel, and the remedy is to wait rather than to re-sign.
 */
export type ChannelStatus =
  | 'opening'
  | 'open'
  | 'closed'
  | 'settled'
  | 'missing';

/** A channel as the chain currently reports it. */
export interface OnChainChannelStatus {
  channelId: string;
  status: ChannelStatus;
  /** The chain key this channel lives on, when the reader knows it. */
  chain?: string;
  /** This participant's collateral, in base units. */
  deposit?: bigint;
  /** Unix seconds the channel was closed, when it is closed. */
  closedAt?: bigint;
  /** Unix seconds after which `settle` is permitted. */
  settleableAt?: bigint;
}

/**
 * One chain's implementation of the lifecycle.
 *
 * Every method here is a transaction the *client* signs and pays gas for. None
 * of them talks to a connector.
 */
export interface ChannelClient {
  openChannel(params: OpenChannelParams): Promise<OpenChannelResult>;
  /**
   * Add collateral. `currentDeposit` is the channel's present total, which EVM
   * needs because `setTotalDeposit` takes the new cumulative figure rather than
   * a delta — a contract shape that makes a lost or duplicated call harmless.
   */
  depositToChannel(
    channelId: string,
    amount: bigint,
    opts: { currentDeposit: bigint }
  ): Promise<{ txHash?: string; depositTotal: bigint }>;
  /** Start the challenge period. */
  closeChannel(channelId: string): Promise<{
    txHash?: string;
    closedAt: bigint;
    settlementTimeout: bigint;
    settleableAt: bigint;
  }>;
  /** Pay out and finish. Only permitted once the challenge period has elapsed. */
  settleChannel(channelId: string): Promise<{ txHash?: string }>;
  getChannelState(channelId: string): Promise<OnChainChannelStatus>;
}
