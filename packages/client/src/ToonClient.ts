import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import type {
  BootstrapService,
  DiscoveredPeer,
  DiscoveryTracker,
  IlpPeerInfo,
  IlpSendResult,
  IlpClient,
} from '@toon-protocol/core';
import type { NetworkFamilyStatus } from '@toon-protocol/core';
import { validateConfig, applyDefaults, getNetworkStatus } from './config.js';
import {
  toBase64,
  fromBase64,
  encodeUtf8,
  decodeUtf8,
  toHex,
} from './utils/binary.js';
import {
  ConnectorEdgeClient,
  connectorEdgeBaseUrl,
  type ConnectorRouteTerms,
  type ConnectorSettlementTerms,
  type ConnectorSolanaSettlementTerms,
  type ClaimStateRequestEntry,
  type ClaimStateResult,
} from './adapters/ConnectorEdgeClient.js';
import { readExchangeOutcome, sealExchange } from './wire/sealed-exchange.js';
import { giftWrapPublicKey } from './wire/giftwrap.js';
import { unwrapGiftWrapWithKey, type UnwrappedGiftWrap } from './nip59.js';
import type { ResolvedConfig } from './config.js';
import { initializeHttpMode } from './modes/http.js';
import {
  subscribeToDiscovery,
  type DiscoverySubscription,
} from './discovery-subscription.js';
import {
  ToonClientError,
  ChannelFundingError,
  Http402RequiresBtpError,
  Http401RequiresBtpError,
  isInsufficientGasError,
} from './errors.js';
import {
  announceEndpointPolicyFor,
  rejectedAnnounceEndpoint,
  type AnnounceEndpointPolicy,
  type UnreachableAnnounceEndpoint,
} from './announce-reachability.js';
import type { IlpSendParams } from './adapters/ilp-send.js';
import { EvmSigner } from './signing/evm-signer.js';
import { SolanaSigner } from './signing/solana-signer.js';
import { MinaSigner } from './signing/mina-signer.js';
import { deriveFullIdentity } from './keys/KeyDerivation.js';
import {
  ChannelManager,
  type PeerNegotiation,
} from './channel/ChannelManager.js';
import { JsonFileChannelStore } from './channel/ChannelStore.js';
import {
  isUnknownChannelReject,
  rejectNamesChannel,
} from './channel/stale-channel.js';
import type { OnChainChannelClient } from './channel/OnChainChannelClient.js';
import {
  readEvmTokenBalance,
  readSolanaTokenBalance,
  readMinaBalance,
  readWalletBalances,
  type WalletBalance,
  type WalletBalanceSources,
  type WalletChainBalances,
} from './balance/WalletBalanceReader.js';
import {
  requestBlobStorage,
  type RequestBlobStorageResult,
} from './blob-storage.js';
import {
  sendTransfer as executeTransfer,
  type SendTransferParams,
  type SendTransferResult,
  type TransferConfig,
} from './transfer.js';
import type {
  BtpRuntimeClient,
  BtpChannelDeclaration,
} from './adapters/BtpRuntimeClient.js';
import type {
  BtpPaidWriteTransport,
  ClaimSendingTransport,
} from './adapters/BtpPaidWriteTransport.js';
import {
  Http402Client,
  type H402FetchOptions,
  type ToonChannelAccept,
} from './adapters/Http402Client.js';
import type { SettlementBundle } from '@toon-protocol/sdk';
import {
  submitEvmSettlement,
  type SubmitEvmSettlementResult,
} from './swap/settle-received-claims.js';
import {
  submitMinaSettlement,
  type MinaSignaturePair,
} from './swap/mina-settlement.js';
import { submitSolanaSettlement } from './swap/solana-settlement.js';
import type {
  ToonClientConfig,
  ToonStartResult,
  PublishEventResult,
  SignedBalanceProof,
} from './types.js';

/**
 * Validate an operator-supplied maker Mina co-signature (`{ r, s }` decimal
 * Field strings). Returns undefined for an absent/malformed entry so the
 * settlement path fails closed with `MINA_MAKER_COSIGN_REQUIRED` rather than
 * forwarding garbage into o1js.
 */
function parseMakerMinaSignature(
  raw: { r: string; s: string } | undefined
): MinaSignaturePair | undefined {
  if (
    raw &&
    typeof raw.r === 'string' &&
    raw.r.length > 0 &&
    typeof raw.s === 'string' &&
    raw.s.length > 0
  ) {
    return { r: raw.r, s: raw.s };
  }
  return undefined;
}

/**
 * Whether `address` terminates `destination`: an exact match, or a proper
 * ILP-address prefix of it (`g.toon.ario` terminates `g.toon.ario.inbox`,
 * never `g.toon.ariose` — the '.' separator is required, not just a string
 * prefix).
 */
function ilpAddressTerminates(address: string, destination: string): boolean {
  return destination === address || destination.startsWith(`${address}.`);
}

/**
 * Whether `address` is a claim on `destination` trustworthy enough to name
 * `peerInfo` the terminator (toon-client#533). An EXACT match is always
 * trustworthy — the announce is claiming that literal address. An ANCESTOR
 * (proper-prefix) match is trustworthy only when `peerInfo` used the
 * pre-Epic-7 legacy form — a single self-declared `ilpAddress`, no
 * `ilpAddresses` array at all.
 *
 * Epic-7's `ilpAddresses` lists every address a peer is reachable AT — "one
 * per upstream peering" (`IlpPeerInfo`) — a ROUTING fact, not a claim that
 * the peer owns everything nested under that prefix. Without this guard, a
 * router that legitimately announces `g.toon` (among others) becomes a
 * candidate terminator for `g.toon.ario`, a prefix the STORE — not the
 * router — actually owns: verified against production, where the live
 * router's announce is `ilpAddresses: ["g.toon", "g.toon.relay"]`, making
 * `ilpAddressTerminates('g.toon', 'g.toon.ario')` true. Nothing but the
 * store's own (600s-expiring) announce being in the tracker kept the router
 * from being selected — a startup race or an expiry away from paying into a
 * wrap nobody but the store can open.
 */
function claimsTermination(
  peerInfo: Pick<IlpPeerInfo, 'ilpAddress' | 'ilpAddresses'>,
  address: string,
  destination: string
): boolean {
  if (destination === address) return true;
  return (
    peerInfo.ilpAddresses === undefined &&
    ilpAddressTerminates(address, destination)
  );
}

/**
 * Whether `candidate` can carry a paid write, i.e. an ILP PREPARE plus the
 * signed payment-channel claim. Both built-in transports (`HttpIlpClient`,
 * `BtpRuntimeClient`) and the {@link BtpPaidWriteTransport} wrapper satisfy
 * it; the level-3 `HttpRuntimeClient` (connector-admin HTTP) does not.
 *
 * `ClaimSendingTransport`'s `IlpSendParams` is the shape both built-in
 * transports accept — the sender-chosen `executionCondition` + explicit
 * `expiresAt` extensions (toon-client#350) — and both enforce FULFILL
 * preimage verification.
 */
function sendsClaims(candidate: unknown): candidate is ClaimSendingTransport {
  return (
    typeof (candidate as ClaimSendingTransport | undefined)
      ?.sendIlpPacketWithClaim === 'function'
  );
}

/**
 * Recognizes the transport-level signals that say a claim-bearing
 * ILP-over-HTTP write must be retried over BTP: a `402` whose x402 challenge
 * declares `requiredTransport: "btp"` (issue #561), or a bare `401` refusing a
 * discovered/unconfigured peer identity (issue #565). Both are
 * transport-signal-only — neither implies the write itself was invalid.
 *
 * Returns the signalling error together with the phrase naming what happened
 * (for the `BTP_REQUIRED` message raised when there is no BTP uplink to retry
 * onto), or `undefined` for any other error — an ordinary failure to rethrow
 * untouched.
 */
function btpFallbackSignal(
  error: unknown
): { error: Error; reason: string } | undefined {
  if (error instanceof Http402RequiresBtpError) {
    return { error, reason: '402 response declared requiredTransport: "btp"' };
  }
  if (error instanceof Http401RequiresBtpError) {
    return {
      error,
      reason: '401 response rejected the discovered/unconfigured peer identity',
    };
  }
  return undefined;
}

/**
 * The peer→channel binding a claim was drawn on, carried back out of claim
 * resolution so a refused claim can name the record to retire
 * (toon-client#581). Exactly the three values
 * {@link ChannelManager.evictBinding} needs to identify a binding.
 */
interface ClaimBinding {
  peerId: string;
  negotiation: PeerNegotiation;
  channelId: string;
}

/** One announce's claim on a destination, as {@link outranks} compares them. */
interface TerminatorClaim {
  /** The announcing peer's `httpEndpoint` — its client edge. */
  endpoint: string;
  /** Segment count of the claiming address: how specific the claim is. */
  segments: number;
  /** Whether the claiming address is the announce's primary (`ilpAddresses[0]`). */
  isPrimary: boolean;
  /** The announcing peer's pubkey — for looking up its `requiredTransport` (issue #558). */
  pubkey: string;
  /**
   * The announcing peer's connector peer id (`nostr-<pubkey16>`) — the SAME id
   * `BootstrapService` keys its results under, so a claim can be matched
   * against `peerNegotiations` (issue #565).
   */
  peerId: string;
  /** The announce itself — the counterparty's own settlement facts (issue #565). */
  peerInfo: IlpPeerInfo;
}

/** Whether `claim` beats `best`: more specific first, then primary over secondary. */
function outranks(claim: TerminatorClaim, best: TerminatorClaim): boolean {
  if (claim.segments !== best.segments) return claim.segments > best.segments;
  return claim.isPrimary && !best.isPrimary;
}

/**
 * The `httpEndpoint` of whichever discovered peer's announce (kind:10032)
 * TERMINATES `destination` — i.e. resolution the way ADR 0022 requires:
 * destination → the announce whose `ilpAddress`/`ilpAddresses` claims it →
 * that announce's `httpEndpoint`. `ilpAddresses` is absent on pre-Epic-7
 * events, so `[ilpAddress]` is the documented fallback (`IlpPeerInfo`).
 *
 * When more than one claim matches, the MOST SPECIFIC (longest) address
 * wins — the same longest-prefix rule ILP routing uses elsewhere. A tie
 * between two announces claiming the identical address is broken toward the
 * one where that address is PRIMARY (`ilpAddresses[0]`): a peer that lists an
 * address only as a secondary entry is declaring a forwarding ROUTE for it,
 * not owning its identity (toon-client#526's own acceptance criterion).
 *
 * `undefined` when no discovered announce claims `destination` at all — the
 * caller's job to fall back to the posting edge in that case.
 */
function resolveTerminatorHttpEndpoint(
  destination: string,
  peers: readonly DiscoveredPeer[],
  policy: AnnounceEndpointPolicy,
  unreachable?: UnreachableAnnounceEndpoint[]
): string | undefined {
  return findBestTerminatorClaim(destination, peers, policy, unreachable)
    ?.endpoint;
}

/**
 * The winning {@link TerminatorClaim} for `destination` — the same
 * most-specific/primary-tiebreak search {@link resolveTerminatorHttpEndpoint}
 * exposes as just an endpoint, kept here so a caller can also read WHICH
 * peer won (its pubkey), e.g. to check whether that peer's announce declares
 * `requiredTransport` (issue #558). `undefined` when no discovered announce
 * claims `destination` at all.
 *
 * An announce whose `httpEndpoint` is unreachable-by-construction for THIS
 * reader — a loopback or link-local host, see `announce-reachability.ts` — is
 * skipped as if it had never claimed the destination (toon-client#593), and
 * recorded in `unreachable` so the caller can say WHY it refused rather than
 * letting the client dial its own machine. A `kind:10032` is served forever
 * (the relay implements neither NIP-40 expiry nor NIP-09 deletion), so a
 * dead node's `ws://127.0.0.1:…` claim outlives the node itself and would
 * otherwise win this search unopposed.
 */
function findBestTerminatorClaim(
  destination: string,
  peers: readonly DiscoveredPeer[],
  policy: AnnounceEndpointPolicy,
  unreachable?: UnreachableAnnounceEndpoint[]
): TerminatorClaim | undefined {
  let best: TerminatorClaim | undefined;
  for (const { peerInfo, pubkey, peerId } of peers) {
    const httpEndpoint = peerInfo.httpEndpoint;
    if (!httpEndpoint) continue;
    const refusal = rejectedAnnounceEndpoint(httpEndpoint, policy);
    if (refusal) {
      if (
        unreachable &&
        !unreachable.some((u) => u.endpoint === refusal.endpoint)
      ) {
        unreachable.push(refusal);
      }
      continue;
    }
    const addresses = peerInfo.ilpAddresses ?? [peerInfo.ilpAddress];
    for (const [index, address] of addresses.entries()) {
      if (!claimsTermination(peerInfo, address, destination)) continue;
      const claim: TerminatorClaim = {
        endpoint: httpEndpoint,
        segments: address.split('.').length,
        isPrimary: index === 0,
        pubkey,
        peerId,
        peerInfo,
      };
      if (!best || outranks(claim, best)) best = claim;
    }
  }
  return best;
}

/**
 * Canonical id for chain-negotiation comparisons (#500): `evm:base:84532`
 * (the family-qualified form — what `@toon-protocol/core`'s
 * `resolveClientNetwork` emitted before 3.2.1, and what callers may still
 * have stored in their own config) and `evm:84532` (the unqualified form the
 * live devnet apex's `kind:10032` announce uses, what core >=3.2.1 now emits
 * too, and what `rig`'s own README tables show) name the SAME deployed chain —
 * only the numeric chain id disambiguates on-chain. Solana/Mina ids
 * (`solana:devnet`, `mina:devnet`) have no such qualifier drift and pass
 * through unchanged. The unqualified form is canonical (it's what the
 * network actually announces); qualified strings collapse onto it for
 * comparison only — this never rewrites a chain string a caller stored.
 */
function canonicalChainId(chain: string): string {
  const parts = chain.split(':');
  return parts[0] === 'evm' && parts.length >= 3 ? `evm:${parts[2]}` : chain;
}

/**
 * Looks up `chain` in `map` by exact key first, falling back to a
 * canonical-id match (#500) so a value keyed under a family-qualified form
 * (`evm:base:84532`) is still found when `chain` is the unqualified announce
 * form (`evm:84532`), or vice versa.
 */
function lookupByCanonicalChain(
  map: Record<string, string> | undefined,
  chain: string
): string | undefined {
  if (!map) return undefined;
  if (map[chain] !== undefined) return map[chain];
  const canonical = canonicalChainId(chain);
  for (const [key, value] of Object.entries(map)) {
    if (canonicalChainId(key) === canonical) return value;
  }
  return undefined;
}

/**
 * Internal state for ToonClient after initialization.
 */
interface ToonClientState {
  bootstrapService: BootstrapService;
  discoveryTracker: DiscoveryTracker;
  /**
   * The feed for `discoveryTracker` — see {@link subscribeToDiscovery}. The
   * tracker owns no subscription of its own, so without this it is
   * constructed but never fed (toon-client#550).
   */
  discoverySubscription: DiscoverySubscription;
  runtimeClient: IlpClient;
  peersDiscovered: number;
  btpClient?: BtpRuntimeClient | BtpPaidWriteTransport;
  /**
   * The raw BTP session, unwrapped even when `btpClient` is a
   * `BtpPaidWriteTransport` — used to declare a channel on the live session
   * (toon-client#513) since the wrapper doesn't expose `reauthenticate`.
   */
  btpSession?: BtpRuntimeClient;
}

/**
 * ToonClient - High-level client for interacting with TOON network.
 *
 * This story implements HTTP mode only. Embedded mode will be added in a future epic.
 *
 * @example HTTP Mode
 * ```typescript
 * import { ToonClient } from '@toon-protocol/client';
 * import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
 * import { encodeEvent, decodeEvent } from '@toon-protocol/relay';
 *
 * const secretKey = generateSecretKey();
 * const pubkey = getPublicKey(secretKey);
 *
 * const client = new ToonClient({
 *   connectorUrl: 'http://localhost:8080',
 *   secretKey,
 *   ilpInfo: {
 *     pubkey,
 *     ilpAddress: `g.toon.${pubkey.slice(0, 8)}`,
 *     btpEndpoint: 'ws://localhost:3000',
 *   },
 *   toonEncoder: encodeEvent,
 *   toonDecoder: decodeEvent,
 * });
 *
 * await client.start(); // Bootstrap peers, start monitoring
 *
 * // Publish to default destination (from config)
 * await client.publishEvent(signedEvent);
 *
 * // Publish to specific destination (multi-hop routing)
 * await client.publishEvent(signedEvent, { destination: 'g.toon.peer1' });
 *
 * await client.stop(); // Cleanup
 * ```
 */
