/**
 * The FREE tracker views (#278): `rig issue list|show` and `rig pr list|show`.
 *
 * Pure relay reads over NIP-01 (../remote-state.ts `queryRelay` — the same
 * decoder that tolerates the devnet relay's non-canonical EVENT payload
 * encodings): kind:1621 issues / kind:1617 patches scoped to the repo by the
 * `#a` tag (`30617:<owner>:<repoId>`), kind:1630-1633 status events to derive
 * each item's state (LATEST-WINS: highest created_at, ties broken by lowest
 * id), and kind:1622 comments under `show`. No payments, no channel, no
 * identity — reads are free on TOON.
 *
 * State derivation mirrors rig-web's proven `resolvePRStatus`, upgraded to
 * latest-wins for issues too (a re-opened issue is open again).
 */

import { parseArgs } from 'node:util';
import {
  ISSUE_KIND,
  PATCH_KIND,
  REPOSITORY_ANNOUNCEMENT_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
  STATUS_OPEN_KIND,
} from '@toon-protocol/core/nip34';
import { COMMENT_KIND, authorizedStatusAuthors } from '../nip34-events.js';
import { ownerToHex } from '../npub.js';
import {
  queryRelay,
  type NostrEvent,
  type NostrFilter,
  type WebSocketFactory,
  type WebSocketLike,
} from '../remote-state.js';
import {
  emitCliError,
  UnconfiguredRepoAddressError,
  InvalidRelayUrlError,
} from './errors.js';
import { readToonConfig, resolveRepoRoot } from './git-config.js';
import type { ReadCommandDeps } from './read-seams.js';
import { resolveRelays } from './remote.js';

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const READ_COMMON_FLAGS = `  --repo-id <id>       repository id / NIP-34 d-tag (default: git config)
  --owner <pubkey>     repository owner (npub or 64-char hex; default: git config)
  --remote <name>      read via this configured git remote (default: origin)
  --relay <url>        ad-hoc relay override; repeatable — reads are merged
  --json               machine-readable envelope
  -h, --help           show this help`;

export const ISSUE_LIST_USAGE = `Usage: rig issue list [--state open|closed|all] [options]

List the repo's issues (kind:1621) with their derived state — FREE (relay
reads only). State comes from kind:1630-1633 status events: the latest status
wins; an issue with no status events is open.

Options:
  --state <state>      open | closed | all (default: all)
${READ_COMMON_FLAGS}`;

export const ISSUE_SHOW_USAGE = `Usage: rig issue show <event-id> [options]

Show one issue (kind:1621): metadata, derived state, body, and its
kind:1622 comments — FREE (relay reads only). <event-id> is the 64-char hex
id \`rig issue create\` printed (also visible in \`rig issue list\`).

Options:
${READ_COMMON_FLAGS}`;

export const PR_LIST_USAGE = `Usage: rig pr list [--state open|applied|closed|draft|all] [options]

List the repo's patches/PRs (kind:1617) with their derived state — FREE
(relay reads only). State comes from kind:1630-1633 status events: the
latest status wins; a patch with no status events is open.

Options:
  --state <state>      open | applied | closed | draft | all (default: all)
${READ_COMMON_FLAGS}`;

export const PR_SHOW_USAGE = `Usage: rig pr show <event-id> [options]

Show one patch/PR (kind:1617): metadata, derived state, the FULL patch text
(real \`git format-patch\` output — pipe it to \`git am\` to apply), and its
kind:1622 comments — FREE (relay reads only).

Options:
${READ_COMMON_FLAGS}`;

// ---------------------------------------------------------------------------
// Status derivation (latest-wins)
// ---------------------------------------------------------------------------

export type TrackerStatus = 'open' | 'applied' | 'closed' | 'draft';

const STATUS_BY_KIND: Record<number, TrackerStatus> = {
  [STATUS_OPEN_KIND]: 'open',
  [STATUS_APPLIED_KIND]: 'applied',
  [STATUS_CLOSED_KIND]: 'closed',
  [STATUS_DRAFT_KIND]: 'draft',
};

const STATUS_KINDS = [
  STATUS_OPEN_KIND,
  STATUS_APPLIED_KIND,
  STATUS_CLOSED_KIND,
  STATUS_DRAFT_KIND,
];

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

