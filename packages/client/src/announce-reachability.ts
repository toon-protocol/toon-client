/**
 * Whether an endpoint a DISCOVERED announce advertises can mean anything to
 * the client reading it (toon-client#593).
 *
 * A `kind:10032` announce is an unauthenticated, permanently-served claim:
 * anyone can publish one, the relay treats the kind as
 * parameterized-replaceable, and (on the devnet relay today) implements
 * neither NIP-40 expiry nor NIP-09 deletion — so an announce outlives the
 * node that published it, forever, and can only be replaced by its original
 * signing key.
 *
 * That makes one class of advertised endpoint actively dangerous rather than
 * merely stale: an address whose meaning is RELATIVE TO THE READER.
 * `ws://127.0.0.1:3401` in an announce served by a remote relay does not name
 * the announcer at all — it names *this* machine. Dialling it is best-case a
 * connection-refused and worst-case a BTP session opened against whatever
 * unrelated local service happens to hold that port. The live devnet case
 * that motivated this module was exactly that: a throwaway swap maker
 * (`g.toon.swap.sol`, the only advertised Solana→EVM pair) announcing
 * `ws://127.0.0.1:3401` from a workstation that has not existed since
 * 2026-08-15.
 *
 * ## What is rejected, and why the three zones differ
 *
 * - **Loopback** (`127.0.0.0/8`, `::1`, `localhost`, and the unspecified
 *   bind addresses `0.0.0.0` / `::`) — rejected by default. This is not a
 *   policy judgement, it is a semantic one: there is no network topology in
 *   which a remote announcer's loopback address is a correct way for someone
 *   else to reach it. `0.0.0.0`/`::` are in the same bucket for a different
 *   reason — they are BIND addresses a node leaked into its announce, and
 *   they are not dialable anywhere.
 *
 * - **Link-local** (`169.254.0.0/16`, `fe80::/10`) — rejected by default,
 *   same reasoning: the address is scoped to whichever link the reader is on,
 *   so it resolves to a different machine for every reader, or to none.
 *   `169.254.169.254` additionally is the cloud instance-metadata endpoint,
 *   which a discovered announce must never be able to aim a client at.
 *
 * - **Private / RFC1918, ULA and CGNAT** (`10/8`, `172.16/12`, `192.168/16`,
 *   `100.64/10`, `fc00::/7`) — **ALLOWED by default**, and deliberately so.
 *   Unlike loopback, a private address in an announce CAN be correct: an
 *   operator running a maker and a client on one LAN, a Docker-compose rig
 *   (the `172.x` bridge network this project uses to verify multi-machine
 *   behaviour locally), or a Tailscale/WireGuard overlay (`100.64/10`) are
 *   all real, working deployments where the announcer genuinely is at
 *   `192.168.1.50`. Rejecting those by default would break correct setups to
 *   defend against a case that loopback rejection already covers. A
 *   deployment that never wants a client dialling its own LAN off a public
 *   announce can opt in via `allowPrivate: false`.
 *
 * ## How local development stays working
 *
 * Two escape hatches, in order of preference:
 *
 * 1. **Same-scope rescue (automatic).** A loopback endpoint is accepted when
 *    the announce was discovered from a loopback relay — see
 *    {@link announceEndpointPolicyFor}'s `discoveredFrom`. If you are reading
 *    announces off `ws://localhost:7100`, you are on a local stack, and
 *    `ws://127.0.0.1:3000` is exactly the machine the relay is on. This is
 *    what keeps the local harnesses and the anvil/local-relay dev stack
 *    working with no configuration at all. It cannot rescue the devnet case,
 *    because a public relay is not loopback.
 *
 * 2. **Explicit opt-in.** `allowLoopback: true` (library callers), or
 *    `TOON_CLIENT_ALLOW_LOOPBACK_PEERS=1` in the daemon's environment, for
 *    the split case of a local node announcing itself to a remote relay.
 *
 * Endpoints that were never discovered — a configured `btpUrl`, a
 * `knownPeers[]` entry, an operator-supplied URL — do not pass through here
 * at all. An operator naming an endpoint is a decision; an announce claiming
 * one is a claim. Only the claim is filtered.
 */

/** Which address zone an endpoint's host sits in. */
export type EndpointZone =
  | 'routable'
  | 'loopback'
  | 'link-local'
  | 'private'
  | 'unparsable';

/** Zones a {@link AnnounceEndpointPolicy} can refuse. */
export type RejectableEndpointZone = 'loopback' | 'link-local' | 'private';

/** Environment variable that force-allows loopback endpoints in announces. */
export const ALLOW_LOOPBACK_PEERS_ENV = 'TOON_CLIENT_ALLOW_LOOPBACK_PEERS';

