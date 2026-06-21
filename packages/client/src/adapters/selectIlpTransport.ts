/**
 * Transport selection policy for the client ILP layer.
 *
 * The connector serves ILP-over-HTTP (`POST /ilp`) and BTP on the SAME port
 * (connector PR #181). A peer advertises this in discovery via the toon-core
 * `IlpPeerInfo` fields added in toon PR #29:
 *   - `httpEndpoint?: string`   — the `POST /ilp` URL.
 *   - `supportsUpgrade?: boolean` — whether the host accepts the BTP upgrade.
 *
 * Those fields may not yet exist on the installed `@toon-protocol/core`
 * `IlpPeerInfo` type, so we read them defensively here (see `DiscoveredIlpPeer`).
 *
 * Policy:
 *   - Pure one-shot consumers (`needsDuplex: false`) prefer HTTP when the peer
 *     advertises an `httpEndpoint` — stateless, no persistent socket.
 *   - Clients that must receive server-initiated packets or act as a peer
 *     (`needsDuplex: true`) use BTP. If the peer only exposes `httpEndpoint`
 *     and `supportsUpgrade` is true, we go HTTP-then-upgrade; otherwise we
 *     connect to the BTP endpoint directly.
 */

/**
 * The subset of discovery fields this policy reads. Structurally compatible with
 * core's `IlpPeerInfo`; `httpEndpoint`/`supportsUpgrade` are optional so a
 * pre-PR-#29 `IlpPeerInfo` can be passed through a cast.
 */
export interface DiscoveredIlpPeer {
  /** BTP WebSocket endpoint (always present on a TOON peer). */
  btpEndpoint?: string;
  /** `POST /ilp` URL (toon PR #29). */
  httpEndpoint?: string;
  /** Whether the host accepts the BTP upgrade over the HTTP endpoint (toon PR #29). */
  supportsUpgrade?: boolean;
}

export type IlpTransportChoice =
  /** Stateless one-shot writes via `POST /ilp`. */
  | { kind: 'http'; httpEndpoint: string; canUpgrade: boolean }
  /** Duplex BTP session via the WebSocket endpoint. */
  | { kind: 'btp'; btpEndpoint: string }
  /**
   * Open HTTP first (one-shot writes) but upgrade to BTP when duplex is needed.
   * Only chosen when the peer exposes `httpEndpoint` + `supportsUpgrade` and no
   * separate `btpEndpoint`.
   */
  | { kind: 'http-upgradable'; httpEndpoint: string };

export interface SelectIlpTransportOptions {
  /**
   * Whether the client needs a duplex session (receive server-initiated
   * packets / act as a peer). Default: false (pure one-shot consumer).
   */
  needsDuplex?: boolean;
}

/**
 * Read discovery fields defensively from a (possibly pre-PR-#29) peer info
 * object. Accepts core's `IlpPeerInfo` or any structurally-compatible shape.
 */
export function readDiscoveredIlpPeer(peer: unknown): DiscoveredIlpPeer {
  const p = (peer ?? {}) as Record<string, unknown>;
  return {
    btpEndpoint:
      typeof p['btpEndpoint'] === 'string' ? (p['btpEndpoint'] as string) : undefined,
    httpEndpoint:
      typeof p['httpEndpoint'] === 'string'
        ? (p['httpEndpoint'] as string)
        : undefined,
    supportsUpgrade:
      typeof p['supportsUpgrade'] === 'boolean'
        ? (p['supportsUpgrade'] as boolean)
        : undefined,
  };
}

/**
 * Choose the ILP transport for a discovered peer given the consumer's needs.
 *
 * @throws {Error} If the peer advertises no usable endpoint at all.
 */
export function selectIlpTransport(
  peer: DiscoveredIlpPeer,
  options: SelectIlpTransportOptions = {}
): IlpTransportChoice {
  const needsDuplex = options.needsDuplex ?? false;
  const http = peer.httpEndpoint?.trim() || undefined;
  const btp = peer.btpEndpoint?.trim() || undefined;
  const canUpgrade = peer.supportsUpgrade === true;

  if (needsDuplex) {
    // Duplex consumers prefer a real BTP endpoint; fall back to HTTP-upgrade
    // only when the host advertises it.
    if (btp) return { kind: 'btp', btpEndpoint: btp };
    if (http && canUpgrade) return { kind: 'http-upgradable', httpEndpoint: http };
    throw new Error(
      'Duplex transport required but peer exposes neither a btpEndpoint nor an upgradable httpEndpoint'
    );
  }

  // One-shot consumers prefer stateless HTTP when available.
  if (http) return { kind: 'http', httpEndpoint: http, canUpgrade };
  if (btp) return { kind: 'btp', btpEndpoint: btp };
  throw new Error('Peer exposes neither an httpEndpoint nor a btpEndpoint');
}
