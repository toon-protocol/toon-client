/**
 * Publisher — the paid-write seam between push planning (this package) and
 * the two transport implementations that follow it in epic #222:
 *
 *   1. daemon (#227): client-mcp ControlClient → toon-clientd loopback
 *      /git/* routes, backed by `ClientRunner.publish`/`uploadBlob` (the
 *      production paid-publish path — apex channel, signBalanceProof, flat
 *      per-event fee).
 *   2. standalone (#228): an embedded ToonClient constructed from a
 *      mnemonic, uploading git objects as kind:5094 store writes with
 *      Git-SHA/Git-Type/Repo tags (the proven seed-pipeline shape) and
 *      publishing NIP-34 events through the relay.
 *
 * The interface is deliberately minimal so both fit:
 *
 *  - `uploadGitObject` takes the raw object body (content only — no git
 *    envelope header; the store re-derives the SHA envelope from the
 *    Git-Type/Git-SHA tags) and returns the Arweave txId plus the fee paid.
 *  - `publishEvent` takes an UNSIGNED event template — signing stays with
 *    the implementation (the daemon-held key never leaves the daemon; the
 *    standalone impl signs with its own keypair). Relay URLs are plural
 *    from day one (forward-compat for parked #84/#92; size 1 today).
 *  - `getFeeRates` exposes what `planPush` needs for the pre-push estimate:
 *    a per-byte upload rate (seed pipeline bids bytes × rate) and a flat
 *    per-event publish fee (the daemon charges `apex.feePerEvent` regardless
 *    of event size).
 *
 * All fees are bigint in the smallest asset unit (matches `@toon-protocol/client`
 * channel math); HTTP transports serialize them as strings and convert at
 * the boundary.
 */

import type { UnsignedEvent } from './nip34-events.js';
import type { GitObjectType } from './objects.js';

/** A git object queued for upload to Arweave via the paid store path. */
export interface GitObjectUpload {
  /** Full 40-hex SHA-1 (over the git envelope — see `hashGitObject`). */
  sha: string;
  type: GitObjectType;
  /** Raw object body (content only, no `<type> <size>\0` header). */
  body: Buffer;
  /** Repository identifier — becomes the `Repo` tag on the store write. */
  repoId: string;
}

/** Receipt for one uploaded git object. */
export interface UploadReceipt {
  /** Arweave transaction ID the object is retrievable under. */
  txId: string;
  /** Fee paid for this upload, in the smallest asset unit. */
  feePaid: bigint;
}

/** Receipt for one published Nostr event. */
export interface PublishReceipt {
  /** Event ID as accepted by the relay(s). */
  eventId: string;
  /** Fee paid for this publish, in the smallest asset unit. */
  feePaid: bigint;
}

/** Fee rates used by `planPush` for the pre-push estimate. */
export interface FeeRates {
  /** Upload cost per body byte (smallest asset unit). */
  uploadFeePerByte: bigint;
  /** Flat cost per published event (smallest asset unit). */
  eventFee: bigint;
}

/**
 * Paid transport for `executePush` — implemented by the daemon route
 * handlers (#227) and the standalone embedded client (#228).
 *
 * Implementations must be safe to call sequentially (uploads are issued one
 * at a time in dependency-safe order) and should throw on any failure —
 * `executePush` does not retry; a crashed push is resumed by re-planning
 * (content-addressed uploads make the retry idempotent).
 */
export interface Publisher {
  /** Current fee rates for estimation (may be queried before every plan). */
  getFeeRates(): Promise<FeeRates>;
  /** Upload one git object body to Arweave; paid. */
  uploadGitObject(upload: GitObjectUpload): Promise<UploadReceipt>;
  /**
   * Sign (implementation-held key) and pay-to-publish one event to the
   * given relay(s).
   */
  publishEvent(
    event: UnsignedEvent,
    relayUrls: string[]
  ): Promise<PublishReceipt>;
}
