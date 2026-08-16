/**
 * Rolling-swap RFQ sender (toon-client#585; rolling-swap spec §2.2, §10.3
 * step 2) — the client half of the session-negotiation round trip whose maker
 * half landed in toon-protocol/swap#135 (`packages/swap/src/rolling-rfq.ts`).
 *
 * ## Why this module exists
 *
 * Before it, a `streamNonce` minted by {@link generateStreamNonce} had to be
 * registered with the maker **out of band** — `SwapNodeInstance
 * .registerRollingSession`, an in-process method the CLI-run maker container
 * never calls. So the rolling protocol was unreachable from BOTH ends: the
 * maker could not hear a session onto the wire (swap#135 fixed that), and the
 * client could not put one there (this module).
 *
 * ## The wire contract
 *
 * | phase | envelope | carried in |
 * |---|---|---|
 * | RFQ request | paid ILP write, **zero/absent** `executionCondition`, NIP-59 gift wrap (rumor kind:20033 → seal → kind:1059), TOON-encoded in `data` | `sendSwapPacket` |
 * | RFQ response | gift wrap (rumor kind:20034) sealed back to the request's seal-layer pubkey | the leg-A FULFILL `data`, base64 of the wrap's JSON |
 *
 * The request rides the SAME local-delivery seam as a legacy swap request and
 * is distinguishable **only by its inner rumor kind, after decryption** — which
 * is exactly why capability discovery is a probe (spec §10.3 step 2: "A maker
 * without it is legacy; `toon_swap` keeps the legacy path until the RFQ
 * succeeds") and not an announce flag. swap#135 deliberately added no flag.
 *
 * `senderIlpAddress` is load-bearing and has **no fallback**: the maker uses
 * `RollingSession.senderIlpAddress` verbatim as the destination of every
 * leg-B PREPARE in the session (`swap/packages/swap/src/rolling-engine.ts`),
 * so it must be the address this client's BTP `jobHandler` actually receives
 * on or leg B never arrives.
 *
 * ## Failure policy — total, typed, and never thrown
 *
 * {@link sendRollingRfq} NEVER throws and NEVER returns a partially-usable
 * result. Every outcome is either a complete, nonce-matched quote or a typed
 * failure. A maker without RFQ intake answers a kind:20033 with a
 * legacy-handler reject, which is precisely the negative signal this returns
 * as {@link RollingRfqFailure.reason} `'rejected'`.
 *
 * What the CALLER does with a failure is the caller's policy, and it changed
 * in toon-client#595: the daemon's default is now to fail the swap with that
 * reason named (ADR 0003 — the rolling swap is the only swap) rather than to
 * downgrade to legacy behind the caller's back. This module is unchanged by
 * that: it still reports, and never decides.
 */

import type { SwapPair } from '@toon-protocol/core';
import type { NostrEvent, UnsignedEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unwrapSwapPacket, wrapSwapPacketToToon } from '@toon-protocol/sdk';

import { fromBase64, decodeUtf8 } from '../utils/binary.js';
import {
  ROLLING_PROTOCOL,
  isValidStreamNonce,
  generateStreamNonce,
} from './rolling-protocol.js';

/** Inner rumor kind of an RFQ request (spec §2.2). */
export const ROLLING_RFQ_REQUEST_KIND = 20033;
/** Inner rumor kind of an RFQ response (spec §2.2). */
export const ROLLING_RFQ_RESPONSE_KIND = 20034;

/** One side of the pair, exactly the six fields the maker matches on. */
export interface RollingRfqAsset {
  assetCode: string;
  assetScale: number;
  chain: string;
}

/**
 * The `content` of the kind:20033 rumor, UTF-8 JSON. Field-for-field the
 * maker's `RollingRfqRequest` (swap#135) — the maker rejects rather than
 * falls through on any shape violation, so this is a hard contract.
 */
export interface RollingRfqRequest {
  proto: typeof ROLLING_PROTOCOL;
  type: 'rfq';
  /** Session id — 16 bytes, lowercase hex (spec §2.1). */
  streamNonce: string;
  /** Priced pair; must match an advertised `swapPair` on ALL SIX fields. */
  pair: { from: RollingRfqAsset; to: RollingRfqAsset };
  /** Sender's payout address on `pair.to.chain` — the leg-B claim recipient. */
  chainRecipient: string;
  /** ILP address the maker sends this session's leg-B PREPAREs to. */
  senderIlpAddress: string;
  /** Optional total notional hint, source-asset micro-units (decimal string). */
  sizeHint?: string;
}