/** Which zones a client will accept from a discovered announce. */
export interface AnnounceEndpointPolicy {
  /** Accept `127/8`, `::1`, `localhost`, `0.0.0.0`, `::`. Default `false`. */
  allowLoopback: boolean;
  /** Accept `169.254/16`, `fe80::/10`. Default `false`. */
  allowLinkLocal: boolean;
  /** Accept RFC1918 / ULA / CGNAT. Default `true` — see the module doc. */
  allowPrivate: boolean;
}

/** The safe-by-default policy: loopback and link-local out, private in. */
export const DEFAULT_ANNOUNCE_ENDPOINT_POLICY: AnnounceEndpointPolicy = {
  allowLoopback: false,
  allowLinkLocal: false,
  allowPrivate: true,
};

/** Inputs {@link announceEndpointPolicyFor} resolves a policy from. */
export interface AnnounceEndpointPolicyInput {
  /**
   * The relay URL(s) the announce was read from. When one is itself loopback
   * (or link-local), endpoints in that same zone are accepted: a local relay
   * means a local stack, where `127.0.0.1` genuinely is the announcer. This
   * is the no-configuration path that keeps dev harnesses working.
   *
   * Takes a LIST as well as a single URL because a client can subscribe to
   * several (`config.relayUrl` plus every `knownPeers[].relayUrl` — see
   * `subscribeToDiscovery`), and rig's standalone push pins `relayUrl` to
   * `''` and carries the real one per peer.
   */
  discoveredFrom?: string | readonly string[] | undefined;
  /** Explicit override; wins over the same-scope rescue. */
  allowLoopback?: boolean | undefined;
  /** Explicit override. */
  allowLinkLocal?: boolean | undefined;
  /** Explicit override. */
  allowPrivate?: boolean | undefined;
  /**
   * Environment to read {@link ALLOW_LOOPBACK_PEERS_ENV} from. Defaults to
   * `process.env` when available (absent in a browser build, hence the
   * guard). Injected in tests rather than mutating the real environment.
   */
  env?: Record<string, string | undefined> | undefined;
}

/**
 * Resolve the policy for announces read off one discovery source.
 *
 * Precedence, highest first: an explicit `allow*` flag, then
 * {@link ALLOW_LOOPBACK_PEERS_ENV}, then the same-scope rescue, then
 * {@link DEFAULT_ANNOUNCE_ENDPOINT_POLICY}.
 */
export function announceEndpointPolicyFor(
  input: AnnounceEndpointPolicyInput = {}
): AnnounceEndpointPolicy {
  const env = input.env ?? readProcessEnv();
  const sources =
    input.discoveredFrom === undefined
      ? []
      : typeof input.discoveredFrom === 'string'
        ? [input.discoveredFrom]
        : input.discoveredFrom;
  const sourceZones = new Set(sources.map(classifyEndpointZone));
  return {
    allowLoopback:
      input.allowLoopback ??
      (isTruthyFlag(env[ALLOW_LOOPBACK_PEERS_ENV]) ||
        sourceZones.has('loopback')),
    allowLinkLocal: input.allowLinkLocal ?? sourceZones.has('link-local'),
    allowPrivate:
      input.allowPrivate ?? DEFAULT_ANNOUNCE_ENDPOINT_POLICY.allowPrivate,
  };
}

/** A refused endpoint, with everything a caller needs to say why out loud. */
export interface UnreachableAnnounceEndpoint {
  /** The endpoint exactly as the announce carried it. */
  endpoint: string;
  /** Its host, lowercased and bracket-stripped. */
  host: string;
  /** Why it was refused. */
  zone: RejectableEndpointZone;
  /** One-sentence, user-facing explanation. */
  reason: string;
}

/**
 * The zone an endpoint's host sits in. Purely lexical — no DNS is resolved,
 * so a hostname that happens to point at loopback reads as `'routable'`. That
 * is the intended limit: this defends against an address whose MEANING is
 * reader-relative, not against every possible way to name the local machine.
 *
 * `'unparsable'` for anything that is not a URL with a host; callers treat it
 * as "not this filter's problem" — an endpoint that cannot be parsed cannot
 * be dialled either, and failing it here would only relabel that error.
 */
export function classifyEndpointZone(endpoint: string): EndpointZone {
  const host = endpointHost(endpoint);
  if (host === undefined) return 'unparsable';
  return classifyHost(host);
}

/**
 * The host of an endpoint URL, lowercased, trailing-dot- and
 * bracket-stripped. Accepts a scheme-less `host:port` too, since announces
 * are hand-written often enough to carry one.
 */
export function endpointHost(endpoint: string): string | undefined {
  const raw = endpoint.trim();
  if (raw === '') return undefined;
  const parsed = parseUrl(raw) ?? parseUrl(`ws://${raw}`);
  if (!parsed) return undefined;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === '') return undefined;
  // WHATWG URL already strips IPv6 brackets, but a scheme-less fallback parse
  // of `[::1]:3000` can leave them on some runtimes.
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * `undefined` when `endpoint` is acceptable under `policy`; otherwise the
 * refusal, ready to be surfaced. Call this at the point of SELECTION so the
 * user is told the candidate is unreachable, rather than being handed a
 * connection error from their own machine.
 */
