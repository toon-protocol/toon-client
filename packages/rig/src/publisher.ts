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
  /**
   * Path the blob was reached by in the tree (#368), if known. Its extension
   * derives the `Content-Type` sent in the store write's `output` tag so a
   * gateway serves the blob as its real media type instead of
   * `application/octet-stream`. Absent (or a non-blob object) → octet-stream.
   */
  path?: string;
}

/**
 * A NON-git blob queued for upload to Arweave with an explicit `Content-Type`
 * (#368): the ar.io path manifest that turns a pushed repo into a permaweb
 * site. Unlike {@link GitObjectUpload} it carries no `Git-SHA`/`Git-Type`
 * tags, so the store stores the raw bytes verbatim (no git-envelope
 * re-derivation) — exactly what a manifest needs.
 */
export interface BlobUpload {
  /** Raw bytes to store. */
  body: Buffer;
  /** MIME type sent in the store write's `output` tag. */
  contentType: string;
  /** Optional repository identifier for provenance (`Repo` tag). */
  repoId?: string;
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
  /**
   * Flat cost per published event (smallest asset unit). Implementations
   * already fold any per-packet route-price floor into this flat value, so
   * estimates using it match the claims actually signed.
   */
  eventFee: bigint;
  /**
   * FLAT minimum per upload claim (smallest asset unit): the store
   * destination's announced route price. The connector gates every paid
   * packet at the destination route's price — a balance-proof claim
   * advancing the channel by less is rejected (F06) — so each per-upload fee
   * is `max(bytes × uploadFeePerByte, minUploadFee)`. Absent: no floor
   * (pre-floor behavior, e.g. when the peer announces no capability prices).
   */
  minUploadFee?: bigint;
}

/**
 * Per-upload fee: `bytes × ratePerByte`, floored at `minFee` (the
 * destination's announced flat route price — see
 * {@link FeeRates.minUploadFee}). The single shared implementation keeps
 * every estimate site equal to what the publisher actually claims.
 */
export function flooredUploadFee(
  bytes: number,
  ratePerByte: bigint,
  minFee?: bigint
): bigint {
  const fee = BigInt(bytes) * ratePerByte;
  const min = minFee ?? 0n;
  return fee > min ? fee : min;
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
   * Upload one raw blob (no git envelope) with an explicit `Content-Type`;
   * paid. Used by `rig site` (#368) for the ar.io path manifest. Optional so
   * transports that only move git objects (and pre-#368 test fakes) need not
   * implement it — `rig site` requires it and errors clearly when absent.
   */
  uploadBlob?(upload: BlobUpload): Promise<UploadReceipt>;
  /**
   * Sign (implementation-held key) and pay-to-publish one event to the
   * given relay(s).
   */
  publishEvent(
    event: UnsignedEvent,
    relayUrls: string[]
  ): Promise<PublishReceipt>;
}
