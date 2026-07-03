/**
 * Dependency-light types for the client money lifecycle (#263): the seam
 * between the money CLI commands (`rig fund` / `rig balance` /
 * `rig channel open|close|settle`) and the standalone publisher's money
 * operations.
 *
 * Lives beside channel-map.ts (not in standalone-publisher.ts) so
 * `cli/standalone-context.ts` — which command modules `import type` without
 * dragging in `@toon-protocol/client` — can reference these shapes: the
 * publisher module statically imports the heavy client package, this module
 * imports nothing but the (node:fs-only) channel map types.
 */

import type { ChannelMapRecord } from './channel-map.js';

/**
 * One asset amount within a chain's wallet view — structural twin of
 * `@toon-protocol/client`'s `WalletTokenAmount`; keep in sync.
 */
export interface WalletTokenAmountInfo {
  /** Asset symbol (e.g. `'ETH'`, `'SOL'`, `'MINA'`, `'USDC'`), when known. */
  symbol?: string;
  /** Base-unit integer, decimal string. */
  amount: string;
  /** Decimals for formatting (ETH 18, SOL 9, MINA 9, USDC 6). */
  decimals?: number;
  /** Token contract / SPL mint address. Absent for the native coin. */
  address?: string;
}

/**
 * The full wallet view for ONE chain — native coin + configured tokens —
 * structural twin of `@toon-protocol/client`'s `WalletChainBalances`
 * (`balance/WalletBalanceReader.ts`, exported from the package root); keep in
 * sync.
 */
export interface WalletChainBalanceInfo {
  chain: 'evm' | 'solana' | 'mina';
  /** Full chain key, e.g. `'evm:31337'`, `'solana'`, `'mina'`. */
  chainKey: string;
  address: string;
  /** Native-coin balance, when readable. */
  native?: WalletTokenAmountInfo;
  /** Configured token balances (e.g. USDC). */
  tokens: WalletTokenAmountInfo[];
  /** True when nothing on this chain could be read (RPC unreachable). */
  unreadable?: boolean;
  /** First read error, when any read failed. */
  error?: string;
}

/** Receipt of an explicit `rig channel open` (fresh open OR resume). */
export interface ChannelOpenOutcome {
  channelId: string;
  /** True when the recorded channel was resumed (no on-chain open). */
  resumed: boolean;
  /** ILP anchor destination the channel is keyed by in the map. */
  destination: string;
  /** Negotiated settlement chain, when recorded (e.g. `evm:31337`). */
  chain?: string;
  /** Registered peer id, when recorded. */
  peerId?: string;
  /** On-chain deposit total (base units), when known. */
  depositTotal?: string;
  /** Extra collateral added by `--deposit` (base units), when any. */
  depositAdded?: string;
  /** Tx hash of the `--deposit` top-up, when any. */
  depositTxHash?: string;
}

/** Receipt of a channel close (start of the settlement challenge window). */
export interface ChannelCloseOutcome {
  channelId: string;
  txHash?: string;
  /** Unix SECONDS (string-encoded bigint) the close landed on-chain. */
  closedAt: string;
  /** Unix SECONDS (string-encoded bigint) settle becomes possible. */
  settleableAt: string;
}

/** Receipt of a channel settle (collateral released). */
export interface ChannelSettleOutcome {
  channelId: string;
  txHash?: string;
}

/**
 * The money operations a standalone context exposes to the CLI commands.
 * Implemented by `StandalonePublisher` (guard + client start shared with the
 * paid-write path); tests inject fakes.
 */
export interface StandaloneMoneyOps {
  /**
   * Explicitly open (or resume) the payment channel for the context's
   * channel anchor — the SAME resume-or-open path lazy paid writes use, so
   * the result lands in the #262 peer→channel map. `deposit` adds that much
   * extra collateral (base units) after the open/resume.
   */
  openChannel(opts?: { deposit?: bigint }): Promise<ChannelOpenOutcome>;
  /** Close a recorded channel — starts the on-chain challenge window. */
  closeChannel(record: ChannelMapRecord): Promise<ChannelCloseOutcome>;
  /** Settle a closed channel after its challenge window — releases funds. */
  settleChannel(record: ChannelMapRecord): Promise<ChannelSettleOutcome>;
  /**
   * The full multi-chain wallet view (#299) for the identity's configured
   * chains — native coin + configured tokens (USDC) grouped per chain — a FREE
   * read (no client start, no nonce guard, no uplink). Best-effort per chain:
   * an unreachable RPC yields an `unreadable` chain rather than failing others.
   */
  walletChainBalances(): Promise<WalletChainBalanceInfo[]>;
}
