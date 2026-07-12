import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SwapPair } from '@toon-protocol/core';

/**
 * The persisted receive-side watermark for one swap target channel: the
 * HIGHEST-NONCE verified chain-B claim per `(chain, channelId)` (toon-client
 * issue #352, rolling-swap spec toon-meta docs/rolling-swap.md §3.2/§9).
 *
 * Claims are cumulative balance proofs — a higher-nonce claim supersedes every
 * earlier one — so persisting only the winner per channel is lossless for
 * settlement: `buildSettlementTx` redeems exactly this claim. Superseded claims
 * are informational and dropped.
 */
export interface ReceivedClaimEntry {
  /** Target chain the claim settles on (`pair.to.chain`, e.g. `evm:base:8453`). */
  chain: string;
  /** Payment-channel id on the target chain (0x-hex for EVM, base58 otherwise). */
  channelId: string;
  /** Balance-proof nonce (strictly increasing per channel). */
  nonce: bigint;
  /** Cumulative transferred amount, target micro-units. */
  cumulativeAmount: bigint;
  /** Recipient address the claim pays (the sender's `chainRecipient`). */
  recipient: string;
  /** Swap peer's on-chain signer address the signature verified against. */
  swapSignerAddress: string;
  /** The verified signed claim bytes (chain-specific encoding). */
  claimBytes: Uint8Array;
  /** Optional swap-side claim id. */
  claimId?: string;
  /** The SwapPair the claim was priced against (settlement-time routing). */
  pair: SwapPair;
  /** Unix ms the winning claim was accepted off the wire. */
  receivedAt: number;
  /** Unix ms this entry was last advanced. */
  updatedAt: number;
  /** Unix ms of the last successful on-chain settlement submission. */
  settledAt?: number;
  /** Watermark nonce redeemed by that settlement (claims ≤ this are settled). */
  settledNonce?: bigint;
  /** Tx hash of the last settlement submission. */
  settleTxHash?: string;
}

/**
 * Persistence interface for received (chain-B) swap claims. Mirrors
 * {@link ChannelStore}'s sync surface; keyed by `(chain, channelId)`.
 */
export interface ReceivedClaimStore {
  save(entry: ReceivedClaimEntry): void;
  load(chain: string, channelId: string): ReceivedClaimEntry | undefined;
  list(): ReceivedClaimEntry[];
  delete(chain: string, channelId: string): void;
}

interface JsonEntry {
  chain: string;
  channelId: string;
  /** Stored as strings to preserve bigint precision. */
  nonce: string;
  cumulativeAmount: string;
  recipient: string;
  swapSignerAddress: string;
  /** base64 */
  claimBytes: string;
  claimId?: string;
  pair: SwapPair;
  receivedAt: number;
  updatedAt: number;
  settledAt?: number;
  settledNonce?: string;
  settleTxHash?: string;
}

function key(chain: string, channelId: string): string {
  return `${chain}|${channelId}`;
}

/**
 * JSON file-backed {@link ReceivedClaimStore}. Synchronous I/O to match the
 * `JsonFileChannelStore` pattern (`ChannelStore.ts`); the parent directory is
 * created on first save so a fresh daemon home works out of the box.
 */
export class JsonFileReceivedClaimStore implements ReceivedClaimStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  save(entry: ReceivedClaimEntry): void {
    const data = this.readFile();
    data[key(entry.chain, entry.channelId)] = {
      chain: entry.chain,
      channelId: entry.channelId,
      nonce: entry.nonce.toString(),
      cumulativeAmount: entry.cumulativeAmount.toString(),
      recipient: entry.recipient,
      swapSignerAddress: entry.swapSignerAddress,
      claimBytes: Buffer.from(entry.claimBytes).toString('base64'),
      ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
      pair: entry.pair,
      receivedAt: entry.receivedAt,
      updatedAt: entry.updatedAt,
      ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
      ...(entry.settledNonce !== undefined
        ? { settledNonce: entry.settledNonce.toString() }
        : {}),
      ...(entry.settleTxHash !== undefined
        ? { settleTxHash: entry.settleTxHash }
        : {}),
    };
    this.writeFile(data);
  }

  load(chain: string, channelId: string): ReceivedClaimEntry | undefined {
    const entry = this.readFile()[key(chain, channelId)];
    return entry ? fromJson(entry) : undefined;
  }

  list(): ReceivedClaimEntry[] {
    return Object.values(this.readFile()).map(fromJson);
  }

  delete(chain: string, channelId: string): void {
    const data = this.readFile();
    const { [key(chain, channelId)]: _, ...rest } = data;
    this.writeFile(rest);
  }

  private readFile(): Record<string, JsonEntry> {
    if (!existsSync(this.filePath)) {
      return {};
    }
    const raw = readFileSync(this.filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, JsonEntry>;
  }

  private writeFile(data: Record<string, JsonEntry>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

/**
 * In-memory {@link ReceivedClaimStore} for tests and path-less configs. NOT
 * restart-safe — a daemon should always be given a `JsonFileReceivedClaimStore`.
 */
export class InMemoryReceivedClaimStore implements ReceivedClaimStore {
  private readonly entries = new Map<string, ReceivedClaimEntry>();

  save(entry: ReceivedClaimEntry): void {
    this.entries.set(key(entry.chain, entry.channelId), { ...entry });
  }

  load(chain: string, channelId: string): ReceivedClaimEntry | undefined {
    const entry = this.entries.get(key(chain, channelId));
    return entry ? { ...entry } : undefined;
  }

  list(): ReceivedClaimEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  delete(chain: string, channelId: string): void {
    this.entries.delete(key(chain, channelId));
  }
}

function fromJson(entry: JsonEntry): ReceivedClaimEntry {
  return {
    chain: entry.chain,
    channelId: entry.channelId,
    nonce: BigInt(entry.nonce),
    cumulativeAmount: BigInt(entry.cumulativeAmount),
    recipient: entry.recipient,
    swapSignerAddress: entry.swapSignerAddress,
    claimBytes: new Uint8Array(Buffer.from(entry.claimBytes, 'base64')),
    ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
    pair: entry.pair,
    receivedAt: entry.receivedAt,
    updatedAt: entry.updatedAt,
    ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
    ...(entry.settledNonce !== undefined
      ? { settledNonce: BigInt(entry.settledNonce) }
      : {}),
    ...(entry.settleTxHash !== undefined
      ? { settleTxHash: entry.settleTxHash }
      : {}),
  };
}
