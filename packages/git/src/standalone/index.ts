/**
 * `@toon-protocol/git/standalone` — the standalone embedded Publisher (#228).
 *
 * Separate subpath entry so the core package stays dependency-light: only
 * this entry needs `@toon-protocol/client` (an OPTIONAL peer dependency —
 * install it to use standalone mode; the daemon-backed Publisher in
 * `@toon-protocol/client-mcp` (#227) needs none of this).
 */

export {
  StandalonePublisher,
  StandalonePublishError,
  deriveRouteDestinations,
  extractArweaveTxId,
  type SignedNostrEvent,
  type StandalonePublisherOptions,
  type ToonClientLike,
} from './standalone-publisher.js';

export {
  DEFAULT_DAEMON_PORT,
  DaemonIdentityConflictError,
  NonceLock,
  StandaloneLockError,
  checkDaemonIdentity,
  defaultDaemonPort,
  defaultLockDir,
  type AcquireLockOptions,
  type CheckDaemonOptions,
} from './nonce-guard.js';
