/**
 * Is a channel this client already holds still held with the node that
 * terminates its destination TODAY?
 *
 * Every persisted channel record in this codebase is keyed by a ROUTE — the
 * daemon's peer→channel bindings by `peer|chain|tokenNetwork`, its apex store
 * by `destination|chain`, rig's map by `identity|destination|chain|tokenNetwork`
 * — and none of those key fields names the counterparty. An ILP name can change
 * hands: the devnet apex `g.toon` was retired 2026-08-14 and other nodes took
 * over the names under it. Every key field kept matching, so the client resumed
 * a channel opened against the retired node and signed balance proofs against
 * it. The node now answering holds no record of that channel and refuses every
 * packet with `F01 - claim rejected: names a channel this connector has no
 * record of` — until the record was deleted by hand.
 *
 * The records already carry the counterparty they were opened against
 * (`recipient`), so the check is available wherever a record is about to be
 * reused: compare it against the settlement address the destination announces
 * now. This module is the ONE definition of that comparison, shared by the
 * daemon's two stores (and mirroring rig's own copy in
 * `packages/rig/src/standalone/channel-map.ts`, which cannot import it — the
 * standalone repo publishes that package separately).
 */

/**
 * Compare two settlement addresses. EVM addresses travel in mixed checksum
 * case (an announce may say `0xF29f…` where the record says `0xf29f…`) and are
 * compared case-insensitively; anything else (base58 Solana, base58check Mina)
 * is case-SIGNIFICANT and compared verbatim.
 */
export function sameSettlementAddress(a: string, b: string): boolean {
  const normalize = (v: string): string =>
    /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v;
  return normalize(a) === normalize(b);
}

/**
 * The three answers a stored record can give about its counterparty:
 *
 * - `'match'` — same counterparty, safe to reuse.
 * - `'mismatch'` — the counterparty rotated: the record must be retired and the
 *   channel re-resolved against the address announced now.
 * - `'unrecorded'` — nothing to compare (a record written before this field was
 *   validated, or a peer that announced no settlement address). Reuse is
 *   ALLOWED — an unverifiable record is not a stale one, and refusing it would
 *   open (and fund) a second on-chain channel for no evidence at all — and the
 *   caller should back-fill the record with what the announce says so the NEXT
 *   run is verifiable.
 */
export type CounterpartyVerdict = 'match' | 'mismatch' | 'unrecorded';

/**
 * Does a recorded channel still belong to the counterparty its destination
 * announces TODAY? See {@link CounterpartyVerdict} for what each answer
 * obliges the caller to do.
 *
 * @param record - the stored channel context, of any shape that carries the
 *   `recipient` it was opened against.
 * @param announced - the settlement address the destination advertises now
 *   (a negotiation's `settlementAddress`).
 */
export function counterpartyMatch(
  record: { recipient?: string } | undefined,
  announced: string | undefined
): CounterpartyVerdict {
  const recorded = record?.recipient;
  if (!recorded || !announced) return 'unrecorded';
  return sameSettlementAddress(recorded, announced) ? 'match' : 'mismatch';
}
