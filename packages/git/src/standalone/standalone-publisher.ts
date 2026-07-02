/**
 * StandalonePublisher — impl 2 of the {@link Publisher} seam (#228): an
 * EMBEDDED ToonClient constructed from the caller's config (mnemonic +
 * account index, the exact `packages/client/src/config.ts` shape) instead of
 * routing through a running toon-clientd. Made for CI jobs, servers, and
 * one-shot CLI runs where no daemon exists.
 *
 * Paid-write mechanics mirror the production daemon path
 * (`client-mcp/src/daemon/client-runner.ts`) and the proven seed pipeline
 * (`rig/tests/e2e/seed/lib/{publish,git-builder}.ts`):
 *
 *  - one signed balance-proof CLAIM per write (`signBalanceProof(channelId,
 *    fee)` — the ChannelManager accumulates the cumulative watermark),
 *  - publishes route to the relay write destination with a flat per-event
 *    fee (the daemon's `feePerEvent` convention),
 *  - git objects upload as kind:5094 store writes tagged
 *    Git-SHA/Git-Type/Repo, priced at bytes × per-byte rate (the seed
 *    pipeline's bid), routed to the store destination via `proxyPath:
 *    '/store'`, with the Arweave txId decoded from the FULFILL data.
 *
 * Because the embedded client signs claims on the SAME channels a daemon on
 * the same identity would, every paid operation is preceded by the nonce
 * guard (./nonce-guard.ts): refuse if a toon-clientd holds this identity,
 * and hold an exclusive per-pubkey lockfile against other standalone
 * processes for the lifetime of this publisher.
 */

import type {
  PublishEventResult,
  SignedBalanceProof,
  ToonClientConfig,
} from '@toon-protocol/client';
import { ToonClient, parseFulfillHttp } from '@toon-protocol/client';
import { MAX_OBJECT_SIZE } from '../objects.js';
import type { UnsignedEvent } from '../nip34-events.js';
import type {
  FeeRates,
  GitObjectUpload,
  PublishReceipt,
  Publisher,
  UploadReceipt,
} from '../publisher.js';
import { checkDaemonIdentity, NonceLock } from './nonce-guard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fully-signed Nostr event (structural subset of nostr-tools' NostrEvent). */
export interface SignedNostrEvent extends UnsignedEvent {
  id: string;
  pubkey: string;
  sig: string;
}

/**
 * The slice of `ToonClient` the publisher drives. Kept structural so tests
 * inject a mock and alternative client builds stay compatible.
 */
export interface ToonClientLike {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  isStarted?(): boolean;
  getPublicKey(): string;
  signEvent(template: UnsignedEvent): SignedNostrEvent;
  openChannel(destination?: string): Promise<string>;
  signBalanceProof(
    channelId: string,
    amount: bigint
  ): Promise<SignedBalanceProof>;
  publishEvent(
    event: SignedNostrEvent,
    options?: {
      destination?: string;
      claim?: SignedBalanceProof;
      ilpAmount?: bigint;
      proxyPath?: string;
    }
  ): Promise<PublishEventResult>;
}

export interface StandalonePublisherOptions {
  /**
   * ToonClient config (mnemonic + mnemonicAccountIndex + proxy/BTP uplink +
   * settlement fields — see `packages/client/src/config.ts`). Exactly one of
   * `clientConfig` | `client` is required.
   */
  clientConfig?: ToonClientConfig;
  /** Pre-built client (tests / advanced callers). */
  client?: ToonClientLike;
  /**
   * ILP route for event publishes (relay `/write`). Default: derived from the
   * config's `destinationAddress` anchor (`<base>.relay.store` → `<base>.relay`,
   * matching the daemon's route derivation), else the anchor itself.
   */
  publishDestination?: string;
  /**
   * ILP route for git-object uploads (store `/store` → Arweave). Default:
   * derived like `publishDestination` (`<base>.relay.store` → `<base>.store`).
   */
  storeDestination?: string;
  /**
   * ILP destination the payment channel anchors to. Default: the client
   * config's `destinationAddress`.
   */
  channelDestination?: string;
  /** Flat fee per published event (daemon `feePerEvent` convention). Default 1n. */
  eventFee?: bigint;
  /** Upload fee per object body byte (seed pipeline's bid rate). Default 10n. */
  uploadFeePerByte?: bigint;
  /** Daemon control API port probed by the nonce guard. */
  daemonPort?: number;
  /** Directory for the per-identity advisory lockfile. */
  lockDir?: string;
  /** Fetch impl for the daemon probe (tests). */
  fetchImpl?: typeof fetch;
}

