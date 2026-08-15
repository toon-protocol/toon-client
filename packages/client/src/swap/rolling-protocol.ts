/**
 * Rolling-swap wire protocol (toon-client#573; rolling-swap epic toon-meta#145
 * §3). Mirrors the maker's dispatch contract byte-for-byte (toon-protocol/swap
 * `packages/swap/src/rolling-engine.ts`'s `RollingFillPayload`/
 * `RollingAdvancePayload`, `swap-node.ts`'s `handlePacket` dispatch matrix):
 *
 *   | executionCondition | payload        | maker's path                  |
 *   |---------------------|----------------|--------------------------------|
 *   | absent / all-zero    | gift-wrap TOON | LEGACY, byte-for-byte          |
 *   | non-zero (32B)        | THIS shape     | rolling engine (coupled legs) |
 *   | non-zero (32B)        | anything else  | reject F99 (toon-client#573)  |
 *
 * A sender-chosen condition on the legacy gift-wrap shape hits the last row —
 * `F99 "sender-chosen execution conditions are not supported on the legacy
 * swap path"` — which is exactly the bug this module's callers fix: the leg-A
 * FILL packet must self-identify with `proto: "rolling/1"` to reach the
 * maker's coupled-leg engine at all.
 */

import { randomBytes } from '@noble/hashes/utils.js';
import { toHex, encodeUtf8, decodeUtf8 } from '../utils/binary.js';

/** Protocol tag every rolling-swap wire payload carries (spec §10.3 step 2). */
export const ROLLING_PROTOCOL = 'rolling/1';

/** `streamNonce` — 16 random bytes, lowercase hex (spec §2.1). */
const STREAM_NONCE_REGEX = /^[0-9a-f]{32}$/;

/** True iff `streamNonce` is 16 bytes of lowercase hex (spec §2.1). */
export function isValidStreamNonce(streamNonce: string): boolean {
  return STREAM_NONCE_REGEX.test(streamNonce);
}

/**
 * Mint a fresh session id for a rolling-swap stream. There is no RFQ
 * (kind:20033/20034) session-negotiation transport yet (rolling-engine.ts's
 * own comment: "its transport story registers sessions" — a distinct,
 * unimplemented story), so the streamNonce this mints must be registered with
 * the maker OUT OF BAND before a fill referencing it can succeed
 * (`RollingSessionStore.register` / `SwapNodeInstance.registerRollingSession`
 * on the maker side).
 */
export function generateStreamNonce(): string {
  return toHex(randomBytes(16));
}

/** Leg-A fill payload: the ILP PREPARE `data` of a rolling fill packet. */
export interface RollingFillPayload {
  proto: typeof ROLLING_PROTOCOL;
  type: 'fill';
  /** Session id minted at RFQ — 16 bytes, lowercase hex. */
  streamNonce: string;
  /** Per-session fill sequence, starting at 1. Never reused (spec §4). */
  seq: number;
}

/**
 * Leg-B advance payload: the `data` of the maker→sender PREPARE carrying the
 * chain-B cumulative claim for one fill, priced at the maker's fresh quote.
 * The sender verifies this (spec R5: signature vs the advertised signer,
 * recipient equality, monotone nonce/cumulative) BEFORE revealing `P_i`.
 *
 * All bigints are decimal strings; `claim` is the base64 of the signed
 * balance-proof bytes (chain-specific format, same bytes the legacy FULFILL
 * metadata carried).
 */