function tagValues(tags: string[][], name: string): string[] {
  return tags.filter((t) => t[0] === name && t[1]).map((t) => t[1] as string);
}

/**
 * Derive the state of an issue/patch from its status events: consider only
 * kind:1630-1633 events whose `e` tag references the target AND whose author
 * is AUTHORIZED — the repo owner ∪ declared maintainers (#287). Among the
 * authorized events the LATEST wins (highest created_at, ties broken by lowest
 * event id — the same replaceable convention remote-state uses). Unauthorized
 * status events (any funded stranger) are IGNORED for state; they never move
 * it. No authorized status events ⇒ open.
 *
 * `authorized` is the lowercased-hex set from {@link authorizedStatusAuthors}.
 * When it is empty (the 30617 could not be resolved) NOTHING is authorized and
 * the state stays open — a safe, non-spoofable default.
 */
export function deriveStatus(
  targetEventId: string,
  statusEvents: Iterable<NostrEvent>,
  authorized: ReadonlySet<string>
): TrackerStatus {
  let winner: NostrEvent | null = null;
  for (const event of statusEvents) {
    if (STATUS_BY_KIND[event.kind] === undefined) continue;
    if (!authorized.has(event.pubkey.toLowerCase())) continue;
    if (!event.tags.some((t) => t[0] === 'e' && t[1] === targetEventId))
      continue;
    if (
      winner === null ||
      event.created_at > winner.created_at ||
      (event.created_at === winner.created_at && event.id < winner.id)
    ) {
      winner = event;
    }
  }
  return winner === null
    ? 'open'
    : (STATUS_BY_KIND[winner.kind] as TrackerStatus);
}

// ---------------------------------------------------------------------------
// Relay querying (multi-relay merge; tolerant decode via queryRelay)
// ---------------------------------------------------------------------------

const RELAY_TIMEOUT_MS = 10000;
const HEX64_RE = /^[0-9a-f]{64}$/;
const WS_URL_RE = /^wss?:\/\//i;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = (
    globalThis as { WebSocket?: new (url: string) => WebSocketLike }
  ).WebSocket;
  if (!ctor) {
    throw new Error(
      'No global WebSocket constructor (Node >= 22 required) — pass webSocketFactory'
    );
  }
  return new ctor(url);
}

/**
 * Query every relay with every filter and merge events by id. Resolves as
 * long as at least one relay answered; throws when all fail.
 */
