/**
 * `@toon-protocol/rig/standalone` — the standalone embedded Publisher (#228).
 *
 * Separate subpath entry so the core package stays light at import time:
 * only this entry needs `@toon-protocol/client` (a regular runtime
 * dependency since #259; the daemon-backed Publisher in
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

export type {
  ChannelCloseOutcome,
  ChannelOpenOutcome,
  ChannelSettleOutcome,
  StandaloneMoneyOps,
  WalletChainBalanceInfo,
  WalletTokenAmountInfo,
} from './money.js';

export {
  ChannelMapCorruptError,
  ChannelMapStore,
  RIG_CHANNEL_MAP_FILENAME,
  channelStatus,
  recordKey,
  resolveChannelPaths,
  type ChannelMapKey,
  type ChannelMapRecord,
  type ChannelMapStoreOptions,
  type PersistedChannelContext,
  type WatermarkEntry,
} from './channel-map.js';

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