export interface RollingAdvancePayload {
  proto: typeof ROLLING_PROTOCOL;
  type: 'advance';
  streamNonce: string;
  seq: number;
  /** Base64 signed chain-B balance proof. */
  claim: string;
  claimId?: string;
  channelId?: string;
  /** Balance-proof nonce (decimal string). */
  nonce?: string;
  /** Cumulative transferred amount on the chain-B channel (decimal string). */
  cumulativeAmount?: string;
  /** The session `chainRecipient` the proof was signed for. */
  recipient?: string;
  /** The maker's on-chain signer address for `pair.to.chain`. */
  swapSignerAddress?: string;
  /** Quote tape (spec §7.1): the rate actually applied to this fill. */
  rate: string;
  /** Unix-ms tick time of the maker's rate source for `rate`. */
  rateTimestamp: number;
  /** Leg-A source amount δ (decimal string). */
  sourceAmount: string;
  /** ⌊δ·R_i⌋ in chain-B units (decimal string) — this fill's claim delta. */
  targetAmount: string;
}

function isSafePositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

/**
 * Build the leg-A FILL packet `data` (spec §2.1). `seq` starts at 1 and must
 * never repeat within a session (spec §4).
 */
export function encodeRollingFillPayload(params: {
  streamNonce: string;
  seq: number;
}): Uint8Array {
  if (!isValidStreamNonce(params.streamNonce)) {
    throw new Error(
      `streamNonce must be 16 bytes, lowercase hex — got "${params.streamNonce}"`
    );
  }
  if (!isSafePositiveInt(params.seq)) {
    throw new Error(`seq must be a positive integer — got ${String(params.seq)}`);
  }
  const payload: RollingFillPayload = {
    proto: ROLLING_PROTOCOL,
    type: 'fill',
    streamNonce: params.streamNonce,
    seq: params.seq,
  };
  return encodeUtf8(JSON.stringify(payload));
}

/**
 * Parse an inbound leg-B PREPARE's `data` as a `RollingAdvancePayload`.
 * Returns `null` on anything that is not a well-formed rolling advance —
 * unrecognized/malformed traffic never throws here, letting the caller
 * (`handleRollingAdvance`) reject it as a whole rather than half-parse it.
 */
export function parseRollingAdvancePayload(
  data: Uint8Array
): RollingAdvancePayload | null {
  let text: string;
  try {
    text = decodeUtf8(data);
  } catch {
    return null;
  }
  if (!text.includes(ROLLING_PROTOCOL)) return null; // cheap pre-filter
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['proto'] !== ROLLING_PROTOCOL || rec['type'] !== 'advance') return null;

  const streamNonce = rec['streamNonce'];
  const seq = rec['seq'];
  const claim = rec['claim'];
  const rate = rec['rate'];
  const rateTimestamp = rec['rateTimestamp'];
  const sourceAmount = rec['sourceAmount'];
  const targetAmount = rec['targetAmount'];
  if (typeof streamNonce !== 'string' || !isValidStreamNonce(streamNonce)) {
    return null;
  }
  if (!isSafePositiveInt(seq)) return null;
  if (typeof claim !== 'string' || claim.length === 0) return null;
  if (typeof rate !== 'string' || rate.length === 0) return null;
  if (typeof rateTimestamp !== 'number' || !Number.isFinite(rateTimestamp)) {
    return null;
  }
  if (typeof sourceAmount !== 'string' || sourceAmount.length === 0) return null;
  if (typeof targetAmount !== 'string' || targetAmount.length === 0) return null;

  const optionalString = (key: string): string | undefined => {
    const v = rec[key];
    return typeof v === 'string' ? v : undefined;
  };
  const claimId = optionalString('claimId');
  const channelId = optionalString('channelId');
  const nonce = optionalString('nonce');
  const cumulativeAmount = optionalString('cumulativeAmount');
  const recipient = optionalString('recipient');
  const swapSignerAddress = optionalString('swapSignerAddress');

  return {
    proto: ROLLING_PROTOCOL,
    type: 'advance',
    streamNonce,
    seq,
    claim,
    ...(claimId !== undefined ? { claimId } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    ...(cumulativeAmount !== undefined ? { cumulativeAmount } : {}),
    ...(recipient !== undefined ? { recipient } : {}),
    ...(swapSignerAddress !== undefined ? { swapSignerAddress } : {}),
    rate,
    rateTimestamp,
    sourceAmount,
    targetAmount,
  };
}