/** A relay/store rejected a paid write (fee NOT spent iff the claim failed too). */
export class StandalonePublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandalonePublishError';
  }
}

// ---------------------------------------------------------------------------
// Route derivation (duplicated from client-mcp daemon/config.ts — that
// package depends on this one for #227, so importing it back would be
// circular; keep in sync)
// ---------------------------------------------------------------------------

/**
 * Derive publish/store routes from the channel anchor. Behind the devnet
 * proxy the anchor is `<base>.relay.store` (e.g. `g.proxy.relay.store`):
 * publishes terminate at `<base>.relay`, uploads at `<base>.store`. Anchors
 * not matching the convention pass through unchanged.
 */
export function deriveRouteDestinations(anchor: string): {
  publish: string;
  store: string;
} {
  const segs = anchor.split('.');
  if (segs.at(-1) === 'store' && segs.at(-2) === 'relay') {
    const base = segs.slice(0, -2).join('.');
    return { publish: `${base}.relay`, store: `${base}.store` };
  }
  return { publish: anchor, store: anchor };
}

// ---------------------------------------------------------------------------
// FULFILL → Arweave txId (mirrors @toon-protocol/client blob-storage.ts,
// whose extractor is not exported; uses the exported parseFulfillHttp)
// ---------------------------------------------------------------------------

/** Arweave tx IDs are base64url-encoded 32-byte values (43 chars). */
const ARWEAVE_TX_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;

/**
 * Decode the Arweave txId from a store-write FULFILL. The deployed payment
 * proxy returns the store's verbatim HTTP/1.1 response
 * (`{"accept":true,"txId":…}` body); legacy non-proxy providers return bare
 * `base64(utf8(txId))`.
 *
 * @throws {StandalonePublishError} when no valid txId can be extracted.
 */
export function extractArweaveTxId(base64Data: string): string {
  const http = parseFulfillHttp(base64Data);

  if (!http.isHttp) {
    const legacy = Buffer.from(base64Data, 'base64').toString('utf8');
    if (!ARWEAVE_TX_ID_REGEX.test(legacy)) {
      throw new StandalonePublishError(
        `FULFILL data is not a valid Arweave tx ID: "${legacy}"`
      );
    }
    return legacy;
  }

  if (http.status < 200 || http.status >= 300) {
    throw new StandalonePublishError(
      `git-object upload failed: store returned HTTP ${http.status}` +
        (http.body ? ` - ${http.body}` : '')
    );
  }

  let parsed: { accept?: boolean; txId?: unknown; data?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(http.body) as typeof parsed;
  } catch {
    throw new StandalonePublishError(
      `git-object upload response body was not valid JSON: "${http.body}"`
    );
  }

  if (parsed.accept === false) {
    const reason = typeof parsed.error === 'string' ? `: ${parsed.error}` : '';
    throw new StandalonePublishError(
      `git-object upload rejected by store (accept:false)${reason}`
    );
  }

  if (typeof parsed.txId === 'string' && ARWEAVE_TX_ID_REGEX.test(parsed.txId)) {
    return parsed.txId;
  }
  if (typeof parsed.data === 'string' && parsed.data.length > 0) {
    const decoded = Buffer.from(parsed.data, 'base64').toString('utf8');
    if (ARWEAVE_TX_ID_REGEX.test(decoded)) return decoded;
  }

  throw new StandalonePublishError(
    `git-object upload response did not contain a valid Arweave tx ID: "${http.body}"`
  );
}

