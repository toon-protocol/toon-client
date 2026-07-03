/**
 * Daemon-as-accelerator delegation for paid rig commands (#279).
 *
 * Standalone remains the DEFAULT and the guarantee: every paid command works
 * with no daemon anywhere. But standalone pays a fixed bootstrap tax (relay
 * discovery, peer negotiation, channel resume) on every invocation, while a
 * running `toon-clientd` already holds all of that state warm. When the
 * daemon holds the SAME identity, the pre-#279 nonce guard refused outright
 * (two writers would race the payment channel's cumulative-claim watermark).
 * #279 refines that: the same-identity case now DELEGATES the operation to
 * the daemon's loopback `/git/*` routes — one process (the daemon) owns the
 * watermark, which is exactly the safety property the refusal protected, and
 * the command finishes in daemon time instead of bootstrap time.
 *
 * Decision matrix ({@link resolvePaidSession}):
 *
 *   daemon reachable + SAME identity   → delegate (`path: 'daemon'`)
 *   daemon reachable + other identity  → standalone (its channels are keyed
 *                                        to its own pubkey — no shared state)
 *   daemon unreachable / not a daemon  → standalone
 *
 * TRUST BOUNDARY: the daemon is trusted only because it is (a) loopback and
 * (b) proven to hold the same identity — the `GET /status` identity check
 * happens BEFORE any request body is sent. A same-identity daemon already
 * holds the mnemonic-derived keys and the channel, so delegating adds no
 * authority it does not have.
 *
 * Commands the daemon has NO route for — `rig fund`, `rig balance`,
 * `rig channel open|close|settle` — always run standalone; the on-chain
 * channel mutations among them still REFUSE under a same-identity daemon
 * (the nonce guard in ../standalone/nonce-guard.ts), because close/settle
 * must not race the daemon's live claims.
 *
 * The `DaemonGitClient` is a plain-fetch client, deliberately NOT built on
 * `@toon-protocol/client-mcp`'s ControlClient — that package depends on this
 * one (its daemon Publisher wraps our planner), so importing it back would
 * be circular. Route conventions (loopback base URL, JSON bodies, the error
 * envelope with structured 409 `non_fast_forward` / 413 `oversize_objects`
 * payloads) are mirrored here; the wire types live in `../routes.ts` for
 * client-mcp to adopt. Same duplication contract as
 * `../standalone/nonce-guard.ts` — keep in sync.
 */

import { defaultDaemonPort } from '../standalone/nonce-guard.js';
import type {
  GitCommentRequest,
  GitErrorEnvelope,
  GitEstimateRequest,
  GitEstimateResponse,
  GitEventResponse,
  GitIssueRequest,
  GitPatchRequest,
  GitPushRequest,
  GitPushResponse,
  GitStatusRequest,
} from '../routes.js';
import { resolveIdentity, type IdentitySourceKind } from './identity.js';
import type {
  LoadStandalone,
  StandaloneContext,
} from './standalone-context.js';

// ---------------------------------------------------------------------------
// Daemon probe (GET /status — identity check BEFORE anything is sent)
// ---------------------------------------------------------------------------

/** Result of probing the toon-clientd loopback `/status`. */
export interface DaemonProbe {
  /** Control API base URL probed, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** True when `/status` answered 200 with parseable JSON. */
  reachable: boolean;
  /** `identity.nostrPubkey` from the status body (when reachable). */
  identity?: string;
  /** `ready` from the status body (channel open, publish-ready). */
  ready?: boolean;
  /** Daemon's default relay URL (`relay.url`). */
  relayUrl?: string;
  /**
   * Daemon's flat per-event publish fee (`feePerEvent`, base units, decimal
   * string) — what the single-event subcommands quote before confirming.
   */
  feePerEvent?: string;
  /**
   * Optional-route capabilities the daemon advertises (`capabilities` in the
   * `/status` body, #306). `'git'` means the `/git/*` write path exists. A
   * daemon older than the field itself omits it entirely — so an UNDEFINED or
   * absent-of-`'git'` value must be read as "no git support" (fail closed),
   * NOT delegated to (it would 404 mid-operation).
   */
  capabilities?: string[];
}

