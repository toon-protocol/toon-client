/**
 * Rolling-swap leg-B session registry (toon-client#573) — the daemon's
 * `jobHandler` router for INBOUND leg-B PREPAREs (the maker's
 * `RollingAdvancePayload`, rolling-swap spec §3.2).
 *
 * `ToonClientConfig.jobHandler` is fixed once at client construction
 * (toon-client#494's BTP wiring, `modes/http.ts`); `ClientRunner` installs
 * exactly ONE router — `jobHandler` below — for every apex it builds. A
 * `/swap` call's rolling path `register()`s a session (keyed by
 * `streamNonce`) for the lifetime of that one call and `unregister()`s it in
 * a `finally`, so the router only ever has a live session to dispatch to
 * while a matching `swap()` call is in flight. An inbound job that is not a
 * rolling advance, or names an unknown/expired `streamNonce`, is DECLINED
 * (thrown — `createJobMessageHandler` answers F99): nothing else in this
 * daemon currently offers paid jobs, so there is no other traffic to
 * preserve silence for.
 */

import type { JobHandler, JobRequest } from '@toon-protocol/client';
import {
  handleRollingAdvance,
  parseRollingAdvancePayload,
  type RollingAdvanceContext,
  type RollingAdvanceOutcome,
} from '@toon-protocol/client';

/** One in-flight rolling-swap session's live results, read by `swap()`. */
export interface RollingSwapSession {
  readonly streamNonce: string;
  /** Verified + revealed advances, keyed by `seq`. */
  readonly outcomes: Map<number, RollingAdvanceOutcome>;
  /** Advances that failed verification / were withheld, keyed by `seq`. */
  readonly rejections: Map<number, { code: string; message: string }>;
}

/** Codes surfaced on `RollingSwapSession.rejections` (a client-side classification, not the wire code). */
export const ROLLING_ADVANCE_REJECTED_CODE = 'ROLLING_ADVANCE_REJECTED';

export class RollingSwapSessionRegistry {
  private readonly sessions = new Map<
    string,
    { session: RollingSwapSession; context: RollingAdvanceContext }
  >();

  /**
   * Register a session for `streamNonce`. Throws if one is already active —
   * a `streamNonce` is single-use per the wire spec (§4), and reusing one
   * concurrently would let one swap's outcomes leak into another's.
   */
  register(
    streamNonce: string,
    context: RollingAdvanceContext
  ): RollingSwapSession {
    if (this.sessions.has(streamNonce)) {
      throw new Error(
        `rolling-swap session "${streamNonce}" is already active`
      );
    }
    const session: RollingSwapSession = {
      streamNonce,
      outcomes: new Map(),
      rejections: new Map(),
    };
    this.sessions.set(streamNonce, { session, context });
    return session;
  }

  unregister(streamNonce: string): void {
    this.sessions.delete(streamNonce);
  }

  /**
   * The single `ToonClientConfig.jobHandler` installed on every apex client.
   * Bound as a class-field arrow so it can be passed by reference.
   */
  readonly jobHandler: JobHandler = async (job: JobRequest) => {
    const advance = parseRollingAdvancePayload(job.data);
    if (!advance) {
      throw new Error('not a rolling-swap leg-B advance payload');
    }
    const entry = this.sessions.get(advance.streamNonce);
    if (!entry) {
      throw new Error(
        `unknown or inactive rolling-swap session "${advance.streamNonce}"`
      );
    }
    try {
      const outcome = await handleRollingAdvance(job.data, entry.context);
      entry.session.outcomes.set(outcome.advance.seq, outcome);
      return { fulfillment: outcome.fulfillment };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.session.rejections.set(advance.seq, {
        code: ROLLING_ADVANCE_REJECTED_CODE,
        message,
      });
      throw err;
    }
  };
}