export class ToonClient {
  private readonly config: ResolvedConfig;
  private state: ToonClientState | null = null;
  /**
   * The most recently parsed `toon-channel` x402 accepts entry, from the last
   * `h402Fetch` call that saw a `402` (issue #506) — including its `extra`
   * bag (e.g. `session_lease_ttl_ms`). Captured whether or not that fetch
   * went on to pay, so a caller can read the negotiated terms via
   * {@link getLastX402Terms} without re-issuing the probe by hand.
   */
  private lastX402Terms?: ToonChannelAccept;
  /**
   * The most recently parsed `ConnectorRouteTerms`, from the last
   * `negotiateFromGreeting` call — the greeting parse that ordinary channel
   * bootstrap (`publishEvent`/`openChannel`/`adoptChannel`) already goes
   * through, with no separate `h402Fetch` probe needed (issue #509).
   * Captured whether or not the greeting carried settlement facts to
   * bootstrap from, so its `extra` bag (e.g. `session_lease_ttl_ms`) is
   * readable via {@link getLastConnectorRouteTerms} even when the bootstrap
   * declined to open a channel from that greeting.
   */
  private lastConnectorRouteTerms?: ConnectorRouteTerms;
  /**
   * The channel most recently opened (via `openChannel()`) or adopted (via
   * `adoptChannel()`) — the one declared on the BTP session so a connector
   * crediting earned increments knows which channel to pay (toon-client#513,
   * connector#790). Read by `buildChannelDeclaration`'s `getChannelDeclaration`
   * hook on every auth greeting, including a reconnect's, so a fresh session
   * re-declares it without this client tracking reconnects itself.
   */
  private declaredChannelId?: string;
  private readonly evmSigner?: EvmSigner;
  private solanaSigner?: SolanaSigner;
  /**
   * Ed25519 signing seed (32 bytes) derived from the mnemonic for the Solana
   * identity. Retained so `start()` can inject it into the on-chain channel
   * client's Solana config (same key as `solanaSigner`).
   */
  private solanaSeed?: Uint8Array;
  private minaSigner?: MinaSigner;
  /**
   * Mina private key (big-endian hex scalar, as `deriveFullIdentity` emits)
   * derived from the mnemonic. Retained so `start()` can inject it into the
   * on-chain channel client's Mina config (same key as `minaSigner`).
   */
  private minaPrivateKey?: string;
  private channelManager?: ChannelManager;
  /** Concrete on-chain client, kept so deposit/withdraw can reach chain methods. */
  private onChainChannelClient?: OnChainChannelClient;
  private readonly peerNegotiations = new Map<string, PeerNegotiation>();
  /**
   * Peers whose x402 greeting advertised a Solana settlement leg that this
   * client could not weigh, because `config.solanaChannel` is unset and
   * {@link getBalances} therefore reports no Solana balance at all (issue
   * #474). The EVM leg was taken by default for these; if opening it then
   * fails for lack of funds, {@link withSolanaLegHint} says so.
   */
  private readonly unreadableSolanaLegs = new Set<string>();
  /**
   * Asks terminating connectors for their identity key, caching one per
   * client edge. A packet cannot be formed without the key of the connector
   * that terminates it (ADR 0018), so this is reached on every paid write.
   */
  private readonly connectorEdge = new ConnectorEdgeClient({
    // Resolve `fetch` per call rather than binding it once: a host that
    // installs its own global (and a test that swaps one in) must be the one
    // this reaches, whenever it is reached.
    fetch: (input, init) => globalThis.fetch(input, init),
  });

  /**
   * Creates a new ToonClient instance.
   *
   * @param config - Client configuration
   * @throws {ValidationError} If configuration is invalid
   */
  constructor(config: ToonClientConfig) {
    // Validate config (will reject embedded mode, require connectorUrl)
    validateConfig(config);

    // Apply defaults to optional fields (auto-generates secretKey if needed)
    this.config = applyDefaults(config);

    // Create EVM signer if private key provided
    if (this.config.evmPrivateKey) {
      this.evmSigner = new EvmSigner(this.config.evmPrivateKey);
    }
  }

  /**
   * Generates a new Nostr keypair.
   *
   * @returns Object with secretKey (Uint8Array) and pubkey (hex string)
   */
  static generateKeypair(): { secretKey: Uint8Array; pubkey: string } {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    return { secretKey, pubkey };
  }

  /**
   * Gets the Nostr public key derived from the secret key.
   * Works before start() is called.
   */
  getPublicKey(): string {
    return getPublicKey(this.config.secretKey);
  }

  /**
   * The ILP address this client RECEIVES on — the id its BTP session is bound
   * under at the connector, and therefore the only address a remote party can
   * address a PREPARE to and have it delivered here.
   *
   * Derived exactly as `modes/http.ts` derives the BTP greeting `peerId`
   * (`config.btpPeerId ?? config.ilpInfo.ilpAddress`), because that string is
   * what the connector binds the session under **verbatim** and resolves by
   * **exact match** — `connector/crates/connector-client-edge/src/btp.rs`
   * (`auth_peer_id` → `session_registry.bind`) and
   * `session_registry.rs`'s `resolve` (a `HashMap::get`, not a prefix walk).
   * There is no IL-DCP assignment and no frame that tells a client its
   * address: the client is authoritative for its own.
   *
   * Read by the rolling-swap RFQ sender (toon-client#585) as the default
   * `senderIlpAddress` — the destination the maker addresses every leg-B
   * PREPARE of a session to, which it uses verbatim and has no fallback for.
   * Works before `start()` is called.
   */
  getOwnIlpAddress(): string {
    return this.config.btpPeerId ?? this.config.ilpInfo.ilpAddress;
  }

  /**
   * This client's own ADR 0018 sealing public key — the 65-byte uncompressed
   * secp256k1 identity a buyer seals a job PREPARE's `data` to when this
   * client IS the destination (toon-client#537, toon-meta#266 §3.1/§7), in
   * the same format a real connector reports from `GET /ilp/identity`
   * (`ConnectorIdentity.publicKey`). Publish it as a `kind:31990`
   * advertisement's `seal_pubkey` tag ({@link getSealingPublicKeyHex}) so a
   * buyer can address this client without a `GET /identity` it cannot serve
   * behind NAT (ADR 0022).
   *
   * Derived from the same `secretKey` as {@link getPublicKey}'s Nostr
   * identity — stable across daemon restarts and reconnects, never a fresh
   * key per call, so a durable advertisement stays valid. Works before
   * `start()` is called.
   */
  getSealingPublicKey(): Uint8Array {
    return giftWrapPublicKey(this.config.secretKey);
  }

  /** {@link getSealingPublicKey}, hex-encoded — the exact `seal_pubkey` tag value. */
  getSealingPublicKeyHex(): string {
    return toHex(this.getSealingPublicKey());
  }

  /**
   * Sign an unsigned Nostr event template with the client's Nostr secret key,
   * returning a fully-signed event (id + pubkey + sig).
   *
   * This is the key primitive behind the daemon's sign-and-publish path: a UI
   * or agent supplies only `{ kind, content, tags, created_at }` and never holds
   * the private key — signing happens here, inside the key owner.
   */
  signEvent(template: EventTemplate): NostrEvent {
    return finalizeEvent(template, this.config.secretKey);
  }

  /**
   * Unwrap a NIP-59 gift wrap (kind:1059) addressed to this client's own
   * Nostr identity, decrypting both NIP-44 layers with the identity's secret
   * key. The secret key never leaves this call — only the decrypted rumor
   * and the seal's (signature-verified) signer pubkey come back out.
   *
   * Backs the daemon's `POST /nip59-unwrap` control-API endpoint (buzz#19
   * agent-members receiving gift-wrapped channel keys addressed to the
   * daemon's identity). Callers MUST validate authorship from the returned
   * `sealPubkey` — never from `wrap.pubkey`, which NIP-59 mints fresh and
   * throws away per wrap.
   *
   * @throws {GiftWrapAddressError} malformed input, wrong kind, or not
   *   addressed to this identity.
   * @throws {GiftWrapDecryptError} a NIP-44 layer failed to decrypt, or the
   *   seal's signature didn't verify.
   */
  unwrapGiftWrap(wrap: NostrEvent): UnwrappedGiftWrap {
    return unwrapGiftWrapWithKey(
      this.config.secretKey,
      this.getPublicKey(),
      wrap
    );
  }

  /**
   * Upload bytes to Arweave via the kind:5094 blob-storage DVM (single-packet),
   * signing the request with this client's Nostr key and paying through its
   * existing channel. Returns the Arweave tx id on success.
   *
   * Backs the daemon's `upload-media` path: the key and claim/channel plumbing
   * stay inside the client; callers pass only the bytes.
   */
  async uploadBlob(params: {
    blobData: Uint8Array;
    contentType?: string;
    bid?: string;
    destination?: string;
    ilpAmount?: bigint;
  }): Promise<RequestBlobStorageResult> {
    return requestBlobStorage(this, this.config.secretKey, params);
  }

  /**
   * Per-chain settlement readiness for the configured `network` tier, mirroring
   * the relay node's status. Returns `undefined` when no named `network` is
   * set (or `network: 'custom'`), since there is no preset tier to report on.
   */
  getNetworkStatus(): NetworkFamilyStatus | undefined {
    return getNetworkStatus(this.config);
  }

  /**
   * Gets the EVM address derived from the Nostr secret key (or explicit evmPrivateKey override).
   */
  getEvmAddress(): string | undefined {
    return this.evmSigner?.address;
  }

  /**
   * Gets the Solana (base58) address, when the client was constructed from a
   * `mnemonic`. Available only AFTER `start()` (Solana keys are derived
   * asynchronously). Returns undefined otherwise.
   */
  getSolanaAddress(): string | undefined {
    return this.solanaSigner?.signerIdentifier;
  }

  /**
   * Gets the Mina (base58) address, when the client was constructed from a
   * `mnemonic` AND `mina-signer` is installed. Available only AFTER `start()`.
   * Returns undefined otherwise.
   */
  getMinaAddress(): string | undefined {
    return this.minaSigner?.signerIdentifier;
  }

  /**
   * Derive the Solana/Mina keys from the mnemonic and register their signers on
   * the ChannelManager. Mirrors how the EVM signer is wired, but for the
   * non-secp256k1 chains. Skips any chain whose optional dependency is missing.
   */
  private async registerMnemonicChainSigners(
    mnemonic: string,
    accountIndex = 0
  ): Promise<void> {
    if (!this.channelManager) return;
    const identity = await deriveFullIdentity(mnemonic, accountIndex);

    // Solana: @noble/curves Ed25519 expects a 32-byte seed; deriveFullIdentity
    // returns a 64-byte keypair (seed||pubkey).
    if (identity.solana.publicKey) {
      const seed = identity.solana.secretKey.slice(0, 32);
      this.solanaSeed = seed;
      this.solanaSigner = new SolanaSigner(seed, identity.solana.publicKey);
      this.channelManager.registerChainSigner('solana', this.solanaSigner);
    }

    // Mina: only present when mina-signer is installed (optional dep).
    if (identity.mina.publicKey) {
      this.minaPrivateKey = identity.mina.privateKey;
      // Pass the configured GraphQL URL so the signer can read the channel's
      // on-chain `depositTotal` and bind the conserved `balanceB = depositTotal
      // − balanceA` commitment that a funded zkApp requires (connector#133);
      // without it Mina claims use the legacy balanceB=0 form and a funded zkApp
      // rejects them (F06 - Invalid zk-SNARK proof on claim).
      this.minaSigner = new MinaSigner(
        identity.mina.privateKey,
        identity.mina.publicKey,
        this.config.minaChannel?.graphqlUrl
          ? { graphqlUrl: this.config.minaChannel.graphqlUrl }
          : undefined
      );
      this.channelManager.registerChainSigner('mina', this.minaSigner);
    }
  }

