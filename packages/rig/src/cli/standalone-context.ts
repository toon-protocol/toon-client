/**
 * The seam between the `rig push` command and standalone (embedded-client)
 * mode. Kept in its own module WITHOUT any `@toon-protocol/client` import so
 * `push.ts` can `import type` it: the real implementation
 * (`./standalone-mode.ts`, which needs the optional client peer dependency)
 * is only ever loaded via dynamic import when standalone mode is actually
 * selected — daemon-mode runs never touch it. Tests inject a fake context
 * here (the Publisher seam).
 */

import type { Publisher } from '../publisher.js';
import type { RemoteState } from '../remote-state.js';

/** Everything the push command needs from a standalone (embedded) session. */
export interface StandaloneContext {
  /** Hex Nostr pubkey of the embedded identity — the repo owner. */
  ownerPubkey: string;
  /** Paid transport (nonce-guarded StandalonePublisher in the real impl). */
  publisher: Publisher;
  /** Relay URLs to use when neither `--relay` nor git config provides any. */
  defaultRelayUrls: string[];
  /** Read the remote NIP-34 state (kind:30617/30618 + Arweave fallback). */
  fetchRemote(args: {
    ownerPubkey: string;
    repoId: string;
    relayUrls: string[];
  }): Promise<RemoteState>;
  /** Release the identity lock / stop the embedded client. Idempotent. */
  stop(): Promise<void>;
}

/** Factory for a {@link StandaloneContext}; injectable in tests. */
export type LoadStandalone = (
  env: NodeJS.ProcessEnv
) => Promise<StandaloneContext>;