export function rejectedAnnounceEndpoint(
  endpoint: string,
  policy: AnnounceEndpointPolicy = DEFAULT_ANNOUNCE_ENDPOINT_POLICY
): UnreachableAnnounceEndpoint | undefined {
  const host = endpointHost(endpoint);
  if (host === undefined) return undefined;
  const zone = classifyHost(host);
  if (zone === 'routable' || zone === 'unparsable') return undefined;
  if (zone === 'loopback' && policy.allowLoopback) return undefined;
  if (zone === 'link-local' && policy.allowLinkLocal) return undefined;
  if (zone === 'private' && policy.allowPrivate) return undefined;
  return { endpoint, host, zone, reason: reasonFor(endpoint, host, zone) };
}

/** Convenience inverse of {@link rejectedAnnounceEndpoint}. */
export function isAnnounceEndpointUsable(
  endpoint: string,
  policy: AnnounceEndpointPolicy = DEFAULT_ANNOUNCE_ENDPOINT_POLICY
): boolean {
  return rejectedAnnounceEndpoint(endpoint, policy) === undefined;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function reasonFor(
  endpoint: string,
  host: string,
  zone: RejectableEndpointZone
): string {
  if (zone === 'loopback') {
    return (
      `The announce advertises "${endpoint}", whose host ${host} is a loopback ` +
      'address — that names THIS machine, never the announcer. A discovered ' +
      'announce carrying one is unreachable by definition (the node that ' +
      'published it is gone, or never meant the address for anyone else), and ' +
      'dialling it would connect to whatever unrelated service holds that ' +
      'port locally. Ignoring it. If the announcer really does run on this ' +
      `machine, set ${ALLOW_LOOPBACK_PEERS_ENV}=1.`
    );
  }
  if (zone === 'link-local') {
    return (
      `The announce advertises "${endpoint}", whose host ${host} is a ` +
      'link-local address — it is scoped to whichever network link the reader ' +
      'is on, so it points somewhere different (or nowhere) for every client ' +
      'that reads the announce. Ignoring it.'
    );
  }
  return (
    `The announce advertises "${endpoint}", whose host ${host} is a private ` +
    'address, and this client is configured to refuse private endpoints from ' +
    'discovery. Ignoring it.'
  );
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function classifyHost(host: string): EndpointZone {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const v4 = parseIpv4(host);
  if (v4) return classifyIpv4(v4);
  if (host.includes(':')) return classifyIpv6(host);
  return 'routable';
}

/** The four octets of a dotted-quad, or `undefined` if `host` is not one. */
function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  const [a, b, c, d] = octets;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  ) {
    return undefined;
  }
  return [a, b, c, d];
}

function classifyIpv4(octets: [number, number, number, number]): EndpointZone {
  const [a, b] = octets;
  // 0.0.0.0/8 is "this host on this network" — in practice a bind address a
  // node leaked into its own announce. Not dialable by anyone.
  if (a === 127 || a === 0) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // 100.64/10 — CGNAT, and what Tailscale hands out.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  return 'routable';
}

function classifyIpv6(host: string): EndpointZone {
  // Drop any zone id (`fe80::1%eth0`) before matching.
  const addr = host.split('%')[0] ?? host;
  const normalized = addr.replace(/^\[|\]$/g, '');
  // IPv4-mapped forms carry the v4 semantics, not the v6 ones. Both spellings
  // reach here: the dotted `::ffff:127.0.0.1` a hand-written announce uses,
  // and the hex `::ffff:7f00:1` the WHATWG URL parser normalizes it into.
  const mappedV4 = ipv4MappedOctets(normalized);
  if (mappedV4) return classifyIpv4(mappedV4);
  if (normalized === '::1' || normalized === '::') return 'loopback';
  // fe80::/10 spans fe80–febf; fc00::/7 spans fc00–fdff.
  if (/^fe[89ab]/i.test(normalized)) return 'link-local';
  if (/^f[cd]/i.test(normalized)) return 'private';
  return 'routable';
}

/**
 * The four IPv4 octets an IPv4-mapped IPv6 address carries, in either
 * spelling — `::ffff:127.0.0.1` or the hex `::ffff:7f00:1` the WHATWG URL
 * parser rewrites it to. `undefined` for a genuine IPv6 address.
 */
function ipv4MappedOctets(
  addr: string
): [number, number, number, number] | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (dotted?.[1]) return parseIpv4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (!hex?.[1] || !hex[2]) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readProcessEnv(): Record<string, string | undefined> {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  return proc?.env ?? {};
}
