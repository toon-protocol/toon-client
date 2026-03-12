import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface ChannelStoreEntry {
  nonce: number;
  cumulativeAmount: bigint;
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
