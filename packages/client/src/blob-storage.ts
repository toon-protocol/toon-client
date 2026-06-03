/**
 * Client-side helper for kind:5094 Arweave blob storage DVM requests.
 *
 * This composes the three steps a caller previously had to wire by hand:
 *   1. Build the kind:5094 event via `buildBlobStorageRequest()` (@toon-protocol/core).
 *   2. Publish it to the DVM destination over ILP via `ToonClient.publishEvent()`
 *      (reusing the existing claim / channel plumbing).
 *   3. Decode the FULFILL `data` field into the Arweave transaction ID.
 *
 * ## FULFILL data contract
 *
 * For a successful single-packet (non-chunked) blob upload, the DVM provider
 * returns the Arweave transaction ID as a **UTF-8 string, base64-encoded** in
 * the ILP FULFILL `data` field (the connector validates that FULFILL data is
 * base64). An Arweave tx ID is a 43-character base64url string (32 raw bytes).
 *
 * So the decode is:
 *   `txId = utf8(base64decode(result.data))`
 *
 * See `packages/sdk/src/arweave/arweave-dvm-handler.ts` for the server side and
 * `packages/client/tests/e2e/docker-arweave-dvm-e2e.test.ts` for the reference
 * end-to-end flow this helper mirrors.
 *
 * Chunked uploads (multi-packet, via `uploadId` / `chunkIndex` / `totalChunks`
 * params) are intentionally out of scope for this single-packet helper — the
 * provider returns `ack:<n>` for intermediate chunks and the tx ID only on the
 * final chunk. Callers needing chunking should drive `publishEvent()` directly
 * (see the chunked case in the reference E2E test). Tracked as a follow-up.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { buildBlobStorageRequest } from '@toon-protocol/core';
import { fromBase64, decodeUtf8 } from './utils/binary.js';
import type { ToonClient } from './ToonClient.js';
import type { SignedBalanceProof } from './types.js';

/** Arweave tx IDs are base64url-encoded 32-byte values (43 chars, no padding). */
const ARWEAVE_TX_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;

/**
 * Parameters for {@link requestBlobStorage}.
 */
export interface RequestBlobStorageParams {
  /** The raw blob data to store on Arweave. */
  blobData: Uint8Array;

  /**
   * MIME type of the blob. Defaults to `'application/octet-stream'`
   * (matching `buildBlobStorageRequest`).
   */
  contentType?: string;

  /**
   * Bid amount in USDC micro-units, as a string (declared in the event's
   * `bid` tag). Defaults to the stringified `ilpAmount` when omitted.
   *
   * At least one of `bid` / `ilpAmount` should be provided so the declared
   * bid and the paid ILP amount agree.
   */
  bid?: string;

  /**
   * ILP destination address of the DVM that performs the upload
   * (e.g. `'g.toon.peer1'`). Falls back to the client's configured
   * `destinationAddress` when omitted.
   */
  destination?: string;

  /**
   * Pre-signed balance proof claim for this packet. When omitted, the
   * client's channel manager auto-opens a channel and auto-signs a claim
   * (same lazy-channel behavior as `publishEvent`).
   */
  claim?: SignedBalanceProof;

  /**
   * Explicit ILP payment amount (bigint micro-units). When omitted,
   * `publishEvent` computes it from the encoded event size. When `bid`
   * is omitted, this value is stringified to populate the event's bid tag.
   */
  ilpAmount?: bigint;
}

/**
 * Typed result of {@link requestBlobStorage}.
 */
export interface RequestBlobStorageResult {
  /** Whether the upload succeeded and a tx ID was decoded. */
  success: boolean;

  /** The Arweave transaction ID (43-char base64url) when `success` is true. */
  txId?: string;

  /** The id of the kind:5094 event that was published. */
  eventId?: string;

  /** Error message when `success` is false. */
  error?: string;
}

/**
 * Requests permanent Arweave blob storage from a DVM in a single ILP packet.
 *
 * Mirrors the single-packet flow in
 * `packages/client/tests/e2e/docker-arweave-dvm-e2e.test.ts`: builds a signed
 * kind:5094 event, publishes it through the supplied {@link ToonClient}
 * (reusing its claim/channel plumbing), and decodes the FULFILL `data` field
 * into an Arweave transaction ID.
 *
 * @param client - A started `ToonClient` (call `client.start()` first).
 * @param secretKey - The Nostr secret key used to sign the kind:5094 event.
 * @param params - Blob, content type, bid, destination, and payment options.
 * @returns `{ success, txId?, eventId?, error? }`.
 */
export async function requestBlobStorage(
  client: ToonClient,
  secretKey: Uint8Array,
  params: RequestBlobStorageParams
): Promise<RequestBlobStorageResult> {
  const bid =
    params.bid ??
    (params.ilpAmount !== undefined ? String(params.ilpAmount) : undefined);

  if (bid === undefined || bid === '') {
    return {
      success: false,
      error: 'requestBlobStorage requires a bid (or ilpAmount to derive it)',
    };
  }

  // buildBlobStorageRequest expects a Node Buffer (it calls .toString('base64')).
  // ToonClient surfaces Uint8Array for browser-compat, so normalize here.
  const blobBuffer = Buffer.from(
    params.blobData.buffer,
    params.blobData.byteOffset,
    params.blobData.byteLength
  );

  let event: NostrEvent;
  try {
    event = buildBlobStorageRequest(
      {
        blobData: blobBuffer,
        contentType: params.contentType,
        bid,
      },
      secretKey
    );
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const result = await client.publishEvent(event, {
    destination: params.destination,
    claim: params.claim,
    ilpAmount: params.ilpAmount,
  });

  if (!result.success) {
    return {
      success: false,
      eventId: result.eventId ?? event.id,
      error: result.error ?? 'Blob storage request rejected',
    };
  }

  if (!result.data) {
    return {
      success: false,
      eventId: event.id,
      error: 'FULFILL contained no data; expected base64-encoded Arweave tx ID',
    };
  }

  // FULFILL data contract: base64(utf8(arweaveTxId)).
  const txId = decodeUtf8(fromBase64(result.data));

  if (!ARWEAVE_TX_ID_REGEX.test(txId)) {
    return {
      success: false,
      eventId: event.id,
      error: `Decoded FULFILL data is not a valid Arweave tx ID: "${txId}"`,
    };
  }

  return {
    success: true,
    txId,
    eventId: event.id,
  };
}