/** The `content` of the kind:20034 rumor, UTF-8 JSON. */
export interface RollingRfqResponse {
  proto: typeof ROLLING_PROTOCOL;
  type: 'quote';
  streamNonce: string;
  /** `R₀` — target whole-units per source whole-unit, decimal string. */
  rate: string;
  /** Unix-ms tick time of the maker's rate source for `rate`. */
  rateTimestamp: number;
  /**
   * Unix-ms after which the QUOTE lapses. NOT the session lifetime: the maker
   * keeps the session for its own store TTL (default 1h) and reprices every
   * fill at a fresh `R_i`, so a lapsed quote is a reason to re-RFQ for a fresh
   * `R₀` basis, never a reason to tear down a live stream.
   */
  expiresAt: number;
  /** Maker's advertised two-sided spread, basis points. */
  spreadBps?: number;
  /** Maker's own freshness bound on its rate source, ms (spec §4). */
  maxRateAge?: number;
  /** Per-packet bounds, source-asset micro-units (decimal strings). */
  minAmount?: string;
  maxAmount?: string;
  /**
   * The maker's on-chain signer for `pair.to.chain`. Lets the sender arm its
   * R5 leg-B verification BEFORE the first fill instead of trusting the
   * `swapSignerAddress` echoed on the first advance.
   */
  swapSignerAddress?: string;
}

/** Why a rolling probe did not yield a usable session. */
export type RollingRfqFailureReason =
  /** The probe threw locally and never reached the maker. */
  | 'send-failed'
  /**
   * The maker REJECTed the probe. This is the ordinary "legacy maker" signal:
   * a maker without RFQ intake hands a kind:20033 to its legacy handler,
   * which cannot read it.
   */
  | 'rejected'
  /** FULFILL carried no `data`, or `data` was not a decodable gift wrap. */
  | 'no-response'
  /** The wrap opened but is not a well-formed kind:20034 rolling quote. */
  | 'not-a-quote'
  /** A quote for a DIFFERENT `streamNonce` — never usable, never trusted. */
  | 'nonce-mismatch';

export interface RollingRfqSession {
  ok: true;
  /** The session id every fill of this stream references. */
  streamNonce: string;
  /**
   * The key the request was SEALED with. The maker sealed its answer back to
   * the pubkey recovered from that seal layer, so this is also the key any
   * further gift-wrapped traffic for the session must use.
   */
  senderSecretKey: Uint8Array;
  /** The maker's quote — `R₀` and the guards to arm from it. */
  quote: RollingRfqResponse;
}

export interface RollingRfqFailure {
  ok: false;
  reason: RollingRfqFailureReason;
  /**
   * Whether a packet actually left this client (and was therefore paid for).
   * `false` only when the RFQ could not be BUILT — a malformed pubkey, an
   * empty `senderIlpAddress` — which is a local error, not a statement about
   * the maker's capability.
   */
  sent: boolean;
  /** The maker's ILP reject code, when there was one (F01/F06/T03/T99/…). */
  code?: string;
  /** Human-readable diagnosis. Always present. */
  message: string;
}

export type RollingRfqOutcome = RollingRfqSession | RollingRfqFailure;

/**
 * The one method this module needs from a `ToonClient` — narrowed so a caller
 * (and a test) can supply anything that speaks the paid-write seam.
 */
export interface RollingRfqSender {
  sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    timeout?: number;
    executionCondition?: Uint8Array;
    expiresAt?: Date;
  }): Promise<{
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
  }>;
}

export interface SendRollingRfqParams {
  client: RollingRfqSender;
  /** The maker's ILP address — the same destination the fills go to. */
  destination: string;
  /** The maker's kind:10032 Nostr pubkey (the gift-wrap recipient). */
  swapPubkey: string;
  /** The pair to price; only the six matched fields are put on the wire. */
  pair: Pick<SwapPair, 'from' | 'to'>;
  /** Sender's payout address on `pair.to.chain`. */
  chainRecipient: string;
  /**
   * The ILP address this client receives leg-B PREPAREs on. Load-bearing with
   * no fallback — see the module docblock.
   */
  senderIlpAddress: string;
  /** Amount paid for the probe packet itself, source micro-units. */
  amount: bigint;
  /** Optional total-notional hint, source micro-units. */
  sizeHint?: bigint;
  /** Override the minted session id (an out-of-band pre-registered one). */
  streamNonce?: string;
  /** Override the sealing key (defaults to a fresh per-session key). */
  senderSecretKey?: Uint8Array;
  /** Per-packet send timeout, ms. */
  timeoutMs?: number;
  now?: () => number;
}

