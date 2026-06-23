/**
 * Real, daemon-backed {@link AppBackend} for the TOON apps surface.
 *
 * Reads resolve over the free Nostr relay side (`query`); writes go through the
 * `toon-clientd` control plane (`publish-unsigned` / `upload-media`), where the
 * daemon holds the chain key and signs + pays. **No key material ever reaches
 * the iframe** — the UI only supplies an unsigned event shell or raw bytes.
 *
 * To avoid a dependency cycle (`@toon-protocol/client-mcp` imports
 * `@toon-protocol/views`), this file does NOT import client-mcp. Instead it
 * depends on a minimal structural control port, {@link DaemonControl}, which the
 * client-mcp `ControlClient` satisfies structurally.
 */

import { type NostrEvent, type NostrFilter } from '../types.js';
import {
  type AppBackend,
  type PublishResult,
  type UploadResult,
} from './backend.js';

/** One-shot free read: subscribe the filter(s), wait briefly, return matches. */
export interface DaemonQueryRequest {
  filters: NostrFilter | NostrFilter[];
  timeoutMs?: number;
}

export interface DaemonQueryResponse {
  events: NostrEvent[];
}

/** Build, sign (daemon-held key), and pay-to-write an event from a shell. */
export interface DaemonPublishUnsignedRequest {
  kind: number;
  content?: string;
  tags?: string[][];
}

export interface DaemonPublishResponse {
  eventId: string;
  channelId: string;
  nonce: number;
}

/** Upload bytes to Arweave (blob DVM), then sign+publish a referencing event. */
export interface DaemonUploadMediaRequest {
  dataBase64: string;
  mime?: string;
  kind?: number;
  caption?: string;
  tags?: string[][];
}

export interface DaemonUploadMediaResponse extends DaemonPublishResponse {
  url: string;
  txId: string;
}

/**
 * Minimal structural control-plane port the {@link DaemonAppBackend} needs.
 *
 * Intentionally a structural subset of the client-mcp `ControlClient`: that
 * class satisfies this interface without `views` importing client-mcp (which
 * would form a cycle). Extra response fields (e.g. `data` on a publish) are
 * tolerated — only the fields mapped below are read.
 */
export interface DaemonControl {
  query(body: DaemonQueryRequest): Promise<DaemonQueryResponse>;
  publishUnsigned(
    body: DaemonPublishUnsignedRequest
  ): Promise<DaemonPublishResponse>;
  uploadMedia(
    body: DaemonUploadMediaRequest
  ): Promise<DaemonUploadMediaResponse>;
}

/**
 * `AppBackend` implemented over the live daemon control plane. Construct it with
 * a `DaemonControl` (the client-mcp `ControlClient` fits) and hand it to
 * {@link ../apps-server.registerToonApps registerToonApps}.
 */
export class DaemonAppBackend implements AppBackend {
  constructor(private readonly control: DaemonControl) {}

  /** Free read — no payment. Maps `QueryResponse.events` → `NostrEvent[]`. */
  async query(filter: NostrFilter): Promise<NostrEvent[]> {
    const res = await this.control.query({ filters: filter });
    return res.events;
  }

  /** Pay-to-write. The daemon signs with the held key; the iframe holds none. */
  async publish(req: {
    kind: number;
    content?: string;
    tags?: string[][];
  }): Promise<PublishResult> {
    const res = await this.control.publishUnsigned({
      kind: req.kind,
      content: req.content,
      tags: req.tags,
    });
    return {
      eventId: res.eventId,
      channelId: res.channelId,
      nonce: res.nonce,
    };
  }

  /** Two-step spendy write: Arweave upload (DVM) then sign+publish reference. */
  async uploadMedia(req: {
    dataBase64: string;
    mime?: string;
    kind?: number;
    caption?: string;
    tags?: string[][];
  }): Promise<UploadResult> {
    const res = await this.control.uploadMedia({
      dataBase64: req.dataBase64,
      mime: req.mime,
      kind: req.kind,
      caption: req.caption,
      tags: req.tags,
    });
    return {
      eventId: res.eventId,
      channelId: res.channelId,
      nonce: res.nonce,
      url: res.url,
      txId: res.txId,
    };
  }
}
