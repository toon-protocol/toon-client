/**
 * Git commit-author from the nostr identity (#302).
 *
 * On a rig repo the nostr key IS the identity, so `rig init` sets the repo's
 * LOCAL git author fields from it — the commit author == the push signer ==
 * the nostr identity, a coherent authorship chain baked permanently into the
 * git objects that land on Arweave. Without this, `rig commit` (a git
 * passthrough, #250) dead-ends on git's "Author identity unknown / empty ident
 * name not allowed" for anyone who never set a global git identity.
 *
 *   user.email = `<npub>@nostr`  — npub is bech32, lowercase-alphanumeric, a
 *                                  valid email local part; `@nostr` is a stable
 *                                  non-routable marker domain.
 *   user.name  = the identity's kind:0 profile DISPLAY NAME when published
 *                (prefer `display_name`, else `name` from the content JSON),
 *                read latest-wins (highest created_at) from a resolvable relay,
 *                BEST-EFFORT; falls back to the npub when there is no profile,
 *                no resolvable relay, or the read fails.
 *
 * The kind:0 read reuses the tolerant NIP-01 machinery from `../remote-state`
 * (double-JSON-encoded EVENT payloads and all). It never throws and never
 * blocks init: a short timeout, and any failure falls back to the npub.
 */

import { hexToNpub } from '../npub.js';
import { queryRelay, type WebSocketFactory } from '../remote-state.js';

/** Nostr metadata event kind (profile). */
export const PROFILE_KIND = 0;

/** Default bounded wait for the kind:0 profile read (env-overridable). */
export const DEFAULT_PROFILE_TIMEOUT_MS = 3000;

/** Env var overriding the kind:0 read timeout (milliseconds). */
export const PROFILE_TIMEOUT_ENV = 'RIG_PROFILE_TIMEOUT_MS';

/** Where `user.name` came from: the nostr profile, or the npub fallback. */
export type GitAuthorSource = 'profile' | 'npub';

/** A resolved git commit-author derived from the nostr identity. */
export interface GitAuthor {
  /** `user.name`: the kind:0 display name, else the npub. */
  name: string;
  /** `user.email`: `<npub>@nostr`. */
  email: string;
  /** The npub of the identity (bech32). */
  npub: string;
  source: GitAuthorSource;
}

export interface ResolveGitAuthorOptions {
  /** Identity pubkey (64-char hex). */
  pubkey: string;
  /**
   * Relay to read the kind:0 profile from (resolved at init time). When
   * undefined or not a ws(s) URL, the profile read is skipped and the npub is
   * used — init must not depend on a relay being reachable.
   */
  relayUrl?: string | undefined;
  /** Bounded wait for the kind:0 read (default {@link DEFAULT_PROFILE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** WebSocket factory override (defaults to the global WebSocket). */
  webSocketFactory?: WebSocketFactory;
  /** Relay-query seam (tests); defaults to {@link queryRelay}. */
  queryRelayImpl?: typeof queryRelay;
}

/** True for a WebSocket-scheme URL (the only scheme the kind:0 read speaks). */
function isWebSocketRelay(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

/**
 * Extract a display name from a kind:0 event's content JSON: prefer
 * `display_name`, then `name`. Returns undefined when neither is a non-empty
 * string or the content is not parseable — the caller then keeps the npub.
 */
export function displayNameFromKind0(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const fields = parsed as Record<string, unknown>;
  for (const key of ['display_name', 'name'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Resolve the git commit-author for the identity `pubkey`: `<npub>@nostr` email
 * plus a `user.name` of the published kind:0 display name (latest-wins) or, on
 * any miss, the npub. Best-effort and non-throwing — a relay that is missing,
 * unreachable, slow, or serves no/garbage profile just yields the npub.
 */
export async function resolveGitAuthor(
  options: ResolveGitAuthorOptions
): Promise<GitAuthor> {
  const npub = hexToNpub(options.pubkey);
  const email = `${npub}@nostr`;
  const fallback: GitAuthor = { name: npub, email, npub, source: 'npub' };

  const { relayUrl } = options;
  if (relayUrl === undefined || !isWebSocketRelay(relayUrl)) {
    return fallback;
  }

  const query = options.queryRelayImpl ?? queryRelay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROFILE_TIMEOUT_MS;
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;

  try {
    const events = await query(
      relayUrl,
      { kinds: [PROFILE_KIND], authors: [options.pubkey], limit: 20 },
      timeoutMs,
      factory
    );
    // Latest-wins over the whole buffer — a relay may serve a stale kind:0
    // ahead of the newest (issue #157), so never trust first-in-buffer.
    let latest: { created_at: number; content: string } | undefined;
    for (const event of events) {
      if (event.kind !== PROFILE_KIND) continue;
      if (event.pubkey !== options.pubkey) continue;
      if (!latest || event.created_at > latest.created_at) {
        latest = { created_at: event.created_at, content: event.content };
      }
    }
    if (latest) {
      const name = displayNameFromKind0(latest.content);
      if (name !== undefined) {
        return { name, email, npub, source: 'profile' };
      }
    }
  } catch {
    // Best-effort: any failure keeps the npub fallback (init never blocks).
  }
  return fallback;
}

/** Read {@link PROFILE_TIMEOUT_ENV} as a positive integer, else undefined. */
export function profileTimeoutFromEnv(
  env: NodeJS.ProcessEnv
): number | undefined {
  const raw = env[PROFILE_TIMEOUT_ENV]?.trim();
  if (!raw) return undefined;
  const ms = Number.parseInt(raw, 10);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function defaultWebSocketFactory(url: string): ReturnType<WebSocketFactory> {
  const ctor = (
    globalThis as {
      WebSocket?: new (url: string) => ReturnType<WebSocketFactory>;
    }
  ).WebSocket;
  if (!ctor) {
    throw new Error(
      'No global WebSocket constructor (Node >= 22 required) for the kind:0 read'
    );
  }
  return new ctor(url);
}