function optionalString(
  rec: Record<string, unknown>,
  key: string
): string | undefined {
  const v = rec[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function optionalFiniteNumber(
  rec: Record<string, unknown>,
  key: string
): number | undefined {
  const v = rec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Strip a `SwapPair` leg down to the six fields the maker matches on. */
function rfqAsset(asset: {
  assetCode: string;
  assetScale: number;
  chain: string;
}): RollingRfqAsset {
  return {
    assetCode: asset.assetCode,
    assetScale: asset.assetScale,
    chain: asset.chain,
  };
}

/**
 * Build the kind:20033 rumor `content` (spec §2.2). Exported so the exact
 * bytes the maker parses are assertable without sending a packet.
 *
 * @throws {Error} on an invalid `streamNonce` or an empty `senderIlpAddress` —
 *   both are unconditional maker-side rejects, so failing here turns a
 *   guaranteed-wasted paid packet into an actionable local error.
 */
export function buildRollingRfqRequest(params: {
  streamNonce: string;
  pair: Pick<SwapPair, 'from' | 'to'>;
  chainRecipient: string;
  senderIlpAddress: string;
  sizeHint?: bigint;
}): RollingRfqRequest {
  if (!isValidStreamNonce(params.streamNonce)) {
    throw new Error(
      `streamNonce must be 16 bytes, lowercase hex — got "${params.streamNonce}"`
    );
  }
  if (params.chainRecipient.length === 0) {
    throw new Error('chainRecipient is required on a rolling RFQ');
  }
  if (params.senderIlpAddress.length === 0) {
    throw new Error(
      'senderIlpAddress is required on a rolling RFQ — the maker addresses ' +
        'every leg-B PREPARE of the session to it and has no fallback'
    );
  }
  return {
    proto: ROLLING_PROTOCOL,
    type: 'rfq',
    streamNonce: params.streamNonce,
    pair: {
      from: rfqAsset(params.pair.from),
      to: rfqAsset(params.pair.to),
    },
    chainRecipient: params.chainRecipient,
    senderIlpAddress: params.senderIlpAddress,
    ...(params.sizeHint !== undefined
      ? { sizeHint: params.sizeHint.toString() }
      : {}),
  };
}

/**
 * Gift-wrap an RFQ request and TOON-encode it as the `data` of a
 * zero-condition paid write — byte-identical in construction to the way the
 * sdk's `streamSwap` builds a legacy swap packet (`wrapSwapPacketToToon`,
 * then the PREPARE's own base64 `data` decoded back to bytes), which is what
 * makes it land on the maker's legacy local-delivery seam at all.
 */
export function encodeRollingRfqPacket(params: {
  request: RollingRfqRequest;
  senderSecretKey: Uint8Array;
  swapPubkey: string;
  destination: string;
  amount: bigint;
  now?: () => number;
}): Uint8Array {
  const now = params.now ?? Date.now;
  const rumor = {
    kind: ROLLING_RFQ_REQUEST_KIND,
    content: JSON.stringify(params.request),
    tags: [],
    created_at: Math.floor(now() / 1000),
    pubkey: getPublicKey(params.senderSecretKey),
  } as unknown as UnsignedEvent;
  const wrapped = wrapSwapPacketToToon({
    rumor,
    senderSecretKey: params.senderSecretKey,
    recipientPubkey: params.swapPubkey,
    destination: params.destination,
    amount: params.amount,
  });
  return fromBase64(wrapped.ilpPrepare.data);
}

/**
 * Parse a kind:20034 rumor's `content`. Returns `null` — never throws, never
 * half-parses — on anything that is not a complete rolling quote, so an
 * unrecognized answer degrades to "legacy maker" rather than to a session
 * armed from missing fields.
 */
export function parseRollingRfqResponse(
  content: string
): RollingRfqResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['proto'] !== ROLLING_PROTOCOL || rec['type'] !== 'quote') return null;

  const streamNonce = rec['streamNonce'];
  if (typeof streamNonce !== 'string' || !isValidStreamNonce(streamNonce)) {
    return null;
  }
  const rate = rec['rate'];
  if (typeof rate !== 'string' || rate.length === 0) return null;
  const rateTimestamp = optionalFiniteNumber(rec, 'rateTimestamp');
  if (rateTimestamp === undefined) return null;
  const expiresAt = optionalFiniteNumber(rec, 'expiresAt');
  if (expiresAt === undefined) return null;

  const spreadBps = optionalFiniteNumber(rec, 'spreadBps');
  const maxRateAge = optionalFiniteNumber(rec, 'maxRateAge');
  const minAmount = optionalString(rec, 'minAmount');
  const maxAmount = optionalString(rec, 'maxAmount');
  const swapSignerAddress = optionalString(rec, 'swapSignerAddress');

  return {
    proto: ROLLING_PROTOCOL,
    type: 'quote',
    streamNonce,
    rate,
    rateTimestamp,
    expiresAt,
    ...(spreadBps !== undefined ? { spreadBps } : {}),
    ...(maxRateAge !== undefined ? { maxRateAge } : {}),
    ...(minAmount !== undefined ? { minAmount } : {}),
    ...(maxAmount !== undefined ? { maxAmount } : {}),
    ...(swapSignerAddress !== undefined ? { swapSignerAddress } : {}),
  };
}

/**
 * Open the FULFILL `data` of an RFQ probe: base64 → JSON kind:1059 gift wrap
 * → NIP-59 unwrap with the sealing key → kind:20034 rumor → quote.
 *
 * Returns `null` for every unreadable outcome (not base64, not JSON, not a
 * wrap addressed to us, not kind:20034, malformed content) — the caller reads
 * that as "this maker is legacy" and falls back.
 */
export function decodeRollingRfqQuote(
  dataB64: string,
  senderSecretKey: Uint8Array
): RollingRfqResponse | null {
  let giftWrap: NostrEvent;
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(fromBase64(dataB64)));
    if (typeof parsed !== 'object' || parsed === null) return null;
    giftWrap = parsed as NostrEvent;
  } catch {
    return null;
  }
  let rumor: UnsignedEvent;
  try {
    rumor = unwrapSwapPacket({
      giftWrap,
      recipientSecretKey: senderSecretKey,
    }).rumor;
  } catch {
    return null;
  }
  if (rumor.kind !== ROLLING_RFQ_RESPONSE_KIND) return null;
  return parseRollingRfqResponse(
    typeof rumor.content === 'string' ? rumor.content : ''
  );
}

