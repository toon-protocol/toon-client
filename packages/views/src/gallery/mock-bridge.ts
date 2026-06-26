/**
 * MockBridge — a {@link ViewBridge} backed by the gallery fixtures, so the real
 * composition runtime ({@link ViewSpecRenderer}) renders the real atoms with
 * realistic data and NO MCP host. Resolves `toon_query` against the fixtures by
 * NIP-01 filter, returns the daemon snapshot for `toon_status`, and stubs writes
 * to a successful receipt. Dev-only (gallery harness); never bundled.
 */
import { type ViewBridge, type ToolOutcome } from '../app-bridge/types.js';
import { type NostrEvent, type NostrFilter } from '../types.js';
import { QUERY_TOOL, STATUS_TOOL, CHANNELS_TOOL, BALANCES_TOOL, FUND_WALLET_TOOL } from '../tool-names.js';
import {
  PROFILES,
  NOTES,
  REACTIONS,
  THREAD_ROOT,
  THREAD_REPLIES,
  MEDIA_POSTS,
  REPOS,
  ISSUES,
  PRS,
  COMMENTS,
  STATUS,
  WALLET_CHANNELS,
  WALLET_BALANCES,
  profileFor,
} from './fixtures.js';

/** Every fixture event, used as the searchable pool for id/tag lookups. */
const ALL: NostrEvent[] = [
  ...PROFILES,
  ...NOTES,
  ...REACTIONS,
  THREAD_ROOT,
  ...THREAD_REPLIES,
  ...MEDIA_POSTS,
  ...REPOS,
  ...ISSUES,
  ...PRS,
  ...COMMENTS,
];

function tagValues(e: NostrEvent, name: string): string[] {
  return e.tags.filter((t) => t[0] === name).map((t) => t[1] ?? '');
}

/** Resolve a NIP-01 filter against the fixture pool (best-effort, gallery-only). */
function resolve(filter: NostrFilter | undefined): NostrEvent[] {
  if (!filter) return [];
  const { kinds, ids, authors } = filter;

  // Exact-id fetch (thread root, event-by-id).
  if (ids && ids.length > 0) return ALL.filter((e) => ids.includes(e.id));

  let pool = ALL;
  if (kinds && kinds.length > 0) pool = pool.filter((e) => kinds.includes(e.kind));

  // Tag filters (#e replies/reactions/comments, #a repo-scoped issues/PRs).
  const eTags = filter['#e'];
  if (eTags && eTags.length > 0) {
    pool = pool.filter((e) => tagValues(e, 'e').some((v) => eTags.includes(v)));
  }
  const aTags = filter['#a'];
  if (aTags && aTags.length > 0) {
    pool = pool.filter((e) => tagValues(e, 'a').some((v) => aTags.includes(v)));
  }

  // kind:0 profile lookups: return the profile for each requested author (the
  // feed's resolveProfile seam queries one author at a time).
  if (kinds && kinds.length === 1 && kinds[0] === 0 && authors && authors.length > 0) {
    return authors.map((pk) => profileFor(pk)).filter((p): p is NostrEvent => !!p);
  }
  if (authors && authors.length > 0) {
    pool = pool.filter((e) => authors.includes(e.pubkey));
  }
  return pool;
}

export interface MockBridgeOptions {
  /** Override / disable the live status (e.g. to show the error state). */
  status?: typeof STATUS | null;
}

export function createMockBridge(opts: MockBridgeOptions = {}): ViewBridge {
  const status = opts.status === undefined ? STATUS : opts.status;
  let counter = 0;
  return {
    async callTool(name, args): Promise<ToolOutcome> {
      if (name === QUERY_TOOL) {
        const filter = (args as { filter?: NostrFilter }).filter;
        return { ok: true, events: resolve(filter) };
      }
      if (name === STATUS_TOOL) {
        if (!status) return { ok: false, error: 'status unavailable' };
        return { ok: true, data: status };
      }
      if (name === CHANNELS_TOOL) {
        return { ok: true, data: { channels: WALLET_CHANNELS } };
      }
      if (name === BALANCES_TOOL) {
        return { ok: true, data: { balances: WALLET_BALANCES } };
      }
      if (name === FUND_WALLET_TOOL) {
        const chain = (args as { chain?: string }).chain ?? 'evm';
        return { ok: true, data: { chain, address: '0xfaucet', faucetUrl: 'https://faucet.devnet.toonprotocol.dev' } };
      }
      // Writes (publish/upload/open-channel/swap): pretend success after a beat
      // so the optimistic UI + receipt phases render.
      counter += 1;
      const eventId = `evt_demo_${counter.toString(16).padStart(6, '0')}deadbeefcafef00dba5e`;
      return { ok: true, data: { eventId } };
    },
    notifyModel() {
      /* gallery: model notifications are a no-op */
    },
    onSpec() {
      // The gallery drives specs directly (it never streams via the bridge), so
      // there's nothing to subscribe to; hand back a no-op unsubscribe.
      return () => undefined;
    },
    confirm: () => Promise.resolve(true),
  };
}
