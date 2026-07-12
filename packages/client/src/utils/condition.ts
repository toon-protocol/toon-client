/**
 * Sender-chosen ILP execution conditions (toon-client#350, rolling-swap
 * prerequisite — toon-meta#145 §3 R1/R2).
 *
 * Contract (normative: connector `docs/local-delivery-fulfillment-contract.md`,
 * connector#309):
 *   - An ABSENT or ALL-ZERO (32×0x00) `executionCondition` is the LEGACY
 *     class: no hashlock, no verification — today's publish/upload writes.
 *   - Any NON-ZERO condition is SENDER-CHOSEN: the sender mints a fresh
 *     random 32-byte preimage `P` per packet, sets `C = sha256(P)` on the
 *     PREPARE, and on FULFILL MUST verify that the returned fulfillment
 *     hashes back to `C` — a missing/malformed/mismatching fulfillment is a
 *     hard failure (the packet is counted failed, never silently accepted).
 *
 * Isomorphic: @noble/hashes only (no Buffer, no node:crypto).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

/** Exact byte length of an ILP execution condition / fulfillment preimage. */
export const CONDITION_LENGTH = 32;

/** A freshly minted per-packet hashlock: `condition = sha256(preimage)`. */
export interface ExecutionConditionPair {
  /** Random 32-byte preimage `P` — reveal is the commit act; never reuse. */
  preimage: Uint8Array;
  /** `C = sha256(P)` — goes on the PREPARE's `executionCondition`. */
  condition: Uint8Array;
}

/**
 * Mint a fresh random 32-byte preimage and its sha256 condition (spec R1).
 * Mint one PER PACKET: a reused preimage lets any observer of packet *i*
 * fulfill packet *i+1* without the sender's consent.
 */
export function mintExecutionCondition(): ExecutionConditionPair {
  const preimage = randomBytes(CONDITION_LENGTH);
  return { preimage, condition: sha256(preimage) };
}

/**
 * True when `condition` selects the LEGACY (unverified) class: absent or
 * all-zero. The OER wire treats absent and 32×0x00 identically.
 */
export function isZeroCondition(condition: Uint8Array | undefined): boolean {
  if (condition === undefined) return true;
  for (const byte of condition) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * Validate a caller-supplied execution condition before it goes on the wire.
 * @throws {Error} When the condition is not exactly 32 bytes — the OER
 *   serializer would otherwise silently zero-fill it, downgrading a
 *   sender-chosen packet to the legacy unverified class.
 */
export function assertValidCondition(condition: Uint8Array): void {
  if (condition.length !== CONDITION_LENGTH) {
    throw new Error(
      `executionCondition must be exactly ${CONDITION_LENGTH} bytes, got ${condition.length}`
    );
  }
}

/**
 * True iff `fulfillment` is exactly 32 bytes and `sha256(fulfillment)`
 * equals `condition` — the sender-side FULFILL check (spec R6's mirror).
 * Fail-closed: an undefined/short/long fulfillment never matches.
 */
export function fulfillmentMatchesCondition(
  fulfillment: Uint8Array | undefined,
  condition: Uint8Array
): boolean {
  if (fulfillment === undefined || fulfillment.length !== CONDITION_LENGTH) {
    return false;
  }
  const digest = sha256(fulfillment);
  // Plain comparison is fine: both operands are locally computed/received
  // values on the sender; there is no secret to protect from timing here.
  for (let i = 0; i < CONDITION_LENGTH; i++) {
    if (digest[i] !== condition[i]) return false;
  }
  return true;
}