/**
 * True when the probed daemon advertises the `/git/*` write path (#306).
 * Fails closed: a daemon that predates the `capabilities` field reports
 * `undefined` here, which is treated as "no git routes" so rig raises a clear
 * upgrade error instead of delegating into a mid-operation 404.
 */
export function daemonSupportsGit(probe: DaemonProbe): boolean {
  return Array.isArray(probe.capabilities) && probe.capabilities.includes('git');
}

/** Injectable probe signature (tests fake this instead of the network). */
export type ProbeDaemon = (
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
) => Promise<DaemonProbe>;

/** Loopback control API base URL (port: `TOON_CLIENT_HTTP_PORT`, else 8787). */
export function daemonBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['TOON_CLIENT_HTTP_PORT'];
  const parsed = raw ? Number(raw) : NaN;
  const port =
    Number.isFinite(parsed) && parsed > 0 ? parsed : defaultDaemonPort();
  return `http://127.0.0.1:${port}`;
}

/**
 * Probe `GET /status` on the loopback control API. Anything short of a 200
 * with JSON (no listener, timeout, some other local service) reports
 * unreachable — the caller then runs standalone.
 */
export async function probeDaemon(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  timeoutMs = 1500
): Promise<DaemonProbe> {
  const baseUrl = daemonBaseUrl(env);
  try {
    const res = await fetchImpl(`${baseUrl}/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { baseUrl, reachable: false };
    const body = (await res.json()) as {
      ready?: unknown;
      identity?: { nostrPubkey?: unknown };
      relay?: { url?: unknown };
      feePerEvent?: unknown;
      capabilities?: unknown;
    };
    const probe: DaemonProbe = { baseUrl, reachable: true };
    const pubkey = body?.identity?.nostrPubkey;
    if (typeof pubkey === 'string' && pubkey !== '') probe.identity = pubkey;
    if (typeof body?.ready === 'boolean') probe.ready = body.ready;
    if (typeof body?.relay?.url === 'string' && body.relay.url !== '') {
      probe.relayUrl = body.relay.url;
    }
    if (typeof body?.feePerEvent === 'string' && body.feePerEvent !== '') {
      probe.feePerEvent = body.feePerEvent;
    }
    // Only keep string entries — an old daemon omits the field entirely, and
    // daemonSupportsGit() reads a missing/garbage value as "no git routes".
    if (Array.isArray(body?.capabilities)) {
      probe.capabilities = body.capabilities.filter(
        (c): c is string => typeof c === 'string'
      );
    }
    return probe;
  } catch {
    return { baseUrl, reachable: false };
  }
}

// ---------------------------------------------------------------------------
// /git/* loopback client (plain fetch — see module doc for the no-import rule)
// ---------------------------------------------------------------------------

/** The daemon answered a `/git/*` route with a non-2xx error envelope. */
export class DaemonRouteError extends Error {
  constructor(
    /** HTTP status code (409 non_fast_forward, 413 oversize_objects, …). */
    public readonly status: number,
    /** The parsed error envelope (structured payloads at the top level). */
    public readonly envelope: GitErrorEnvelope
  ) {
    super(envelope.detail ?? envelope.error);
    this.name = 'DaemonRouteError';
  }
}

/**
 * A same-identity daemon holds the identity but is too old to serve the
 * `/git/*` routes (#306 — version skew: git routes added in #227, delegation
 * in #279). Raised at the capability pre-flight (no `'git'` in `/status`
 * `capabilities`), and as defense-in-depth when a git route still 404s despite
 * a positive probe. NOT auto-fell-back to standalone on purpose: a
 * same-identity daemon holding the identity makes the #228 nonce guard REFUSE
 * standalone anyway (both writers would race the channel's cumulative-claim
 * watermark) — so the only correct, non-racy resolution is upgrading or
 * stopping the daemon.
 */
export class DaemonTooOldForGitError extends Error {
  constructor(
    /** Control API base URL the stale daemon answered on. */
    public readonly baseUrl: string,
    /** The shared Nostr pubkey (hex), when known — shortened in the message. */
    public readonly pubkey?: string
  ) {
    const holds =
      pubkey !== undefined && pubkey !== ''
        ? ` holds this identity (${pubkey.slice(0, 8)}…)`
        : ' holds this identity';
    super(
      `toon-clientd at ${baseUrl}${holds} but is too old to handle git ` +
        'operations (missing /git routes). Upgrade the daemon ' +
        '(npm i -g @toon-protocol/client-mcp@latest, then restart it) — or ' +
        'stop it to let rig run standalone.'
    );
    this.name = 'DaemonTooOldForGitError';
  }
}

/** The daemon vanished between the identity probe and the operation. */
export class DaemonUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    cause: unknown
  ) {
    super(
      `toon-clientd stopped answering at ${baseUrl} after the identity ` +
        `probe — nothing was paid. Re-run: rig falls back to standalone ` +
        `automatically when no daemon responds` +
        (cause instanceof Error ? ` (${cause.message})` : '')
    );
    this.name = 'DaemonUnreachableError';
  }
}

export class DaemonGitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
    /** Shared identity pubkey, for the too-old error message on a 404. */
    private readonly pubkey?: string
  ) {}

  gitEstimate(req: GitEstimateRequest): Promise<GitEstimateResponse> {
    return this.post<GitEstimateResponse>('/git/estimate', req);
  }

  gitPush(req: GitPushRequest): Promise<GitPushResponse> {
    return this.post<GitPushResponse>('/git/push', req);
  }

  gitIssue(req: GitIssueRequest): Promise<GitEventResponse> {
    return this.post<GitEventResponse>('/git/issue', req);
  }

  gitComment(req: GitCommentRequest): Promise<GitEventResponse> {
    return this.post<GitEventResponse>('/git/comment', req);
  }

  gitPatch(req: GitPatchRequest): Promise<GitEventResponse> {
    return this.post<GitEventResponse>('/git/patch', req);
  }

  gitStatus(req: GitStatusRequest): Promise<GitEventResponse> {
    return this.post<GitEventResponse>('/git/status', req);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new DaemonUnreachableError(this.baseUrl, err);
    }
    // Defense in depth (#306): a 404 on a `/git/*` route means the route is
    // not registered — a daemon too old for the git write path, despite the
    // capability pre-flight having (wrongly) passed. Surface the same
    // actionable upgrade error rather than the opaque "HTTP 404" envelope.
    if (res.status === 404) {
      throw new DaemonTooOldForGitError(this.baseUrl, this.pubkey);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new DaemonRouteError(res.status, {
        error: 'invalid_response',
        detail: `daemon returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      });
    }
    if (!res.ok) {
      const envelope =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as GitErrorEnvelope)
          : { error: 'http_error', detail: `HTTP ${res.status}` };
      throw new DaemonRouteError(res.status, envelope);
    }
    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Paid-session resolution (the decision matrix)
// ---------------------------------------------------------------------------

/** Which transport a paid command ran on (stderr line + `--json` field). */
export type SessionPath = 'daemon' | 'standalone';

/** The delegated fast path: a same-identity daemon owns the operation. */
export interface DaemonSession {
  path: 'daemon';
  client: DaemonGitClient;
  baseUrl: string;
  /** Locally-resolved identity (source tier + pubkey — never the phrase). */
  identity: {
    pubkey: string;
    source: IdentitySourceKind;
    sourceLabel: string;
  };
  /** Daemon's flat per-event fee (base units, decimal), when reported. */
  feePerEvent?: string;
  /** Daemon's configured relay URL, when reported (mismatch warning). */
  daemonRelayUrl?: string;
}

/** The default path: the embedded, nonce-guarded standalone context. */
export interface StandaloneSession {
  path: 'standalone';
  ctx: StandaloneContext;
}

export type PaidSession = DaemonSession | StandaloneSession;

export interface ResolveSessionOptions {
  env: NodeJS.ProcessEnv;
  /** Working directory (identity `.env` walk / standalone loader). */
  cwd: string;
  /** Stderr line sink (the chosen-path line always prints here). */
  warn(line: string): void;
  /** Standalone factory (`deps.loadStandalone ?? defaultLoadStandalone`). */
  loadStandalone: LoadStandalone;
  /** Relay-origin for the standalone #264 network bootstrap, when resolved. */
  relayUrl?: string;
  /** Fetch impl for probe + delegated requests (tests). Default: global. */
  fetchImpl?: typeof fetch;
  /** Probe override (tests). Default: {@link probeDaemon}. */
  probeDaemon?: ProbeDaemon;
}

/**
 * Decide how this paid command pays (see the module-doc matrix) and return a
 * ready session. The chosen path is announced on stderr either way, BEFORE
 * the expensive work starts. Identity is confirmed against the daemon's
 * `/status` before anything else is sent to it.
 */
export async function resolvePaidSession(
  options: ResolveSessionOptions
): Promise<PaidSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const probe = await (options.probeDaemon ?? probeDaemon)(
    options.env,
    fetchImpl
  );

  if (probe.reachable && probe.identity !== undefined) {
    // Local identity resolution only happens when there is a daemon to
    // compare against — the standalone loader resolves it itself otherwise.
    const identity = await resolveIdentity({
      env: options.env,
      cwd: options.cwd,
      warn: options.warn,
    });
    if (identity.pubkey === probe.identity) {
      // Capability pre-flight (#306): a same-identity daemon that predates the
      // `/git/*` routes (older client-mcp) has `/status` but 404s every git
      // route. Delegating would dead-end with an opaque 404, and blindly
      // falling back to standalone is unsafe — the #228 nonce guard REFUSES
      // standalone while a same-identity daemon is up (cumulative-claim race).
      // Fail closed with a clear upgrade/stop remediation instead.
      if (!daemonSupportsGit(probe)) {
        throw new DaemonTooOldForGitError(probe.baseUrl, identity.pubkey);
      }
      options.warn(
        `rig: paid path: daemon — toon-clientd at ${probe.baseUrl} holds ` +
          `this identity (${identity.pubkey.slice(0, 8)}…), delegating`
      );
      return {
        path: 'daemon',
        client: new DaemonGitClient(probe.baseUrl, fetchImpl, identity.pubkey),
        baseUrl: probe.baseUrl,
        identity: {
          pubkey: identity.pubkey,
          source: identity.source,
          sourceLabel: identity.sourceLabel,
        },
        ...(probe.feePerEvent !== undefined
          ? { feePerEvent: probe.feePerEvent }
          : {}),
        ...(probe.relayUrl !== undefined
          ? { daemonRelayUrl: probe.relayUrl }
          : {}),
      };
    }
    options.warn(
      `rig: paid path: standalone — the toon-clientd at ${probe.baseUrl} ` +
        `runs a different identity (${probe.identity.slice(0, 8)}…), no ` +
        'shared channel state'
    );
  } else {
    options.warn(
      `rig: paid path: standalone (no toon-clientd at ${probe.baseUrl})`
    );
  }

  const ctx = await options.loadStandalone({
    env: options.env,
    cwd: options.cwd,
    warn: options.warn,
    ...(options.relayUrl !== undefined ? { relayUrl: options.relayUrl } : {}),
  });
  return { path: 'standalone', ctx };
}
