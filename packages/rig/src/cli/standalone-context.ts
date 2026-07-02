/**
 * The seam between the CLI commands and the standalone (embedded-client)
 * publisher. Kept in its own module WITHOUT any `@toon-protocol/client`
 * import so command modules can `import type` it: the real implementation
 * (`./standalone-mode.ts`, which needs the optional client peer dependency)
 * is only ever loaded via dynamic import once a command actually needs to
 * sign or pay. Tests inject a fake context here (the Publisher seam).
 */

import type { Publisher } from '../publisher.js';
import type { RemoteState } from '../remote-state.js';
import type { IdentitySourceKind } from './identity.js';

/** Everything a paid command needs from a standalone (embedded) session. */
export interface StandaloneContext {
  /** Hex Nostr pubkey of the embedded identity — the repo owner. */
  ownerPubkey: string;
  /** Where the identity's mnemonic came from (chain tier). */
  identitySource: IdentitySourceKind;
  /** Human-facing source label, e.g. `RIG_MNEMONIC env` or a file path. */
  identitySourceLabel: string;
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

/** What the standalone factory needs from the command environment. */
export interface StandaloneLoadOptions {
  env: NodeJS.ProcessEnv;
  /** Working directory (starts the project-local `.env` walk). */
  cwd: string;
  /** Stderr line sink (deprecated-alias warning). */
  warn(line: string): void;
}

/** Factory for a {@link StandaloneContext}; injectable in tests. */
export type LoadStandalone = (
  options: StandaloneLoadOptions
) => Promise<StandaloneContext>;
