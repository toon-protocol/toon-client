/**
 * Per-packet preimage retention (toon-client#360, rolling-swap epic
 * toon-meta#145 — spec `docs/rolling-swap.md` §3 R1 / §3.2 leg-B reveal).
 *
 * `withSenderConditions` (toon-client#354) mints a fresh 32-byte preimage
 * `P_i` per fill packet, sets `C_i = sha256(P_i)` on the leg-A PREPARE, and —
 * before this module — DISCARDED `P_i`. Leg-B reveal (spec §3.2) is the commit
 * act: the sender reveals `P_i` only AFTER verifying the leg-B claim, so the
 * daemon must retain each `P_i` from mint time until the reveal step consumes
 * it. This is that retention seam.
 *
 * Keyed by `packetIndex` — the 0-indexed position in the swap's packet stream.
 * `packetIndex` is the one identifier shared between the send side (the wrapper
 * mints one condition per `sendSwapPacket` call, which `streamSwap` issues in
 * strictly increasing `packetIndex` order) and the receive side
 * (`AccumulatedClaim.packetIndex`), so it correlates a retained preimage to the
 * claim whose reveal will consume it.
 *
 * Reveal is single-use: {@link PreimageRetentionStore.take} removes the entry
 * so a preimage is never revealed twice (spec R1 — a reused preimage lets an
 * observer of packet *i* fulfill packet *i+1* without the sender's consent).
 *
 * Session-scoped and in-memory by design: a preimage is only meaningful within
 * the swap stream that minted it (a fresh stream mints fresh preimages), and a
 * preimage revealed after a crash would commit leg A for a leg-B claim the
 * restarted daemon can no longer verify. Durability lives on the *watermark*
 * (`ReceivedClaimStore`), not here.
 */

/** A retained per-packet hashlock secret awaiting (or past) its leg-B reveal. */
export interface RetainedPreimage {
  /** 0-indexed position in the swap's packet stream; the correlation key. */
  packetIndex: number;
  /** The 32-byte preimage `P_i` — revealed to commit leg A (spec R6). */
  preimage: Uint8Array;
  /** `C_i = sha256(P_i)` — what went on the leg-A PREPARE (kept for auditing). */
  condition: Uint8Array;
  /** Unix ms the preimage was minted/retained. */
  retainedAt: number;
}

/**
 * Retention interface for per-packet preimages, keyed by `packetIndex`. Mirrors
 * the sync surface of the daemon's other stores ({@link ReceivedClaimStore}).
 */
export interface PreimageRetentionStore {
  /** Retain `entry`, replacing any prior entry for the same `packetIndex`. */
  retain(entry: RetainedPreimage): void;
  /** Peek the retained preimage for `packetIndex` without consuming it. */
  get(packetIndex: number): RetainedPreimage | undefined;
  /** Consume (return AND remove) the preimage — single-use reveal (spec R1). */
  take(packetIndex: number): RetainedPreimage | undefined;
  /** Number of preimages still retained (awaiting reveal). */
  size(): number;
  /** Drop every retained preimage — call when the session ends. */
  clear(): void;
}

/** Defensive copy so a retained preimage cannot be mutated after the fact. */
function copy(entry: RetainedPreimage): RetainedPreimage {
  return {
    packetIndex: entry.packetIndex,
    preimage: Uint8Array.from(entry.preimage),
    condition: Uint8Array.from(entry.condition),
    retainedAt: entry.retainedAt,
  };
}

/**
 * In-memory {@link PreimageRetentionStore}. The only implementation: preimages
 * are session-scoped secrets that MUST NOT outlive their stream (see the module
 * doc), so there is deliberately no file-backed variant.
 */
export class InMemoryPreimageRetentionStore implements PreimageRetentionStore {
  private readonly entries = new Map<number, RetainedPreimage>();

  retain(entry: RetainedPreimage): void {
    this.entries.set(entry.packetIndex, copy(entry));
  }

  get(packetIndex: number): RetainedPreimage | undefined {
    const entry = this.entries.get(packetIndex);
    return entry ? copy(entry) : undefined;
  }

  take(packetIndex: number): RetainedPreimage | undefined {
    const entry = this.entries.get(packetIndex);
    if (!entry) return undefined;
    this.entries.delete(packetIndex);
    return copy(entry);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