async function queryAll(
  relays: string[],
  filters: NostrFilter[],
  webSocketFactory: WebSocketFactory
): Promise<Map<string, NostrEvent>> {
  const jobs = relays.flatMap((relay) =>
    filters.map((filter) =>
      queryRelay(relay, filter, RELAY_TIMEOUT_MS, webSocketFactory)
    )
  );
  const results = await Promise.allSettled(jobs);
  const byId = new Map<string, NostrEvent>();
  let failures = 0;
  let firstError: unknown;
  for (const result of results) {
    if (result.status === 'rejected') {
      failures += 1;
      firstError ??= result.reason;
      continue;
    }
    for (const event of result.value) {
      if (typeof event.id === 'string' && !byId.has(event.id)) {
        byId.set(event.id, event);
      }
    }
  }
  if (failures === results.length && results.length > 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error(String(firstError));
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Shared context resolution (repo address + relays; NO identity, NO payment)
// ---------------------------------------------------------------------------

interface TrackerFlags {
  json: boolean;
  help: boolean;
  state?: string;
  relay: string[];
  remote?: string;
  repoId?: string;
  owner?: string;
}

const TRACKER_OPTIONS = {
  json: { type: 'boolean', default: false },
  state: { type: 'string' },
  relay: { type: 'string', multiple: true },
  remote: { type: 'string' },
  'repo-id': { type: 'string' },
  owner: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function pickTrackerFlags(values: Record<string, unknown>): TrackerFlags {
  const flags: TrackerFlags = {
    json: values['json'] === true,
    help: values['help'] === true,
    relay: Array.isArray(values['relay']) ? (values['relay'] as string[]) : [],
  };
  if (typeof values['state'] === 'string') flags.state = values['state'];
  if (typeof values['remote'] === 'string') flags.remote = values['remote'];
  if (typeof values['repo-id'] === 'string') flags.repoId = values['repo-id'];
  if (typeof values['owner'] === 'string')
    flags.owner = ownerToHex(values['owner']);
  return flags;
}

interface TrackerContext {
  relays: string[];
  /** Set when the repo address resolved (list always has it; show may not). */
  repoAddr: { ownerPubkey: string; repoId: string } | null;
  webSocketFactory: WebSocketFactory;
}

/**
 * Resolve relays (+ repo address when `needRepoAddr`) from flags and the git
 * config, mirroring the paid commands' #249 chain — but reads may target
 * MULTIPLE relays (results are merged), and only ws/wss URLs are usable.
 */
async function resolveTrackerContext(
  flags: TrackerFlags,
  deps: ReadCommandDeps,
  needRepoAddr: boolean
): Promise<TrackerContext> {
  let repoRoot: string | undefined;
  let toonConfig: { repoId?: string; owner?: string; relays: string[] } = {
    relays: [],
  };
  try {
    repoRoot = await resolveRepoRoot(deps.cwd);
    toonConfig = await readToonConfig(repoRoot);
  } catch {
    // Not inside a git repo — flags must carry everything.
  }

  let repoAddr: TrackerContext['repoAddr'] = null;
  if (needRepoAddr) {
    const repoId = flags.repoId ?? toonConfig.repoId;
    if (!repoId) throw new UnconfiguredRepoAddressError('repository id');
    const owner = flags.owner ?? toonConfig.owner;
    if (!owner) throw new UnconfiguredRepoAddressError('repository owner');
    repoAddr = { ownerPubkey: owner, repoId };
  }

  const resolved = await resolveRelays({
    relayFlags: flags.relay,
    remoteName: flags.remote,
    repoRoot,
    toonRelays: toonConfig.relays,
  });
  const wsRelays = resolved.relays.filter((url) => WS_URL_RE.test(url));
  if (wsRelays.length === 0) {
    throw new InvalidRelayUrlError(
      resolved.relays[0] ?? '',
      'reads need a ws:// or wss:// relay'
    );
  }

  return {
    relays: wsRelays,
    repoAddr,
    webSocketFactory: deps.webSocketFactory ?? defaultWebSocketFactory,
  };
}

function repoATag(addr: { ownerPubkey: string; repoId: string }): string {
  return `${REPOSITORY_ANNOUNCEMENT_KIND}:${addr.ownerPubkey}:${addr.repoId}`;
}

/**
 * Resolve the AUTHORIZED status authors (#287) for a repo: the owner ∪ the
 * maintainers declared on the repo's kind:30617 announcement. Reads the 30617
 * from the relay(s) — untrusted relays may over-return, so only the owner's
 * own announcement for this `d`-tag is honored. When no announcement is found
 * the set falls back to OWNER-ONLY (the owner is always an implicit
 * maintainer); this is the safe default — an unresolved 30617 can never widen
 * authority to a stranger.
 */
async function fetchAuthorizedAuthors(
  ctx: TrackerContext,
  ownerPubkey: string,
  repoId: string
): Promise<Set<string>> {
  let announceTags: string[][] = [];
  try {
    const events = await queryAll(
      ctx.relays,
      [
        {
          kinds: [REPOSITORY_ANNOUNCEMENT_KIND],
          authors: [ownerPubkey],
          '#d': [repoId],
        },
      ],
      ctx.webSocketFactory
    );
    // Latest replaceable 30617 by (created_at, id) from the trusted owner.
    let latest: NostrEvent | null = null;
    for (const event of events.values()) {
      if (event.kind !== REPOSITORY_ANNOUNCEMENT_KIND) continue;
      if (event.pubkey !== ownerPubkey) continue;
      if (!event.tags.some((t) => t[0] === 'd' && t[1] === repoId)) continue;
      if (
        latest === null ||
        event.created_at > latest.created_at ||
        (event.created_at === latest.created_at && event.id < latest.id)
      ) {
        latest = event;
      }
    }
    if (latest) announceTags = latest.tags;
  } catch {
    // Relay read failed — fall back to owner-only authority.
  }
  return authorizedStatusAuthors(ownerPubkey, announceTags);
}

// ---------------------------------------------------------------------------
// Shared list/show engines (issues and PRs differ only in kind + fields)
// ---------------------------------------------------------------------------

interface TrackerItem {
  eventId: string;
  kind: number;
  title: string;
  status: TrackerStatus;
  authorPubkey: string;
  createdAt: number;
  labels: string[];
  content: string;
  /** kind:1617 only: `commit` tag SHAs. */
  commitShas?: string[];
  /** kind:1617 only: `branch` tag. */
  branch?: string;
  /**
   * kind:1617 only: the PR body from the `description` tag (#280). Separate
   * from `content`, which is pure `git format-patch` output for `git am`.
   */
  description?: string;
}

function parseTrackerItem(
  event: NostrEvent,
  status: TrackerStatus
): TrackerItem {
  const item: TrackerItem = {
    eventId: event.id,
    kind: event.kind,
    title:
      tagValue(event.tags, 'subject') ??
      (event.content.split('\n')[0] ?? '').slice(0, 120),
    status,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    labels: tagValues(event.tags, 't'),
    content: event.content,
  };
  if (event.kind === PATCH_KIND) {
    item.commitShas = tagValues(event.tags, 'commit');
    const branch = tagValue(event.tags, 'branch');
    if (branch !== undefined) item.branch = branch;
    const description = tagValue(event.tags, 'description');
    if (description !== undefined) item.description = description;
  }
  return item;
}

function isoDate(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().slice(0, 10);
}

/** Fetch items of `kind` for the repo + their statuses; derive state. */
async function fetchItems(
  ctx: TrackerContext,
  kind: number
): Promise<TrackerItem[]> {
  const addr = ctx.repoAddr as { ownerPubkey: string; repoId: string };
  const aTag = repoATag(addr);
  // Authority set (#287): owner ∪ declared maintainers from the 30617. Fetched
  // in parallel with the items — status resolution honors ONLY these authors.
  const authorizedPromise = fetchAuthorizedAuthors(
    ctx,
    addr.ownerPubkey,
    addr.repoId
  );
  const [itemEvents, aStatusEvents] = await Promise.all([
    queryAll(
      ctx.relays,
      [{ kinds: [kind], '#a': [aTag] }],
      ctx.webSocketFactory
    ),
    queryAll(
      ctx.relays,
      [{ kinds: STATUS_KINDS, '#a': [aTag] }],
      ctx.webSocketFactory
    ),
  ]);

  // Defense against over-returning relays: keep only the right kind + repo.
  const items = [...itemEvents.values()].filter(
    (e) => e.kind === kind && e.tags.some((t) => t[0] === 'a' && t[1] === aTag)
  );

  // Statuses may lack the repo `a` tag (other clients) — also query by `#e`.
  const statuses = new Map(aStatusEvents);
  if (items.length > 0) {
    const byE = await queryAll(
      ctx.relays,
      [{ kinds: STATUS_KINDS, '#e': items.map((i) => i.id) }],
      ctx.webSocketFactory
    );
    for (const [id, event] of byE)
      if (!statuses.has(id)) statuses.set(id, event);
  }

  const authorized = await authorizedPromise;
  return items
    .map((event) =>
      parseTrackerItem(event, deriveStatus(event.id, statuses.values(), authorized))
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

interface ShownItem {
  item: TrackerItem;
  comments: {
    eventId: string;
    authorPubkey: string;
    createdAt: number;
    content: string;
  }[];
  repoATag: string | null;
}

/** Fetch one item by event id + its statuses and comments. */
async function fetchItem(
  ctx: TrackerContext,
  eventId: string,
  expectedKind: number
): Promise<ShownItem> {
  const found = await queryAll(
    ctx.relays,
    [{ ids: [eventId] }],
    ctx.webSocketFactory
  );
  const event = found.get(eventId);
  if (!event) {
    throw new Error(`event ${eventId} not found on ${ctx.relays.join(', ')}`);
  }
  if (event.kind !== expectedKind) {
    const hint =
      event.kind === PATCH_KIND
        ? ' (it is a kind:1617 patch — use `rig pr show`)'
        : event.kind === ISSUE_KIND
          ? ' (it is a kind:1621 issue — use `rig issue show`)'
          : '';
    throw new Error(
      `event ${eventId} has kind ${event.kind}, expected ${expectedKind}${hint}`
    );
  }

  const [statusEvents, commentEvents] = await Promise.all([
    queryAll(
      ctx.relays,
      [{ kinds: STATUS_KINDS, '#e': [eventId] }],
      ctx.webSocketFactory
    ),
    queryAll(
      ctx.relays,
      [{ kinds: [COMMENT_KIND], '#e': [eventId] }],
      ctx.webSocketFactory
    ),
  ]);

  const comments = [...commentEvents.values()]
    .filter(
      (e) =>
        e.kind === COMMENT_KIND &&
        e.tags.some((t) => t[0] === 'e' && t[1] === eventId)
    )
    .sort((a, b) => a.created_at - b.created_at)
    .map((e) => ({
      eventId: e.id,
      authorPubkey: e.pubkey,
      createdAt: e.created_at,
      content: e.content,
    }));

  // Authority set (#287): `show` may run without a resolved repo address, so
  // derive owner + repoId from the target's own `a` tag (30617:<owner>:<id>)
  // and read that repo's 30617 for the maintainers. No parseable a-tag ⇒ an
  // empty authority set ⇒ status stays open (safe: no stranger can move it).
  const repoATag = tagValue(event.tags, 'a') ?? null;
  const parsedAddr = parseRepoATag(repoATag);
  const authorized = parsedAddr
    ? await fetchAuthorizedAuthors(ctx, parsedAddr.ownerPubkey, parsedAddr.repoId)
    : new Set<string>();

  return {
    item: parseTrackerItem(
      event,
      deriveStatus(eventId, statusEvents.values(), authorized)
    ),
    comments,
    repoATag,
  };
}

/** Parse a NIP-34 repo `a` tag `30617:<owner-hex>:<repoId>` into its parts. */
function parseRepoATag(
  aTag: string | null
): { ownerPubkey: string; repoId: string } | null {
  if (!aTag) return null;
  const [kind, ownerPubkey, ...repoIdParts] = aTag.split(':');
  const repoId = repoIdParts.join(':');
  if (kind !== String(REPOSITORY_ANNOUNCEMENT_KIND) || !ownerPubkey || !repoId) {
    return null;
  }
  return { ownerPubkey, repoId };
}

// ---------------------------------------------------------------------------
// list command (shared by issue/pr)
// ---------------------------------------------------------------------------

interface ListSpec {
  command: 'issue list' | 'pr list';
  kind: number;
  usage: string;
  states: readonly TrackerStatus[];
  jsonKey: 'issues' | 'prs';
}

async function runList(
  args: string[],
  deps: ReadCommandDeps,
  spec: ListSpec
): Promise<number> {
  const { io } = deps;
  let flags: TrackerFlags;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: TRACKER_OPTIONS,
      allowPositionals: true,
    });
    if (positionals.length > 0) {
      throw new Error(`rig ${spec.command} takes no positional arguments`);
    }
    flags = pickTrackerFlags(values);
    if (
      flags.state !== undefined &&
      flags.state !== 'all' &&
      !spec.states.includes(flags.state as TrackerStatus)
    ) {
      throw new Error(
        `--state must be one of ${[...spec.states, 'all'].join(' | ')} (got ${JSON.stringify(flags.state)})`
      );
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(spec.usage);
    return 2;
  }
  if (flags.help) {
    io.out(spec.usage);
    return 0;
  }

  try {
    const ctx = await resolveTrackerContext(flags, deps, true);
    const all = await fetchItems(ctx, spec.kind);
    const state = flags.state ?? 'all';
    const items = state === 'all' ? all : all.filter((i) => i.status === state);

    if (flags.json) {
      io.emitJson({
        command: spec.command,
        repoAddr: ctx.repoAddr,
        relays: ctx.relays,
        state,
        count: items.length,
        [spec.jsonKey]: items,
      });
      return 0;
    }

    if (items.length === 0) {
      io.out(
        `no ${state === 'all' ? '' : `${state} `}${spec.jsonKey} found for ` +
          `${repoATag(ctx.repoAddr as { ownerPubkey: string; repoId: string })}`
      );
      return 0;
    }
    for (const item of items) {
      const labels =
        item.labels.length > 0 ? `  [${item.labels.join(', ')}]` : '';
      io.out(
        `${item.status.padEnd(7)}  ${item.eventId.slice(0, 8)}  ${item.title}` +
          `  (${item.authorPubkey.slice(0, 8)}, ${isoDate(item.createdAt)})${labels}`
      );
    }
    io.out(
      `${items.length} ${spec.jsonKey}${state === 'all' ? '' : ` (${state})`}`
    );
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, spec.command, err);
  }
}

// ---------------------------------------------------------------------------
// show command (shared by issue/pr)
// ---------------------------------------------------------------------------

interface ShowSpec {
  command: 'issue show' | 'pr show';
  kind: number;
  usage: string;
  jsonKey: 'issue' | 'pr';
  /** PRs print their full patch text; issues print the body. */
  bodyLabel: string;
}

async function runShow(
  args: string[],
  deps: ReadCommandDeps,
  spec: ShowSpec
): Promise<number> {
  const { io } = deps;
  let flags: TrackerFlags;
  let eventId: string;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: TRACKER_OPTIONS,
      allowPositionals: true,
    });
    flags = pickTrackerFlags(values);
    if (flags.help) {
      io.out(spec.usage);
      return 0;
    }
    if (positionals.length !== 1) {
      throw new Error('expected exactly one <event-id>');
    }
    eventId = positionals[0] as string;
    if (!HEX64_RE.test(eventId)) {
      throw new Error(
        `<event-id> must be a 64-char lowercase hex id (got ${JSON.stringify(eventId)})`
      );
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(spec.usage);
    return 2;
  }

  try {
    const ctx = await resolveTrackerContext(flags, deps, false);
    const shown = await fetchItem(ctx, eventId, spec.kind);

    if (flags.json) {
      io.emitJson({
        command: spec.command,
        relays: ctx.relays,
        repoATag: shown.repoATag,
        [spec.jsonKey]: shown.item,
        comments: shown.comments,
      });
      return 0;
    }

    const { item } = shown;
    io.out(`${spec.jsonKey} ${item.eventId}`);
    io.out(`Title:   ${item.title}`);
    io.out(`Status:  ${item.status}`);
    io.out(`Author:  ${item.authorPubkey}`);
    io.out(`Date:    ${isoDate(item.createdAt)}`);
    if (item.labels.length > 0) io.out(`Labels:  ${item.labels.join(', ')}`);
    if (item.branch !== undefined) io.out(`Branch:  ${item.branch}`);
    if (item.commitShas && item.commitShas.length > 0) {
      io.out(`Commits: ${item.commitShas.join(', ')}`);
    }
    if (shown.repoATag !== null) io.out(`Repo:    ${shown.repoATag}`);
    if (item.description !== undefined) {
      // The `description` tag (`rig pr create --body`): shown as its own
      // section so the patch text below stays pipeable into `git am`.
      io.out('');
      io.out('Body:');
      for (const line of item.description.split('\n')) io.out(line);
    }
    io.out('');
    io.out(`${spec.bodyLabel}:`);
    for (const line of item.content.split('\n')) io.out(line);
    io.out('');
    io.out(`Comments (${shown.comments.length}):`);
    for (const comment of shown.comments) {
      io.out(
        `--- ${comment.eventId.slice(0, 8)} by ${comment.authorPubkey.slice(0, 8)} ` +
          `on ${isoDate(comment.createdAt)}`
      );
      for (const line of comment.content.split('\n')) io.out(line);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, flags.json, spec.command, err);
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

const ISSUE_STATES = ['open', 'closed', 'applied', 'draft'] as const;
const PR_STATES = ['open', 'applied', 'closed', 'draft'] as const;

/** `rig issue list` */
export function runIssueList(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  return runList(args, deps, {
    command: 'issue list',
    kind: ISSUE_KIND,
    usage: ISSUE_LIST_USAGE,
    states: ISSUE_STATES,
    jsonKey: 'issues',
  });
}

/** `rig issue show <event-id>` */
export function runIssueShow(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  return runShow(args, deps, {
    command: 'issue show',
    kind: ISSUE_KIND,
    usage: ISSUE_SHOW_USAGE,
    jsonKey: 'issue',
    bodyLabel: 'Body',
  });
}

/** `rig pr list` */
export function runPrList(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  return runList(args, deps, {
    command: 'pr list',
    kind: PATCH_KIND,
    usage: PR_LIST_USAGE,
    states: PR_STATES,
    jsonKey: 'prs',
  });
}

/** `rig pr show <event-id>` */
export function runPrShow(
  args: string[],
  deps: ReadCommandDeps
): Promise<number> {
  return runShow(args, deps, {
    command: 'pr show',
    kind: PATCH_KIND,
    usage: PR_SHOW_USAGE,
    jsonKey: 'pr',
    bodyLabel: 'Patch',
  });
}
