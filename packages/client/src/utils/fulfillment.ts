/**
 * The sender's end-to-end delivery check (connector ADR 0069).
 *
 * Until issue #1269 a sender minted a random preimage, put `sha256(preimage)`
 * on the PREPARE as its `executionCondition`, and checked a returned
 * fulfilment by hashing it back to that value. ADR 0069 removes the condition
 * from the wire entirely: no hop carries one, no hop reads one, and no hop
 * verifies one. What survives is the check that was always the only one worth
 * anything — the SENDER comparing what came back against the fulfilment it can
 * derive itself.
 *
 * That derivation is `deriveFulfillment(sharedSecret)` in `wire/giftwrap.ts`
 * (ADR 0019): the terminating connector recovers the same secret by opening
 * the gift wrap and derives the same 32 bytes, so an honest FULFILL carries
 * exactly them. No intermediate hop can, because no intermediate hop can open
 * the wrap.
 *
 * There is no hashing left in either direction here, and deliberately no
 * `condition` vocabulary: a comparison of two locally-known 32-byte values is
 * the whole relation.
 *
 * Isomorphic: no Buffer, no node:crypto.
 */

/** Exact byte length of an ILP fulfilment preimage. */
export const FULFILLMENT_LENGTH = 32;

/**
 * True iff `returned` is exactly the 32 bytes the sender expected.
 *
 * Fail-closed: an absent, short or long fulfilment never matches. Plain
 * comparison is fine — both operands are values the sender already holds, and
 * a forger who could produce the expected bytes would already have the secret
 * that derives them, so there is no secret here for a timing side channel to
 * leak.
 */
export function fulfillmentMatches(
  returned: Uint8Array | undefined,
  expected: Uint8Array
): boolean {
  if (returned === undefined || returned.length !== FULFILLMENT_LENGTH) {
    return false;
  }
  if (expected.length !== FULFILLMENT_LENGTH) return false;
  for (let i = 0; i < FULFILLMENT_LENGTH; i++) {
    if (returned[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Validate a caller-supplied expected fulfilment before a packet goes out.
 *
 * @throws {Error} when it is not exactly 32 bytes — a wrong-length value can
 *   never match a real FULFILL, so every delivery would be counted failed and
 *   every paid packet thrown away. Failing here says why.
 */
export function assertValidFulfillment(fulfillment: Uint8Array): void {
  if (fulfillment.length !== FULFILLMENT_LENGTH) {
    throw new Error(
      `an expected fulfillment must be exactly ${FULFILLMENT_LENGTH} bytes, got ${fulfillment.length}`
    );
  }
}