// ---------------------------------------------------------------------------
// StandalonePublisher
// ---------------------------------------------------------------------------

export class StandalonePublisher implements Publisher {
  private readonly client: ToonClientLike;
  private readonly ownsClient: boolean;
  private readonly publishDestination: string | undefined;
  private readonly storeDestination: string | undefined;
  private readonly channelDestination: string | undefined;
  private readonly eventFee: bigint;
  private readonly uploadFeePerByte: bigint;
  private readonly daemonPort: number | undefined;
  private readonly lockDir: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  private lock: NonceLock | undefined;
  private channelId: string | undefined;
  private readyPromise: Promise<void> | undefined;

  constructor(options: StandalonePublisherOptions) {
    if (options.client && options.clientConfig) {
      throw new Error(
        'StandalonePublisher: provide either `clientConfig` or `client`, not both'
      );
    }
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else if (options.clientConfig) {
      this.client = new ToonClient(options.clientConfig);
      this.ownsClient = true;
    } else {
      throw new Error(
        'StandalonePublisher: one of `clientConfig` (mnemonic-based ToonClient config) or `client` is required'
      );
    }

    // Routes: explicit option → derived from the channel anchor (same
    // `<base>.relay.store` convention the daemon resolves).
    const anchor =
      options.channelDestination ?? options.clientConfig?.destinationAddress;
    const routes = anchor ? deriveRouteDestinations(anchor) : undefined;
    this.publishDestination = options.publishDestination ?? routes?.publish;
    this.storeDestination = options.storeDestination ?? routes?.store;
    this.channelDestination = options.channelDestination;

    this.eventFee = options.eventFee ?? 1n;
    this.uploadFeePerByte = options.uploadFeePerByte ?? 10n;
    this.daemonPort = options.daemonPort;
    this.lockDir = options.lockDir;
    this.fetchImpl = options.fetchImpl;
  }

  /** Hex Nostr pubkey of the embedded identity (available before start). */
  getPublicKey(): string {
    return this.client.getPublicKey();
  }

  /**
   * Run the nonce guard, start the embedded client, and open (or resume) the
   * payment channel. Called lazily by the first paid operation; safe to call
   * eagerly to fail fast. Idempotent.
   */
  start(): Promise<void> {
    this.readyPromise ??= this.doStart().catch((err: unknown) => {
      // Let a later call retry (e.g. after the conflicting daemon stops).
      this.readyPromise = undefined;
      throw err;
    });
    return this.readyPromise;
  }

  private async doStart(): Promise<void> {
    const pubkey = this.client.getPublicKey();

    // Guard 1: refuse while a toon-clientd holds this identity.
    await checkDaemonIdentity(pubkey, {
      ...(this.daemonPort !== undefined ? { port: this.daemonPort } : {}),
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });

    // Guard 2: exclusive advisory lock against other standalone processes.
    this.lock = await NonceLock.acquire(pubkey, {
      ...(this.lockDir !== undefined ? { dir: this.lockDir } : {}),
    });

    try {
      if (this.client.isStarted?.() !== true) {
        await this.client.start();
      }
      // Idempotent — returns the existing channel for the peer if one is open.
      this.channelId = await this.client.openChannel(this.channelDestination);
    } catch (err) {
      this.lock.release();
      this.lock = undefined;
      throw err;
    }
  }

  /** Release the identity lock and stop the embedded client (if we own it). */
  async stop(): Promise<void> {
    this.lock?.release();
    this.lock = undefined;
    this.readyPromise = undefined;
    this.channelId = undefined;
    if (this.ownsClient) {
      await this.client.stop();
    }
  }