  /**
   * Starts the ToonClient.
   *
   * This will:
   * 1. Initialize HTTP mode components (runtime client, admin client, bootstrap, monitor)
   * 2. Bootstrap the network (discover peers, register, and open channels)
   * 3. Start monitoring relay for new peers (kind:10032 events)
   *
   * @returns Result with number of peers discovered and mode
   * @throws {ToonClientError} If client is already started
   * @throws {ToonClientError} If initialization fails
   */
  async start(): Promise<ToonStartResult> {
    if (this.state !== null) {
      throw new ToonClientError('Client already started', 'INVALID_STATE');
    }

    try {
      // Create channel manager FIRST (before bootstrap) so it can sign claims during settlement
      if (this.evmSigner) {
        const store = this.config.channelStorePath
          ? new JsonFileChannelStore(this.config.channelStorePath)
          : undefined;
        // `initialDeposit`/`settlementTimeout` are documented ToonClientConfig
        // knobs; thread them through so the collateral an open locks is
        // configurable on every chain (they were previously accepted and
        // silently dropped, pinning every open to ChannelManager's defaults).
        this.channelManager = new ChannelManager(this.evmSigner, store, {
          ...(this.config.initialDeposit !== undefined
            ? { initialDeposit: this.config.initialDeposit }
            : {}),
          ...(this.config.settlementTimeout !== undefined
            ? { settlementTimeout: this.config.settlementTimeout }
            : {}),
        });

        // When constructed from a mnemonic, derive the non-secp256k1 keys
        // (Solana Ed25519, Mina Pallas) and register their signers so the
        // client can settle on those chains too. Derivation is async (dynamic
        // imports + optional deps), hence done here rather than in the
        // synchronous constructor. Gracefully skips a chain whose optional dep
        // is absent (e.g. mina-signer) — deriveFullIdentity leaves it empty.
        if (this.config.mnemonic) {
          await this.registerMnemonicChainSigners(
            this.config.mnemonic,
            this.config.mnemonicAccountIndex ?? 0
          );
        }
      }

      // Initialize HTTP mode components
      const initialization = await initializeHttpMode(this.config, {
        getChannelDeclaration: () => this.buildChannelDeclaration(),
      });

      const {
        bootstrapService,
        discoveryTracker,
        runtimeClient,
        btpClient,
        btpSession,
      } = initialization;

      // Open the tracker's feed BEFORE bootstrap, so announces are landing
      // while bootstrap does its network work rather than only after it
      // (toon-client#550 — see `subscribeToDiscovery` for why the tracker
      // needs feeding at all, and why it takes `config.relayUrl` AND every
      // `knownPeers[].relayUrl` rather than just the former).
      const discoverySubscription = await subscribeToDiscovery(
        [
          this.config.relayUrl,
          ...(this.config.knownPeers ?? []).map((peer) => peer.relayUrl),
        ],
        discoveryTracker
      );

      // Wire claim signer to bootstrap service if we have channel manager
      if (this.channelManager) {
        const cm = this.channelManager;
        const nostrPubkey = this.getPublicKey();
        // Derive default chain context from config (first supported chain)
        const defaultChainCtx = this.getDefaultChainContext();
        bootstrapService.setClaimSigner(
          async (channelId: string, amount: bigint) => {
            // Track the channel if not already tracked
            if (!cm.isTracking(channelId)) {
              cm.trackChannel(channelId, defaultChainCtx);
            }
            // Sign balance proof and build full claim message with the
            // chain-appropriate signer (the channel is tracked above, so a
            // non-EVM channel yields its correct envelope, not an EVM claim).
            const proof = await cm.signBalanceProof(channelId, amount);
            const signer = cm.getSignerForChannel(channelId);
            return signer.buildClaimMessage(proof, nostrPubkey);
          }
        );
      }

      // Start bootstrap process (discover peers, register with settlement, announce)
      const bootstrapResults = await bootstrapService.bootstrap();

      // Store negotiation metadata from bootstrap results for lazy channel opening
      for (const result of bootstrapResults) {
        if (result.negotiatedChain && result.settlementAddress) {
          const chainType = result.negotiatedChain.split(':')[0] ?? 'evm';
          const parts = result.negotiatedChain.split(':');
          // Accept 3-part `evm:{network}:{chainId}` and 2-part `evm:{chainId}`.
          const chainId =
            parts.length >= 3
              ? parseInt(parts[2] ?? '0', 10)
              : parts.length >= 2
                ? parseInt(parts[1] ?? '0', 10)
                : 0;
          const r = result as typeof result & {
            tokenAddress?: string;
            tokenNetwork?: string;
          };
          this.peerNegotiations.set(result.registeredPeerId, {
            chain: result.negotiatedChain,
            chainType,
            chainId: isNaN(chainId) ? 0 : chainId,
            settlementAddress: result.settlementAddress,
            tokenAddress: r.tokenAddress,
            tokenNetwork: r.tokenNetwork,
          });
        } else if (
          result.registeredPeerId &&
          !this.peerNegotiations.has(result.registeredPeerId)
        ) {
          // Lightweight client fallback: bootstrap discovered the peer but didn't
          // negotiate a chain (no connector admin to register with). Extract the
          // peer's settlement info from their kind:10032 event data and match
          // against our supported chains. `negotiationFromAnnounce` still throws
          // CHAIN_NOT_SUPPORTED when nothing is mutually supported, unchanged.
          const announced = this.negotiationFromAnnounce(
            result.peerInfo,
            result.registeredPeerId
          );
          if (announced) {
            this.peerNegotiations.set(result.registeredPeerId, announced);
          }
        }
        // Track any pre-opened channels (backwards compat)
        if (
          this.channelManager &&
          result.channelId &&
          !this.channelManager.isTracking(result.channelId)
        ) {
          const chainCtx = this.getChainContext(result.negotiatedChain);
          this.channelManager.trackChannel(result.channelId, chainCtx);
        }
      }

      // Wire on-chain channel client into ChannelManager for lazy opens
      if (this.channelManager && initialization.onChainChannelClient) {
        this.onChainChannelClient = initialization.onChainChannelClient;
        this.channelManager.setChannelClient(
          initialization.onChainChannelClient
        );

        // Late-bind the Solana channel config: the program/RPC/token come from
        // config, the Ed25519 keypair from the mnemonic-derived Solana seed.
        // Requires both a Solana seed (mnemonic-derived) and explicit
        // solanaChannel config — otherwise the on-chain Solana opener has no
        // program/RPC and would throw at openChannel time.
        if (this.config.solanaChannel && this.solanaSeed) {
          initialization.onChainChannelClient.setSolanaConfig({
            rpcUrl: this.config.solanaChannel.rpcUrl,
            programId: this.config.solanaChannel.programId,
            tokenMint: this.config.solanaChannel.tokenMint,
            challengeDuration: this.config.solanaChannel.challengeDuration,
            deposit: this.config.solanaChannel.deposit,
            keypair: this.solanaSeed,
          });
        }

        // Late-bind the Mina channel config (parallel to Solana). The
        // graphqlUrl + zkAppAddress come from config; the Mina private key from
        // the mnemonic-derived Mina identity (same key as the registered Mina
        // signer). Requires both a Mina private key (mnemonic-derived, present
        // only when `mina-signer` is installed) and explicit minaChannel config.
        //
        // openMinaChannel now performs a REAL on-chain channel open
        // (initialize + optional deposit) on the deployed zkApp so the
        // connector's getChannelState reports `opened` and the claim verifies +
        // stores (parity with Solana). Full on-chain Mina SETTLE remains gated by
        // the connector-side settlement-executor (same blocker as Solana).
        if (this.config.minaChannel && this.minaPrivateKey) {
          initialization.onChainChannelClient.setMinaConfig({
            graphqlUrl: this.config.minaChannel.graphqlUrl,
            ...(this.config.minaChannel.zkAppAddress !== undefined
              ? { zkAppAddress: this.config.minaChannel.zkAppAddress }
              : {}),
            ...(this.config.minaChannel.autoDeploy !== undefined
              ? { autoDeploy: this.config.minaChannel.autoDeploy }
              : {}),
            privateKey: this.minaPrivateKey,
            ...(this.config.minaChannel.challengeDuration !== undefined
              ? { challengeDuration: this.config.minaChannel.challengeDuration }
              : {}),
            ...(this.config.minaChannel.tokenId !== undefined
              ? { tokenId: this.config.minaChannel.tokenId }
              : {}),
            ...(this.config.minaChannel.deposit !== undefined
              ? { deposit: this.config.minaChannel.deposit }
              : {}),
            ...(this.config.minaChannel.networkId !== undefined
              ? { networkId: this.config.minaChannel.networkId }
              : {}),
          });
        }
      }

      // Store state
      this.state = {
        bootstrapService,
        discoveryTracker,
        discoverySubscription,
        runtimeClient,
        peersDiscovered: bootstrapResults.length,
        btpClient: btpClient ?? undefined,
        btpSession: btpSession ?? undefined,
      };

      return {
        peersDiscovered: bootstrapResults.length,
        mode: 'http',
      };
    } catch (error) {
      throw new ToonClientError(
        'Failed to start client',
        'INITIALIZATION_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Publishes a Nostr event through the connector that terminates
   * `destination`, as a sealed, condition-bearing paid write (ADR 0018/0019).
   *
   * What crosses the wire, in order:
   *
   * 1. **The terminating connector's identity is fetched first.** `data` is
   *    sealed to that key, so a packet cannot be formed without it — and
   *    there is no default to fall back to, because sealing to the wrong key
   *    is a confidentiality failure that merely presents as undeliverable.
   * 2. **The price is ASKED for, not computed.** ADR 0020 makes a price flat
   *    per handler, so `GET /ilp/routes/price` — the same longest-prefix
   *    lookup the claim gate charges against — is the only thing that can
   *    state what this write costs. `options.ilpAmount` still overrides.
   * 3. **The event becomes an OER `EnvelopeRequest`** — `POST <proxyPath>`
   *    carrying `{"event": …}` — never HTTP text.
   * 4. **The PREPARE carries a real execution condition**, minted as
   *    `sha256` of the fulfilment derived from the secret sealed inside the
   *    wrap. The transport verifies the returned preimage against it, so a
   *    FULFILL nobody could have earned is counted failed rather than
   *    accepted.
   * 5. **The answer is opened with that same secret.** A FULFILL carries a
   *    sealed response envelope; a REJECT sealed at the termination means the
   *    destination refused, and a plaintext one means somebody on the path
   *    did. `refusedBy` keeps those apart.
   *
   * An HTTP status inside the response envelope is envelope CONTENT, not a
   * packet outcome (ADR 0020): a 404 rides home on a FULFILL and value moved.
   * This method still reports a non-2xx as `success: false` — the event did
   * not persist — but `response` is populated either way, so a caller can see
   * exactly what it paid for.
   *
   * @param event - Signed Nostr event to publish
   * @param options - Optional destination, claim, amount and request target
   * @throws {ToonClientError} If the client is not started, the terminating
   *   connector's identity or route price cannot be obtained, or the send
   *   fails outright.
   */
  async publishEvent(
    event: NostrEvent,
    options?: {
      destination?: string;
      claim?: SignedBalanceProof;
      ilpAmount?: bigint;
      /** Sub-path resolved strictly BENEATH the route's handler path (ADR
       *  0025). Default '' — the handler's own path, correct whenever the
       *  destination terminates at exactly one endpoint. Never absolute:
       *  a leading '/' is refused by the connector (F00). */
      proxyPath?: string;
    }
  ): Promise<PublishEventResult> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    try {
      const destination =
        options?.destination ?? this.config.destinationAddress;
      const edge = this.resolveClientEdgeEndpoint();

      // (1) The key first — no packet exists without it. Resolved from the
      // connector that TERMINATES `destination`, never the posting edge: for
      // a forwarded prefix those are different machines, and sealing to the
      // forwarder's key is a confidentiality failure the wire only reports
      // as an undeliverable packet (issue #526).
      // Asked FOR this destination (connector #1026): a forwarding edge
      // answers with the terminating connector's own signed statement,
      // verified before it is sealed to; without one the posting edge's key
      // is what it always was.
      const identity = await this.connectorEdge.getIdentity(
        this.resolveTerminatorEndpoint(destination),
        { destination }
      );

      // (2) The price is ASKED for, not computed. ADR 0020 makes a price flat
      // per handler — the route table is the price list — so there is no
      // per-byte rate to multiply and nothing local that could disagree with
      // what the connector will actually charge. An explicit `ilpAmount`
      // still overrides, and never triggers the lookup.
      const amount =
        options?.ilpAmount !== undefined
          ? String(options.ilpAmount)
          : String(await this.routePriceFor(edge, destination));

      // (3)+(4) One call mints the envelope's seal and the condition that
      // matches it, so the two can never drift apart.
      const exchange = sealExchange(
        {
          method: 'POST',
          // ADR 0025 (connector #596): the envelope target is resolved
          // STRICTLY BENEATH the route's configured handler path — it can
          // extend that path, never replace it. '' means "the handler's own
          // path", which is the whole answer for a route that terminates at
          // exactly one endpoint (g.rust.relay → …/write, g.rust.store →
          // …/store): the DESTINATION picks the endpoint, not the target.
          // An absolute target like '/write' is refused as an escape
          // attempt (F00) before the app is ever reached.
          target: options?.proxyPath ?? '',
          headers: [['content-type', 'application/json']],
          body: encodeUtf8(JSON.stringify({ event })),
        },
        identity.publicKey
      );

      const transport = this.getClaimTransport(destination);
      const response = await this.sendPaidPacket(
        destination,
        transport,
        {
          destination,
          amount,
          data: toBase64(exchange.data),
          executionCondition: exchange.condition,
        },
        BigInt(amount),
        options?.claim
      );

      // (5) Open the answer with the secret this packet sealed.
      const outcome = readExchangeOutcome(
        response,
        response.data === undefined ? undefined : fromBase64(response.data),
        exchange.sharedSecret
      );

      if (outcome.kind === 'destination-refused') {
        return {
          success: false,
          refusedBy: 'destination',
          code: outcome.code,
          error: `Destination refused the write: ${outcome.code} - ${outcome.message}`,
        };
      }
      if (outcome.kind === 'path-refused') {
        return {
          success: false,
          refusedBy: 'path',
          code: outcome.code,
          error: `A connector on the path refused the write: ${outcome.code} - ${outcome.message}`,
        };
      }

      const { response: answer } = outcome;
      if (answer.status < 200 || answer.status >= 300) {
        const detail =
          answer.body.length > 0 ? ` - ${decodeUtf8(answer.body)}` : '';
        return {
          success: false,
          response: answer,
          error: `Write failed: the destination answered HTTP ${answer.status}${detail}`,
        };
      }

      return { success: true, eventId: event.id, response: answer };
    } catch (error) {
      console.error(
        '[ToonClient.publishEvent] ROOT CAUSE:',
        String(error),
        error instanceof Error ? error.stack : ''
      );
      // These conditions are raised before any packet exists and name a thing
      // the caller can fix: the destination is not terminated here, there is
      // no client edge to ask at all, no channel negotiation exists AND the
      // greeting-based bootstrap (connector #617) found nothing to synthesize
      // one from, or the settlement wallet cannot fund the one-time on-chain
      // channel open (`CHANNEL_FUNDING` — which carries the wallet, the chain,
      // and, for an unreadable Solana leg, the missing config, see
      // {@link withSolanaLegHint}). `BTP_REQUIRED` (issue #558) is the same
      // shape: the terminator's own announce ruled HTTP out before a packet
      // was formed. Wrapping any of them in `PUBLISH_ERROR` would hide the
      // one fact worth surfacing behind the most generic code this method
      // has. Everything else — including a connector that will not answer
      // for its identity — keeps the existing wrapping, so `PUBLISH_ERROR`
      // still means "the publish itself failed".
      if (
        error instanceof ToonClientError &&
        (error.code === 'NO_TERMINATED_ROUTE' ||
          error.code === 'NO_CONNECTOR_EDGE' ||
          error.code === 'PEER_NOT_NEGOTIATED' ||
          error.code === 'CHANNEL_FUNDING' ||
          error.code === 'TERMINATOR_UNRESOLVED' ||
          error.code === 'BTP_REQUIRED')
      ) {
        throw error;
      }
      throw new ToonClientError(
        'Failed to publish event',
        'PUBLISH_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * What a destination costs, asked of the connector that terminates it —
   * `null` when it terminates no route matching it.
   *
   * The public form of the lookup `publishEvent` makes, for callers that need
   * a price BEFORE they build a packet: a pre-push estimate that must equal
   * what the push will actually pay, a fee quote shown to a user for consent.
   * Since ADR 0020 a price is flat per handler, so the figure is the whole
   * fee for one packet to that destination — there is nothing to multiply it
   * by. Cached per destination, so this is cheap to call repeatedly.
   *
   * @throws {ToonClientError} NO_CONNECTOR_EDGE when no client edge is known.
   * @throws {ConnectorEdgeError} when the connector cannot be asked.
   */
  async getRoutePrice(destination: string): Promise<bigint | null> {
    const price = await this.connectorEdge.getRoutePrice(
      this.resolveClientEdgeEndpoint(),
      destination
    );
    return price === null ? null : price.price;
  }

  /**
   * What this destination costs, from the connector that terminates it.
   *
   * ADR 0020 makes a price flat per handler: one handler, one price, and an
   * app that wants to charge differently exposes more handlers. There is
   * therefore nothing to compute — the route table IS the price list, and
   * `GET /ilp/routes/price` is the same longest-prefix lookup the claim gate
   * charges against, so it can never state a price a real request would not
   * be charged.
   *
   * Cached per (edge, destination) by {@link ConnectorEdgeClient}, so this is
   * one round trip per destination rather than one per packet.
   *
   * @throws {ToonClientError} NO_TERMINATED_ROUTE when the connector answers
   *   `404` — it does not terminate this destination. That is a refusal to
   *   guess, not a zero: pricing an unroutable write at 0 (or at some local
   *   fallback rate) would send a packet certain to be rejected, and report
   *   the wrong reason for it.
   */
  private async routePriceFor(
    edge: string,
    destination: string
  ): Promise<bigint> {
    const price = await this.connectorEdge.getRoutePrice(edge, destination);
    if (price === null) {
      throw new ToonClientError(
        `The connector at ${edge} terminates no route for "${destination}", so it ` +
          'cannot say what a write there costs. Check the destination, or pass an ' +
          'explicit `ilpAmount` to price it yourself.',
        'NO_TERMINATED_ROUTE'
      );
    }
    return price.price;
  }

  /**
   * The client edge `/ilp/identity` and `/ilp/routes/price` hang off — the
   * same origin paid writes already POST `/ilp` to.
   *
   * Preferring the live transport's own endpoint over config is deliberate:
   * transport selection may have followed a discovered `httpEndpoint`, and
   * the identity must come from the connector actually being paid, not from
   * whatever URL was configured before discovery ran.
   *
   * @throws {ToonClientError} NO_CONNECTOR_EDGE when no origin is known.
   */
  private resolveClientEdgeEndpoint(): string {
    const runtime = this.state?.runtimeClient as
      | { clientEdgeEndpoint?: string }
      | undefined;
    const endpoint =
      runtime?.clientEdgeEndpoint ??
      this.config.proxyUrl ??
      this.config.connectorUrl;
    if (!endpoint) {
      throw new ToonClientError(
        'No connector client edge to ask for an identity. Configure `proxyUrl` or ' +
          '`connectorUrl`; a payload cannot be sealed without the terminating ' +
          "connector's key (ADR 0018).",
        'NO_CONNECTOR_EDGE'
      );
    }
    return connectorEdgeBaseUrl(endpoint);
  }

  /**
   * The client edge to fetch `destination`'s identity from — the connector
   * that TERMINATES it, not the one this client happens to be posting to
   * (issue #526). ADR 0022 makes identity answered-not-announced, so it is
   * fetched from the terminator's own `/ilp/identity`; discovery is only
   * used to find WHICH origin that is.
   *
   * Matches `destination` against every peer this client has discovered
   * announcing itself via kind:10032 — including ones never peered with,
   * since a forwarded prefix's terminator need not be a direct peer at all
   * (that is precisely the shape a forwarded prefix has). Falls back to the
   * posting edge only when there is no discovery tracker wired up AT ALL —
   * preserving the (still-common) same-node case where the posting node
   * terminates its own destination, and the only case that worked before
   * #526.
   *
   * Once a tracker exists, silence — whether zero peers discovered at all,
   * or peers discovered but none of them claiming `destination` — is treated
   * as a refusal, not a green light (toon-client#533): zero peers is not
   * evidence the posting edge terminates the destination, only the absence
   * of evidence that anything does, and that absence is exactly what
   * fail-closed exists for. It is also a live production window, not a
   * theoretical one: `discoveryTracker` is always constructed for a started
   * client, so a tracker reporting zero peers is what the startup race looks
   * like before the first announce lands. Likewise, an ancestor-only claim
   * (a router legitimately owning `g.toon`, which is not the same as owning
   * everything under it) used to slip through here and get treated as
   * coverage once a competing announce expired. `resolveTerminatorHttpEndpoint`'s
   * own claim-gating fixes that; the caller-visible half of the fix is this —
   * refusing to publish beats sealing to a key that cannot open the wrap,
   * for a defect whose symptom is "money spent, write lost".
   *
   * @throws {ToonClientError} NO_CONNECTOR_EDGE when no origin is known at
   *   all (propagated from {@link resolveClientEdgeEndpoint}).
   * @throws {ToonClientError} TERMINATOR_UNRESOLVED when a discovery tracker
   *   is present but no discovered announce claims `destination` — including
   *   when it has discovered no peers at all yet.
   */
  /**
   * Which endpoint zones this client will accept off a DISCOVERED announce
   * (toon-client#593). Derived once from the relays this client actually
   * subscribes for announces on — `config.relayUrl` plus every
   * `knownPeers[].relayUrl`, the same list `subscribeToDiscovery` is handed —
   * so a local stack (local relay ⇒ local peers) keeps working with no
   * configuration, while a loopback endpoint announced to a PUBLIC relay is
   * refused. `TOON_CLIENT_ALLOW_LOOPBACK_PEERS=1` is the explicit override
   * for a node that runs here but announces itself remotely.
   *
   * Memoized: the inputs cannot change over a client's life, and this is read
   * on every paid write.
   */
  private announceEndpointPolicy(): AnnounceEndpointPolicy {
    this.cachedAnnounceEndpointPolicy ??= announceEndpointPolicyFor({
      discoveredFrom: [
        this.config.relayUrl,
        ...(this.config.knownPeers ?? []).map((peer) => peer.relayUrl),
      ],
    });
    return this.cachedAnnounceEndpointPolicy;
  }

  private cachedAnnounceEndpointPolicy: AnnounceEndpointPolicy | undefined;

  private resolveTerminatorEndpoint(destination: string): string {
    const edge = this.resolveClientEdgeEndpoint();
    // Probed, not assumed: a client whose state was assembled without a full
    // tracker (a stub, a half-built runtime) still publishes — it just has
    // nothing to resolve against and falls back to the posting edge.
    const tracker: Partial<DiscoveryTracker> | undefined =
      this.state?.discoveryTracker;
    if (typeof tracker?.getAllDiscoveredPeers !== 'function') return edge;

    const peers = tracker.getAllDiscoveredPeers();
    const unreachable: UnreachableAnnounceEndpoint[] = [];
    const httpEndpoint = resolveTerminatorHttpEndpoint(
      destination,
      peers,
      this.announceEndpointPolicy(),
      unreachable
    );
    if (!httpEndpoint) {
      // Lead with the unreachable announces when there were any: "nobody
      // claims it" and "the only claimant advertises an address on YOUR
      // machine" are different problems with different fixes, and the second
      // one reads as a mystery unless it is said out loud (toon-client#593).
      const skipped =
        unreachable.length > 0
          ? ' ' +
            `${unreachable.length} announce(s) claiming it were IGNORED as ` +
            'unreachable from here: ' +
            unreachable.map((u) => u.reason).join(' ')
          : '';
      throw new ToonClientError(
        `No discovered announce terminates "${destination}" (${peers.length} ` +
          'peer(s) discovered, none claims it), so this client cannot confirm ' +
          'the posting edge is who it would be paying. Refusing to publish ' +
          'rather than seal to a key that may not be able to open the wrap.' +
          skipped,
        'TERMINATOR_UNRESOLVED'
      );
    }
    return connectorEdgeBaseUrl(httpEndpoint);
  }

  /**
   * Whether the announce that TERMINATES `destination` declares
   * `requiredTransport: "btp"` (issue #558) — the connector accepts `POST
   * /ilp` for identity/price reads, but rejects a PAID WRITE over HTTP with
   * `402 Payment Required` unless it rode a BTP session.
   *
   * `requiredTransport` is read off the announce's raw content by
   * `DiscoverySubscription.requiredTransportFor` (`discovery-subscription.ts`),
   * never through the parsed `IlpPeerInfo`: the installed
   * `@toon-protocol/core`'s `parseIlpPeerInfo` drops unknown fields, the same
   * gap toon-client#544 hit for `notice`. Silent `false` (never sealed HTTP is
   * fine) whenever a tracker, its winning claim, or the subscription's raw
   * feed is unavailable — this is an ADDITIONAL constraint on top of
   * `resolveTerminatorEndpoint`'s own claim gating, not a replacement for it.
   */
  private terminatorRequiresBtp(destination: string): boolean {
    // Probed, not assumed — as in {@link resolveTerminatorEndpoint}: a state
    // assembled without a full tracker/subscription (a stub, a half-built
    // runtime) simply has nothing to read the requirement off.
    const tracker: Partial<DiscoveryTracker> | undefined =
      this.state?.discoveryTracker;
    if (typeof tracker?.getAllDiscoveredPeers !== 'function') return false;
    const subscription: Partial<DiscoverySubscription> | undefined =
      this.state?.discoverySubscription;
    if (typeof subscription?.requiredTransportFor !== 'function') return false;

    const claim = findBestTerminatorClaim(
      destination,
      tracker.getAllDiscoveredPeers(),
      this.announceEndpointPolicy()
    );
    if (!claim) return false;
    return subscription.requiredTransportFor(claim.pubkey) === 'btp';
  }

  /**
   * Payment-aware HTTP fetch over TOON (issue #50). A `fetch()`-like method that
   * makes paying for an HTTP resource transparent:
   *
   *   1. Issues the HTTP request to `url`.
   *   2. On `402`, parses the x402 `accepts` array and selects the
   *      `toon-channel` entry (see {@link Http402Client} for the wire shape).
   *   3. Opens/reuses a payment channel for the entry's ILP destination (via
   *      ChannelManager), signs a balance proof for the demanded price, and
   *      re-sends the SAME HTTP request as a transparent HTTP-in-ILP packet to
   *      the connector's `POST /ilp` (via {@link HttpIlpClient}), with the claim
   *      in the `ILP-Payment-Channel-Claim` header.
   *   4. Reconstructs and returns a standard Web `Response` from the FULFILL
   *      `data`. The caller never sees ILP.
   *
   * If the origin offers no `toon-channel` entry, the original `402` Response is
   * returned unchanged (the caller sees the vanilla x402 challenge).
   *
   * The channel/claim plumbing is wired to the live ChannelManager + per-chain
   * signer via `resolveClaimForDestination` — identical to `publishEvent`. The
   * `amount` paid comes from the selected x402 entry (the resource's price).
   *
   * @throws {ToonClientError} If the client is not started.
   * @throws {ConnectorError} If the connector rejects the payment or returns no
   *   HTTP payload.
   */
  async h402Fetch(url: string, opts?: H402FetchOptions): Promise<Response> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    // Pay only when a channel manager is configured; otherwise the engine still
    // probes and transparently surfaces the vanilla 402 (no resolveClaim hook).
    const client = new Http402Client({
      // Share this client's identity cache rather than letting each per-call
      // engine fetch the same connector's key again: `h402Fetch` builds a
      // fresh Http402Client per call (below), and a paid request now needs a
      // terminating key.
      connectorEdge: this.connectorEdge,
      // Capture the negotiated terms (issue #506) regardless of the
      // pay/pass-through outcome — see `lastX402Terms`'s own doc comment.
      onChallenge: (challenge) => {
        this.lastX402Terms = challenge.toonChannel;
      },
      ...(this.channelManager
        ? {
            resolveClaim: (destination: string, amount: bigint) =>
              this.resolveClaimForDestination(destination, amount),
          }
        : {}),
    });

    return client.fetch(url, opts);
  }

  /**
   * The `toon-channel` accepts entry from the most recent `h402Fetch` 402
   * probe — including its `extra` bag (issue #506, e.g.
   * `extra.session_lease_ttl_ms`, connector#722) — or `undefined` if
   * `h402Fetch` has not yet been called or its last probe offered no
   * `toon-channel` entry. Captured whether or not that fetch went on to pay,
   * so a caller (e.g. buzz#84's mesh refresh cadence) can read the
   * negotiated terms without re-issuing a probe by hand.
   */
  getLastX402Terms(): ToonChannelAccept | undefined {
    return this.lastX402Terms;
  }

  /**
   * The `ConnectorRouteTerms` from the most recent ordinary channel
   * bootstrap (`publishEvent`/`openChannel`/`adoptChannel`, via
   * `negotiateFromGreeting`) — including its `extra` bag (issue #509, e.g.
   * `extra.session_lease_ttl_ms`, connector#722) — or `undefined` if no
   * greeting has been parsed on this path yet. Unlike
   * {@link getLastX402Terms}, this populates from a client that only ever
   * calls `start()`/`publishEvent()`: `ConnectorEdgeClient.getRouteTerms` is
   * the parser the live path actually negotiates through, so a caller does
   * not need to issue a separate `h402Fetch` probe purely to read the lease
   * TTL.
   */
  getLastConnectorRouteTerms(): ConnectorRouteTerms | undefined {
    return this.lastConnectorRouteTerms;
  }

  /**
   * Sends a raw swap ILP packet (Story 12.5) to a swap peer with an attached
   * balance-proof claim. This is a lower-level surface than `publishEvent`:
   * it forwards the raw `IlpSendResult` so the sender (`streamSwap()`) can
   * decode FULFILL metadata itself.
   *
   * Claim resolution mirrors `publishEvent`:
   *   (a) explicit `params.claim` -> use it,
   *   (b) `channelManager` present -> auto-open + auto-sign for the peer
   *       matching `destination`,
   *   (c) neither -> throw MISSING_CLAIM.
   *
   * A caller may supply a sender-chosen 32-byte `executionCondition`
   * (`C = sha256(P)`, one fresh preimage per packet — toon-client#350,
   * rolling-swap spec §3 R1/R2) and an explicit `expiresAt` (R7). Both are
   * set on the wire by either transport (HTTP `POST /ilp` and BTP), and on
   * FULFILL the transport verifies `sha256(fulfillment) == condition` —
   * a mismatch comes back as `accepted: false` (code F99), never a silent
   * accept. Omitting them keeps today's zero-condition legacy packet.
   *
   * @throws {ToonClientError} INVALID_STATE / NO_ILP_TRANSPORT / MISSING_CLAIM
   */
  async sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    timeout?: number;
    claim?: SignedBalanceProof;
    /** Sender-chosen 32-byte execution condition; absent/zero = legacy. */
    executionCondition?: Uint8Array;
    /** Explicit ILP expiry; defaults to `now + timeout` in the transport. */
    expiresAt?: Date;
  }): Promise<IlpSendResult> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }
    const transport = this.getClaimTransport(params.destination);

    return this.sendPaidPacket(
      params.destination,
      transport,
      {
        destination: params.destination,
        amount: String(params.amount),
        data: toBase64(params.toonData),
        timeout: params.timeout ?? 30000,
        ...(params.executionCondition
          ? { executionCondition: params.executionCondition }
          : {}),
        ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
      },
      params.amount,
      params.claim
    );
  }

