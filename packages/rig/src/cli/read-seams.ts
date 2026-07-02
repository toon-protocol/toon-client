/**
 * Injectable seams of the FREE read-path commands (#278): clone, fetch, and
 * the issue/pr list|show tracker views. All three talk to the outside world
 * through exactly these three interfaces — a NIP-01 WebSocket (relay), WHATWG
 * fetch (Arweave gateways), and the GraphQL Git-SHA resolver — so tests run
 * against in-process mock relays/gateways and production uses the defaults.
 *
 * No payments, no channel, no identity: reads are free on TOON, so none of
 * these commands ever load the standalone publisher.
 */

import type { FetchLike } from '../object-fetch.js';
import type { WebSocketFactory } from '../remote-state.js';
import type { CliIo } from './output.js';

/** Optional read-path seams, carried by the CLI dependency bags. */
export interface ReadSeams {
  /** WebSocket constructor override (default: the global WebSocket). */
  webSocketFactory?: WebSocketFactory;
  /** fetch override for Arweave gateway downloads (default: global fetch). */
  fetchFn?: FetchLike;
  /** Git-SHA → Arweave txId resolver override (default: GraphQL resolver). */
  resolveSha?: (sha: string, repo: string) => Promise<string | null>;
}

/** Dependency bag of the read-path commands. */
export interface ReadCommandDeps extends ReadSeams {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
}