  // ── Publisher ─────────────────────────────────────────────────────────────

  /**
   * Fee rates for `planPush` estimation: the flat per-event fee and the
   * per-byte upload rate this publisher pays (daemon `feePerEvent` and seed
   * bid-rate conventions; override via options).
   */
  getFeeRates(): Promise<FeeRates> {
    return Promise.resolve({
      uploadFeePerByte: this.uploadFeePerByte,
      eventFee: this.eventFee,
    });
  }

  /**
   * Upload one git object as a kind:5094 store write (Git-SHA/Git-Type/Repo
   * tagged — the proven seed-pipeline shape), signing one balance-proof claim
   * for `body.length × uploadFeePerByte`.
   */
  async uploadGitObject(upload: GitObjectUpload): Promise<UploadReceipt> {
    if (upload.body.length > MAX_OBJECT_SIZE) {
      throw new StandalonePublishError(
        `git object ${upload.sha} exceeds the ${MAX_OBJECT_SIZE}-byte limit: ${upload.body.length} bytes`
      );
    }
    await this.start();
    const channelId = this.requireChannel();

    const fee = BigInt(upload.body.length) * this.uploadFeePerByte;
    const event = this.client.signEvent({
      kind: 5094,
      content: '',
      created_at: nowSeconds(),
      tags: [
        ['i', upload.body.toString('base64'), 'blob'],
        ['bid', fee.toString(), 'usdc'],
        ['output', 'application/octet-stream'],
        ['Git-SHA', upload.sha],
        ['Git-Type', upload.type],
        ['Repo', upload.repoId],
      ],
    });

    const claim = await this.client.signBalanceProof(channelId, fee);
    const result = await this.client.publishEvent(event, {
      ...(this.storeDestination ? { destination: this.storeDestination } : {}),
      claim,
      ilpAmount: fee,
      // The store backend serves POST /store (not the relay's /write).
      proxyPath: '/store',
    });
    if (!result.success) {
      throw new StandalonePublishError(
        `git-object upload rejected (${upload.sha}): ${result.error ?? 'store rejected the write'}`
      );
    }
    if (!result.data) {
      throw new StandalonePublishError(
        `git-object upload FULFILL carried no data (${upload.sha}); expected the Arweave tx ID`
      );
    }
    return { txId: extractArweaveTxId(result.data), feePaid: fee };
  }

  /**
   * Sign the event with the embedded identity and pay-to-publish it through
   * the relay write route, one claim for the flat per-event fee.
   *
   * `relayUrls` is the interface's plural forward-compat surface (parked
   * #84): the standalone impl routes over ILP to its single configured
   * publish destination, so more than one relay is refused rather than
   * silently half-published.
   */
  async publishEvent(
    event: UnsignedEvent,
    relayUrls: string[]
  ): Promise<PublishReceipt> {
    if (relayUrls.length > 1) {
      throw new StandalonePublishError(
        `multi-relay publish is not supported yet (got ${relayUrls.length} relays) — the standalone publisher routes to a single relay destination (#84 parked)`
      );
    }
    await this.start();
    const channelId = this.requireChannel();

    const signed = this.client.signEvent(event);
    const fee = this.eventFee;
    const claim = await this.client.signBalanceProof(channelId, fee);
    const result = await this.client.publishEvent(signed, {
      ...(this.publishDestination
        ? { destination: this.publishDestination }
        : {}),
      claim,
      ilpAmount: fee,
    });
    if (!result.success) {
      throw new StandalonePublishError(
        `publish rejected (kind ${event.kind}): ${result.error ?? 'relay rejected the event'}`
      );
    }
    return { eventId: result.eventId ?? signed.id, feePaid: fee };
  }

  private requireChannel(): string {
    if (!this.channelId) {
      throw new StandalonePublishError(
        'no payment channel open — start() did not complete'
      );
    }
    return this.channelId;
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
