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
 *
 * Channel REUSE (#262): with a `channelMap` configured, start() resumes the
 * channel recorded for (identity, channel anchor) — `trackChannel` rehydrates
 * the cumulative-claim watermark from the client's channels.json — and
 * records any fresh lazy open, so sequential CLI invocations share ONE
 * on-chain channel instead of stranding a deposit per run (./channel-map.ts).
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
import {
  recordKey,
  type ChannelMapRecord,
  type ChannelMapStore,
  type PersistedChannelContext,
} from './channel-map.js';
import type {
  ChannelCloseOutcome,
  ChannelOpenOutcome,
  ChannelSettleOutcome,
  WalletBalanceInfo,
} from './money.js';
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
  /** On-chain deposit total for a tracked channel (channel-map bookkeeping). */
  getChannelDepositTotal?(channelId: string): bigint;
  /** Re-read a RESUMED channel's on-chain deposit (persisted state omits it). */
  rehydrateChannelDeposit?(
    channelId: string,
    opts: { chain: string; tokenNetworkAddress: string }
  ): Promise<bigint | undefined>;
  // ── money lifecycle (#263) — optional, matches ToonClient's surface ──────
  /** Deposit extra collateral (base-unit delta) into an open channel. */
  depositToChannel?(
    channelId: string,
    amount: string | bigint
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }>;
  /** Close a channel — starts the settlement challenge window (on-chain). */
  closeChannel?(channelId: string): Promise<{
    channelId: string;
    txHash?: string;
    /** Unix SECONDS, string-encoded. */
    closedAt: string;
    settleableAt: string;
  }>;
  /** Settle a closed channel after its window — releases funds (on-chain). */
  settleChannel?(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string }>;
  /** Free on-chain wallet-balance read (works on an UNSTARTED client). */
  getBalances?(): Promise<WalletBalanceInfo[]>;
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
  /**
   * Peer→channel map store (#262): start() resumes the channel recorded for
   * (identity, channel anchor) instead of opening a fresh one, and records
   * any fresh lazy open for the next invocation. Absent (embedded callers
   * managing their own channel lifecycle): the historical behaviour — open
   * lazily every run, record nothing.
   */
  channelMap?: ChannelMapStore;
  /**
   * Per-chain settlement parameters to BACK-FILL into the client's peer
   * negotiations after start (#264/#260): peers whose kind:10032 announce
   * carries no `tokenNetworks`/`preferredTokens` negotiate with those fields
   * empty, and the on-chain channel open then fails ("tokenNetwork address
   * is required"). Values here never override what a peer DID announce —
   * they only fill gaps, keyed by the negotiated chain id.
   */
  negotiationFallbacks?: {
    tokenNetworks?: Record<string, string>;
    preferredTokens?: Record<string, string>;
  };
  /** Sink for non-fatal channel-persistence warnings (default: stderr). */
  warn?: (line: string) => void;
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
// Channel-resume introspection (#262)
//
// The peer negotiation table and the ChannelManager's peer→channel map are
// PRIVATE on ToonClient, so resuming a channel reaches into them through a
// structural runtime cast — the exact pattern the daemon uses
// (client-mcp/src/daemon/client-runner.ts, openOrResumeApexChannel /
// routeChildPeersThroughApexChannel). Keep the shapes in sync with
// @toon-protocol/client's ToonClient/ChannelManager.
// ---------------------------------------------------------------------------

/** The slice of a `PeerNegotiation` the channel map records. */
interface NegotiationLike {
  chain: string;
  chainType: string;
  chainId: number | string;
  settlementAddress: string;
  tokenAddress?: string;
  tokenNetwork?: string;
}

interface ChannelInternals {
  peerNegotiations?: Map<string, NegotiationLike>;
  channelManager?: {
    trackChannel?: (
      channelId: string,
      context: PersistedChannelContext
    ) => void;
    peerChannels?: Map<string, string>;
  };
  /**
   * The client's on-chain channel client caches per-channel chain context at
   * OPEN time only; close/settle/deposit on a channel resumed from the map
   * would throw "No on-chain context" without re-seeding it (#263). Same
   * structural-cast contract as the rest of this block — keep in sync with
   * `@toon-protocol/client`'s OnChainChannelClient.
   */
  onChainChannelClient?: {
    channelContext?: Map<
      string,
      { chain: string; tokenNetworkAddress: string; tokenAddress?: string }
    >;
  };
}

/** Best-effort access to the client's private negotiation/channel state. */
function channelInternals(client: ToonClientLike): ChannelInternals {
  const c = client as unknown as ChannelInternals;
  const negotiations =
    c.peerNegotiations instanceof Map ? c.peerNegotiations : undefined;
  const cm =
    c.channelManager &&
    typeof c.channelManager.trackChannel === 'function' &&
    c.channelManager.peerChannels instanceof Map
      ? c.channelManager
      : undefined;
  const onChain =
    c.onChainChannelClient &&
    c.onChainChannelClient.channelContext instanceof Map
      ? c.onChainChannelClient
      : undefined;
  return {
    ...(negotiations ? { peerNegotiations: negotiations } : {}),
    ...(cm ? { channelManager: cm } : {}),
    ...(onChain ? { onChainChannelClient: onChain } : {}),
  };
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
  private readonly channelMap: ChannelMapStore | undefined;
  /** ILP anchor the channel is keyed by in the map (peer/apex destination). */
  private readonly channelAnchor: string | undefined;
  private readonly negotiationFallbacks:
    | StandalonePublisherOptions['negotiationFallbacks']
    | undefined;
  private readonly warn: (line: string) => void;

  private lock: NonceLock | undefined;
  private channelId: string | undefined;
  private readyPromise: Promise<void> | undefined;
  /** Guard + client start only (no channel) — see {@link startClientOnly}. */
  private clientReadyPromise: Promise<void> | undefined;
  /** True when the last start() RESUMED the recorded channel (#263). */
  private lastOpenResumed = false;

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
    this.channelMap = options.channelMap;
    this.channelAnchor = anchor;
    this.negotiationFallbacks = options.negotiationFallbacks;
    this.warn =
      options.warn ?? ((line) => process.stderr.write(`${line}\n`));
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
    this.readyPromise ??= (async () => {
      await this.startClientOnly();
      try {
        this.channelId = await this.openOrResumeChannel();
      } catch (err) {
        // Release the identity lock on a failed channel open (pre-#263
        // behaviour): nothing holds claims yet, so another process may go.
        this.lock?.release();
        this.lock = undefined;
        this.clientReadyPromise = undefined;
        throw err;
      }
    })().catch((err: unknown) => {
      // Let a later call retry (e.g. after the conflicting daemon stops).
      this.readyPromise = undefined;
      throw err;
    });
    return this.readyPromise;
  }

  /**
   * Run the nonce guard and start the embedded client WITHOUT touching the
   * payment channel (#263): `channel close`/`settle` operate on a RECORDED
   * channel and must never open a fresh one as a side effect of starting.
   * Idempotent; `start()` layers the channel open/resume on top of this.
   */
  startClientOnly(): Promise<void> {
    this.clientReadyPromise ??= this.doStartClient().catch((err: unknown) => {
      this.clientReadyPromise = undefined;
      throw err;
    });
    return this.clientReadyPromise;
  }

  private async doStartClient(): Promise<void> {
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
      // #264: back-fill negotiation gaps as soon as the client's bootstrap
      // negotiation exists — before any channel open (start()) or recorded-
      // channel operation reads them.
      this.applyNegotiationFallbacks();
    } catch (err) {
      this.lock.release();
      this.lock = undefined;
      throw err;
    }
  }

  /**
   * Back-fill negotiated peer metadata the announce did not carry
   * (#264/#260 root cause 3): after the client's bootstrap negotiation, any
   * peer negotiation missing `tokenNetwork`/`tokenAddress` gets the derived
   * per-chain fallback for its negotiated chain, BEFORE the lazy channel
   * open reads them. Announced values are never overridden.
   */
  private applyNegotiationFallbacks(): void {
    const fallbacks = this.negotiationFallbacks;
    if (!fallbacks) return;
    const negotiations = channelInternals(this.client).peerNegotiations;
    if (!negotiations) {
      this.warn(
        'rig: settlement fallbacks configured but the client does not ' +
          'expose negotiation internals — on-chain channel opening may fail ' +
          'if the peer announced no TokenNetwork'
      );
      return;
    }
    for (const negotiation of negotiations.values()) {
      if (!negotiation.tokenNetwork) {
        const tokenNetwork = fallbacks.tokenNetworks?.[negotiation.chain];
        if (tokenNetwork) negotiation.tokenNetwork = tokenNetwork;
      }
      if (!negotiation.tokenAddress) {
        const tokenAddress = fallbacks.preferredTokens?.[negotiation.chain];
        if (tokenAddress) negotiation.tokenAddress = tokenAddress;
      }
    }
  }

  /**
   * Open the payment channel — or, when the channel map has a record for
   * (identity, anchor), RESUME the recorded on-chain channel (#262).
   *
   * Resume seeds the client's ChannelManager (`trackChannel` rehydrates the
   * cumulative-claim watermark from channels.json; `peerChannels` makes the
   * subsequent `openChannel` return the same id instead of opening on-chain).
   * A fresh open is RECORDED so the next invocation resumes it. A corrupt map
   * file throws BEFORE anything is opened — never a silent duplicate open.
   */
  private async openOrResumeChannel(): Promise<string> {
    const map = this.channelMap;
    if (!map) {
      // No persistence configured: historical lazy open, nothing recorded.
      return this.client.openChannel(this.channelDestination);
    }
    if (!this.channelAnchor) {
      this.warn(
        'rig: no channel anchor destination configured — the peer→channel ' +
          'mapping cannot be persisted, so this run may open a fresh channel'
      );
      return this.client.openChannel(this.channelDestination);
    }

    const anchor = this.channelAnchor;
    const identity = this.client.getPublicKey();
    // Corruption check happens HERE, before any on-chain open (throws).
    const candidates = map.listFor(identity, anchor);
    const internals = channelInternals(this.client);
    const resumed = await this.resumeRecordedChannel(map, candidates, internals);

    // Idempotent — returns the (resumed or existing) channel for the peer if
    // one is tracked, else opens lazily on-chain.
    const channelId = await this.client.openChannel(this.channelDestination);

    if (resumed && channelId === resumed.channelId) {
      this.lastOpenResumed = true;
      map.touch(recordKey(resumed));
    } else {
      this.lastOpenResumed = false;
      this.recordOpenedChannel(map, internals, identity, anchor, channelId);
    }
    return channelId;
  }

  /**
   * Try to resume one recorded channel: the first candidate whose peer is
   * still negotiated on the SAME chain + tokenNetwork and whose watermark
   * does not show it closed/settled. Returns the resumed record, if any.
   */
  private async resumeRecordedChannel(
    map: ChannelMapStore,
    candidates: ChannelMapRecord[],
    internals: ChannelInternals
  ): Promise<ChannelMapRecord | undefined> {
    if (candidates.length === 0) return undefined;
    const cm = internals.channelManager;
    if (!cm?.trackChannel || !cm.peerChannels) {
      this.warn(
        'rig: a recorded channel exists but the client does not expose ' +
          'channel internals to resume it — a fresh channel may be opened'
      );
      return undefined;
    }

    for (const record of candidates) {
      // The peer must still be negotiated on the recorded chain/tokenNetwork;
      // a rotated peer identity or re-negotiated settlement gets a fresh
      // channel (recorded under its own key) instead of stale claims.
      const negotiation = internals.peerNegotiations?.get(record.peerId);
      if (
        !negotiation ||
        negotiation.chain !== record.chain ||
        (negotiation.tokenNetwork ?? '') !== record.tokenNetwork
      ) {
        continue;
      }

      // Never resume a channel the withdraw flow already closed/settled.
      const watermark = map.readWatermark(record.channelId);
      if (
        watermark?.closedAt !== undefined ||
        watermark?.settledAt !== undefined
      ) {
        continue;
      }
      if (!watermark) {
        // Fresh channels are seeded at record time, so a missing entry means
        // the watermark store was lost. Resuming from nonce 0 fails SAFE: a
        // regressed cumulative claim is rejected by the peer (no double
        // spend), but warn so the failure is diagnosable.
        this.warn(
          `rig: resuming channel ${record.channelId} with no local claim ` +
            `watermark (${map.watermarkPath}) — if this channel was claimed ` +
            'against before, the peer will reject the stale claims; remove ' +
            `its entry from ${map.mapPath} to open a fresh channel instead`
        );
      }

      // trackChannel rehydrates nonce/cumulative from the watermark store;
      // seeding peerChannels makes ensureChannel/openChannel reuse the id.
      cm.trackChannel(record.channelId, record.context);
      cm.peerChannels.set(record.peerId, record.channelId);

      // Persisted channel state omits the on-chain deposit — re-read it so
      // fee/balance accounting is right (EVM only; mirrors the daemon).
      if (
        record.context.chainType === 'evm' &&
        this.client.rehydrateChannelDeposit
      ) {
        try {
          const deposit = await this.client.rehydrateChannelDeposit(
            record.channelId,
            {
              chain: record.chain,
              tokenNetworkAddress: record.context.tokenNetworkAddress,
            }
          );
          if (deposit !== undefined) {
            map.touch(recordKey(record), {
              depositTotal: deposit.toString(),
            });
          }
        } catch (err) {
          this.warn(
            `rig: deposit re-read for resumed channel ${record.channelId} ` +
              `failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return record;
    }
    return undefined;
  }

  /** Record a freshly opened channel (+ seed its claim watermark at 0/0). */
  private recordOpenedChannel(
    map: ChannelMapStore,
    internals: ChannelInternals,
    identity: string,
    destination: string,
    channelId: string
  ): void {
    let peerId: string | undefined;
    for (const [peer, channel] of internals.channelManager?.peerChannels ??
      []) {
      if (channel === channelId) {
        peerId = peer;
        break;
      }
    }
    const negotiation =
      peerId !== undefined
        ? internals.peerNegotiations?.get(peerId)
        : undefined;
    if (peerId === undefined || !negotiation) {
      this.warn(
        `rig: opened channel ${channelId} but could not record the ` +
          'peer→channel mapping (client does not expose negotiation ' +
          'internals) — the NEXT invocation may open another channel'
      );
      return;
    }

    let depositTotal: bigint | undefined;
    try {
      depositTotal = this.client.getChannelDepositTotal?.(channelId);
    } catch {
      // deposit unknown — recorded without it; a later resume re-reads it
    }

    map.record({
      channelId,
      peerId,
      identity,
      destination,
      chain: negotiation.chain,
      tokenNetwork: negotiation.tokenNetwork ?? '',
      // Context mirrors the daemon's persistApexChannel shape — exactly what
      // trackChannel needs on resume.
      context: {
        chainType: negotiation.chainType,
        chainId:
          typeof negotiation.chainId === 'number' ? negotiation.chainId : 0,
        tokenNetworkAddress: negotiation.tokenNetwork ?? '',
        ...(negotiation.tokenAddress
          ? { tokenAddress: negotiation.tokenAddress }
          : {}),
        recipient: negotiation.settlementAddress,
      },
      ...(depositTotal !== undefined && depositTotal > 0n
        ? { depositTotal: depositTotal.toString() }
        : {}),
    });
    // Seed nonce 0 / cumulative 0 so a later resume can tell "never claimed
    // against" apart from "watermark lost" (which only fails claim-rejected).
    map.seedWatermark(channelId);
  }

  /** Release the identity lock and stop the embedded client (if we own it). */
  async stop(): Promise<void> {
    this.lock?.release();
    this.lock = undefined;
    this.readyPromise = undefined;
    this.clientReadyPromise = undefined;
    this.channelId = undefined;
    // Never stop a client that was never started (`ToonClient.stop()` throws
    // INVALID_STATE) — e.g. after a free `rig balance` read (#263).
    if (this.ownsClient && this.client.isStarted?.() !== false) {
      await this.client.stop();
    }
  }

  // ── Money lifecycle (#263) ──────────────────────────────────────────────────

  /**
   * Explicit `rig channel open`: the SAME resume-or-open path the lazy paid
   * writes use (guard → start → resume the recorded channel or open + record
   * a fresh one), surfaced with a receipt — plus an optional extra collateral
   * deposit on top of the open/resume.
   */
  async openChannelExplicit(opts?: {
    /** Extra collateral to deposit AFTER the open/resume (base units). */
    deposit?: bigint;
  }): Promise<ChannelOpenOutcome> {
    await this.start();
    const channelId = this.requireChannel();
    const identity = this.client.getPublicKey();
    const destination = this.channelAnchor ?? '';
    const record =
      this.channelMap && this.channelAnchor
        ? this.channelMap
            .listFor(identity, this.channelAnchor)
            .find((r) => r.channelId === channelId)
        : undefined;

    const outcome: ChannelOpenOutcome = {
      channelId,
      resumed: this.lastOpenResumed,
      destination,
      ...(record ? { chain: record.chain, peerId: record.peerId } : {}),
      ...(record?.depositTotal !== undefined
        ? { depositTotal: record.depositTotal }
        : {}),
    };

    if (opts?.deposit !== undefined && opts.deposit > 0n) {
      if (!this.client.depositToChannel) {
        throw new StandalonePublishError(
          'this client build does not support channel deposits ' +
            '(depositToChannel is unavailable)'
        );
      }
      const deposited = await this.client.depositToChannel(
        channelId,
        opts.deposit
      );
      outcome.depositAdded = opts.deposit.toString();
      outcome.depositTotal = deposited.depositTotal;
      if (deposited.txHash) outcome.depositTxHash = deposited.txHash;
      if (record) {
        this.channelMap?.touch(recordKey(record), {
          depositTotal: deposited.depositTotal,
        });
      }
    }
    return outcome;
  }

  /**
   * Adopt a RECORDED channel into the running client so on-chain close/
   * settle/deposit can act on it: `trackChannel` rehydrates the claim
   * watermark + withdraw timers from channels.json, `peerChannels` binds the
   * peer, and the on-chain client's context cache is re-seeded (it only
   * learns context at open time — a resumed channel would otherwise throw
   * "No on-chain context").
   */
  private adoptRecordedChannel(record: ChannelMapRecord): void {
    const internals = channelInternals(this.client);
    const cm = internals.channelManager;
    if (cm?.trackChannel && cm.peerChannels) {
      cm.trackChannel(record.channelId, record.context);
      cm.peerChannels.set(record.peerId, record.channelId);
    }
    const contextCache = internals.onChainChannelClient?.channelContext;
    if (contextCache && !contextCache.has(record.channelId)) {
      contextCache.set(record.channelId, {
        chain: record.chain,
        tokenNetworkAddress: record.context.tokenNetworkAddress,
        ...(record.context.tokenAddress
          ? { tokenAddress: record.context.tokenAddress }
          : {}),
      });
    }
  }

  /**
   * Close a recorded channel: starts the on-chain settlement challenge
   * window. The client persists `closedAt`/`settleableAt` into the claim
   * watermark store, which is exactly where `rig channel list`/`balance`
   * derive the closing/settleable/settled status from. Guard + client start,
   * but NEVER a channel open ({@link startClientOnly}).
   */
  async closeRecordedChannel(
    record: ChannelMapRecord
  ): Promise<ChannelCloseOutcome> {
    await this.startClientOnly();
    if (!this.client.closeChannel) {
      throw new StandalonePublishError(
        'this client build does not support closing channels ' +
          '(closeChannel is unavailable)'
      );
    }
    this.adoptRecordedChannel(record);
    const result = await this.client.closeChannel(record.channelId);
    this.channelMap?.touch(recordKey(record));
    return result;
  }

  /**
   * Settle a recorded channel after its challenge window — releases the
   * remaining collateral. The client enforces the `now >= settleableAt` time
   * guard BEFORE spending gas (a too-early call throws its retryable
   * SettleTooEarlyError) and persists `settledAt` into the watermark store.
   */
  async settleRecordedChannel(
    record: ChannelMapRecord
  ): Promise<ChannelSettleOutcome> {
    await this.startClientOnly();
    if (!this.client.settleChannel) {
      throw new StandalonePublishError(
        'this client build does not support settling channels ' +
          '(settleChannel is unavailable)'
      );
    }
    this.adoptRecordedChannel(record);
    const result = await this.client.settleChannel(record.channelId);
    this.channelMap?.touch(recordKey(record));
    return result;
  }

  /**
   * On-chain wallet balances for the embedded identity — a FREE read on the
   * UNSTARTED client (no nonce guard, no uplink, no channel): the client
   * reads the settlement chain its channels actually use (its EVM key is
   * derived at construction; Solana/Mina keys only exist after a start, so
   * those chains appear once a start-requiring command ran — same
   * best-effort contract as the client's own getBalances).
   */
  async readWalletBalances(): Promise<WalletBalanceInfo[]> {
    if (!this.client.getBalances) return [];
    return await this.client.getBalances();
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
