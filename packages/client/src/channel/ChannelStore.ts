import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface ChannelStoreEntry {
  nonce: number;
  cumulativeAmount: bigint;
  /** Unix SECONDS when close was initiated (withdraw flow). */
  closedAt?: bigint;
  /** Unix SECONDS the channel becomes settleable (= closedAt + settlementTimeout). */
  settleableAt?: bigint;
  /** Unix SECONDS the channel was settled (collateral released). */
  settledAt?: bigint;
}

/**
 * Persistence interface for payment channel nonce/amount state.
 */
export interface ChannelStore {
  save(channelId: string, tracking: ChannelStoreEntry): void;
  load(channelId: string): ChannelStoreEntry | undefined;
  list(): string[];
  delete(channelId: string): void;
}

interface JsonEntry {
  nonce: number;
  /** Stored as string to preserve bigint precision */
  cumulativeAmount: string;
  /** Withdraw-flow timers, string-encoded SECONDS (bigint precision). */
  closedAt?: string;
  settleableAt?: string;
  settledAt?: string;
}

/**
 * JSON file-backed ChannelStore.
 * Uses synchronous I/O to match ChannelManager's sync API surface.
 */
export class JsonFileChannelStore implements ChannelStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  save(channelId: string, tracking: ChannelStoreEntry): void {
    const data = this.readFile();
    data[channelId] = {
      nonce: tracking.nonce,
      cumulativeAmount: tracking.cumulativeAmount.toString(),
      ...(tracking.closedAt !== undefined ? { closedAt: tracking.closedAt.toString() } : {}),
      ...(tracking.settleableAt !== undefined ? { settleableAt: tracking.settleableAt.toString() } : {}),
      ...(tracking.settledAt !== undefined ? { settledAt: tracking.settledAt.toString() } : {}),
    };
    this.writeFile(data);
  }

  load(channelId: string): ChannelStoreEntry | undefined {
    const data = this.readFile();
    const entry = data[channelId];
    if (!entry) return undefined;
    return {
      nonce: entry.nonce,
      cumulativeAmount: BigInt(entry.cumulativeAmount),
      ...(entry.closedAt !== undefined ? { closedAt: BigInt(entry.closedAt) } : {}),
      ...(entry.settleableAt !== undefined ? { settleableAt: BigInt(entry.settleableAt) } : {}),
      ...(entry.settledAt !== undefined ? { settledAt: BigInt(entry.settledAt) } : {}),
    };
  }

  list(): string[] {
    return Object.keys(this.readFile());
  }

  delete(channelId: string): void {
    const data = this.readFile();
    const { [channelId]: _, ...rest } = data;
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
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