/**
 * The maker's reject `data` is base64 JSON `{ reason }` (swap#135's
 * `buildRollingReject`). Best-effort only: absent or unreadable, the ILP
 * code and message alone are the diagnosis.
 */
function rejectReason(dataB64: string | undefined): string | undefined {
  if (dataB64 === undefined || dataB64.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(fromBase64(dataB64)));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return optionalString(parsed as Record<string, unknown>, 'reason');
  } catch {
    return undefined;
  }
}

/**
 * Probe a maker for rolling capability and, on success, establish the session
 * (spec §10.3 step 2). One paid, zero-condition write out; a quote or a typed
 * failure back.
 *
 * Never throws: every failure — a local send throw, a maker reject, an
 * undecodable or mismatched answer — comes back as {@link RollingRfqFailure},
 * with a `reason` the caller can name in its own diagnosis (toon-client#595)
 * or use to select a fallback.
 */
export async function sendRollingRfq(
  params: SendRollingRfqParams
): Promise<RollingRfqOutcome> {
  const streamNonce = params.streamNonce ?? generateStreamNonce();
  const senderSecretKey = params.senderSecretKey ?? generateSecretKey();

  let toonData: Uint8Array;
  try {
    const request = buildRollingRfqRequest({
      streamNonce,
      pair: params.pair,
      chainRecipient: params.chainRecipient,
      senderIlpAddress: params.senderIlpAddress,
      ...(params.sizeHint !== undefined ? { sizeHint: params.sizeHint } : {}),
    });
    toonData = encodeRollingRfqPacket({
      request,
      senderSecretKey,
      swapPubkey: params.swapPubkey,
      destination: params.destination,
      amount: params.amount,
      ...(params.now ? { now: params.now } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'send-failed',
      sent: false,
      message: `could not build the RFQ request: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let result: {
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
  };
  try {
    result = await params.client.sendSwapPacket({
      destination: params.destination,
      amount: params.amount,
      toonData,
      ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
      // NO executionCondition: the RFQ rides the zero-condition
      // local-delivery seam, the same one a legacy swap request rides. A
      // sender-chosen condition here is an unconditional maker-side F99.
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'send-failed',
      sent: true,
      message: `RFQ probe never reached the maker: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!result.accepted) {
    const reason = rejectReason(result.data);
    return {
      ok: false,
      reason: 'rejected',
      sent: true,
      ...(result.code !== undefined ? { code: result.code } : {}),
      message:
        `maker rejected the RFQ probe` +
        (result.code !== undefined ? ` (${result.code})` : '') +
        (reason !== undefined ? ` reason=${reason}` : '') +
        (result.message !== undefined ? `: ${result.message}` : ''),
    };
  }

  const data = result.data;
  if (data === undefined || data.length === 0) {
    return {
      ok: false,
      reason: 'no-response',
      sent: true,
      message: 'maker FULFILLed the RFQ probe but returned no response data',
    };
  }

  const quote = decodeRollingRfqQuote(data, senderSecretKey);
  if (!quote) {
    return {
      ok: false,
      reason: 'not-a-quote',
      sent: true,
      message:
        'maker FULFILLed the RFQ probe but its response is not a kind:20034 ' +
        'rolling quote — treating this maker as legacy',
    };
  }
  if (quote.streamNonce !== streamNonce) {
    return {
      ok: false,
      reason: 'nonce-mismatch',
      sent: true,
      message:
        `maker quoted streamNonce "${quote.streamNonce}" for a request that ` +
        `minted "${streamNonce}" — the session it registered is not ours`,
    };
  }

  return { ok: true, streamNonce, senderSecretKey, quote };
}