  /**
   * Build a BTP claim message from a pre-signed balance proof using the
   * CHAIN-APPROPRIATE signer.
   *
   * The explicit-claim path (caller signs the balance proof, then passes
   * `{ claim }`) must wrap the proof with the signer matching the channel's
   * chain. Hardcoding `EvmSigner.buildClaimMessage` here produced an EVM
   * `BTPClaimMessage` for a Solana/Mina balance proof — no `blockchain`
   * discriminator and the base58 channel account placed in the EVM
   * `channelId` field — which the connector's inbound validator classifies
   * as EVM and rejects with F06 (`Invalid channelId format`).
   *
   * When the proof's `channelId` is tracked we use
   * `getSignerForChannel(channelId).buildClaimMessage`, which emits the
   * correct per-chain envelope (e.g. `blockchain:'solana'` + base58
   * `channelAccount`). When it is not tracked we fall back to the EVM signer
   * to preserve prior behavior for lightweight/EVM-only callers.
   *
   * EVM output is byte-identical to the previous hardcoded path (the EVM
   * adapter in `getSignerForChannel` delegates to the same
   * `EvmSigner.buildClaimMessage`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- claim message is opaque forwarded type
  private buildClaimMessageForProof(claim: SignedBalanceProof): any {
    if (this.channelManager?.isTracking(claim.channelId)) {
      const signer = this.channelManager.getSignerForChannel(claim.channelId);
      return signer.buildClaimMessage(claim, this.getPublicKey());
    }
    return EvmSigner.buildClaimMessage(claim, this.getPublicKey());
  }

  /**
   * Resolve the ILP transport for a paid (claim-bearing) write.
   *
   * The connector is a payment-proxy: paid writes carry an ILP PREPARE plus the
   * signed payment-channel claim. Either transport speaks the SAME claim
   * contract — the BTP `payment-channel-claim` protocolData entry and the
   * ILP-over-HTTP `ILP-Payment-Channel-Claim` header serialize the same claim
   * JSON — so we route through whichever transport is ACTIVE rather than
   * hard-requiring BTP.
   *
   * Selection (mirrors `modes/http.ts` runtime-client precedence):
   *   1. `runtimeClient` when it implements `sendIlpPacketWithClaim` — this is
   *      the HttpIlpClient (proxy `POST /ilp`) when a `proxyUrl`/
   *      `connectorHttpEndpoint` is configured, else the BtpRuntimeClient.
   *   2. `btpClient` as an explicit fallback (always present when `btpUrl` is set).
   *
   * `config.preferBtpForPaidWrites` (toon-client#482) SWAPS that order: when
   * set, `btpClient` — which `modes/http.ts` wraps in a
   * {@link BtpPaidWriteTransport} for this case, giving persistent,
   * strictly-ordered claim dispatch with its own fallback to `runtimeClient`
   * — is tried first, and `runtimeClient` remains as a second candidate.
   * Default `false` reproduces the exact precedence above, unchanged.
   *
   * The level-3 `HttpRuntimeClient` (connector-admin HTTP, no `btpUrl` AND no
   * proxy) does NOT implement `sendIlpPacketWithClaim`; in that case there is no
   * paid-write transport and we throw a clear, actionable error.
   *
   * `destination`, when given, is checked against {@link terminatorRequiresBtp}
   * FIRST, overriding both orderings above (issue #558): a terminating
   * announce that declares `requiredTransport: "btp"` gets `btpClient`
   * exclusively — never `runtimeClient`, even when HTTP would otherwise have
   * been tried first — because the connector enforces that requirement with
   * a `402` on every paid write, so a retry over HTTP can only ever repeat
   * the same failure. Omitting `destination` (or a tracker that cannot
   * resolve one) reproduces the exact precedence above, unchanged.
   *
   * @throws {ToonClientError} NO_ILP_TRANSPORT when no active transport can send
   *   a packet+claim.
   * @throws {ToonClientError} BTP_REQUIRED when `destination`'s terminator
   *   requires BTP but this client has no `btpClient` configured at all.
   */
  private getClaimTransport(destination?: string): ClaimSendingTransport {
    const state = this.state;
    if (!state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    if (destination !== undefined && this.terminatorRequiresBtp(destination)) {
      if (sendsClaims(state.btpClient)) return state.btpClient;
      throw new ToonClientError(
        `The connector terminating "${destination}" requires BTP for paid ` +
          'writes (its kind:10032 announce declares requiredTransport: ' +
          '"btp"), but this client has no BTP uplink (`btpUrl`) configured.',
        'BTP_REQUIRED'
      );
    }

    const candidates: (
      | IlpClient
      | BtpRuntimeClient
      | BtpPaidWriteTransport
      | undefined
    )[] = this.config.preferBtpForPaidWrites
      ? [state.btpClient, state.runtimeClient]
      : [state.runtimeClient, state.btpClient];
    for (const candidate of candidates) {
      if (sendsClaims(candidate)) return candidate;
    }
    throw new ToonClientError(
      'No ILP transport for paid writes. Configure `proxyUrl`/`connectorHttpEndpoint` ' +
        '(route through the connector proxy over ILP-over-HTTP) or `btpUrl` (BTP socket).',
      'NO_ILP_TRANSPORT'
    );
  }

  /**
   * Sends a claim-bearing PREPARE over the ALREADY-RESOLVED `transport` (a
   * prior {@link getClaimTransport} call — kept as a separate argument so the
   * NO_ILP_TRANSPORT/BTP_REQUIRED failure modes of resolving a transport at
   * all still surface before any claim is resolved, matching every caller's
   * existing behavior), retrying once over the BTP uplink when it comes back
   * with a transport signal that says so — {@link btpFallbackSignal}.
   *
   * {@link Http402RequiresBtpError} (issue #561) is the first such signal.
   * `getClaimTransport`'s own `requiredTransport` check ({@link
   * terminatorRequiresBtp}) reads the peer's kind:10032 announce — but the
   * live devnet relay's announce never carries that field, only its `402`
   * response does, and only once a write has already been posted over HTTP.
   * So the announce-based guard alone is dead code against that fleet: this
   * is the fallback that actually avoids the repeat-402 loop, discovered
   * live rather than assumed from the announce.
   *
   * `Http401RequiresBtpError` (issue #565) is the same shape of problem from
   * a different connector generation: the rust edge live on the two-box
   * devnet answers a discovered/unconfigured peer identity with a bare `401`
   * rather than the 402 x402 greeting, so it gets the identical retry — both
   * error types are transport-signal-only and neither implies the write
   * itself was invalid.
   *
   * A retry is attempted only when the failing transport was not already the
   * BTP one (neither error can come from the BTP transport in the first
   * place — BTP has no HTTP status codes) and a BTP uplink is actually
   * configured; otherwise this throws the same `BTP_REQUIRED` error
   * `getClaimTransport` throws for the announce-based case, so callers see
   * one consistent code regardless of which guard caught it.
   *
   * @throws {ToonClientError} BTP_REQUIRED when the terminator's 401/402
   *   response demands BTP but this client has no BTP uplink (`btpUrl`)
   *   configured.
   */
  private async sendClaimBearingPacket(
    destination: string,
    transport: ClaimSendingTransport,
    params: IlpSendParams,
    claim: unknown
  ): Promise<IlpSendResult> {
    try {
      return await transport.sendIlpPacketWithClaim(params, claim);
    } catch (error) {
      const signal = btpFallbackSignal(error);
      if (!signal) throw error;

      // Widened to `ClaimSendingTransport` on purpose: `sendsClaims` would
      // otherwise narrow to `BtpRuntimeClient & ClaimSendingTransport`, whose
      // `claim` parameter is the stricter `Record<string, unknown>`.
      const uplink = this.state?.btpClient;
      const btp: ClaimSendingTransport | undefined = sendsClaims(uplink)
        ? uplink
        : undefined;
      if (btp && btp !== transport) {
        return btp.sendIlpPacketWithClaim(params, claim);
      }
      throw new ToonClientError(
        `The connector terminating "${destination}" requires BTP for paid ` +
          `writes (its ${signal.reason}), but this client has no BTP uplink ` +
          '(`btpUrl`) configured.',
        'BTP_REQUIRED',
        signal.error
      );
    }
  }

  /**
   * Shared claim-resolution logic used by `publishEvent` and `sendSwapPacket`.
   *
   * `out` (optional) receives the BINDING the claim was drawn on — the peer,
   * the negotiation and the channel — so a caller that gets the claim refused
   * can name the record to retire (toon-client#581, see
   * {@link sendPaidPacket}). It is an out-parameter rather than a widened
   * return type on purpose: every existing caller (and every test that stubs
   * this method) keeps working unchanged, and a stub that ignores it simply
   * yields no binding, which disables the recovery rather than breaking it.
   * Left empty on the explicit-claim path: the caller owns that proof, so
   * there is no binding of ours behind it.
   */
  private async resolveClaimForDestination(
    destination: string,
    amount: bigint,
    explicitClaim?: SignedBalanceProof,
    out?: { binding?: ClaimBinding }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- claim message is opaque forwarded type
  ): Promise<any> {
    if (explicitClaim) {
      return this.buildClaimMessageForProof(explicitClaim);
    }
    if (this.channelManager) {
      const peerId = this.peerIdForClaim(destination);
      const negotiation = await this.negotiationFor(destination, peerId);
      if (!negotiation) {
        throw new ToonClientError(
          `No negotiation metadata for peer "${peerId}" — was bootstrap completed?` +
            " (and the route's x402 greeting carried no settlement facts to bootstrap from)" +
            this.rawDestinationKeyHint(destination, peerId),
          'PEER_NOT_NEGOTIATED'
        );
      }
      let channelId: string;
      try {
        channelId = await this.channelManager.ensureChannel(
          peerId,
          negotiation
        );
      } catch (error) {
        throw this.withSolanaLegHint(peerId, error);
      }
      if (out) out.binding = { peerId, negotiation, channelId };
      const proof = await this.channelManager.signBalanceProof(
        channelId,
        amount
      );
      const signer = this.channelManager.getSignerForChannel(channelId);
      return signer.buildClaimMessage(proof, this.getPublicKey());
    }
    throw new ToonClientError(
      'No claim provided and no channel manager configured',
      'MISSING_CLAIM'
    );
  }

  /**
   * Resolve a claim, send the packet with it, and — when the connector refuses
   * the claim as naming a channel it has no record of — retire that binding and
   * retry the SAME packet ONCE against a re-resolved channel (toon-client#581).
   *
   * This is where an ILP reject code first reaches the binding layer. The
   * counterparty check #580 added runs BEFORE a packet exists and can only
   * catch a record that visibly disagrees with the destination's announce; a
   * node that keeps its settlement address but loses its channel state answers
   * every write `F01 - claim rejected: names a channel this connector has no
   * record of` and, until now, poisoned every subsequent write until the JSON
   * was edited by hand (observed live on both `rig` and the daemon).
   *
   * Bounded deliberately:
   *   - ONE retry, never a loop. A second `F01` is returned to the caller as
   *     the failure it is — a repeated eviction could open a channel per write.
   *   - Only the unknown-channel flavour of `F01` (see
   *     {@link isUnknownChannelReject}); a nonce-race `F01` names a HEALTHY
   *     channel and evicting it would strand its collateral.
   *   - Only when the reject can be attributed to the channel we just used
   *     ({@link rejectNamesChannel}).
   *   - Only on the auto-claim path: an explicit caller-supplied claim yields
   *     no binding, so there is nothing of ours to retire.
   *   - Only when re-resolution actually moves: a retry onto the SAME channel
   *     id would just repeat the reject, so the first result is returned.
   *
   * Re-resolution goes through the ordinary {@link ChannelManager.ensureChannel}
   * path — the same one the #580 mismatch recovery uses — which resumes an
   * existing binding where one survives and otherwise lets the on-chain opener
   * bind whatever channel this identity already holds with that counterparty.
   * Nothing here forces a fresh on-chain open.
   *
   * The packet itself is re-sent verbatim: it was REJECTED, so nothing was
   * fulfilled and no seal, condition or payload needs re-minting — only the
   * claim rides on the new channel.
   */
  private async sendPaidPacket(
    destination: string,
    transport: ClaimSendingTransport,
    params: IlpSendParams,
    amount: bigint,
    explicitClaim?: SignedBalanceProof
  ): Promise<IlpSendResult> {
    const first: { binding?: ClaimBinding } = {};
    const claim = await this.resolveClaimForDestination(
      destination,
      amount,
      explicitClaim,
      first
    );
    const result = await this.sendClaimBearingPacket(
      destination,
      transport,
      params,
      claim
    );

    const stale = first.binding;
    if (!stale || !this.channelManager) return result;
    if (!isUnknownChannelReject(result)) return result;
    if (!rejectNamesChannel(result.message, stale.channelId)) return result;
    if (
      !this.channelManager.evictBinding(
        stale.peerId,
        stale.negotiation,
        stale.channelId
      )
    ) {
      return result;
    }

    console.warn(
      `[ToonClient] the connector terminating "${destination}" refused a claim ` +
        `drawn on channel ${stale.channelId} (${result.code} - ${result.message}). ` +
        'That channel is not one it holds a record of, so the binding for peer ' +
        `"${stale.peerId}" is retired (superseded, so any on-chain deposit stays ` +
        'reclaimable) and the write retried once against a re-resolved channel.'
    );

    const retryBinding: { binding?: ClaimBinding } = {};
    const retryClaim = await this.resolveClaimForDestination(
      destination,
      amount,
      explicitClaim,
      retryBinding
    );
    if (retryBinding.binding?.channelId === stale.channelId) return result;
    return this.sendClaimBearingPacket(
      destination,
      transport,
      params,
      retryClaim
    );
  }

  /**
   * Signs a balance proof for the given channel with the specified amount.
   * Delegates to ChannelManager which auto-increments nonce and tracks cumulative amount.
   *
   * @param channelId - Payment channel identifier
   * @param amount - Additional amount to add to cumulative transferred amount
   * @returns Signed balance proof
   * @throws {ToonClientError} If no EVM signer configured or channel not tracked
   */
  async signBalanceProof(
    channelId: string,
    amount: bigint
  ): Promise<SignedBalanceProof> {
    if (!this.channelManager) {
      throw new ToonClientError(
        'No EVM signer configured. Provide evmPrivateKey in config.',
        'NO_EVM_SIGNER'
      );
    }
    return this.channelManager.signBalanceProof(channelId, amount);
  }

  /**
   * Eagerly open (or return existing) payment channel for the given destination.
   *
   * Channels are normally opened lazily on the first `publishEvent()` /
   * `sendSwapPacket()` call. This method exposes the lazy-open path so
   * callers (and E2E tests) that need a tracked `channelId` BEFORE publishing
   * can force the open. Idempotent — returns the existing channel ID for the
   * peer if one is already open.
   *
   * The counterparty is driven by `destination` (issue #565): the channel is
   * opened against the settlement address of whoever TERMINATES it — an
   * existing negotiation for that peer, else the terminating kind:10032
   * announce's own `settlementAddresses`, else the route's x402 greeting. Two
   * destinations that terminate at different nodes therefore get two channels,
   * each with the right counterparty.
   *
   * @param destination - Optional ILP destination address. Defaults to
   *   `config.destinationAddress`.
   * @returns The channel ID of the (now) open channel.
   * @throws {ToonClientError} If client not started, no channel manager
   *   configured, or peer negotiation metadata missing.
   */
  async openChannel(destination?: string): Promise<string> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }
    if (!this.channelManager) {
      throw new ToonClientError(
        'No channel manager configured. Provide evmPrivateKey in config.',
        'NO_EVM_SIGNER'
      );
    }
    const dest = destination ?? this.config.destinationAddress;
    if (!dest) {
      throw new ToonClientError(
        'No destination provided and no default destinationAddress configured.',
        'NO_DESTINATION'
      );
    }
    const peerId = this.peerIdForClaim(dest);
    const negotiation = await this.negotiationFor(dest, peerId);
    if (!negotiation) {
      throw new ToonClientError(
        `No negotiation metadata for peer "${peerId}" — was bootstrap completed?` +
          " (and the route's x402 greeting carried no settlement facts to bootstrap from)" +
          this.rawDestinationKeyHint(dest, peerId),
        'PEER_NOT_NEGOTIATED'
      );
    }
    let channelId: string;
    try {
      channelId = await this.channelManager.ensureChannel(peerId, negotiation);
    } catch (error) {
      throw this.withSolanaLegHint(peerId, error);
    }
    // Covers BOTH a fresh open and ensureChannel's internal resume path
    // (toon-client#513's "and after resuming an existing channel").
    await this.declareChannelOnBtpSession(channelId);
    return channelId;
  }

  /**
   * Adopt an ALREADY-OPEN payment channel for `destination` — the restart path
   * for a host that persisted the channel id itself (#489).
   *
   * Tracking a channel is not enough: the lazy-open path keys off the peer, so
   * a host that only re-tracked its saved channel still opened (and funded) a
   * SECOND one on the first paid write. This binds it, so every later write
   * resumes it, with its claim watermark, and the on-chain client can deposit
   * into and close it too. Idempotent.
   */
  async adoptChannel(destination: string, channelId: string): Promise<void> {
    if (!this.channelManager) {
      throw new ToonClientError(
        'No channel manager configured. Provide evmPrivateKey in config.',
        'NO_EVM_SIGNER'
      );
    }
    const peerId = this.peerIdForClaim(destination);
    const negotiation = await this.negotiationFor(destination, peerId);
    if (!negotiation) {
      throw new ToonClientError(
        `No negotiation metadata for peer "${peerId}" — cannot adopt channel ` +
          `"${channelId}" without knowing its chain and token network.`,
        'PEER_NOT_NEGOTIATED'
      );
    }
    this.channelManager.adoptChannel(peerId, negotiation, channelId);
    await this.declareChannelOnBtpSession(channelId);
  }

  /**
   * Gets list of tracked payment channel IDs.
   */
  getTrackedChannels(): string[] {
    return this.channelManager?.getTrackedChannels() ?? [];
  }

  /**
   * Gets the current nonce for a tracked channel.
   */
  getChannelNonce(channelId: string): number {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getNonce(channelId);
  }

  /**
   * Signs a claim-state-challenge declaration for one channel — the shared
   * scheme both `getClaimState` and `buildChannelDeclaration` (toon-client#513)
   * use to prove channel ownership without moving value or advancing a nonce,
   * so it can never be replayed as a payment. `undefined` for a chain type
   * neither signer covers (Mina, or any chain this client has no signer for)
   * — matching `getClaimState`'s existing evm/solana-only posture.
   */
  private async signClaimStateChallenge(
    channelId: string,
    context: {
      chainType: string;
      chainId: number;
      tokenNetworkAddress: string;
    },
    expires: number
  ): Promise<BtpChannelDeclaration | undefined> {
    if (context.chainType === 'evm' && this.evmSigner) {
      const signature = await this.evmSigner.signClaimStateChallenge({
        chainId: context.chainId,
        tokenNetworkAddress: context.tokenNetworkAddress,
        channelId,
        expires,
      });
      return { blockchain: 'evm', channelId, expires, signature };
    }

    if (context.chainType === 'solana' && this.solanaSigner) {
      const signature = await this.solanaSigner.signClaimStateChallenge({
        channelAccount: channelId,
        expires,
      });
      return {
        blockchain: 'solana',
        channelAccount: channelId,
        expires,
        signature,
      };
    }

    return undefined;
  }

  /**
   * Signs a claim-state-challenge declaration for `this.declaredChannelId`
   * (toon-client#513). Wired as the BTP session's `getChannelDeclaration`
   * hook, so it is called on every auth greeting (initial connect, explicit
   * reauthenticate, and every reconnect) — `undefined` (no declared channel
   * yet, or a chain this endpoint doesn't cover) leaves that greeting
   * exactly as it was before this feature existed.
   */
  private async buildChannelDeclaration(): Promise<
    BtpChannelDeclaration | undefined
  > {
    const channelId = this.declaredChannelId;
    if (!channelId || !this.channelManager) return undefined;
    const context = this.channelManager.getChannelContext(channelId);
    if (!context) return undefined;

    // Matches getClaimState's default: the connector verifies this the
    // moment the greeting is processed, so it only needs to outlast network
    // latency and clock skew, not the session's lifetime.
    const expires = Math.floor(Date.now() / 1000) + 300;

    return this.signClaimStateChallenge(channelId, context, expires);
  }

  /**
   * Declares `channelId` as this client's channel on its live BTP session
   * (toon-client#513) — called after `openChannel()`/`adoptChannel()`
   * establish or resume one, so a connector crediting earned increments
   * learns the association without this client ever paying. Re-sends the
   * auth greeting on the EXISTING session; does not reconnect the socket.
   * A no-op when no BTP session is live (e.g. `btpUrl` not configured, or
   * the session is momentarily down) — the next reconnect's own greeting
   * already re-declares via `buildChannelDeclaration`.
   */
  private async declareChannelOnBtpSession(channelId: string): Promise<void> {
    this.declaredChannelId = channelId;
    await this.state?.btpSession?.reauthenticate();
  }

  /**
   * Gets the cumulative transferred amount for a tracked channel.
   */
  getChannelCumulativeAmount(channelId: string): bigint {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getCumulativeAmount(channelId);
  }

  /**
   * The credited balance — earning's read surface (toon-client#494,
   * toon-meta#262 decision 9). Asks the connector's `POST /ilp/claim-state`
   * (client-edge-spec.md §1.10) for the netted off-chain position of one or
   * more tracked channels: deposit, cumulative claimed, available, nonce and
   * last-claim time — the SAME place `getBalances`'s on-chain reads and a
   * paid write's claim gate both already treat as this channel's runway
   * source of truth, rather than a parallel figure this client derives
   * itself (#262 decision 4 forbids self-reported money).
   *
   * `channelIds` defaults to every tracked channel. A channel this client has
   * no signer for (e.g. Mina — unsupported by this endpoint) or no recorded
   * chain context for is silently skipped, matching `getBalances`'s
   * best-effort-per-chain posture.
   *
   * @param opts.expiresInSeconds - How long the signed challenge stays valid
   *   (default 300s). This is a READ signature, distinct from a real claim —
   *   it moves no value and advances no nonce.
   */
  async getClaimState(
    channelIds?: string[],
    opts?: { expiresInSeconds?: number }
  ): Promise<ClaimStateResult[]> {
    if (!this.channelManager) {
      throw new ToonClientError(
        'No channel manager configured. Provide evmPrivateKey in config.',
        'NO_EVM_SIGNER'
      );
    }
    const channelManager = this.channelManager;
    const ids = channelIds ?? channelManager.getTrackedChannels();
    if (ids.length === 0) return [];

    const expires =
      Math.floor(Date.now() / 1000) + (opts?.expiresInSeconds ?? 300);

    const entries = await Promise.all(
      ids.map(async (channelId): Promise<ClaimStateRequestEntry | null> => {
        const context = channelManager.getChannelContext(channelId);
        if (!context) return null;
        // Mina (and any other chain type this client has no signer for):
        // §1.10 documents evm/solana only.
        return (
          (await this.signClaimStateChallenge(channelId, context, expires)) ??
          null
        );
      })
    );

    const requests = entries.filter(
      (e): e is ClaimStateRequestEntry => e !== null
    );
    if (requests.length === 0) return [];

    return this.connectorEdge.getClaimState(
      this.resolveClientEdgeEndpoint(),
      requests
    );
  }

  /**
   * Gets the on-chain deposit total (locked collateral) for a tracked channel.
   * The available (spendable) balance is this minus the cumulative spent amount.
   */
  getChannelDepositTotal(channelId: string): bigint {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getDepositTotal(channelId);
  }

  /**
   * Deposit additional collateral into an open channel. `amount` is the delta to
   * add (base units, decimal string or bigint). The daemon signs its own tx; no
   * key material leaves the client. Reads the current tracked deposit, performs
   * the on-chain deposit, updates the tracked total, and returns the new total.
   * EVM is live; Solana/Mina deposit lands in a follow-up.
   */
  async depositToChannel(
    channelId: string,
    amount: string | bigint
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }> {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    if (!this.onChainChannelClient) {
      throw new Error(
        'On-chain channel client not configured (no chainRpcUrls).'
      );
    }
    const delta = BigInt(amount);
    if (delta <= 0n) throw new Error('Deposit amount must be positive.');
    const currentDeposit = this.channelManager.getDepositTotal(channelId);
    const result = await this.onChainChannelClient.depositToChannel(
      channelId,
      delta,
      {
        currentDeposit,
      }
    );
    this.channelManager.setDepositTotal(channelId, result.depositTotal);
    return {
      channelId,
      ...(result.txHash ? { txHash: result.txHash } : {}),
      depositTotal: result.depositTotal.toString(),
    };
  }

  /**
   * Close a channel to begin the settlement grace period (first half of
   * withdraw). Records `closedAt`/`settleableAt` (unix seconds) on the tracked
   * channel — persisted, so the grace timer survives a daemon restart. Spends
   * on-chain. EVM today; Solana/Mina are follow-ups.
   */
  async closeChannel(channelId: string): Promise<{
    channelId: string;
    txHash?: string;
    closedAt: string;
    settleableAt: string;
  }> {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    if (!this.onChainChannelClient) {
      throw new Error(
        'On-chain channel client not configured (no chainRpcUrls).'
      );
    }
    const r = await this.onChainChannelClient.closeChannel(channelId);
    this.channelManager.setChannelClosed(channelId, r.closedAt, r.settleableAt);
    return {
      channelId,
      ...(r.txHash ? { txHash: r.txHash } : {}),
      closedAt: r.closedAt.toString(),
      settleableAt: r.settleableAt.toString(),
    };
  }

  /**
   * Settle a closed channel to release collateral (second half of withdraw).
   * THE time guard: never settle before `settleableAt`. A too-early call throws
   * a retryable error (carrying the remaining seconds) BEFORE spending gas — the
   * contract would revert anyway. Spends on-chain. EVM today.
   */
  async settleChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string }> {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    if (!this.onChainChannelClient) {
      throw new Error(
        'On-chain channel client not configured (no chainRpcUrls).'
      );
    }
    const settleableAt = this.channelManager.getSettleableAt(channelId);
    if (settleableAt === undefined) {
      throw new Error(
        `Channel "${channelId}" is not closed; call closeChannel first.`
      );
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (nowSec < settleableAt) {
      const remaining = settleableAt - nowSec;
      throw Object.assign(
        new Error(
          `Channel "${channelId}" is not settleable yet — ${remaining}s remain (settleable at ${settleableAt}).`
        ),
        {
          name: 'SettleTooEarlyError',
          retryable: true,
          settleableAt: settleableAt.toString(),
        }
      );
    }
    const r = await this.onChainChannelClient.settleChannel(channelId);
    this.channelManager.setChannelSettled(channelId, nowSec);
    return { channelId, ...(r.txHash ? { txHash: r.txHash } : {}) };
  }

  /**
   * Submit a receive-side swap settlement bundle on-chain (toon-client#352).
   * The bundle comes from the sdk's `buildSettlementTx` over persisted,
   * verified chain-B claims (`buildSwapSettlements`); this signs it with the
   * client's EVM account (the claim recipient) and broadcasts it.
   *
   * Env-gated seam: EVM only, and only when `chainRpcUrls[bundle.chain]` is
   * configured — otherwise this throws a clear config error and callers
   * surface a built-not-submitted result. Solana submission and the Mina
   * receive-side co-sign path are explicit follow-ups (see
   * swap/settle-received-claims.ts module doc).
   */
  async settleSwapBundle(
    bundle: SettlementBundle
  ): Promise<SubmitEvmSettlementResult> {
    if (bundle.chainKind === 'mina') {
      // Mina receive-side redemption (#357): reads the live channel state,
      // produces the recipient's co-signature, and drives the dual-party
      // `claimFromChannel` (o1js proving). Config-gated on minaChannel.graphqlUrl
      // + a derived Mina key; fails closed (never a silent pass) with a stable
      // MinaSettlementError code that the daemon surfaces.
      if (!this.minaPrivateKey) {
        throw new Error(
          'Mina signer not configured (no mnemonic / mina-signer) — cannot co-sign the receive-side claim.'
        );
      }
      const makerSignature = parseMakerMinaSignature(
        this.config.swapMinaMakerSignatures?.[bundle.channelId]
      );
      const { txHash } = await submitMinaSettlement(bundle, {
        recipientPrivateKey: this.minaPrivateKey,
        ...(this.config.minaChannel?.graphqlUrl
          ? { graphqlUrl: this.config.minaChannel.graphqlUrl }
          : {}),
        ...(makerSignature ? { makerSignature } : {}),
      });
      return { txHash };
    }
    if (bundle.chainKind === 'solana') {
      // Solana receive-side redemption (toon-client#604). The compiled Message
      // the sdk hands back needs exactly ONE signature — the recipient's, which
      // is also the fee payer — so this client can redeem unilaterally, with no
      // maker co-sign and no proving step (unlike Mina above).
      //
      // The RPC is `solanaChannel.rpcUrl` FIRST: the channel PDA being claimed
      // lives on the node the channel was opened against, and that is the config
      // the Solana channel path already uses. `chainRpcUrls` is the fallback so a
      // caller that only configured the generic map still works.
      const rpcUrl =
        this.config.solanaChannel?.rpcUrl ??
        this.config.chainRpcUrls?.[bundle.chain];
      if (!rpcUrl) {
        throw new Error(
          `No Solana RPC URL configured for chain "${bundle.chain}" — set ` +
            `solanaChannel.rpcUrl (or chainRpcUrls["${bundle.chain}"]) to enable ` +
            `swap settlement submission.`
        );
      }
      if (!this.solanaSeed) {
        throw new Error(
          'Solana signer not configured (no mnemonic-derived Solana key) — the ' +
            'claim recipient cannot sign its own redemption.'
        );
      }
      const { txHash } = await submitSolanaSettlement(bundle, {
        rpcUrl,
        recipientSeed: this.solanaSeed,
      });
      return { txHash };
    }
    if (bundle.chainKind !== 'evm') {
      throw new Error(
        `Swap settlement submission for ${bundle.chainKind} (${bundle.chain}) is not wired yet — EVM only today.`
      );
    }
    const rpcUrl = this.config.chainRpcUrls?.[bundle.chain];
    if (!rpcUrl) {
      throw new Error(
        `No RPC URL configured for chain "${bundle.chain}" — add it to chainRpcUrls to enable swap settlement submission.`
      );
    }
    if (!this.evmSigner) {
      throw new Error('EVM signer not configured (no evmPrivateKey/mnemonic).');
    }
    return submitEvmSettlement(bundle, {
      rpcUrl,
      account: this.evmSigner.account,
    });
  }

  /** Where a tracked channel sits in the withdraw journey. */
  getChannelCloseState(
    channelId: string
  ): 'open' | 'closing' | 'settleable' | 'settled' {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getChannelCloseState(channelId);
  }

  getSettleableAt(channelId: string): bigint | undefined {
    if (!this.channelManager) throw new Error('ChannelManager not initialized');
    return this.channelManager.getSettleableAt(channelId);
  }

  /**
   * Re-hydrate a RESUMED channel's on-chain deposit. Persisted channel state
   * omits `depositTotal`, so after a daemon restart the tracked deposit is `0`
   * and the wallet shows 0 spendable even though real collateral is locked
   * on-chain. Read the participant's `deposit` from the `participants` mapping
   * and update the tracked total so `depositTotal - cumulativeAmount` is right.
   * Best-effort by caller (await + catch); returns the on-chain deposit, or
   * `undefined` when it can't be read (no channel manager / on-chain client /
   * EVM address).
   */
  async rehydrateChannelDeposit(
    channelId: string,
    opts: { chain: string; tokenNetworkAddress: string }
  ): Promise<bigint | undefined> {
    if (!this.channelManager || !this.onChainChannelClient) return undefined;
    const participant = this.getEvmAddress();
    if (!participant) return undefined;
    const { deposit } = await this.onChainChannelClient.readEvmParticipantState(
      {
        chain: opts.chain,
        tokenNetworkAddress: opts.tokenNetworkAddress,
        channelId,
        participant,
      }
    );
    this.channelManager.setDepositTotal(channelId, deposit);
    return deposit;
  }

  /**
   * Read the on-chain settlement-token balance of this client's OWN wallet on
   * each configured chain (EVM token, Solana SPL, native MINA). A free read — no
   * signing, no payment. Best-effort per chain: a chain whose config is absent or
   * whose RPC read fails is omitted rather than failing the whole result, so the
   * wallet view degrades gracefully. Available after `start()` (Solana/Mina keys
   * are derived there).
   */
  async getBalances(): Promise<WalletBalance[]> {
    const out: WalletBalance[] = [];

    // EVM: read the settlement token (preferredTokens) for the client's
    // settlement chain. `supportedChains` is a union with the network PRESET
    // first (see applyDefaults), so the preset's primary EVM chain (e.g.
    // base-sepolia on devnet) sorts ahead of an explicitly-configured chain
    // like `evm:anvil:31337`. Picking the FIRST evm key would read the preset
    // chain's token — a different contract with a 0 balance — even though the
    // faucet funds, and channels live on, the settlement chain. So prefer the
    // evm key that is the actual settlement chain (present in
    // `settlementAddresses`), falling back to the first usable evm chain.
    const evmAddress = this.getEvmAddress();
    const rpcUrls = this.config.chainRpcUrls;
    const tokens = this.config.preferredTokens;
    if (evmAddress && rpcUrls && tokens) {
      const chainKeys = this.config.supportedChains ?? Object.keys(rpcUrls);
      const usableEvm = (c: string): boolean =>
        c.startsWith('evm') && Boolean(rpcUrls[c]) && Boolean(tokens[c]);
      const settlementKeys = Object.keys(this.config.settlementAddresses ?? {});
      const chainKey =
        settlementKeys.find((c) => usableEvm(c)) ?? chainKeys.find(usableEvm);
      const rpcUrl = chainKey ? rpcUrls[chainKey] : undefined;
      const tokenAddress = chainKey ? tokens[chainKey] : undefined;
      if (chainKey && rpcUrl && tokenAddress) {
        try {
          out.push(
            await readEvmTokenBalance({
              rpcUrl,
              chainKey,
              tokenAddress,
              owner: evmAddress,
            })
          );
        } catch {
          /* best-effort: drop EVM on read failure */
        }
      }
    }

    // Solana: SPL balance of the negotiated token mint.
    const solAddress = this.getSolanaAddress();
    const sol = this.config.solanaChannel;
    if (solAddress && sol?.rpcUrl && sol.tokenMint) {
      try {
        out.push(
          await readSolanaTokenBalance({
            rpcUrl: sol.rpcUrl,
            mint: sol.tokenMint,
            owner: solAddress,
          })
        );
      } catch {
        /* best-effort */
      }
    }

    // Mina: native MINA balance via GraphQL.
    const minaAddress = this.getMinaAddress();
    const mina = this.config.minaChannel;
    if (minaAddress && mina?.graphqlUrl) {
      try {
        out.push(
          await readMinaBalance({
            graphqlUrl: mina.graphqlUrl,
            owner: minaAddress,
          })
        );
      } catch {
        /* best-effort */
      }
    }

    return out;
  }

  /**
   * Lazily derive the mnemonic's full multi-chain identity, at most once per
   * call to the returned function. Solana/Mina keys are only registered as
   * signers during `start()`; this lets an UNSTARTED client (e.g. `rig
   * balance`, or `sendTransfer` before `start()`) derive them on demand
   * instead. Shared by {@link getWalletBalances} and {@link sendTransfer}.
   */
  private createIdentityDeriver(): () => Promise<
    Awaited<ReturnType<typeof deriveFullIdentity>> | undefined
  > {
    let derived: Awaited<ReturnType<typeof deriveFullIdentity>> | undefined;
    let derivedTried = false;
    return async () => {
      if (derivedTried) return derived;
      derivedTried = true;
      if (this.config.mnemonic) {
        derived = await deriveFullIdentity(
          this.config.mnemonic,
          this.config.mnemonicAccountIndex ?? 0
        );
      }
      return derived;
    };
  }

  /**
   * The EVM chain key + RPC URL to use for a settlement-token/native-gas
   * operation: the settlement chain wins over the preset-first chain, mirroring
   * {@link getBalances}. Shared by {@link getWalletBalances} and
   * {@link sendTransfer}.
   */
  private resolveSettlementEvmChain():
    | { chainKey: string; rpcUrl: string }
    | undefined {
    const rpcUrls = this.config.chainRpcUrls;
    if (!rpcUrls) return undefined;
    const usableEvm = (c: string): boolean =>
      c.startsWith('evm') && Boolean(rpcUrls[c]);
    const settlementKeys = Object.keys(this.config.settlementAddresses ?? {});
    const chainKeys = this.config.supportedChains ?? Object.keys(rpcUrls);
    const chainKey =
      settlementKeys.find(usableEvm) ?? chainKeys.find(usableEvm);
    const rpcUrl = chainKey ? rpcUrls[chainKey] : undefined;
    return chainKey && rpcUrl ? { chainKey, rpcUrl } : undefined;
  }

  /**
   * The FULL multi-chain wallet view (#299): for every chain the identity is
   * configured for, the native coin (ETH / SOL / MINA) AND every configured
   * token (USDC), grouped per chain with the identity's address on that chain.
   * A superset of {@link getBalances} — which stays scoped to the channel's
   * settlement token — kept as a separate reader so channel-settlement callers
   * are unaffected.
   *
   * FREE: read-only RPC, no signing, no payment. Works on an UNSTARTED client:
   * the Solana/Mina addresses (which the signers only register during
   * `start()`) are derived on demand from the retained mnemonic — the SAME keys
   * `start()` would register and that `rig fund` prints — so all configured
   * chains appear even before a start. Best-effort per chain: an unreachable
   * RPC yields `{ unreadable: true }` for that chain, never failing the others.
   *
   * `fallback` supplies Solana/Mina channel params (RPC/GraphQL + token) to use
   * ONLY when `config.solanaChannel`/`config.minaChannel` are unset — a
   * wallet-view-only default (e.g. the network preset's public RPC) that lets a
   * caller show all three chains, reading 0 for a not-yet-on-chain account,
   * WITHOUT injecting those channels into the client's settlement config (which
   * would change chain negotiation). Explicit config wins.
   */
  async getWalletBalances(fallback?: {
    solanaChannel?: ToonClientConfig['solanaChannel'];
    minaChannel?: ToonClientConfig['minaChannel'];
  }): Promise<WalletChainBalances[]> {
    const sources: WalletBalanceSources = {};

    // Solana/Mina keys are only registered as signers during start(); derive
    // them from the retained mnemonic on demand so an unstarted client (e.g.
    // `rig balance`) still reports every configured chain. Derived once, lazily.
    const ensureDerived = this.createIdentityDeriver();

    // EVM: native ETH + settlement USDC. Pick the settlement chain key the same
    // way getBalances does (settlement chain wins over the preset primary).
    const evmAddress = this.getEvmAddress();
    const evmChain = this.resolveSettlementEvmChain();
    const tokens = this.config.preferredTokens;
    if (evmAddress && evmChain) {
      sources.evm = {
        chainKey: evmChain.chainKey,
        rpcUrl: evmChain.rpcUrl,
        owner: evmAddress,
        ...(tokens?.[evmChain.chainKey]
          ? { tokenAddress: tokens[evmChain.chainKey] }
          : {}),
      };
    }

    // Solana: native SOL + SPL USDC (the negotiated mint). Explicit config
    // wins; else the caller's wallet-view fallback (e.g. network preset RPC).
    const sol = this.config.solanaChannel ?? fallback?.solanaChannel;
    if (sol?.rpcUrl) {
      const solAddress =
        this.getSolanaAddress() ?? (await ensureDerived())?.solana.publicKey;
      if (solAddress) {
        sources.solana = {
          chainKey: 'solana',
          rpcUrl: sol.rpcUrl,
          owner: solAddress,
          ...(sol.tokenMint ? { tokenMint: sol.tokenMint } : {}),
        };
      }
    }

    // Mina: native MINA plus, when the deployment settles a custom token, that
    // token's balance (USDC) — read via the derived/explicit `minaChannel.tokenId`
    // (core preset or announce, see resolveNetworkTopology/deriveMinaChannel). A
    // fresh client with no explicit `config.minaChannel` still gets both.
    // Explicit config wins; else the caller's wallet-view fallback.
    const mina = this.config.minaChannel ?? fallback?.minaChannel;
    if (mina?.graphqlUrl) {
      const minaAddress =
        this.getMinaAddress() ?? (await ensureDerived())?.mina.publicKey;
      if (minaAddress) {
        sources.mina = {
          chainKey: 'mina',
          graphqlUrl: mina.graphqlUrl,
          owner: minaAddress,
          ...(mina.tokenId ? { tokenId: mina.tokenId } : {}),
        };
      }
    }

    return readWalletBalances(sources);
  }

  /**
   * Send the settlement token or native gas from THIS client's own wallet to
   * an arbitrary address, on any chain this client is configured for.
   * Non-custodial plain send (issue #491) — distinct from the payment-channel
   * machinery, and the missing primitive underneath provisioning a buzz agent
   * (toon-protocol/buzz#74): the owner's treasury funds a freshly-derived
   * agent address with USDC + gas before that address can open a channel.
   *
   * Confirmed by an OBSERVED balance delta at the destination, never by the
   * send call/transaction merely landing — see `transfer.ts` module docs
   * (the devnet faucet's Solana leg has returned a real tx signature while
   * delivering 0 lamports, connector#691).
   *
   * Chain resolution mirrors {@link getWalletBalances}: EVM picks the
   * settlement chain key (falling back to the first usable EVM chain) from
   * `chainRpcUrls`/`settlementAddresses`; Solana/Mina need `solanaChannel`/
   * `minaChannel` configured, and their signing keys are either already
   * derived (client was `start()`-ed) or derived on demand from `mnemonic`.
   *
   * @throws {UnknownChainError} `params.chain` isn't configured on this client.
   * @throws {InvalidAddressError} `params.to` is malformed for the chain.
   * @throws {InsufficientBalanceError} the sender can't cover amount (+ fees).
   * @throws {TransferNotDeliveredError} accepted on-chain/by-node, but the
   *   destination balance never reflected it within the wait window.
   * @throws {TransferUnsupportedError} chain/asset combination not implemented
   *   yet (currently: the Mina settlement token).
   */
  async sendTransfer(params: SendTransferParams): Promise<SendTransferResult> {
    const config: TransferConfig = {};

    // EVM: same settlement-chain-first resolution as getBalances/getWalletBalances.
    if (this.evmSigner) {
      const evmChain = this.resolveSettlementEvmChain();
      if (evmChain) {
        const tokens = this.config.preferredTokens;
        config.evm = {
          chainKey: evmChain.chainKey,
          rpcUrl: evmChain.rpcUrl,
          signer: this.evmSigner,
          ...(tokens?.[evmChain.chainKey]
            ? { tokenAddress: tokens[evmChain.chainKey] }
            : {}),
        };
      }
    }

    // Solana/Mina keys are only registered as signers during start(); derive
    // them from the retained mnemonic on demand otherwise (mirrors
    // getWalletBalances' `ensureDerived`).
    const ensureDerived = this.createIdentityDeriver();

    const sol = this.config.solanaChannel;
    if (sol?.rpcUrl) {
      const seed =
        this.solanaSeed ??
        (await ensureDerived())?.solana.secretKey.slice(0, 32);
      if (seed) {
        config.solana = {
          rpcUrl: sol.rpcUrl,
          keypair: seed,
          ...(sol.tokenMint ? { tokenMint: sol.tokenMint } : {}),
        };
      }
    }

    const mina = this.config.minaChannel;
    if (mina?.graphqlUrl) {
      const privateKey =
        this.minaPrivateKey ?? (await ensureDerived())?.mina.privateKey;
      if (privateKey) {
        config.mina = { graphqlUrl: mina.graphqlUrl, privateKey };
      }
    }

    return executeTransfer(config, params);
  }

  /**
   * The peer id a claim for `destination` accounts under — and therefore WHICH
   * counterparty's channel that claim is drawn on. Normally `resolvePeerId`,
   * which resolves by identity (an existing negotiation key, or the announce
   * that terminates `destination`) — but where that throws `PEER_NOT_FOUND`
   * (nothing announced, nothing registered, nothing unambiguous to guess), the
   * destination itself is the key, so the announce-less greeting bootstrap
   * (connector #617) has a stable identity to remember its synthesized
   * negotiation under.
   *
   * Never a positional guess across several peers (issue #565): keying a
   * second destination onto the first peer's negotiation opens the channel
   * against the WRONG settlement address, and the real terminator then rejects
   * every claim (F01 — "names a channel this connector has no record of").
   */
  private peerIdForClaim(destination: string): string {
    try {
      return this.resolvePeerId(destination);
    } catch {
      return destination;
    }
  }

  /**
   * The extra sentence a `PEER_NOT_NEGOTIATED` error carries when the peer id
   * IS the raw destination — the signature of {@link peerIdForClaim}'s
   * `PEER_NOT_FOUND` fallback, and the ONLY case where the greeting bootstrap
   * was the last hope. Nothing is ever registered under a full ILP address, so
   * that lookup could not have hit on identity: this client holds no
   * negotiation for `destination` at all.
   *
   * Worth saying out loud because the daemon runs ONE `ToonClient` per apex
   * and injects a `toon_add_apex` target's negotiation into that client alone
   * (`injectApexNegotiation`, under the peer id `resolvePeerId` returns —
   * `g.toon.swap.maker` → `maker`). A swap or publish streamed on a DIFFERENT
   * apex's client therefore reads exactly like a bootstrap that never
   * happened. Listing the peers this client did negotiate names the real
   * fault instead of leaving the fallback silent.
   */
  private rawDestinationKeyHint(destination: string, peerId: string): string {
    if (peerId !== destination) return '';
    const known = [...this.peerNegotiations.keys()];
    return (
      ` NOTE: "${peerId}" is the DESTINATION, not a peer id — no negotiation is ` +
      'ever registered under a full ILP address, so this client holds none for ' +
      'it. Negotiated peers on this client: ' +
      (known.length > 0 ? known.join(', ') : '(none)') +
      '. If the destination belongs to a registered apex, the write must go ' +
      "out on THAT apex's client."
    );
  }

  /**
   * The announce-less channel bootstrap (connector #617): when nothing has
   * negotiated with this destination's peer — no kind:10032 announce, no
   * connector-admin registration — ask the route itself. A settling
   * connector's x402 greeting carries the channel-opening facts, and ADR
   * 0022 makes the greeting the ONLY place the Rust fleet will ever state
   * them. Synthesizes a {@link PeerNegotiation} from those facts, remembers
   * it, and returns it; `undefined` when there is no edge to ask or the
   * greeting carries no settlement facts this client can open a channel on.
   *
   * A two-chain greeting (connector #632's `extra.settlements`) prefers EVM
   * — the long-standing default — UNLESS the wallet holds Solana
   * settlement-token funds and holds none on EVM (issue #470), in which case
   * it opens the Solana leg instead: a wallet funded only with Solana devnet
   * assets can bootstrap exactly as an EVM one does. A Solana-only greeting
   * (no EVM leg at all) always opens Solana — there is nothing to compare
   * funds against.
   *
   * That comparison is only as good as what {@link getBalances} can SEE: with
   * no `solanaChannel` config it cannot read the Solana side at all, so a
   * Solana-funded client silently looks broke and takes the EVM leg (issue
   * #474). We cannot fix the read here — the config genuinely isn't there —
   * but we remember the peer so the resulting EVM funding failure names the
   * missing config instead of reading as a plain "fund your wallet".
   *
   * Never throws: this is a fallback on a path that already has a precise
   * error (`PEER_NOT_NEGOTIATED`), and a transport failure while ASKING
   * must not mask it.
   */
  private async negotiateFromGreeting(
    destination: string,
    peerId: string
  ): Promise<PeerNegotiation | undefined> {
    let edge: string;
    try {
      edge = this.resolveClientEdgeEndpoint();
    } catch {
      return undefined;
    }
    try {
      const terms = await this.connectorEdge.getRouteTerms(edge, destination);
      this.lastConnectorRouteTerms = terms ?? undefined;
      const evmSettlement = terms?.settlement;
      const solanaSettlement = terms?.settlements?.find(
        (entry) => entry.kind === 'solana'
      );
      if (!evmSettlement && !solanaSettlement) return undefined;

      let negotiation: PeerNegotiation | undefined;
      if (
        solanaSettlement &&
        (!evmSettlement || (await this.walletPrefersSolana()))
      ) {
        negotiation = this.solanaNegotiationFromSettlement(solanaSettlement);
      } else if (evmSettlement) {
        negotiation = this.evmNegotiationFromSettlement(evmSettlement);
        // EVM chosen while the greeting also offered Solana we could not read.
        if (solanaSettlement && !this.canReadSolanaBalance()) {
          this.unreadableSolanaLegs.add(peerId);
        }
      }
      if (!negotiation) return undefined;

      this.peerNegotiations.set(peerId, negotiation);
      return negotiation;
    } catch (error) {
      console.warn(
        '[ToonClient] channel bootstrap from the x402 greeting failed:',
        String(error)
      );
      return undefined;
    }
  }

  /**
   * Build the EVM {@link PeerNegotiation} from the greeting's legacy
   * `settlement` object (connector #617). `undefined` when `chain` is not
   * the documented `evm:<chainId>` shape — the greeting is malformed rather
   * than a chain this client cannot open, so bootstrap declines instead of
   * opening against unverified facts.
   */
  private evmNegotiationFromSettlement(
    settlement: ConnectorSettlementTerms
  ): PeerNegotiation | undefined {
    const [chainType, chainIdText] = settlement.chain.split(':');
    const chainId = Number(chainIdText);
    if (chainType !== 'evm' || !Number.isFinite(chainId)) return undefined;
    return {
      chain: settlement.chain,
      chainType,
      chainId,
      settlementAddress: settlement.settlementAddress,
      tokenAddress: settlement.tokenAddress,
      tokenNetwork: settlement.tokenNetwork,
    };
  }

  /**
   * Build the Solana {@link PeerNegotiation} from a `settlements` entry
   * (connector #632). Unlike the EVM leg there is no numeric chain id to
   * parse or validate — `chain` is always the literal `'solana'` — so,
   * unlike {@link evmNegotiationFromSettlement}, this cannot fail.
   */
  private solanaNegotiationFromSettlement(
    settlement: ConnectorSolanaSettlementTerms
  ): PeerNegotiation {
    return {
      chain: 'solana',
      chainType: 'solana',
      chainId: 'solana',
      settlementAddress: settlement.settlementAddress,
      tokenAddress: settlement.tokenAddress,
      tokenNetwork: settlement.programId,
    };
  }

  /**
   * Whether a two-chain greeting-bootstrap should open the Solana leg
   * instead of the default EVM one (issue #470): the wallet holds Solana
   * SETTLEMENT-TOKEN funds and holds none on EVM.
   *
   * Reads {@link getBalances}, which reports one balance per chain — the SPL
   * settlement token on Solana, NOT native SOL (issue #474). That is
   * deliberate: SOL alone cannot collateralize a channel, so a SOL-only
   * wallet must not steer the negotiation to Solana. The native SOL a fresh
   * open needs for rent + fees is checked separately, at open time, by the
   * Solana opener's funding preflight.
   *
   * `getBalances` is itself best-effort per chain (a missing config or failed
   * RPC read just omits that chain) — this never throws, degrading to "prefer
   * EVM" (the pre-existing default) on any read failure. When Solana is
   * omitted because `solanaChannel` is unset, see
   * {@link canReadSolanaBalance} / {@link unreadableSolanaLegs}.
   */
  private async walletPrefersSolana(): Promise<boolean> {
    try {
      const balances = await this.getBalances();
      const hasFunds = (chain: 'evm' | 'solana'): boolean =>
        balances.some((b) => b.chain === chain && BigInt(b.amount) > 0n);
      return hasFunds('solana') && !hasFunds('evm');
    } catch {
      return false;
    }
  }

  /**
   * Whether {@link getBalances} can report a Solana balance at all — the exact
   * condition that reader gates on. False means a Solana-funded wallet reads
   * as empty, so `walletPrefersSolana` cannot see its funds.
   */
  private canReadSolanaBalance(): boolean {
    const sol = this.config.solanaChannel;
    return Boolean(this.getSolanaAddress() && sol?.rpcUrl && sol.tokenMint);
  }

  /**
   * Re-throw a channel-open failure with the missing-`solanaChannel` diagnosis
   * attached (issue #474).
   *
   * When the peer's greeting advertised a Solana leg this client could not
   * evaluate, "the EVM wallet has no funds/gas" is a symptom, not the cause:
   * the funds may be sitting on Solana, invisible because `solanaChannel` is
   * unconfigured. Only funding failures are rewritten — every other error is
   * returned untouched, since a transport/RPC/contract fault has nothing to do
   * with which chain was picked.
   */
  private withSolanaLegHint(peerId: string, error: unknown): unknown {
    if (!this.unreadableSolanaLegs.has(peerId)) return error;
    const isFunding =
      error instanceof ChannelFundingError || isInsufficientGasError(error);
    if (!isFunding) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new ChannelFundingError(
      `${detail} NOTE: the route also offered a Solana settlement leg, but this ` +
        `client has no \`solanaChannel\` config (rpcUrl + tokenMint), so its Solana ` +
        `balance could not be read and the EVM leg was chosen by default. If the ` +
        `wallet is funded on Solana, configure \`solanaChannel\` and retry.`,
      error instanceof Error ? error : undefined
    );
  }

  private resolvePeerId(destination: string): string {
    // Check if destination matches a known peer's ILP address pattern
    const segments = destination.split('.');
    const lastSegment = segments[segments.length - 1] ?? '';

    // Direct match against peerNegotiations keys
    if (lastSegment && this.peerNegotiations.has(lastSegment)) {
      return lastSegment;
    }

    // Try "nostr-" prefixed peer IDs (convention: nostr-{pubkey_prefix})
    for (const peerId of this.peerNegotiations.keys()) {
      if (
        destination.endsWith(`.${peerId}`) ||
        destination.endsWith(`.${peerId.replace('nostr-', '')}`)
      ) {
        return peerId;
      }
    }

    // Ask DISCOVERY who actually terminates this destination (issue #565).
    // Neither match above can succeed for a bootstrapped peer, because
    // `BootstrapService` keys its results under `nostr-<pubkey16>` while the
    // destination is an ILP address (`g.toon.ario`) — the two share no
    // substring. So the announce is the only thing that binds a destination to
    // a counterparty, and it must be consulted BEFORE any positional guess.
    const claim = this.terminatorClaimFor(destination);
    if (claim) return claim.peerId;

    // Legacy single-uplink fallback: with exactly ONE negotiated peer and no
    // announce claiming this destination, that peer IS the only counterparty
    // this client could be paying. With SEVERAL, "the first one" is an
    // arbitrary map-insertion-order pick — the bug this replaces
    // (`openChannel('g.toon.ario')` opened against the RELAY's settlement
    // address, and the store then rejected every claim with F01 "names a
    // channel this connector has no record of"). Declining here lets
    // `peerIdForClaim` key off the destination itself and negotiate from that
    // destination's own greeting instead of settling with the wrong node.
    if (this.peerNegotiations.size === 1) {
      const only = this.peerNegotiations.keys().next();
      if (!only.done && only.value) return only.value;
    }

    throw new ToonClientError(
      `Cannot resolve peer for destination: ${destination}`,
      'PEER_NOT_FOUND'
    );
  }

  /**
   * The winning kind:10032 claim on `destination` from this client's discovery
   * tracker, or `undefined` when there is no tracker yet or no announce claims
   * it. Probed rather than assumed, exactly as {@link terminatorRequiresBtp}
   * does — a half-built state (a stub, a client mid-`start()`) simply has
   * nothing to resolve against, and a missing announce is a normal state, not
   * an error.
   */
  private terminatorClaimFor(destination: string): TerminatorClaim | undefined {
    const tracker: Partial<DiscoveryTracker> | undefined =
      this.state?.discoveryTracker;
    if (typeof tracker?.getAllDiscoveredPeers !== 'function') return undefined;
    return findBestTerminatorClaim(
      destination,
      tracker.getAllDiscoveredPeers(),
      this.announceEndpointPolicy()
    );
  }

  /**
   * The negotiation to settle `destination` with, in order of authority
   * (issue #565):
   *
   *   1. an ALREADY-negotiated peer (bootstrap, or a host that injected one);
   *   2. the terminating announce's OWN settlement facts — the counterparty
   *      states its `settlementAddresses`/`tokenNetworks` in the same
   *      kind:10032 event that claims the destination, so this is the
   *      counterparty naming itself rather than us inferring one;
   *   3. the route's x402 greeting ({@link negotiateFromGreeting}, connector
   *      #617) for an announce-less route.
   *
   * Step 2 is what makes a SECOND destination openable at all: bootstrap only
   * negotiates with `knownPeers`, so a client seeded with the relay had no
   * negotiation for the store box and used to fall through to the relay's.
   */
  private async negotiationFor(
    destination: string,
    peerId: string
  ): Promise<PeerNegotiation | undefined> {
    const known = this.peerNegotiations.get(peerId);
    if (known) return known;

    const claim = this.terminatorClaimFor(destination);
    if (claim && claim.peerId === peerId) {
      // CHAIN_NOT_SUPPORTED here means this ANNOUNCE offers no chain we share
      // — the greeting below may still offer one (a connector can settle on
      // more than it advertises), so fall through rather than fail the write.
      let announced: PeerNegotiation | undefined;
      try {
        announced = this.negotiationFromAnnounce(claim.peerInfo, peerId);
      } catch {
        announced = undefined;
      }
      if (announced) {
        this.peerNegotiations.set(peerId, announced);
        return announced;
      }
    }

    return this.negotiateFromGreeting(destination, peerId);
  }

  /**
   * The {@link PeerNegotiation} a peer's own kind:10032 announce supports: the
   * chain both sides support, plus the settlement address / token / token
   * network THAT PEER advertises for it (falling back to this client's
   * configured maps only where the announce is silent).
   *
   * `undefined` when the announce names no settlement address for the matched
   * chain — there is nothing to open a channel against, and guessing one is how
   * a claim ends up unverifiable at the counterparty.
   *
   * @throws {ToonClientError} CHAIN_NOT_SUPPORTED when no mutually supported
   *   chain exists (from {@link matchNegotiatedChain}) — bootstrap surfaces
   *   this; the lazy per-destination path catches it.
   */
  private negotiationFromAnnounce(
    peerInfo: IlpPeerInfo & {
      supportedChains?: string[];
      settlementAddresses?: Record<string, string>;
      preferredTokens?: Record<string, string>;
      tokenNetworks?: Record<string, string>;
    },
    peerId: string
  ): PeerNegotiation | undefined {
    const matchedChain = this.matchNegotiatedChain(
      this.config.supportedChains ?? [],
      peerInfo.supportedChains ?? [],
      peerId
    );
    const peerAddr = peerInfo.settlementAddresses?.[matchedChain];
    if (!peerAddr) return undefined;
    const parts = matchedChain.split(':');
    const chainId =
      parts.length >= 3
        ? parseInt(parts[2] ?? '0', 10)
        : parts.length >= 2
          ? parseInt(parts[1] ?? '0', 10)
          : 0;
    return {
      chain: matchedChain,
      chainType: parts[0] ?? 'evm',
      chainId: isNaN(chainId) ? 0 : chainId,
      settlementAddress: peerAddr,
      tokenAddress:
        peerInfo.preferredTokens?.[matchedChain] ??
        lookupByCanonicalChain(this.config.preferredTokens, matchedChain),
      tokenNetwork:
        peerInfo.tokenNetworks?.[matchedChain] ??
        lookupByCanonicalChain(this.config.tokenNetworks, matchedChain),
    };
  }

  /**
   * Extracts chain context (chainId + tokenNetworkAddress) from a chain key like 'evm:base:421614'.
   */
  private getChainContext(
    negotiatedChain?: string
  ):
    | { chainId: number; tokenNetworkAddress: string; tokenAddress?: string }
    | undefined {
    if (!negotiatedChain) return undefined;
    const parts = negotiatedChain.split(':');
    // Accept 3-part `evm:{network}:{chainId}` and 2-part `evm:{chainId}`.
    const chainIdPart =
      parts.length >= 3 ? parts[2] : parts.length >= 2 ? parts[1] : undefined;
    const numericChainId =
      chainIdPart !== undefined ? parseInt(chainIdPart, 10) : NaN;
    if (isNaN(numericChainId)) return undefined;
    const tokenNetworkAddress = this.config.tokenNetworks?.[negotiatedChain];
    if (!tokenNetworkAddress) return undefined;
    const tokenAddress = this.config.preferredTokens?.[negotiatedChain];
    return { chainId: numericChainId, tokenNetworkAddress, tokenAddress };
  }

  /**
   * Picks the settlement chain both `ourChains` and `peerChains` support,
   * used by the lightweight bootstrap-fallback negotiation (peer discovered
   * but no connector admin registered a chain). Prefers
   * `this.config.preferredChain`'s family (#485) over array order; picks the
   * first mutually-supported chain (legacy behavior) when unconfigured.
   *
   * Chains are matched by {@link canonicalChainId} rather than exact string
   * equality (#500): a family-qualified `evm:base:84532` (a caller's config,
   * or a preset from core <3.2.1) and the live apex's unqualified
   * `evm:84532` name the same chain, and
   * exact matching skipped straight past it to the next mutually-supported
   * chain (`solana:devnet`) — negotiating a chain nobody asked for instead
   * of failing loudly. The PEER's own chain string is returned (not ours),
   * since callers index the peer's own `settlementAddresses` /
   * `preferredTokens` / `tokenNetworks` maps with it.
   *
   * @throws {ToonClientError} `CHAIN_NOT_SUPPORTED` naming both chain sets
   *   when no common chain exists — a caller explicitly configured this
   *   peer as a counterparty, so silently negotiating a different chain (or
   *   returning nothing) would hide a real incompatibility behind an
   *   unrelated failure several layers downstream (#500).
   */
  private matchNegotiatedChain(
    ourChains: string[],
    peerChains: string[],
    peerId: string
  ): string {
    const peerByCanonical = new Map(
      peerChains.map((c) => [canonicalChainId(c), c])
    );
    const preferred = this.config.preferredChain;
    const candidates = preferred
      ? ourChains.filter((c) => c.split(':')[0] === preferred)
      : ourChains;
    for (const c of candidates) {
      const peerMatch = peerByCanonical.get(canonicalChainId(c));
      if (peerMatch) return peerMatch;
    }
    if (preferred) {
      throw new ToonClientError(
        `Configured chain "${preferred}" is not supported by peer ` +
          `"${peerId}" (peer supportedChains: ` +
          `${peerChains.join(', ') || '(none)'}).`,
        'CHAIN_NOT_SUPPORTED'
      );
    }
    throw new ToonClientError(
      `No common settlement chain with peer "${peerId}" ` +
        `(our supportedChains: ${ourChains.join(', ') || '(none)'}; ` +
        `peer supportedChains: ${peerChains.join(', ') || '(none)'}).`,
      'CHAIN_NOT_SUPPORTED'
    );
  }

  /**
   * Gets the default chain context: the explicitly-configured
   * `preferredChain` family when set (#485 — e.g. `TOON_CLIENT_CHAIN=evm`
   * must not silently pin to `supportedChains[0]` when that happens to be a
   * different chain, such as Solana), else the first supported chain.
   *
   * @throws {ToonClientError} `CHAIN_NOT_SUPPORTED` if `preferredChain` is
   *   set but none of `supportedChains` belong to that family — this must
   *   fail loudly rather than fall back to a chain the caller didn't choose.
   */
  private getDefaultChainContext():
    | { chainId: number; tokenNetworkAddress: string; tokenAddress?: string }
    | undefined {
    const chains = this.config.supportedChains;
    if (!chains?.length) return undefined;
    const preferred = this.config.preferredChain;
    if (preferred) {
      const match = chains.find((c) => c.split(':')[0] === preferred);
      if (!match) {
        throw new ToonClientError(
          `Configured chain "${preferred}" is not supported by this peer ` +
            `(supportedChains: ${chains.join(', ')}). Set a matching ` +
            `TOON_CLIENT_CHAIN / preferredChain, or fund a supported chain.`,
          'CHAIN_NOT_SUPPORTED'
        );
      }
      return this.getChainContext(match);
    }
    return this.getChainContext(chains[0]);
  }

  /**
   * Sends an ILP payment, optionally with a balance proof claim via BTP.
   *
   * @param params - Payment parameters
   * @returns ILP send result
   * @throws {ToonClientError} If client is not started
   */
  async sendPayment(params: {
    destination: string;
    amount: string;
    data?: string;
    claim?: SignedBalanceProof;
  }): Promise<IlpSendResult> {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    const ilpParams = {
      destination: params.destination,
      amount: params.amount,
      data: params.data ?? '',
    };

    // Require claim + BTP — plain sendIlpPacket is only valid for
    // node-to-node forwarding (relay.ts), not client-to-node.
    if (!params.claim) {
      throw new ToonClientError(
        'Signed balance proof required. Call signBalanceProof() first.',
        'MISSING_CLAIM'
      );
    }
    const transport = this.getClaimTransport(params.destination);
    const claimMessage = this.buildClaimMessageForProof(params.claim);
    return this.sendClaimBearingPacket(
      params.destination,
      transport,
      ilpParams,
      claimMessage as unknown as Record<string, unknown>
    );
  }

  /**
   * Stops the ToonClient and cleans up resources.
   *
   * This will:
   * 1. Disconnect BTP client if connected
   * 2. Clear internal state
   *
   * @throws {ToonClientError} If client is not started
   */
  async stop(): Promise<void> {
    if (!this.state) {
      throw new ToonClientError('Client not started', 'INVALID_STATE');
    }

    try {
      // Tear down the discovery relay subscription first — it is a local,
      // synchronous close, so a BTP disconnect that rejects can't leave the
      // relay socket open behind it (toon-client#550).
      this.state.discoverySubscription.close();

      // Disconnect BTP client if connected
      if (this.state.btpClient) {
        await this.state.btpClient.disconnect();
      }

      // Clear state
      this.state = null;
    } catch (error) {
      throw new ToonClientError(
        'Failed to stop client',
        'STOP_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Returns true if the client is currently started.
   */
  isStarted(): boolean {
    return this.state !== null;
  }

  /**
   * Gets the number of peers discovered during bootstrap.
   *
   * @returns Number of peers discovered
   * @throws {ToonClientError} If client is not started
   */
  getPeersCount(): number {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    return this.state.peersDiscovered;
  }

  /**
   * Gets the list of peers discovered by the relay monitor.
   *
   * @returns Array of discovered peer objects
   * @throws {ToonClientError} If client is not started
   */
  getDiscoveredPeers() {
    if (!this.state) {
      throw new ToonClientError(
        'Client not started. Call start() first.',
        'INVALID_STATE'
      );
    }

    return this.state.discoveryTracker.getDiscoveredPeers();
  }

  /**
   * The `IlpPeerInfo` a discovered peer (a kind:10032 announce author)
   * advertised, keyed by its Nostr pubkey — regardless of peering status
   * (issue #572). A swap MAKER is a payment destination reached by pubkey,
   * not necessarily a connector peer, so this reads `getAllDiscoveredPeers`
   * (peered or not) rather than `getDiscoveredPeers` (unpeered only).
   *
   * @returns `undefined` when the client isn't started, has no tracker, or
   *   has not (yet) seen an announce from `pubkey`.
   */
  getDiscoveredPeerInfo(pubkey: string): IlpPeerInfo | undefined {
    const tracker: Partial<DiscoveryTracker> | undefined =
      this.state?.discoveryTracker;
    if (typeof tracker?.getAllDiscoveredPeers !== 'function') return undefined;
    return tracker.getAllDiscoveredPeers().find((p) => p.pubkey === pubkey)
      ?.peerInfo;
  }

  /**
   * The **leg-B** `swapVerifyingContracts` map a swap MAKER announced (chain
   * key → its deployed `RollingSwapChannel` address), by Nostr pubkey
   * (toon-client#583). This is the EIP-712 `verifyingContract` a received
   * balance-proof claim from that maker must be verified under.
   *
   * NOT {@link getDiscoveredPeerInfo}'s `tokenNetworks`: that is **leg A**,
   * the `TokenNetwork` this client opens its own payment channel against to
   * pay the maker. swap#134 split them into separate announce keys because
   * they are separate contracts — verifying a leg-B claim against the leg-A
   * address recovers an unrelated address and looks like a key mismatch.
   *
   * Read off the announce's RAW content (`DiscoverySubscription`), because
   * `@toon-protocol/core`'s `parseIlpPeerInfo` drops the field entirely — the
   * same gap `terminatorRequiresBtp` works around for `requiredTransport`.
   *
   * @returns `undefined` when the client isn't started, has no discovery
   *   subscription, or that maker's latest announce carries no usable map.
   */
  getSwapVerifyingContracts(
    pubkey: string
  ): Record<string, string> | undefined {
    const subscription: Partial<DiscoverySubscription> | undefined =
      this.state?.discoverySubscription;
    if (typeof subscription?.swapVerifyingContractsFor !== 'function') {
      return undefined;
    }
    return subscription.swapVerifyingContractsFor(pubkey);
  }
}
