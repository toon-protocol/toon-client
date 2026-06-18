/**
 * Pluggable read/write backends for the TOON apps MCP server.
 *
 * The apps server (atoms + ViewSpec rendering) depends only on these
 * interfaces. The {@link ./fake-backend FakeBackend} satisfies them with a
 * seeded relay + in-memory writes (good enough while core/sdk are in flux); the
 * real `@toon-protocol/client-mcp` daemon will satisfy them with live BTP writes
 * and relay reads.
 */

import { type NostrEvent, type NostrFilter } from '../types.js';

/** Free-read side: resolve a NIP-01 filter to matching events. */
export interface AppReadBackend {
  query(filter: NostrFilter): Promise<NostrEvent[]>;
}

export interface PublishResult {
  eventId: string;
  channelId?: string;
  nonce?: number;
}

export interface UploadResult extends PublishResult {
  url: string;
  txId: string;
}

/** Pay-to-write side: sign+publish an event shell; upload+publish media. */
export interface AppWriteBackend {
  publish(req: {
    kind: number;
    content?: string;
    tags?: string[][];
  }): Promise<PublishResult>;
  uploadMedia(req: {
    dataBase64: string;
    mime?: string;
    kind?: number;
    caption?: string;
    tags?: string[][];
  }): Promise<UploadResult>;
}

export interface AppBackend extends AppReadBackend, AppWriteBackend {}
